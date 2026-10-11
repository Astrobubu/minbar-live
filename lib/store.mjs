// Session storage for Minbar Live.
//
// Two adapters share one interface:
//   createFileStore  - one JSON file, sessions held in memory (local dev, tests, single-process hosting).
//   createRedisStore - every session is its own set of Redis keys so any serverless instance can serve any
//                      request: nothing is cached between requests, and live events travel through a Redis
//                      stream that every instance polls (Upstash REST has no blocking subscribe).
//
// Redis layout (prefix `mb:`), all keys expire after `ttl` seconds of inactivity:
//   s:{id}  hash   session fields (each value JSON), `sequence` is a plain counter (HINCRBY)
//   g:{id}  hash   segment id -> segment JSON
//   o:{id}  list   segment ids in display order (RPUSH is atomic, so concurrent appends never lose a segment)
//   i:{id}  hash   source itemId -> segment id (HSETNX makes "already posted" checks atomic across instances)
//   q:{id}  list   review queue items (JSON)
//   e:{id}  stream live events (XADD MAXLEN ~)
//   c:{CODE} string  room code -> id          all zset, pub zset, u:{userId} set, p:{profileId} set  (indexes)
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = () => [...randomBytes(6)].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const ID_RE = /^[\w-]{1,64}$/;
const CODE_RE = /^[A-Za-z0-9]{6}$/;

/** Chain segments by their durable client item links (a late segment is placed after the one it follows). */
export function orderByLinks(segments) {
  const ordered = [], remaining = [...segments];
  let previous = null;
  while (remaining.length) {
    const index = remaining.findIndex(x => x.previousItemId === previous);
    const next = remaining.splice(index >= 0 ? index : 0, 1)[0];
    ordered.push(next);
    previous = next.itemId;
  }
  return ordered;
}

/* ------------------------------------------------------------------ file */

export async function createFileStore(dir) {
  const storePath = path.join(dir, 'sessions.json');
  let sessions = {};
  try {
    sessions = JSON.parse(await readFile(storePath, 'utf8'));
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) throw new Error('Invalid local session store.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Local session store is corrupt or inaccessible; refusing to reset it.');
  }
  let queue = Promise.resolve();
  const save = () => (queue = queue.catch(() => {}).then(async () => { await writeFile(storePath + '.tmp', JSON.stringify(sessions)); await rename(storePath + '.tmp', storePath); }));
  const byCode = code => (CODE_RE.test(code) ? Object.values(sessions).find(x => x.code === code.toUpperCase()) : undefined);
  const newCode = () => { for (;;) { const code = randomCode(); if (!Object.values(sessions).some(x => x.code === code)) return code; } };
  // Migrate sessions stored before multi-target translation: single `language` becomes targetLanguages[0].
  for (const s of Object.values(sessions)) {
    s.sourceLanguage ??= 'ar';
    if (!Array.isArray(s.targetLanguages) || !s.targetLanguages.length) s.targetLanguages = [s.language || (s.sourceLanguage === 'ar' ? 'en' : 'ar')];
    s.language = s.targetLanguages[0]; s.code ??= newCode();
    for (const x of s.segments || []) {
      x.sourceLanguage ??= s.sourceLanguage;
      if (!x.translations || typeof x.translations !== 'object') x.translations = x.translation ? { [x.language || s.language]: x.translation } : {};
      if (x.translationStatus === 'pending') x.translationStatus = 'partial';
    }
  }
  return {
    shared: false,
    kind: 'file',
    sessions, // exposed for recording retention only
    save,
    async newCode() { return newCode(); },
    async get(id) { return sessions[id]; },
    async find(idOrCode) { return sessions[idOrCode] || byCode(idOrCode); },
    async create(s) { sessions[s.id] = s; await save(); },
    async count() { return Object.keys(sessions).length; },
    async patch() { await save(); },
    nextSeq(s) { return ++s.sequence; },
    async claimItem(s, itemId) { return !s.segments.some(x => x.itemId === itemId || x.supersedes?.includes(itemId)); },
    async segmentByItem(s, itemId) { return s.segments.find(x => x.itemId === itemId || x.supersedes?.includes(itemId)); },
    async appendSegment(s, segment, reviewItems = []) { s.segments.push(segment); s.reviewQueue.push(...reviewItems); s.segments = orderByLinks(s.segments); await save(); },
    async putSegment() { await save(); },
    snapshotSegments() { return null; },
    async commitSegments() { await save(); },
    async listPublic() { return Object.values(sessions).filter(s => s.visibility === 'public' && s.kind === 'venue'); },
    async listByUser(userId) { return Object.values(sessions).filter(s => s.userId === userId); },
    async listByProfile(profileId) { return Object.values(sessions).filter(s => s.profileId === profileId && s.visibility === 'public' && s.kind === 'venue'); }
  };
}

