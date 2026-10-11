// Phone reader: /listen.html?room=ID_or_CODE
import {
  t, registerStrings, getUiLang, setUiLang, applyUiLang, onUiLangChange,
  getSession, saveRoom, subscribe, createSegmentStore, textFor, langName, dirOf, isRtl,
  createPcmPlayer, exportUrl, urlParams, h, icon, quranCitations, verseView
} from '/js/core.mjs';

const $ = id => document.getElementById(id);

/* ------------------------------------------------------------- local strings */
const LOCAL = {
  en: {
    conn_lost: 'Connection lost. Reconnecting…',
    audio_waiting: 'Waiting for audio from the khatib…',
    audio_playing: 'Playing original audio',
    audio_unsupported: 'Audio playback is not supported on this device.',
    private_hint: 'Ask the host for the public link, or open it on the device that created the room.',
    load_failed: 'Could not load this khutbah.',
    no_room: 'No room was given. Open the link or QR code shared by the mosque.',
    original_in: 'Original · {lang}',
    verse_arabic: 'Arabic'
  },
  ar: {
    conn_lost: 'انقطع الاتصال. جارٍ إعادة الاتصال…',
    audio_waiting: 'بانتظار الصوت من الخطيب…',
    audio_playing: 'يتم تشغيل الصوت الأصلي',
    audio_unsupported: 'تشغيل الصوت غير مدعوم على هذا الجهاز.',
    private_hint: 'اطلب من المنظّم الرابط العام، أو افتحها على الجهاز الذي أنشأ الغرفة.',
    load_failed: 'تعذّر تحميل هذه الخطبة.',
    no_room: 'لم يتم تحديد غرفة. افتح الرابط أو رمز QR الذي شاركه المسجد.',
    original_in: 'الأصل · {lang}',
    verse_arabic: 'العربية'
  }
};
registerStrings(LOCAL);

/* ---------------------------------------------------------------- storage */
const store_ = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }
};
const KEY = { lang: 'minbar-listen-lang', size: 'minbar-listen-size', orig: 'minbar-listen-orig' };
const SCALES = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2];

/* ------------------------------------------------------------------ state */
const segStore = createSegmentStore();
const state = {
  key: urlParams().get('room') || '',
  id: '',
  session: null,
  status: null,          // 'ready' | 'live' | 'ended' (null until known)
  conn: 'connecting',
  everOpen: false,
  lang: 'source',        // reading language: a target code or 'source'
  showOrig: store_.get(KEY.orig) === '1',
  scaleIdx: Math.max(0, Math.min(SCALES.length - 1, Number(store_.get(KEY.size)) || 1)),
  openVerses: new Set(),   // `${segmentId}:${reference}` of verse cards whose Arabic is expanded
  following: true,
  jumping: false,
  audioOn: false,
  audioLast: 0,
  fatal: null            // {title, body, retry}
};
if (!Number.isInteger(state.scaleIdx)) state.scaleIdx = 1;

/* ---------------------------------------------------------- reading language */
/** 'ready' with captions already flowing counts as live (the server only flips to 'live' on realtime start). */
const curStatus = () => (state.status === 'ready' && segStore.segments.length ? 'live' : state.status);
const targets = () => state.session?.targetLanguages?.length ? state.session.targetLanguages : [];
const sourceLang = () => state.session?.sourceLanguage || 'ar';

function defaultLang() {
  const list = targets();
  if (!list.length) return 'source';
  const nav = (navigator.languages?.length ? navigator.languages : [navigator.language])
    .map(l => String(l || '').toLowerCase().split('-')[0]);
  return list.find(code => nav.includes(code)) || list[0];
}
function pickInitialLang() {
  const saved = store_.get(KEY.lang);
  return saved && (saved === 'source' || targets().includes(saved)) ? saved : defaultLang();
}
/** Language code a given reading choice renders in. */
const captionLang = choice => (choice === 'source' ? sourceLang() : choice);

