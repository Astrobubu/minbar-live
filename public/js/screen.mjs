// Minbar hall screen: /screen.html?room=ID&lang=en[&source=1][&size=1.2]
// Dark projector view: the latest 2-3 translated lines, newest at the bottom.
import {
  langName, isRtl, t, registerStrings, applyUiLang, textFor,
  getSession, ownerToken, subscribe, createSegmentStore, sharePageUrl, qrSrc, urlParams,
  h, quranCitations, verseView
} from '/js/core.mjs';

/* ----------------------------------------------------------- local strings */
const LOCAL = {
  en: {
    connecting_hint: 'Reaching the room…',
    reconnecting_hint: 'The connection dropped. Captions will resume automatically.',
    not_found_hint: 'Check the link or room code on the khatib console.',
    private_hint: 'Open this screen on the device that created the room, or ask the khatib to make it public.',
    no_room: 'No room was given. Open this page from the khatib console.'
  },
  ar: {
    connecting_hint: 'جارٍ الوصول إلى الغرفة…',
    reconnecting_hint: 'انقطع الاتصال. ستعود الترجمة تلقائيًا.',
    not_found_hint: 'تحقّق من الرابط أو رمز الغرفة في لوحة الخطيب.',
    private_hint: 'افتح هذه الشاشة على الجهاز الذي أنشأ الغرفة، أو اطلب من الخطيب جعلها عامة.',
    no_room: 'لم يتم تحديد غرفة. افتح هذه الصفحة من لوحة الخطيب.'
  }
};
registerStrings(LOCAL);

/* ---------------------------------------------------------------- constants */
const MAX_LINES = 3;            // lines considered visible (fit may drop the oldest)
const PENDING_GIVE_UP_MS = 25000; // stop showing the typing indicator for a translation this old
const IDLE_MS = 3000;
const VERSE_HOLD_MS = 8000;      // a verse block stays a verse block this long after it first appears
const SCALE_MIN = 0.5, SCALE_MAX = 2, SCALE_STEP = 0.1;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const $ = id => document.getElementById(id);
const el = {
  title: $('title'), status: $('status'), statusDot: $('status-dot'), statusText: $('status-text'),
  share: $('share'), qr: $('qr'), code: $('code'),
  captions: $('captions'), lines: $('lines'),
  state: $('state'), stateTitle: $('state-title'), stateHint: $('state-hint'), stateSpinner: $('state-spinner'),
  settings: $('settings'), gear: $('gear'), panel: $('panel'),
  setLang: $('set-lang'), setSource: $('set-source'), sizeDown: $('size-down'), sizeUp: $('size-up'), sizeValue: $('size-value'), setFull: $('set-fullscreen')
};

const params = urlParams();
const roomParam = params.get('room') || '';
const view = {
  lang: params.get('lang') || '',          // language code or 'source'
  source: params.get('source') === '1' || params.get('source') === 'true',
  scale: clampScale(parseFloat(params.get('size')) || 1)
};
const app = { roomId: '', session: null, phase: 'loading', gotSnapshot: false, conn: 'connecting', status: 'ready' };
const store = createSegmentStore();
const lineEls = new Map();   // segment id -> <p class="line">
const verseSeen = new Map(); // segment id -> when its verse block first showed as the newest line
let pendingTimer = null;

function clampScale(v) { return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v * 10) / 10)); }

/* -------------------------------------------------------------- URL persistence */
function persist() {
  try {
    const q = new URLSearchParams(location.search);
    q.set('lang', view.lang);
    if (view.source) q.set('source', '1'); else q.delete('source');
    if (view.scale !== 1) q.set('size', String(view.scale)); else q.delete('size');
    history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
  } catch { /* replaceState unavailable */ }
}

/* ---------------------------------------------------------------- language helpers */
const sourceLang = () => app.session?.sourceLanguage || 'ar';
const targetLangs = () => (app.session?.targetLanguages?.length ? app.session.targetLanguages : [app.session?.language || 'en']);
const captionLang = () => (view.lang === 'source' ? sourceLang() : view.lang);
function resolveLang(wanted) {
  if (wanted === 'source' || wanted === 'original' || wanted === sourceLang()) return 'source';
  return targetLangs().includes(wanted) ? wanted : targetLangs()[0];
}

