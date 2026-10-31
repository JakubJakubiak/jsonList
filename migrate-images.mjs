// Przenosi obrazy z i.ibb.co do folderu media/ tego repozytorium (GitHub Pages):
// pobiera, zmniejsza do WebP i podmienia link w humnOrAi.json. Serwer ibb często
// wisi 30 s i zwraca 503, więc bot próbuje po trochu i kończy w kolejnych przebiegach.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const FILE = 'humnOrAi.json';
const DIR = 'media';
const BASE = 'https://jakubjakubiak.github.io/jsonList/media';
const OLD_HOST = 'https://i.ibb.co/';
const CONCURRENCY = 8;
const FETCH_TIMEOUT = 45_000;
const RUN_LIMIT = Number(process.env.RUN_MINUTES ?? 40) * 60_000;
const MAX_SIZE = 1280;
const started = Date.now();

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const list = data.humanOrAi;
const key = (e) => (e.link ? 'link' : 'url');
const queue = list.filter((e) => e[key(e)]?.startsWith(OLD_HOST)).sort(() => Math.random() - 0.5);
console.log(`Do przeniesienia: ${queue.length}`);
mkdirSync(DIR, { recursive: true });

let moved = 0;
let failed = 0;
let bytesIn = 0;
let bytesOut = 0;

async function migrate(entry) {
  const url = entry[key(entry)];
  const name = `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.webp`;
  const path = `${DIR}/${name}`;
  if (!existsSync(path)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const input = Buffer.from(await res.arrayBuffer());
    const output = await sharp(input)
      .rotate()
      .resize({ width: MAX_SIZE, height: MAX_SIZE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    writeFileSync(path, output);
    bytesIn += input.length;
    bytesOut += output.length;
  }
  entry[key(entry)] = `${BASE}/${name}`;
  moved++;
}

async function worker() {
  while (queue.length && Date.now() - started < RUN_LIMIT) {
    const entry = queue.pop();
    try {
      await migrate(entry);
    } catch {
      failed++;
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
if (moved) writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`);
const mb = (n) => (n / 1e6).toFixed(1);
console.log(`Przeniesiono ${moved}, nieudanych prób ${failed}, zostało ${queue.length + failed}. ${mb(bytesIn)} MB -> ${mb(bytesOut)} MB`);
