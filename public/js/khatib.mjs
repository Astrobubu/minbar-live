// Khatib console: pick a source (microphone or a sample/file played "as live"), start/stop the
// realtime pipeline, watch exactly what the audience receives, share the room, export, end.
import {
  langName, dirOf, textFor, t, registerStrings, getUiLang, setUiLang, applyUiLang, onUiLangChange,
  getSession, getConfig, saveRoom, listRooms, ownerToken, api, ensureLocalAccess,
  subscribe, createSegmentStore, pageUrl, sharePageUrl, qrSrc, exportUrl, urlParams,
  loadSamples, formatDuration, copyText, h, icon, quranCitations, verseView, isLanHost, localConsoleUrl
} from '/js/core.mjs';
import { createCapture, uploadAudioFile } from '/js/capture.mjs';

/* ------------------------------------------------------------ local strings */
// Strings only this page needs, registered with core so t() and data-i18n resolve them.
const LOCAL = {
  en: {
    src_mic: 'Microphone',
    src_file: 'Audio file',
    from_device: 'Choose a file',
    my_file: 'My file: {name}',
    audio_level: 'Audio level',
    lan_gate_title: 'Open the console on the host computer',
    lan_gate_body: 'Open the console on this computer at {url}',
    stopping: 'Stopping… finishing the last lines',
    stopped: 'Stopped',
    reconnecting_n: 'Reconnecting ({n}/3)…',
    play_again: 'Play again',
    start_again: 'Start again',
    pick_audio: 'Choose a sample or a file first.',
    sample_lang_mismatch: 'This audio is in {lang}, but this room expects {room}. The transcript may be poor.',
    audio_done: 'The audio finished. The last lines are being saved.',
    translation_failed: 'Translation unavailable',
    double_checked: 'Double-checked',
    share_private: 'Private room: no QR code. Only this device can open it.',
    events_reconnecting: 'Reconnecting to live updates…',
    session_limit: 'The session reached its time limit and was ended.',
    session_limit_soon: 'Approaching the 60-minute session limit. The session ends automatically.',
    uploading: 'Transcribing {name}… this can take a minute.',
    upload_done: 'Transcribed {name}. The text now appears in the transcript.',
    upload_big: 'That file is larger than 25 MB.',
    ended_cannot_start: 'This khutbah has ended.',
    ending_failed: 'Could not end the khutbah.',
    go_listen: 'Open phone view',
    notice_relay: 'Original audio relay is slow or unavailable. Captions are not affected.',
    notice_verify: 'The audio double-check was skipped. Live text was kept.',
    notice_generic: 'Some background steps did not finish. Live captions are not affected.',
    no_room: 'No room was given.',
    no_room_body: 'Open this page from the room created on the start page.',
    err_mic_denied: 'Microphone access was blocked. Allow it in the browser settings (the lock icon in the address bar) and try again.',
    err_mic_missing: 'No microphone was found. Connect one and try again.',
    err_mic_failed: 'The microphone is busy or could not be opened. Close other apps using it and try again.',
    err_audio_failed: 'The audio could not be played. Try another file or sample.',
    err_no_owner: 'This device is not the host of this room, so it cannot start the transcription.',
    err_host_key: 'Live transcription is locked on this server. Save the host key in this browser, or run the server in local mode.',
    err_no_live: 'Live transcription is not available: the server has no OpenAI key configured.',
    err_ended: 'This khutbah has ended.',
    err_realtime: 'Could not reach the live transcription service. Check the internet connection and try again in a moment.',
    err_network: 'Network problem. Check the connection and try again.',
    err_timeout: 'The microphone or connection did not respond in time. Try again.',
    err_connection: 'The connection to live transcription was lost and could not be restored.',
    err_unknown: 'Something went wrong.'
  },
  ar: {
    src_mic: 'الميكروفون',
    src_file: 'ملف صوتي',
    from_device: 'اختر ملفًا',
    my_file: 'ملفي: {name}',
    audio_level: 'مستوى الصوت',
    lan_gate_title: 'افتح لوحة الخطيب على جهاز الخادم',
    lan_gate_body: 'افتح لوحة الخطيب على هذا الحاسوب عبر {url}',
    stopping: 'جارٍ الإيقاف… وحفظ آخر الأسطر',
    stopped: 'متوقف',
    reconnecting_n: 'إعادة الاتصال ({n}/3)…',
    play_again: 'تشغيل مرة أخرى',
    start_again: 'ابدأ من جديد',
    pick_audio: 'اختر عيّنة أو ملفًا أولًا.',
    sample_lang_mismatch: 'هذا الصوت بلغة {lang} لكن الغرفة تتوقع {room}. قد يكون التفريغ ضعيفًا.',
    audio_done: 'انتهى الصوت. يجري حفظ آخر الأسطر.',
    translation_failed: 'الترجمة غير متاحة',
    double_checked: 'تمت المراجعة',
    share_private: 'غرفة خاصة: لا يوجد رمز QR. لا يفتحها إلا هذا الجهاز.',
    events_reconnecting: 'جارٍ إعادة الاتصال بالتحديثات المباشرة…',
    session_limit: 'بلغت الجلسة حدّها الزمني وتم إنهاؤها.',
    session_limit_soon: 'تقترب الجلسة من حدّ الستين دقيقة، وتنتهي تلقائيًا.',
    uploading: 'جارٍ تفريغ {name}… قد يستغرق دقيقة.',
    upload_done: 'تم تفريغ {name}. سيظهر النص الآن في السجل.',
    upload_big: 'حجم الملف أكبر من 25 ميغابايت.',
    ended_cannot_start: 'انتهت هذه الخطبة.',
    ending_failed: 'تعذّر إنهاء الخطبة.',
    go_listen: 'فتح عرض الهاتف',
    notice_relay: 'بثّ الصوت الأصلي بطيء أو غير متاح. لا يتأثر عرض النص.',
    notice_verify: 'تم تخطّي مراجعة الصوت. بقي النص المباشر كما هو.',
    notice_generic: 'لم تكتمل بعض الخطوات الخلفية. لا يتأثر عرض النص المباشر.',
    no_room: 'لم تُحدَّد غرفة.',
    no_room_body: 'افتح هذه الصفحة من الغرفة التي أنشأتها في صفحة البداية.',
    err_mic_denied: 'تم حظر الوصول إلى الميكروفون. اسمح به من إعدادات المتصفح (أيقونة القفل في شريط العنوان) ثم أعد المحاولة.',
    err_mic_missing: 'لم يتم العثور على ميكروفون. وصّل واحدًا ثم أعد المحاولة.',
    err_mic_failed: 'الميكروفون مشغول أو تعذّر فتحه. أغلق التطبيقات الأخرى التي تستخدمه وأعد المحاولة.',
    err_audio_failed: 'تعذّر تشغيل الصوت. جرّب ملفًا أو عيّنة أخرى.',
    err_no_owner: 'هذا الجهاز ليس مضيف هذه الغرفة، فلا يستطيع بدء التفريغ.',
    err_host_key: 'التفريغ المباشر مقفل على هذا الخادم. احفظ مفتاح المضيف في هذا المتصفح أو شغّل الخادم في الوضع المحلي.',
    err_no_live: 'التفريغ المباشر غير متاح: لا يوجد مفتاح OpenAI على الخادم.',
    err_ended: 'انتهت هذه الخطبة.',
    err_realtime: 'تعذّر الوصول إلى خدمة التفريغ المباشر. تحقق من الاتصال بالإنترنت وأعد المحاولة بعد قليل.',
    err_network: 'مشكلة في الشبكة. تحقق من الاتصال وأعد المحاولة.',
    err_timeout: 'لم يستجب الميكروفون أو الاتصال في الوقت المناسب. أعد المحاولة.',
    err_connection: 'انقطع الاتصال بالتفريغ المباشر وتعذّرت استعادته.',
    err_unknown: 'حدث خطأ ما.'
  }
};
registerStrings(LOCAL);