function renderLangSelect() {
  const select = $('lang-select');
  const opts = [...targets().map(code => h('option', { value: code, lang: code, text: langName(code) })),
    h('option', { value: 'source', text: t('original_in', { lang: langName(sourceLang()) }) })];
  select.replaceChildren(...opts);
  select.value = state.lang;
  select.lang = captionLang(state.lang);
  select.disabled = !state.session;
}

/* ----------------------------------------------------------- feed rendering */
const feed = $('feed');
const nodes = new Map();   // segment id -> element
let rendered = false;      // first full render done (afterwards new lines animate in)

function capClass(lang) { return isRtl(lang) ? 'cap-rtl' : 'cap-latin'; }
function line(cls, text, lang) {
  return h('p', { class: `${cls} caption ${capClass(lang)}`, lang, dir: dirOf(lang), text });
}

/** Everything that decides how one segment looks right now (used as a change signature). */
function segView(seg) {
  const src = seg.sourceLanguage || sourceLang();
  const lang = captionLang(state.lang);
  const own = textFor(seg, state.lang);
  const orig = seg.text || '';
  const verses = quranCitations(seg).map(c => ({ ...verseView(c, state.lang, '', getUiLang()), open: state.openVerses.has(`${seg.id}:${c.reference}`) }));
  if (own) {
    return { main: own, mainLang: lang, orig: state.showOrig && state.lang !== 'source' && orig && orig !== own ? orig : '', origLang: src, verses };
  }
  if (seg.translationStatus === 'pending' && state.session?.translationEnabled !== false) {
    return { pending: true, orig: state.showOrig ? orig : '', origLang: src, verses };
  }
  return { main: orig, mainLang: src, note: state.lang !== 'source', verses };
}

/** Inline verse card. Arabic (Amiri Quran) is collapsible when there is a translation to read instead. */
function buildVerse(v, segId) {
  const collapsible = Boolean(v.translation) && Boolean(v.arabic);
  const open = !collapsible || v.open;
  const key = `${segId}:${v.reference}`;
  const head = [h('span', { class: 'label-wrap', dir: 'auto', text: v.label }), v.approximate && h('span', { class: 'verse-tag', text: t('likely_match') })];
  const headEl = collapsible
    ? h('button', { type: 'button', class: 'verse-head', 'aria-expanded': String(open), 'aria-label': `${v.label}: ${t('verse_arabic')}`, onclick: () => { if (state.openVerses.has(key)) state.openVerses.delete(key); else state.openVerses.add(key); renderFeed(); } },
      h('span', {}, ...head), h('span', { html: icon(open ? 'up' : 'down') }))
    : h('div', { class: 'verse-head' }, h('span', {}, ...head));
  return h('div', { class: `verse${collapsible ? '' : ' verse-static'}` },
    headEl,
    open && v.arabic && h('p', { class: 'quran verse-ar', lang: 'ar', dir: 'rtl', text: v.arabic }),
    v.translation && h('p', { class: `verse-tr caption ${capClass(state.lang)}`, lang: state.lang, dir: dirOf(state.lang), text: v.translation }),
    v.source && h('p', { class: 'verse-src', lang: 'en', text: v.source }));
}

function buildSeg(seg, view, fresh) {
  const kids = [];
  if (view.pending) {
    kids.push(h('div', { class: 'shimmer', 'aria-label': t('translating'), role: 'img' }, h('i'), h('i'), h('i')));
  } else {
    kids.push(line('seg-text', view.main, view.mainLang));
  }
  if (view.orig) kids.push(line('seg-orig', view.orig, view.origLang));
  if (view.note) kids.push(h('p', { class: 'seg-note', text: t('translation_unavailable') }));
  for (const v of view.verses || []) kids.push(buildVerse(v, seg.id));
  return h('article', { class: `entry${view.pending ? ' is-pending' : ''}${fresh ? ' is-new' : ''}`, 'data-id': seg.id }, ...kids);
}

