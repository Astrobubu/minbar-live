import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeTargets, LANGUAGES } from '../lib/languages.mjs';
import { translateAll } from '../lib/translation.mjs';
import { translationInstructions } from '../lib/openai.mjs';
import { applyVerifiedWindow } from '../lib/revisions.mjs';

test('normalizeTargets defaults, dedupes and validates', () => {
  assert.deepEqual(normalizeTargets('ar', undefined), ['en']);
  assert.deepEqual(normalizeTargets('en', null), ['ar']);
  assert.deepEqual(normalizeTargets('ar', ['en', 'ur', 'en']), ['en', 'ur']);
  assert.deepEqual(normalizeTargets('en', 'ar'), ['ar']);
  assert.throws(() => normalizeTargets('ar', ['ar']), { status: 400 });
  assert.throws(() => normalizeTargets('ar', ['xx']), { status: 400 });
  assert.throws(() => normalizeTargets('ar', []), { status: 400 });
  assert.throws(() => normalizeTargets('ar', ['en', 'ur', 'id', 'fr', 'tr']), { status: 400 });
  assert.equal(normalizeTargets('ar', ['en', 'ur', 'id', 'fr']).length, 4);
  assert.deepEqual(LANGUAGES.map(l => l.code), ['ar', 'en', 'ur', 'id', 'fr', 'tr']);
});

test('translation prompt names languages properly and covers sermon content', () => {
  const text = translationInstructions('ar', 'ur');
  assert.match(text, /from Arabic into Urdu/);
  assert.match(text, /Quran/);
  assert.match(text, /hadith/);
  assert.match(translationInstructions('en', 'id'), /from English into Indonesian/);
});

test('translateAll fans out in parallel, reports each language as it settles and tolerates failures', async () => {
  const seen = [];
  let active = 0, peak = 0;
  const translate = async (text, lang) => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, lang === 'ur' ? 40 : 5));
    active--;
    if (lang === 'fr') throw new Error('boom');
    return `${lang}:${text}`;
  };
  const out = await translateAll({ text: 'hi', targets: ['ur', 'en', 'fr'], sourceLanguage: 'ar', translate, onResult: (lang, r, remaining) => seen.push([lang, Boolean(r.text), remaining]) });
  assert.equal(peak, 3);
  assert.deepEqual(out.translations, { ur: 'ur:hi', en: 'en:hi' });
  assert.equal(out.errors.fr, 'boom');
  assert.equal(seen.at(-1)[0], 'ur');
  assert.equal(seen.at(-1)[2], 0);
  assert.equal(seen[0][2], 2);
});

test('verified revisions carry translations for every target and keep translation = first target', () => {
  const session = { language: 'en', targetLanguages: ['en', 'ur'], sourceLanguage: 'ar', sequence: 1, segments: [{ itemId: 'a', text: 'old' }] };
  const seg = applyVerifiedWindow(session, { itemIds: ['a'], text: 'new', translations: { en: 'new en', ur: 'new ur' }, citations: [], windowStartSample: 0, windowEndSample: 240, revisionId: 'r1', createdAt: 'now' });
  assert.deepEqual(seg.translations, { en: 'new en', ur: 'new ur' });
  assert.equal(seg.translation, 'new en');
  assert.equal(seg.sourceLanguage, 'ar');
});

// ---- server integration with a fake OpenAI backend (OPENAI_BASE_URL) ----
const fakeCalls = [];
const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const target = /into (\w+)\./.exec(body.instructions || '')?.[1];
  const input = JSON.parse(body.input);
  fakeCalls.push({ target, instructions: body.instructions, input });
  await new Promise(r => setTimeout(r, target === 'Urdu' ? 250 : 60));
  if (target === 'French') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":"fail"}'); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: `[${target}] ${input.currentSegment}` }] }] }));
});
await new Promise(r => fake.listen(4399, '127.0.0.1', r));
const temp = await mkdtemp(path.join(os.tmpdir(), 'minbar-ml-test-'));
const port = 4398;
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(port), MINBAR_DATA_DIR: temp, OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'http://127.0.0.1:4399/v1', APP_ACCESS_TOKEN: 'test-host-key', LOCAL_DEVELOPMENT: 'false' },
  stdio: 'pipe'
});
await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error('Server exit ' + code))); });
const base = `http://127.0.0.1:${port}`;
const request = async (p, options = {}) => {
  const r = await fetch(base + p, options);
  const type = r.headers.get('content-type') || '';
  return { status: r.status, data: type.includes('json') ? await r.json() : await r.text() };
};
const JSONH = { 'Content-Type': 'application/json' };
const create = body => request('/api/sessions', { method: 'POST', headers: JSONH, body: JSON.stringify({ visibility: 'public', ...body }) });
const post = (session, ownerToken, body) => request(`/api/sessions/${session.id}/segments`, { method: 'POST', headers: { ...JSONH, Authorization: `Bearer ${ownerToken}`, 'X-Host-Key': 'test-host-key' }, body: JSON.stringify(body) });
test.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); fake.close(); await rm(temp, { recursive: true, force: true }); });

/** Read SSE events until done(events) is true or the timeout hits. */
async function sse(p, done, timeout = 5000) {
  const ctl = new AbortController();
  const r = await fetch(base + p, { signal: ctl.signal });
  const reader = r.body.getReader(), dec = new TextDecoder(), events = [];
  let buf = '';
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    while (!done(events)) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const type = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
        if (type && data) events.push({ type, data: JSON.parse(data) });
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
  finally { clearTimeout(timer); ctl.abort(); }
  return events;
}

