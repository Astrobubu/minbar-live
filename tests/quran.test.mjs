import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArabic, matchQuran, quranAvailable, hadithReview, createDetector } from '../lib/quran.mjs';
import { corpus, verseAt, translationText, translationLanguages, surahName, TRANSLATION_SOURCES } from '../lib/quran-data.mjs';
import { translateAll, quranContext } from '../lib/translation.mjs';
import { translationInstructions } from '../lib/openai.mjs';

test('full attributed Quran corpus loads', () => assert.equal(quranAvailable, true));

test('Arabic normalization strips diacritics, unifies letter forms and keeps meaningful words', () => {
  assert.equal(normalizeArabic('إِنَّ اللَّهَ  يَأْمُرُ'), 'ان الله يامر');
  assert.equal(normalizeArabic('الصَّلَاةَ'), normalizeArabic('الصلاة'));
  assert.equal(normalizeArabic('الصلاة'), normalizeArabic('الصلاه'));                // ta marbuta / ha
  assert.equal(normalizeArabic('موسىٰ'), normalizeArabic('موسي'));                    // alif maqsura / dagger alif
  assert.equal(normalizeArabic('الرَّحْمَـٰنِ'), 'الرحمن');                          // tatweel + dagger alif
  assert.equal(normalizeArabic('أولئك'), normalizeArabic('اولئك'));                   // hamza seats
  assert.equal(normalizeArabic('ﷲ'), 'الله');                                         // ligature
  assert.equal(normalizeArabic('كتاب، و"قال"؟'), 'كتاب و قال');                      // punctuation
});

test('every Tanzil token normalizes to plain Arabic letters', () => {
  for (const verse of corpus) assert.match(normalizeArabic(verse.arabic), /^[ء-ي]+( [ء-ي]+)*$/, verse.reference);
});

test('exact distinctive 5+ word source quote retrieves sourced verse', () => {
  const matches = matchQuran('قال الله إن الله يأمر بالعدل والإحسان وإيتاء ذي القربى');
  assert.ok(matches.some(c => c.reference === '16:90'));
  assert.ok(matches.every(c => c.sourceUrl.startsWith('https://tanzil.net/#')));
});

test('citation contract: field names, canonical Arabic, established translations only for target languages', () => {
  const [c, ...rest] = matchQuran('ذكرنا قول الله تعالى اللَّهُ لَا إِلَـٰهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ لَا تَأْخُذُهُ سِنَةٌ وَلَا نَوْمٌ لَّهُ مَا فِي السَّمَاوَاتِ وَمَا فِي الْأَرْضِ', { targets: ['en', 'ur', 'ar'] });
  assert.equal(rest.length, 0);
  assert.equal(c.kind, 'quran');
  assert.equal(c.reference, '2:255');
  assert.deepEqual([c.surah, c.ayahStart, c.ayahEnd], [2, 255, 255]);
  assert.deepEqual(c.surahName, { ar: 'البقرة', en: 'Al-Baqara', meaning: 'The Cow' });
  assert.equal(c.arabic, verseAt(2, 255).arabic);
  assert.deepEqual(Object.keys(c.translations).sort(), ['en', 'ur']);
  assert.match(c.translations.en, /^Allah - there is no deity except Him/);
  assert.equal(c.translationSources.en, 'Saheeh International (Tanzil)');
  assert.equal(c.translationSources.ur, 'Fateh Muhammad Jalandhry (Tanzil)');
  assert.equal(c.matchType, 'exact');
  assert.ok(c.confidence > 0.9 && c.confidence <= 1);
  assert.match(normalizeArabic(c.matchedText), /^الله لا اله الا هو الحي القيوم/); // spoken span only, without the lead-in
  assert.deepEqual(matchQuran('اللَّهُ لَا إِلَـٰهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ لَا تَأْخُذُهُ سِنَةٌ وَلَا نَوْمٌ')[0].translations, {}); // no targets -> none
});

test('runs across consecutive ayat merge into a range with joined text', () => {
  const text = [verseAt(2, 255).arabic, verseAt(2, 256).arabic].join(' ');
  const [c] = matchQuran(text, { targets: ['en', 'fr'] });
  assert.equal(c.reference, '2:255-256');
  assert.deepEqual([c.ayahStart, c.ayahEnd], [255, 256]);
  assert.equal(c.arabic, text);
  assert.equal(c.verses.length, 2);
  assert.ok(c.translations.en.includes(translationText('en', 2, 255)) && c.translations.en.endsWith(translationText('en', 2, 256)));
  assert.ok(c.translations.fr);
});

test('partial recitation of a verse with ASR errors is approximate but still cited', () => {
  const [c] = matchQuran('إن الله يأمر بالعدل والاحسان وايتاء ذي القربا وينهى عن الفحشاء', { targets: ['en'] });
  assert.equal(c.reference, '16:90');
  assert.equal(c.matchType, 'approximate');
  assert.ok(c.confidence >= 0.6 && c.confidence < 1);
});

test('a verse split across two segments is found through the previous-segment tail', () => {
  const first = 'الله لا إله إلا هو الحي القيوم لا تأخذه سنة';
  const second = 'ولا نوم له ما في السماوات وما في الأرض من ذا الذي يشفع عنده إلا بإذنه';
  assert.deepEqual(matchQuran(second.split(' ').slice(0, 3).join(' ')), []);
  const [c] = matchQuran(second, { tailText: first });
  assert.equal(c.reference, '2:255');
  assert.equal(c.spansPreviousSegment, true);
  assert.ok(!c.matchedText.includes('القيوم'), 'matchedText only covers the current segment');
  assert.ok(c.evidence.normalizedTokenStart >= 0);
});

