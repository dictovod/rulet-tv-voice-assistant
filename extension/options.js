const $ = (id) => document.getElementById(id);
let settings = { ...RUTV.DEFAULTS };
let saveTimer;

async function load() {
  const stored = await chrome.storage.local.get('rutv');
  settings = { ...RUTV.DEFAULTS, ...(stored.rutv || {}) };
  $('enabled').checked = settings.enabled;
  $('mode').value = settings.mode;
  $('monitor').checked = settings.monitor;
  $('serverUrl').value = settings.serverUrl;
  $('authToken').value = settings.authToken;
  $('greetingEnabled').checked = settings.greetingEnabled;
  $('greeting').value = settings.greeting;
  $('protectGreeting').checked = settings.protectGreeting;
  $('videoDelayMs').value = Math.max(3000, Number(settings.videoDelayMs) || 3000);
  $('silenceMs').value = settings.silenceMs;
  $('responsePauseMs').value = settings.responsePauseMs;
}

async function save() {
  const stored = await chrome.storage.local.get('rutv');
  const serverUrl = $('serverUrl').value.trim();
  try {
    const url = new URL(serverUrl);
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.host) throw new Error();
  } catch (_) {
    $('saved').textContent = 'Укажите корректный адрес ws:// или wss://';
    return;
  }
  settings = {
    ...RUTV.DEFAULTS,
    ...(stored.rutv || {}),
    enabled: $('enabled').checked,
    mode: $('mode').value === 'listen' ? 'listen' : 'auto',
    monitor: $('monitor').checked,
    serverUrl,
    authToken: $('authToken').value.trim(),
    greetingEnabled: $('greetingEnabled').checked,
    greeting: $('greeting').value.trim(),
    protectGreeting: $('protectGreeting').checked,
    videoDelayMs: Math.max(3000, Math.min(5000, Number($('videoDelayMs').value) || 3000)),
    silenceMs: Math.max(300, Math.min(3000, Number($('silenceMs').value) || 800)),
    responsePauseMs: Math.max(0, Math.min(3000, Number($('responsePauseMs').value) || 0)),
  };
  $('videoDelayMs').value = settings.videoDelayMs;
  $('silenceMs').value = settings.silenceMs;
  $('responsePauseMs').value = settings.responsePauseMs;
  await chrome.storage.local.set({ rutv: settings });
  $('saved').textContent = 'Сохранено';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { $('saved').textContent = ''; }, 1800);
}

for (const id of ['enabled', 'mode', 'monitor', 'serverUrl', 'authToken', 'greetingEnabled', 'greeting', 'protectGreeting', 'videoDelayMs', 'silenceMs', 'responsePauseMs']) {
  $(id).addEventListener(id === 'greeting' ? 'input' : 'change', save);
}

$('reset').addEventListener('click', async () => {
  const stored = await chrome.storage.local.get('rutv');
  settings = {
    ...RUTV.DEFAULTS,
    ...(stored.rutv || {}),
    enabled: RUTV.DEFAULTS.enabled,
    mode: RUTV.DEFAULTS.mode,
    monitor: RUTV.DEFAULTS.monitor,
    serverUrl: RUTV.DEFAULTS.serverUrl,
    authToken: RUTV.DEFAULTS.authToken,
    greetingEnabled: RUTV.DEFAULTS.greetingEnabled,
    greeting: RUTV.DEFAULTS.greeting,
    protectGreeting: RUTV.DEFAULTS.protectGreeting,
    videoDelayMs: RUTV.DEFAULTS.videoDelayMs,
    silenceMs: RUTV.DEFAULTS.silenceMs,
    responsePauseMs: RUTV.DEFAULTS.responsePauseMs,
  };
  await chrome.storage.local.set({ rutv: settings });
  await load();
  $('saved').textContent = 'Значения по умолчанию восстановлены';
});

load();
