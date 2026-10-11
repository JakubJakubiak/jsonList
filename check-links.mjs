// check-links.mjs  v2  (Node 20+, zero zależności)
// 1. Wyciąga wszystkie URL-e z *.json
// 2. Sprawdza każdy: ok / dead / unknown (z powodem)
// 3. Martwe PRZENOSI z list do old.json (nic nie jest kasowane na stałe)
// 4. Zapisuje historię (link-status.json) i raport (LINK_REPORT.md + podsumowanie w Actions)

import { readdir, readFile, writeFile, appendFile } from 'node:fs/promises';

// ---------- ustawienia ----------
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 30;          // ile linków naraz ogółem
const PER_HOST = 4;              // ile naraz do JEDNEJ domeny (mniej blokad 429)
const RETRY_WAITS = [2000, 5000]; // ponowne próby dla "unknown" (429, 5xx, timeout)
const FORBIDDEN_AFTER = 3;      // HTTP 403 tyle przebiegów z rzędu = plik zdjęty z CDN, traktujemy jak martwy
const DEAD_AFTER = 1;            // ile wykryć "dead" = przenosimy (przed tym i tak jest re-check)
const MAX_PRUNE_RATIO = 0.5;     // >50% martwych w pliku = pewnie awaria sieci, nie ruszamy
const BREAKER_SOFT = 10;         // tyle "unknown" z rzędu z hosta = bez ponownych prób
const BREAKER_HARD = 30;         // tyle z rzędu = pomijamy resztę linków tego hosta
const STATUS_FILE = 'link-status.json';
const OLD_FILE = 'old.json';
const SKIP = new Set([STATUS_FILE, OLD_FILE, 'suno-playlists.json', 'sources.json', 'pending.json', 'rejected.json', 'package.json', 'package-lock.json']);
const SKIP_PATTERN = /^(archiwe|old)/i; // archiwa nie są czyszczone
const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|svg|mp3|wav|ogg|m4a|flac|mp4|webm|mov)$/i;
const YT = /(?:youtube\.com|youtu\.be)\//;
const UA = 'Mozilla/5.0 (compatible; jsonList-link-checker/2.0)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isUrl = (s) => typeof s === 'string' && /^https?:\/\//i.test(s.trim());
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return 'invalid'; } };

function collect(node, out) {
  if (typeof node === 'string') { if (isUrl(node)) out.add(node.trim()); }
  else if (Array.isArray(node)) node.forEach((n) => collect(n, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => collect(n, out));
}

// ---------- wczytanie plików ----------
const files = (await readdir('.')).filter((f) => f.endsWith('.json') && !SKIP.has(f) && !SKIP_PATTERN.test(f));
const parsed = new Map();
const urlToFiles = new Map();
for (const f of files) {
  let data;
  try { data = JSON.parse(await readFile(f, 'utf8')); } catch { console.warn('Pomijam (zły JSON):', f); continue; }
  parsed.set(f, data);
  const set = new Set();
  collect(data, set);
  for (const u of set) urlToFiles.set(u, [...(urlToFiles.get(u) ?? []), f]);
}
const urls = [...urlToFiles.keys()];
// tasowanie: linki z jednej domeny nie stoją obok siebie, więc limit na host nie blokuje całej puli
for (let i = urls.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [urls[i], urls[j]] = [urls[j], urls[i]]; }
console.log(`Plików: ${parsed.size}, unikalnych linków: ${urls.length}`);

// ---------- limit równoległości na host + bezpiecznik ----------
const hosts = new Map();
const hostState = (h) => { let s = hosts.get(h); if (!s) { s = { active: 0, waiters: [], unknownRun: 0 }; hosts.set(h, s); } return s; };
async function withHost(host, fn) {
  const s = hostState(host);
  if (s.active >= PER_HOST) await new Promise((r) => s.waiters.push(r)); else s.active++;
  try { return await fn(s); }
  finally { const w = s.waiters.shift(); if (w) w(); else s.active--; }
}

// ---------- sprawdzanie jednego linku ----------
async function request(url, method, extra = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await fetch(url, { method, redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA, ...extra } }); }
  finally { clearTimeout(t); }
}
const retryAfter = (res) => { const v = Number(res.headers.get('retry-after')); return Number.isFinite(v) && v > 0 ? v * 1000 : undefined; };

