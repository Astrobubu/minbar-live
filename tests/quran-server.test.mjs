// Server integration: Quran citations on live segments, verified revisions, SSE, export and translation context.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verseAt, translationText } from '../lib/quran-data.mjs';

const FAKE_PORT = 4395, SERVER_PORT = 4394;
const fakeCalls = [];
let transcript = '';
const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url.includes('/audio/transcriptions')) return res.end(JSON.stringify({ text: transcript }));
  const body = JSON.parse(raw.toString() || '{}');
  const target = /into (\w+)\./.exec(body.instructions || '')?.[1];
  const input = JSON.parse(body.input);
  fakeCalls.push({ target, instructions: body.instructions, input });
  res.end(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: `[${target}] ${input.currentSegment.slice(0, 20)}` }] }] }));
});
await new Promise(r => fake.listen(FAKE_PORT, '127.0.0.1', r));
const temp = await mkdtemp(path.join(os.tmpdir(), 'minbar-quran-test-'));
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(SERVER_PORT), MINBAR_DATA_DIR: temp, OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`, APP_ACCESS_TOKEN: 'test-host-key', LOCAL_DEVELOPMENT: 'false' },
  stdio: 'pipe'
});
await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error('Server exit ' + code))); });
test.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); fake.close(); await rm(temp, { recursive: true, force: true }); });

const base = `http://127.0.0.1:${SERVER_PORT}`;
const JSONH = { 'Content-Type': 'application/json' };
const request = async (p, options = {}) => {
  const r = await fetch(base + p, options);
  return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text() };
};
const hostHeaders = token => ({ ...JSONH, Authorization: `Bearer ${token}`, 'X-Host-Key': 'test-host-key' });
const room = async (targetLanguages = ['en', 'ur']) => (await request('/api/sessions', { method: 'POST', headers: JSONH, body: JSON.stringify({ visibility: 'public', sourceLanguage: 'ar', targetLanguages }) })).data;
const post = (session, ownerToken, body) => request(`/api/sessions/${session.id}/segments`, { method: 'POST', headers: hostHeaders(ownerToken), body: JSON.stringify(body) });
const settle = async (session, id) => { for (let i = 0; i < 60; i++) { const s = (await request(`/api/sessions/${session.id}`)).data.segments.find(x => x.id === id); if (s?.translationStatus === 'done') return s; await new Promise(r => setTimeout(r, 50)); } throw new Error('translation did not settle'); };

async function events(p, done, timeout = 5000) {
  const ctl = new AbortController(), r = await fetch(base + p, { signal: ctl.signal });
  const reader = r.body.getReader(), dec = new TextDecoder(), out = [];
  let buf = '';
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    while (!done(out)) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const type = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
        if (type && data) out.push({ type, data: JSON.parse(data) });
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { clearTimeout(timer); ctl.abort(); }
  return out;
}

const KURSI_SERMON = 'وقال الله تعالى الله لا إله إلا هو الحي القيوم لا تأخذه سنه ولا نوم له ما في السموات وما في الأرض فاتقوا الله يا عباد الله';

test('a mis-transcribed Ayat al-Kursi inside a sermon sentence gets a citation with established translations, SSE, export and translation context', async () => {
  const { session, ownerToken } = await room(['en', 'ur']);
  fakeCalls.length = 0;
  const stream = events(`/api/sessions/${session.id}/events`, ev => ev.some(e => e.type === 'segment' && e.data.translationStatus === 'done'));
  await new Promise(r => setTimeout(r, 150));
  const started = performance.now();
  const posted = await post(session, ownerToken, { text: KURSI_SERMON, itemId: 'k1' });
  const elapsed = performance.now() - started;
  assert.equal(posted.status, 200);
  const [c, ...rest] = posted.data.segment.citations;
  assert.equal(rest.length, 0);
  assert.equal(c.kind, 'quran');
  assert.equal(c.reference, '2:255');
  assert.equal(c.surahName.ar, 'البقرة');
  assert.equal(c.arabic, verseAt(2, 255).arabic);
  assert.deepEqual(c.translations, { en: translationText('en', 2, 255), ur: translationText('ur', 2, 255) });
  assert.deepEqual(Object.keys(c.translationSources).sort(), ['en', 'ur']);
  assert.ok(['exact', 'approximate'].includes(c.matchType) && c.confidence > 0.7);
  assert.match(c.matchedText, /^الله لا إله إلا هو/);
  assert.ok(elapsed < 1000);

  const got = (await stream).filter(e => e.type === 'segment' && e.data.id === posted.data.segment.id);
  assert.equal(got[0].data.citations[0].reference, '2:255', 'segment event carries citations immediately');
  assert.ok((await stream).some(e => e.type === 'snapshot' && e.data.segments.some(s => s.citations?.[0]?.reference === '2:255')));

  const settled = await settle(session, posted.data.segment.id);
  assert.equal(settled.citations[0].reference, '2:255');
  // Translation calls were given the canonical verse and the established wording for that language.
  assert.equal(fakeCalls.length, 2);
  const en = fakeCalls.find(x => x.target === 'English'), ur = fakeCalls.find(x => x.target === 'Urdu');
  assert.equal(en.input.quranVerses[0].establishedTranslation, translationText('en', 2, 255));
  assert.equal(ur.input.quranVerses[0].establishedTranslation, translationText('ur', 2, 255));
  assert.equal(en.input.quranVerses[0].canonicalArabic, verseAt(2, 255).arabic);
  assert.match(en.instructions, /established English translation/);

  const txt = (await request(`/api/sessions/${session.id}/export?format=txt`)).data;
  assert.ok(txt.includes(`[Quran 2:255] ${verseAt(2, 255).arabic}`));
  assert.ok(txt.includes(`[Quran 2:255 en] ${translationText('en', 2, 255)}`));
  assert.ok(txt.includes(`[Quran 2:255 ur] ${translationText('ur', 2, 255)}`));
  const json = (await request(`/api/sessions/${session.id}/export?format=json`)).data;
  assert.equal(json.segments[0].citations[0].reference, '2:255');
});

