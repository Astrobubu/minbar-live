// Shared-state storage: the Redis adapter (against an in-memory Redis) and two server instances sharing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRedisStore, createMemoryRedis, createFileStore, orderByLinks } from '../lib/store.mjs';

const room = (over = {}) => ({ id: 'room-1', code: 'ABC234', title: 'T', kind: 'venue', visibility: 'public', status: 'ready', sequence: 0, segments: [], recordings: [], reviewQueue: [], createdAt: new Date().toISOString(), ...over });
const seg = (id, itemId, previousItemId = null, text = id) => ({ id, itemId, previousItemId, text, translations: {}, citations: [] });

test('redis store: create/get round-trips a session and finds it by code from another store instance', async () => {
  const redis = createMemoryRedis();
  const a = createRedisStore(redis), b = createRedisStore(redis);
  await a.create(room());
  const byId = await b.get('room-1', { segments: 'none' });
  assert.equal(byId.title, 'T');
  assert.equal((await b.find('abc234')).id, 'room-1');
  assert.equal((await b.listPublic()).length, 1);
  assert.equal(await b.get('missing'), undefined);
  assert.equal(await b.get('../x'), undefined);
});

test('redis store: sequence counter and item claims are atomic across instances', async () => {
  const redis = createMemoryRedis();
  const a = createRedisStore(redis), b = createRedisStore(redis);
  const s = room();
  await a.create(s);
  const [x, y] = await Promise.all([a.nextSeq({ ...s }), b.nextSeq({ ...s })]);
  assert.deepEqual([x, y].sort(), [1, 2]);
  assert.equal(await a.claimItem(s, 'item-1', 'seg-1'), true);
  assert.equal(await b.claimItem(s, 'item-1', 'seg-2'), false);
});

test('redis store: appended segments keep order, tail loads the last few, late segments slot in by link', async () => {
  const redis = createMemoryRedis();
  const store = createRedisStore(redis);
  const s = room();
  await store.create(s);
  const live = await store.get('room-1', { segments: 'tail' });
  await store.appendSegment(live, seg('g1', 'i1'));
  await store.appendSegment(live, seg('g3', 'i3', 'i2')); // arrives before i2
  await store.appendSegment(live, seg('g2', 'i2', 'i1'));
  const all = await store.get('room-1');
  assert.deepEqual(all.segments.map(x => x.id), ['g1', 'g2', 'g3']);
  const tail = await store.get('room-1', { segments: 'tail', tail: 2 });
  assert.deepEqual(tail.segments.map(x => x.id), ['g2', 'g3']);
  await store.claimItem(s, 'i2', 'g2');
  assert.equal((await store.segmentByItem(s, 'i2')).id, 'g2');
});

test('redis store: translation writes touch only that segment and survive concurrent appends', async () => {
  const redis = createMemoryRedis();
  const store = createRedisStore(redis);
  await store.create(room());
  const live = await store.get('room-1', { segments: 'tail' });
  const first = seg('g1', 'i1');
  await store.appendSegment(live, first);
  first.translations.en = 'hello';
  await Promise.all([store.putSegment(live, first), store.appendSegment(live, seg('g2', 'i2', 'i1'))]);
  const all = await store.get('room-1');
  assert.equal(all.segments.length, 2);
  assert.equal(all.segments[0].translations.en, 'hello');
});

test('redis store: commitSegments persists a verification (replace, order, revisions) from a loaded session', async () => {
  const redis = createMemoryRedis();
  const store = createRedisStore(redis);
  await store.create(room());
  const live = await store.get('room-1', { segments: 'tail' });
  for (const [n, p] of [['1', null], ['2', 'i1'], ['3', 'i2']]) await store.appendSegment(live, seg('g' + n, 'i' + n, p));
  const s = await store.get('room-1');
  const before = store.snapshotSegments(s);
  s.segments.splice(0, 2, { id: 'v1', itemId: 'verified-1', text: 'fixed', supersedes: ['i1', 'i2'], translations: {}, citations: [] });
  s.revisions = [{ id: 'v1' }];
  await store.commitSegments(s, before);
  const after = await store.get('room-1');
  assert.deepEqual(after.segments.map(x => x.id), ['v1', 'g3']);
  assert.deepEqual(after.revisions, [{ id: 'v1' }]);
  assert.equal(await store.claimItem(s, 'i2', 'x'), false);
});

test('redis store: events are readable in order after a cursor, and an empty stream starts at 0-0', async () => {
  const store = createRedisStore(createMemoryRedis());
  assert.equal(await store.lastEventId('r'), '0-0');
  await store.pushEvent('r', { t: 'status', q: 1, d: { status: 'live' } });
  const cursor = await store.lastEventId('r');
  await store.pushEvent('r', { t: 'segment', q: 2, d: { text: 'نص' } });
  await store.pushEvent('r', { t: 'snapshot', q: 3 });
  const events = await store.readEvents('r', cursor);
  assert.deepEqual(events.map(e => e.t), ['segment', 'snapshot']);
  assert.deepEqual(events[0].d, { text: 'نص' });
  assert.equal(events[1].d, undefined);
  assert.deepEqual(await store.readEvents('r', events[1].id), []);
});