function classify(res, url) {
  if (res.url.includes('removed.png')) return { status: 'dead', reason: 'usunięte (removed.png)' };
  if (res.ok) {
    const ct = res.headers.get('content-type') || '';
    let path = ''; try { path = new URL(url).pathname; } catch {}
    if (MEDIA_EXT.test(path) && ct.startsWith('text/html')) return { status: 'dead', reason: 'HTML zamiast pliku (soft 404)' };
    return { status: 'ok' };
  }
  if ([404, 410].includes(res.status)) return { status: 'dead', reason: `HTTP ${res.status}` };
  return { status: 'unknown', reason: `HTTP ${res.status}`, retryAfter: retryAfter(res) };
}

async function attempt(url) {
  try {
    if (YT.test(url)) {
      const r = await request(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, 'GET');
      if (r.ok) return { status: 'ok' };
      if (r.status === 404) return { status: 'dead', reason: 'YouTube: nie znaleziono' };
      // 401 = prywatny albo bez osadzania - film może istnieć, więc nie ruszamy
      return { status: 'unknown', reason: `YouTube HTTP ${r.status}`, retryAfter: retryAfter(r) };
    }
    let res = await request(url, 'HEAD');
    if ([403, 405, 501].includes(res.status)) res = await request(url, 'GET', { Range: 'bytes=0-0' });
    return classify(res, url);
  } catch (e) {
    const code = e?.cause?.code ?? e?.name;
    if (code === 'ENOTFOUND') return { status: 'dead', reason: 'domena nie istnieje (DNS)' };
    return { status: 'unknown', reason: ['AbortError', 'TimeoutError'].includes(code) ? 'timeout' : String(code) };
  }
}

async function check(url) {
  const host = YT.test(url) ? 'youtube-oembed' : hostOf(url);
  return withHost(host, async (s) => {
    if (s.unknownRun >= BREAKER_HARD) return { status: 'unknown', reason: 'pominięto: host nie odpowiada (bezpiecznik)' };
    let r = await attempt(url);
    if (r.status === 'dead') { await sleep(2000); r = await attempt(url); } // re-check przed przeniesieniem
    if (r.status === 'unknown' && s.unknownRun < BREAKER_SOFT) {
      for (const wait of RETRY_WAITS) {
        await sleep(Math.min(r.retryAfter ?? wait, 10_000));
        r = await attempt(url);
        if (r.status !== 'unknown') break;
      }
    }
    s.unknownRun = r.status === 'unknown' ? s.unknownRun + 1 : 0;
    return r;
  });
}