/* ------------------------------------------------------------------ chrome */
function renderChrome() {
  const s = app.session;
  el.title.textContent = s?.title || '';
  el.title.hidden = !s?.title;
  if (s?.title) document.title = `${s.title} · ${t('app_name')}`;

  let tone = 'idle', text = t('connecting'), dotIdle = true;
  if (app.phase === 'ok' && app.gotSnapshot) {
    if (app.conn === 'reconnecting') { tone = 'warn'; text = t('reconnecting'); dotIdle = false; }
    else if (app.status === 'live' || (app.status !== 'ended' && store.segments.length)) { tone = 'live'; text = t('live'); dotIdle = false; }
    else if (app.status === 'ended') { tone = 'idle'; text = t('ended'); }
    else { tone = 'idle'; text = t('waiting'); }
  } else if (app.phase === 'notfound' || app.phase === 'private') { text = ''; }
  else if (app.conn === 'reconnecting') { tone = 'warn'; text = t('reconnecting'); dotIdle = false; }
  el.status.dataset.tone = tone;
  el.status.hidden = !text;
  el.statusText.textContent = text;
  el.statusDot.classList.toggle('is-idle', dotIdle);
}

async function renderShare() {
  const s = app.session;
  if (!s || s.visibility !== 'public' || !s.code) { el.share.hidden = true; return; }
  el.code.textContent = s.code;
  try {
    const link = await sharePageUrl('listen', s.id);
    el.qr.onerror = () => { el.share.hidden = true; };
    el.qr.onload = () => { el.share.hidden = false; };
    el.qr.src = qrSrc(s.id, link);
  } catch { el.share.hidden = true; }
}

function setState({ title = '', hint = '', spinner = false } = {}) {
  const show = Boolean(title || spinner);
  el.state.hidden = !show;
  el.stateTitle.textContent = title;
  el.stateTitle.hidden = !title;
  el.stateHint.textContent = hint;
  el.stateHint.hidden = !hint;
  el.stateSpinner.hidden = !spinner;
}

function updateState(hasLines, hasPending) {
  if (!roomParam) return setState({ title: t('room_not_found'), hint: t('no_room') });
  if (app.phase === 'notfound') return setState({ title: t('room_not_found'), hint: t('not_found_hint') });
  if (app.phase === 'private') return setState({ title: t('room_private'), hint: t('private_hint') });
  if (!app.gotSnapshot) {
    const reconnecting = app.conn === 'reconnecting';
    return setState({ title: t(reconnecting ? 'reconnecting' : 'connecting'), hint: reconnecting ? t('reconnecting_hint') : '', spinner: true });
  }
  if (app.status === 'ended') return setState({ title: t('ended_title'), hint: t('ended_hint') });
  if (!hasLines && !hasPending) return setState({ title: t('waiting_title'), hint: t('waiting_hint') });
  setState();
}

/* ---------------------------------------------------------------- captions */
const typingEl = Object.assign(document.createElement('div'), { className: 'typing', hidden: true });
typingEl.setAttribute('aria-hidden', 'true');
typingEl.innerHTML = '<i></i><i></i><i></i>';

function makeLine(id) {
  const p = document.createElement('p');
  p.className = 'line';
  p.dataset.id = id;
  p._text = ''; p._sig = '';
  return p;
}

