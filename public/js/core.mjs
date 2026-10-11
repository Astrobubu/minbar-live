// Minbar shared client core (ES module, no build step).
//
//   import { api, subscribe, createSegmentStore, t, LANGS, ... } from '/js/core.mjs';
//
// Sections: languages, i18n, room storage, api, live events (SSE), segment store, URLs, small utils.

import { STRINGS } from './strings.mjs';

// Dev flag: ?mockQuran=1 injects fixture Quran citations client-side (public/js/mock-quran.mjs) so the verse UI can be
// reviewed without the backend producing citations. Harmless without the flag: the module is never loaded.
const MOCK_QURAN = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mockQuran') === '1';
const mock = MOCK_QURAN ? await import('./mock-quran.mjs') : null;
const mockify = seg => (mock ? mock.withMockCitation(seg) : seg);

/* ------------------------------------------------------------------ languages */

/** Supported languages. `name` = English name, `nativeName` = shown to readers of that language. */
export const LANGS = [
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl' },
  { code: 'en', name: 'English', nativeName: 'English', dir: 'ltr' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو', dir: 'rtl' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', dir: 'ltr' },
  { code: 'fr', name: 'French', nativeName: 'Français', dir: 'ltr' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', dir: 'ltr' }
];
/** Languages a khatib can speak in. */
export const SOURCE_LANGS = ['ar', 'en'];
export const MAX_TARGETS = 4;
export const langMeta = code => LANGS.find(l => l.code === code) || { code, name: code, nativeName: code, dir: 'ltr' };
/** Display name of a language in its own script (default) or English. */
export const langName = (code, { native = true } = {}) => { const l = langMeta(code); return native ? l.nativeName : l.name; };
/** True for right-to-left languages (ar, ur). Use for caption direction. */
export const isRtl = code => langMeta(code).dir === 'rtl';
/** 'rtl' | 'ltr' for a language code, for use in dir="" attributes. */
export const dirOf = code => langMeta(code).dir;
/** Default target list for a source language: ['en'] for ar, ['ar'] for en. */
export const defaultTargets = source => [source === 'ar' ? 'en' : 'ar'];

/**
 * Text of a segment in `lang`: the original text when lang is the segment's source language
 * (or the literal 'source'/'original'), otherwise translations[lang], or null when that
 * translation has not arrived (yet). Never falls back to a different language.
 */
export function textFor(segment, lang) {
  if (!segment) return null;
  if (lang === 'source' || lang === 'original' || lang === segment.sourceLanguage) return segment.text ?? null;
  const own = segment.translations?.[lang];
  if (own) return own;
  // Rooms created before multi-target translation only have `translation` (in segment.language).
  if (!segment.translations && segment.translation && lang === segment.language) return segment.translation;
  return null;
}

/* ------------------------------------------------------------ quran citations */

/**
 * Quran citations of a segment (defensive: absent/empty on old segments, old exact matches carry only
 * {kind, reference, arabic, confidence}). Returns at most `max` entries.
 */
export const quranCitations = (segment, max = 2) =>
  (Array.isArray(segment?.citations) ? segment.citations : []).filter(c => c && c.kind === 'quran' && (c.arabic || c.reference)).slice(0, max);

/**
 * View model for one citation in the reading language `lang` (a target code, or 'source'/'original'/'ar' for none).
 * { reference, name, label, arabic, translation, source, approximate }   (labelLang 'ar' puts the Arabic surah name first)
 *   label       'Al-Baqarah 2:255 · البقرة' (both names) or just the reference when the surah name is unknown
 *   translation citation.translations[lang], else `fallback` (e.g. the segment's own translation), else ''
 */
export function verseView(citation, lang, fallback = '', labelLang = 'en') {
  const c = citation || {};
  const names = c.surahName || {};
  const ref = String(c.reference || '');
  const label = labelLang === 'ar' && names.ar ? `${names.ar} ${ref}`
    : names.en && names.ar ? `${names.en} ${ref} · ${names.ar}` : names.en ? `${names.en} ${ref}` : names.ar ? `${names.ar} ${ref}` : ref;
  const wantsTranslation = lang && lang !== 'source' && lang !== 'original' && lang !== 'ar';
  const own = wantsTranslation ? c.translations?.[lang] : '';
  return {
    reference: ref, name: names, label, arabic: c.arabic || '',
    translation: wantsTranslation ? (own || fallback || '') : '',
    source: own ? (c.translationSources?.[lang] || '') : '',
    approximate: c.matchType === 'approximate'
  };
}

/* ---------------------------------------------------------------------- icons + dom */

// Simple 1.5px-stroke icons on a 24px grid. Use icon('share') for an SVG string, or <i data-icon="share"></i> in HTML
// (filled in by applyUiLang()/hydrateIcons()).
const ICON_PATHS = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>',
  wave: '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/>',
  more: '<circle class="dot" cx="5" cy="12" r="1.5"/><circle class="dot" cx="12" cy="12" r="1.5"/><circle class="dot" cx="19" cy="12" r="1.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  download: '<path d="M12 4v11M8 11l4 4 4-4M5 20h14"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  speaker: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  arrowdown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  home: '<path d="M4 11l8-7 8 7M6 10v10h12V10"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'
};
/** SVG markup for a named icon (inherits colour via currentColor). */
export const icon = (name, size) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"${size ? ` width="${size}" height="${size}"` : ''}>${ICON_PATHS[name] || ''}</svg>`;
/** Replace every <i data-icon="name"> under `root` with its SVG. Idempotent. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]:empty')) el.innerHTML = icon(el.dataset.icon, el.dataset.size);
}
/** Tiny element builder: h('p', {class:'x', text:'hi', onclick}, ...children). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false));
  return el;
}

/* ----------------------------------------------------------------------- i18n */

