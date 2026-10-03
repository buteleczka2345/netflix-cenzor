/* ============================================================
 * NCZ Chrome Extension shim (MV3, swiat MAIN)
 * Zastepuje API Tampermonkey (GM_*) lokalnym odpowiednikiem.
 * Ustawienia trzymane sa w localStorage strony (synchronicznie,
 * jak GM), a ich kopia lustrzana trafia do chrome.storage
 * przez skrypt-posrednik (content-bridge.js, swiat ISOLATED).
 * ============================================================ */
(function () {
  try {
    var LS_PREFIX = 'ncz4ext:';
    var mem = Object.create(null);
    function lsGet(k, d) {
      if (k in mem) return mem[k];
      try {
        var v = window.localStorage.getItem(LS_PREFIX + k);
        return (v === null || v === undefined) ? d : v;
      } catch (e) { return d; }
    }
    function lsSet(k, v) {
      mem[k] = v;
      try { window.localStorage.setItem(LS_PREFIX + k, v); } catch (e) {}
      try { window.postMessage({ source: 'ncz-main', type: 'ncz-store-mirror', key: k, value: v, ts: Date.now() }, '*'); } catch (e) {}
    }
    if (typeof window.GM_getValue !== 'function') {
      window.GM_getValue = function (k, d) { return lsGet(k, d); };
    }
    if (typeof window.GM_setValue !== 'function') {
      window.GM_setValue = function (k, v) { lsSet(k, v); };
    }
    if (typeof window.GM_registerMenuCommand !== 'function') {
      window.GM_registerMenuCommand = function (name, fn) { window.__nczMenuCmd = fn; };
    }
    // W swiecie MAIN `window` jest obiektem globalnym, ale dla pewnosci
    // (i testow poza przegladarka) przypisujemy tez jawnie do globalThis —
    // skrypt uzywa ich jako zwyklych globali (jak w userscripcie GM).
    try {
      var G = (typeof globalThis !== 'undefined') ? globalThis : window;
      if (typeof G.GM_getValue !== 'function') G.GM_getValue = window.GM_getValue;
      if (typeof G.GM_setValue !== 'function') G.GM_setValue = window.GM_setValue;
      if (typeof G.GM_registerMenuCommand !== 'function') {
        G.GM_registerMenuCommand = window.GM_registerMenuCommand;
      }
    } catch (e2) {}
    // Popros mostek (ISOLATED) o przywrocenie kopii z chrome.storage
    // (ustawienia + profile lektorow), bo po odswiezeniu karty to popup
    // pozostaje zrodlem prawdy.
    try { window.postMessage({ source: 'ncz-main', type: 'ncz-store-pull' }, '*'); } catch (e) {}
  } catch (e) {}
})();

