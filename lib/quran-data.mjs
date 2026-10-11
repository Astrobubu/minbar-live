// Quran reference data: Tanzil Quran text, established translations and surah names.
// Sources and licence terms are documented in README.md (data attribution); the data files keep their
// Tanzil copyright blocks verbatim.
import { readFileSync } from 'node:fs';

const read = name => { try { return readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'); } catch { return ''; } };

export function parseCorpus(text) {
  return text.split(/\r?\n/).filter(line => /^\d+\|\d+\|/.test(line)).map(line => {
    const [surah, ayah, ...parts] = line.split('|');
    return { surah: Number(surah), ayah: Number(ayah), reference: `${surah}:${ayah}`, arabic: parts.join('|') };
  });
}

export const corpus = parseCorpus(read('quran-simple.txt'));
export const quranAvailable = corpus.length === 6236;
const byReference = new Map(corpus.map(verse => [verse.reference, verse]));
export const verseAt = (surah, ayah) => byReference.get(`${surah}:${ayah}`);

// Language code (as used by rooms) -> Tanzil translation file and the label shown to listeners.
export const TRANSLATION_SOURCES = {
  en: { file: 'translations/en.sahih.txt', id: 'en.sahih', label: 'Saheeh International (Tanzil)' },
  ur: { file: 'translations/ur.jalandhry.txt', id: 'ur.jalandhry', label: 'Fateh Muhammad Jalandhry (Tanzil)' },
  id: { file: 'translations/id.indonesian.txt', id: 'id.indonesian', label: 'Indonesian Ministry of Religious Affairs (Tanzil)' },
  fr: { file: 'translations/fr.hamidullah.txt', id: 'fr.hamidullah', label: 'Muhammad Hamidullah (Tanzil)' },
  tr: { file: 'translations/tr.diyanet.txt', id: 'tr.diyanet', label: 'Diyanet Isleri (Tanzil)' }
};

const translations = {};
for (const [lang, source] of Object.entries(TRANSLATION_SOURCES)) {
  const rows = parseCorpus(read(source.file));
  if (rows.length === 6236) translations[lang] = new Map(rows.map(row => [row.reference, row.arabic.trim()]));
}
export const translationLanguages = Object.keys(translations);
export const translationText = (lang, surah, ayah) => translations[lang]?.get(`${surah}:${ayah}`) || '';

let surahTable = [];
try { surahTable = JSON.parse(read('surahs.json')).surahs || []; } catch { /* names are optional */ }
export const surahName = number => {
  const s = surahTable[number - 1];
  return s ? { ar: s.ar, en: s.en, meaning: s.meaning } : { ar: '', en: `Surah ${number}`, meaning: '' };
};
