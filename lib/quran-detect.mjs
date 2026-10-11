// Deterministic Quran detector: finds Quran verses inside (noisy) Arabic ASR text.
//
// Pipeline (no LLM, no network):
//   1. Normalize + tokenize the spoken text (optionally prefixed with the tail of the previous segment).
//   2. Seed retrieval: unigram and bigram postings (over a very tolerant "skeleton" key of each token) give
//      (query position, Quran stream position) seeds. Seeds that share a diagonal (stream - query position)
//      form a cluster, i.e. a candidate region of the whole Quran treated as one continuous token stream,
//      so quotes that run across consecutive ayat need no special handling.
//   3. Each cluster is aligned with a banded Smith-Waterman: exact / variant / fuzzy token matches score
//      positively; wrong, missing or extra tokens cost a penalty, so a small number of ASR errors is absorbed.
//   4. Acceptance rules (minimum span, density, coverage of the verse(s), rarity, formula blacklist) and an
//      ambiguity rule (a phrase that fits two different places equally well is not cited).
import { tokenizeWithSource, matchKey, particleKey, skeleton, editCost, fuzzyLimit, tokenize } from './arabic.mjs';

export const DEFAULTS = {
  maxPostings: 300,        // skip seed keys occurring more often than this (stop words)
  maxClusters: 24,         // DP is run for at most this many clusters, best seed weight first
  clusterFloor: 0.35,      // ... and only for clusters weighing at least this fraction of the best one
  minClusterCover: 3,      // distinct query positions covered by seeds
  minClusterWeight: 9,
  clusterGap: 4,           // diagonals closer than this belong to one cluster
  bandPad: 4,              // extra diagonals either side of a cluster (room for missing/extra tokens)
  maxClusterWidth: 36,
  matchScores: { exact: 2, variant: 1.6, fuzzy: 1.2 },
  mismatch: -1.2,          // aligned but different token
  gap: -1.5,               // missing or extra token
  minMatched: 4,           // aligned tokens
  minDensity: 0.6,         // aligned tokens / query span covered
  shortVerseCoverage: 0.6, // fraction of the touched verse(s) that must be matched ...
  longSpan: 6,             // ... unless at least this many tokens matched
  minRun: 3,               // longest uninterrupted run of aligned tokens (scattered coincidences are not quotes)
  minExact: 2,
  minRarity: 9,            // sum of ln(streamSize/df) of matched tokens: guards generic phrases
  ambiguityMargin: 0.1,    // a second location scoring within 10% of the best makes the phrase ambiguous
  minConfidence: 0.45,
  window: 64,              // long texts are processed in windows of this many tokens
  stride: 44,
  minStraddleTokens: 2     // tokens a citation must take from the current segment when it also uses the tail
};

// Stock phrases that must never be cited on their own (documented in README). Normalized text.
const FORMULA_TEXT = [
  'بسم الله الرحمن الرحيم', 'اعوذ بالله من الشيطان الرجيم', 'الحمد لله', 'الحمد لله رب العالمين', 'ان الحمد لله',
  'ان الحمد لله نحمده ونستعينه ونستغفره', 'صلى الله عليه وسلم', 'عليه الصلاه والسلام', 'رضي الله عنه', 'رضي الله عنهم',
  'ان الله', 'سبحان الله', 'لا اله الا الله', 'ما شاء الله', 'ان الله على كل شيء قدير', 'والله اعلم', 'يا ايها الذين امنوا',
  'يا ايها الناس', 'صدق الله العظيم', 'قال الله تعالى', 'قال تعالى', 'قال الله', 'ان الله غفور رحيم', 'ان الله بكل شيء عليم',
  'ان الله سميع بصير', 'ان الله عزيز حكيم', 'اتقوا الله', 'ان الله مع الصابرين', 'ان الله يحب المحسنين'
].map(text => tokenize(text));

const GRADE_EXACT = 2, GRADE_VARIANT = 1.6, GRADE_FUZZY = 1.2;

function isFormula(spanTokens) {
  for (const formula of FORMULA_TEXT) {
    if (spanTokens.length > formula.length + 1) continue;
    const span = ' ' + spanTokens.join(' ') + ' ', f = ' ' + formula.join(' ') + ' ';
    if (span.includes(f) || f.includes(span)) return true;
  }
  return false;
}