// ==UserScript==
// @name         Netflix Cenzor
// @namespace    ncz.v4
// @version      4.8.3
// @description  Wycisza przekleństwa. Tryb CUE: przechwytuje wewnętrzną tablicę napisów Netflixa i planuje wyciszenie PRZED ich faktycznym początkiem. Czas słowa liczony MODELEM SEGMENTOWYM (samogłoska 1.4, spółgłoska/dwuznak 0.8, półsamogłoska „i" 0.8 lub 0, interpunkcja 0.4) — odwzorowuje polską fonetykę lepiej niż suma liter. Czasy ciągłe, ostatnie słowo kończy się dokładnie na endTime. Bufor i trzymanie ciszy skalowane przez TEMPO TEKSTU. PROFILE LEKTORÓW: trzy paski z trybami zapamiętywane osobno dla każdego lektora. W tej kopii panel na stronie jest wyłączony — sterowanie z popupu rozszerzenia. Bez Pipera i bez lokalnego serwera.
// @match        https://www.netflix.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      localhost
// @noframes
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * 1) PRZECHWYTYWANIE CUE'ÓW (tryb główny)
   * ============================================================ */

  const cues = [];              // { start, end, text } w sekundach
  let cueMode = false;          // true = mamy prawdziwe czasy z cue'ów
  const seenCueKeys = new Set(); // duplikaty przy wielu pushach

  const origPush = Array.prototype.push;

  function looksLikeCueArray(args) {
    if (!args || !args.length) return false;
    const first = args[0];
    return !!(first && typeof first === 'object'
      && 'blocks' in first
      && typeof first.startTime === 'number');
  }

  function extractText(cue) {
    try {
      const blocks = cue.blocks || [];
      const parts = [];
      for (const b of blocks) {
        if (!b) continue;
        const nodes = b.textNodes || [];
        for (const n of nodes) if (n && n.text) parts.push(n.text);
        if (!nodes.length && b.text) parts.push(b.text);
      }
      // Laczymy SPACJA, nie pustym ciagiem: Netflix czesto dzieli jedna
      // kwestie na kilka blocks (druga linijka napisu) albo textNodes
      // (fragment pogrubiony/kursywa). Puste polaczenie sklejalo koniec
      // jednego fragmentu z poczatkiem kolejnego w jedno "slowo"
      // ("...kurwaco sie dzieje" zamiast "...kurwa co sie dzieje"), przez
      // co regex z granica \p{L}\p{N} nie widzial konca przeklenstwa i
      // przepuszczal je bez wyciszenia. Dodatkowy replace porzadkuje
      // ewentualne podwojne spacje, gdyby jakis fragment mial juz biala
      // spacje na brzegu.
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    } catch (e) { return ''; }
  }

  let insidePatch = false;   // zabezpieczenie przed rekurencja

  Array.prototype.push = function () {
    if (!insidePatch && looksLikeCueArray(arguments)) {
      insidePatch = true;
      try {
        for (let i = 0; i < arguments.length; i++) {
          const c = arguments[i];
          const text = extractText(c);
          if (!text) continue;
          const key = c.startTime + '|' + c.endTime + '|' + text;
          if (seenCueKeys.has(key)) continue;
          seenCueKeys.add(key);
          cues.push({                       // <-- wlasny push na patchowanej tablicy
            start: c.startTime / 1000,
            end:   c.endTime / 1000,
            text
          });
        }
        cues.sort((a, b) => a.start - b.start);
        cueMode = true;
      } finally {
        insidePatch = false;
      }
      schedulePanel();
    }
    return origPush.apply(this, arguments);
  };

  // Zdarzenie dla skryptow diagnostycznych / uzytkownika.
  function announce() {
    try { window.dispatchEvent(new CustomEvent('ncz-cues', { detail: { count: cues.length } })); }
    catch (e) { /* ignorujemy */ }
  }

  /* ============================================================
   * 2) USTAWIENIA I LISTA SŁÓW
   * ============================================================ */

  const DEFAULT_WORDS = [
    'kurw*','kurew*','nakurw*','wkurw*','zakurw*','rozkurw*','pokurw*','skurwysyn*','skurwi*',
    'chuj*','huj*',
    'pizd*','spizdz*','wypizdz*','przypizdz*','zapizdz*','popizdz*','podpizdz*',
    'cip*','dziwk*',
    'jeb*','wjeb*','podjeb*','przyjeb*','ujeb*',
    'pierdol*','pierdal*','spierdol*','spierdal*','wypierdol*','wypierdal*',
    'odpierdol*','odpierdal*','napierdal*','rozpierdal*','zapierdal*',
    'przepierdal*','opierdal*','wpierdal*','dopierdol*','dopierdal*',
    'przypierdol*','przypierdal*','podpierdol*','podpierdal*','popierdol*','popierdal*',
    'zajeb*','dojeb*','pojeb*','najeb*','wyjeb*','odjeb*','rozjeb*','przejeb*'
  ].join(', ');

  const SETTINGS_KEY = 'ncz4_settings_v2';

  // Wersja wbudowanej listy słów. PODBIJAJ przy każdej zmianie DEFAULT_WORDS -
  // wtedy stare instalacje jednorazowo dopisza sobie nowe wzorce
  // (mechanizm w loadSettings, pole wordsMergeVer).
  const WORDS_DEFAULTS_VER = 3;

  // Rozbija zapis listy na pojedyncze wzorce (małe litery, bez pustych wpisów).
  function wordStemsOf(str) {
    return String(str || '').split(/[\s,;\n]+/).map(w => w.trim().toLowerCase()).filter(Boolean);
  }

  function defaultWordStems() { return wordStemsOf(DEFAULT_WORDS); }

  // Czy odczyt z GM wymagał naprawy? Jeśli tak, oczyszczony stan
  // zapisujemy po inicjalizacji profili (persist() wolane za wcześnie
  // sięgałoby zmiennej profileStore, która jeszcze nie istnieje).
  let settingsDirty = false;

  function loadSettings() {
    const def = {
      enabled: true,
      bufferMs: 750,
      holdMs: 0,
      lenMode: 'normal',  // off | normal | strong - dodatkowa cisza za dlugie przeklestwo
      precise: true,      // przycinamy okno do pozycji slowa w kwestii
      minimized: false,   // panel zwiniety do paseczka (przycisk –)
      panelOpen: true,    // czy panel jest w ogole odsloniety (menu GUI)
      words: DEFAULT_WORDS,
      textRate: 0.6,
      textAuto: false,
      showHelp: false,
      wordsCollapsed: false,  // ramka listy słów zwinięta (przycisk ▸/▾)
      wordsHeight: 0,         // zapamiętana wysokość ramki w px; 0 = auto
      wordsMergeVer: 0        // wersja listy domyślnej już scalona (0 = scal teraz)
    };
    try {
      if (typeof GM_getValue === 'function') {
        const raw = GM_getValue(SETTINGS_KEY, '');
        if (raw) {
          const got = Object.assign(def, JSON.parse(raw));
          // Migracja ze starszych wersji: "adaptive" zastapilo trybem dlugosci.
          if (got.adaptive === false) got.lenMode = 'off';
          delete got.adaptive;
          // Migracja: tempo tekstu (v4.6.0). Brak pol = Twoje robocze 750/0/0.6/recznie.
          if (typeof got.textRate !== 'number' || !isFinite(got.textRate)) got.textRate = 0.6;
          got.textRate = Math.min(2.5, Math.max(0.25, got.textRate));
          if (typeof got.textAuto !== 'boolean') got.textAuto = false;
          if (typeof got.bufferMs !== 'number' || !isFinite(got.bufferMs)) got.bufferMs = 750;
          if (typeof got.holdMs !== 'number' || !isFinite(got.holdMs)) got.holdMs = 0;
          if (typeof got.showHelp !== 'boolean') got.showHelp = false;
          // v4.8.0: stan zwinięcia i wysokość ramki słów. Bez walidacji
          // uszkodzona wartość w GM przywróciłaby ramkę w złym stanie.
          if (typeof got.wordsCollapsed !== 'boolean') {
            got.wordsCollapsed = false;
            settingsDirty = true;
          }
          if (typeof got.wordsHeight !== 'number' || !isFinite(got.wordsHeight)
              || got.wordsHeight < 0) {
            got.wordsHeight = 0;
            settingsDirty = true;
          } else {
            const cap = Math.min(600, Math.round(got.wordsHeight));
            if (cap !== got.wordsHeight) { got.wordsHeight = cap; settingsDirty = true; }
          }
          // Scalanie domyślnej listy słów. Stare instalacje trzymają kopię
          // DEFAULT_WORDS sprzed aktualizacji, więc wzorce dodane później
          // (np. "przejeb*") tam nie istnieją i te słowa przechodzą bez
          // cenzury - często z kropką na końcu zdania, co wygląda jak bug
          // interpunkcji. Dopisujemy brakujące RAZ; usunięte świadomie
          // słowa można potem skasować i już nie wrócą (marker wersji).
          if (typeof got.wordsMergeVer !== 'number' || !isFinite(got.wordsMergeVer)) got.wordsMergeVer = 0;
          if (got.wordsMergeVer < WORDS_DEFAULTS_VER) {
            const have = new Set(wordStemsOf(got.words));
            const missing = defaultWordStems().filter(w => !have.has(w));
            if (missing.length) {
              const cur = (got.words || '').trim();
              got.words = (cur ? cur + ', ' : '') + missing.join(', ');
              console.log('[Cenzor] dopisano brakujące słowa domyślne: ' + missing.join(', '));
            }
            got.wordsMergeVer = WORDS_DEFAULTS_VER;
            settingsDirty = true;
          }
          return got;
        }
      }
    } catch (e) { /*ignorujemy*/ }
    return def;
  }

  const state = loadSettings();

  function persist() {
    try {
      if (typeof GM_setValue === 'function')
        GM_setValue(SETTINGS_KEY, JSON.stringify(state));
    } catch (e) { /*ignorujemy*/ }
    // Trzy paski należą do lektora, więc każda zmiana suwaka od razu
    // zapisuje się w aktywnym profilu (nie tylko w stanie globalnym).
    syncActiveProfile();
  }

  /* ============================================================
   * 2a) PROFILE LEKTORÓW
   *
   * Trzy paski (Bufor / Trzymaj / Tempo tekstu) muszą być inne dla
   * różnych lektorów: kontra mówi szybko, trzeba go łapać bardziej
   * z wyprzedzeniem i krócej trzymać. Zamiast jednego zestawu
   * ustawień trzymamy listę profili, a każdy ma własne:
   *
   *   Bufor, Trzymaj, Tempo tekstu   - trzy paski
   *   Auto                           - "tempo tekstu = tempo filmu"
   *   Długość słowa, Tylko samo słowo - tryby zależne od tempa lektora
   *
   * Wspólne dla wszystkich lektorów pozostają: lista słów,
   * włączanie cenzora, pozycja panelu i pomoc.
   *
   * Cały magazyn leży w JEDNYM kluczu GM (ncz4_profiles_v1), więc
   * zapis jest atomowy - nie da się zapisać profilu bez aktywnego.
   * ============================================================ */

  const PROFILE_STORE_KEY = 'ncz4_profiles_v1';

  // Pola należące do profilu.
  const PROFILE_FIELDS = [
    'bufferMs', 'holdMs', 'textRate', 'textAuto', 'lenMode', 'precise'
  ];

  // Wartości fabryczne - ten sam zestaw co def w loadSettings(), czyli
  // to, co użytkownik dostał w 4.6.2.
  const PROFILE_DEFAULTS = {
    bufferMs: 750,
    holdMs: 0,
    textRate: 0.6,
    textAuto: false,
    lenMode: 'normal',
    precise: true
  };

  const LEN_MODES = ['off', 'normal', 'strong'];

  // Zakresy suwaków - muszą się zgadzać z atrybutami min/max w panelu,
  // inaczej profil zapisany na innym ustawieniu wyszedłby poza zakres.
  const BUF_RANGE  = [0, 3000];
  const HOLD_RANGE = [0, 2000];

  function clampNum(v, min, max, def) {
    const n = Number(v);
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  function newProfileId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // Zwiększa nazwy, aż będzie wolna: "Lektor", "Lektor 2", "Lektor 3"...
  function nextProfileName() {
    const base = 'Lektor';
    if (!profileStore.list.some(p => p.name === base)) return base;
    for (let i = 2; i < 500; i++) {
      const n = base + ' ' + i;
      if (!profileStore.list.some(p => p.name === n)) return n;
    }
    return base + ' ' + Date.now();
  }

  // Ujednolica i chroni profil przed śmieciami w GM (uszkodzony JSON,
  // brakujące pola, wartości spoza zakresu suwaka).
  function sanitizeProfile(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const out = {};
    out.id = (typeof src.id === 'string' && src.id.trim())
      ? src.id.trim().slice(0, 48) : newProfileId();
    out.name = (typeof src.name === 'string' && src.name.trim())
      ? src.name.trim().slice(0, 32) : 'Lektor';
    out.bufferMs = clampNum(src.bufferMs, BUF_RANGE[0], BUF_RANGE[1], PROFILE_DEFAULTS.bufferMs);
    out.holdMs = clampNum(src.holdMs, HOLD_RANGE[0], HOLD_RANGE[1], PROFILE_DEFAULTS.holdMs);
    out.textRate = clampTextRate(
      typeof src.textRate === 'number' ? src.textRate : PROFILE_DEFAULTS.textRate);
    out.textAuto = !!src.textAuto;
    out.lenMode = LEN_MODES.indexOf(src.lenMode) >= 0 ? src.lenMode : PROFILE_DEFAULTS.lenMode;
    out.precise = src.precise === undefined ? PROFILE_DEFAULTS.precise : !!src.precise;
    return out;
  }

  // Wczytuje magazyn profili. Przy pierwszym uruchomieniu (brak klucza)
  // tworzy jeden profil "Domyślny" z OBECNYCH ustawień, więc zachowanie
  // jest identyczne jak w 4.6.2 - migracja jest bezbolesna.
  function loadProfileStore() {
    let raw = '';
    try {
      if (typeof GM_getValue === 'function') raw = GM_getValue(PROFILE_STORE_KEY, '');
    } catch (e) { /*ignorujemy*/ }

    let data = null;
    if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }

    const list = [];
    if (data && Array.isArray(data.list)) {
      const seenIds = new Set();
      const seenNames = new Set();
      for (const item of data.list) {
        if (!item || typeof item !== 'object') continue;
        const p = sanitizeProfile(item);
        const nameKey = p.name.toLowerCase();
        if (seenIds.has(p.id) || seenNames.has(nameKey)) continue;   // duplikaty
        seenIds.add(p.id);
        seenNames.add(nameKey);
        list.push(p);
      }
    }

    if (!list.length) {
      // Migracja z 4.6.2: bierzemy to, co użytkownik już ma ustawione.
      list.push(sanitizeProfile({
        id: 'domyslny',
        name: 'Domyślny',
        bufferMs: state.bufferMs,
        holdMs: state.holdMs,
        textRate: state.textRate,
        textAuto: state.textAuto,
        lenMode: state.lenMode,
        precise: state.precise
      }));
    }

    let activeId = (data && typeof data.activeId === 'string') ? data.activeId : list[0].id;
    if (!list.some(p => p.id === activeId)) activeId = list[0].id;
    return { list, activeId };
  }

  const profileStore = loadProfileStore();
  let activeProfileId = profileStore.activeId;

  function activeProfile() {
    return profileStore.list.find(p => p.id === activeProfileId) || profileStore.list[0];
  }

  function saveProfileStore() {
    try {
      if (typeof GM_setValue === 'function')
        GM_setValue(PROFILE_STORE_KEY, JSON.stringify({
          v: 1, activeId: activeProfileId, list: profileStore.list
        }));
    } catch (e) { /*ignorujemy*/ }
  }

  // Przepisuje stan suwaków do aktywnego profilu. Wołane z persist(),
  // czyli po każdej zmianie któregokolwiek suwaka.
  function syncActiveProfile() {
    const p = activeProfile();
    if (!p) return;
    for (const f of PROFILE_FIELDS) p[f] = state[f];
    saveProfileStore();
  }

  // Przełączenie lektora: wczytujemy jego ustawienia do stanu i liczymy
  // okna ciszy od nowa (bufor i tempo zmieniają okna).
  function applyProfile(id) {
    const p = profileStore.list.find(x => x.id === id);
    if (!p) return false;
    state.bufferMs = p.bufferMs;
    state.holdMs = p.holdMs;
    state.textRate = p.textRate;
    state.textAuto = p.textAuto;
    state.lenMode = p.lenMode;
    state.precise = p.precise;
    activeProfileId = p.id;
    persist();                 // zapis stanu + profilu
    buildRegex();
    windows = [];
    plannedFor = -1;
    if (cueMode && cues.length) planFromCues();
    refreshProfileUI();
    schedulePanel();
    return true;
  }

  // Nowy lektor. fromCurrent=true kopiuje bieżące ustawienia (typowy
  // scenariusz: dostrajasz paski pod nowego lektora i klikasz "Zapisz jako").
  function createProfile(name, fromCurrent) {
    const src = fromCurrent
      ? {
          bufferMs: state.bufferMs, holdMs: state.holdMs, textRate: state.textRate,
          textAuto: state.textAuto, lenMode: state.lenMode, precise: state.precise
        }
      : Object.assign({}, PROFILE_DEFAULTS);

    let clean = (typeof name === 'string' ? name.trim() : '').slice(0, 32);
    if (!clean) clean = nextProfileName();
    // Nazwy muszą być unikalne, inaczej lista staje się nieczytelna.
    if (profileStore.list.some(p => p.name.toLowerCase() === clean.toLowerCase())) {
      let i = 2, candidate;
      do {
        candidate = (clean + ' ' + i).slice(0, 32);
        i++;
      } while (profileStore.list.some(p => p.name.toLowerCase() === candidate.toLowerCase()) && i < 100);
      clean = candidate;
    }

    const p = sanitizeProfile(Object.assign({ id: newProfileId(), name: clean }, src));
    profileStore.list.push(p);
    activeProfileId = p.id;
    saveProfileStore();
    return p;
  }

  // Usunięcie lektora. Nie wolno usunąć ostatniego - skrypt zawsze
  // musi mieć na czym pracować.
  function deleteProfile(id) {
    if (profileStore.list.length <= 1) return false;
    const idx = profileStore.list.findIndex(p => p.id === id);
    if (idx < 0) return false;
    const wasActive = id === activeProfileId;
    profileStore.list.splice(idx, 1);
    if (wasActive) {
      // Usuwamy aktywnego - wskakujemy na sąsiedniego i wczytujemy go.
      const next = profileStore.list[Math.min(idx, profileStore.list.length - 1)];
      activeProfileId = next.id;
      state.bufferMs = next.bufferMs;
      state.holdMs = next.holdMs;
      state.textRate = next.textRate;
      state.textAuto = next.textAuto;
      state.lenMode = next.lenMode;
      state.precise = next.precise;
      buildRegex();
      windows = [];
      plannedFor = -1;
      if (cueMode && cues.length) planFromCues();
    }
    saveProfileStore();
    persist();
    refreshProfileUI();
    schedulePanel();
    return true;
  }

  // Przywrócenie fabrycznych pasków bieżącego lektora.
  function resetActiveProfile() {
    const p = activeProfile();
    if (!p) return;
    Object.assign(p, PROFILE_DEFAULTS);
    applyProfile(p.id);
  }

  // Zmiana nazwy aktywnego lektora.
  function renameActiveProfile(name) {
    const p = activeProfile();
    if (!p) return;
    const clean = (typeof name === 'string' ? name.trim() : '').slice(0, 32);
    if (!clean || clean === p.name) return;
    p.name = clean;
    saveProfileStore();
    refreshProfileUI();
  }

  // Szybkie wejście z menu Tampermonkey: kolejny lektor z listy.
  function nextProfile() {
    if (profileStore.list.length < 2) return false;
    const i = profileStore.list.findIndex(p => p.id === activeProfileId);
    return applyProfile(profileStore.list[(i + 1) % profileStore.list.length].id);
  }

  // Wypełnia listę wyboru lektorów i przerysowuje wszystkie kontrolki
  // z ustawień właśnie wczytanego profilu. Wywoływana po każdej
  // zmianie profilu oraz przy budowie panelu.
  function refreshProfileUI() {
    const p = activeProfile();
    if (profSelEl) {
      profSelEl.innerHTML = '';
      for (const item of profileStore.list) {
        const o = document.createElement('option');
        o.value = item.id;
        o.textContent = item.name;
        profSelEl.appendChild(o);
      }
      profSelEl.value = activeProfileId;
    }
    if (profDelEl) profDelEl.disabled = profileStore.list.length <= 1;
    if (profNameEl) profNameEl.value = '';
    if (ttlEl && p) ttlEl.textContent = 'Cenzor v4.8.3 · ' + p.name;
    if (!p) return;
    // Suwaki pokazują wartości nowego profilu, nie poprzedniego.
    if (bufEl) bufEl.value = state.bufferMs;
    if (holdEl) holdEl.value = state.holdMs;
    if (textRateEl) textRateEl.value =
      clampTextRate(state.textAuto ? effectiveTextRate() : state.textRate).toFixed(2);
    if (textAutoEl) textAutoEl.checked = !!state.textAuto;
    if (lenEl) lenEl.value = state.lenMode;
    if (precEl) precEl.checked = !!state.precise;
    refreshPanel();
  }

  let wordRegex = null;

  function buildRegex() {
    const stems = [...new Set(wordStemsOf(state.words).map(w => {
      // Gwiazdka na końcu = wzorzec dowolnego zakończenia - zachowujemy ją.
      // Resztę brzegów czyścimy z interpunkcji: wpis "kurwa." (skopiowany
      // z napisów razem z kropką) ma działać jak "kurwa" i łapać "kurwa",
      // "kurwa." oraz "kurwa,".
      const wildcard = w.endsWith('*');
      const base = (wildcard ? w.slice(0, -1) : w).replace(PUNCT_RE, '');
      const cleaned = wildcard ? base + '*' : base;
      return cleaned.length >= 2 ? cleaned : null;
    }).filter(Boolean))];
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = [...new Set(stems.map(w => {
      if (w.endsWith('*')) { const b = esc(w.slice(0, -1)); return b ? b + '[\\p{L}\\p{N}]*' : null; }
      return esc(w);
    }).filter(Boolean))];
    if (!parts.length) { wordRegex = null; return; }
    const body = '(?:' + parts.join('|') + ')';
    try { wordRegex = new RegExp('(?<![\\p{L}\\p{N}])' + body + '(?![\\p{L}\\p{N}])', 'giu'); }
    catch (e) { wordRegex = new RegExp('\\b' + body + '\\b', 'gi'); }
    console.log('[Cenzor] lista słów: ' + parts.length + ' wzorców');
  }

  /* ============================================================
   * 3) PLANOWANIE OKIEN WYCISZENIA (z cue'ów - z wyprzedzeniem)
   * ============================================================ */

  let windows = [];       // { start, end } w sekundach
  let plannedFor = -1;    // ilu cue'ow juz uzylo do planowania

  // Ile dodatkowej ciszy dla dlugszego przeklestwa. "skurwysyn" trzymamy
  // dluzej niz "kurwa", bo jest wyrazem dluzszym i trwa dluzej.
  // 0 = wyłączone, 1 = standard, 2 = mocno.
  const LEN_FACTOR = { off: 0, normal: 1, strong: 2 };

  function extraHoldForWord(word) {
    const f = LEN_FACTOR[state.lenMode] !== undefined ? LEN_FACTOR[state.lenMode] : 1;
    if (f === 0) return 0;
    // 4 znaki = bazowo, kazdy kolejny znak dodaje ok. 90 ms ciszy
    return Math.max(0, (word.length - 4) * 90 * f);
  }

  // ----------------------------------------------------------------
  // calculateWordTimings - przyblizone czasy slow wewnatrz cue
  //
  // MODEL (segmentowy, wagi umowne - liczy sie tylko proporcja):
  //   samogloska                       -> 1.4  (rdzen sylaby, ~2x czas spolgloski)
  //   spolgloska lub dwuznak            -> 0.8  (dwuznak = JEDEN segment)
  //   "i" przed samogloska w naglosie  -> 0.8  (polsamogloska [j])
  //   "i" przed samogloska po spolgl.  -> 0    (tylko znak miekkosci: "nie")
  //   token z samej interpunkcji        -> 0.4  (sladowy, niezerowy)
  //   floory dla slowa                  -> 1.0
  //
  // To heurystyka: nie modeluje akcentu, tempa ani "rz" na granicy
  // morfemow ("marznac" liczone jak dwuznak).
  //
  // UWAGA O JEDNOSTCE: cue.start i cue.end sa JUZ w sekundach (dzielimy przez
  // 1000 juz na etapie przechwytywania). Nie dzielimy ich ponownie.
  //
  // ZAŁOŻENIE: cueText jest już oczyszczony ze znacznikow (<c>, &amp; itd.).
  // ----------------------------------------------------------------

  // "dzi" zwijamy tylko przed samogloska ("dzień" -> [djɛɲ]); w "dziki"/"grodzi"
  // po "dz" nastepuje pelne, sylabiczne "i", wiec zwijamy samo "dz".
  // Kolejnosc alternacji ma znaczenie: dluzsze wzorce pierwsze.
  const DIGRAPH_RE = /dzi(?=[aąeęioóuy])|dż|dź|dz|sz|cz|rz|ch/g;
  const VOWEL_RE = /[aąeęioóuy]/;
  // Interpunkcja = wszystko, co nie jest litera ani cyfra, na brzegach tokena.
  // Klasa \p{L}\p{N} zalatwia tez „ ” – — … « » itd.
  const PUNCT_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

  const W_VOWEL = 1.4;
  const W_CONSONANT = 0.8;   // takze dwuznak i [j]
  const W_PUNCT_ONLY = 0.4;
  const MIN_WORD_WEIGHT = 1.0;

  /**
   * @param {string} cleanWord - slowo bez interpunkcji, lowercase; moze byc puste
   * @returns {number} waga > 0
   */
  function estimateWeight(cleanWord) {
    if (!cleanWord) return W_PUNCT_ONLY;

    // Dwuznaki -> jeden placeholder, zeby liczyc je jako pojedyncza gloske.
    const collapsed = cleanWord.replace(DIGRAPH_RE, '#');
    let weight = 0;

    for (let i = 0; i < collapsed.length; i++) {
      const c = collapsed[i];
      const prev = collapsed[i - 1] || '';
      const next = collapsed[i + 1] || '';

      if (c === '#') {
        weight += W_CONSONANT;                    // dwuznak = 1 segment
      } else if (c === 'i' && VOWEL_RE.test(next)) {
        // "i" przed samogloska nie tworzy wlasnej sylaby:
        weight += (prev && !VOWEL_RE.test(prev))
          ? 0              // zmiekczenie: "nie" -> [ɲɛ] - "i" nie dodaje czasu
          : W_CONSONANT;   // naglosowe [j] - tyle co spolgloska
      } else if (VOWEL_RE.test(c)) {
        weight += W_VOWEL;
      } else {
        weight += W_CONSONANT;
      }
    }
    return Math.max(weight, MIN_WORD_WEIGHT);
  }

  /**
   * Oblicza przyblizone czasy slow wewnatrz cue, proporcjonalnie do wagi
   * fonetycznej.
   *
   * @param {string} cueText  - tekst cue (interpunkcja dozwolona)
   * @param {number} startTime - poczatek cue [s]
   * @param {number} endTime   - koniec cue [s], musi byc > startTime
   * @param {{roundMs?: boolean}} [options] - domyslnie zaokragla granice do ms
   * @returns {{word: string, start: number, end: number}[]}
   *   Czasy ciagle; ostatni end === endTime.
   * @throws {TypeError} gdy cueText nie jest stringiem
   * @throws {RangeError} gdy czasy nie sa skonczone lub endTime <= startTime
   */
  function calculateWordTimings(cueText, startTime, endTime, opts) {
    const roundMs = !opts || opts.roundMs !== false;
    if (typeof cueText !== 'string') {
      throw new TypeError('cueText musi być stringiem, otrzymano: ' + typeof cueText);
    }
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
      throw new RangeError(
        'Nieprawidłowy zakres czasu: startTime=' + startTime + ', endTime=' + endTime
      );
    }

    const text = cueText.trim();
    if (!text) return [];   // cue pusty lub z samych bialych znakow

    const round = roundMs
      ? (t) => Math.round(t * 1000) / 1000
      : (t) => t;

    const words = text.split(/\s+/).map((rawWord) => {
      const cleanWord = rawWord.toLowerCase().replace(PUNCT_RE, '');
      return { word: rawWord, weight: estimateWeight(cleanWord) };
    });

    // totalWeight > 0 z konstrukcji (kazda waga >= W_PUNCT_ONLY).
    const totalWeight = words.reduce((sum, w) => sum + w.weight, 0);
    const totalDuration = endTime - startTime;

    // Granice liczone z wagi kumulatywnej (nie przez akumulacje czasu) -
    // brak dryfu float, a siedsiednie slowa dostaja identyczna granice.
    let accWeight = 0;
    const timings = words.map((item) => {
      const start = round(startTime + (accWeight / totalWeight) * totalDuration);
      accWeight += item.weight;
      return {
        word: item.word,
        start,
        end: round(startTime + (accWeight / totalWeight) * totalDuration)
      };
    });

    timings[timings.length - 1].end = endTime;   // pelne pokrycie [startTime, endTime]
    return timings;
  }

  // Wyeksportowane globalnie — wersja rozszerzeniowa definiuje pełne
  // API (wraz z profilami lektorów) w sekcji 6a poniżej.

  // Okno pojedynczego slowa w kwestii - liczone modelem segmentowym powyzej.

  function wordTimesInCue(cue, match) {
    const text = cue.text || '';
    const cueStart = cue.start;              // juz sekundy
    const cueEnd = cue.end;
    const totalDuration = Math.max(0.1, cueEnd - cueStart);

    // timings[i] = { word, start, end }. Podzial slow jest identyczny jak w
    // calculateWordTimings (dzielenie po \s+), wiec indeksy sie zgadzaja.
    let timings;
    try {
      timings = calculateWordTimings(text, cueStart, cueStart + totalDuration);
    } catch (e) {
      // Obejmuje RangeError (bledny zakres cue) i TypeError (tekst nie-string).
      // PlanFromCues ma wtedy sciezke zapasowa i nie przestaje wyciszac.
      return null;
    }
    if (!timings.length) return null;

    // Znajdujemy numer slowa, w ktorym trafia pozycja z regexa.
    // (Nie indexOf - on zgubilby trafienie wewnątrz słowa.)
    let targetIndex = -1;
    let pos = 0;
    for (let i = 0; i < timings.length; i++) {
      while (pos < text.length && /\s/.test(text[pos])) pos++;
      const start = pos;
      const end = start + timings[i].word.length;
      if (match.index >= start && match.index < end) { targetIndex = i; break; }
      pos = end;
    }
    if (targetIndex === -1) return null;       // regex trafil w spacje

    // 0.15 s to bezpieczny dolny limit okna: po zaokragleniu do ms skrajnie
    // krotkie slowo (gloska "o") moglo by dostac 20 ms, a tyle za krotkie
    // okno i tak nie zdazy zglosic w petli tick.
    const slot = timings[targetIndex];
    return { from: slot.start, to: Math.max(slot.end, slot.start + 0.15) };
  }

  function planFromCues() {
    if (!wordRegex) buildRegex();
    // Bufory/trzymania sa podawane w ms CZASU RZECZYWISTEGO, wiec przeliczamy
    // je na sekundy CZASU MATERIALU przez TEMPO TEKSTU (patrz
    // realMsToMaterial + effectiveTextRate). Przy Auto tempo tekstu = tempo
    // filmu; przy recznym - wartosc z suwaka, niezalezna od playbackRate.
    const rate = effectiveTextRate();
    const buf = realMsToMaterial(state.bufferMs, rate);
    const hold = realMsToMaterial(state.holdMs, rate);
    const out = [];

    for (const c of cues) {
      wordRegex.lastIndex = 0;
      const matches = findMatches(c.text);
      if (!matches.length) continue;

      for (const m of matches) {
        let start, end;
        if (state.precise) {
          // Okno tylko na samo slowo: od pierwszego glosu slowa do jego konca,
          // powiekszone o bufor PRZED i hold PO. Dzieki temu nie wyciszamy
          // dwoch czystych wyrazow stojacych za przeklestwem.
          const wt = wordTimesInCue(c, m);
          // wordTimesInCue zwraca null, gdy regex trafil w spacje albo
          // tekst jest pusty. Wtedy cofamy do prostej proporcji dlugosci,
          // zeby nigdy nie zglosic bledu i nie przestac wyciszac.
          if (!wt) {
            const dur = Math.max(0.2, c.end - c.start);
            const total = c.text.length || 1;
            const f = c.start + (m.index / total) * dur;
            start = f - buf;
            end = f + (m.word.length / total) * dur + hold
                + realMsToMaterial(extraHoldForWord(m.word), rate);
          } else {
            start = wt.from - buf;
            end = wt.to + hold + realMsToMaterial(extraHoldForWord(m.word), rate);
          }
        } else {
          // Prostszy wariant: cala kwestia.
          start = c.start - buf;
          end = c.end + hold;
        }
        out.push({ start: Math.max(0, start), end });
      }
    }

    out.sort((a, b) => a.start - b.start);
    // Sklejamy nachodzace na siebie okna, zeby nie odtwarzalo ciszy
    // miedzy wyrazami jednej kwestii.
    windows = [];
    for (const w of out) {
      const last = windows[windows.length - 1];
      if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
      else windows.push(w);
    }
    plannedFor = cues.length;
    announce();
    refreshPanel();
  }

  /* ============================================================
   * 4) TRYB AWARYJNY: DOM (identyczny mechanizm jak w wersji 3.1)
   * Uzywamy go wylacznie gdy przechwycenie cue'ow sie nie udalo.
   * ============================================================ */

  let lastSub = '';
  let lastSubHasProf = false;
  let domWin = null;        // { start, end, open }
  const LINE_SAFETY_MAX = 25;

  function currentSubtitleRaw() {
    let nodes = document.querySelectorAll('.player-timedtext-text-container');
    if (!nodes.length) nodes = document.querySelectorAll('.player-timedtext');
    if (!nodes.length) return '';
    return Array.from(nodes).map(n => n.textContent || '').join(' ');
  }

  function findMatches(flat) {
    if (!wordRegex) return [];
    const out = []; let m;
    wordRegex.lastIndex = 0;
    while ((m = wordRegex.exec(flat))) {
      out.push({ word: m[0], index: m.index });
      if (m.index === wordRegex.lastIndex) wordRegex.lastIndex++;
    }
    return out;
  }

  function subtitlesVisible() {
    let nodes = document.querySelectorAll('.player-timedtext-text-container');
    if (!nodes.length) nodes = document.querySelectorAll('.player-timedtext');
    for (const n of nodes) {
      if (!(n.textContent || '').trim()) continue;
      if (typeof n.checkVisibility === 'function') {
        if (n.checkVisibility({ visibilityProperty: true })) return true;
        continue;
      }
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }

  function openDomMute(v, t0) {
    // Tez przeliczamy przez tempo tekstu, zeby wyprzedzenie bylo spojne z CUE.
    const lead = realMsToMaterial(state.bufferMs, effectiveTextRate());
    domWin = { start: Math.max(0, t0 - lead), end: Infinity, open: true };
    applyMute(true);
  }

  function closeDomMute() {
    if (!domWin) return;
    const v = mainVideo();
    const now = v ? v.currentTime : 0;
    // Cisza trwa jeszcze "trzymaj" ms po zniknieciu napisu.
    domWin.end = now + realMsToMaterial(state.holdMs, effectiveTextRate());
    const still = now >= domWin.start && now < domWin.end;
    domWin = null;
    setDot(still);
  }

  function checkSubtitle() {
    const flat = currentSubtitleRaw().replace(/\s+/g, ' ').trim();
    if (flat === lastSub) return;
    lastSub = flat;
    if (!flat) { lastSubHasProf = false; if (domWin && domWin.open) closeDomMute(); return; }
    lastSubHasProf = findMatches(flat).length > 0;
    if (state.enabled && lastSubHasProf) {
      const v = mainVideo();
      if (v) { if (!domWin) openDomMute(v, v.currentTime); setDot(true); }
    }
  }

  /* ============================================================
   * 5) WYCISZANIE I PĘTLA GŁÓWNA
   * ============================================================ */

  function mainVideo() {
    let best = null, bestA = 0;
    document.querySelectorAll('video').forEach(v => {
      const a = (v.videoWidth || 0) * (v.videoHeight || 0);
      if (a > bestA) { bestA = a; best = v; }
    });
    return best;
  }

  // Aktualna predkosc odtwarzania. Zabezpieczona przed dziesietkami/NaN,
  // bo niektore przegladarki chwilowo zwracaja dziwne wartosci.
  function speedOf() {
    const v = mainVideo();
    const r = v ? Number(v.playbackRate) : NaN;
    if (!isFinite(r) || r <= 0) return 1;
    return Math.min(4, Math.max(0.25, r));
  }

  // Przelamia marz z milisekund CZASU RZECZYWISTEGO na sekundy CZASU
  // MATERIALU (czyli na te same jednostki, w ktorych zyje video.currentTime).
  //
  // Dlaczego mnozymy, a nie dzielimy: przy predkosci 1.5x filmowy licznik
  // currentTime przebiega 1.5 s na kazda sekunde zegara. Okno 0.8 s
  // materialu mija wiec po 0.8/1.5 = 533 ms REALNIE. Zeby zawsze dostac
  // zadeklarowane 800 ms na zegarze, okno musi byc 0.8 * 1.5 = 1.2 s
  // materialu. Stę mnożenie.
  //
  // To ten sam wzorz co w v5/v6 dla Pipera (tam naturalne tempo dzielimy
  // przez rate, bo Piper mierzy w tempie 1.0).
  function realMsToMaterial(ms, rate) {
    return Math.max(0, ms) / 1000 * rate;
  }

  // Tempo TEKSTU do planowania ciszy (v4.6.0): niezalezne od tempa filmu.
  // Auto = tempo filmu (zachowanie jak w 4.5.0); recznie = suwak 0.25-2.5.
  function clampTextRate(r) {
    const n = Number(r);
    if (!isFinite(n) || n <= 0) return 1;
    return Math.min(2.5, Math.max(0.25, n));
  }

  function effectiveTextRate() {
    if (state.textAuto) return speedOf();
    return clampTextRate(state.textRate);
  }

  const userMutedBefore = new WeakMap();
  let muteWas = false;

  function applyMute(want) {
    if (want === muteWas) return;
    document.querySelectorAll('video').forEach(v => {
      if (want) { userMutedBefore.set(v, v.muted); v.muted = true; }
      else { v.muted = userMutedBefore.get(v) === true; userMutedBefore.delete(v); }
    });
    muteWas = want;
    setDot(want);
  }

  let lastT = null;
  let lastRate = null;     // predkosc, dla ktorej okna sa obecnie zplanowane

  // ------------------------------------------------------------------
  // WYKRYWANIE ZMIANY TYTULU/ODCINKA.
  //
  // Netflix jest SPA - przejscie do kolejnego odcinka (autoplay lub
  // reczne) NIE przeladowuje strony. Nasz patch na Array.prototype.push
  // zyje wiec dalej i DOPISUJE nowe cue do tej samej tablicy "cues",
  // ktora wciaz zawiera napisy z poprzedniego odcinka. Skutek: przy tym
  // samym czasie odtwarzania (np. 12:34) w nowym odcinku moze nie byc
  // zadnego dialogu, a skrypt i tak wyciszy, bo w "windows" siedzi stare,
  // juz nieaktualne okno z poprzedniego tytulu. Powtarza sie to cyklicznie
  // co odcinek - stad "co jakis czas cisza bez zdania, regularnie".
  //
  // Rozwiazanie: sledzimy id odcinka z URL (/watch/<id>) i przy kazdej
  // zmianie czyscimy caly stan zwiazany z napisami od zera.
  // ------------------------------------------------------------------
  let currentWatchId = null;

  function watchIdFromUrl() {
    const m = location.pathname.match(/\/watch\/(\d+)/);
    return m ? m[1] : null;
  }

  function resetForNewTitle() {
    cues.length = 0;
    seenCueKeys.clear();
    cueMode = false;
    windows = [];
    plannedFor = -1;
    lastT = null;
    lastRate = null;
    domWin = null;
    lastSub = '';
    lastSubHasProf = false;
    applyMute(false);
    schedulePanel();
    console.log('[Cenzor] nowy tytul wykryty - czyszcze stare napisy');
  }

  function checkWatchIdChange() {
    const id = watchIdFromUrl();
    if (id !== currentWatchId) {
      currentWatchId = id;
      if (id) resetForNewTitle();
    }
  }

  function tick() {
    checkWatchIdChange();
    const v = mainVideo();
    if (v) {
      const t = v.currentTime;
      // Wykrywamy zmiane predkosci (albo przewinciecie). Okna planujemy
      // w sekundach CZASU MATERIALU, wiec po zmianie tempa trzeba je
      // przeliczyc - inaczej marginesy w milisekundach bylyby zalezne
      // od tego, przy jakiej predkosci akurat zlapalismy cue'y.
      const rate = speedOf();
      const speedChanged = lastRate !== null && rate !== lastRate;
      if (speedChanged) schedulePanel();   // odśwież napis o predkosci
      if (speedChanged || (lastT !== null && Math.abs(t - lastT) > 1.5)) {
        windows = [];
        plannedFor = -1;
        if (cueMode && cues.length) planFromCues();
      }
      lastT = t;
      lastRate = rate;

      let want = false;
      if (cueMode) {
        if (cues.length && plannedFor !== cues.length) planFromCues();
        want = state.enabled && windows.some(w => t >= w.start && t < w.end);
      } else {
        // awaria: okno DOM trzymamy az do znikniecia napisu
        if (domWin && domWin.end === Infinity) {
          if (!subtitlesVisible()) closeDomMute();
          else if (t - domWin.start > LINE_SAFETY_MAX) closeDomMute();
        }
        want = state.enabled && !!domWin && t >= domWin.start && t < domWin.end;
      }
      applyMute(!!want);

      // sprzatanie przetartych okien
      while (windows.length && windows[0].end + 5 < t) windows.shift();
    }
    requestAnimationFrame(tick);
  }

/* ============================================================
   * 6) STEROWANIE — WERSJA ROZSZERZENIE (bez panelu na stronie)
   *
   * Panel z userscriptu jest tu celowo wyłączony: w rozszerzeniu
   * wszystko obsługuje popup (ikona na pasku), a mostek niżej
   * (window.ncz.*) udostępnia popupowi dokładnie te same operacje,
   * które w userscripcie robił panel na stronie.
   *
   * Stuby zachowują oryginalne nazwy, żeby wywołania w sekcjach 1-5
   * (schedulePanel / refreshPanel / setDot / applyWordsFold) pozostały
   * bezpieczne i nie musiały być wycinane z logiki.
   * ============================================================ */

  var NO_PAGE_PANEL = true;   // panel na stronie wyłączony — tylko popup

  let panel = null, dotEl = null, statusEl = null, modeEl = null,
      bufEl = null, bufVal = null, holdEl = null, holdVal = null,
      wordsEl = null, planPanel = null, refreshTimer = null,
      textRateEl = null, textRateVal = null, textAutoEl = null,
      ttlEl = null, lenEl = null, precEl = null;
  let profSelEl = null, profNameEl = null, profDelEl = null;
  let wordsBox = null, wordsToggle = null;

  const fmtRate = r => Number(r).toFixed(2).replace(/\.?0+$/, '') + 'x';
  const fmt = ms => ms >= 1000 ? (ms / 1000).toFixed(2).replace('.00', '.0') + ' s' : ms + ' ms';

  function setDot(on) { /* brak panelu = brak kropki */ }
  function schedulePanel() { /* brak panelu */ }
  function applyWordsFold() { /* brak ramki listy słów na stronie */ }
  function clampToViewport(el) { /* brak panelu */ }
  function applyMin() { }
  function buildPanel() { }
  function panelSetup() { }

  function refreshPanel() {
    // Popup nie ma stale otwartego panelu, ale tryb pracy (CUE / AWARIA)
    // jest przydatny diagnostycznie — trzymamy go w tytule strony,
    // żeby dało się sprawdzić, czy przechwycenie cue'ów zadziałało.
    try {
      if (!cueMode) return;
      document.title = 'CUE: ' + cues.length + ' napisow';
    } catch (e) { /*ignorujemy*/ }
  }

  // Panel w userscripcie był otwierany z menu Tampermonkey. W rozszerzeniu
  // nie ma menu skryptu, więc zostawiamy funkcję jako bezpieczny no-op
  // (mostek może ją wywołać, ale nic się nie stanie).
  function setPanelVisible(visible) { state.panelOpen = !!visible && !NO_PAGE_PANEL; }
  function togglePanel() { setPanelVisible(!state.panelOpen); }

  /* ============================================================
   * 6a) MOSTEK: window.ncz.* — API dla popupu rozszerzenia
   *
   * Popup (świat ISOLATED) nie ma dostępu do zawartości strony, więc
   * content-bridge.js przekazuje wywołania przez window.postMessage.
   * Poniższe funkcje są jedynym wejściem do ustawień i profili.
   * ============================================================ */

  const GLOBAL_FIELDS = ['enabled', 'words', 'showHelp'];
  const PROFILE_FIELDS_EXT = ['bufferMs', 'holdMs', 'textRate', 'textAuto',
                              'lenMode', 'precise'];

  function snapshot() {
    return {
      settings: JSON.parse(JSON.stringify(state)),
      profiles: JSON.parse(JSON.stringify({
        activeId: activeProfileId,
        list: profileStore.list
      }))
    };
  }

  function clampState() {
    state.bufferMs = clampNum(state.bufferMs, BUF_RANGE[0], BUF_RANGE[1], PROFILE_DEFAULTS.bufferMs);
    state.holdMs = clampNum(state.holdMs, HOLD_RANGE[0], HOLD_RANGE[1], PROFILE_DEFAULTS.holdMs);
    state.textRate = clampTextRate(state.textRate);
    state.textAuto = !!state.textAuto;
    state.lenMode = LEN_MODES.indexOf(state.lenMode) >= 0 ? state.lenMode : PROFILE_DEFAULTS.lenMode;
    state.precise = !!state.precise;
    state.showHelp = !!state.showHelp;
    state.enabled = !!state.enabled;
    // Panel na stronie pozostaje wyłączony.
    state.panelOpen = false;
  }

  function replan() {
    buildRegex();
    windows = [];
    plannedFor = -1;
    if (cueMode && cues.length) planFromCues();
    else schedulePanel();
  }

// publiczne API dla mostku
  try {
    window.ncz = window.ncz || {};
    Object.assign(window.ncz, {
      calculateWordTimings: calculateWordTimings,
      wordTimesInCue: wordTimesInCue,
      speedOf: speedOf,
      realMsToMaterial: realMsToMaterial,
      effectiveTextRate: effectiveTextRate,
      clampTextRate: clampTextRate,
      profiles: function () {
        return JSON.parse(JSON.stringify({
          activeId: activeProfileId, list: profileStore.list
        }));
      },
      getSettings: function () {
        try { return snapshot(); } catch (e) { return { settings: state, profiles: null }; }
      },
      applySettings: function (patch) {
        if (!patch || typeof patch !== 'object') return false;
        for (const k of GLOBAL_FIELDS) {
          if (patch[k] !== undefined) state[k] = patch[k];
        }
        for (const k of PROFILE_FIELDS_EXT) {
          if (patch[k] !== undefined) state[k] = patch[k];
        }
        clampState();
        persist();          // zapis + sync do aktywnego profilu
        replan();           // nowe tempo/bufor => nowe okna ciszy
        return true;
      },
      status: function () {
        return {
          cueMode: cueMode, cues: cues.length, windows: windows.length,
          enabled: !!state.enabled, profile: (activeProfile() || {}).name || ''
        };
      },
      // hooki testowe (jak w userscripcie)
      __test_plan: function (text, start, end) {
        cues.length = 0;
        cues.push({ start: start, end: end, text: text });
        cueMode = true;
        windows = [];
        plannedFor = -1;
        planFromCues();
        return windows.length;
      },
      __test_windows: function () { return windows.map(w => ({ start: w.start, end: w.end })); }
    });

    // Wiadomości z content-bridge.js (świat ISOLATED).
    window.addEventListener('message', function (ev) {
      if (ev.source !== window) return;
      var d = ev.data;
      if (!d || d.source !== 'ncz-bridge' || !d.type) return;
      try {
        if (d.type === 'ncz-get-settings') {
          window.postMessage({ source: 'ncz-main', type: 'ncz-settings-push',
            reqId: d.reqId, settings: window.ncz.getSettings() }, '*');
        } else if (d.type === 'ncz-apply-settings') {
          window.ncz.applySettings(d.settings || {});
        }
      } catch (e) { /*ignorujemy*/ }
    });
  } catch (e) { /*ignorujemy*/ }

  /* ============================================================
   * 7) START
   * ============================================================ */

  function ready(fn) {
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  // Wczytanie do stanu parametrów aktywnego lektora. Po migracji (4.6.2)
  // profil przejmuje władzę nad trzema paskami, więc przy każdym starcie
  // to on jest źródłem prawdy - nie stan zapisany w SETTINGS_KEY.
  function hydrateStateFromProfile() {
    const p = activeProfile();
    if (!p) return;
    state.bufferMs = p.bufferMs;
    state.holdMs = p.holdMs;
    state.textRate = p.textRate;
    state.textAuto = p.textAuto;
    state.lenMode = p.lenMode;
    state.precise = p.precise;
  }

  buildRegex();
  hydrateStateFromProfile();
  // Zapis pierwszego profilu od razu, żeby przy kolejnym starcie
  // nie tworzyć go od nowa.
  saveProfileStore();
  // Oczyszczone śmieci z localStorage wracają na dysk od razu.
  if (settingsDirty) persist();
  // Panel na stronie wyłączony — nie utrzymujemy jego stanu w ogóle.
  state.panelOpen = false;

  ready(() => {
    if (cueMode && cues.length) planFromCues();
    // Awaria: sprawdzamy co 500 ms napisy z DOM (jak w 3.1).
    setInterval(() => { if (!cueMode) checkSubtitle(); }, 500);
    requestAnimationFrame(tick);
    console.log('[Cenzor v4.8.3 EXT] start. lektor="' + (activeProfile() || {}).name
      + '" bufor=' + state.bufferMs + ' trzymaj=' + state.holdMs
      + ' tempo=' + state.textRate + (state.textAuto ? ' (auto)' : '')
      + ' | cueMode=' + cueMode + ' cues=' + cues.length);
  });
})();

/* Eksport do testow. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calculateWordTimings: (typeof window !== 'undefined' && window.ncz) ? window.ncz.calculateWordTimings : null
  };
}
