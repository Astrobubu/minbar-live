// Deterministic fixtures for Quran detection: noisy variants of real verses plus non-Quran sermon text.
// Verse text always comes from the Tanzil corpus, so no Arabic is hand-typed for the positives.
import { verseAt, corpus } from '../../lib/quran-data.mjs';

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Real verses (and a few runs of consecutive ayat) chosen for variety of length and topic.
export const SINGLE = ['2:152', '2:183', '2:186', '2:255', '2:286', '3:102', '3:103', '3:185', '4:1', '4:59', '5:8', '9:119', '13:28', '16:90', '17:23', '17:70',
  '18:110', '20:14', '24:35', '31:13', '33:56', '33:70', '39:53', '49:10', '49:13', '51:56', '59:18', '59:22', '62:9', '65:2', '67:2', '94:5', '99:7', '112:1'];
export const RANGES = [[112, 1, 4], [103, 1, 3], [55, 1, 4], [1, 1, 7], [2, 255, 256], [59, 22, 24]];

export function expected() {
  const items = SINGLE.map(ref => { const [s, a] = ref.split(':').map(Number); return { surah: s, from: a, to: a }; });
  for (const [surah, from, to] of RANGES) items.push({ surah, from, to });
  return items.map(item => {
    const arabic = [];
    for (let a = item.from; a <= item.to; a++) arabic.push(verseAt(item.surah, a).arabic);
    return { ...item, arabic: arabic.join(' ') };
  });
}

export const stripMarks = text => text.replace(/[ً-ٰٟۖ-ۭـ]/g, '').replace(/\s+/g, ' ').trim();

const ASR_SWAPS = [['س', 'ص'], ['ز', 'ذ'], ['ت', 'ط'], ['د', 'ض'], ['ك', 'ق'], ['ه', 'ح'], ['ع', 'غ'], ['ذ', 'ظ'], ['ث', 'س']];
const pick = (r, list) => list[Math.floor(r() * list.length)];

/** Replace one letter of a token with an ASR-confusable one, or insert/delete a weak letter. */
function corruptToken(r, token) {
  const mode = r();
  if (mode < 0.5) {
    for (let tries = 0; tries < 6; tries++) {
      const i = Math.floor(r() * token.length), [a, b] = pick(r, ASR_SWAPS);
      if (token[i] === a) return token.slice(0, i) + b + token.slice(i + 1);
      if (token[i] === b) return token.slice(0, i) + a + token.slice(i + 1);
    }
  }
  if (mode < 0.8 && token.length >= 4) { const i = 1 + Math.floor(r() * (token.length - 2)); return token.slice(0, i) + 'ا' + token.slice(i); }
  const weak = [...token].map((c, i) => 'اوي'.includes(c) && i > 0 ? i : -1).filter(i => i > 0);
  if (weak.length) { const i = pick(r, weak); return token.slice(0, i) + token.slice(i + 1); }
  const i = Math.floor(r() * token.length);
  return token.slice(0, i) + (token[i] === 'م' ? 'ن' : 'م') + token.slice(i + 1);
}

/** ASR-style modern spelling differences (not errors a detector should be penalized for). */
export function respell(r, text) {
  return text.split(' ').map(token => {
    let t = token;
    if (r() < 0.5) t = t.replace(/ة$/, 'ه');
    if (r() < 0.5) t = t.replace(/ى$/, 'ي');
    if (r() < 0.5) t = t.replace(/^[أإ]/, 'ا');
    if (r() < 0.6) t = t.replace(/^الرحمن$/, 'الرحمان').replace(/^ذلك$/, 'ذالك').replace(/^هذا$/, 'هاذا').replace(/^لكن$/, 'لاكن').replace(/^أولئك$/, 'اولائك').replace(/^إله$/, 'إلاه');
    return t;
  }).join(' ');
}

export function swapLetters(r, tokens, count) {
  const out = [...tokens];
  const eligible = out.map((t, i) => t.length >= 5 ? i : -1).filter(i => i >= 0);
  for (let n = 0; n < count && eligible.length; n++) {
    const at = eligible.splice(Math.floor(r() * eligible.length), 1)[0];
    out[at] = corruptToken(r, out[at]);
  }
  return out;
}

/** Replace one letter in some tokens with an arbitrary letter (not an ASR-style confusion). */
export function randomLetter(r, tokens, count) {
  const out = [...tokens];
  const letters = [...'بتجحدرسعفلمنهوي'];
  const eligible = out.map((t, i) => t.length >= 5 ? i : -1).filter(i => i >= 0);
  for (let n = 0; n < count && eligible.length; n++) {
    const at = eligible.splice(Math.floor(r() * eligible.length), 1)[0], i = 1 + Math.floor(r() * (out[at].length - 1));
    out[at] = out[at].slice(0, i) + pick(r, letters) + out[at].slice(i + 1);
  }
  return out;
}

