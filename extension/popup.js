/** popup.js — настройки и статус текущей вкладки. */
const STATE_TEXT = {
  idle: 'ожидание звонка',
  connecting: 'подключение к серверу…',
  connected: 'на связи с сервером',
  disconnected: 'нет связи с сервером',
};
const $ = (id) => document.getElementById(id);
let settings = { ...RUTV.DEFAULTS };

async function load() {
  const s = await chrome.storage.local.get('rutv');
  settings = { ...RUTV.DEFAULTS, ...(s.rutv || {}) };
  $('enabled').checked = settings.enabled;
  $('mode').value = settings.mode;
  $('serverUrl').value = settings.serverUrl;
  $('monitor').checked = settings.monitor;
}

function save() {
  settings = {
    enabled: $('enabled').checked,
    mode: $('mode').value,
    serverUrl: $('serverUrl').value.trim() || RUTV.DEFAULTS.serverUrl,
    monitor: $('monitor').checked,
  };
  chrome.storage.local.set({ rutv: settings });
}

async function refreshStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const st = await chrome.runtime.sendMessage({ type: 'get_status', tabId: tab.id });
  $('state').textContent = STATE_TEXT[st.state] || st.state;
  $('error').textContent = st.error || '';
  const log = $('log');
  log.replaceChildren();
  for (const t of st.transcripts || []) {
    const div = document.createElement('div');
    div.className = t.role === 'user' ? 'u' : 'a';
    div.textContent = (t.role === 'user' ? 'Собеседник: ' : 'Бот: ') + t.text;
    log.appendChild(div);
  }
}

for (const id of ['enabled', 'mode', 'serverUrl', 'monitor']) $(id).addEventListener('change', save);
load().then(refreshStatus);
setInterval(refreshStatus, 1000);
