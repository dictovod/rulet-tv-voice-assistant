/**
 * background.js — service worker (MV3).
 * Держит WebSocket к локальному Python-серверу: по одному на звонящую вкладку/фрейм.
 * Логика учёта по вкладкам и очистка в tabs.onRemoved — как tabMediaRegistry в старом плагине.
 * WebSocket живёт здесь, а не на странице, чтобы его не блокировал CSP rulet.tv.
 */
importScripts('logger.js', 'shared.js');

const logger = new PluginLogger('background');
const RECONNECT_MS = [1000, 2000, 5000];

/** tabId → { state, transcripts[] } — для popup и бейджа. */
const tabStatus = new Map();

function updateTabStatus(tabId, patch) {
  if (tabId == null) return;
  const cur = tabStatus.get(tabId) || { state: 'idle', transcripts: [] };
  tabStatus.set(tabId, { ...cur, ...patch });
}

class Session {
  constructor(port) {
    this.port = port;
    this.tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
    this.config = { ...RUTV.DEFAULTS };
    this.ws = null;
    this.closed = false;
    this.attempt = 0;
    this.everConnected = false;
    this.timer = null;
  }

  onPortMessage(m) {
    switch (m.type) {
      case 'start': this.config = m.config; this.open(); break;
      case 'settings':
        this.config = m.config;
        this.sendJson({ type: 'settings', mode: this.config.mode });
        break;
      case 'audio':
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(RUTV.b64ToBuf(m.data));
        break;
      default: break;
    }
  }

  open() {
    if (this.closed) return;
    this.setState('connecting');
    let ws;
    try {
      ws = new WebSocket(this.config.serverUrl);
    } catch (e) {
      logger.error('Некорректный serverUrl', { url: this.config.serverUrl });
      this.setState('disconnected');
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setState('connected');
      // resumed=true — после переподключения сервер не будет повторять приветствие
      this.sendJson({ type: 'start', mode: this.config.mode, resumed: this.everConnected });
      this.everConnected = true;
      logger.info('WebSocket подключён', { tab: this.tabId });
    };
    ws.onmessage = (e) => this.onServerMessage(e.data);
    ws.onerror = () => logger.warn('Ошибка WebSocket', { url: this.config.serverUrl });
    ws.onclose = () => {
      if (this.ws !== ws || this.closed) return;   // намеренное закрытие: статус уже «idle»
      this.setState('disconnected');
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    const delay = RECONNECT_MS[Math.min(this.attempt++, RECONNECT_MS.length - 1)];
    this.timer = setTimeout(() => this.open(), delay);
  }

  sendJson(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  onServerMessage(data) {
    if (typeof data !== 'string') {                       // бинарный кадр = PCM16 с TTS
      this.toPage({ type: 'tts_audio', data: RUTV.u8ToB64(new Uint8Array(data)) });
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    switch (msg.type) {
      case 'transcript': {
        const cur = tabStatus.get(this.tabId) || { transcripts: [] };
        const list = [...cur.transcripts, { role: msg.role, text: msg.text }].slice(-8);
        updateTabStatus(this.tabId, { transcripts: list });
        logger.info(`${msg.role}: ${msg.text}`);
        break;
      }
      case 'tts_start':
      case 'tts_end':
      case 'interrupt':
        this.toPage(msg);
        break;
      case 'error':
        logger.error('Ошибка сервера', msg);
        updateTabStatus(this.tabId, { error: msg.message });
        break;
      default: break;
    }
  }

  toPage(msg) {
    try { this.port.postMessage(msg); } catch (_) { /* порт уже закрыт */ }
  }

  setState(state) {
    updateTabStatus(this.tabId, { state, error: state === 'connected' ? '' : undefined });
    if (this.tabId != null) {
      const text = state === 'connected' ? 'ON' : state === 'idle' ? '' : '…';
      chrome.action.setBadgeText({ tabId: this.tabId, text }).catch(() => {});
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.sendJson({ type: 'stop' });
    if (this.ws) { try { this.ws.close(); } catch (_) {} }
    this.setState('idle');
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rutv') return;
  const session = new Session(port);
  port.onMessage.addListener((m) => session.onPortMessage(m));
  port.onDisconnect.addListener(() => session.close());
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'get_status') {
    sendResponse(tabStatus.get(msg.tabId) || { state: 'idle', transcripts: [] });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => tabStatus.delete(tabId));