/* ------------------------------------------------------------------- state */
const $ = id => document.getElementById(id);
const SESSION_LIMIT_MIN = 60;
const ACTIVE = new Set(['connecting', 'listening', 'paused', 'stopping']);

const S = {
  roomId: '', session: null, status: 'ready', liveStartedAt: null,
  mode: 'mic', samples: [], sampleId: '', customFile: null, customUrl: '',
  targetIdx: 0, cap: 'idle', capReason: '', attempt: 0,
  conn: 'open', banner: null, notice: '', uploading: false, ending: false, config: null
};
const seenLines = new Set(), feedCache = new Map();
let relayHits = [], cap = null, store = null, closeEvents = null, noticeTimer = null, shareToken = 0;

const targets = () => (S.session?.targetLanguages?.length ? S.session.targetLanguages : [S.session?.language || 'en']);
const sourceLang = () => S.session?.sourceLanguage || 'ar';
const isActive = () => ACTIVE.has(S.cap);
const toast = (() => {
  let timer;
  return message => { const el = $('toast'); el.textContent = message; el.hidden = false; clearTimeout(timer); timer = setTimeout(() => { el.hidden = true; }, 2200); };
})();

/* -------------------------------------------------------------------- gate */
function showGate({ title, body = '', link = null, actions = [], loading = false }) {
  document.body.dataset.view = 'gate';
  $('gate').hidden = false; $('console').hidden = true; $('page-foot').hidden = true;
  $('gate').classList.toggle('is-static', !loading);
  $('gate-title').textContent = title;
  const bodyEl = $('gate-body');
  if (link && body.includes(link.label)) { const [a, b] = body.split(link.label); bodyEl.replaceChildren(a, h('a', { href: link.href, dir: 'ltr', text: link.label }), b); }
  else bodyEl.textContent = body;
  bodyEl.hidden = !body;
  $('gate-actions').replaceChildren(...actions.map(a => h('a', { class: a.primary ? 'btn btn-primary' : 'btn', href: a.href, text: a.label })));
  renderBar();
}