test('non-Quran segments carry no citations and no verse context is sent to translation', async () => {
  const { session, ownerToken } = await room(['en']);
  fakeCalls.length = 0;
  const posted = await post(session, ownerToken, { text: 'علينا أن نعتني بجيراننا ونساعد المحتاجين في مجتمعنا', itemId: 'n1' });
  assert.deepEqual(posted.data.segment.citations, []);
  await settle(session, posted.data.segment.id);
  assert.equal(fakeCalls[0].input.quranVerses, undefined);
  assert.doesNotMatch(fakeCalls[0].instructions, /quranVerses/);
});

test('English rooms (translation into Arabic) never get Quran citations', async () => {
  const { session, ownerToken } = (await request('/api/sessions', { method: 'POST', headers: JSONH, body: JSON.stringify({ visibility: 'public', sourceLanguage: 'en', targetLanguages: ['ar'] }) })).data;
  const posted = await post(session, ownerToken, { text: 'God, there is no god but Him, the Living, the Self-subsisting', itemId: 'e1' });
  assert.deepEqual(posted.data.segment.citations, []);
});

test('a verse split across two live segments is cited on the second segment', async () => {
  const { session, ownerToken } = await room(['en']);
  const first = await post(session, ownerToken, { text: 'نقرأ قول الله تعالى الله لا إله إلا هو الحي القيوم لا تأخذه سنة', itemId: 's1' });
  const second = await post(session, ownerToken, { text: 'ولا نوم له ما في السماوات وما في الأرض من ذا الذي يشفع عنده إلا بإذنه', itemId: 's2', previousItemId: 's1' });
  const all = [...first.data.segment.citations, ...second.data.segment.citations];
  assert.ok(all.some(c => c.reference === '2:255'));
  assert.equal(second.data.segment.citations[0].reference, '2:255');
  assert.equal(second.data.segment.citations[0].spansPreviousSegment, true);
});

function wav(samples) {
  const data = Buffer.alloc(samples * 2), h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('double-checked revision segments are re-cited from the verified transcript and published on SSE', async () => {
  const { session, ownerToken } = await room(['en', 'ur']);
  const live = await post(session, ownerToken, { text: 'نص مباشر غير دقيق', itemId: 'v1' });
  assert.deepEqual(live.data.segment.citations, []);
  await settle(session, live.data.segment.id);
  transcript = `قال الله تعالى ${verseAt(112, 1).arabic} ${verseAt(112, 2).arabic} ${verseAt(112, 3).arabic} ${verseAt(112, 4).arabic}`;
  fakeCalls.length = 0;
  const stream = events(`/api/sessions/${session.id}/events`, ev => ev.some(e => e.type === 'revision'));
  await new Promise(r => setTimeout(r, 150));
  const verified = await request(`/api/sessions/${session.id}/verify`, { method: 'POST', headers: hostHeaders(ownerToken), body: JSON.stringify({ audioWavBase64: wav(2400).toString('base64'), itemIds: ['v1'], captureId: 'cap-1', windowStartSample: 0, windowEndSample: 2400 }) });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  const seg = verified.data.segment;
  assert.equal(seg.status, 'double-checked');
  assert.equal(seg.citations[0].reference, '112:1-4');
  assert.equal(seg.citations[0].verificationStatus, 'double-checked-source');
  assert.equal(seg.citations[0].translations.en, [1, 2, 3, 4].map(a => translationText('en', 112, a)).join(' '));
  assert.deepEqual(Object.keys(seg.citations[0].translationSources).sort(), ['en', 'ur']);
  assert.equal(fakeCalls[0].input.quranVerses[0].reference, '112:1-4', 'verified translation also receives verse context');
  const got = await stream;
  assert.equal(got.find(e => e.type === 'revision').data.segment.citations[0].reference, '112:1-4');
  assert.ok(got.some(e => e.type === 'snapshot'));
});
