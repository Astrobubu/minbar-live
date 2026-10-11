// Supported languages. `name` is the English name (used in translation prompts),
// `nativeName` is what we show to people reading in that language.
export const LANGUAGES = [
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl' },
  { code: 'en', name: 'English', nativeName: 'English', dir: 'ltr' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو', dir: 'rtl' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', dir: 'ltr' },
  { code: 'fr', name: 'French', nativeName: 'Français', dir: 'ltr' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', dir: 'ltr' }
];
export const LANGUAGE_CODES = LANGUAGES.map(l => l.code);
export const SOURCE_LANGUAGES = ['ar', 'en'];
export const MAX_TARGETS = 4;
export const languageName = code => LANGUAGES.find(l => l.code === code)?.name || code;
export const defaultTargets = source => [source === 'ar' ? 'en' : 'ar'];

/**
 * Validate a requested target list for a room. Returns a clean array
 * (deduplicated, order preserved) or throws an Error with .status = 400.
 * `input` may be undefined/null (-> defaults), a string or an array.
 */
export function normalizeTargets(source, input) {
  if (input === undefined || input === null || input === '') return defaultTargets(source);
  const list = Array.isArray(input) ? input : [input];
  const out = [];
  for (const raw of list) {
    const code = String(raw).trim().toLowerCase();
    if (!LANGUAGE_CODES.includes(code)) throw Object.assign(new Error(`Unsupported target language "${String(raw).slice(0, 12)}".`), { status: 400 });
    if (code === source) throw Object.assign(new Error('A target language cannot be the same as the spoken language.'), { status: 400 });
    if (!out.includes(code)) out.push(code);
  }
  if (out.length < 1 || out.length > MAX_TARGETS) throw Object.assign(new Error(`Choose between 1 and ${MAX_TARGETS} target languages.`), { status: 400 });
  return out;
}
