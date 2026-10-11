# jsonList — baza treści gry „Human or AI?"

Listy linków (obrazy, wideo, muzyka), które gra pobiera bezpośrednio z tego repozytorium, oraz boty,
które pilnują, żeby linki działały, i proponują nowe treści.

- Gra: [`JakubJakubiak/Ai-or-people`](https://github.com/JakubJakubiak/Ai-or-people)
- Strona: [`JakubJakubiak/web-ai-vs-humna`](https://github.com/JakubJakubiak/web-ai-vs-humna)

> Uwaga: gałąź `main` jest „produkcją". Aplikacja czyta pliki z `raw.githubusercontent.com/.../main/`,
> więc każda zmiana list od razu trafia do graczy.

## Pliki, które czyta gra

| Plik | Co zawiera | Format wpisu |
|---|---|---|
| `humnOrAi.json` | obrazy AI i ludzkie | `{ "humanOrAi": [ { "link", "op": "ai" \| "human", "credit"?, "new"? } ] }` |
| `video_links_ai.json` | wideo AI | `[ { "url", "op": "ai" } ]` |
| `video_links_human.json` | wideo ludzkie | `[ { "url", "op": "human", "credit"? } ]` |
| `tinyncsmusic.json` | muzyka ludzka | `[ { "url", "track", "artistraw", "cover", "credit"? } ]` |
| `SunoMusicList.json` | muzyka AI (Suno) | `{ "playlists": [ { "playlist_clips": [ { "clip": { "audio_url", "title", "image_url" } } ] } ] }` |

W obrazach kluczem musi być **`link`** (nie `url`) — starsze wersje aplikacji czytają tylko `link`.
`credit` to autor i licencja; gra pokazuje go po odpowiedzi (wymagane przy licencjach CC).

Pozostałe pliki `*.json` (`ncsmusic.json`, `catsLink.json`, `space.json` itd.) to zapasy i dane innych
projektów; gra ich nie pobiera.

## Boty

Wszystko to skrypty Node 20+ bez zależności, uruchamiane przez GitHub Actions (1. i 15. dnia miesiąca)
albo ręcznie.

### 1. Sprawdzanie linków — `check-links.mjs` (workflow „Check links")

- Sprawdza każdy link ze wszystkich list.
- Martwe wpisy (404/410, usunięty obrazek, HTML zamiast pliku, 403 trzy razy z rzędu) **przenosi** do
  `old.json` — nic nie jest kasowane na stałe.
- Zapisuje historię w `link-status.json` i raport w `LINK_REPORT.md`.
- Zabezpieczenie: jeśli ponad połowa linków w pliku wygląda na martwe, plik nie jest ruszany
  (to raczej awaria sieci).

### 2. Odświeżanie muzyki AI — `refresh-suno.mjs`

- Pobiera playlisty z `suno-playlists.json` z publicznego API Suno (bez logowania) i odbudowuje
  `SunoMusicList.json`.
- Suno nie udostępnia już mp3 niezalogowanym, więc źródłem dźwięku jest publiczny plik mp4 utworu
  (wpisywany w `audio_url`, żeby stare wersje gry działały bez zmian).
- Każdy link jest sprawdzany; gdy API zwróci za mało wyników, plik zostaje bez zmian.
- Żeby dodać muzykę AI, dopisz ID playlisty do `suno-playlists.json`.

### 3. Propozycje nowych treści — `ingest.mjs` (workflow „Ingest new content")

Szuka nowych treści w źródłach z `sources.json`, sprawdza linki i dopisuje **propozycje** do
`pending.json`. Podgląd z miniaturami jest w [`PENDING.md`](PENDING.md). Nic nie trafia do gry bez
zatwierdzenia.

| Źródło | Co daje | Klucz |
|---|---|---|
| Wikimedia Commons (wyróżnione zdjęcia, obrazy, portrety, jedzenie, miasto) | obrazy ludzi | nie |
| Civitai | obrazy AI (bez treści dla dorosłych) | nie |
| NASA | wideo ludzi | nie |
| Incompetech, `ncsmusic.json` | muzyka ludzi | nie |
| Pexels (zdjęcia i wideo) | treści ludzi | sekret `PEXELS_API_KEY` (darmowy) |

Nowe źródło to nowy wpis w `sources.json`: `name`, `label` (`ai`/`human`), `type`
(`image`/`video`/`audio`), `format`, `url`, `target` (plik docelowy), `limit`.

### 4. Zatwierdzanie — `approve.mjs` (workflow „Approve pending")

Actions → **Approve pending** → Run workflow:

- `approve`: `all` albo ID z `PENDING.md` oddzielone spacjami,
- `reject`: ID do odrzucenia albo `rest` (wszystko poza zatwierdzonymi).

Zatwierdzone wpisy trafiają do właściwej listy w formacie gry, odrzucone do `rejected.json`
(bot nie zaproponuje ich ponownie). Można też ręcznie ustawić w `pending.json` `"approved": true`
lub `"rejected": true`.

## Uruchamianie lokalnie

```bash
node check-links.mjs
node refresh-suno.mjs
node ingest.mjs
PREVIEW_ONLY=1 node ingest.mjs
APPROVE="id1 id2" REJECT=rest node approve.mjs
```

`PREVIEW_ONLY=1` tylko odświeża `PENDING.md`, bez szukania nowych treści.

## Dobre praktyki

- Przed zatwierdzeniem obejrzyj miniatury — w galeriach AI trafiają się znaki wodne, marki i postacie
  z cudzych utworów.
- Dbaj o różnorodność: jeśli ludzkie treści to same zdjęcia, a AI same ilustracje, styl zdradza odpowiedź.
- Linki do cudzych serwerów mogą zniknąć. Własne pliki najlepiej trzymać w darmowym magazynie
  (np. Cloudflare R2) i tutaj podawać tylko adresy.