test('a tail alone never produces a citation for the current segment', () => {
  assert.deepEqual(matchQuran('وبعد ذلك سنتحدث عن الصبر', { tailText: 'الله لا إله إلا هو الحي القيوم لا تأخذه سنة ولا نوم' }), []);
});

test('short devotional language and stock formulas are not auto-cited', () => {
  for (const text of ['الحمد لله رب العالمين', 'بسم الله الرحمن الرحيم', 'أعوذ بالله من الشيطان الرجيم', 'صلى الله عليه وسلم', 'إن الله على كل شيء قدير', 'يا أيها الذين آمنوا'])
    assert.deepEqual(matchQuran(text), [], text);
});

test('ambiguous phrases (same text at two places) do not get a random citation', () => {
  const duplicate = createDetector([...corpus, { surah: 115, ayah: 1, arabic: verseAt(16, 90).arabic }]);
  assert.deepEqual(duplicate.detect(verseAt(16, 90).arabic), []);
  assert.equal(createDetector(corpus).detect(verseAt(16, 90).arabic).length, 1);
  assert.deepEqual(matchQuran('فبأي آلاء ربكما تكذبان فبأي آلاء ربكما تكذبان'), []); // refrain repeated 31 times in surah 55
});

test('ordinary sermon prose does not invent a verse', () => {
  assert.deepEqual(matchQuran('علينا أن نعتني بجيراننا ونساعد المحتاجين في مجتمعنا'), []);
  assert.deepEqual(matchQuran(''), []);
  assert.deepEqual(matchQuran('English only text'), []);
});

test('a quote is never reported across a surah boundary', () => {
  const text = `${verseAt(1, 6).arabic} ${verseAt(1, 7).arabic} ${verseAt(2, 1).arabic} ${verseAt(2, 2).arabic} ${verseAt(2, 3).arabic}`;
  for (const c of matchQuran(text)) assert.ok(c.ayahEnd >= c.ayahStart && c.reference.startsWith(`${c.surah}:`));
});

test('very long texts (a whole uploaded recording) are scanned in windows', () => {
  const filler = 'ونحن نتحدث اليوم عن موضوع مهم في حياة المسلم وهو حسن الخلق والتعامل مع الناس '.repeat(40);
  const text = `${filler} ${verseAt(2, 255).arabic} ${filler} ${verseAt(112, 1).arabic} ${verseAt(112, 2).arabic} ${verseAt(112, 3).arabic} ${verseAt(112, 4).arabic} ${filler}`;
  const refs = matchQuran(text).map(c => c.reference);
  assert.ok(refs.includes('2:255') && refs.includes('112:1-4'), refs.join());
});

test('Tanzil translations load for en, ur, id, fr, tr with 6236 verses each, headers intact', async () => {
  assert.deepEqual(translationLanguages.sort(), ['en', 'fr', 'id', 'tr', 'ur']);
  assert.match(translationText('en', 1, 2), /praise is \[due\] to Allah/);
  assert.match(translationText('tr', 1, 2), /Hamd/);
  assert.match(translationText('fr', 1, 2), /Louange/);
  assert.match(translationText('id', 1, 2), /Segala puji/);
  assert.match(translationText('ur', 1, 2), /تعریف/);
  const { readFile } = await import('node:fs/promises');
  for (const source of Object.values(TRANSLATION_SOURCES)) {
    const raw = await readFile(new URL(`../data/${source.file}`, import.meta.url), 'utf8');
    assert.match(raw, /Quran Translation/);
    assert.match(raw, new RegExp(`ID: ${source.id.replace('.', '\\.')}`));
    assert.match(raw, /Source: Tanzil\.net/);
  }
});

test('surah names are available in Arabic, transliteration and English meaning', () => {
  assert.deepEqual(surahName(1), { ar: 'الفاتحة', en: 'Al-Faatiha', meaning: 'The Opening' });
  assert.equal(surahName(114).ar, 'الناس');
  for (let n = 1; n <= 114; n++) assert.ok(surahName(n).ar && surahName(n).en && surahName(n).meaning, `surah ${n}`);
});

test('Hadith markers produce review queue without generated references', () => {
  const result = hadithReview('قال رسول الله إنما الأعمال بالنيات');
  assert.equal(result[0].status, 'needs-review');
  assert.equal(result[0].reference, undefined);
});

test('translation call receives canonical verse + established translation per target language', async () => {
  const [c] = matchQuran('قال الله تعالى إن الله يأمر بالعدل والإحسان وإيتاء ذي القربى', { targets: ['en', 'ur'] });
  assert.deepEqual(quranContext([c], 'en')[0].establishedTranslation, translationText('en', 16, 90));
  assert.equal(quranContext([c], 'fr')[0].establishedTranslation, undefined);
  assert.equal(quranContext([c], 'fr')[0].canonicalArabic, c.arabic);
  assert.deepEqual(quranContext([], 'en'), []);
  const seen = {};
  await translateAll({ text: 'x', targets: ['en', 'ur'], sourceLanguage: 'ar', quran: [c], translate: async (text, lang, safety, source, context, verses) => { seen[lang] = verses; return lang; } });
  assert.equal(seen.en[0].reference, '16:90');
  assert.equal(seen.ur[0].translationSource, 'Fateh Muhammad Jalandhry (Tanzil)');
  const calls = [];
  await translateAll({ text: 'x', targets: ['en'], sourceLanguage: 'ar', translate: async (...args) => { calls.push(args); return 'ok'; } });
  assert.deepEqual(calls[0][5], []);
  assert.match(translationInstructions('ar', 'en', true), /established English translation/);
  assert.doesNotMatch(translationInstructions('ar', 'en'), /quranVerses/);
});