function renderFeed() {
  const segs = segStore.segments;
  const live = new Set(segs.map(s => s.id));
  for (const [id, node] of nodes) if (!live.has(id)) { node.remove(); nodes.delete(id); }
  segs.forEach((seg, i) => {
    const view = segView(seg), sig = JSON.stringify(view);
    let node = nodes.get(seg.id);
    if (!node || node._sig !== sig) {
      const next = buildSeg(seg, view, !node && rendered);
      next._sig = sig;
      if (node) node.replaceWith(next);
      nodes.set(seg.id, next);
      node = next;
    }
    if (feed.children[i] !== node) feed.insertBefore(node, feed.children[i] || null);
  });
  rendered = true;
  renderDraft();
  renderChrome();
  stickBottom();
}

function renderDraft() {
  const el = $('draft'), p = segStore.partial;
  const show = state.lang === 'source' && p?.text && state.status !== 'ended';
  el.hidden = !show;
  if (!show) return;
  const lang = sourceLang();
  el.className = `draft caption ${capClass(lang)}`;
  el.lang = lang; el.dir = dirOf(lang);
  el.textContent = `${p.text} …`;
}

/* ------------------------------------------------------------ chrome states */
/** {key, tone, label}: the dot is red while live; the word is shown for every state except live (the dot says it). */
function statusInfo() {
  if (state.fatal) return null;
  if (!state.session) return { tone: 'idle', key: 'connecting' };
  if (state.conn === 'reconnecting') return { tone: 'warn', key: 'reconnecting' };
  if (state.status === 'ended') return { tone: 'none', key: 'ended' };
  if (curStatus() === 'live') return { tone: 'live', key: 'live' };
  if (curStatus() === 'ready') return { tone: 'idle', key: 'waiting' };
  return { tone: 'idle', key: 'connecting' };
}

function renderStatusPill() {
  const pill = $('status-pill'), info = statusInfo();
  pill.hidden = !info;
  if (!info) return;
  pill.setAttribute('aria-label', t(info.key));
  const dot = info.tone === 'none' ? null : h('span', { class: `dot-live${info.tone === 'live' ? '' : ' is-idle'}`, 'aria-hidden': 'true' });
  pill.replaceChildren(...[dot, info.tone === 'live' ? null : document.createTextNode(t(info.key))].filter(Boolean));
}

function canExport() { return !!state.session && state.session.allowExport !== false && segStore.segments.length > 0; }

function renderChrome() {
  const ended = state.status === 'ended';
  const hasSegs = segStore.segments.length > 0;
  document.body.dataset.view = state.fatal ? 'fatal' : state.session ? 'ready' : 'loading';
  document.body.classList.toggle('is-ended', ended);

  renderStatusPill();

  // banners
  const banner = $('banner');
  const reconnecting = !state.fatal && state.session && state.conn === 'reconnecting';
  banner.hidden = !reconnecting;
  if (reconnecting) $('banner-text').textContent = t('conn_lost');

  // waiting / ended
  $('waiting').hidden = !(state.session && !state.fatal && state.status !== 'ended' && !hasSegs && !(state.lang === 'source' && segStore.partial?.text));
  $('ended-notice').hidden = !(state.session && ended);
  $('fineprint').hidden = !state.session || state.fatal;

  // export links
  const exp = state.session ? exportUrl(state.id, 'txt') : '#';
  $('opt-export').href = exp; $('opt-export').hidden = !canExport() || ended;
  $('end-export').href = exp; $('end-export').hidden = !canExport() || !ended;

  // audio only while the khutbah is not over
  const audioOk = !!(window.AudioContext || window.webkitAudioContext);
  $('audio-btn').hidden = ended || !audioOk;
  $('audio-status').hidden = ended || !state.audioOn;

  // options
  $('orig-row').hidden = state.lang === 'source';
  $('orig-toggle').checked = state.showOrig;
  $('size-down').disabled = state.scaleIdx <= 0;
  $('size-up').disabled = state.scaleIdx >= SCALES.length - 1;

  updateJump();
  renderAudio();
}

function renderTitle() {
  const title = state.session?.title;
  $('room-title').textContent = title || t('app_name');
  document.title = title ? `${title} · ${t('app_name')}` : t('app_name');
}

