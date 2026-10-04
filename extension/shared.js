/**
 * shared.js — общие константы и хелперы.
 * Подключается: в content-script (manifest), в service worker (importScripts) и в popup (<script>).
 */
const RUTV = (() => {
  /** Настройки по умолчанию (хранятся в chrome.storage.local под ключом "rutv"). */
  const DEFAULTS = {
    enabled: false,                          // главный переключатель
    mode: 'auto',                            // 'auto' — отвечает голосом; 'listen' — только слушает
    monitor: true,                           // слышать ту же озвучку через динамики ПК
    serverUrl: 'ws://127.0.0.1:8765/ws',     // адрес локального Python-сервера
  };

  /** Uint8Array → base64. chrome.runtime-порты передают только JSON, поэтому бинарные данные кодируем. */
  function u8ToB64(u8) {
    let s = '';
    const step = 0x8000;
    for (let i = 0; i < u8.length; i += step) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + step));
    }
    return btoa(s);
  }

  /** base64 → ArrayBuffer. */
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }

  return { DEFAULTS, u8ToB64, b64ToBuf };
})();
