/* ============================================================
 * Netflix Cenzor v4.8.3 EXT – content-bridge.js (świat ISOLATED)
 * Pośrednik między stroną (content-main.js, świat MAIN)
 * a popupem / pamięcią chrome.storage.
 *
 * MAIN nie ma stabilnego dostępu do chrome.storage, więc:
 *  - popup pyta o stan: tabs.sendMessage -> tu ->
 *    window.postMessage -> MAIN odpowiada -> sendResponse,
 *  - popup zapisuje: tabs.sendMessage -> tu ->
 *    window.postMessage (MAIN stosuje na żywo) + kopia w
 *    chrome.storage (na wypadek zamkniętej karty),
 *  - MAIN po każdym GM_setValue śle tu lustrzaną kopię
 *    (localStorage strony -> chrome.storage).
 *
 * NOWE w 4.8.3: profil lektorów (ncz4_profiles_v1) ma własny
 * klucz kopii w chrome.storage i osobny kanał "ncz-profile",
 * żeby popup mógł tworzyć / kasować / przełączać lektorów.
 * ============================================================ */
(function () {
  'use strict';

  var LS_PREFIX = 'ncz4ext:';
  var BACKUP_KEY = 'ncz4_backup_ncz4_settings_v2';      // klucz ustawień w GM
  var PROFILE_KEY = 'ncz4_backup_ncz4_profiles_v1';      // klucz magazynu lektorów
  var pending = new Map();
  var reqSeq = 0;

  function pageLSGet(k) {
    try { return window.localStorage.getItem(LS_PREFIX + k); }
    catch (e) { return null; }
  }
  function pageLSSet(k, v) {
    try { window.localStorage.setItem(LS_PREFIX + k, v); } catch (e) {}
  }

  // --- wiadomości ze strony (świat MAIN) ---
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== 'ncz-main' || !d.type) return;

    if (d.type === 'ncz-store-mirror' && d.key) {
      // Lustrzana kopia do chrome.storage — ALE NIE WOLNO nadpisac NOWSZEGO
      // backupu STARYM stanem strony. Po odswiezeniu karty MAIN najpierw wola
      // persist() na starych danych (z localStorage), a dopiero potem bridge
      // konczy ncz-store-pull. Gdyby mirror bezwarunkowo nadpisywal backup,
      // kazdy F5 kasowalby ustawienia z popupu ("wracalo samo"). Dlatego
      // mirror MA ZAKAZ dotykania glownego BACKUP_KEY — zapisujemy tylko pod
      // osobnym kluczem diagnostycznym. Jedynym pisarzem BACKUP_KEY jest
      // popup (save/autoSave) i galezie 'set'/pull ponizej.
      try {
        var mobj = {};
        mobj['ncz4_mirror_' + d.key] = d.value;
        mobj.ncz4_mirror_ts = (typeof d.ts === 'number') ? d.ts : Date.now();
        // Magazyn lektorow jest tu WYJATKIEM: nikt inny go nie zapisuje
        // (popup zarzadza lektorami przez MAIN), wiec mirror jest jedynym
        // zrodlem kopii przetrwajacej odswiezenie karty.
        if (d.key === 'ncz4_profiles_v1') {
          mobj[PROFILE_KEY] = d.value;
          mobj.ncz4_profiles_ts = mobj.ncz4_mirror_ts;
        }
        chrome.storage.local.set(mobj);
      } catch (e) {}
    } else if (d.type === 'ncz-store-pull') {
      // MAIN prosi o backup (np. po odswiezeniu karty). ZAWSZE stosujemy
      // kopie z popupu — to jedyne sterowanie po wylaczeniu panelu na
      // stronie. Dawny warunek "tylko gdy localStorage strony jest pusty"
      // byl przyczyna braku zapamietywania: strona miala STARE wartosci,
      // wiec ignorowala NOWSZE z popupu i suwaki "wracaly same".
      (async function () {
        var got = {};
        try { got = await chrome.storage.local.get([BACKUP_KEY, PROFILE_KEY]); } catch (e) { return; }
        var bak = got && got[BACKUP_KEY];
        // 1) ustawienia
        if (bak) {
          try { pageLSSet('ncz4_settings_v2', bak); } catch (e0) {}
          try { pageLSSet('ncz4_backup_ts', String(Date.now())); } catch (e0b) {}
          try {
            var s = JSON.parse(bak);
            window.postMessage(
              { source: 'ncz-bridge', type: 'ncz-apply-settings', settings: s }, '*');
          } catch (e1) {}
        }
        // 2) magazyn lektorow (ncz4_profiles_v1) — niezalezny od ustawien
        var pbak = got && got[PROFILE_KEY];
        if (pbak) {
          try { pageLSSet('ncz4_profiles_v1', pbak); } catch (e2) {}
          // MAIN musi przestawic sie na te lektory (albo wybrac profil,
          // ktorego paski odpowiadaja ustawieniom z backupu).
          try {
            var ps = JSON.parse(pbak);
            var match = null;
            if (ps && Array.isArray(ps.list)) {
              match = ps.list.find(function (x) {
                return x && x.bufferMs === s.bufferMs && x.holdMs === s.holdMs &&
                       !!x.textAuto === !!s.textAuto &&
                       Math.abs((x.textRate || 0) - (s.textRate || 0)) < 1e-9;
              }) || null;
            }
            window.postMessage({ source: 'ncz-bridge', type: 'ncz-apply-profiles',
              profiles: pbak, matchId: (match && match.id) || '' }, '*');
            if (match) {
              window.postMessage({ source: 'ncz-bridge', type: 'ncz-apply-settings',
                settings: s }, '*');
            }
          } catch (e3) {}
        }
      })();
    } else if (d.type === 'ncz-settings-push') {
      var p = pending.get(d.reqId);
      if (p) { pending.delete(d.reqId); try { p(d.settings); } catch (e) {} }
    } else if (d.type === 'ncz-state-push') {
      // Odpowiedź na operację profilu z popupu: zwracamy świeży stan.
      var pp = pending.get(d.reqId);
      if (pp) { pending.delete(d.reqId); try { pp(d.state); } catch (e) {} }
    }
  });