/* ------------------------------------------------------------------ banner */
function setBanner(banner) { S.banner = banner; renderBanner(); }
function errorText(code, raw) {
  const key = `err_${String(code).replace(/-/g, '_')}`;
  const own = LOCAL.en[key];
  return own ? t(key) : (raw || t('err_unknown'));
}
function renderBanner() {
  const b = S.banner, el = $('banner');
  el.hidden = !b;
  if (!b) return;
  el.className = `banner banner-${b.kind || 'error'}`;
  $('banner-text').textContent = b.code ? errorText(b.code, b.raw) : b.text;
  const actions = [];
  if (b.code === 'no-owner') actions.push(h('a', { class: 'btn', href: pageUrl('listen', S.roomId, {}, { base: null }), text: t('go_listen') }));
  else if (b.retry && !isActive() && !S.ended) actions.push(h('button', { type: 'button', class: 'btn', onclick: () => void onPrimary(), text: t('start_again') }));
  actions.push(h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { if (b.mismatch) S.mismatchDismissed = S.sampleId; setBanner(null); }, text: t('close') }));
  $('banner-actions').replaceChildren(...actions);
}
function showNotice(text) {
  S.notice = text; renderNotice();
  clearTimeout(noticeTimer);
  if (text) noticeTimer = setTimeout(() => { S.notice = ''; renderNotice(); }, 9000);
}
function renderNotice() {
  const el = $('notice');
  const text = S.conn !== 'open' ? t('events_reconnecting') : S.notice || (S.status === 'live' && elapsedSec() >= (SESSION_LIMIT_MIN - 5) * 60 ? t('session_limit_soon') : '');
  el.textContent = text; el.hidden = !text;
}

/* ------------------------------------------------------------- header/status */
const elapsedSec = () => (S.liveStartedAt ? Math.max(0, (Date.now() - Date.parse(S.liveStartedAt)) / 1000) : 0);

function statusLabel() {
  if (S.ended) return t('ended');
  switch (S.cap) {
    case 'connecting': return S.attempt ? t('reconnecting_n', { n: S.attempt }) : t('status_connecting');
    case 'listening': return t('live');
    case 'paused': return t('paused');
    case 'stopping': return t('stopping');
    case 'stopped': return t('stopped');
    case 'error': return t('status_error');
    default: return S.status === 'live' ? t('paused') : t('status_idle');
  }
}
function renderStatus() {
  const live = S.cap === 'listening' && !S.ended;
  $('live-dot').classList.toggle('is-idle', !live);
  const block = $('state');
  block.classList.toggle('is-live', live);
  block.classList.toggle('is-error', S.cap === 'error');
  $('status-text').textContent = statusLabel();
  const showElapsed = Boolean(S.liveStartedAt) && !S.ended;
  $('elapsed').hidden = !showElapsed;
  if (showElapsed) $('elapsed').textContent = formatDuration(elapsedSec());
  renderNotice();
}
/** Top bar: room title + live state appear once the console is up; gate states keep just the wordmark and menu. */
function renderBar() {
  const on = Boolean(S.consoleReady) && document.body.dataset.view === 'console';
  $('room-title').hidden = !on || !S.session?.title;
  $('state').hidden = !on;
  const other = getUiLang() === 'ar' ? 'en' : 'ar';
  $('ui-lang-label').textContent = other === 'ar' ? 'العربية' : 'English';
  $('ui-lang-label').lang = other;
}

