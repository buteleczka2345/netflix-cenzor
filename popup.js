/* Netflix Cenzor v4.8.3 EXT – popup (ustawienia)
 *
 * Źródłem prawdy jest kopia w chrome.storage (BACKUP_KEY). Karta Netflix
 * jest traktowana jako żywy odbiornik zmian: po każdej zmianie suwaka
 * popup próbuje zastosować ją na żywo (tabs.sendMessage -> bridge -> MAIN).
 */
(function () {
  'use strict';

  var BACKUP_KEY = 'ncz4_backup_ncz4_settings_v2';
  // Stan zwinietej listy slow trzymamy OSOBNO, zeby zapisywac go
  // natychmiast (bez czekania na wczytanie kopii). Dzieki temu
  // stan przezywa natychmiastowe zamkniecie popupu.
  var FOLD_KEY = 'ncz4_words_collapsed';
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
    textRate: 0.6, textAuto: false, showHelp: false,
    // stan zwinięcia ramki listy słów (zapamiętywany w chrome.storage)
    wordsCollapsed: false
  };

  var $ = function (id) { return document.getElementById(id); };
  var elOn, elBuf, elBufV, elHold, elHoldV, elLen, elPrec, elWords, elStatus;
  var elTextRate, elTextRateV, elTextAuto, elShowHelp, elDiag;
  var elWordsBox, elWordsToggle, elWordsHead;

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

  // ncz.getSettings() zwraca { settings, profiles }. Backup ze storage ma
  // kształt płaskiego settings — przyjmujemy oba.
  function unwrap(payload) {
    if (!payload) return null;
    if (payload.settings && typeof payload.settings === 'object') {
      return { settings: payload.settings };
    }
    return { settings: payload };
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
    applyWordsFold(!!s.wordsCollapsed);
  }

  // Zwijanie ramki listy słów. Stan leży w backupie (chrome.storage),
  // więc po zamknięciu i ponownym otwarciu popupu ramka zostaje zwinięta.
  // refresh() woła fill() przy każdym otwarciu, dlatego stan jest tu
  // stosowany przy każdym odczycie, a nie tylko przy kliknięciu.
  var wordsCollapsed = false;

  function applyWordsFold(collapsed) {
    wordsCollapsed = !!collapsed;
    if (elWordsBox) elWordsBox.style.display = wordsCollapsed ? 'none' : 'block';
    if (elWordsToggle) elWordsToggle.textContent = wordsCollapsed ? '▸' : '▾';
  }

  function toggleWordsFold() {
    applyWordsFold(!wordsCollapsed);
    // 1) NATYCHMIASTOWY zapis do osobnego klucza - jedyne miejsce,
    //    ktore na pewno zdazy sie wykonac przed zamknieciem popupu.
    try {
      chrome.storage.local.set({
        [FOLD_KEY]: wordsCollapsed ? 1 : 0,
        ncz4_fold_ts: Date.now()
      });
    } catch (e) {}
    // 2) pelny zapis ustawien (wolniejszy, asynchroniczny).
    // Zapis NATYCHMIASTOWY, nie przez autoSave(): autoSave odracza zapis o 300 ms
    // (debounce pod suwakami), a popup zamyka sie od razu po kliknieciu -
    // stan zwinietej listy by wtedy przepadl i ramka znowu sie rozwijala.
    save(true);
  }

  // Lista lektorów w select + blokada przycisków przy jednym lektorze.
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
      wordsCollapsed: wordsCollapsed,
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
    // Stan zwinietej ramki listy slow: OSTATNIE slowo ma osobny klucz
    // (zapis natychmiastowy przy kliknieciu). Gdy go nie ma - spadamy
    // na stan z kopii ustawien.
    try {
      var fg = await chrome.storage.local.get([FOLD_KEY]);
      if (fg && fg[FOLD_KEY] !== undefined) applyWordsFold(fg[FOLD_KEY] === 1);
    } catch (e1) {}
    var tab = await netflixTab();
    if (tab) {
      try {
        var res = await chrome.tabs.sendMessage(tab.id, { ncz: 'get' });
        var u = unwrap(res && res.settings);
        if (u && u.settings) {
          // Ustawienia z karty sa nowsze tylko wtedy, gdy w kopii ich nie ma.
          if (!bak0) fill(u.settings);
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

  /* ---------- start ---------- */

  document.addEventListener('DOMContentLoaded', function () {
    elOn = $('st-enabled'); elBuf = $('st-buf'); elBufV = $('st-bufval');
    elHold = $('st-hold'); elHoldV = $('st-holdval');
    elLen = $('st-len'); elPrec = $('st-prec');
    elTextRate = $('st-textrate'); elTextRateV = $('st-textrateval');
    elTextAuto = $('st-textauto'); elShowHelp = $('st-showhelp');
    elWords = $('st-words'); elStatus = $('status'); elDiag = $('diag');
    elWordsBox = $('st-wordsbox'); elWordsToggle = $('btn-wordstoggle');
    elWordsHead = $('st-wordshead');

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

    // --- zwijanie listy słów (stan idzie do chrome.storage) ---
    if (elWordsToggle) {
      elWordsToggle.addEventListener('click', function (e) {
        e.stopPropagation();      // klik nie moze odpalic handleru naglowka
        toggleWordsFold();
      });
    }
    // Kliknięcie w sam nagłówek też zwija/rozwija — wygodniejsze niż
    // celowanie w mały przycisk.
    if (elWordsHead) {
      elWordsHead.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('.foldb')) return;
        toggleWordsFold();
      });
    }

    $('btn-open').addEventListener('click', function () {
      try { chrome.tabs.create({ url: 'https://www.netflix.com/' }); } catch (e) {}
    });

    refresh();
  });
})();
