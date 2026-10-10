// approve.mjs - przenosi zatwierdzone wpisy z pending.json do list docelowych.
// W pending.json ustaw "approved": true (zostaje) albo "rejected": true (odpada na stałe).
import { readFile, writeFile } from 'node:fs/promises';
const read = async (f, d) => JSON.parse(await readFile(f, 'utf8').catch(() => JSON.stringify(d)));

const pending = await read('pending.json', []);
const rejected = await read('rejected.json', []);
const keep = [];
const byTarget = {};
let ok = 0, no = 0;

for (const p of pending) {
  if (p.approved) {
    const { approved, rejected: _r, target, ...entry } = p;
    (byTarget[target ?? 'approved.json'] ??= []).push(entry);
    ok++;
  } else if (p.rejected) {
    rejected.push({ id: p.id, url: p.url }); // pamiętamy, żeby bot nie dodał tego ponownie
    no++;
  } else keep.push(p);
}
for (const [file, entries] of Object.entries(byTarget)) {
  const list = await read(file, []);
  if (!Array.isArray(list)) { console.error(`${file} nie jest tablicą - pomijam`); keep.push(...entries.map((e) => ({ ...e, target: file, approved: true }))); continue; }
  await writeFile(file, JSON.stringify([...list, ...entries], null, 2));
}
await writeFile('pending.json', JSON.stringify(keep, null, 2));
await writeFile('rejected.json', JSON.stringify(rejected, null, 2));
console.log(`Zatwierdzone: ${ok}, odrzucone: ${no}, czeka: ${keep.length}`);