/* ------------------------------------------------------------ source + controls */
const currentSample = () => S.samples.find(s => s.id === S.sampleId) || null;
const sampleTitle = s => (getUiLang() === 'ar' && s.titleAr ? s.titleAr : s.title);

function renderSamples() {
  const sel = $('sample');
  const prefer = sourceLang();
  const ordered = [...S.samples].sort((a, b) => (b.language === prefer) - (a.language === prefer));
  const opts = ordered.map(s => h('option', { value: s.id, text: `${sampleTitle(s)} · ${langName(s.language)} · ${formatDuration(s.durationSec)}` }));
  if (S.customFile) opts.push(h('option', { value: '__file__', text: t('my_file', { name: S.customFile.name }) }));
  sel.replaceChildren(...opts);
  sel.value = S.sampleId;
  if (!sel.value && opts.length) { S.sampleId = opts[0].value; sel.value = S.sampleId; }
}

function applyAudioSource() {
  const player = $('player');
  let src = '', name = '';
  if (S.sampleId === '__file__' && S.customUrl) { src = S.customUrl; name = S.customFile.name; }
  else if (currentSample()) { src = `/samples/${currentSample().file}`; name = sampleTitle(currentSample()); }
  const absolute = src ? new URL(src, location.href).href : '';
  if (absolute && player.src !== absolute) { player.src = src; player.load(); }
  $('player-name').textContent = name;
  renderPlayer();
}

function renderPlayer() {
  const p = $('player');
  const dur = Number.isFinite(p.duration) ? p.duration : (currentSample()?.durationSec || 0);
  const pos = p.currentTime || 0;
  $('player-time').textContent = `${formatDuration(pos)} / ${formatDuration(dur)}`;
  const frac = dur ? Math.min(1, pos / dur) : 0;
  $('player-fill').style.transform = `scaleX(${frac})`;
  $('player-bar').setAttribute('aria-valuenow', String(Math.round(frac * 100)));
}

function renderControls() {
  const file = S.mode === 'file';
  const gone = Boolean(S.ended);
  $('file-panel').hidden = !file || gone;
  $('mode-group').hidden = gone;
  $('primary').hidden = gone;
  $('meter-wrap').hidden = gone;
  $('ended-note').hidden = !gone;
  for (const input of document.querySelectorAll('input[name="mode"]')) { input.checked = input.value === S.mode; input.disabled = isActive(); }
  $('meter-label').textContent = file ? t('audio_level') : t('mic_level');
  $('sample').disabled = isActive();
  $('pick-file').disabled = isActive();

  const btn = $('primary'), iconSlot = $('primary-icon'), label = $('primary-label');
  btn.classList.remove('is-stop');
  btn.classList.add('btn-primary');
  btn.disabled = false;
  let iconHtml, text;
  if (S.ended) { btn.disabled = true; iconHtml = ''; text = t('ended_cannot_start'); }
  else if (S.cap === 'connecting' && !S.attempt) { btn.disabled = true; iconHtml = '<span class="spinner"></span>'; text = t('status_connecting'); }
  else if (S.cap === 'connecting' || S.cap === 'listening' || S.cap === 'paused') { btn.classList.add('is-stop'); btn.classList.remove('btn-primary'); iconHtml = icon('stop'); text = t('stop'); }
  else if (S.cap === 'stopping') { btn.disabled = true; iconHtml = '<span class="spinner"></span>'; text = t('stopping'); }
  else {
    const again = S.cap === 'stopped' || S.cap === 'error';
    iconHtml = file ? icon('play') : icon('mic');
    text = again ? t('start_again') : t('start');
  }
  iconSlot.innerHTML = iconHtml;
  label.textContent = text;

  const showPause = S.cap === 'listening' || S.cap === 'paused';
  $('pause-btn').hidden = !showPause || gone;
  $('pause-btn').textContent = S.cap === 'paused' ? t('resume') : t('pause');

  const off = !(S.cap === 'listening');
  $('meter').classList.toggle('is-off', off);

  const sample = currentSample();
  const mismatch = file && S.sampleId !== '__file__' && sample && sample.language !== sourceLang() && S.mismatchDismissed !== S.sampleId;
  if (mismatch && !S.banner) setBanner({ kind: 'warn', text: t('sample_lang_mismatch', { lang: langName(sample.language, { native: false }), room: langName(sourceLang(), { native: false }) }), mismatch: true });
  else if (!mismatch && S.banner?.mismatch) setBanner(null);

  $('new-room').hidden = !S.ended;
  setDisabled($('transcribe-btn'), S.ended || S.uploading || isActive());
  setDisabled($('end-btn'), S.ended || S.ending);
}

