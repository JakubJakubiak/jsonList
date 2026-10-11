// ingest.mjs (Node 20+, zero zależności)
// Szuka NOWYCH treści w źródłach z sources.json -> sprawdza, czy link działa -> dopisuje do pending.json
// i generuje PENDING.md (podgląd z miniaturami do przejrzenia na GitHubie).
// Nic nie trafia do gry, dopóki tego nie zatwierdzisz (workflow "Approve pending" / approve.mjs).
//
// Formaty źródeł (pole "format"):
//   commons      - Wikimedia Commons (zdjęcia/obrazy ludzi, stabilny hosting, wymaga podania autora)
//   civitai      - obrazy AI (tylko poziom bez treści dla dorosłych)
//   incompetech  - muzyka Kevina MacLeoda (człowiek, CC BY)
//   file         - lokalny plik JSON z repo (np. duża lista ncsmusic.json) - proponuje losowe wpisy, których gra jeszcze nie ma
//   nasa-video   - krótkie filmy NASA (człowiek, domena publiczna)
//   pexels-video - filmy z Pexels (człowiek; wymaga darmowego klucza w sekrecie PEXELS_API_KEY)
//   pexels-photo - zdjęcia z Pexels (jw.)
//   rss / json   - dowolny kanał RSS albo JSON ze ścieżką "path", np. "items[].image_url"
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const UA = 'AiOrPeopleContentBot/1.0 (+https://github.com/JakubJakubiak/jsonList)';
const read = async (f, d) => JSON.parse(await readFile(f, 'utf8').catch(() => JSON.stringify(d)));
const sources = await read('sources.json', []);
const pending = await read('pending.json', []);

const norm = (u) => { try { const x = new URL(String(u).trim()); x.hash = ''; return x.href.replace(/\/$/, ''); } catch { return null; } };
const idOf = (u) => createHash('sha1').update(u).digest('hex').slice(0, 12);
const strip = (html) => String(html ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function collect(node, out) {
  if (typeof node === 'string') { const n = /^https?:\/\//i.test(node) ? norm(node) : null; if (n) out.add(n); }
  else if (Array.isArray(node)) node.forEach((n) => collect(n, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => collect(n, out));
}

// wszystko, co już znamy: listy, pending, rejected, old -> nie proponujemy drugi raz
const known = new Set();
const skip = new Set(['sources.json', 'link-status.json', 'suno-playlists.json']);
for (const f of (await readdir('.')).filter((f) => f.endsWith('.json') && !skip.has(f))) {
  try { collect(JSON.parse(await readFile(f, 'utf8')), known); } catch {}
}

async function getJson(url, headers = {}) {
  let last;
  for (const wait of [0, 4000, 10000]) { // wolne/kapryśne serwery dostają trzy próby
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(40000) });
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) { last = new Error(e.cause?.code ?? e.message); }
  }
  throw last;
}

// ---------- parsery źródeł: każdy zwraca listę { url, credit?, title?, artist?, cover? } ----------
function fromRss(xml) {
  const urls = new Set();
  for (const m of xml.matchAll(/<(?:enclosure|media:content|media:thumbnail)[^>]*\burl="([^"]+)"/g)) urls.add(m[1]);
  if (!urls.size) for (const m of xml.matchAll(/<link>([^<]+)<\/link>/g)) urls.add(m[1]);
  return [...urls].map((u) => ({ url: u.replace(/&amp;/g, '&') }));
}
function fromJson(data, path) { // np. "data.children[].data.url"
  let cur = [data];
  for (const part of path.split('.')) {
    const isArr = part.endsWith('[]'), key = part.replace('[]', '');
    cur = cur.flatMap((n) => { const v = key ? n?.[key] : n; return isArr ? (Array.isArray(v) ? v : []) : [v]; });
  }
  return cur.filter((x) => typeof x === 'string').map((url) => ({ url }));
}