test('file store keeps working without Redis: append reorders by link and persists', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minbar-store-'));
  try {
    const store = await createFileStore(dir);
    const s = room({ code: await store.newCode() });
    await store.create(s);
    await store.appendSegment(s, seg('g2', 'i2', 'i1'));
    await store.appendSegment(s, seg('g1', 'i1'));
    assert.deepEqual(s.segments.map(x => x.id), ['g1', 'g2']);
    assert.equal(await store.claimItem(s, 'i1'), false);
    const reopened = await createFileStore(dir);
    assert.equal((await reopened.find(s.code)).segments.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('orderByLinks chains by previousItemId', () => {
  assert.deepEqual(orderByLinks([seg('b', 'b', 'a'), seg('a', 'a')]).map(x => x.id), ['a', 'b']);
});

/* ---- two server instances, one shared Redis: what a serverless deployment does ---- */

test('two server instances share rooms and live events through the shared store; OPEN_ACCESS skips host keys but not owner checks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minbar-inst-'));
  Object.assign(process.env, { MINBAR_FAKE_REDIS: '1', OPEN_ACCESS: 'true', VERCEL: '1', MINBAR_DATA_DIR: dir, OPENAI_API_KEY: '', EVENT_POLL_MS: '60', LOCAL_DEVELOPMENT: '' });
  delete process.env.APP_ACCESS_TOKEN;
  globalThis.__minbarFakeRedis = createMemoryRedis();
  const A = await import('../server.mjs?instance=a'), B = await import('../server.mjs?instance=b');
  const listen = srv => new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${srv.address().port}`)));
  const [a, b] = [await listen(A.server), await listen(B.server)];
  const controller = new AbortController();
  try {
    const config = await (await fetch(a + '/api/config')).json();
    assert.equal(config.openAccess, true);

    const created = await (await fetch(a + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Shared', visibility: 'public', sourceLanguage: 'ar', targetLanguages: ['en'] }) })).json();
    const { session, ownerToken } = created;
    // Instance B has never seen this room but serves it (by id and by code) and lists it.
    assert.equal((await (await fetch(`${b}/api/sessions/${session.id}`)).json()).title, 'Shared');
    assert.equal((await (await fetch(`${b}/api/sessions/${session.code}`)).json()).id, session.id);
    assert.equal((await (await fetch(b + '/api/sessions')).json()).sessions.length, 1);

    // Live events: listener on B, owner posts on A.
    const stream = await fetch(`${b}/api/sessions/${session.id}/events`, { signal: controller.signal });
    const reader = stream.body.getReader(), decoder = new TextDecoder();
    let seen = '';
    const waitFor = async re => { const end = Date.now() + 6000; while (Date.now() < end) { const m = seen.match(re); if (m) return m; const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ value: null }), 500))]); if (done) break; if (value) seen += decoder.decode(value); } return null; };
    assert.ok(await waitFor(/event: snapshot/), 'initial snapshot');

    const owner = { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' };
    const strangerPost = await fetch(`${a}/api/sessions/${session.id}/segments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x', itemId: 'nope' }) });
    assert.equal(strangerPost.status, 401, 'owner token still required under OPEN_ACCESS');

    const ayah = 'الله لا إله إلا هو الحي القيوم لا تأخذه سنة ولا نوم له ما في السماوات وما في الأرض';
    const posted = await fetch(`${a}/api/sessions/${session.id}/segments`, { method: 'POST', headers: owner, body: JSON.stringify({ text: ayah, itemId: 'item-1' }) });
    assert.equal(posted.status, 200);
    const event = await waitFor(/event: segment\ndata: (.*)\n/);
    assert.ok(event, 'segment event crossed instances');
    const segment = JSON.parse(event[1]);
    assert.equal(segment.itemId, 'item-1');
    assert.equal(segment.citations[0]?.surah, 2);
    assert.equal(segment.citations[0]?.ayahStart, 255);

    // The same item posted again (e.g. a retry landing on another instance) is not duplicated.
    await fetch(`${b}/api/sessions/${session.id}/segments`, { method: 'POST', headers: owner, body: JSON.stringify({ text: ayah, itemId: 'item-1' }) });
    const full = await (await fetch(`${b}/api/sessions/${session.id}`)).json();
    assert.equal(full.segments.length, 1);
    assert.equal(full.segments[0].citations[0].reference.startsWith('2:255'), true);
    assert.ok(full.sequence >= 1);

    // Ending on B reaches the listener attached to B and is visible from A.
    assert.equal((await fetch(`${b}/api/sessions/${session.id}`, { method: 'PATCH', headers: owner, body: JSON.stringify({ status: 'ended' }) })).status, 200);
    assert.ok(await waitFor(/event: status\ndata: \{"status":"ended"/), 'ended status event');
    assert.equal((await (await fetch(`${a}/api/sessions/${session.id}`)).json()).status, 'ended');
  } finally {
    controller.abort();
    await new Promise(r => setTimeout(r, 150));
    A.server.close(); B.server.close(); A.server.closeAllConnections?.(); B.server.closeAllConnections?.();
    await rm(dir, { recursive: true, force: true });
  }
});