function setDisabled(el, on) { el.disabled = on; el.toggleAttribute('aria-disabled', on); }

function setLevel(level) {
  $('meter-fill').style.transform = `scaleX(${level})`;
  $('meter').setAttribute('aria-valuenow', String(Math.round(level * 100)));
}

/* ------------------------------------------------------------------ live panel */
const targetCode = () => targets()[Math.min(S.targetIdx, targets().length - 1)];

function renderTargets() {
  const list = targets();
  const box = $('tgt-tabs');
  box.hidden = list.length < 2;
  box.replaceChildren(...list.map((code, i) => {
    const input = h('input', { type: 'radio', name: 'tgt', value: code, checked: i === S.targetIdx, onchange: () => { S.targetIdx = i; renderTargets(); renderFeed({ stick: true }); renderShare(); } });
    return h('label', { class: 'chip' }, input, h('span', { lang: code, dir: dirOf(code), text: langName(code) }));
  }));
}

/** Compact verse block under a segment: label, canonical Arabic (Amiri Quran), translation in the target language + its source. */
function verseEl(v, code) {
  return h('div', { class: 'verse' },
    h('div', { class: 'verse-ref' }, h('span', { dir: 'auto', text: v.label }), v.approximate && h('span', { class: 'verse-tag', text: t('likely_match') })),
    v.arabic && h('p', { class: 'quran verse-ar', lang: 'ar', dir: 'rtl', text: v.arabic }),
    v.translation && h('p', { class: 'verse-tr', lang: code, dir: dirOf(code), text: v.translation }),
    v.source && h('p', { class: 'verse-src', lang: 'en', text: v.source }));
}

function lineEl(seg) {
  const code = targetCode();
  const tr = textFor(seg, code);
  const pending = !tr && seg.translationStatus !== 'failed';
  const verses = quranCitations(seg).map(c => verseView(c, code, '', getUiLang()));
  const key = [seg.id, seg.text, tr, seg.status, seg.translationStatus, code, getUiLang(), JSON.stringify(verses)].join('|');
  const prev = feedCache.get(seg.id);
  if (prev?.key === key) return prev.el;
  const fresh = !seenLines.has(seg.id); seenLines.add(seg.id);
  const el = h('article', { class: `line${fresh && S.feedReady ? ' is-new' : ''}`, 'data-id': seg.id },
    h('p', { class: 'src caption', lang: sourceLang(), dir: dirOf(sourceLang()), text: seg.text }),
    h('p', { class: `tr caption${tr ? '' : ' pending'}`, lang: code, dir: dirOf(code), text: tr || (pending ? t('translating') : t('translation_failed')) }),
    ...verses.map(v => verseEl(v, code)),
    seg.status === 'double-checked' && h('span', { class: 'tag', html: `${icon('check')}${t('double_checked')}` }));
  feedCache.set(seg.id, { key, el });
  return el;
}

function renderFeed({ stick = false } = {}) {
  const feed = $('feed');
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
  const segments = store.segments, draft = store.partial;
  if (!segments.length && !draft) feed.replaceChildren(h('div', { class: 'empty-note' }, h('p', { text: t('transcript_empty') })));
  else {
    const nodes = segments.map(lineEl);
    if (draft) nodes.push(h('article', { class: 'line draft' }, h('p', { class: 'src caption', lang: sourceLang(), dir: dirOf(sourceLang()), text: draft.text })));
    feed.replaceChildren(...nodes);
  }
  S.feedReady = true;
  if (stick || nearBottom) { feed.scrollTop = feed.scrollHeight; $('jump').hidden = true; }
  else $('jump').hidden = false;
}

/* ------------------------------------------------------------------ share */
async function renderShare() {
  const token = ++shareToken;
  const code = targetCode();
  $('room-code').textContent = S.session.code || '';
  $('open-listen').href = pageUrl('listen', S.roomId);
  const isPublic = S.session.visibility !== 'private';
  $('share-private').hidden = isPublic;
  $('share-private').textContent = t('share_private');
  $('share-qr-box').hidden = !isPublic;
  const url = await sharePageUrl('listen', S.roomId);
  if (token !== shareToken) return;
  $('phone-link').value = url;
  $('hall-link').value = await sharePageUrl('screen', S.roomId, { lang: code });
  if (token !== shareToken) return;
  if (isPublic) {
    const img = $('share-qr');
    img.alt = `${t('scan_to_join')}: ${S.session.code || ''}`;
    img.onerror = () => { $('share-qr-box').hidden = true; };
    const src = qrSrc(S.roomId, url);
    if (!img.src.endsWith(src)) img.src = src;
  }
  $('open-screen').dataset.lang = code;
}