/** Fill a line: plain caption (translation + optional original), or a verse block (Arabic, translation, reference). */
function setLineContent(p, { text, verse }, srcText, srcLang, lang) {
  const sig = JSON.stringify([text, srcText, srcLang, verse, lang]);
  p._text = text;
  if (p._sig === sig) return;
  p._sig = sig;
  p.classList.toggle('is-verse', Boolean(verse));
  if (verse) {
    const tr = lang === 'source' ? '' : verse.translation;
    p.replaceChildren(
      verse.arabic && h('span', { class: 'quran verse-ar', lang: 'ar', dir: 'rtl', text: verse.arabic }),
      tr && h('span', { class: 'verse-tr', lang: captionLang(), dir: isRtl(captionLang()) ? 'rtl' : 'ltr', text: tr }),
      h('span', { class: 'verse-ref' }, h('bdi', { dir: 'auto', text: verse.label }), verse.approximate && h('span', { class: 'verse-tag', text: t('likely_match') })));
    return;
  }
  const trEl = h('span', { class: 'tr', text });
  const kids = [trEl];
  if (srcText) kids.push(h('span', { class: 'src', lang: srcLang, dir: isRtl(srcLang) ? 'rtl' : 'ltr', text: srcText }));
  p.replaceChildren(...kids);
}

/** The lines that should be on screen: last MAX_LINES with text in the chosen language. */
function candidates() {
  const out = [];
  const now = Date.now();
  const segs = store.segments;
  const wanted = view.lang === 'source' ? 'source' : view.lang;
  segs.forEach((seg, i) => {
    const known = lineEls.get(seg.id);
    let text = textFor(seg, wanted);
    text = typeof text === 'string' ? text.trim() : '';
    if (!text && known) text = known._text;            // never blank a line that is already showing
    // Quran verse: shown as a verse block while it is the newest line (and for VERSE_HOLD_MS after it first showed).
    let verse = null;
    const cite = quranCitations(seg, 1)[0];
    if (cite && app.status !== 'ended') {
      const newest = i === segs.length - 1;
      if (newest && !verseSeen.has(seg.id)) verseSeen.set(seg.id, now);
      if (newest || (verseSeen.has(seg.id) && now - verseSeen.get(seg.id) < VERSE_HOLD_MS)) {
        verse = verseView(cite, wanted, text, wanted === 'source' || isRtl(wanted) ? 'ar' : 'en');
        if (!verse.arabic) verse = null;
      }
    }
    if (!text && !(verse && (verse.translation || wanted === 'source'))) return;   // not translated (yet) or failed: show nothing
    out.push({ seg, text, verse });
  });
  const shown = out.slice(-MAX_LINES);
  // come back when the newest verse's hold runs out so it settles into a normal dimmed line
  for (const c of shown) if (c.verse && c.seg !== segs.at(-1)) { clearTimeout(verseTimer); verseTimer = setTimeout(draw, Math.max(50, VERSE_HOLD_MS - (now - verseSeen.get(c.seg.id)) + 50)); }
  return shown;
}
let verseTimer = null;

function pendingNow() {
  const last = store.segments.at(-1);
  if (!last || view.lang === 'source') return false;
  if (lineEls.has(last.id) || last.translationStatus === 'failed') return false;
  const own = textFor(last, view.lang);
  if (own) return false;
  const age = Date.now() - (Date.parse(last.createdAt) || Date.now());
  if (age > PENDING_GIVE_UP_MS) return false;
  pendingTimer = setTimeout(draw, PENDING_GIVE_UP_MS - age + 50);
  return true;
}

let showTyping = false;
function applyLines(cands, animateNew) {
  const lang = captionLang();
  const dir = isRtl(lang) ? 'rtl' : 'ltr';
  const showSrc = view.source && view.lang !== 'source';
  const want = new Set(cands.map(c => c.seg.id));
  for (const [id, p] of lineEls) if (!want.has(id)) { p.remove(); lineEls.delete(id); }
  let prev = null;
  cands.forEach(({ seg, text, verse }, i) => {
    let p = lineEls.get(seg.id);
    if (!p) {
      p = makeLine(seg.id);
      lineEls.set(seg.id, p);
      if (animateNew) { p.classList.add('enter'); p.addEventListener('animationend', () => p.classList.remove('enter'), { once: true }); }
    }
    p.lang = lang; p.dir = dir;
    setLineContent(p, { text, verse }, showSrc ? seg.text : '', sourceLang(), view.lang === 'source' ? 'source' : lang);
    const ref = prev ? prev.nextSibling : el.lines.firstChild;
    if (ref !== p) el.lines.insertBefore(p, ref);
    p.dataset.age = String(cands.length - 1 - i);
    prev = p;
  });
  el.captions.classList.toggle('multi', cands.length > 1);
  // typing indicator always sits last, only while the newest line's translation is on its way
  typingEl.hidden = !showTyping;
  if (showTyping) { typingEl.dir = dir; if (el.lines.lastChild !== typingEl) el.lines.append(typingEl); }
  else if (typingEl.parentNode) typingEl.remove();
}