// ---------- pula robocza ----------
const prev = JSON.parse(await readFile(STATUS_FILE, 'utf8').catch(() => '{}'));
const next = {};
const now = new Date().toISOString();
const started = Date.now();
let i = 0, done = 0;
async function worker() {
  while (i < urls.length) {
    const url = urls[i++];
    const r = await check(url);
    const old = prev[url] ?? {};
    // CDN-y (S3/CloudFront) oddają 403 zamiast 404 dla usuniętych plików - po kilku przebiegach uznajemy za martwe
    if (r.status === 'unknown' && r.reason === 'HTTP 403' && old.reason === 'HTTP 403' && (old.unknownStreak ?? 0) + 1 >= FORBIDDEN_AFTER) {
      r.status = 'dead'; r.reason = `HTTP 403 od ${FORBIDDEN_AFTER} przebiegów`;
    }
    next[url] = {
      status: r.status,
      reason: r.reason ?? null,
      fails: r.status === 'dead' ? (old.fails ?? 0) + 1 : r.status === 'ok' ? 0 : old.fails ?? 0,
      unknownStreak: r.status === 'unknown' ? (old.unknownStreak ?? 0) + 1 : 0,
      lastOk: r.status === 'ok' ? now : old.lastOk ?? null,
      lastChecked: now,
    };
    if (++done % 1000 === 0) console.log(`Sprawdzono ${done}/${urls.length}...`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// ---------- przenoszenie martwych do old.json ----------
const dead = new Set(Object.entries(next).filter(([, v]) => v.status === 'dead' && v.fails >= DEAD_AFTER).map(([u]) => u));
const hasDead = (item) =>
  typeof item === 'string' ? dead.has(item.trim())
  : item && typeof item === 'object' && !Array.isArray(item) && Object.values(item).some((v) => typeof v === 'string' && dead.has(v.trim()));

function prune(node, removed) {
  if (Array.isArray(node)) {
    const out = [];
    for (const item of node) { if (hasDead(item)) removed.push(item); else out.push(prune(item, removed)); }
    return out;
  }
  if (node && typeof node === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && dead.has(v.trim())) removed.push({ [k]: v }); else o[k] = prune(v, removed);
    }
    return o;
  }
  return node;
}

const oldList = JSON.parse(await readFile(OLD_FILE, 'utf8').catch(() => '[]'));
const moved = [], skippedFiles = [];
for (const [f, data] of parsed) {
  const removed = [];
  const pruned = prune(data, removed);
  if (!removed.length) continue;
  const here = [...urlToFiles].filter(([, fs]) => fs.includes(f)).map(([u]) => u);
  if (here.length && here.filter((u) => dead.has(u)).length / here.length > MAX_PRUNE_RATIO) { skippedFiles.push(f); continue; }
  await writeFile(f, JSON.stringify(pruned, null, 2) + '\n');
  for (const entry of removed) {
    const url = typeof entry === 'string' ? entry : Object.values(entry).find((v) => typeof v === 'string' && dead.has(v.trim()));
    oldList.push({ file: f, removedAt: now, reason: next[url?.trim()]?.reason ?? null, entry });
    moved.push({ file: f, entry, reason: next[url?.trim()]?.reason });
  }
}
if (moved.length) await writeFile(OLD_FILE, JSON.stringify(oldList, null, 2) + '\n');
await writeFile(STATUS_FILE, JSON.stringify(next, null, 2));

// ---------- raport ----------
const all = Object.entries(next);
const okCount = all.filter(([, v]) => v.status === 'ok').length;
const unknown = all.filter(([, v]) => v.status === 'unknown');
const persistent = unknown.filter(([, v]) => (v.unknownStreak ?? 0) >= 3);

const byDomain = new Map();
for (const [u, v] of unknown) {
  const d = hostOf(u);
  const e = byDomain.get(d) ?? { n: 0, reasons: new Map() };
  e.n++; e.reasons.set(v.reason, (e.reasons.get(v.reason) ?? 0) + 1);
  byDomain.set(d, e);
}
const domainRows = [...byDomain].sort((a, b) => b[1].n - a[1].n).slice(0, 25).map(([d, e]) =>
  `| ${d} | ${e.n} | ${[...e.reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} ×${n}`).join(', ')} |`);

const mins = ((Date.now() - started) / 60000).toFixed(1);
const head = [
  `# Raport linków (${now})`,
  '',
  `- OK: **${okCount}** / ${all.length}  _(czas: ${mins} min)_`,
  `- Przeniesione do ${OLD_FILE}: **${moved.length}**`,
  `- Nieznane (blokada/timeout): **${unknown.length}**, z czego od ≥3 przebiegów z rzędu: **${persistent.length}**`,
  ...(skippedFiles.length ? ['', `⚠️ Pominięto czyszczenie (>${MAX_PRUNE_RATIO * 100}% martwych, możliwa awaria sieci): ${skippedFiles.join(', ')}`] : []),
  ...(domainRows.length ? ['', '## Nieznane według domen', '', '| Domena | Ile | Powody |', '|---|---|---|', ...domainRows] : []),
];
const body = [
  '',
  '## Przeniesione do old.json',
  ...moved.map((m) => `- ${typeof m.entry === 'string' ? m.entry : JSON.stringify(m.entry)} — ${m.reason ?? '?'} _(${m.file})_`),
  '',
  '## Nieznane od ≥3 przebiegów (sprawdź ręcznie)',
  ...persistent.slice(0, 300).map(([u, v]) => `- ${u} — ${v.reason}`),
  ...(persistent.length > 300 ? [`…i ${persistent.length - 300} więcej w ${STATUS_FILE}`] : []),
];
await writeFile('LINK_REPORT.md', [...head, ...body].join('\n') + '\n');
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, head.join('\n') + '\n');
console.log(head.join('\n'));