export function substituteToken(r, tokens) {
  if (tokens.length < 6) return tokens;
  const out = [...tokens], at = 1 + Math.floor(r() * (tokens.length - 2));
  const other = stripMarks(corpus[Math.floor(r() * corpus.length)].arabic).split(' ');
  out[at] = pick(r, other);
  return out;
}

/** Glue two neighbouring words together or split one word, as live ASR does. */
export function gluing(r, tokens) {
  const out = [...tokens];
  const at = Math.floor(r() * (out.length - 1));
  if (r() < 0.5) out.splice(at, 2, out[at] + out[at + 1]);
  else { const t = out[at]; if (t.length >= 6) out.splice(at, 1, t.slice(0, 3), t.slice(3)); }
  return out;
}

export function dropToken(r, tokens) {
  if (tokens.length < 6) return tokens;
  const out = [...tokens];
  out.splice(1 + Math.floor(r() * (tokens.length - 2)), 1);
  return out;
}

const PREFIXES = ['قال الله تعالى في كتابه الكريم', 'وفي هذا المعنى يقول ربنا سبحانه', 'ثم تأملوا معي يا عباد الله قول ربنا', 'أيها الإخوة الكرام اسمعوا إلى قوله جل جلاله'];
const SUFFIXES = ['فاتقوا الله يا عباد الله واعملوا بما سمعتم', 'نفعني الله وإياكم بما فيه من الآيات والذكر الحكيم', 'هذا ما أردت قوله وأستغفر الله لي ولكم'];

/**
 * One case = { kind, segments: [text, ...], expect: {surah, from, to} }.
 * Segments are fed in order; segment N gets segment N-1 as its tail (as the server does).
 */
export function buildPositiveCases(seed = 20261011) {
  const cases = [];
  for (const [index, item] of expected().entries()) {
    const r = rng(seed + index * 101);
    const plain = stripMarks(item.arabic), tokens = plain.split(' ');
    const expect = { surah: item.surah, from: item.from, to: item.to };
    const verse = `${item.surah}:${item.from}${item.to > item.from ? '-' + item.to : ''}`;
    const add = (kind, segments) => cases.push({ kind, segments, expect, verse });
    add('diacritics', [item.arabic]);
    add('no-diacritics', [plain]);
    add('respelled', [respell(r, plain)]);
    add('letter-swap', [swapLetters(r, tokens, 1 + Math.floor(r() * 2)).join(' ')]);
    add('drop-token', [dropToken(r, tokens).join(' ')]);
    if (tokens.length >= 7) {
      const keep = Math.max(6, Math.ceil(tokens.length * 0.65));
      add('partial-start', [tokens.slice(0, keep).join(' ')]);
      add('partial-end', [tokens.slice(tokens.length - keep).join(' ')]);
    }
    const prefix = pick(r, PREFIXES), suffix = pick(r, SUFFIXES);
    add('embedded', [`${prefix} ${plain} ${suffix}`]);
    // Harder variants (reported separately).
    const hard = (kind, segments) => cases.push({ kind, level: 'hard', segments, expect, verse });
    if (tokens.length >= 7) {
      hard('hard-3-edits', [dropToken(r, randomLetter(r, swapLetters(r, tokens, 1), 1)).join(' ')]);
      hard('hard-2-drops', [dropToken(r, dropToken(r, tokens)).join(' ')]);
      hard('hard-word-substituted', [substituteToken(r, tokens).join(' ')]);
      hard('hard-glued-or-split', [gluing(r, tokens).join(' ')]);
      hard('hard-long-sermon', [`${SUFFIXES[0]} ${PREFIXES[1]} ${PREFIXES[3]} ${dropToken(r, tokens).join(' ')} ${SUFFIXES[1]} ${SUFFIXES[2]} ${PREFIXES[0]}`]);
    }
    if (tokens.length >= 12) {
      const a = Math.floor(tokens.length / 3), b = Math.floor((tokens.length * 2) / 3);
      hard('hard-3-segments', [tokens.slice(0, a).join(' '), tokens.slice(a, b).join(' '), tokens.slice(b).join(' ')]);
    }
    add('embedded-noisy', [`${prefix} ${dropToken(r, swapLetters(r, tokens, 1)).join(' ')} ${suffix}`]);
    if (tokens.length >= 8) {
      const cut = Math.floor(tokens.length / 2) + Math.floor(r() * 3) - 1;
      add('split-2-segments', [tokens.slice(0, cut).join(' '), tokens.slice(cut).join(' ')]);
      add('split-embedded', [`${prefix} ${tokens.slice(0, cut).join(' ')}`, `${tokens.slice(cut).join(' ')} ${suffix}`]);
    }
  }
  return cases.map(c => ({ level: 'standard', ...c }));
}

/** Negative: a real verse with its words shuffled (same vocabulary, wrong order). */
export function shuffledVerses(seed = 77, count = 30) {
  const r = rng(seed), out = [];
  while (out.length < count) {
    const tokens = stripMarks(corpus[Math.floor(r() * corpus.length)].arabic).split(' ');
    if (tokens.length < 8) continue;
    for (let i = tokens.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [tokens[i], tokens[j]] = [tokens[j], tokens[i]]; }
    out.push(tokens.join(' '));
  }
  return out;
}

