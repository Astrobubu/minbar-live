import { translate as defaultTranslate } from './openai.mjs';

/**
 * Verse context for one target language, built from a segment's Quran citations.
 * Gives the model the canonical Arabic and, when one exists, the established translation to reuse.
 */
export function quranContext(citations, lang) {
  return (citations || []).filter(c => c && c.kind === 'quran' && c.reference).slice(0, 3).map(c => ({
    reference: c.reference,
    spokenQuotedText: c.matchedText,
    canonicalArabic: c.arabic,
    ...(c.translations?.[lang] ? { establishedTranslation: c.translations[lang], translationSource: c.translationSources?.[lang] } : {})
  }));
}

/**
 * Translate one piece of source text into every target language in parallel.
 *
 * onResult(lang, {text, error}, remaining) fires as each language settles, so callers can
 * publish the first language as soon as it is ready. `remaining` is how many languages are
 * still outstanding after this one (0 on the last call).
 * Never rejects: failures are returned in `errors` and the matching language is absent
 * from `translations`.
 */
export async function translateAll({ text, targets, sourceLanguage, context = [], quran = [], safetyId, translate = defaultTranslate, onResult = () => {} }) {
  const translations = {}, errors = {};
  let remaining = targets.length;
  await Promise.all(targets.map(async lang => {
    let result;
    try {
      const verses = quranContext(quran, lang);
      const out = String(await translate(text, lang, safetyId, sourceLanguage, context, verses)).trim();
      if (!out) throw new Error('Empty translation.');
      translations[lang] = out;
      result = { text: out };
    } catch (error) {
      errors[lang] = error.message || 'Translation failed.';
      result = { error: errors[lang] };
    }
    remaining -= 1;
    try { onResult(lang, result, remaining); } catch { /* listener errors must not break the fan-out */ }
  }));
  return { translations, errors };
}