function renderUiLangButton() {
  const other = getUiLang() === 'ar' ? 'en' : 'ar';
  const b = $('ui-lang-label');
  b.textContent = other === 'ar' ? 'العربية' : 'English';
  b.lang = other;
}

function renderAll() {
  applyUiLang();
  renderUiLangButton();
  renderTitle();
  renderLangSelect();
  document.documentElement.style.setProperty('--text-scale', SCALES[state.scaleIdx]);
  if (state.fatal) renderFatal();
  renderFeed();
}

function renderFatal() {
  const f = state.fatal, card = $('state-card');
  card.hidden = !f;
  if (!f) return;
  card.replaceChildren(
    h('h2', { text: f.title }),
    f.body && h('p', { class: 'muted', text: f.body }),
    h('div', { class: 'row state-actions' },
      f.retry && h('button', { type: 'button', class: 'btn btn-primary', text: t('retry'), onclick: () => location.reload() }),
      h('a', { class: `btn${f.retry ? '' : ' btn-primary'}`, href: '/', text: t('back_home') }))
  );
  $('waiting').hidden = true;
  $('ended-notice').hidden = true;
}

/* ------------------------------------------------------------------ scrolling */
const docEl = document.documentElement;
const distanceFromBottom = () => docEl.scrollHeight - (window.scrollY + window.innerHeight);
const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let lastInput = 0, scrollQueued = false;

for (const ev of ['touchstart', 'touchmove', 'wheel', 'keydown', 'pointerdown']) {
  addEventListener(ev, () => { lastInput = Date.now(); if (state.jumping && ev !== 'pointerdown') state.jumping = false; }, { passive: true });
}
addEventListener('scroll', () => {
  const near = distanceFromBottom() < 90;
  if (state.jumping) { if (near) state.jumping = false; return; }
  if (near) state.following = true;
  else if (Date.now() - lastInput < 1500) state.following = false; // only deliberate scrolling stops auto-follow
  updateJump();
}, { passive: true });

function stickBottom() {
  if (!state.following || scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => { scrollQueued = false; if (state.following) scrollTo({ top: docEl.scrollHeight, behavior: 'auto' }); });
}
function updateJump() {
  $('jump').hidden = !(state.session && !state.following && state.status !== 'ended' && segStore.segments.length > 0);
}
$('jump').addEventListener('click', () => {
  state.following = true; state.jumping = true;
  scrollTo({ top: docEl.scrollHeight, behavior: reduceMotion() ? 'auto' : 'smooth' });
  setTimeout(() => { state.jumping = false; if (state.following) stickBottom(); }, 900);
  updateJump();
});

/* ---------------------------------------------------------------------- audio */
let player = null;
let eqTimer = null;
const SILENCE = btoa('\0'.repeat(480)); // 10 ms of PCM16 silence, used to unlock Web Audio inside the click

function setAudio(on) {
  if (on === state.audioOn) return;
  state.audioOn = on;
  if (on) {
    player = createPcmPlayer();
    try { player.push({ audio: SILENCE, sampleRate: 24000 }); } catch { /* unlock best-effort */ }
    state.audioLast = 0;
    eqTimer = setInterval(renderAudio, 500);
  } else {
    player?.stop(); player = null;
    clearInterval(eqTimer); eqTimer = null;
  }
  renderChrome();
}
function renderAudio() {
  const on = state.audioOn;
  const btn = $('audio-btn');
  btn.setAttribute('aria-pressed', String(on));
  $('audio-label').textContent = t(on ? 'stop_original_audio' : 'listen_original_audio');
  const active = on && Date.now() - state.audioLast < 1800;
  $('audio-ind').hidden = !on;
  $('audio-ind').classList.toggle('is-active', active);
  const status = $('audio-status');
  if (on) status.textContent = active ? t('audio_playing') : t('audio_waiting');
}
$('audio-btn').addEventListener('click', () => setAudio(!state.audioOn));