const AI_HINT = /\b(AI|artificial intelligence|AI-generated|Midjourney|DALL|Stable Diffusion|generative)\b/i;
function fromCommons(data) {
  return (data?.query?.pages ?? []).flatMap((p) => {
    const i = p.imageinfo?.[0], m = i?.extmetadata ?? {};
    if (!i?.thumburl || !/^image\/(jpeg|png)$/.test(i.mime ?? '')) return [];
    if (AI_HINT.test(`${m.Categories?.value} ${p.title}`)) return []; // tu mają być wyłącznie prace ludzi
    const author = strip(m.Artist?.value).slice(0, 60) || 'Wikimedia Commons';
    return [{ url: i.thumburl.split('?')[0], credit: `${author} · ${strip(m.LicenseShortName?.value) || 'CC'} · Wikimedia Commons` }];
  });
}
function fromCivitai(data) {
  return (data?.items ?? [])
    .filter((x) => x.type === 'image' && x.nsfw === false && x.nsfwLevel === 'None' && x.width >= 768)
    .map((x) => ({ url: x.url.replace('/original=true/', '/width=1024/'), credit: x.baseModel ? `AI · ${x.baseModel}` : undefined }));
}
function fromIncompetech(data) {
  return shuffle((Array.isArray(data) ? data : []).filter((x) => x.filename?.endsWith('.mp3'))).map((x) => ({
    url: `https://incompetech.com/music/royalty-free/mp3-royaltyfree/${encodeURIComponent(x.filename)}`,
    title: x.title, artist: 'Kevin MacLeod', credit: 'Kevin MacLeod (incompetech.com) · CC BY 4.0',
  }));
}
async function fromNasaVideo(data) {
  const out = [];
  for (const it of shuffle(data?.collection?.items ?? []).slice(0, 25)) {
    try {
      const files = await getJson(encodeURI(it.href));
      const mp4 = files.find((f) => f.endsWith('~mobile.mp4')) ?? files.find((f) => f.endsWith('~small.mp4'));
      if (mp4) out.push({ url: encodeURI(mp4).replace(/^http:/, 'https:'), title: it.data?.[0]?.title, credit: 'NASA · domena publiczna' });
    } catch {}
  }
  return out;
}
function fromPexelsVideo(data) {
  return (data?.videos ?? []).flatMap((v) => {
    const f = (v.video_files ?? []).filter((x) => x.file_type === 'video/mp4' && x.height && x.height <= 1080).sort((a, b) => Math.abs(a.height - 720) - Math.abs(b.height - 720))[0];
    return f ? [{ url: f.link, cover: v.image, credit: `${v.user?.name ?? 'Pexels'} · Pexels` }] : [];
  });
}
function fromPexelsPhoto(data) {
  return (data?.photos ?? []).map((p) => ({ url: p.src?.large2x ?? p.src?.large, credit: `${p.photographer ?? 'Pexels'} · Pexels` })).filter((x) => x.url);
}

