import test from 'node:test';
import assert from 'node:assert/strict';
import { createSegmentStore, textFor, isRtl, parseRoomInput, pageUrl, qrSrc, defaultTargets, t, LANGS } from '../public/js/core.mjs';
import { STRINGS } from '../public/js/strings.mjs';

const seg = (id, extra = {}) => ({ id, itemId: 'i-' + id, text: 'src ' + id, sourceLanguage: 'ar', translations: {}, ...extra });

test('ui strings: ar and en define the same keys', () => {
  assert.deepEqual(Object.keys(STRINGS.ar).sort(), Object.keys(STRINGS.en).sort());
  assert.equal(t('targets_hint', { n: 4 }).includes('4'), true);
});

test('language helpers', () => {
  assert.equal(LANGS.length, 6);
  assert.equal(isRtl('ar') && isRtl('ur'), true);
  assert.equal(isRtl('en'), false);
  assert.deepEqual(defaultTargets('ar'), ['en']);
  assert.deepEqual(defaultTargets('en'), ['ar']);
});

test('textFor returns source for the source language, translations otherwise, never a fallback language', () => {
  const s = seg('a', { translations: { en: 'hello' } });
  assert.equal(textFor(s, 'ar'), 'src a');
  assert.equal(textFor(s, 'original'), 'src a');
  assert.equal(textFor(s, 'en'), 'hello');
  assert.equal(textFor(s, 'ur'), null);
  assert.equal(textFor({ text: 'x', sourceLanguage: 'ar', language: 'en', translation: 'legacy' }, 'en'), 'legacy');
});

test('segment store merges updates idempotently and handles revisions', () => {
  const store = createSegmentStore();
  let notifications = 0;
  store.onChange(() => notifications++);
  store.applySnapshot({ segments: [seg('a'), seg('b')] });
  store.applySegment(seg('c'));
  store.applySegment(seg('c', { translations: { en: 'C-en' } }));
  store.applySegment(seg('c', { translations: { ur: 'C-ur' } }));
  store.applySegment(seg('c', { translations: { en: 'C-en' } }));
  assert.deepEqual(store.segments.map(s => s.id), ['a', 'b', 'c']);
  assert.deepEqual(store.segments[2].translations, { en: 'C-en', ur: 'C-ur' });
  store.applyRevision({ segment: seg('v', { itemId: 'verified-1', supersedes: ['i-b', 'i-c'] }), supersedes: ['i-b', 'i-c'] });
  assert.deepEqual(store.segments.map(s => s.id), ['a', 'v']);
  // late translation for a superseded segment must not resurrect it
  store.applySegment(seg('b', { translations: { en: 'late' } }));
  assert.deepEqual(store.segments.map(s => s.id), ['a', 'v']);
  assert.ok(notifications > 4);
  // a snapshot containing the revision keeps superseded ids blocked
  store.applySnapshot({ segments: [seg('a'), seg('v', { itemId: 'verified-1', supersedes: ['i-b', 'i-c'] })] });
  store.applySegment(seg('c'));
  assert.deepEqual(store.segments.map(s => s.id), ['a', 'v']);
});

test('segment store tracks the live draft and clears it when the final segment lands', () => {
  const store = createSegmentStore();
  store.applyPartial({ itemId: 'i-a', text: 'draft…' });
  assert.deepEqual(store.partial, { itemId: 'i-a', text: 'draft…' });
  store.applySegment(seg('a'));
  assert.equal(store.partial, null);
  store.applyPartial({ itemId: 'i-b', text: 'more' });
  store.applyPartial({ itemId: 'i-b', text: '', cleared: true });
  assert.equal(store.partial, null);
});

test('url helpers', () => {
  assert.equal(pageUrl('screen', 'r1', { lang: 'en', source: true, none: undefined }, { base: null }), '/screen.html?room=r1&lang=en&source=1');
  assert.equal(pageUrl('listen', 'r1', {}, { base: 'http://x.test' }), 'http://x.test/listen.html?room=r1');
  assert.throws(() => pageUrl('nope', 'r1', {}, { base: null }));
  assert.match(qrSrc('r1', 'http://x.test/listen.html?room=r1'), /^\/api\/sessions\/r1\/qr\?url=http/);
  assert.equal(parseRoomInput(' abc234 '), 'ABC234');
  assert.equal(parseRoomInput('http://h/listen.html?room=ABC234'), 'ABC234');
  assert.equal(parseRoomInput('x 123e4567-e89b-12d3-a456-426614174000 y'), '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(parseRoomInput('nope!'), '');
});

test('registerStrings: page-local strings resolve through t() with ar -> en fallback and {vars}', async () => {
  const { registerStrings } = await import('../public/js/core.mjs');
  assert.equal(t('page_only_key'), 'page_only_key');
  registerStrings({ en: { page_only_key: 'Hello {name}', en_only_key: 'English only' }, ar: { page_only_key: 'مرحبا {name}' } });
  assert.equal(t('page_only_key', { name: 'Sam' }), 'Hello Sam'); // node has no navigator.language -> en
  assert.equal(t('en_only_key'), 'English only');
  assert.equal(t('app_name'), STRINGS.en.app_name); // shared keys still work
});
