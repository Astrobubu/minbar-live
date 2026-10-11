import {
  LANGS, SOURCE_LANGS, MAX_TARGETS, defaultTargets, langName, dirOf,
  t, getUiLang, setUiLang, applyUiLang, onUiLangChange,
  getSession, createRoom, saveRoom, listRooms, removeRoom, parseRoomInput, pageUrl, exportUrl, h
} from '/js/core.mjs';

const $ = id => document.getElementById(id);
const state = { source: 'ar', targets: ['en'], visibility: 'public', busy: false };

// Server messages are English; in the Arabic UI show a translated message per status instead, and keep any text bidi-safe.
function errorText(e, fallbackKey) {
  if (!e) return t(fallbackKey);
  if (getUiLang() !== 'ar') return e.message || t(fallbackKey);
  const key = { 0: 'err_network', 401: 'err_auth', 403: 'err_auth', 404: 'err_missing', 429: 'err_rate' }[e.status] || (e.status >= 500 ? 'err_server' : fallbackKey);
  return t(key);
}
const showError = (id, message) => { const el = $(id); el.setAttribute('dir', 'auto'); el.textContent = message || ''; el.hidden = !message; };

/* ---- language toggle ---- */
function renderUiLangButton() {
  const other = getUiLang() === 'ar' ? 'en' : 'ar';
  $('ui-lang').textContent = other === 'ar' ? 'العربية' : 'English';
  $('ui-lang').lang = other;
}

/* ---- start form ---- */
function renderSource() {
  const box = $('source-options');
  box.replaceChildren(...SOURCE_LANGS.map(code => {
    const input = h('input', { type: 'radio', name: 'source', value: code, checked: state.source === code, onchange: () => setSource(code) });
    return h('label', {}, input, h('span', { lang: code, dir: dirOf(code), text: langName(code) }));
  }));
}

function renderTargets() {
  const box = $('target-options');
  const full = state.targets.length >= MAX_TARGETS;
  box.replaceChildren(...LANGS.filter(l => l.code !== state.source).map(l => {
    const checked = state.targets.includes(l.code);
    const input = h('input', {
      type: 'checkbox', name: 'target', value: l.code, checked, disabled: full && !checked,
      onchange: e => toggleTarget(l.code, e.target.checked)
    });
    return h('label', { class: 'chip' }, input, h('span', { lang: l.code, dir: dirOf(l.code), text: l.nativeName }));
  }));
}

function renderVisibility() {
  const opts = [['public', 'visibility_public'], ['private', 'visibility_private']];
  $('visibility-options').replaceChildren(...opts.map(([value, key]) => h('label', {},
    h('input', { type: 'radio', name: 'visibility', value, checked: state.visibility === value, onchange: () => { state.visibility = value; } }),
    h('span', { text: t(key) }))));
}

function setSource(code) {
  state.source = code;
  // keep still-valid choices, otherwise fall back to the default "other" language
  state.targets = state.targets.filter(c => c !== code);
  if (!state.targets.length) state.targets = defaultTargets(code);
  renderTargets();
}

function toggleTarget(code, on) {
  if (on) { if (state.targets.length < MAX_TARGETS && !state.targets.includes(code)) state.targets = [...state.targets, code]; }
  else state.targets = state.targets.filter(c => c !== code);
  renderTargets();
  showError('start-error', state.targets.length ? '' : t('targets_min'));
}

async function startKhutbah(event) {
  event.preventDefault();
  if (state.busy) return;
  if (!state.targets.length) return showError('start-error', t('targets_min'));
  setBusy('start-submit', true, 'creating');
  showError('start-error', '');
  try {
    const { session } = await createRoom({
      title: $('title').value.trim() || t('khutbah_title_placeholder'),
      sourceLanguage: state.source,
      targetLanguages: state.targets,
      visibility: state.visibility
    });
    location.href = pageUrl('khatib', session.id, {}, { base: null });
  } catch (e) {
    showError('start-error', errorText(e, 'could_not_create'));
    setBusy('start-submit', false, 'create_room');
  }
}