async function candidates(s) {
  if (s.format === 'file') {
    const list = await read(s.file, []);
    return shuffle(list.filter((x) => x?.url)).map((x) => ({ url: x.url, title: x.track, artist: x.artistraw, cover: x.cover, credit: s.credit }));
  }
  const headers = {};
  if (s.auth) {
    const key = process.env[s.auth];
    if (!key) { console.log(`[${s.name}] pominięte - brak sekretu ${s.auth}`); return null; }
    headers.Authorization = key;
  }
  if (s.format === 'rss') {
    const res = await fetch(s.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return fromRss(await res.text());
  }
  const data = await getJson(s.url, headers);
  switch (s.format) {
    case 'commons': return fromCommons(data);
    case 'civitai': return fromCivitai(data);
    case 'incompetech': return fromIncompetech(data);
    case 'nasa-video': return fromNasaVideo(data);
    case 'pexels-video': return fromPexelsVideo(data);
    case 'pexels-photo': return fromPexelsPhoto(data);
    default: return fromJson(data, s.path ?? '');
  }
}

const EXT = { image: /\.(jpe?g|png|webp|gif|avif)$/i, video: /\.(mp4|mov|m4v)$/i, audio: /\.(mp3|m4a|ogg|wav)$/i };
async function verify(url, s) {
  const opt = (extra = {}) => ({ redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': UA, ...extra } });
  try {
    let r = await fetch(url, { method: 'HEAD', ...opt() });
    if ([403, 405, 501].includes(r.status)) { r = await fetch(url, opt({ Range: 'bytes=0-0' })); await r.body?.cancel(); }
    if (!r.ok || r.url.includes('removed.png')) return 'dead';
    const ct = r.headers.get('content-type') || '';
    const path = new URL(url).pathname;
    const typeOk = ct.startsWith(s.type + '/') || (/octet-stream/.test(ct) && EXT[s.type]?.test(path));
    if (s.checkType !== false && !typeOk) return 'wrong-type';
    const size = Number(r.headers.get('content-range')?.split('/')[1] ?? r.headers.get('content-length')) || 0;
    const maxMB = s.maxMB ?? (s.type === 'video' ? 30 : s.type === 'audio' ? 15 : 8);
    if (size > maxMB * 1024 * 1024) return 'too-big';
    return 'ok';
  } catch { return 'unreachable'; }
}

// dla źródeł "file" kandydat jest już w repo (więc w `known`) - liczy się tylko to, czy jest w grze/pending/rejected
async function alreadyUsed(s) {
  const used = new Set();
  for (const f of [s.target, 'pending.json', 'rejected.json', 'old.json']) collect(await read(f, []), used);
  return used;
}

const today = new Date().toISOString().slice(0, 10);
let added = 0;
for (const s of sources) {
  if (s.enabled === false || process.env.PREVIEW_ONLY) continue; // PREVIEW_ONLY=1: tylko odśwież PENDING.md
  try {
    const seen = s.format === 'file' ? await alreadyUsed(s) : known;
    const raw = await candidates(s);
    if (!raw) continue;
    let taken = 0;
    for (const item of raw) {
      if (taken >= (s.limit ?? 20)) break;
      const url = norm(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url); known.add(url);
      if ((await verify(url, s)) !== 'ok') continue;
      const extra = Object.fromEntries(['title', 'artist', 'cover', 'credit'].filter((k) => item[k]).map((k) => [k, item[k]]));
      pending.push({ id: idOf(url), type: s.type, label: s.label, url, ...extra, source: s.name, target: s.target, addedAt: today, approved: false, rejected: false });
      taken++; added++;
    }
    console.log(`[${s.name}] nowych: ${taken}`);
  } catch (e) { console.warn(`[${s.name}] błąd: ${e.message}`); }
}
await writeFile('pending.json', JSON.stringify(pending, null, 2) + '\n');
console.log(`Razem dodano do pending.json: ${added}, czeka na decyzję: ${pending.length}`);

// ---------- PENDING.md: podgląd propozycji ----------
const bySource = new Map();
for (const p of pending) bySource.set(p.source, [...(bySource.get(p.source) ?? []), p]);
const md = [
  `# Propozycje do dodania (${pending.length})`,
  '',
  'Zatwierdzanie: **Actions → Approve pending → Run workflow**.',
  'W polu `approve` wpisz `all` albo ID oddzielone spacjami; w polu `reject` ID do odrzucenia albo `rest` (wszystko, czego nie zatwierdzasz).',
  '',
];
for (const [name, list] of bySource) {
  const label = list[0].label === 'ai' ? 'AI' : 'człowiek';
  md.push(`## ${name} — ${list[0].type}, ${label} (${list.length})`, '');
  if (list[0].type === 'image') {
    md.push('<table>');
    for (let i = 0; i < list.length; i += 4) {
      md.push('<tr>' + list.slice(i, i + 4).map((p) => `<td align="center"><a href="${p.url}"><img src="${p.url}" width="180"></a><br><code>${p.id}</code></td>`).join('') + '</tr>');
    }
    md.push('</table>', '');
  } else {
    for (const p of list) md.push(`- \`${p.id}\` — [${[p.title, p.artist].filter(Boolean).join(' — ') || 'otwórz'}](${p.url})${p.credit ? ` _(${p.credit})_` : ''}`);
    md.push('');
  }
}
await writeFile('PENDING.md', md.join('\n'));