const UI_LANG_KEY = 'minbar-ui-lang';
const uiListeners = new Set();
let uiLang = null;
const safeGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

/** Current UI language: 'ar' | 'en'. Persisted; defaults to the browser language. */
export function getUiLang() {
  if (uiLang) return uiLang;
  const saved = safeGet(UI_LANG_KEY);
  uiLang = saved === 'ar' || saved === 'en' ? saved : (navigator.language || '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
  return uiLang;
}

// Page-local strings added with registerStrings(); they win over the shared table for the same key.
const EXTRA = { ar: {}, en: {} };
/**
 * Register strings only one page needs, so t() and data-i18n="key" resolve them like shared ones:
 *   registerStrings({ en: { my_key: 'Hello {name}' }, ar: { my_key: 'مرحبا {name}' } });
 * Call it at module load, before the first applyUiLang(). A key missing in `ar` falls back to `en`.
 */
export function registerStrings(tables = {}) {
  for (const lang of ['ar', 'en']) Object.assign(EXTRA[lang], tables[lang] || {});
}

/**
 * Translate a UI string key. Falls back ar -> en -> the key itself. `vars` fills {placeholders}.
 * t('targets_hint', {n: 4})
 */
export function t(key, vars) {
  const lang = getUiLang();
  let s = EXTRA[lang]?.[key] ?? STRINGS[lang]?.[key] ?? EXTRA.en[key] ?? STRINGS.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return s;
}

/**
 * Apply the UI language to the document: sets <html lang dir> and fills every element carrying
 *   data-i18n="key"                 -> textContent
 *   data-i18n-placeholder="key"     -> placeholder attribute
 *   data-i18n-title="key"           -> title attribute
 *   data-i18n-aria-label="key"      -> aria-label attribute
 * Safe to call repeatedly (e.g. after rendering new DOM: applyUiLang(container)).
 */
export function applyUiLang(root = document) {
  const lang = getUiLang();
  const html = document.documentElement;
  html.lang = lang;
  html.dir = lang === 'ar' ? 'rtl' : 'ltr';
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  hydrateIcons(root);
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
  }
}

/** Switch UI language ('ar'|'en'), persist, re-apply to the document and notify onUiLangChange listeners. */
export function setUiLang(lang) {
  uiLang = lang === 'ar' ? 'ar' : 'en';
  safeSet(UI_LANG_KEY, uiLang);
  applyUiLang();
  for (const fn of uiListeners) { try { fn(uiLang); } catch { /* listener error */ } }
  return uiLang;
}
/** Register a callback fired after setUiLang(). Returns an unsubscribe function. Use it to re-render dynamic text. */
export function onUiLangChange(fn) { uiListeners.add(fn); return () => uiListeners.delete(fn); }

/* ------------------------------------------------------------- room storage */