test('POST /api/sessions validates targetLanguages and sets defaults', async () => {
  const multi = await create({ sourceLanguage: 'ar', targetLanguages: ['en', 'ur'] });
  assert.equal(multi.status, 201);
  assert.deepEqual(multi.data.session.targetLanguages, ['en', 'ur']);
  assert.equal(multi.data.session.language, 'en');
  assert.equal(multi.data.session.translationEnabled, true);
  assert.match(multi.data.session.code, /^[A-Z2-9]{6}$/);
  assert.deepEqual((await create({ sourceLanguage: 'ar' })).data.session.targetLanguages, ['en']);
  assert.deepEqual((await create({ sourceLanguage: 'en' })).data.session.targetLanguages, ['ar']);
  assert.deepEqual((await create({ sourceLanguage: 'en', language: 'ar' })).data.session.targetLanguages, ['ar']);
  for (const bad of [['ar'], ['zz'], [], ['en', 'ur', 'id', 'fr', 'tr']]) assert.equal((await create({ sourceLanguage: 'ar', targetLanguages: bad })).status, 400, JSON.stringify(bad));
  assert.equal((await create({ sourceLanguage: 'en', targetLanguages: ['en'] })).status, 400);
});

test('/api/config lists languages with native names', async () => {
  const { data } = await request('/api/config');
  const ur = data.languages.find(l => l.code === 'ur');
  assert.equal(ur.name, 'Urdu');
  assert.equal(ur.nativeName, 'اردو');
  assert.equal(ur.dir, 'rtl');
  assert.equal(data.languages.length, 6);
});

test('final segment publishes source immediately, then same-id updates fill every target translation', async () => {
  const { data: { session, ownerToken } } = await create({ sourceLanguage: 'ar', targetLanguages: ['en', 'ur', 'id'] });
  fakeCalls.length = 0;
  const events = sse(`/api/sessions/${session.id}/events`, ev => ev.some(e => e.type === 'segment' && e.data.translationStatus === 'done'));
  await new Promise(r => setTimeout(r, 150));
  const posted = await post(session, ownerToken, { text: 'الحمد لله', itemId: 'item-1' });
  assert.equal(posted.status, 200);
  const seg = posted.data.segment;
  assert.equal(seg.text, 'الحمد لله');
  assert.equal(seg.sourceLanguage, 'ar');
  assert.equal(seg.translationStatus, 'pending');
  assert.deepEqual(seg.translations, {});
  const got = (await events).filter(e => e.type === 'segment' && e.data.id === seg.id);
  assert.equal(got[0].data.translationStatus, 'pending');
  const last = got.at(-1).data;
  assert.equal(last.translationStatus, 'done');
  assert.deepEqual(last.translations, { en: '[English] الحمد لله', ur: '[Urdu] الحمد لله', id: '[Indonesian] الحمد لله' });
  assert.equal(last.translation, '[English] الحمد لله');
  // English (fast) arrives before Urdu (slow): per-language updates
  const order = got.filter(e => e.data.translations.en || e.data.translations.ur).map(e => Object.keys(e.data.translations).join(','));
  assert.ok(order[0].includes('en') && !order[0].includes('ur'));
  assert.deepEqual(fakeCalls.map(c => c.target).sort(), ['English', 'Indonesian', 'Urdu']);
  const detail = await request(`/api/sessions/${session.id}`);
  assert.deepEqual(detail.data.segments[0].translations, last.translations);
  const txt = await request(`/api/sessions/${session.id}/export?format=txt`);
  assert.match(txt.data, /\[en\] \[English\]/);
  assert.match(txt.data, /\[ur\] \[Urdu\]/);
  assert.match(txt.data, /\[id\] \[Indonesian\]/);
  const json = await request(`/api/sessions/${session.id}/export?format=json`);
  assert.equal(json.data.segments[0].translations.ur, '[Urdu] الحمد لله');
});

test('a failing target leaves the source visible and marks the segment partial', async () => {
  const { data: { session, ownerToken } } = await create({ sourceLanguage: 'ar', targetLanguages: ['en', 'fr'] });
  const events = sse(`/api/sessions/${session.id}/events`, ev => ev.some(e => e.type === 'segment' && e.data.translationStatus === 'partial'));
  await new Promise(r => setTimeout(r, 150));
  await post(session, ownerToken, { text: 'السلام عليكم', itemId: 'x' });
  const final = (await events).filter(e => e.type === 'segment').at(-1).data;
  assert.equal(final.translationStatus, 'partial');
  assert.deepEqual(final.translations, { en: '[English] السلام عليكم' });
  assert.equal(final.text, 'السلام عليكم');
});

test('translation cannot be toggled by non-owners; owners still can', async () => {
  const { data: { session, ownerToken } } = await create({ sourceLanguage: 'ar' });
  const p = `/api/sessions/${session.id}/translation`;
  assert.equal((await request(p, { method: 'POST', headers: JSONH, body: JSON.stringify({ enabled: true }) })).status, 401);
  assert.equal((await request(p, { method: 'POST', headers: JSONH, body: JSON.stringify({ enabled: false }) })).status, 401);
  assert.equal((await request(p, { method: 'POST', headers: { ...JSONH, Authorization: 'Bearer wrong' }, body: JSON.stringify({ enabled: false }) })).status, 401);
  assert.equal((await request(`/api/sessions/${session.id}`)).data.translationEnabled, true);
  const off = await request(p, { method: 'POST', headers: { ...JSONH, Authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ enabled: false }) });
  assert.equal(off.status, 200);
  assert.equal(off.data.translationEnabled, false);
});

test('rooms resolve by 6-character code and static files support byte ranges', async () => {
  const { data: { session } } = await create({ sourceLanguage: 'ar' });
  assert.equal((await request(`/api/sessions/${session.code.toLowerCase()}`)).data.id, session.id);
  const r = await fetch(base + '/js/strings.mjs', { headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 10);
});
