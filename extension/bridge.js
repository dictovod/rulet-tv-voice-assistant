/**
 * bridge.js — content-script в ISOLATED-мире. Мост: страница (inject.js) ⇄ background.js.
 * Аналог связки interceptor.js ⇄ content.js из старого плагина, но на postMessage,
 * потому что нужно передавать ArrayBuffer с аудио.
 * Зависит от shared.js (RUTV).
 */
(() => {
  'use strict';

  const CH = '__RUTV__';
  let config = { ...RUTV.DEFAULTS };
  let port = null;
  let sessionWanted = false;

  const toPage = (msg, transfer) => window.postMessage({ [CH]: 1, dir: 'down', ...msg }, '*', transfer || []);

  function pushConfig() {
    toPage({ type: 'config', config: { enabled: config.enabled, mode: config.mode, monitor: config.monitor } });
  }

  async function loadConfig() {
    try {
      const s = await chrome.storage.local.get('rutv');
      config = { ...RUTV.DEFAULTS, ...(s.rutv || {}) };
      pushConfig();
    } catch (e) { console.warn('[RuletTV] storage:', e); }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.rutv) return;
      config = { ...RUTV.DEFAULTS, ...(changes.rutv.newValue || {}) };
      pushConfig();
      if (port) port.postMessage({ type: 'settings', config });
    });
  } catch (_) { /* контекст расширения уже недействителен */ }

  function openPort() {
    if (port) return;
    try {
      port = chrome.runtime.connect({ name: 'rutv' });
    } catch (e) {
      console.warn('[RuletTV] расширение обновлено — перезагрузите вкладку', e);
      return;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      // service worker мог быть перезапущен — переподключаемся, пока звонок идёт
      if (sessionWanted) setTimeout(openPort, 1000);
    });
    port.postMessage({ type: 'start', config });
  }

  function closePort() {
    sessionWanted = false;
    if (port) { try { port.disconnect(); } catch (_) {} port = null; }
  }

  function onPortMessage(m) {
    switch (m.type) {
      case 'tts_audio': {
        const pcm = RUTV.b64ToBuf(m.data);
        toPage({ type: 'tts_audio', pcm }, [pcm]);
        break;
      }
      case 'tts_start': toPage({ type: 'tts_start', sampleRate: m.sample_rate }); break;
      case 'tts_end': toPage({ type: 'tts_end' }); break;
      case 'interrupt': toPage({ type: 'interrupt' }); break;
      default: break;
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[CH] !== 1 || d.dir !== 'up') return;
    switch (d.type) {
      case 'hello': pushConfig(); break;
      case 'session_start': sessionWanted = true; openPort(); break;
      case 'session_end': closePort(); break;
      case 'audio':
        if (port) port.postMessage({ type: 'audio', data: RUTV.u8ToB64(new Uint8Array(d.pcm)) });
        break;
      default: break;
    }
  });

  loadConfig();
})();