function bindCopy(buttonId, getText) {
  const btn = $(buttonId);
  btn.addEventListener('click', async () => {
    const ok = await copyText(getText());
    toast(ok ? t('copied') : t('error'));
    if (ok) { btn.innerHTML = icon('check'); setTimeout(() => { btn.innerHTML = icon('copy'); }, 1500); }
  });
}

/* ---------------------------------------------------------------- capture */
function wireCapture() {
  cap = createCapture({ sessionId: S.roomId });
  cap.on('status', ({ state, reason, attempt }) => {
    S.cap = state; S.capReason = reason || ''; S.attempt = state === 'connecting' ? (attempt || 0) : 0;
    if (state === 'stopped' && reason === 'file-ended') toast(t('audio_done'));
    if (state === 'listening') setBanner(S.banner?.mismatch ? S.banner : null);
    renderStatus(); renderControls();
  });
  cap.on('level', setLevel);
  cap.on('error', ({ code, message }) => {
    if (code === 'ended') { markEnded(); return; }
    setBanner({ kind: 'error', code, raw: message, retry: true });
  });
  cap.on('notice', ({ level, message }) => {
    if (level !== 'warn') return;
    // One dropped relay packet is normal (a busy tab); only warn when it keeps happening.
    if (/relay|original audio/i.test(message)) {
      const now = Date.now();
      relayHits = relayHits.filter(x => now - x < 10000).concat(now);
      if (relayHits.length < 3) return;
    }
    showNotice(/relay|original audio/i.test(message) ? t('notice_relay') : /double-check/i.test(message) ? t('notice_verify') : t('notice_generic'));
  });
}

async function onPrimary() {
  if (S.ended) return;
  if (S.cap === 'connecting' || S.cap === 'listening' || S.cap === 'paused') { await cap.stop(); return; }
  if (S.cap === 'stopping') return;
  setBanner(null);
  if (S.mode === 'file' && !($('player').getAttribute('src'))) { setBanner({ kind: 'error', text: t('pick_audio') }); return; }
  if (S.config && S.config.liveAvailable === false) { setBanner({ kind: 'error', code: 'no-live' }); return; }
  await cap.start({ kind: S.mode, audio: S.mode === 'file' ? $('player') : undefined });
}

/* ----------------------------------------------------------- session events */
function syncSession(session) {
  if (!session) return;
  S.session = { ...S.session, ...session };
  S.status = session.status || S.status;
  S.liveStartedAt = session.liveStartedAt || S.liveStartedAt;
  if (S.status === 'ended') markEnded();
  renderStatus(); renderControls();
}
function markEnded(reason) {
  if (reason && /time limit/i.test(reason)) setBanner({ kind: 'warn', text: t('session_limit') });
  if (S.ended) return;
  S.ended = true; S.status = 'ended';
  if (isActive()) void cap.stop({ reason: 'ended' });
  renderStatus(); renderControls();
}
function onEventStatus(ev) {
  if (ev.status === 'ended') markEnded(ev.reason);
  else if (ev.status) { S.status = ev.status; if (ev.status === 'live' && !S.liveStartedAt) S.liveStartedAt = new Date().toISOString(); renderStatus(); }
}

/* --------------------------------------------------------------- actions */
async function doEnd() {
  if (S.ending || S.ended) return;
  S.ending = true; renderControls();
  try {
    await cap.stop();
    await api(`/api/sessions/${encodeURIComponent(S.roomId)}`, { method: 'PATCH', owner: S.roomId, body: { status: 'ended' } });
    markEnded();
    toast(t('ended'));
  } catch (e) {
    setBanner({ kind: 'error', text: `${t('ending_failed')} ${e.message || ''}`.trim() });
  } finally { S.ending = false; renderControls(); }
}

