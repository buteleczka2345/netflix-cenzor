/* Netflix Cenzor v4.8.3 EXT – popup (ustawienia + profile lektorów)
 *
 * Źródłem prawdy jest kopia w chrome.storage (BACKUP_KEY). Karta Netflix
 * jest traktowana jako żywy odbiornik zmian: po każdej zmianie suwaka
 * popup probuje zastosować ją na żywo (tabs.sendMessage -> bridge -> MAIN).
 *
 * NOWE w 4.8.3: profil lektorów. Trzy paski (Wstecz / Przód / Tempo tekstu)
 * należą do lektora, nie do filmu — każdy ma własne ustawienia.
 */
(function () {
  'use strict';

  var BACKUP_KEY = 'ncz4_backup_ncz4_settings_v2';
  // Lista słów z userscriptu 4.8.3 (55 wzorców, wersja WORDS_DEFAULTS_VER=3).
  // Angielskie wzorce z poprzednich wersji zostawiamy — nie szkodzą, a
  // ktoś ich używał.
  var DEFAULT_WORDS = [
    'kurw*','kurew*','nakurw*','wkurw*','zakurw*','rozkurw*','pokurw*','skurwysyn*','skurwi*',
    'chuj*','huj*','pizd*','spizdz*','wypizdz*','przypizdz*','zapizdz*','popizdz*','podpizdz*',
    'cip*','dziwk*','jeb*','wjeb*','podjeb*','przyjeb*','ujeb*',
    'pierdol*','pierdal*','spierdol*','spierdal*','wypierdol*','wypierdal*',
    'odpierdol*','odpierdal*','napierdal*','rozpierdal*','zapierdal*',
    'przepierdal*','opierdal*','wpierdal*','dopierdol*','dopierdal*',
    'przypierdol*','przypierdal*','podpierdol*','podpierdal*','popierdol*','popierdal*',
    'zajeb*','dojeb*','pojeb*','najeb*','wyjeb*','odjeb*','rozjeb*','przejeb*',
    'fuck*','motherfuck*','shit*','bitch*','cunt*'
  ].join(', ');

  var DEF = {
    enabled: true, bufferMs: 750, holdMs: 0, lenMode: 'normal',
    precise: true, minimized: false, panelOpen: false, words: DEFAULT_WORDS,
    textRate: 0.6, textAuto: false, showHelp: false
  };

  var $ = function (id) { return document.getElementById(id); };
  var elOn, elBuf, elBufV, elHold, elHoldV, elLen, elPrec, elWords, elStatus;
  var elTextRate, elTextRateV, elTextAuto, elShowHelp, elDiag;
  var elProf, elProfName, elProfDel, elProfReset, elProfNext;

  function fmtRate(r) { r = +r || 0; return r.toFixed(2) + 'x'; }
  function clampTR(r) { r = +r; if (!isFinite(r) || r <= 0) return 1;
    return Math.min(2.5, Math.max(0.25, r)); }
  function fmt(ms) {
    ms = +ms || 0;
    return ms >= 1000 ? (ms / 1000).toFixed(2).replace('.00', '.0') + ' s' : ms + ' ms';
  }
  function status(t) { if (elStatus) elStatus.textContent = t; }
  function diag(t, err) {
    if (!elDiag) return;
    elDiag.textContent = t;
    elDiag.className = err ? 'hint ERR' : 'hint';
  }

  async function netflixTab() {
    try {
      var tabs = await chrome.tabs.query({ url: 'https://www.netflix.com/*' });
      return (tabs && tabs[0]) || null;
    } catch (e) { return null; }
  }

  async function loadBackup() {
    try {
      var got = await chrome.storage.local.get([BACKUP_KEY]);
      if (got && got[BACKUP_KEY]) {
        try { return JSON.parse(got[BACKUP_KEY]); } catch (e) { return null; }
      }
    } catch (e) {}
    return null;
  }
/* ---------- wypełnianie kontrolek ---------- */

  // ncz.getSettings() zwraca { settings, profiles: { activeId, list } }.
  // Backup ze storage ma kształt płaskiego settings — przyjmujemy oba.
  function unwrap(payload) {
    if (!payload) return null;
    if (payload.settings && typeof payload.settings === 'object') {
      return { settings: payload.settings, profiles: payload.profiles || null };
    }
    return { settings: payload, profiles: null };
  }

  function fill(s) {
    s = Object.assign({}, DEF, s || {});
    elOn.checked = !!s.enabled;
    elBuf.value = s.bufferMs;
    elHold.value = s.holdMs;
    elLen.value = (s.lenMode === 'off' || s.lenMode === 'strong') ? s.lenMode : 'normal';
    elPrec.checked = !!s.precise;
    elWords.value = typeof s.words === 'string' ? s.words : DEF.words;
    elBufV.textContent = fmt(s.bufferMs);
    elHoldV.textContent = fmt(s.holdMs);
    var tr = clampTR((typeof s.textRate === "number") ? s.textRate : 0.6);
    elTextRate.value = tr.toFixed(2);
    elTextRateV.textContent = fmtRate(tr);
    elTextAuto.checked = !!s.textAuto;
    elTextRate.disabled = elTextAuto.checked;
    elShowHelp.checked = !!s.showHelp;
    var hb = $("helpbox");
    if (hb) hb.style.display = s.showHelp ? "block" : "none";
  }

  // Lista lektorów w select + blokada przycisków przy jednym lektorze.
  function fillProfiles(p) {
    if (!p || !p.list || !p.list.length) return;
    elProf.innerHTML = '';
    for (var i = 0; i < p.list.length; i++) {
      var o = document.createElement('option');
      o.value = p.list[i].id;
      o.textContent = p.list[i].name;
      elProf.appendChild(o);
    }
    elProf.value = p.list.some(function (x) { return x.id === p.activeId; })
      ? p.activeId : p.list[0].id;
    elProfDel.disabled = p.list.length <= 1;
    elProfNext.disabled = p.list.length <= 1;
  }

  function collect() {
    return {
      enabled: elOn.checked,
      bufferMs: +elBuf.value || 0,
      holdMs: +elHold.value || 0,
      lenMode: elLen.value,
      precise: elPrec.checked,
      textRate: clampTR(elTextRate.value),
      textAuto: elTextAuto.checked,
      showHelp: elShowHelp.checked,
      words: elWords.value
    };
  }

  /* ---------- odczyt stanu ---------- */

  async function refresh() {
    // Backup jest ZRODLEM PRAWDY: najpierw wypelniamy nim suwaki.
    // Karta Netflix mogla miec w pamieci STARE wartosci (sprzed Zapisz),
    // wiec nie wolno jej odpowiedzia nadpisywac popupu — stad "wracalo samo".
    var bak0 = null;
    try { bak0 = await loadBackup(); } catch (e0) {}
fill(bak0 || DEF);
    var tab = await netflixTab();
    if (tab) {
      try {
        var res = await chrome.tabs.sendMessage(tab.id, { ncz: 'get' });
        var u = unwrap(res && res.settings);
        if (u && u.settings) {
          // Ustawienia z karty sa nowsze tylko wtedy, gdy w kopii ich nie ma.
          if (!bak0) fill(u.settings);
          if (u.profiles) fillProfiles(u.profiles);
        }
        diag('Karta Netflix podlaczona - zmiany dzialaja na zywo.');
      } catch (e) {
        diag('Karta Netflix jest, ale nie odpowiada. Odswiez ja (F5).', true);
      }
    } else {
      diag('Brak otwartej karty Netflix - ustawienia zapisza sie na pozniej.', true);
    }
  }
/* ---------- zapis ---------- */

  var autoTimer = null;
  function autoSave() {
    status('Zapisywanie…');
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(function () { save(true); }, 300);
  }

  async function save(quiet) {
    var patch = collect();
    elBufV.textContent = fmt(patch.bufferMs);
    elHoldV.textContent = fmt(patch.holdMs);
    elTextRateV.textContent = fmtRate(patch.textRate);
    // 1) Kopia w chrome.storage (zawsze – działa też bez otwartej karty).
    //    Zapisujemy PELNY zestaw pol (merge z DEF), zeby ncz-store-pull po
    //    stronie karty zawsze mial komplet, a nie czastkowy patch.
    try {
      var bak = (await loadBackup()) || {};
      var merged = Object.assign({}, DEF, bak, patch);
      merged.panelOpen = false;   // panel na stronie wylaczony na stale
      var obj = { ncz4_backup_ts: Date.now() };
      obj[BACKUP_KEY] = JSON.stringify(merged);
      await chrome.storage.local.set(obj);
    } catch (e) {}
    // 2) Na żywo do otwartej karty.
    var tab = await netflixTab();
    if (tab) {
      try {
        await chrome.tabs.sendMessage(tab.id, { ncz: 'set', settings: patch });
        status(quiet ? 'Zapisano automatycznie.' : 'Zapisano (karta Netflix + kopia).');
        return;
      } catch (e) {
        status('Zapisano kopię. Odśwież kartę Netflix (F5), żeby zastosować na żywo.');
        return;
      }
    }
    status('Zapisano kopię. Otwórz Netflix, żeby zastosować.');
  }

  /* ---------- operacje na lektorach ---------- */

  // MAIN wykonuje operację i odsyła świeży stan -> przerysowujemy kontrolki.
  async function profileOp(op, extra) {
    var tab = await netflixTab();
    if (!tab) { status('Otwórz kartę Netflix, aby zarządzać lektorami.'); return null; }
    try {
      var msg = Object.assign({ ncz: 'profile', op: op }, extra || {});
      var res = await chrome.tabs.sendMessage(tab.id, msg);
      var st = res && res.state;
      if (st) {
        fill(st.settings || DEF);
        fillProfiles(st.profiles);
      }
      return st;
    } catch (e) {
      status('Nie udało się połączyć z kartą Netflix. Odśwież ją (F5).');
      return null;
    }
  }

  /* ---------- start ---------- */

  document.addEventListener('DOMContentLoaded', function () {
    elOn = $('st-enabled'); elBuf = $('st-buf'); elBufV = $('st-bufval');
    elHold = $('st-hold'); elHoldV = $('st-holdval');
    elLen = $('st-len'); elPrec = $('st-prec');
    elTextRate = $('st-textrate'); elTextRateV = $('st-textrateval');
    elTextAuto = $('st-textauto'); elShowHelp = $('st-showhelp');
    elWords = $('st-words'); elStatus = $('status'); elDiag = $('diag');
    elProf = $('st-prof'); elProfName = $('st-profname');
    elProfDel = $('btn-profdel'); elProfNext = $('btn-profnext');

    elBuf.addEventListener('input', function () {
      elBufV.textContent = fmt(elBuf.value); autoSave();
    });
    elHold.addEventListener('input', function () {
      elHoldV.textContent = fmt(elHold.value); autoSave();
    });
    elOn.addEventListener('change', autoSave);
    elLen.addEventListener('change', autoSave);
    elPrec.addEventListener('change', autoSave);
    elTextRate.addEventListener('input', function () {
      elTextRateV.textContent = fmtRate(elTextRate.value);
      if (!elTextAuto.checked) autoSave();
    });
    elTextAuto.addEventListener('change', function () {
      elTextRate.disabled = elTextAuto.checked;
      autoSave();
    });
    elShowHelp.addEventListener('change', function () {
      var hb = $('helpbox');
      if (hb) hb.style.display = elShowHelp.checked ? 'block' : 'none';
      autoSave();
    });
    $('btn-text1x').addEventListener('click', function () {
      elTextRate.value = '1.00';
      elTextRateV.textContent = fmtRate(1);
      elTextAuto.checked = false;
      elTextRate.disabled = false;
      autoSave();
    });
    var wordsTimer = null;
    elWords.addEventListener('input', function () {
      if (wordsTimer) clearTimeout(wordsTimer);
      wordsTimer = setTimeout(autoSave, 800);
    });

    // --- lektorzy ---
    elProf.addEventListener('change', function () {
      profileOp('apply', { id: elProf.value }).then(function () { autoSave(); });
    });
    $('btn-profsave').addEventListener('click', function () {
      var name = (elProfName.value || '').trim();
      profileOp('create', { name: name, fromCurrent: true }).then(function (st) {
        if (st) { elProfName.value = ''; autoSave(); }
      });
    });
    elProfName.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      $('btn-profsave').click();
    });
    elProfDel.addEventListener('click', function () {
      var id = elProf.value;
      var opt = elProf.options[elProf.selectedIndex];
      if (!opt) return;
      if (!confirm('Usunąć lektora "' + opt.text + '"?\nUstawienia tego lektora znikną.')) return;
      profileOp('delete', { id: id }).then(function (st) { if (st) autoSave(); });
    });
    $('btn-profreset').addEventListener('click', function () {
      var opt = elProf.options[elProf.selectedIndex];
      if (!confirm('Przywrócić fabryczne paski (750 / 0 / 0,6x) dla "' +
        (opt ? opt.text : 'tego lektora') + '"?')) return;
      profileOp('reset', {}).then(function (st) { if (st) autoSave(); });
    });
    $('btn-profnext').addEventListener('click', function () {
      profileOp('next', {}).then(function (st) { if (st) autoSave(); });
    });

    $('btn-open').addEventListener('click', function () {
      try { chrome.tabs.create({ url: 'https://www.netflix.com/' }); } catch (e) {}
    });

    refresh();
  });
})();