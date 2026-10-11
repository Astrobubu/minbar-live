// Quran detection + retrieval facade used by the server.
// matchQuran(text, { targets, tailText }) -> citation objects (see README, "Citation contract").
import { normalizeArabic } from './arabic.mjs';
import { createDetector } from './quran-detect.mjs';
import { corpus, parseCorpus, quranAvailable, verseAt, surahName, translationText, TRANSLATION_SOURCES, translationLanguages } from './quran-data.mjs';

export { normalizeArabic, parseCorpus, quranAvailable, createDetector };

const detector = quranAvailable ? createDetector(corpus) : null;

/** Build the public citation object from a detector core result. */
export function buildCitation(core, targets = []) {
  const verses = [];
  for (let ayah = core.ayahStart; ayah <= core.ayahEnd; ayah++) {
    const verse = verseAt(core.surah, ayah);
    if (verse) verses.push({ ayah, arabic: verse.arabic });
  }
  const reference = core.ayahStart === core.ayahEnd ? `${core.surah}:${core.ayahStart}` : `${core.surah}:${core.ayahStart}-${core.ayahEnd}`;
  const translations = {}, translationSources = {};
  for (const lang of targets) {
    if (!translationLanguages.includes(lang)) continue;
    const parts = verses.map(v => translationText(lang, core.surah, v.ayah)).filter(Boolean);
    if (!parts.length) continue;
    translations[lang] = parts.join(' ');
    translationSources[lang] = TRANSLATION_SOURCES[lang].label;
  }
  return {
    kind: 'quran', reference, surah: core.surah, ayahStart: core.ayahStart, ayahEnd: core.ayahEnd,
    surahName: surahName(core.surah),
    arabic: verses.map(v => v.arabic).join(' '),
    verses,
    translations, translationSources,
    matchType: core.matchType, confidence: core.confidence, matchedText: core.matchedText,
    sourceUrl: `https://tanzil.net/#${core.surah}:${core.ayahStart}`,
    ...(core.spansPreviousSegment ? { spansPreviousSegment: true } : {}),
    evidence: core.evidence
  };
}

/**
 * Detect Quran verses in Arabic text.
 * options.targets  - room target languages; established translations are attached for those that have one.
 * options.tailText - the end of the previous segment, so a verse split across two segments is still found.
 */
export function matchQuran(text, options = {}) {
  if (!detector || typeof text !== 'string') return [];
  const { targets = [], tailText = '' } = options;
  return detector.detect(text, { tailText }).map(core => buildCitation(core, targets));
}

export function hadithReview(text) {
  return /(?:قال رسول|قال النبي|حديث|رواه|عن النبي)/u.test(text) ? [{ kind: 'hadith', status: 'needs-review', text, reason: 'Hadith wording detected; authoritative corpus and human verification required.' }] : [];
}
