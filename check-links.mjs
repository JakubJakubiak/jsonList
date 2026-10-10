// check-links.mjs  (Node 20+, zero zależności)
// 1. Wyciąga wszystkie URL-e z *.json
// 2. Sprawdza każdy: ok / dead / unknown
// 3. Martwe linki PRZENOSI z list do old.json (nic nie jest kasowane na stałe)
// 4. Zapisuje historię (link-status.json) i raport (LINK_REPORT.md)

import { readdir, readFile, writeFile } from 'node:fs/promises';

const TIMEOUT_MS = 15_000;
const CONCURRENCY = 15;
const DEAD_AFTER = 1;          // ile wykryć "dead" = przenosimy (1 = od razu; i tak jest re-check)
const MAX_PRUNE_RATIO = 0.5;   // jeśli >50% linków pliku wygląda na martwe -> pewnie awaria sieci, nie ruszamy
const STATUS_FILE = 'link-status.json';
const OLD_FILE = 'old.json';
const SKIP = new Set([STATUS_FILE, OLD_FILE, 'sources.json', 'pending.json', 'rejected.json', 'package.json', 'package-lock.json']);
const SKIP_PATTERN = /^(archiwe|old)/i; // Archiwe_humnOrAi.json, OldhumnOrAi.json = archiwa, nie ruszamy
const UA = 'Mozilla/5.0 (compatible; jsonList-link-checker/1.0)';

const isUrl = (s) => typeof s === 'string' && /^https?:\/\//i.test(s.trim());

function collect(node, out) {
  if (typeof node === 'string') { if (isUrl(node)) out.add(node.trim()); }
  else if (Array.isArray(node)) node.forEach((n) => collect(n, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => collect(n, out));
}

const files = (await readdir('.')).filter((f) => f.endsWith('.json') && !SKIP.has(f) && !SKIP_PATTERN.test(f));
const parsed = new Map();   // plik -> dane JSON
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
console.log(`Plików: ${parsed.size}, unikalnych linków: ${urls.length}`);

// ---------- sprawdzanie ----------
async function request(url, method, extraHeaders = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { method, redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA, ...extraHeaders } });
  } finally { clearTimeout(t); }
}
function classify(res) {
  if (res.url.includes('removed.png')) return 'dead';
  if (res.ok) return 'ok';
  if ([404, 410].includes(res.status)) return 'dead';
  return 'unknown';
}
async function checkOnce(url) {
  try {
    if (/(?:youtube\.com|youtu\.be)\//.test(url)) {
      const r = await request(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, 'GET');
      return r.ok ? 'ok' : [400, 401, 404].includes(r.status) ? 'dead' : 'unknown';
    }
    let res = await request(url, 'HEAD');
    if ([403, 405, 501].includes(res.status)) res = await request(url, 'GET', { Range: 'bytes=0-0' });
    return classify(res);
  } catch (e) {
    return e?.cause?.code === 'ENOTFOUND' ? 'dead' : 'unknown';
  }
}
async function check(url) {
  const first = await checkOnce(url);
  if (first !== 'dead') return first;
  await new Promise((r) => setTimeout(r, 2000)); // re-check, żeby nie przenosić przez chwilową awarię
  return checkOnce(url);
}

const prev = JSON.parse(await readFile(STATUS_FILE, 'utf8').catch(() => '{}'));
const next = {};
const now = new Date().toISOString();
let i = 0;
async function worker() {
  while (i < urls.length) {
    const url = urls[i++];
    const result = await check(url);
    const old = prev[url] ?? { fails: 0, lastOk: null };
    next[url] = {
      status: result,
      fails: result === 'ok' ? 0 : result === 'dead' ? old.fails + 1 : old.fails,
      lastOk: result === 'ok' ? now : old.lastOk,
      lastChecked: now,
    };
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// ---------- przenoszenie martwych do old.json ----------
const dead = new Set(Object.entries(next).filter(([, v]) => v.status === 'dead' && v.fails >= DEAD_AFTER).map(([u]) => u));

// element listy ma martwy link: sam string albo obiekt z martwym URL-em w którymś polu (płytko)
const hasDead = (item) =>
  typeof item === 'string' ? dead.has(item.trim())
  : item && typeof item === 'object' && !Array.isArray(item) && Object.values(item).some((v) => typeof v === 'string' && dead.has(v.trim()));

function prune(node, removed) {
  if (Array.isArray(node)) {
    const out = [];
    for (const item of node) {
      if (hasDead(item)) removed.push(item); else out.push(prune(item, removed));
    }
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
const moved = [];
const skippedFiles = [];
for (const [f, data] of parsed) {
  const removed = [];
  const pruned = prune(data, removed);
  if (!removed.length) continue;
  const total = [...urlToFiles].filter(([, fs]) => fs.includes(f)).length;
  const deadHere = [...urlToFiles].filter(([u, fs]) => fs.includes(f) && dead.has(u)).length;
  if (total && deadHere / total > MAX_PRUNE_RATIO) { skippedFiles.push(f); continue; }
  await writeFile(f, JSON.stringify(pruned, null, 2) + '\n');
  for (const entry of removed) { oldList.push({ file: f, removedAt: now, entry }); moved.push({ file: f, entry }); }
}
if (moved.length) await writeFile(OLD_FILE, JSON.stringify(oldList, null, 2) + '\n');
await writeFile(STATUS_FILE, JSON.stringify(next, null, 2));

// ---------- raport ----------
const entries = Object.entries(next);
const okCount = entries.filter(([, v]) => v.status === 'ok').length;
const unknown = entries.filter(([, v]) => v.status === 'unknown');
const lines = [
  `# Raport linków (${now})`,
  '',
  `- OK: **${okCount}** / ${entries.length}`,
  `- Przeniesione do ${OLD_FILE}: **${moved.length}**`,
  `- Nieznane (blokada/timeout, sprawdź ręcznie): **${unknown.length}**`,
  ...(skippedFiles.length ? ['', `⚠️ Pominięto czyszczenie (ponad ${MAX_PRUNE_RATIO * 100}% martwych, możliwa awaria sieci): ${skippedFiles.join(', ')}`] : []),
  '',
  '## Przeniesione do old.json',
  ...moved.map((m) => `- ${typeof m.entry === 'string' ? m.entry : JSON.stringify(m.entry)}  _(${m.file})_`),
];
await writeFile('LINK_REPORT.md', lines.join('\n') + '\n');
console.log(lines.slice(0, 6).join('\n'));
