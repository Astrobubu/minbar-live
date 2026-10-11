// Dev fixture for ?mockQuran=1 (see core.mjs). Lets the Quran citation UI be seen without the backend
// producing citations. Never loaded unless the flag is present in the page URL; harmless otherwise.
export const MOCK_VERSES = [
  {
    kind: 'quran', reference: '2:255', surah: 2, ayahStart: 255, ayahEnd: 255,
    surahName: { ar: 'البقرة', en: 'Al-Baqarah', meaning: 'The Cow' },
    arabic: 'ٱللَّهُ لَآ إِلَـٰهَ إِلَّا هُوَ ٱلْحَىُّ ٱلْقَيُّومُ ۚ لَا تَأْخُذُهُۥ سِنَةٌ وَلَا نَوْمٌ',
    translations: {
      en: 'Allah - there is no deity except Him, the Ever-Living, the Sustainer of [all] existence. Neither drowsiness overtakes Him nor sleep.',
      ur: 'اللہ، اس کے سوا کوئی معبود نہیں، وہ زندہ ہے، سب کو قائم رکھنے والا۔ نہ اسے اونگھ آتی ہے اور نہ نیند۔'
    },
    translationSources: { en: 'Saheeh International (Tanzil)', ur: 'Jalandhry (Tanzil)' },
    matchType: 'exact', confidence: 1
  },
  {
    kind: 'quran', reference: '94:5-6', surah: 94, ayahStart: 5, ayahEnd: 6,
    surahName: { ar: 'الشرح', en: 'Ash-Sharh', meaning: 'The Relief' },
    arabic: 'فَإِنَّ مَعَ ٱلْعُسْرِ يُسْرًا ۝ إِنَّ مَعَ ٱلْعُسْرِ يُسْرًا',
    translations: {
      en: 'For indeed, with hardship [will be] ease. Indeed, with hardship [will be] ease.',
      ur: 'پس یقیناً مشکل کے ساتھ آسانی ہے۔ بے شک مشکل کے ساتھ آسانی ہے۔'
    },
    translationSources: { en: 'Saheeh International (Tanzil)', ur: 'Jalandhry (Tanzil)' },
    matchType: 'approximate', confidence: 0.82
  },
  {
    kind: 'quran', reference: '103:1-3', surah: 103, ayahStart: 1, ayahEnd: 3,
    surahName: { ar: 'العصر', en: 'Al-Asr', meaning: 'The Declining Day' },
    arabic: 'وَٱلْعَصْرِ ۝ إِنَّ ٱلْإِنسَـٰنَ لَفِى خُسْرٍ ۝ إِلَّا ٱلَّذِينَ ءَامَنُوا۟ وَعَمِلُوا۟ ٱلصَّـٰلِحَـٰتِ وَتَوَاصَوْا۟ بِٱلْحَقِّ وَتَوَاصَوْا۟ بِٱلصَّبْرِ',
    translations: {
      en: 'By time, indeed, mankind is in loss, except for those who believe and do righteous deeds and advise each other to truth and advise each other to patience.',
      ur: 'زمانے کی قسم، بے شک انسان خسارے میں ہے، سوائے ان کے جو ایمان لائے اور نیک عمل کیے اور ایک دوسرے کو حق کی نصیحت کی اور صبر کی نصیحت کی۔'
    },
    translationSources: { en: 'Saheeh International (Tanzil)', ur: 'Jalandhry (Tanzil)' },
    matchType: 'exact', confidence: 1
  }
];

/** Adds a mock citation to every third segment (sequence % 3 === 2) that has none, cycling through the fixtures. */
export function withMockCitation(segment) {
  if (!segment || segment.citations?.length) return segment;
  const n = Number(segment.sequence);
  if (!Number.isFinite(n) || n % 3 !== 2) return segment;
  return { ...segment, citations: [MOCK_VERSES[Math.floor(n / 3) % MOCK_VERSES.length]] };
}
