import test from 'node:test';import assert from 'node:assert/strict';import {normalizeArabic,matchQuran,quranAvailable,hadithReview} from '../lib/quran.mjs';
test('full attributed Quran corpus loads',()=>assert.equal(quranAvailable,true));
test('Arabic normalization strips diacritics but preserves meaningful words',()=>assert.equal(normalizeArabic('إِنَّ اللَّهَ  يَأْمُرُ'), 'ان الله يامر'));
test('exact distinctive 5+ word source quote retrieves sourced verse',()=>{const matches=matchQuran('قال الله إن الله يأمر بالعدل والإحسان وإيتاء ذي القربى');assert.ok(matches.some(c=>c.reference==='16:90'));assert.ok(matches.every(c=>c.sourceUrl.startsWith('https://tanzil.net/#')));});
test('short devotional language is not auto-cited',()=>assert.deepEqual(matchQuran('الحمد لله رب العالمين'),[]));
test('ambiguous phrases do not get a random citation',()=>assert.deepEqual(matchQuran('one two three four five',[{reference:'1:1',arabic:'one two three four five'},{reference:'2:1',arabic:'one two three four five'}]),[]));
test('ordinary sermon prose does not invent a verse',()=>assert.deepEqual(matchQuran('علينا أن نعتني بجيراننا ونساعد المحتاجين في مجتمعنا'),[]));
test('Hadith markers produce review queue without generated references',()=>{const result=hadithReview('قال رسول الله إنما الأعمال بالنيات');assert.equal(result[0].status,'needs-review');assert.equal(result[0].reference,undefined);});