/* ------------------------------------------------------------------ wake lock */
let wakeLock = null, waking = false;
async function syncWakeLock() {
  const want = curStatus() === 'live' && document.visibilityState === 'visible';
  if (want && !wakeLock && !waking && navigator.wakeLock?.request) {
    waking = true;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* denied or unsupported: reading still works */ }
    waking = false;
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', syncWakeLock);

/* ---------------------------------------------------------------------- live */
function setStatus(status) {
  if (!status || status === state.status) return;
  state.status = status;
  if (status === 'ended') setAudio(false);
  syncWakeLock();
}

segStore.onChange((_segs, change) => {
  if (change?.type === 'snapshot') {
    const s = segStore.session;
    if (s) {
      state.session = { ...state.session, ...s };
      setStatus(s.status);
      renderTitle();
    }
  }
  renderFeed();
});

function start(session) {
  state.session = session;
  state.id = session.id;
  state.status = session.status;
  state.lang = pickInitialLang();
  saveRoom(session.id, { title: session.title, code: session.code, sourceLanguage: session.sourceLanguage, targetLanguages: session.targetLanguages, visibility: session.visibility });
  // Ended rooms open at the top (read from the start); live rooms follow the newest line.
  state.following = session.status !== 'ended';
  syncWakeLock();
  renderAll();
  subscribe(session.id, {
    ...segStore.handlers,
    onStatus: e => { if (e?.status) { setStatus(e.status); if (e.translationEnabled !== undefined) state.session.translationEnabled = e.translationEnabled; renderChrome(); } },
    onConnection: c => { state.conn = c; if (c === 'open') state.everOpen = true; renderChrome(); },
    onAudio: e => { if (state.audioOn && player) { state.audioLast = Date.now(); player.push(e); } }
  }, { owner: true });
}

async function boot() {
  renderAll();
  if (!state.key) {
    state.fatal = { title: t('room_not_found'), body: t('no_room') };
    return renderAll();
  }
  try {
    start(await getSession(state.key));
  } catch (e) {
    state.fatal = e.status === 404 ? { title: t('room_not_found'), body: '' }
      : e.status === 401 ? { title: t('room_private'), body: t('private_hint') }
      : { title: t('load_failed'), body: e.message || '', retry: true };
    renderAll();
  }
}

/* ------------------------------------------------------------------- controls */
$('ui-lang').addEventListener('click', () => { setOptions(false); setUiLang(getUiLang() === 'ar' ? 'en' : 'ar'); });
onUiLangChange(() => { rendered = false; for (const n of nodes.values()) n._sig = ''; renderAll(); rendered = true; });

$('lang-select').addEventListener('change', e => {
  state.lang = e.target.value;
  store_.set(KEY.lang, state.lang);
  $('lang-select').lang = captionLang(state.lang);
  renderFeed();
  if (state.following) stickBottom();
});
function setScale(idx) {
  state.scaleIdx = Math.max(0, Math.min(SCALES.length - 1, idx));
  store_.set(KEY.size, String(state.scaleIdx));
  docEl.style.setProperty('--text-scale', SCALES[state.scaleIdx]);
  renderChrome();
  stickBottom();
}
$('size-down').addEventListener('click', () => setScale(state.scaleIdx - 1));
$('size-up').addEventListener('click', () => setScale(state.scaleIdx + 1));

$('orig-toggle').addEventListener('change', e => {
  state.showOrig = e.target.checked;
  store_.set(KEY.orig, state.showOrig ? '1' : '0');
  renderFeed();
});

const optBtn = $('opt-btn'), optPanel = $('opt-panel');
function setOptions(open) { optPanel.hidden = !open; optBtn.setAttribute('aria-expanded', String(open)); }
optBtn.addEventListener('click', () => setOptions(optPanel.hidden));
document.addEventListener('click', e => { if (!optPanel.hidden && !e.target.closest('.menu-wrap')) setOptions(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !optPanel.hidden) { setOptions(false); optBtn.focus(); } });

addEventListener('pagehide', () => { player?.stop(); });
boot();
