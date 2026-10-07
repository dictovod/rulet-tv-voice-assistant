const $ = (id) => document.getElementById(id);
const STATE_TEXT = {
  idle: 'Ожидание звонка',
  connecting: 'Подключение к серверу…',
  connected: 'На связи с сервером',
  disconnected: 'Нет связи с сервером',
};
let renderedKey = '';
let latestDebugReport = null;
let copyNoticeTimer;

$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('copyDebug').addEventListener('click', copyDebugReport);

function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n, digits = 2) => String(n).padStart(digits, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatDelay(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `Ответ через ${ms} мс` : `Ответ через ${(ms / 1000).toFixed(1)} с`;
}

function render(transcripts) {
  const key = transcripts.map((item) => `${item.at}:${item.role}:${item.delayMs}:${item.text}`).join('|');
  if (key === renderedKey) return;
  renderedKey = key;
  const box = $('messages');
  box.replaceChildren();
  if (!transcripts.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Здесь появятся распознанные вопросы и ответы.';
    box.appendChild(empty);
    return;
  }
  for (const item of transcripts) {
    const card = document.createElement('article');
    card.className = item.role === 'user' ? 'user' : 'assistant';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = item.role === 'user' ? 'Собеседник' : 'Марина';
    const time = document.createElement('time');
    time.dateTime = new Date(item.at).toISOString();
    time.textContent = formatTime(item.at);
    const text = document.createElement('div');
    text.textContent = item.text;
    card.append(label, time, text);
    if (item.role === 'assistant' && item.delayMs != null) {
      const delay = document.createElement('span');
      delay.className = 'delay';
      delay.textContent = formatDelay(item.delayMs);
      card.appendChild(delay);
    }
    box.appendChild(card);
  }
  box.scrollTop = box.scrollHeight;
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const status = await chrome.runtime.sendMessage({ type: 'get_status', tabId: tab.id });
  const stored = await chrome.storage.local.get('rutv');
  const settings = { ...RUTV.DEFAULTS, ...(stored.rutv || {}) };
  $('status').textContent = status.error || STATE_TEXT[status.state] || status.state;
  $('status').className = status.state || '';
  render(status.transcripts || []);
  latestDebugReport = makeDebugReport(tab, status, settings);
}

function safeEndpoint(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch (_) { return 'invalid or unavailable'; }
}

function makeDebugReport(tab, status, settings) {
  let pageHost = 'unavailable';
  try { pageHost = new URL(tab.url).host; } catch (_) {}
  return {
    captured_at: new Date().toISOString(),
    extension: {
      name: chrome.runtime.getManifest().name,
      version: chrome.runtime.getManifest().version,
      id: chrome.runtime.id,
    },
    server: status.serverInfo || null,
    browser: { user_agent: navigator.userAgent, language: navigator.language },
    page_host: pageHost,
    connection: { state: status.state, error: status.error || null },
    settings: {
      auto_response_enabled: settings.enabled && settings.mode === 'auto',
      mode: settings.mode,
      monitor: settings.monitor,
      greeting_enabled: settings.greetingEnabled,
      greeting: settings.greeting,
      protect_greeting: settings.protectGreeting,
      video_delay_ms: settings.videoDelayMs,
      silence_ms: settings.silenceMs,
      response_pause_ms: settings.responsePauseMs,
      server_endpoint: safeEndpoint(settings.serverUrl),
    },
    timing_notes: {
      response_delay_ms: 'Measured from the recognized user transcript timestamp to the first TTS audio frame received by the extension.',
      response_pause_ms: 'Additional intentional pause after the model creates reply text and before speech synthesis starts.',
      tuning: 'If replies feel rushed, increase response_pause_ms in small 100-200 ms steps. If replies feel slow, reduce it. silence_ms controls end-of-utterance detection, not thinking time.',
    },
    conversation: (status.transcripts || []).map((item) => ({
      role: item.role,
      text: item.text,
      transcript_at: item.at ? new Date(item.at).toISOString() : null,
      first_audio_at: item.audioAt ? new Date(item.audioAt).toISOString() : null,
      response_delay_ms: item.delayMs,
    })),
  };
}

async function copyDebugReport() {
  const button = $('copyDebug');
  try {
    if (!latestDebugReport) throw new Error('Диагностика ещё загружается');
    await navigator.clipboard.writeText(JSON.stringify(latestDebugReport, null, 2));
    $('copyState').textContent = 'Скопировано. Отчёт включает историю разговора.';
    button.textContent = 'Скопировано';
  } catch (error) {
    $('copyState').textContent = `Не удалось скопировать: ${error.message}`;
  }
  clearTimeout(copyNoticeTimer);
  copyNoticeTimer = setTimeout(() => {
    $('copyState').textContent = '';
    button.textContent = 'Копировать для отладки';
  }, 3000);
}

refresh();
setInterval(() => refresh().catch(() => {}), 700);
