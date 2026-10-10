import { readFileSync } from 'node:fs';
export function normalizeArabic(text) {
  return text.normalize('NFKC').replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g, '').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
}
export function parseCorpus(text) {
  return text.split(/\r?\n/).filter(line=>/^\d+\|\d+\|/.test(line)).map(line=>{const [surah,ayah,...parts]=line.split('|');return {reference:`${surah}:${ayah}`,arabic:parts.join('|')};});
}
let corpus=[];
try { corpus=parseCorpus(readFileSync(new URL('../data/quran-simple.txt',import.meta.url),'utf8')); } catch {}
export const quranAvailable=corpus.length===6236;
const index=new Map();
for(const verse of corpus){verse.tokens=normalizeArabic(verse.arabic).split(' ');for(let i=0;i<=verse.tokens.length-5;i++){const gram=verse.tokens.slice(i,i+5).join(' ');const entries=index.get(gram)||[];entries.push(verse);index.set(gram,entries);}}
export function matchQuran(text, customCorpus) {
  const tokens=normalizeArabic(text).split(' ');if(tokens.length<5)return [];
  const lookup=customCorpus?null:index;const matches=new Map();
  for(let i=0;i<=tokens.length-5;i++){
    const phrase=tokens.slice(i,i+5).join(' ');
    const candidates=lookup?lookup.get(phrase)||[]:customCorpus.filter(v=>normalizeArabic(v.arabic).includes(phrase));
    const unique=[...new Map(candidates.map(v=>[v.reference,v])).values()];
    // Ambiguous repeated phrases remain unannotated. Exact lexical evidence only.
    if(unique.length===1){const verse=unique[0];matches.set(verse.reference,{kind:'quran',reference:verse.reference,arabic:verse.arabic,sourceUrl:`https://tanzil.net/#${verse.reference}`,confidence:1,matchType:'exact-normalized-phrase',matchedPhrase:phrase,evidence:{normalizedTokenStart:i,normalizedTokenEnd:i+5,tokenCount:5}});}
  }
  return [...matches.values()];
}
export function hadithReview(text) {
  return /(?:قال رسول|قال النبي|حديث|رواه|عن النبي)/u.test(text)?[{kind:'hadith',status:'needs-review',text,reason:'Hadith wording detected; authoritative corpus and human verification required.'}]:[];
}