const overflows = () => el.lines.offsetHeight > el.captions.clientHeight + 1;

/** Drop the oldest lines, then shrink text, until everything fits the stage. */
function fit(cands, animateNew) {
  let list = cands;
  document.body.style.removeProperty('--fit');
  applyLines(list, animateNew);
  while (overflows() && list.length > 1) { list = list.slice(1); applyLines(list, animateNew); }
  let f = 1;
  while (overflows() && f > 0.3) { f = Math.round((f - 0.07) * 100) / 100; document.body.style.setProperty('--fit', String(f)); }
}

let rendered = false;
function draw() {
  if (app.phase !== 'ok' || !app.gotSnapshot) { updateState(false, false); return; }
  const cands = candidates();
  const before = new Map();
  for (const [id, p] of lineEls) before.set(id, p.getBoundingClientRect().top);

  const animate = rendered && !reducedMotion.matches;
  clearTimeout(pendingTimer);
  const pending = pendingNow();
  showTyping = pending;
  fit(cands, animate);
  // FLIP: glide lines that were already on screen to their new position
  if (animate) {
    for (const [id, p] of lineEls) {
      if (!before.has(id)) continue;
      const dy = before.get(id) - p.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) p.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
  }
  rendered = true;
  el.captions.hidden = app.status === 'ended';
  updateState(cands.length > 0, pending);
}

/** A revision gives the replacement a new id: reuse the DOM node of the superseded line so nothing flickers. */
function rekey(segments, revised) {
  if (!revised || lineEls.has(revised.id)) return;
  const live = new Set(segments.map(s => s.id));
  for (const node of el.lines.children) {
    const id = node.dataset?.id;
    if (id && lineEls.has(id) && !live.has(id)) {
      lineEls.delete(id); lineEls.set(revised.id, node); node.dataset.id = revised.id;
      return;
    }
  }
}

store.onChange((segments, change) => {
  if (change?.type === 'revision') rekey(segments, change.segment);
  draw();
});

/* ---------------------------------------------------------------- settings */
function buildLangOptions() {
  const opts = targetLangs().map(code => {
    const o = document.createElement('option');
    o.value = code; o.textContent = langName(code); o.lang = code;
    return o;
  });
  const orig = document.createElement('option');
  orig.value = 'source'; orig.textContent = `${t('original')} · ${langName(sourceLang())}`;
  el.setLang.replaceChildren(...opts, orig);
  el.setLang.value = view.lang;
}

function applyScale() {
  document.body.style.setProperty('--scale', String(view.scale));
  el.sizeValue.textContent = `${Math.round(view.scale * 100)}%`;
  el.sizeDown.disabled = view.scale <= SCALE_MIN;
  el.sizeUp.disabled = view.scale >= SCALE_MAX;
}
function changeScale(delta) {
  const next = clampScale(view.scale + delta);
  if (next === view.scale) return;
  view.scale = next; applyScale(); persist(); draw();
}
function setLanguage(code) {
  view.lang = resolveLang(code);
  el.setLang.value = view.lang;
  // lines re-render in the new language; start fresh so they do not animate as new
  for (const p of lineEls.values()) p.remove();
  lineEls.clear(); rendered = false;
  persist(); draw();
}

const isFullscreen = () => Boolean(document.fullscreenElement);
function toggleFullscreen() {
  try {
    if (isFullscreen()) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  } catch { /* not allowed */ }
}
function renderFullscreenLabel() { el.setFull.textContent = t(isFullscreen() ? 'exit_fullscreen' : 'fullscreen'); }

