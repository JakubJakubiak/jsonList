// refresh-suno.mjs (Node 20+, zero zależności)
// Odświeża SunoMusicList.json z publicznego API playlist Suno (bez logowania).
// - playlisty do pobrania: suno-playlists.json (same ID; dopisz kolejne, żeby dodać muzykę)
// - Suno nie podaje już mp3 niezalogowanym (audio_url = .../api/forbidden), więc jako
//   źródło dźwięku bierzemy publiczny video_url (mp4 z AAC) i wpisujemy go w audio_url.
//   Struktura pliku zostaje taka sama, więc stare wersje aplikacji też działają.
// - utwory, które zniknęły z playlist, zostają w pliku dopóki ich link odpowiada.
// - przy awarii API (mało wyników) plik NIE jest nadpisywany.
import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://studio-api.prod.suno.com/api/playlist';
const OUT = 'SunoMusicList.json';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_PAGES = 10;
const MIN_CLIPS = 50;       // mniej = uznajemy, że API padło i nic nie zapisujemy
const MIN_SECONDS = 30;     // za krótkie urywki nie nadają się do zgadywania
const CONCURRENCY = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = async (f, d) => JSON.parse(await readFile(f, 'utf8').catch(() => JSON.stringify(d)));

async function getJson(url) {
  for (const wait of [0, 2000, 6000]) {
    if (wait) await sleep(wait);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
  }
  return null;
}

async function alive(url) {
  for (const wait of [0, 3000]) {
    if (wait) await sleep(wait);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-0' }, signal: AbortSignal.timeout(15000) });
      await r.body?.cancel();
      if (r.ok) return true;
      if ([403, 404, 410].includes(r.status)) return false;
    } catch {}
  }
  return false;
}

async function pool(items, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
  }));
  return out;
}

const slim = (c) => ({
  id: c.id,
  title: c.title ?? '',
  display_name: c.display_name ?? '',
  audio_url: c.video_url,
  video_url: c.video_url,
  image_url: c.image_url ?? null,
  major_model_version: c.major_model_version ?? null,
  duration: Number(c.metadata?.duration) || null,
});

const ids = await read('suno-playlists.json', []);
const previous = await read(OUT, { playlists: [] });
const seen = new Set();
const playlists = [];

for (const id of ids) {
  const clips = [];
  let name = '';
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await getJson(`${API}/${id}/?page=${page}`);
    const list = data?.playlist_clips ?? [];
    if (!list.length) break;
    name = data.name || name;
    for (const { clip } of list) {
      if (!clip?.id || seen.has(clip.id)) continue;
      if (clip.status !== 'complete' || clip.is_public === false || clip.is_trashed || clip.explicit) continue;
      if (!/^https:\/\/[^/]+\/.+\.mp4$/.test(clip.video_url ?? '')) continue;
      if ((Number(clip.metadata?.duration) || 0) < MIN_SECONDS) continue;
      seen.add(clip.id);
      clips.push(slim(clip));
    }
    await sleep(300);
  }
  console.log(`[${name || id}] kandydatów: ${clips.length}`);
  playlists.push({ id, name, playlist_clips: clips.map((clip) => ({ clip })) });
}

// stare wpisy, których nie ma już na playlistach - zostają, jeśli link żyje
const kept = [];
for (const p of previous.playlists ?? []) {
  for (const { clip } of p.playlist_clips ?? []) {
    if (!clip?.id || seen.has(clip.id)) continue;
    seen.add(clip.id);
    const url = clip.video_url ?? clip.audio_url;
    if (/\.mp4$/.test(url ?? '')) kept.push({ ...slim({ ...clip, video_url: url, metadata: { duration: clip.duration ?? clip.metadata?.duration } }) });
  }
}
if (kept.length) playlists.push({ id: 'kept', name: 'Wcześniej dodane', playlist_clips: kept.map((clip) => ({ clip })) });

// weryfikacja, że każdy link naprawdę odpowiada
let dropped = 0;
for (const p of playlists) {
  const ok = await pool(p.playlist_clips, ({ clip }) => alive(clip.audio_url));
  const before = p.playlist_clips.length;
  p.playlist_clips = p.playlist_clips.filter((_, n) => ok[n]);
  dropped += before - p.playlist_clips.length;
}

const result = playlists.filter((p) => p.playlist_clips.length);
const total = result.reduce((n, p) => n + p.playlist_clips.length, 0);
console.log(`Działających utworów: ${total}, odrzuconych (martwy link): ${dropped}`);
if (total < MIN_CLIPS) {
  console.error(`Za mało wyników (<${MIN_CLIPS}) - API Suno mogło się zmienić. ${OUT} zostaje bez zmian.`);
  process.exit(1);
}
await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), num_total_results: total, current_page: 1, playlists: result }, null, 1) + '\n');