function setBusy(buttonId, busy, key) {
  state.busy = busy;
  const b = $(buttonId);
  b.disabled = busy;
  b.textContent = t(key);
}

/* ---- demo ---- */
async function startDemo() {
  if (state.busy) return;
  setBusy('demo-btn', true, 'creating');
  showError('demo-error', '');
  try {
    const { session } = await createRoom({ title: t('demo_title'), sourceLanguage: 'ar', targetLanguages: ['en'], visibility: 'public' });
    location.href = pageUrl('khatib', session.id, { demo: 1 }, { base: null });
  } catch (e) {
    showError('demo-error', errorText(e, 'could_not_create'));
    setBusy('demo-btn', false, 'try_demo');
  }
}

/* ---- join ---- */
async function joinRoom(event) {
  event.preventDefault();
  if (state.busy) return;
  const key = parseRoomInput($('join-code').value);
  if (!key) return showError('join-error', t('room_not_found'));
  setBusy('join-submit', true, 'loading');
  showError('join-error', '');
  try {
    const session = await getSession(key);
    saveRoom(session.id, { title: session.title, code: session.code, sourceLanguage: session.sourceLanguage, targetLanguages: session.targetLanguages, visibility: session.visibility });
    location.href = pageUrl('listen', session.id, {}, { base: null });
  } catch (e) {
    showError('join-error', e.status === 404 ? t('room_not_found') : e.status === 401 ? t('room_private') : errorText(e, 'could_not_join'));
    setBusy('join-submit', false, 'join');
  }
}

/* ---- recent rooms ---- */
function renderRecent() {
  const rooms = listRooms();
  $('recent').hidden = rooms.length === 0;
  $('recent-list').replaceChildren(...rooms.map(room => {
    const link = (key, href, cls = '') => h('a', { class: cls, href, text: t(key) });
    const first = (room.targetLanguages || [])[0];
    const langs = room.sourceLanguage ? `${langName(room.sourceLanguage)}${first ? ` → ${room.targetLanguages.map(c => langName(c)).join(', ')}` : ''}` : '';
    const date = room.createdAt ? new Date(room.createdAt).toLocaleDateString(getUiLang() === 'ar' ? 'ar' : undefined, { month: 'short', day: 'numeric' }) : '';
    const meta = [room.code && h('span', { class: 'recent-code', dir: 'ltr', text: room.code }), langs && h('span', { text: langs }), date && h('span', { text: date })].filter(Boolean);
    return h('li', { class: 'recent-item' },
      h('div', { class: 'recent-info' }, h('div', { class: 'recent-title', text: room.title || room.id }), h('div', { class: 'recent-meta' }, ...meta)),
      h('div', { class: 'recent-actions' },
        room.ownerToken && link('role_khatib', pageUrl('khatib', room.id, {}, { base: null }), 'is-primary'),
        link('role_screen', pageUrl('screen', room.id, first ? { lang: first } : {}, { base: null })),
        link('role_listen', pageUrl('listen', room.id, {}, { base: null })),
        h('a', { href: exportUrl(room.id, 'txt'), download: '', text: t('export_txt') }),
        h('button', { type: 'button', text: t('remove'), onclick: () => { removeRoom(room.id); renderRecent(); } })));
  }));
}

/* ---- boot ---- */
function renderAll() {
  applyUiLang();
  renderUiLangButton();
  renderSource(); renderTargets(); renderVisibility(); renderRecent();
  if (!state.busy) { $('start-submit').textContent = t('create_room'); $('demo-btn').textContent = t('try_demo'); $('join-submit').textContent = t('join'); }
}

$('ui-lang').addEventListener('click', () => setUiLang(getUiLang() === 'ar' ? 'en' : 'ar'));
onUiLangChange(renderAll);
$('start-form').addEventListener('submit', startKhutbah);
$('join-form').addEventListener('submit', joinRoom);
$('demo-btn').addEventListener('click', startDemo);
renderAll();
// pageshow: coming back via the back button must not leave buttons stuck in "creating"
addEventListener('pageshow', e => { if (e.persisted) { state.busy = false; renderAll(); } });
