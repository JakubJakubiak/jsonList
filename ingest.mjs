// ingest.mjs (Node 20+, zero zależności)
// Pobiera nowe linki ze źródeł z sources.json -> weryfikuje -> dopisuje do pending.json
// Nic nie trafia do właściwych list, dopóki tego nie zatwierdzisz (approve.mjs).
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const UA = 'Mozilla/5.0 (compatible; jsonList-ingest/1.0)';
const read = async (f, d) => JSON.parse(await readFile(f, 'utf8').catch(() => JSON.stringify(d)));
const sources = await read('sources.json', []);
const pending = await read('pending.json', []);

const norm = (u) => { try { const x = new URL(u.trim()); x.hash = ''; return x.href.replace(/\/$/, ''); } catch { return null; } };
const idOf = (u) => createHash('sha1').update(u).digest('hex').slice(0, 12);

function collect(node, out) {
  if (typeof node === 'string') { const n = /^https?:\/\//i.test(node) ? norm(node) : null; if (n) out.add(n); }
  else if (Array.isArray(node)) node.forEach((n) => collect(n, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => collect(n, out));
}

// wszystko, co już znamy: listy, pending, rejected -> nie dodajemy drugi raz
const known = new Set();
const skip = new Set(['sources.json', 'link-status.json']);
for (const f of (await readdir('.')).filter((f) => f.endsWith('.json') && !skip.has(f))) {
  try { collect(JSON.parse(await readFile(f, 'utf8')), known); } catch {}
}

function fromRss(xml) {
  const urls = new Set();
  for (const m of xml.matchAll(/<(?:enclosure|media:content|media:thumbnail)[^>]*\burl="([^"]+)"/g)) urls.add(m[1]);
  if (!urls.size) for (const m of xml.matchAll(/<link>([^<]+)<\/link>/g)) urls.add(m[1]);
  return [...urls].map((u) => u.replace(/&amp;/g, '&'));
}
function fromJson(data, path) { // np. "data.children[].data.url"
  let cur = [data];
  for (const part of path.split('.')) {
    const isArr = part.endsWith('[]'), key = part.replace('[]', '');
    cur = cur.flatMap((n) => { const v = key ? n?.[key] : n; return isArr ? (Array.isArray(v) ? v : []) : [v]; });
  }
  return cur.filter((x) => typeof x === 'string');
}

async function verify(url, mediaType, checkType) {
  const opt = (extra = {}) => ({ redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, ...extra } });
  try {
    let r = await fetch(url, { method: 'HEAD', ...opt() });
    if ([403, 405, 501].includes(r.status)) r = await fetch(url, opt({ Range: 'bytes=0-0' }));
    if (!r.ok || r.url.includes('removed.png')) return 'dead';
    if (checkType && !(r.headers.get('content-type') || '').startsWith(mediaType + '/')) return 'wrong-type';
    return 'ok';
  } catch { return 'unreachable'; }
}

const today = new Date().toISOString().slice(0, 10);
let added = 0;
for (const s of sources) {
  try {
    const res = await fetch(s.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) { console.warn(`[${s.name}] HTTP ${res.status}`); continue; }
    const raw = s.format === 'rss' ? fromRss(await res.text()) : fromJson(await res.json(), s.path ?? '');
    let taken = 0;
    for (const u of raw) {
      if (taken >= (s.limit ?? 20)) break;
      const url = norm(u);
      if (!url || known.has(url)) continue;
      const status = await verify(url, s.type, s.checkType !== false);
      if (status !== 'ok') continue;
      known.add(url);
      pending.push({ id: idOf(url), type: s.type, label: s.label, url, source: s.name, target: s.target, addedAt: today, approved: false, rejected: false });
      taken++; added++;
    }
    console.log(`[${s.name}] nowych: ${taken}`);
  } catch (e) { console.warn(`[${s.name}] błąd: ${e.message}`); }
}
await writeFile('pending.json', JSON.stringify(pending, null, 2));
console.log(`Razem dodano do pending.json: ${added}`);