async function doUpload(file) {
  if (!file) return;
  const status = $('upload-status');
  status.classList.remove('error-text');
  if (file.size > 25 * 1024 * 1024) { status.textContent = t('upload_big'); status.classList.add('error-text'); return; }
  S.uploading = true; renderControls();
  status.textContent = t('uploading', { name: file.name });
  try {
    await ensureLocalAccess();
    await uploadAudioFile(S.roomId, file);
    status.textContent = t('upload_done', { name: file.name });
  } catch (e) {
    status.textContent = e.message || t('err_unknown'); status.classList.add('error-text');
  } finally { S.uploading = false; renderControls(); }
}

/* ------------------------------------------------------------------ boot */
function renderAll() {
  applyUiLang();
  if (!S.session) return renderBar();
  document.title = `${S.session.title || ''} · ${t('khatib_console')}`;
  $('room-title').textContent = S.session.title || t('khatib_console');
  renderBar();
  renderSamples(); renderTargets(); renderStatus(); renderControls(); renderBanner(); renderFeed({ stick: true }); renderShare();
  $('export-txt').href = exportUrl(S.roomId, 'txt');
  $('export-json').href = exportUrl(S.roomId, 'json');
  applyAudioSource();
}

function resolveRoomId(param) {
  if (/^[0-9a-f-]{36}$/i.test(param)) return param.toLowerCase();
  const code = param.toUpperCase();
  return listRooms().find(r => (r.code || '').toUpperCase() === code)?.id || param;
}

function showNoOwner(session) {
  S.reGate = () => showNoOwner(session);
  showGate({
    title: t('owner_missing_title'), body: t('owner_missing_body'),
    actions: [{ primary: true, label: t('go_listen'), href: pageUrl('listen', session?.id || S.roomId, {}, { base: null }) }, { label: t('back_home'), href: '/' }]
  });
}

/* -------------------------------------------------------------------- menu */
function setMenu(open) {
  $('menu').hidden = !open;
  $('menu-btn').setAttribute('aria-expanded', String(open));
}
function wireMenu() {
  $('menu-btn').addEventListener('click', () => setMenu($('menu').hidden));
  document.addEventListener('click', e => { if (!$('menu').hidden && !e.target.closest('.menu-wrap')) setMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('menu').hidden) { setMenu(false); $('menu-btn').focus(); } });
  for (const a of ['export-txt', 'export-json']) $(a).addEventListener('click', () => setMenu(false));
}

