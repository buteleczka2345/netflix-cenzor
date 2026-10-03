# Netflix Cenzor v4.5.2

Rozszerzenie Chrome (Manifest V3), które **wycisza przekleństwa w filmach i serialach na Netflixie** — dokładnie wtedy, gdy padają, bez pobierania i bez modyfikowania strumienia wideo.

> ⚠️ To narzędzie **nie obchodzi** ochrony regionalnej ani DRM Netflixa. Pracuje wyłącznie na warstwie odtwarzacza w Twojej przeglądarce, na Twoim własnym koncie.

---

## Czym to jest — w skrócie

Netflix trzyma napisy w wewnętrznej tablicy obiektów (tzw. cue'ach). Rozszerzenie **przechwytuje tę tablicę** przez podmianę `Array.prototype.push` — zanim odtwarzacz zdąży ją wyświetlić — wyciąga tekst kwestii i sprawdza go wzorcami przekleństw. Jeśli któreś słowo się zgadza, skrypt **wycisza `video` na ułamek sekundy przed słowem** i przywraca dźwięk tuż po nim.

Dzięki temu cisza trafia idealnie w brzmienie słowa, a nie „gdzieś w okolicy".

## Jak to działa — technicznie

| Element | Rola |
|---|---|
| `manifest.json` | Deklaracja MV3. Jedyne uprawnienie: `storage` + host `https://www.netflix.com/*`. |
| `content-main.js` | Główny skrypt, uruchamiany w **świecie MAIN** (`world: "MAIN"`) — dzięki temu patch `Array.prototype.push` widzi dokładnie te same tablice, co odtwarzacz Netflixa. Zawiera też shim `GM_*` (Tampermonkey → localStorage). |
| `content-bridge.js` | Pośrednik w świecie ISOLATED: most między stroną a popupem oraz `chrome.storage`. |
| `popup.html` / `popup.js` | Panel ustawień po kliknięciu ikony rozszerzenia. |
| `icons/` | Ikony 16/48/128 px (czerwona ikona Netflixa z przekreślonym głośnikiem). |
| `gen_icons.py` | Opcjonalny skrypt Pythona (Pillow) generujący ikony. |

### Przechwytywanie napisów (tryb CUE)

```js
const origPush = Array.prototype.push;
Array.prototype.push = function () {
  // wykrycie tablicy cue'ów po obecności `blocks` i liczbowym `startTime`
  ...
};
```

Sposób rozpoznania tablicy cue'ów: pierwszy element ma pole `blocks` oraz numeryczne `startTime`.

### Model segmentowy czasu słowa

Długość ciszy **nie** liczona jest jako liczba liter. Każdy znak dostaje wagę:

- samogłoska — **1.4**
- spółgłoska / dwuznak — **0.8**
- półsamogłoska „i" — **0.8** (lub 0)
- interpunkcja — **0.4**

To znacznie lepiej odwzorowuje polską fonetykę niż suma liter. Czasy są ciągłe, a ostatnie słowo w kwestii kończy się dokładnie na `endTime`.

### Bufor, trzymanie i tempo tekstu

Bufor i czas trzymania ciszy są skalowane przez **tempo tekstu** — ustawiasz, jakim tempem liczymy okna, niezależnie od prędkości odtwarzania filmu. Tryb `Auto` kopiuje tempo tekstu z tempa filmu, więc przy zmianie prędkości odtwarzania ustawienia same się dostosowują.

## Funkcje

- **Wyciszanie przekleństw w napisach** — 55 domyślnych wzorców (polskie + angielskie), z obsługą `*` (np. `kurw*` łapie `kurwa`, `kurwy`, `kurwać`).
- **Naprawa odcinków (SPA)** — Netflix nie przeładowuje strony przy przejściu do kolejnego odcinka, więc stare cue'y zostawały w pamięci i cisza pojawiała się cyklicznie „w złych miejscach". Skrypt śledzi ID odcinka z adresu (`/watch/<id>`) i przy zmianie czyści stare cue'y oraz natychmiast przywraca dźwięk.
- **Łączenie fragmentów napisu spacją** — Netflix dzieli jedną kwestię na kilka bloków; sklejanie bez spacji tworzyło „słowa" typu `kurwaco`, przez co końcowe przekleństwo przepuszczało ciszę.
- **Interpunkcja w wzorcach** — wpis `kurwa.` jest czyszczony z brzegów i działa jak `kurwa` (łapie też `kurwa,` i `kurwę?`).
- **Lista słów, którą edytujesz** — nowe wzorce dopisują się raz, potem możesz je usunąć i same nie wrócą.

### Świadomie wycofane: profile lektorów

W `content-main.js` została warstwa profili (`PROFILE_STORE_KEY`, `activeProfileId`, `applyProfile`), ale **nie ma do niej interfejsu** — `popup.html` nie zawiera żadnych kontrolek lektora, a `content-bridge.js` nie obsługuje wiadomości profili. Kod jest martwy: zapisuje się w localStorage, ale nie da się nim sterować z okna rozszerzenia.

To celowe — funkcja została porzucona. Nie usuwaj tej warstwy, chyba że chcesz ją dokończyć; brakuje wtedy `importProfiles()` oraz obsługi wiadomości `ncz-apply-profiles` i `ncz-profile`.

## Instalacja (tryb dewelopera, ~2 minuty)

1. Otwórz `chrome://extensions`.
2. Włącz **Tryb dewelopera** (prawy górny róg).
3. Kliknij **Załaduj rozpakowane** (*Load unpacked*).
4. Wskaż folder z plikiem `manifest.json` (ten z repo).
5. Przypnij ikonę rozszerzenia na pasku.
6. Wejdź na `https://www.netflix.com/` i **odśwież kartę (F5)** — content script musi wstrzyknąć się przy ładowaniu strony.

Nie trzeba niczego budować ani instalować poza Pythona. Nie ma serwera, nie ma procesu w tle.

### Pobieranie

Pobierz repo (kopiuj lub **Download ZIP**), rozpakuj i wskaż folder z `manifest.json` w oknie „Load unpacked".

## Używanie

Całe sterowanie jest w **popupie** (ikona rozszerzenia na pasku). Panel na stronie odtwarzacza jest celowo wyłączony.

Popup zapisuje **na żywo**, gdy karta Netflix jest otwarta; gdy jej nie ma — zapisuje kopię, która zastosuje się przy następnym odświeżeniu.

### Co jest w popupie

| Kontrolka | Znaczenie |
|---|---|
| **Cenzor włączony** | Główny włącznik. |
| **Wstecz** | O ile milisekund **wcześniej** włącza się cisza. |
| **Przód** | Jak długo cisza jest trzymana **po** końcu słowa. |
| **Długość słowa** | `wyłącz` / `normalnie` / `mocno` — dłuższe przekleństwo trzymane dłużej. |
| **Tempo tekstu** | Jakim tempem liczymy okna (0.25x–2.5x), niezależnie od prędkości filmu. |
| **Auto** | Tempo tekstu kopiuje tempo filmu. Przycisk `1x` — szybki reset. |
| **Tylko samo słowo** | Wycisza ciasno samo słowo zamiast całej kwestii. |
| **Lista słów** | Wzorce oddzielone przecinkami, obsługuje `*` (np. `kurw*`). Zwijana, stan zapamiętywany. |

Ściąga z autorem (w skrócie):

- **słychać początek słowa → Wstecz w górę** (cisza wchodzi za późno),
- **słychać końcówkę → Przód w górę** (cisza puszcza się za wcześnie).

## Ważne

- **Nie uruchamiaj tego razem z userscriptem 4.5.0 w Tampermonkey.** Dwa skrypty będą walczyć o `video.muted` — ma zostać **jeden**: albo userscript, albo to rozszerzenie.
- Suwaki w popupie zapisują się same — nie trzeba klikać „Zapisz".

## Prywatność i bezpieczeństwo

- Uprawnienia: `storage` + dostęp tylko do `https://www.netflix.com/*`.
- **Zero sieci.** Kod nie wykonuje żadnych zapytań `fetch`/`XHR`, nie ładuje zewnętrznych skryptów, nie używa `eval`, nie czyta i nie zapisuje ciasteczek. Jedyne miejsce przechowywania ustawień to `chrome.storage.local` oraz `localStorage` samego Netflixa (klucze `ncz4ext:*`).
- Kod nie omija DRM ani ochrony regionalnej — nie pobiera treści wideo.

## Odwracanie zmian

1. Usuń rozszerzenie w `chrome://extensions`.
2. Opcjonalnie wyczyść ustawienia strony: DevTools (F12) → Application → Local Storage → `www.netflix.com` → klucze `ncz4ext:*`.

## Wymagania

**Chrome 111+** (potrzebny świat MAIN w content scripts). Działa też na Edge/Opera/Brave (Chromium).

## Licencja

MIT — patrz [LICENSE](LICENSE).