// --- wiadomości z popupu ---
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || !msg.ncz) return false;

      if (msg.ncz === 'get') {
        var reqId = 'r' + (++reqSeq) + '_' + Date.now();
        var to = setTimeout(function () {
          var p = pending.get(reqId);
          if (p) { pending.delete(reqId); try { p(null); } catch (e) {} }
        }, 1500);
        pending.set(reqId, function (s) {
          clearTimeout(to);
          try { sendResponse({ settings: s }); } catch (e) {}
        });
        try { window.postMessage({ source: 'ncz-bridge', type: 'ncz-get-settings', reqId: reqId }, '*'); }
        catch (e) { try { sendResponse({ settings: null }); } catch (e2) {} }
        return true; // odpowiedź asynchroniczna
      }

      if (msg.ncz === 'set') {
        try {
          window.postMessage(
            { source: 'ncz-bridge', type: 'ncz-apply-settings', settings: msg.settings || {} }, '*');
        } catch (e) {}
        // Kopia w chrome.storage (gdyby karta nie była otwarta).
        try {
          chrome.storage.local.get([BACKUP_KEY], function (got) {
            try {
              var cur = {};
              try { cur = JSON.parse((got && got[BACKUP_KEY]) || '{}'); }
              catch (e) { cur = {}; }
              var merged = Object.assign({}, cur, msg.settings || {});
              merged.panelOpen = false;   // panel na stronie wylaczony
              var obj = { ncz4_backup_ts: Date.now() };
              obj[BACKUP_KEY] = JSON.stringify(merged);
              chrome.storage.local.set(obj);
            } catch (e) {}
          });
        } catch (e) {}
        try { sendResponse({ ok: true }); } catch (e) {}
        return false;
      }

      // Operacje na profilach lektorow (4.8.3). MAIN wykonuje zadanie
      // i odsyła świeży stan -> trafia tu do sendResponse popupu.
      if (msg.ncz === 'profile') {
        var pid = 'p' + (++reqSeq) + '_' + Date.now();
        var pto = setTimeout(function () {
          var f = pending.get(pid);
          if (f) { pending.delete(pid); try { f(null); } catch (e) {} }
        }, 2500);
        pending.set(pid, function (s) {
          clearTimeout(pto);
          try { sendResponse({ state: s }); } catch (e) {}
        });
        try {
          window.postMessage({
            source: 'ncz-bridge', type: 'ncz-profile',
            op: msg.op || '', id: msg.id || '', name: msg.name || '',
            fromCurrent: msg.fromCurrent !== false, reqId: pid
          }, '*');
        } catch (e) { try { sendResponse({ state: null }); } catch (e2) {} }
        return true;
      }

      if (msg.ncz === 'toggle') {
        try { window.postMessage({ source: 'ncz-bridge', type: 'ncz-toggle-panel' }, '*'); } catch (e) {}
        try { sendResponse({ ok: true }); } catch (e) {}
        return false;
      }
      return false;
    });
  } catch (e) {}

  // --- zmiany w chrome.storage (np. drugi popup) -> strona ---
  try {
    chrome.storage.onChanged.addListener(function (chg, area) {
      if (area !== 'local') return;
      var b = chg && chg[BACKUP_KEY];
      if (b && b.newValue && b.newValue !== b.oldValue) {
        try {
          var s = JSON.parse(b.newValue);
          window.postMessage(
            { source: 'ncz-bridge', type: 'ncz-apply-settings', settings: s }, '*');
        } catch (e) {}
      }
    });
  } catch (e) {}
})();