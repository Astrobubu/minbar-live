// Precision / recall / latency of the Quran detector on generated noisy variants of real verses plus
// non-Quran sermon text. Numbers are printed so `npm test` shows them; README quotes a recorded run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchQuran } from '../lib/quran.mjs';
import { corpus } from '../lib/quran-data.mjs';
import { buildPositiveCases, NEGATIVES, shuffledVerses, rng, stripMarks, swapLetters, dropToken } from './support/quran-fixtures.mjs';

const inRange = (c, expect) => c.surah === expect.surah && c.ayahStart <= expect.to && c.ayahEnd >= expect.from;

function evaluate() {
  const cases = buildPositiveCases();
  const times = [], byKind = {}, byLevel = {};
  let tp = 0, fp = 0;
  const misses = [];
  for (const c of cases) {
    let hits = [];
    c.segments.forEach((segment, i) => {
      const t0 = performance.now();
      const out = matchQuran(segment, { tailText: i ? c.segments[i - 1] : '', targets: ['en', 'ur'] });
      times.push(performance.now() - t0);
      if (i === c.segments.length - 1) hits = out;
    });
    const kind = (byKind[c.kind] ??= { n: 0, hit: 0 }), level = (byLevel[c.level] ??= { n: 0, hit: 0 });
    kind.n++; level.n++;
    if (hits.some(h => inRange(h, c.expect))) { tp++; kind.hit++; level.hit++; } else misses.push(`${c.kind} ${c.verse}`);
    fp += hits.filter(h => !inRange(h, c.expect)).length;
  }
  const negatives = [...NEGATIVES, ...shuffledVerses()];
  const negativeFalse = negatives.filter(text => matchQuran(text).length).length;
  times.sort((a, b) => a - b);
  return { cases, tp, fp, misses, byKind, byLevel, negatives: negatives.length, negativeFalse, times,
    precision: tp / (tp + fp + negativeFalse), recall: tp / cases.length, p50: times[times.length >> 1], p99: times[Math.floor(times.length * 0.99)], max: times.at(-1) };
}

test('noisy-variant benchmark: precision, recall and latency', () => {
  evaluate(); // warm up (JIT) so the latency numbers describe a running server
  const r = evaluate();
  console.log(`# quran detector: ${r.cases.length} positive cases (${r.byLevel.standard.hit}/${r.byLevel.standard.n} standard, ${r.byLevel.hard.hit}/${r.byLevel.hard.n} hard), ${r.negatives} negatives`);
  console.log(`# precision ${r.precision.toFixed(3)} (wrong-verse ${r.fp}, false alarms on negatives ${r.negativeFalse}), recall ${r.recall.toFixed(3)}`);
  console.log(`# latency per segment: p50 ${r.p50.toFixed(2)}ms p99 ${r.p99.toFixed(2)}ms max ${r.max.toFixed(2)}ms`);
  console.log('# by variant: ' + Object.entries(r.byKind).map(([k, v]) => `${k} ${v.hit}/${v.n}`).join(', '));
  if (r.misses.length) console.log('# misses: ' + r.misses.join('; '));
  assert.equal(r.fp, 0, 'no citation may point at the wrong verse');
  assert.equal(r.negativeFalse, 0, 'no false alarms on non-Quran text');
  assert.ok(r.precision >= 0.99, `precision ${r.precision}`);
  assert.ok(r.recall >= 0.97, `recall ${r.recall}`);
  assert.ok(r.byLevel.standard.hit / r.byLevel.standard.n >= 0.98);
  for (const kind of ['diacritics', 'no-diacritics', 'respelled', 'embedded', 'split-2-segments']) assert.equal(r.byKind[kind].hit, r.byKind[kind].n, kind);
  assert.ok(r.p99 < 20, `p99 latency ${r.p99}ms must stay under 20ms`);
});

test('corpus sweep: every 5th verse of 6+ tokens, clean and noisy, never cites the wrong verse', () => {
  const r = rng(11);
  let clean = 0, cleanHit = 0, noisy = 0, noisyHit = 0, wrong = 0;
  for (let i = 0; i < corpus.length; i += 5) {
    const verse = corpus[i], tokens = stripMarks(verse.arabic).split(' ');
    if (tokens.length < 6) continue;
    const inVerse = h => h.surah === verse.surah && h.ayahStart <= verse.ayah && h.ayahEnd >= verse.ayah;
    const hits = matchQuran(tokens.join(' '));
    clean++; if (hits.some(inVerse)) cleanHit++; wrong += hits.filter(h => !inVerse(h)).length;
    if (tokens.length >= 8) {
      const noisyHits = matchQuran(dropToken(r, swapLetters(r, tokens, 1)).join(' '));
      noisy++; if (noisyHits.some(inVerse)) noisyHit++; wrong += noisyHits.filter(h => !inVerse(h)).length;
    }
  }
  console.log(`# corpus sweep: clean ${cleanHit}/${clean}, noisy ${noisyHit}/${noisy}, wrong-verse citations ${wrong}`);
  assert.equal(wrong, 0);
  assert.ok(cleanHit / clean >= 0.95, 'clean recall (misses are verses repeated elsewhere, which are deliberately not cited)');
  assert.ok(noisyHit / noisy >= 0.93);
});
