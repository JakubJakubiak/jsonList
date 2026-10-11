// approve.mjs - przenosi zatwierdzone wpisy z pending.json do list, które czyta gra.
// Dwa sposoby zatwierdzania:
//   1) workflow "Approve pending": pole approve = "all" albo ID oddzielone spacjami/przecinkami,
//      pole reject = ID albo "rest" (odrzuć wszystko, czego nie zatwierdzono)
//   2) ręcznie w pending.json: "approved": true (dodaj) albo "rejected": true (odpada na stałe)
import { readFile, writeFile } from 'node:fs/promises';
const read = async (f, d) => JSON.parse(await readFile(f, 'utf8').catch(() => JSON.stringify(d)));
const ids = (v) => new Set(String(v ?? '').split(/[\s,]+/).filter(Boolean));

const pending = await read('pending.json', []);
const rejected = await read('rejected.json', []);
const approve = ids(process.env.APPROVE), reject = ids(process.env.REJECT);
for (const p of pending) {
  if (approve.has('all') || approve.has(p.id)) p.approved = true;
  else if (reject.has('rest') || reject.has(p.id)) p.rejected = true;
}

const keep = [];
const byTarget = {};
let ok = 0, no = 0;
for (const p of pending) {
  if (p.approved && !p.rejected) { (byTarget[p.target ?? 'approved.json'] ??= []).push(p); ok++; }
  else if (p.rejected) { rejected.push({ id: p.id, url: p.url }); no++; } // pamiętamy, żeby bot nie proponował ponownie
  else keep.push(p);
}

// Wpis w formacie, który czyta gra.
const today = new Date().toISOString().slice(0, 10);
const meta = (e) => ({ ...(e.credit ? { credit: e.credit } : {}), new: e.addedAt ?? today });
const asImage = (e) => ({ link: e.url, op: e.label, ...meta(e) });
const asVideo = (e) => ({ url: e.url, op: e.label, ...meta(e) });
const asMusic = (e) => ({ url: e.url, track: e.title ?? '', artistraw: e.artist ?? '', cover: e.cover ?? null, ...meta(e) });

for (const [file, entries] of Object.entries(byTarget)) {
  const data = await read(file, []);
  if (Array.isArray(data?.humanOrAi)) {
    data.humanOrAi.push(...entries.map(asImage));
    await writeFile(file, JSON.stringify(data, null, 4) + '\n');
  } else if (Array.isArray(data)) {
    const convert = /^video_links_/.test(file) ? asVideo : /music/i.test(file) ? asMusic : (e) => { const { approved, rejected: _r, target, ...rest } = e; return rest; };
    await writeFile(file, JSON.stringify([...data, ...entries.map(convert)], null, 4) + '\n');
  } else {
    console.error(`${file} ma nieznany format - wpisy zostają w pending.json`);
    keep.push(...entries); ok -= entries.length;
  }
}
await writeFile('pending.json', JSON.stringify(keep, null, 2) + '\n');
await writeFile('rejected.json', JSON.stringify(rejected, null, 2) + '\n');
console.log(`Zatwierdzone: ${ok}, odrzucone: ${no}, czeka: ${keep.length}`);