async function boot() {
  $('ui-lang').addEventListener('click', () => { setMenu(false); setUiLang(getUiLang() === 'ar' ? 'en' : 'ar'); });
  onUiLangChange(() => { if (S.consoleReady) renderAll(); else { applyUiLang(); (S.reGate || showBootGate)(); } });
  wireMenu();
  applyUiLang();
  showBootGate();

  const params = urlParams();
  const param = (params.get('room') || '').trim();
  const demo = params.get('demo') === '1';
  if (!param) { S.noRoom = true; showBootGate(); return; }
  S.roomId = resolveRoomId(param);

  // Operator access (/api/local-access) only works from a loopback origin. Opened from a LAN address (e.g. the
  // computer's own 192.168.x.x) the console cannot start capture, so say so instead of failing with a 403.
  let hostKey = ''; try { hostKey = localStorage.getItem('minbar-host-key') || ''; } catch { /* storage unavailable */ }
  // With OPEN_ACCESS (public deployments) there is no host key and no loopback requirement, so never gate on the address.
  const openAccess = Boolean((await getConfig().catch(() => null))?.openAccess);
  if (!openAccess && isLanHost() && !hostKey) {
    const url = `${localConsoleUrl()}${pageUrl('khatib', S.roomId, demo ? { demo: 1 } : {}, { base: null })}`;
    S.reGate = () => showGate({ title: t('lan_gate_title'), body: t('lan_gate_body', { url: localConsoleUrl() }), link: { label: localConsoleUrl(), href: url }, actions: [{ label: t('go_listen'), href: pageUrl('listen', S.roomId, {}, { base: null }) }] });
    return S.reGate();
  }

  let session;
  try { session = await getSession(S.roomId); }
  catch (e) {
    if (e.status === 401) return showNoOwner(null);
    S.fatal = e.status === 404 ? 'room_not_found' : null; S.fatalMsg = e.message;
    return showBootGate();
  }
  S.roomId = session.id;
  S.session = session;
  saveRoom(session.id, { title: session.title, code: session.code, sourceLanguage: session.sourceLanguage, targetLanguages: session.targetLanguages, visibility: session.visibility });
  if (!ownerToken(session.id)) return showNoOwner(session);

  S.status = session.status || 'ready';
  S.liveStartedAt = session.liveStartedAt || null;
  S.ended = S.status === 'ended';
  S.config = await getConfig().catch(() => null);
  ensureLocalAccess();

  // samples
  S.samples = await loadSamples();
  if (!Array.isArray(S.samples)) S.samples = [];
  const preferred = S.samples.find(s => s.language === session.sourceLanguage) || S.samples[0];
  S.sampleId = preferred?.id || '';
  if (demo && preferred) S.mode = 'file';

  store = createSegmentStore();
  store.applySnapshot(session);
  store.onChange(() => renderFeed());
  wireCapture();

  S.consoleReady = true;
  document.body.dataset.view = 'console';
  $('gate').hidden = true; $('console').hidden = false; $('page-foot').hidden = false;
  renderAll();

  /* wiring */
  for (const input of document.querySelectorAll('input[name="mode"]')) input.addEventListener('change', () => { S.mode = input.value; setBanner(null); renderControls(); });
  $('sample').addEventListener('change', e => { S.sampleId = e.target.value; setBanner(null); applyAudioSource(); renderControls(); });
  $('pick-file').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (S.customUrl) URL.revokeObjectURL(S.customUrl);
    S.customFile = f; S.customUrl = URL.createObjectURL(f); S.sampleId = '__file__'; S.mode = 'file';
    renderSamples(); applyAudioSource(); renderControls();
  });
  const player = $('player');
  for (const ev of ['timeupdate', 'loadedmetadata', 'durationchange', 'ended']) player.addEventListener(ev, renderPlayer);
  $('primary').addEventListener('click', () => void onPrimary());
  $('pause-btn').addEventListener('click', () => (S.cap === 'paused' ? cap.resume() : cap.pause()));
  $('share-btn').addEventListener('click', () => { renderShare(); $('share-dialog').showModal(); });
  $('share-close').addEventListener('click', () => $('share-dialog').close());
  $('share-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $('open-screen').addEventListener('click', () => window.open(pageUrl('screen', S.roomId, { lang: targetCode() }), '_blank', 'noopener'));
  bindCopy('copy-code', () => S.session.code || '');
  bindCopy('copy-link', () => $('phone-link').value);
  bindCopy('copy-hall', () => $('hall-link').value);
  for (const id of ['phone-link', 'hall-link']) $(id).addEventListener('focus', e => e.target.select());
  $('transcribe-btn').addEventListener('click', () => { setMenu(false); $('upload-input').click(); });
  $('upload-input').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; void doUpload(f); });
  const dialog = $('end-dialog');
  $('end-btn').addEventListener('click', () => { setMenu(false); if (typeof dialog.showModal === 'function') dialog.showModal(); else if (confirm(t('end_confirm'))) void doEnd(); });
  dialog.addEventListener('close', () => { if (dialog.returnValue === 'end') void doEnd(); dialog.returnValue = ''; });
  $('feed').addEventListener('scroll', () => { const f = $('feed'); if (f.scrollHeight - f.scrollTop - f.clientHeight < 90) $('jump').hidden = true; }, { passive: true });
  $('jump').addEventListener('click', () => { const f = $('feed'); f.scrollTo({ top: f.scrollHeight, behavior: 'smooth' }); $('jump').hidden = true; });
  addEventListener('beforeunload', e => { if (isActive()) { e.preventDefault(); e.returnValue = ''; } });
  addEventListener('pagehide', () => { closeEvents?.(); });

  closeEvents = subscribe(session.id, {
    ...store.handlers,
    onSnapshot: snap => { store.handlers.onSnapshot(snap); syncSession(snap); },
    onStatus: onEventStatus,
    onConnection: state => { S.conn = state === 'open' ? 'open' : state; renderStatus(); }
  }, { owner: true });

  setInterval(renderStatus, 1000);
}

function showBootGate() {
  if (S.noRoom) return showGate({ title: t('no_room'), body: t('no_room_body'), actions: [{ primary: true, label: t('back_home'), href: '/' }] });
  if (S.fatal) return showGate({ title: t('room_not_found'), actions: [{ primary: true, label: t('back_home'), href: '/' }] });
  if (S.fatalMsg) return showGate({ title: S.fatalMsg, actions: [{ primary: true, label: t('retry'), href: location.href }] });
  showGate({ title: t('loading'), loading: true });
}

boot().catch(e => { console.error(e); S.fatalMsg = e.message || t('err_unknown'); showBootGate(); });