/** verses: [{ surah, ayah, arabic }] in Quran order. Returns { detect, size }. */
export function createDetector(verses, overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  const sTok = [], sKey = [], sPk = [], sSk = [], sVerse = [], sId = [], sPid = [];
  const ids = new Map();
  const idOf = key => { let id = ids.get(key); if (id === undefined) { id = ids.size; ids.set(key, id); } return id; };
  const verseStart = [], verseTokens = [];
  verses.forEach((verse, vi) => {
    const tokens = tokenize(verse.arabic);
    verseStart.push(sTok.length);
    verseTokens.push(tokens.length);
    for (const token of tokens) {
      const key = matchKey(token);
      const pk = particleKey(key);
      sTok.push(token); sKey.push(key); sPk.push(pk); sSk.push(skeleton(token)); sVerse.push(vi); sId.push(idOf(key)); sPid.push(idOf(pk ?? key));
    }
  });
  const S = sTok.length;
  const uni = new Map(), bi = new Map(), df = new Map();
  const push = (map, key, position) => { const list = map.get(key); if (list) list.push(position); else map.set(key, [position]); };
  for (let p = 0; p < S; p++) {
    df.set(sSk[p], (df.get(sSk[p]) || 0) + 1);
    if (sSk[p].length >= 2) push(uni, sSk[p], p);
    if (p + 1 < S && sVerse[p] === sVerse[p + 1] && sSk[p].length >= 1 && sSk[p + 1].length >= 1) push(bi, sSk[p] + ' ' + sSk[p + 1], p);
  }
  const idf = key => Math.log(S / (df.get(key) || 1));

  let unseen = -2;
  const knownId = key => ids.get(key) ?? unseen--;
  function compare(q, i, p, cache) {
    if (q.ids[i] === sId[p]) return GRADE_EXACT;
    if (q.pids[i] === sPid[p]) return GRADE_VARIANT;
    const a = q.keys[i], b = sKey[p];
    const limit = fuzzyLimit(Math.max(a.length, b.length));
    if (!limit || Math.abs(a.length - b.length) > 2) return 0;
    const id = i * 65536 + sId[p];
    let cost = cache.get(id);
    if (cost === undefined) { cost = editCost(a, b, limit); cache.set(id, cost); }
    return cost <= limit ? GRADE_FUZZY : 0;
  }

  /** Banded local alignment of query tokens against stream diagonals [dLo, dHi]. Returns matched pairs. */
  function align(q, dLo, dHi, cache) {
    const n = q.keys.length, K = dHi - dLo + 1;
    const H = new Float32Array(n * K), T = new Uint8Array(n * K);
    let best = 0, bi_ = -1, bk = -1;
    const grades = new Float32Array(n * K);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < K; k++) {
        const p = i + dLo + k;
        if (p < 0 || p >= S) continue;
        const grade = compare(q, i, p, cache);
        grades[i * K + k] = grade;
        const diag = (i ? H[(i - 1) * K + k] : 0) + (grade ? grade : cfg.mismatch);
        const up = i && k + 1 < K ? H[(i - 1) * K + k + 1] + cfg.gap : -1;       // extra spoken token
        const left = k ? H[i * K + k - 1] + cfg.gap : -1;                          // Quran token not spoken
        let v = 0, dir = 0;
        if (diag > v) { v = diag; dir = 1; }
        if (up > v) { v = up; dir = 2; }
        if (left > v) { v = left; dir = 3; }
        H[i * K + k] = v; T[i * K + k] = dir;
        if (v > best) { best = v; bi_ = i; bk = k; }
      }
    }
    if (bi_ < 0) return [];
    const pairs = [];
    let i = bi_, k = bk;
    while (i >= 0 && k >= 0 && k < K && T[i * K + k]) {
      const dir = T[i * K + k];
      if (dir === 1) { const g = grades[i * K + k]; if (g) pairs.push({ i, p: i + dLo + k, g }); i -= 1; }
      else if (dir === 2) { i -= 1; k += 1; }
      else { k -= 1; }
    }
    return pairs.reverse();
  }

  /** Turn aligned pairs into a verse-range candidate (or null). */
  function summarize(pairs, q) {
    if (!pairs.length) return null;
    // One surah only: keep the surah holding most matched tokens.
    const bySurah = new Map();
    for (const pair of pairs) { const s = verses[sVerse[pair.p]].surah; bySurah.set(s, (bySurah.get(s) || 0) + pair.g); }
    const surah = [...bySurah.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let kept = pairs.filter(pair => verses[sVerse[pair.p]].surah === surah);
    // Drop edge verses that were touched by a single stray token.
    for (let round = 0; round < 2 && kept.length; round++) {
      const first = sVerse[kept[0].p], last = sVerse[kept[kept.length - 1].p];
      if (first === last) break;
      const count = v => kept.filter(pair => sVerse[pair.p] === v).length;
      if (count(first) <= 1 && verseTokens[first] > 1) kept = kept.filter(pair => sVerse[pair.p] !== first);
      else if (count(last) <= 1 && verseTokens[last] > 1) kept = kept.filter(pair => sVerse[pair.p] !== last);
      else break;
    }
    if (!kept.length) return null;
    const qMin = kept[0].i, qMax = kept[kept.length - 1].i, pMin = kept[0].p, pMax = kept[kept.length - 1].p;
    const firstVerse = sVerse[pMin], lastVerse = sVerse[pMax];
    const M = kept.length;
    const exact = kept.filter(pair => pair.g === GRADE_EXACT).length;
    const qGaps = qMax - qMin + 1 - M, pGaps = pMax - pMin + 1 - M;
    const sum = kept.reduce((a, pair) => a + pair.g, 0);
    let run = 1, longestRun = 1;
    for (let k = 1; k < kept.length; k++) { run = kept[k].i === kept[k - 1].i + 1 && kept[k].p === kept[k - 1].p + 1 ? run + 1 : 1; if (run > longestRun) longestRun = run; }
    let touched = 0;
    for (let v = firstVerse; v <= lastVerse; v++) touched += verseTokens[v];
    let rarity = 0;
    for (const pair of kept) rarity += idf(sSk[pair.p]) * (pair.g === GRADE_EXACT ? 1 : 0.7);
    return {
      pairs: kept, M, exact, longestRun, qMin, qMax, pMin, pMax, firstVerse, lastVerse, qGaps, pGaps, touched, rarity, surah,
      density: M / (qMax - qMin + 1),
      score: sum + cfg.gap * 0.8 * (qGaps + pGaps),
      quality: (sum / 2) / Math.max(qMax - qMin + 1, pMax - pMin + 1)
    };
  }

  function detectWindow(q, cache) {
    const n = q.keys.length;
    // Seeds, encoded as diag*1024+i so a numeric sort groups them by diagonal.
    const seeds = [], weight = new Float64Array(n);
    const addSeeds = (list, i, w, width) => {
      if (!list || list.length > cfg.maxPostings) return;
      for (const p of list) seeds.push([p - i, i, w, width]);
    };
    for (let i = 0; i < n; i++) {
      const sk = q.sks[i];
      if (sk.length >= 2) { const list = uni.get(sk); if (list && list.length <= cfg.maxPostings) addSeeds(list, i, Math.log(S / list.length), 1); }
      if (i + 1 < n) { const list = bi.get(sk + ' ' + q.sks[i + 1]); if (list && list.length <= cfg.maxPostings) addSeeds(list, i, Math.log(S / list.length), 2); }
    }
    if (seeds.length < 2) return [];
    seeds.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const clusters = [];
    let cur = null;
    for (const seed of seeds) {
      if (!cur || seed[0] - cur.maxD > cfg.clusterGap || seed[0] - cur.minD > cfg.maxClusterWidth) {
        cur = { minD: seed[0], maxD: seed[0], cover: new Set(), weight: 0 };
        clusters.push(cur);
      }
      cur.maxD = seed[0]; cur.weight += seed[2];
      for (let w = 0; w < seed[3]; w++) cur.cover.add(seed[1] + w);
    }
    const viable = clusters.filter(c => c.cover.size >= cfg.minClusterCover && c.weight >= cfg.minClusterWeight).sort((a, b) => b.weight - a.weight);
    const floor = viable.length ? viable[0].weight * cfg.clusterFloor : 0;
    const strong = viable.filter(c => c.weight >= floor).slice(0, cfg.maxClusters);
    const candidates = [];
    for (const cluster of strong) {
      const pairs = align(q, cluster.minD - cfg.bandPad, cluster.maxD + cfg.bandPad, cache);
      const cand = summarize(pairs, q);
      if (cand && cand.M >= cfg.minMatched && cand.density >= cfg.minDensity) candidates.push(cand);
    }
    return candidates;
  }

  /** Remove duplicates and ambiguous locations from structural candidates. Returns [{cand, runnerUp}]. */
  function resolve(candidates) {
    candidates.sort((a, b) => b.score - a.score);
    const chosen = [], blocked = [];
    const overlapQ = (a, b) => {
      const lo = Math.max(a.qMin, b.qMin), hi = Math.min(a.qMax, b.qMax);
      return hi >= lo && (hi - lo + 1) / Math.min(a.qMax - a.qMin + 1, b.qMax - b.qMin + 1) >= 0.5;
    };
    for (const cand of candidates) {
      if (blocked.some(b => overlapQ(b, cand))) continue;
      const rival = chosen.find(c => overlapQ(c.cand, cand));
      if (!rival) { chosen.push({ cand, runnerUp: 0 }); continue; }
      const sameVerses = !(cand.lastVerse < rival.cand.firstVerse || cand.firstVerse > rival.cand.lastVerse);
      if (sameVerses) continue;
      if (cand.score >= rival.cand.score * (1 - cfg.ambiguityMargin)) {
        chosen.splice(chosen.indexOf(rival), 1);
        blocked.push(rival.cand);
      } else rival.runnerUp = Math.max(rival.runnerUp, cand.score / rival.cand.score);
    }
    return chosen;
  }

  function accept(entry, q, tailLen) {
    const c = entry.cand;
    const current = c.pairs.filter(pair => pair.i >= tailLen);
    if (!current.length) return null;
    if (tailLen && c.qMin < tailLen && current.length < cfg.minStraddleTokens) return null;
    if (c.exact < cfg.minExact || c.longestRun < Math.min(cfg.minRun, c.M)) return null;
    if (!(c.M >= cfg.longSpan || c.M >= cfg.shortVerseCoverage * c.touched)) return null;
    if (c.rarity < cfg.minRarity) return null;
    if (isFormula(q.tokens.slice(c.qMin, c.qMax + 1))) return null;
    const allExact = c.exact === c.M && c.qGaps === 0 && c.pGaps === 0;
    let confidence = c.quality * (0.65 + 0.35 * Math.min(1, c.M / 8));
    if (entry.runnerUp > 0.75) confidence *= 0.85;
    confidence = Math.round(Math.min(1, confidence) * 100) / 100;
    if (confidence < cfg.minConfidence) return null;
    const first = verses[c.firstVerse], last = verses[c.lastVerse];
    const from = Math.max(c.qMin, tailLen), to = c.qMax;
    const rawFrom = q.rawIndex[from], rawTo = q.rawIndex[to];
    return {
      surah: c.surah, ayahStart: first.ayah, ayahEnd: last.ayah,
      matchType: allExact ? 'exact' : 'approximate', confidence,
      matchedText: q.raw.slice(rawFrom, rawTo + 1).join(' '),
      spansPreviousSegment: c.qMin < tailLen,
      localFrom: from, localTo: to,
      stats: { matched: c.M, exact: c.exact, gaps: c.qGaps + c.pGaps, density: Math.round(c.density * 100) / 100, rarity: Math.round(c.rarity * 10) / 10, score: Math.round(c.score * 10) / 10 }
    };
  }

  /** detect(text, { tailText }) -> citation cores (no translations). */
  function detect(text, { tailText = '', maxTail = 24 } = {}) {
    const cur = tokenizeWithSource(text);
    if (cur.tokens.length < 3) return [];
    let tail = tailText ? tokenizeWithSource(tailText) : { tokens: [], raw: [], rawIndex: [] };
    if (tail.tokens.length > maxTail) {
      const cut = tail.tokens.length - maxTail;
      tail = { tokens: tail.tokens.slice(cut), rawIndex: tail.rawIndex.slice(cut), raw: tail.raw };
    }
    const tailLen = tail.tokens.length;
    const all = {
      tokens: [...tail.tokens, ...cur.tokens],
      rawIndex: [...tail.rawIndex.map(() => 0), ...cur.rawIndex],
      raw: cur.raw
    };
    const total = all.tokens.length;
    const found = new Map();
    for (let start = 0; start < total; start += cfg.stride) {
      const end = Math.min(total, start + cfg.window);
      const slice = all.tokens.slice(start, end);
      const q = { tokens: slice, keys: slice.map(matchKey), ids: [], pids: [], sks: slice.map(skeleton), rawIndex: all.rawIndex.slice(start, end), raw: all.raw };
      q.ids = q.keys.map(knownId);
      q.pids = q.keys.map((key, i) => { const pk = particleKey(key); return pk === null ? q.ids[i] : knownId(pk); });
      // Evidence/tail bookkeeping is done in window-local indexes, then shifted back to global ones.
      const localTail = Math.max(0, Math.min(tailLen - start, slice.length));
      for (const entry of resolve(detectWindow(q, new Map()))) {
        const result = accept(entry, q, localTail);
        if (!result) continue;
        result.evidence = { normalizedTokenStart: start + result.localFrom - tailLen, normalizedTokenEnd: start + result.localTo + 1 - tailLen, tokenCount: result.localTo - result.localFrom + 1 };
        delete result.localFrom; delete result.localTo;
        const key = `${result.surah}:${result.ayahStart}-${result.ayahEnd}`;
        const prior = found.get(key);
        if (!prior || prior.confidence < result.confidence) found.set(key, result);
      }
      if (end === total) break;
    }
    return [...found.values()].sort((a, b) => a.evidence.normalizedTokenStart - b.evidence.normalizedTokenStart);
  }

  return { detect, size: S, verseCount: verses.length };
}
