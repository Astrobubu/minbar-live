// Builds data/surahs.json from Tanzil quran-data.xml (https://tanzil.net/res/text/metadata/quran-data.xml, CC-BY).
// Usage: node scripts/build-surahs.mjs [path-to-quran-data.xml]   (downloads if no path is given)
import { readFile, writeFile } from 'node:fs/promises';
const url = 'https://tanzil.net/res/text/metadata/quran-data.xml';
const xml = process.argv[2] ? await readFile(process.argv[2], 'utf8') : await (await fetch(url)).text();
const surahs = [...xml.matchAll(/<sura index="(\d+)" ayas="(\d+)"[^>]*? name="([^"]+)" tname="([^"]+)" ename="([^"]+)" type="(\w+)"/g)]
  .map(m => ({ number: +m[1], ayahs: +m[2], ar: m[3], en: m[4], meaning: m[5], type: m[6] }));
if (surahs.length !== 114 || surahs.reduce((n, s) => n + s.ayahs, 0) !== 6236) throw new Error('Unexpected metadata; nothing written');
await writeFile(new URL('../data/surahs.json', import.meta.url), JSON.stringify({ source: 'Tanzil Quran metadata (quran-data.xml), (C) 2008-2009 Tanzil.info, license CC-BY; en = Tanzil transliteration (tname), meaning = Tanzil English name (ename)', url, surahs }, null, 1) + '\n');
console.log('wrote data/surahs.json', surahs.length);