/* ----------------------------------------------------------------- redis */

/** Minimal Upstash REST client: cmd(...args), pipeline([[...]]), multi([[...]]) (atomic MULTI/EXEC). */
export function createRestRedis({ url, token, fetchImpl = fetch, timeoutMs = 8000 }) {
  const base = url.replace(/\/+$/, '');
  async function post(route, body) {
    const response = await fetchImpl(base + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Redis ${response.status}: ${data.error || 'request failed'}`);
    return data;
  }
  const unwrap = list => list.map(x => { if (x.error) throw new Error(`Redis: ${x.error}`); return x.result; });
  return {
    async cmd(...args) { const data = await post('', args.map(String)); if (data.error) throw new Error(`Redis: ${data.error}`); return data.result; },
    async pipeline(commands) { return commands.length ? unwrap(await post('/pipeline', commands.map(c => c.map(String)))) : []; },
    async multi(commands) { return commands.length ? unwrap(await post('/multi-exec', commands.map(c => c.map(String)))) : []; }
  };
}

const flatToObject = flat => { const o = {}; for (let i = 0; i < (flat?.length || 0); i += 2) o[flat[i]] = flat[i + 1]; return o; };
const parseJson = text => { try { return JSON.parse(text); } catch { return undefined; } };

export function createRedisStore(redis, { prefix = 'mb:', ttl = 7 * 86400, now = Date.now } = {}) {
  const K = {
    meta: id => `${prefix}s:${id}`, seg: id => `${prefix}g:${id}`, ord: id => `${prefix}o:${id}`, item: id => `${prefix}i:${id}`,
    rq: id => `${prefix}q:${id}`, ev: id => `${prefix}e:${id}`, code: c => `${prefix}c:${c}`,
    all: `${prefix}all`, pub: `${prefix}pub`, user: u => `${prefix}u:${u}`, profile: p => `${prefix}p:${p}`
  };
  const sessionKeys = id => [K.meta(id), K.seg(id), K.ord(id), K.item(id), K.rq(id), K.ev(id)];
  const expireAll = id => sessionKeys(id).map(k => ['EXPIRE', k, ttl]);
  const SKIP = new Set(['segments', 'reviewQueue']);
  const metaArgs = (s, fields) => { const args = []; for (const f of fields) if (s[f] !== undefined && !SKIP.has(f)) args.push(f, JSON.stringify(s[f])); return args; };
  function parseMeta(flat) {
    if (!flat?.length) return undefined;
    const s = {};
    for (const [k, v] of Object.entries(flatToObject(flat))) { const value = parseJson(v); if (value !== undefined) s[k] = value; }
    s.segments = []; s.reviewQueue = [];
    return s;
  }
  async function loadMany(ids) {
    if (!ids.length) return [];
    return (await redis.pipeline(ids.map(id => ['HGETALL', K.meta(id)]))).map(parseMeta).filter(Boolean);
  }

  return {
    shared: true,
    kind: 'redis',
    async newCode() {
      for (let i = 0; i < 20; i++) { const code = randomCode(); if (await redis.cmd('SET', K.code(code), 'reserved', 'NX', 'EX', 600)) return code; }
      throw new Error('Could not allocate a room code.');
    },
    /** segments: 'all' | 'tail' (last `tail` segments, enough for context and ordering) | 'none'. */
    async get(id, { segments = 'all', tail = 8 } = {}) {
      if (typeof id !== 'string' || !ID_RE.test(id)) return undefined;
      const commands = [['HGETALL', K.meta(id)]];
      if (segments === 'all') commands.push(['LRANGE', K.ord(id), 0, -1], ['HGETALL', K.seg(id)], ['LRANGE', K.rq(id), 0, -1]);
      else if (segments === 'tail') commands.push(['LRANGE', K.ord(id), -tail, -1]);
      const r = await redis.pipeline(commands);
      const s = parseMeta(r[0]);
      if (!s) return undefined;
      if (segments === 'all') {
        const map = flatToObject(r[2]);
        s.segments = r[1].map(x => parseJson(map[x])).filter(Boolean);
        s.reviewQueue = r[3].map(parseJson).filter(Boolean);
      } else if (segments === 'tail' && r[1].length) {
        s.segments = (await redis.cmd('HMGET', K.seg(id), ...r[1])).map(x => (x ? parseJson(x) : undefined)).filter(Boolean);
      }
      return s;
    },
    async find(idOrCode, options) {
      if (CODE_RE.test(idOrCode)) {
        const id = await redis.cmd('GET', K.code(idOrCode.toUpperCase()));
        return id && id !== 'reserved' ? this.get(id, options) : undefined;
      }
      return this.get(idOrCode, options);
    },
    async create(s) {
      const commands = [
        ['HSET', K.meta(s.id), ...metaArgs(s, Object.keys(s))],
        ['SET', K.code(s.code), s.id, 'EX', ttl],
        ['ZREMRANGEBYSCORE', K.all, '-inf', now() - ttl * 1000],
        ['ZADD', K.all, now(), s.id],
        ...expireAll(s.id)
      ];
      if (s.visibility === 'public' && s.kind === 'venue') commands.push(['ZADD', K.pub, now(), s.id], ['ZREMRANGEBYSCORE', K.pub, '-inf', now() - ttl * 1000]);
      if (s.userId) commands.push(['SADD', K.user(s.userId), s.id], ['EXPIRE', K.user(s.userId), ttl]);
      if (s.profileId) commands.push(['SADD', K.profile(s.profileId), s.id], ['EXPIRE', K.profile(s.profileId), ttl]);
      await redis.pipeline(commands);
    },
    async count() { return Number(await redis.cmd('ZCOUNT', K.all, now() - ttl * 1000, '+inf')) || 0; },
    /** Persist only the named session fields (never the whole session: other instances may write others). */
    async patch(s, fields) {
      const args = metaArgs(s, fields);
      if (args.length) await redis.pipeline([['HSET', K.meta(s.id), ...args], ['EXPIRE', K.meta(s.id), ttl]]);
    },
    /** Atomic per-session sequence; keeps s.sequence in step. Must be awaited (returns a promise). */
    async nextSeq(s) { const n = Number(await redis.cmd('HINCRBY', K.meta(s.id), 'sequence', 1)); s.sequence = n; return n; },
    /** Atomically claim a source itemId; false when it was already posted (or superseded by a double-check). */
    async claimItem(s, itemId, segmentId) { return Number(await redis.cmd('HSETNX', K.item(s.id), itemId, segmentId)) === 1; },
    async segmentByItem(s, itemId) {
      const segmentId = await redis.cmd('HGET', K.item(s.id), itemId);
      if (!segmentId) return undefined;
      const text = await redis.cmd('HGET', K.seg(s.id), segmentId);
      return text ? parseJson(text) : undefined;
    },
    /** Append (or, if a later segment already linked to this one, insert before it) without rewriting anything else. */
    async appendSegment(s, segment, reviewItems = []) {
      const pivot = s.segments.find(x => x.previousItemId === segment.itemId);
      const commands = [['HSET', K.seg(s.id), segment.id, JSON.stringify(segment)]];
      if (reviewItems.length) commands.push(['RPUSH', K.rq(s.id), ...reviewItems.map(x => JSON.stringify(x))]);
      commands.push(...expireAll(s.id));
      let inserted = -1;
      if (pivot) { const r = await redis.pipeline([['LINSERT', K.ord(s.id), 'BEFORE', pivot.id, segment.id], ...commands]); inserted = Number(r[0]); }
      else await redis.pipeline([['RPUSH', K.ord(s.id), segment.id], ...commands]);
      if (pivot && inserted < 0) await redis.cmd('RPUSH', K.ord(s.id), segment.id);
      if (pivot && inserted >= 0) { const at = s.segments.indexOf(pivot); s.segments.splice(at, 0, segment); } else s.segments.push(segment);
      s.reviewQueue.push(...reviewItems);
    },
    /** Write one segment back (translation landed). Safe to call repeatedly; only touches that segment. */
    async putSegment(s, segment) { await redis.cmd('HSET', K.seg(s.id), segment.id, JSON.stringify(segment)); },
    snapshotSegments(s) { return { json: new Map(s.segments.map(x => [x.id, JSON.stringify(x)])), order: s.segments.map(x => x.id) }; },
    /** After a verification rewrites segments: persist changed/added/removed segments, the order, review queue and revisions atomically. */
    async commitSegments(s, before) {
      const commands = [];
      const current = new Map(s.segments.map(x => [x.id, x]));
      for (const x of s.segments) { const text = JSON.stringify(x); if (before.json.get(x.id) !== text) commands.push(['HSET', K.seg(s.id), x.id, text]); if (!before.json.has(x.id)) { commands.push(['HSET', K.item(s.id), x.itemId, x.id]); for (const item of x.supersedes || []) commands.push(['HSET', K.item(s.id), item, x.id]); } }
      const removed = [...before.json.keys()].filter(id => !current.has(id));
      if (removed.length) commands.push(['HDEL', K.seg(s.id), ...removed]);
      const order = s.segments.map(x => x.id);
      if (order.length !== before.order.length || order.some((id, i) => id !== before.order[i])) { commands.push(['DEL', K.ord(s.id)]); if (order.length) commands.push(['RPUSH', K.ord(s.id), ...order]); }
      commands.push(['DEL', K.rq(s.id)]); if (s.reviewQueue.length) commands.push(['RPUSH', K.rq(s.id), ...s.reviewQueue.map(x => JSON.stringify(x))]);
      commands.push(['HSET', K.meta(s.id), ...metaArgs(s, ['revisions', 'recordings'])], ...expireAll(s.id));
      // Keep each request well under the REST body limit.
      let batch = [], size = 0;
      for (const command of commands) { const n = command.reduce((a, x) => a + String(x).length, 0); if (batch.length && size + n > 600000) { await redis.multi(batch); batch = []; size = 0; } batch.push(command); size += n; }
      if (batch.length) await redis.multi(batch);
    },
    async listPublic(limit = 50) { return loadMany(await redis.cmd('ZREVRANGE', K.pub, 0, limit - 1)); },
    async listByUser(userId, limit = 50) { const ids = (await redis.cmd('SMEMBERS', K.user(userId))).slice(0, limit); return (await Promise.all(ids.map(id => this.get(id)))).filter(Boolean); },
    async listByProfile(profileId, limit = 50) { return (await loadMany((await redis.cmd('SMEMBERS', K.profile(profileId))).slice(0, limit))).filter(s => s.visibility === 'public' && s.kind === 'venue'); },

    /* live events */
    async pushEvent(id, event) {
      const fields = ['t', event.t, 'q', String(event.q ?? 0)];
      if (event.d !== undefined && event.d !== null) fields.push('d', JSON.stringify(event.d));
      await redis.pipeline([['XADD', K.ev(id), 'MAXLEN', '~', 400, '*', ...fields], ['EXPIRE', K.ev(id), ttl]]);
    },
    /** Id of the newest event, or '0-0' for an empty stream: the starting cursor for a new listener. */
    async lastEventId(id) { const r = await redis.cmd('XREVRANGE', K.ev(id), '+', '-', 'COUNT', 1); return r?.[0]?.[0] || '0-0'; },
    /** Events after `cursor` (exclusive), oldest first: [{id, t, q, d}]. */
    async readEvents(id, cursor, count = 200) {
      const r = await redis.cmd('XREAD', 'COUNT', count, 'STREAMS', K.ev(id), cursor);
      const entries = r?.[0]?.[1] || [];
      return entries.map(([eid, flat]) => { const f = flatToObject(flat); return { id: eid, t: f.t, q: Number(f.q) || 0, d: f.d === undefined ? undefined : parseJson(f.d) }; });
    }
  };
}

/* ----------------------------------------------- in-memory Redis (tests) */

/** Just enough of Redis, with the same cmd/pipeline/multi surface as createRestRedis, to exercise the Redis store offline. */
export function createMemoryRedis() {
  const data = new Map();
  let streamMs = 0, streamSeq = 0;
  const hash = k => { if (!data.has(k)) data.set(k, new Map()); return data.get(k); };
  const list = k => { if (!data.has(k)) data.set(k, []); return data.get(k); };
  const cmpId = (a, b) => { const [am, as] = a.split('-').map(Number), [bm, bs] = b.split('-').map(Number); return am - bm || as - bs; };
  const range = (arr, start, stop) => { const n = arr.length; let a = start < 0 ? Math.max(0, n + start) : start, b = stop < 0 ? n + stop : Math.min(stop, n - 1); return a > b ? [] : arr.slice(a, b + 1); };
  const run = (name, ...args) => {
    switch (name.toUpperCase()) {
      case 'PING': return 'PONG';
      case 'SET': { const [k, v, ...opts] = args; if (opts.includes('NX') && data.has(k)) return null; data.set(k, String(v)); return 'OK'; }
      case 'GET': return data.has(args[0]) ? data.get(args[0]) : null;
      case 'DEL': return args.reduce((n, k) => n + (data.delete(k) ? 1 : 0), 0);
      case 'EXPIRE': return data.has(args[0]) ? 1 : 0;
      case 'HSET': { const h = hash(args[0]); let n = 0; for (let i = 1; i < args.length; i += 2) { if (!h.has(args[i])) n++; h.set(args[i], String(args[i + 1])); } return n; }
      case 'HSETNX': { const h = hash(args[0]); if (h.has(args[1])) return 0; h.set(args[1], String(args[2])); return 1; }
      case 'HGET': return hash(args[0]).get(args[1]) ?? null;
      case 'HMGET': return args.slice(1).map(f => hash(args[0]).get(f) ?? null);
      case 'HGETALL': return [...hash(args[0])].flat();
      case 'HDEL': return args.slice(1).reduce((n, f) => n + (hash(args[0]).delete(f) ? 1 : 0), 0);
      case 'HINCRBY': { const h = hash(args[0]); const v = (Number(h.get(args[1])) || 0) + Number(args[2]); h.set(args[1], String(v)); return v; }
      case 'RPUSH': { const l = list(args[0]); l.push(...args.slice(1).map(String)); return l.length; }
      case 'LRANGE': return range(list(args[0]), Number(args[1]), Number(args[2]));
      case 'LINSERT': { const l = list(args[0]); const i = l.indexOf(String(args[2])); if (i < 0) return -1; l.splice(args[1].toUpperCase() === 'BEFORE' ? i : i + 1, 0, String(args[3])); return l.length; }
      case 'ZADD': { const z = hash(args[0]); z.set(String(args[2]), Number(args[1])); return 1; }
      case 'ZREMRANGEBYSCORE': { const z = hash(args[0]); const lo = args[1] === '-inf' ? -Infinity : Number(args[1]); const hi = args[2] === '+inf' ? Infinity : Number(args[2]); let n = 0; for (const [m, s] of z) if (s >= lo && s <= hi) { z.delete(m); n++; } return n; }
      case 'ZCOUNT': { const z = hash(args[0]); const lo = args[1] === '-inf' ? -Infinity : Number(args[1]); const hi = args[2] === '+inf' ? Infinity : Number(args[2]); return [...z.values()].filter(s => s >= lo && s <= hi).length; }
      case 'ZREVRANGE': return range([...hash(args[0])].sort((a, b) => b[1] - a[1]).map(x => x[0]), Number(args[1]), Number(args[2]));
      case 'SADD': { const h = hash(args[0]); let n = 0; for (const m of args.slice(1)) if (!h.has(String(m))) { h.set(String(m), 1); n++; } return n; }
      case 'SMEMBERS': return [...hash(args[0]).keys()];
      case 'XADD': { const k = args[0]; const i = args.indexOf('*'); const fields = args.slice(i + 1).map(String); const ms = Date.now(); if (ms === streamMs) streamSeq++; else { streamMs = ms; streamSeq = 0; } const id = `${streamMs}-${streamSeq}`; const l = list(k); l.push([id, fields]); const m = args.indexOf('MAXLEN'); if (m >= 0) { const max = Number(args[m + 2] === '*' ? args[m + 3] : args[m + 2]); while (l.length > max) l.shift(); } return id; }
      case 'XREVRANGE': { const l = list(args[0]); return l.length ? [l[l.length - 1]].slice(0, Number(args[4]) || 1) : []; }
      case 'XREAD': { const count = Number(args[1]); const k = args[3], cursor = args[4]; const out = list(k).filter(([id]) => cmpId(id, cursor) > 0).slice(0, count); return out.length ? [[k, out]] : null; }
      default: throw new Error(`memory redis: unsupported command ${name}`);
    }
  };
  return {
    async cmd(...args) { return run(...args.map((x, i) => (i === 0 ? x : typeof x === 'number' ? String(x) : x))); },
    async pipeline(commands) { return commands.map(c => run(...c)); },
    async multi(commands) { return commands.map(c => run(...c)); }
  };
}
