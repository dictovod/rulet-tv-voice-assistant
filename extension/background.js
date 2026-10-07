/**
 * background.js — service worker (MV3).
 * Держит WebSocket к локальному Python-серверу: по одному на звонящую вкладку/фрейм.
 * Логика учёта по вкладкам и очистка в tabs.onRemoved — как tabMediaRegistry в старом плагине.
 * WebSocket живёт здесь, а не на странице, чтобы его не блокировал CSP rulet.tv.
 */
importScripts('logger.js', 'shared.js');

const logger = new PluginLogger('background');
const RECONNECT_MS = [1000, 2000, 5000];

function safeServerAddress(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch (_) { return 'invalid'; }
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => {
  logger.warn('Не удалось включить боковую панель', { message: String(e) });
});

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
      case 'start':
        this.config = { ...RUTV.DEFAULTS, ...(m.config || {}) };
        updateTabStatus(this.tabId, { transcripts: [], lastUserAt: null, error: '', serverInfo: null });
        this.open();
        break;
      case 'settings': {
        const reconnect = this.config.serverUrl !== m.config.serverUrl || this.config.authToken !== m.config.authToken;
        this.config = m.config;
        if (reconnect) {
          this.attempt = 0;
          if (this.ws) {
            const old = this.ws;
            this.ws = null;
            old.close();
          }
          this.open();
          break;
        }
        this.sendJson({ type: 'settings', ...this.serverSettings() });
        break;
      }
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
      const url = new URL(this.config.serverUrl);
      if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('serverUrl must use ws:// or wss://');
      if (this.config.authToken) url.searchParams.set('token', this.config.authToken);
      ws = new WebSocket(url.toString());
    } catch (e) {
      logger.error('Некорректный serverUrl', { url: safeServerAddress(this.config.serverUrl) });
      this.setState('disconnected');
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setState('connected');
      // resumed=true — после переподключения сервер не будет повторять приветствие
      this.sendJson({ type: 'start', ...this.serverSettings(), resumed: this.everConnected });
      this.everConnected = true;
      logger.info('WebSocket подключён', { tab: this.tabId });
    };
    ws.onmessage = (e) => this.onServerMessage(e.data);
    ws.onerror = () => logger.warn('Ошибка WebSocket', { url: safeServerAddress(this.config.serverUrl) });
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

  serverSettings() {
    return {
      mode: this.config.mode,
      greeting_enabled: this.config.greetingEnabled,
      greeting: this.config.greeting,
      protect_greeting: this.config.protectGreeting,
      silence_ms: this.config.silenceMs,
      response_pause_ms: this.config.responsePauseMs,
    };
  }

  onServerMessage(data) {
    if (typeof data !== 'string') {
      const cur = tabStatus.get(this.tabId);
      if (cur && cur.lastUserAt) {
        const transcripts = [...cur.transcripts];
        const audioAt = Date.now();
        for (let i = transcripts.length - 1; i >= 0; i--) {
          const item = transcripts[i];
          if (item.role !== 'assistant' || item.at < cur.lastUserAt || item.delayMs != null) continue;
          transcripts[i] = { ...item, audioAt, delayMs: audioAt - cur.lastUserAt };
          updateTabStatus(this.tabId, { transcripts });
          break;
        }
      }
      this.toPage({ type: 'tts_audio', data: RUTV.u8ToB64(new Uint8Array(data)) });
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    switch (msg.type) {
      case 'transcript': {
        const cur = tabStatus.get(this.tabId) || { transcripts: [] };
        const at = Date.now();
        const lastUserAt = msg.role === 'user' ? at : cur.lastUserAt;
        const entry = {
          role: msg.role,
          text: msg.text,
          at,
          delayMs: null,
        };
        const list = [...cur.transcripts, entry].slice(-100);
        updateTabStatus(this.tabId, { transcripts: list, lastUserAt });
        break;
      }
      case 'server_info':
        updateTabStatus(this.tabId, { serverInfo: msg });
        break;
      case 'tts_start':
      case 'tts_end':
      case 'interrupt':
        this.toPage(msg);
        break;
      case 'dialog_ended':
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
    const patch = { state };
    if (state === 'connected') patch.error = '';
    updateTabStatus(this.tabId, patch);
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