// Sermon sentences that are NOT Quran quotations (formulas, hadith, paraphrase, ordinary khutbah prose).
export const NEGATIVES = [
  'الحمد لله رب العالمين والصلاة والسلام على أشرف الأنبياء والمرسلين نبينا محمد وعلى آله وصحبه أجمعين',
  'بسم الله الرحمن الرحيم',
  'أعوذ بالله من الشيطان الرجيم',
  'أشهد أن لا إله إلا الله وحده لا شريك له وأشهد أن محمدا عبده ورسوله',
  'إن الحمد لله نحمده ونستعينه ونستغفره ونعوذ بالله من شرور أنفسنا ومن سيئات أعمالنا',
  'أيها الإخوة الكرام نجتمع اليوم في هذا المسجد المبارك لنتذاكر أهمية صلة الأرحام وبر الوالدين',
  'إن من أعظم النعم التي أنعم الله بها علينا نعمة الأمن والأمان في الأوطان',
  'علينا أن نعتني بجيراننا ونساعد المحتاجين في مجتمعنا',
  'قال رسول الله صلى الله عليه وسلم إنما الأعمال بالنيات وإنما لكل امرئ ما نوى',
  'يا عباد الله اتقوا الله في السر والعلن وراقبوه في كل وقت وحين',
  'إن الصدق يهدي إلى البر وإن البر يهدي إلى الجنة وإن الكذب يهدي إلى الفجور',
  'لقد شهد الناس في هذا الأسبوع حدثا مؤثرا جمع بين أبناء الحي في مساعدة الأسر المتضررة',
  'ومن الأمور التي ينبغي لنا أن نحرص عليها في هذه الأيام المباركة كثرة الدعاء والاستغفار',
  'إن الأمة التي تحافظ على وقتها وتحسن إدارة شؤونها هي أمة قادرة على النهوض',
  'أوصيكم ونفسي بتقوى الله عز وجل فإنها وصية الله للأولين والآخرين',
  'اللهم صل وسلم وبارك على نبينا محمد وعلى آله وصحبه',
  'اللهم احفظ بلادنا وولاة أمرنا ووفقهم لما فيه خير العباد والبلاد',
  'التاجر الصدوق الأمين مع النبيين والصديقين والشهداء يوم القيامة',
  'تأملوا يا إخوة كيف كان النبي عليه الصلاة والسلام يعامل أصحابه بالرحمة واللين وحسن الخلق',
  'في هذا الزمان كثرت الفتن وتعددت مصادر الأخبار فلا بد من التثبت قبل نشر أي خبر',
  'إن الله كتب الإحسان على كل شيء فإذا قتلتم فأحسنوا القتلة وإذا ذبحتم فأحسنوا الذبحة',
  'الدنيا دار ممر والآخرة دار مقر فخذوا من ممركم لمقركم',
  'نسأل الله العظيم رب العرش العظيم أن يشفي مرضانا ويرحم موتانا',
  'أخي الكريم إذا أردت أن تنجح في حياتك فعليك أن تجعل لك هدفا واضحا وتسعى إليه بجد',
  'وقد ذكر العلماء أن للصيام فوائد كثيرة منها تهذيب النفس وتقوية الإرادة والشعور بالمحتاجين',
  'ولا يخفى عليكم أن الإنسان محتاج إلى ربه في كل أحواله وأنه ضعيف بدون عونه',
  'سنتحدث اليوم عن الأمانة وأهميتها في بناء المجتمع وعن خطر الخيانة وأثرها',
  'يجب على كل مسلم أن يتعلم أحكام دينه وأن يحرص على أداء الصلاة في وقتها',
  'إن الله جميل يحب الجمال والكبر بطر الحق وغمط الناس',
  'الصلاة عماد الدين من أقامها فقد أقام الدين ومن هدمها فقد هدم الدين',
  'وعلى المسلم أن يكون صادقا في قوله أمينا في عمله رحيما بأهله وجيرانه',
  'مرحبا بكم جميعا في مسجدنا ونسأل الله أن يتقبل منا ومنكم صالح الأعمال',
  'شهر رمضان شهر الصبر والمواساة وشهر تفتح فيه أبواب الجنة وتغلق فيه أبواب النار',
  'الذين آمنوا وعملوا الصالحات لهم عند الله مكانة عظيمة وأجر كبير فاحرصوا على العمل الصالح',
  'وكل ذلك يتطلب منا أن نتقي الله ونصلح ما بيننا ونطيع الله ورسوله في السر والعلن',
  'يا أيها الناس اتقوا الله واعلموا أن الدنيا فانية وأن العمل الصالح هو زاد المسافر',
  'الحمد لله',
  'صلى الله عليه وسلم',
  'إن الله على كل شيء قدير وهو بكل شيء عليم فلنثق بوعده',
  'يا أيها الذين آمنوا اتقوا الله',
  'والله أعلم وصلى الله على نبينا محمد وعلى آله وصحبه وسلم'
];