// localStorage['minbar-rooms'] = { [roomId]: { ownerToken?, title?, code?, sourceLanguage?, targetLanguages?, visibility?, createdAt, updatedAt } }
// (Same key/shape the old app used: older entries are just {ownerToken}.)
const ROOMS_KEY = 'minbar-rooms';
const readRooms = () => { try { const v = JSON.parse(safeGet(ROOMS_KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const writeRooms = rooms => safeSet(ROOMS_KEY, JSON.stringify(rooms));

/** Stored record for a room on this device, or null. */
export const getRoom = id => readRooms()[id] || null;
/** Merge `patch` into the stored record for a room (creates it). Returns the merged record. */
export function saveRoom(id, patch = {}) {
  const rooms = readRooms(), now = Date.now();
  rooms[id] = { ...rooms[id], ...patch, createdAt: rooms[id]?.createdAt || now, updatedAt: now };
  writeRooms(rooms);
  return rooms[id];
}
/** Forget a room on this device. */
export function removeRoom(id) { const rooms = readRooms(); delete rooms[id]; writeRooms(rooms); }
/** Rooms stored on this device as [{id, ...record}], most recently updated first. */
export const listRooms = () => Object.entries(readRooms()).map(([id, r]) => ({ id, ...r })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
/** Owner token for a room, or '' when this device did not create it. */
export const ownerToken = id => getRoom(id)?.ownerToken || '';

/* ----------------------------------------------------------------------- api */

const HOST_KEY_STORAGE = 'minbar-host-key'; // set manually when the server is not in local-development mode
// Routes that need host access (local-development cookie or host key), beyond owner authorization.
const HOST_GATED = /\/api\/sessions\/[\w-]+\/(realtime|audio|audio-live|partials|segments|verify|insights)$/;
let localAccess = null;

/** True when the page was opened through a loopback host (localhost / 127.0.0.1 / ::1). */
export const isLoopbackHost = (host = location.hostname) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) || host.endsWith('.localhost');
/** True for a LAN-style host (IP literal, *.local, bare hostname): a different device or address than "this computer". */
export const isLanHost = (host = location.hostname) => !isLoopbackHost(host) && (/^[\d.]+$/.test(host) || host.includes(':') || host.endsWith('.local') || !host.includes('.'));
/** "http://localhost:PORT" for this server, for telling the operator where to open the console. */
export const localConsoleUrl = () => `http://localhost${location.port ? `:${location.port}` : ''}`;

/**
 * Ensure the loopback operator cookie exists (POST /api/local-access once per page load).
 * Only attempted when the server reports localDevelopmentAvailable AND the page is on a loopback host
 * (the server refuses anything else with 403). Resolves true when granted, false otherwise; never throws.
 */
export function ensureLocalAccess() {
  localAccess ??= (async () => {
    if (!isLoopbackHost()) return false;
    try {
      const cfg = await getConfig();
      if (!cfg?.localDevelopmentAvailable) return false;
      const r = await fetch('/api/local-access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return r.ok;
    } catch { return false; }
  })();
  return localAccess;
}

/**
 * Call the Minbar API and return parsed JSON (or text for non-JSON responses such as TXT export).
 *   api('/api/sessions', {method: 'POST', body: {title, sourceLanguage, targetLanguages}})
 *   api(`/api/sessions/${id}/segments`, {method: 'POST', body: {...}, owner: id})
 * - body: plain object -> JSON; string/Blob/ArrayBuffer/FormData sent as-is (set `headers` yourself).
 * - owner: roomId -> attaches `Authorization: Bearer <stored owner token>` for that room.
 * - Host-gated routes (realtime, audio, segments, ...) trigger ensureLocalAccess() first, and send
 *   X-Host-Key when one is saved in localStorage['minbar-host-key'].
 * Throws Error(serverMessage) with `.status` (HTTP status) on non-2xx; network failures throw too.
 */
export async function api(path, { method = 'GET', body, owner, headers = {}, signal } = {}) {
  const h = { ...headers };
  if (owner) { const token = ownerToken(owner); if (token) h.Authorization = `Bearer ${token}`; }
  if (HOST_GATED.test(path.split('?')[0])) {
    await ensureLocalAccess();
    const key = safeGet(HOST_KEY_STORAGE);
    if (key) h['X-Host-Key'] = key;
  }
  let payload = body;
  if (body !== undefined && body !== null && typeof body === 'object' && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) && !(body instanceof FormData)) {
    payload = JSON.stringify(body);
    h['Content-Type'] ||= 'application/json';
  }
  let res;
  try { res = await fetch(path, { method, headers: h, body: payload, signal }); }
  catch (e) { throw Object.assign(new Error(e?.name === 'AbortError' ? 'Request cancelled.' : 'Network error. Check your connection.'), { status: 0, cause: e }); }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throw Object.assign(new Error((isJson && data?.error) || `Request failed (${res.status}).`), { status: res.status });
  return data;
}

let configPromise = null;
/** Cached GET /api/config: {languages, sourceLanguages, maxTargets, publicBaseUrl, liveAvailable, localDevelopmentAvailable, ...}. */
/** True when the server runs with OPEN_ACCESS: no host key and no localhost-only operator gate. */
export const isOpenAccess = async () => Boolean((await getConfig().catch(() => null))?.openAccess);
export const getConfig = () => (configPromise ??= api('/api/config').catch(e => { configPromise = null; throw e; }));

/** Fetch a room by id OR 6-character room code. Sends the owner token when this device has one. Returns the session (with .id). */
export const getSession = idOrCode => api(`/api/sessions/${encodeURIComponent(idOrCode)}`, { owner: idOrCode });

/**
 * Create a room and remember its owner token on this device.
 *   createRoom({title, sourceLanguage:'ar', targetLanguages:['en','ur'], visibility:'public'|'private'})
 * Returns {session, ownerToken}.
 */
export async function createRoom({ title, sourceLanguage = 'ar', targetLanguages, visibility = 'public', ...rest } = {}) {
  const created = await api('/api/sessions', { method: 'POST', body: { title, sourceLanguage, targetLanguages, visibility, kind: 'venue', ...rest } });
  const s = created.session;
  saveRoom(s.id, { ownerToken: created.ownerToken, title: s.title, code: s.code, sourceLanguage: s.sourceLanguage, targetLanguages: s.targetLanguages, visibility: s.visibility });
  return created;
}

/* ------------------------------------------------------------ live events (SSE) */

/**
 * Subscribe to a room's Server-Sent Events with automatic reconnect (exponential backoff, and an
 * immediate retry when the tab becomes visible again).
 *
 *   const close = subscribe(roomId, {
 *     onSnapshot(session) {},        // full session; sent on every (re)connect and after each segment
 *     onSegment(segment) {},         // new final segment, OR an update to an existing one (same id) -- be idempotent
 *     onPartial({itemId, text, sourceLanguage, cleared}) {},  // live draft line; text '' / cleared=true clears it
 *     onRevision({segment, supersedes}) {},  // double-checked text replaces segments whose itemId is in `supersedes`
 *     onStatus({status, ...}) {},    // status: 'ready' | 'live' | 'ended', translationEnabled, reason...
 *     onAudio({sequence, format:'pcm16', sampleRate, audio /* base64 *\/}) {},
 *     onConnection(state) {}         // 'connecting' | 'open' | 'reconnecting'
 *   }, {owner: true});               // owner:true -> use this device's stored owner token (needed for private rooms)
 *                                    // owner:'<token>' -> use that token
 *   close();                         // stop and never reconnect
 *
 * Prefer createSegmentStore().handlers for the segment-related callbacks.
 */
export function subscribe(roomId, handlers = {}, { owner = false } = {}) {
  let es = null, closed = false, timer = null, attempts = 0;
  const token = typeof owner === 'string' ? owner : owner ? ownerToken(roomId) : '';
  const emit = (name, value) => { try { handlers[name]?.(value); } catch (e) { console.error(`[minbar] ${name} handler failed`, e); } };
  const url = `/api/sessions/${encodeURIComponent(roomId)}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const parse = e => { try { return JSON.parse(e.data); } catch { return null; } };

  function connect() {
    if (closed) return;
    clearTimeout(timer);
    es?.close();
    emit('onConnection', attempts ? 'reconnecting' : 'connecting');
    es = new EventSource(url);
    es.onopen = () => { attempts = 0; emit('onConnection', 'open'); };
    es.onerror = () => {
      // EventSource retries by itself only for dropped streams; after an HTTP error it is CLOSED.
      emit('onConnection', 'reconnecting');
      if (es.readyState === EventSource.CLOSED) {
        attempts += 1;
        timer = setTimeout(connect, Math.min(10000, 800 * 2 ** Math.min(attempts, 4)));
      }
    };
    const on = (type, name) => es.addEventListener(type, e => { const v = parse(e); if (v) emit(name, v); });
    on('snapshot', 'onSnapshot'); on('segment', 'onSegment'); on('partial', 'onPartial');
    on('revision', 'onRevision'); on('status', 'onStatus'); on('audio', 'onAudio');
  }
  const onVisible = () => { if (!closed && document.visibilityState === 'visible' && es && es.readyState !== EventSource.OPEN) { attempts = 0; connect(); } };
  document.addEventListener('visibilitychange', onVisible);
  connect();
  return function close() { closed = true; clearTimeout(timer); es?.close(); document.removeEventListener('visibilitychange', onVisible); };
}

/* -------------------------------------------------------------- segment store */

/**
 * Ordered, idempotent client-side view of a room's segments.
 *
 *   const store = createSegmentStore();
 *   store.onChange((segments, change) => render(segments));   // returns unsubscribe
 *   const close = subscribe(roomId, {...store.handlers, onStatus, onConnection}, {owner:true});
 *
 *   store.segments   // current array (a NEW array after each change; segment objects are replaced, never mutated)
 *   store.partial    // {itemId, text} current draft line, or null
 *   store.session    // last snapshot (without trusting its segments over the store: they are the same data)
 *
 * Rules: snapshot replaces everything; a segment event with a known id is merged in place (translations
 * are merged key-by-key so a late/duplicate update never drops text); a revision removes the segments whose
 * itemId is in `supersedes` and inserts the revised segment where the first one was; updates for superseded
 * segments (e.g. a translation finishing after a double-check) are ignored.
 */
export function createSegmentStore() {
  let segments = [], partial = null, session = null;
  const superseded = new Set();
  const listeners = new Set();
  const notify = change => { for (const fn of [...listeners]) { try { fn(segments, change); } catch (e) { console.error('[minbar] store listener failed', e); } } };
  const noteSuperseded = list => { for (const s of list || []) for (const id of s.supersedes || []) superseded.add(id); };
  const merge = (old, next) => ({ ...old, ...next, translations: { ...(old.translations || {}), ...(next.translations || {}) } });

  const store = {
    get segments() { return segments; },
    get partial() { return partial; },
    get session() { return session; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    applySnapshot(snapshot) {
      session = snapshot;
      segments = (snapshot.segments || []).map(s => mockify({ ...s }));
      superseded.clear(); noteSuperseded(segments);
      if (partial && segments.some(s => s.itemId === partial.itemId)) partial = null;
      notify({ type: 'snapshot' });
    },
    applySegment(segment) {
      if (!segment?.id || superseded.has(segment.itemId)) return;
      segment = mockify(segment);
      const i = segments.findIndex(s => s.id === segment.id);
      if (i >= 0) { segments = segments.map((s, j) => (j === i ? merge(s, segment) : s)); notify({ type: 'update', segment: segments[i] }); }
      else { segments = [...segments, { ...segment }]; if (partial?.itemId === segment.itemId) partial = null; notify({ type: 'add', segment }); }
    },
    applyRevision({ segment, supersedes = [] }) {
      if (!segment) return;
      segment = mockify(segment);
      for (const id of supersedes) superseded.add(id);
      noteSuperseded([segment]);
      const gone = new Set(supersedes);
      const first = segments.findIndex(s => gone.has(s.itemId));
      const kept = segments.filter(s => !gone.has(s.itemId) && s.id !== segment.id);
      const at = first < 0 ? kept.length : segments.slice(0, first).filter(s => !gone.has(s.itemId) && s.id !== segment.id).length;
      kept.splice(at, 0, { ...segment });
      segments = kept;
      notify({ type: 'revision', segment });
    },
    applyPartial(p) {
      const next = p && p.text && !p.cleared ? { itemId: p.itemId, text: p.text } : null;
      if (next || partial) { partial = next; notify({ type: 'partial' }); }
    },
    clear() { segments = []; partial = null; session = null; superseded.clear(); notify({ type: 'clear' }); }
  };
  /** Spread into subscribe(): {onSnapshot, onSegment, onRevision, onPartial}. */
  store.handlers = { onSnapshot: store.applySnapshot, onSegment: store.applySegment, onRevision: store.applyRevision, onPartial: store.applyPartial };
  return store;
}

/* ---------------------------------------------------------------------- URLs */

const PAGES = { khatib: '/khatib.html', screen: '/screen.html', listen: '/listen.html' };

/**
 * URL of a page for a room: pageUrl('screen', id, {lang:'en', source:1}) -> 'https://host/screen.html?room=ID&lang=en&source=1'.
 * Absolute against `base` (default: current origin). Pass {base:null} for a relative path.
 * For links meant for OTHER devices (QR, copy), use sharePageUrl() so the configured public origin is used.
 */
export function pageUrl(kind, roomId, params = {}, { base = location.origin } = {}) {
  if (!PAGES[kind]) throw new Error(`Unknown page kind: ${kind}`);
  const q = new URLSearchParams({ room: roomId });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== false && v !== '') q.set(k, v === true ? '1' : String(v));
  const path = `${PAGES[kind]}?${q}`;
  return base ? new URL(path, base).href : path;
}
/** Like pageUrl but built on the server's configured PUBLIC_BASE_URL (what phones can actually reach). */
export async function sharePageUrl(kind, roomId, params = {}) {
  let base = location.origin;
  try { base = (await getConfig()).publicBaseUrl || base; } catch { /* use current origin */ }
  return pageUrl(kind, roomId, params, { base });
}
/**
 * <img src> for a QR code of `url` (SVG, public rooms only; the server only accepts urls on its public
 * origin pointing at this room's listen/screen page -- use sharePageUrl('listen', id)).
 */
export const qrSrc = (roomId, url) => `/api/sessions/${encodeURIComponent(roomId)}/qr${url ? `?url=${encodeURIComponent(url)}` : ''}`;
/** Download link for the transcript: exportUrl(id, 'txt'|'json'). Includes the owner token when this device has it (private rooms). */
export function exportUrl(roomId, format = 'txt') {
  const token = ownerToken(roomId);
  return `/api/sessions/${encodeURIComponent(roomId)}/export?format=${format === 'json' ? 'json' : 'txt'}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
}
/** Read ?room= (id or code) and other params from the current URL. */
export const urlParams = () => new URLSearchParams(location.search);
/** Extract a room id or code from user input: a pasted link (?room=...), a UUID or a 6-char code. '' if none. */
export function parseRoomInput(input) {
  const v = String(input || '').trim();
  try { const r = new URL(v).searchParams.get('room'); if (r) return r; } catch { /* not a URL */ }
  const uuid = v.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) return uuid[0].toLowerCase();
  return /^[A-Za-z0-9]{6}$/.test(v) ? v.toUpperCase() : '';
}

/* --------------------------------------------------------------- small utils */

/** Escape text for innerHTML. Prefer textContent; use this only when building HTML strings. */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** 75 -> '1:15', 3700 -> '1:01:40'. */
export function formatDuration(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
}
/** Copy text to the clipboard (with a fallback for non-secure contexts). Resolves true/false. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0'; document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}
/** Bundled sample sermons: [{id, file, title, titleAr, language, durationSec}]. Files live at /samples/<file>. */
export const loadSamples = () => api('/samples/index.json').catch(() => []);

/**
 * Plays the `audio` SSE relay (base64 PCM16 mono) through Web Audio with a small jitter buffer.
 *   const player = createPcmPlayer();  onAudio: e => player.push(e);  stop: player.stop()
 * Must be created/resumed from a user gesture (autoplay policy), e.g. the "Listen to original audio" click.
 */
export function createPcmPlayer() {
  let ctx = null, nextTime = 0;
  return {
    push({ audio, sampleRate = 24000 }) {
      ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      const bin = atob(audio), n = bin.length >> 1, buf = ctx.createBuffer(1, n, sampleRate), ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v > 32767) v -= 65536; ch[i] = v / 32768; }
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
      const now = ctx.currentTime;
      if (nextTime < now + 0.05) nextTime = now + 0.2; // (re)build ~200ms jitter buffer after an underrun
      src.start(nextTime); nextTime += buf.duration;
    },
    stop() { ctx?.close(); ctx = null; nextTime = 0; }
  };
}