let idleTimer = null;
const panelOpen = () => !el.panel.hidden;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (panelOpen() || el.settings.contains(document.activeElement)) return wake();
    document.body.classList.add('idle');
  }, IDLE_MS);
}
function setPanel(open) {
  el.panel.hidden = !open;
  el.gear.setAttribute('aria-expanded', String(open));
  if (open) el.setLang.focus(); else el.gear.focus({ preventScroll: true });
  wake();
}

function initSettings() {
  el.setSource.checked = view.source;
  el.setSource.addEventListener('change', () => { view.source = el.setSource.checked; persist(); draw(); });
  el.setLang.addEventListener('change', () => setLanguage(el.setLang.value));
  el.sizeDown.addEventListener('click', () => changeScale(-SCALE_STEP));
  el.sizeUp.addEventListener('click', () => changeScale(SCALE_STEP));
  el.gear.addEventListener('click', () => setPanel(!panelOpen()));
  el.setFull.addEventListener('click', toggleFullscreen);
  if (!document.fullscreenEnabled) el.setFull.hidden = true;
  document.addEventListener('fullscreenchange', () => { renderFullscreenLabel(); draw(); });
  renderFullscreenLabel();
  applyScale();

  document.addEventListener('pointerdown', e => { if (panelOpen() && !el.settings.contains(e.target)) setPanel(false); });
  for (const ev of ['mousemove', 'pointermove', 'pointerdown', 'touchstart', 'keydown']) document.addEventListener(ev, wake, { passive: true });
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && panelOpen()) return setPanel(false);
    if (e.target.closest?.('select, input, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'f') { e.preventDefault(); toggleFullscreen(); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); changeScale(SCALE_STEP); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); changeScale(-SCALE_STEP); }
  });
  wake();
}

/* --------------------------------------------------------------- wake lock */
let wakeLock = null;
async function keepAwake() {
  try {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { wakeLock = null; /* denied or unsupported: the screen may sleep */ }
}
document.addEventListener('visibilitychange', keepAwake);

/* --------------------------------------------------------------------- boot */
// Re-fit whenever the stage changes size or web fonts finish loading (metrics change line heights).
let refitRaf = 0;
const refit = () => { cancelAnimationFrame(refitRaf); refitRaf = requestAnimationFrame(draw); };
if ('ResizeObserver' in window) new ResizeObserver(refit).observe(el.captions); else addEventListener('resize', refit);
document.fonts?.addEventListener?.('loadingdone', refit);
document.fonts?.ready?.then(refit);

function onSnapshot(session) {
  app.session = session;
  app.status = session.status || 'ready';
  const first = !app.gotSnapshot;
  app.gotSnapshot = true;
  store.applySnapshot(session);          // triggers draw()
  if (first) { view.lang = resolveLang(view.lang || targetLangs()[0]); buildLangOptions(); persist(); renderShare(); }
  renderChrome();
}

async function start() {
  applyUiLang();
  initSettings();
  keepAwake();
  renderChrome();
  updateState(false, false);
  if (!roomParam) { app.phase = 'notfound'; renderChrome(); return updateState(false, false); }

  let session;
  for (;;) {
    try { session = await getSession(roomParam); break; }
    catch (e) {
      if (e.status === 404) { app.phase = 'notfound'; break; }
      if (e.status === 401 || e.status === 403) { app.phase = 'private'; break; }
      await new Promise(r => setTimeout(r, 3000));      // network/server hiccup: keep trying
    }
  }
  if (app.phase !== 'loading') { renderChrome(); return updateState(false, false); }

  app.phase = 'ok';
  app.roomId = session.id;
  app.session = session;
  view.lang = resolveLang(view.lang || targetLangs()[0]);
  buildLangOptions();
  renderChrome();
  subscribe(session.id, {
    ...store.handlers,
    onSnapshot,
    onStatus(e) { if (e?.status) { app.status = e.status; renderChrome(); draw(); } },
    onConnection(state) { app.conn = state; renderChrome(); if (!app.gotSnapshot) updateState(false, false); }
  }, { owner: Boolean(ownerToken(session.id)) });
}

start();
