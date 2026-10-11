// Arabic text normalization and token similarity used by the Quran detector.
//
// Two levels of equality are used when comparing spoken (ASR) tokens with Tanzil tokens:
//   1. normalizeArabic()  - orthographic normalization: diacritics, Quranic marks, tatweel, hamza seats,
//      alif maqsura, ta marbuta, Persian/Urdu letter forms, ligatures, punctuation. Both sides go through it.
//   2. matchKey()         - drops non-initial alifs of longer words (Tanzil Simple writes some medial alifs
//      differently from modern ASR spelling: الرحمن/الرحمان, إسماعيل/إسمعيل). Equal keys count as "exact".
// Anything else is compared with a weighted edit distance (cheap substitutions for letters ASR confuses,
// cheap insertion/deletion of weak letters) and counts as "approximate".

// Tashkeel, Quranic annotation signs, dagger alif, tatweel, bidi controls.
const MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭ࣓-ࣿـ​-‏‪-‮⁦-⁩﻿]/g;

const LETTER_MAP = new Map(Object.entries({
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ٲ': 'ا', 'ٳ': 'ا', // alif forms
  'ى': 'ي', 'ی': 'ي', 'ے': 'ي', 'ۓ': 'ي', 'ئ': 'ي', // alif maqsura, Persian ya, hamza on ya
  'ؤ': 'و', // hamza on waw
  'ة': 'ه', 'ہ': 'ه', 'ۃ': 'ه', 'ھ': 'ه', 'ە': 'ه', 'ۀ': 'ه', // ta marbuta, ha forms
  'ک': 'ك', 'ڪ': 'ك', // keheh
  'ء': '' // stand-alone hamza: ASR and Tanzil disagree on its presence/seat
}));

export function normalizeArabic(text) {
  return String(text ?? '')
    .normalize('NFKC') // expands ligatures such as the Allah and salla-llahu-alayhi-wa-sallam glyphs
    .replace(MARKS, '')
    .replace(/[ءآأؤإئةىٱ-ٳکڪھۀہۃیےۓە]/g, ch => LETTER_MAP.get(ch) ?? ch)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text) {
  const normalized = normalizeArabic(text);
  return normalized ? normalized.split(' ') : [];
}

/**
 * Tokenize while remembering which whitespace-delimited raw piece each normalized token came from, so a
 * matched token span can be mapped back to the exact spoken text.
 */
export function tokenizeWithSource(text) {
  const raw = String(text ?? '').split(/\s+/).filter(Boolean);
  const tokens = [], rawIndex = [];
  raw.forEach((piece, index) => {
    for (const token of tokenize(piece)) { tokens.push(token); rawIndex.push(index); }
  });
  return { tokens, rawIndex, raw };
}

const isWeak = ch => ch === 'ا' || ch === 'و' || ch === 'ي';

/** Alif-insensitive key for words of 5+ letters (the first letter is kept). Equal keys = "exact". */
export function matchKey(token) {
  if (token.length < 5) return token;
  return token[0] + token.slice(1).replace(/ا/g, '');
}

/** Key with a leading conjunction particle (و / ف) removed; null when nothing was stripped. */
export function particleKey(key) {
  if (key.length >= 4 && (key[0] === 'و' || key[0] === 'ف')) return key.slice(1);
  return null;
}

/** Very tolerant key used only to retrieve candidates: weak letters are dropped after the first letter. */
export function skeleton(token) {
  const key = particleKey(matchKey(token)) ?? matchKey(token);
  return key[0] + key.slice(1).replace(/[اوي]/g, '');
}

// Letters ASR commonly confuses (similar sounds); substituting inside a class is cheap.
const CONFUSION = ['سصث', 'زذظض', 'تط', 'دض', 'كق', 'هح', 'عغ', 'اوي', 'نم'];
const CHEAP_PAIRS = new Set();
for (const group of CONFUSION) for (const x of group) for (const y of group) if (x !== y) CHEAP_PAIRS.add(x + y);
const cheapSub = (a, b) => CHEAP_PAIRS.has(a + b);

/** Weighted edit distance; gives up (returns Infinity) once it cannot come in at or under `limit`. */
export function editCost(a, b, limit = 1.5) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return Infinity;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j ? prev[j - 1] + (isWeak(b[j - 1]) ? 0.5 : 1) : 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1);
    cur[0] = prev[0] + (isWeak(a[i - 1]) ? 0.5 : 1);
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const sub = a[i - 1] === b[j - 1] ? 0 : (cheapSub(a[i - 1], b[j - 1]) ? 0.5 : 1);
      cur[j] = Math.min(prev[j - 1] + sub, prev[j] + (isWeak(a[i - 1]) ? 0.5 : 1), cur[j - 1] + (isWeak(b[j - 1]) ? 0.5 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > limit) return Infinity;
    prev = cur;
  }
  return prev[b.length] <= limit ? prev[b.length] : Infinity;
}

/** Maximum edit cost tolerated between two tokens, by length of the longer one. Short words must be exact. */
export function fuzzyLimit(length) {
  if (length <= 3) return 0;
  if (length <= 5) return 0.5;
  if (length <= 8) return 1;
  return 1.5;
}

/** Similarity grades returned by compareTokens. */
export const MATCH = { EXACT: 2, VARIANT: 1.6, FUZZY: 1.2, NONE: 0 };
