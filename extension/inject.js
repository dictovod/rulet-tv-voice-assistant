/**
 * inject.js — выполняется в MAIN-мире rulet.tv (manifest: world "MAIN", document_start).
 *
 * Что делает:
 *  1. Подменяет window.RTCPeerConnection (наследник нативного) и следит за всеми соединениями,
 *     включая пересозданные во время звонка.
 *  2. Берёт удалённый аудиотрек собеседника (событие 'track'), гонит его через Web Audio,
 *     даунсемплит до 16 кГц mono PCM16 и отправляет в bridge.js (→ background → Python).
 *  3. Создаёт «виртуальный микрофон» (MediaStreamAudioDestinationNode) и подменяет им исходящий
 *     трек через RTCRtpSender.replaceTrack(). TTS-аудио с сервера играется в этот узел.
 *
 * Приёмы из старого плагина (interceptor.js): guard от двойной инжекции, обёртки нативных API
 * с сохранением оригинала и try/catch, чтобы не ломать страницу, дедупликация найденных объектов.
 */
(() => {
  'use strict';

  if (window.__RUTV_INITIALIZED__) return;
  window.__RUTV_INITIALIZED__ = true;

  const NativePC = window.RTCPeerConnection;
  if (!NativePC || !window.RTCRtpSender) return;
  const nativeReplaceTrack = RTCRtpSender.prototype.replaceTrack;

  const CH = '__RUTV__';               // метка сообщений между MAIN и ISOLATED мирами
  const TAG = '[RuletTV]';
  const CAPTURE_RATE = 16000;          // частота, которую ждёт сервер
  const CHUNK_SAMPLES = 1600;          // 100 мс при 16 кГц
  const SESSION_GRACE_MS = 5000;       // сколько ждём удалённое аудио перед завершением звонка
  const VIDEO_TRANSITION_GRACE_MS = 1200;

  const cfg = { enabled: false, mode: 'auto', monitor: true, videoDelayMs: 3000, workletUrl: '' };
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // ───────────────────────── Связь с bridge.js ─────────────────────────

  function toBridge(msg, transfer) {
    window.postMessage({ [CH]: 1, dir: 'up', ...msg }, '*', transfer || []);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[CH] !== 1 || d.dir !== 'down') return;
    onBridgeMessage(d);
  });

  function onBridgeMessage(d) {
    switch (d.type) {
      case 'config': applyConfig(d.config); break;
      case 'tts_start': engine.ttsRate = d.sampleRate || 48000; break;
      case 'tts_audio': if (cfg.enabled) engine.playPcm(d.pcm); break;
      case 'interrupt': engine.stopPlayback(); break;
      case 'dialog_ended': endSession('диалог завершён по запросу собеседника'); break;
      default: break;
    }
  }

  // ───────────────────────── Аудио-движок ─────────────────────────

  /** Простой даунсемплер «усреднением» (box-фильтр): достаточно для речи и STT. */
  class Downsampler {
    constructor(inRate, outRate) {
      this.ratio = inRate / outRate;
      this.pos = 0;
      this.acc = 0;
      this.n = 0;
    }
    process(input) {
      const out = [];
      for (let i = 0; i < input.length; i++) {
        this.acc += input[i];
        this.n++;
        this.pos += 1;
        if (this.pos >= this.ratio) {
          this.pos -= this.ratio;
          out.push(this.acc / this.n);
          this.acc = 0;
          this.n = 0;
        }
      }
      return out;
    }
  }

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.destination = null;       // «виртуальный микрофон»
      this.virtualTrack = null;      // его трек — именно он уходит в replaceTrack
      this.remote = new Map();       // MediaStreamTrack → { source, element } (дедупликация)
      this.capturing = false;
      this.playing = new Set();
      this.nextStart = 0;
      this.ttsRate = 48000;
      this._chunk = new Int16Array(CHUNK_SAMPLES);
      this._filled = 0;
      this.captureSetup = null;
      this.userActivated = false;
      this.pendingRemote = new Set();
      this.pendingPlayback = [];

      const activate = (event) => {
        if (!event.isTrusted) return;
        this.userActivated = true;
        if (!cfg.enabled && !this.ctx) return;
        this.ensure(true);
        if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
        for (const track of this.pendingRemote) {
          if (track.readyState === 'live') this.attachRemote(track);
        }
        this.pendingRemote.clear();
        for (const pcm of this.pendingPlayback.splice(0)) this._playPcm(pcm);
        pcs.forEach(collectRemote);
        syncAll();
      };
      for (const t of ['pointerdown', 'keydown', 'click']) window.addEventListener(t, activate, true);
    }

    ensure() {
      if (this.ctx) return true;
      if (!this.userActivated) return false;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
      this.destination = this.ctx.createMediaStreamDestination();
      this.virtualTrack = this.destination.stream.getAudioTracks()[0];
      this._down = new Downsampler(this.ctx.sampleRate, CAPTURE_RATE);

      // Шина захвата: все удалённые треки суммируются сюда.
      this.bus = this.ctx.createGain();
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      sink.connect(this.ctx.destination);
      this.captureSetup = this._setupCapture(sink);
      return true;
    }

    async _setupCapture(sink) {
      if (this.ctx.audioWorklet && window.AudioWorkletNode && cfg.workletUrl) {
        try {
          await this.ctx.audioWorklet.addModule(cfg.workletUrl);
          this.processor = new AudioWorkletNode(this.ctx, 'rutv-capture', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            processorOptions: { chunkSize: Math.round(this.ctx.sampleRate / 10) },
          });
          this.processor.port.onmessage = (event) => this._onAudioSamples(new Float32Array(event.data));
          this.bus.connect(this.processor);
          this.processor.connect(sink);
          return;
        } catch (e) {
          warn('AudioWorklet не загрузился, включаю резервный захват', e);
        }
      }

      this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
      this.processor.onaudioprocess = (e) => this._onAudioSamples(e.inputBuffer.getChannelData(0));
      this.bus.connect(this.processor);
      this.processor.connect(sink);

      // Политика автоплея: возобновляем контекст по любому действию пользователя.
      const resume = () => { if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); };
      resume();
      for (const t of ['pointerdown', 'keydown', 'click']) window.addEventListener(t, resume, true);
    }

    /** Подключить удалённый трек собеседника к захвату. */
    attachRemote(track) {
      if (this.remote.has(track) || this.pendingRemote.has(track)) return;
      if (!this.ensure()) {
        this.pendingRemote.add(track);
        return;
      }
      const stream = new MediaStream([track]);
      // Обход бага Chromium: MediaStreamSource от удалённого WebRTC-потока отдаёт тишину,
      // пока поток не привязан к media-элементу. Элемент заглушён, чтобы не дублировать звук сайта.
      const element = new Audio();
      element.muted = true;
      element.srcObject = stream;
      element.play().catch(() => {});
      const source = this.ctx.createMediaStreamSource(stream);
      source.connect(this.bus);
      this.remote.set(track, { source, element });
      track.addEventListener('ended', () => this.detachRemote(track), { once: true });
      log('удалённый аудиотрек подключён к захвату');
    }

    detachRemote(track) {
      const rec = this.remote.get(track);
      if (!rec) return;
      try { rec.source.disconnect(); } catch (_) {}
      rec.element.srcObject = null;
      this.remote.delete(track);
    }

    _onAudioSamples(input) {
      if (!this.capturing) return;
      const samples = this._down.process(input);
      for (const s of samples) {
        this._chunk[this._filled++] = (Math.max(-1, Math.min(1, s)) * 32767) | 0;
        if (this._filled === CHUNK_SAMPLES) {
          const out = this._chunk.slice().buffer;
          this._filled = 0;
          toBridge({ type: 'audio', pcm: out }, [out]);
        }
      }
    }

    /** Поставить PCM16 mono (частота this.ttsRate) в очередь воспроизведения без щелчков между кусками. */
    playPcm(buffer) {
      if (!this.ensure()) {
        this.pendingPlayback.push(buffer.slice(0));
        return;
      }
      this._playPcm(buffer);
    }

    _playPcm(buffer) {
      const i16 = new Int16Array(buffer, 0, buffer.byteLength >> 1);
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
      const ab = this.ctx.createBuffer(1, f32.length, this.ttsRate);
      ab.copyToChannel(f32, 0);
      const src = this.ctx.createBufferSource();
      src.buffer = ab;
      src.connect(this.destination);                       // → исходящий трек
      if (cfg.monitor) src.connect(this.ctx.destination);  // → динамики ПК
      const startAt = Math.max(this.ctx.currentTime + 0.05, this.nextStart);
      src.start(startAt);
      this.nextStart = startAt + ab.duration;
      this.playing.add(src);
      src.onended = () => this.playing.delete(src);
    }

    /** Барж-ин: оборвать всё, что запланировано и играет. */
    stopPlayback() {
      this.pendingPlayback = [];
      for (const s of this.playing) { try { s.stop(); } catch (_) {} }
      this.playing.clear();
      this.nextStart = 0;
    }

    /** Отладка: короткий тон в виртуальный микрофон (проверка replaceTrack без сервера). */
    beep(seconds = 1) {
      if (!this.ensure()) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      gain.gain.value = 0.2;
      osc.frequency.value = 440;
      osc.connect(gain);
      gain.connect(this.destination);
      if (cfg.monitor) gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + seconds);
    }
  }

  const engine = new AudioEngine();

  // ───────────────────────── Подмена исходящего трека ─────────────────────────

  const pcs = new Set();         // живые RTCPeerConnection
  const taken = new WeakMap();   // RTCRtpSender → { original: MediaStreamTrack|null }

  async function takeOver(sender) {
    const track = sender.track;
    if (!track || track.kind !== 'audio' || taken.has(sender)) return;
    if (!engine.ensure()) return;
    if (track === engine.virtualTrack) return;
    taken.set(sender, { original: track });
    try {
      await nativeReplaceTrack.call(sender, engine.virtualTrack);
      log('исходящий трек подменён через replaceTrack (был:', track.label || 'микрофон', ')');
    } catch (e) {
      taken.delete(sender);
      warn('replaceTrack не удался', e);
    }
  }

  async function release(sender) {
    const rec = taken.get(sender);
    if (!rec) return;
    taken.delete(sender);
    try {
      const back = rec.original && rec.original.readyState === 'live' ? rec.original : null;
      await nativeReplaceTrack.call(sender, back);
      log('исходящий трек восстановлен');
    } catch (e) { warn('не удалось восстановить трек', e); }
  }

  async function syncSenders(pc) {
    if (pc.connectionState === 'closed' || pc.signalingState === 'closed') { pcs.delete(pc); return; }
    const want = cfg.enabled && cfg.mode === 'auto';
    for (const sender of pc.getSenders()) {
      if (want) await takeOver(sender); else await release(sender);
    }
  }
  const syncAll = () => Promise.all([...pcs].map(syncSenders));

  // Если сама страница вызывает replaceTrack (смена микрофона и т.п.) — запоминаем её трек
  // как «оригинал», но оставляем в отправителе наш виртуальный.
  RTCRtpSender.prototype.replaceTrack = function (track) {
    let rec = taken.get(this);
    const isRealAudio = track && track.kind === 'audio' && track !== engine.virtualTrack;
    // Отправитель появился без трека (addTransceiver), а микрофон страница поставила позже —
    // ни одно событие это не сигнализирует, поэтому берём его под контроль прямо здесь.
    if (!rec && isRealAudio && cfg.enabled && cfg.mode === 'auto') {
      if (!engine.ensure()) return nativeReplaceTrack.call(this, track);
      rec = { original: track };
      taken.set(this, rec);
      log('микрофон поставлен страницей через replaceTrack — подменяю');
      return nativeReplaceTrack.call(this, engine.virtualTrack);
    }
    if (rec) {
      if (isRealAudio) {
        rec.original = track;
        return nativeReplaceTrack.call(this, engine.virtualTrack);
      }
      if (track === null) rec.original = null;
    }
    return nativeReplaceTrack.call(this, track);
  };

  // ───────────────────────── Перехват RTCPeerConnection ─────────────────────────

  function collectRemote(pc) {
    if (!cfg.enabled) return;
    for (const r of pc.getReceivers()) {
      if (!r.track || r.track.readyState !== 'live') continue;
      if (r.track.kind === 'audio') onRemoteTrack(r.track);
      if (r.track.kind === 'video') onRemoteVideoTrack(r.track);
    }
  }

  function register(pc) {
    pcs.add(pc);
    pc.addEventListener('track', (e) => {
      if (e.track.kind === 'audio') onRemoteTrack(e.track);
      if (e.track.kind === 'video') onRemoteVideoTrack(e.track);
    });
    const onChange = () => { syncSenders(pc); collectRemote(pc); };
    for (const ev of ['negotiationneeded', 'signalingstatechange', 'connectionstatechange', 'iceconnectionstatechange']) {
      pc.addEventListener(ev, onChange);
    }
    log('создан RTCPeerConnection, всего:', pcs.size);
  }

  class HookedPC extends NativePC {
    constructor(...args) {
      super(...args);
      try { register(this); } catch (e) { warn('register', e); }
    }
  }
  window.RTCPeerConnection = HookedPC;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = HookedPC;

  /** Обёртка нативного метода: вызываем оригинал, затем наш код (ошибки не ломают страницу). */
  function wrapMethod(proto, name, after) {
    const orig = proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function (...args) {
      const result = orig.apply(this, args);
      try { after.call(this); } catch (e) { warn(name, e); }
      return result;
    };
  }
  // Подменяем трек сразу после появления отправителя — до начала передачи RTP.
  wrapMethod(NativePC.prototype, 'addTrack', function () { queueMicrotask(() => syncSenders(this)); });
  wrapMethod(NativePC.prototype, 'addTransceiver', function () { queueMicrotask(() => syncSenders(this)); });
  // close() не генерирует событий — убираем соединение из реестра вручную.
  wrapMethod(NativePC.prototype, 'close', function () { pcs.delete(this); });

  // ───────────────────────── Сессия звонка ─────────────────────────

  let sessionActive = false;
  let idleSince = 0;
  let watchdog = null;
  let sessionStartTimer = null;
  let videoReadyAt = 0;
  let videoIdleSince = 0;
  let hasSeenVideoTrack = false;
  const observedVideoTracks = new WeakSet();

  function hasLiveRemote() {
    for (const pc of pcs) {
      if (pc.getReceivers().some((r) => r.track && r.track.kind === 'audio' && r.track.readyState === 'live')) return true;
    }
    return false;
  }

  function hasLiveRemoteVideo() {
    for (const pc of pcs) {
      if (pc.getReceivers().some((r) => r.track && r.track.kind === 'video' && r.track.readyState === 'live' && !r.track.muted)) return true;
    }
    return false;
  }

  function requestSessionStart() {
    if (!cfg.enabled || sessionActive) return;
    if (!hasLiveRemoteVideo()) {
      videoReadyAt = 0;
      clearTimeout(sessionStartTimer);
      sessionStartTimer = null;
      return;
    }
    if (!videoReadyAt) videoReadyAt = Date.now();
    if (sessionStartTimer) return;
    sessionStartTimer = setTimeout(() => {
      sessionStartTimer = null;
      if (cfg.enabled && hasLiveRemoteVideo() && hasLiveRemote()) startSession();
      else if (!hasLiveRemoteVideo()) videoReadyAt = 0;
    }, Math.max(3000, cfg.videoDelayMs ?? 3000) - (Date.now() - videoReadyAt));
  }

  function onRemoteVideoTrack(track) {
    if (observedVideoTracks.has(track)) return;
    observedVideoTracks.add(track);
    const isReplacement = hasSeenVideoTrack;
    let replacementHandled = false;
    hasSeenVideoTrack = true;
    const onVideoStateChange = () => {
      if (isReplacement && !replacementHandled && sessionActive && track.readyState === 'live' && !track.muted) {
        replacementHandled = true;
        endSession('получен новый видеотрек собеседника');
      }
      requestSessionStart();
    };
    track.addEventListener('unmute', onVideoStateChange);
    track.addEventListener('mute', onVideoStateChange);
    track.addEventListener('ended', onVideoStateChange);
    onVideoStateChange();
  }

  function startSession() {
    if (sessionActive) return;
    sessionActive = true;
    idleSince = 0;
    engine.capturing = true;
    toBridge({ type: 'session_start' });
    watchdog = setInterval(checkAlive, 1000);
    log('сессия начата');
  }

  function endSession(reason) {
    videoReadyAt = 0;
    videoIdleSince = 0;
    clearTimeout(sessionStartTimer);
    sessionStartTimer = null;
    if (!sessionActive) return;
    sessionActive = false;
    engine.capturing = false;
    engine.stopPlayback();
    clearInterval(watchdog);
    toBridge({ type: 'session_end' });
    log('сессия завершена:', reason);
  }

  /** Раз в секунду: чистим закрытые PC и решаем, не закончился ли звонок.
   *  Пауза SESSION_GRACE_MS переживает пересоздание PeerConnection. */
  function checkAlive() {
    for (const pc of [...pcs]) {
      if (pc.connectionState === 'closed' || pc.signalingState === 'closed') pcs.delete(pc);
    }
    const now = Date.now();
    if (!hasLiveRemoteVideo()) {
      if (!videoIdleSince) videoIdleSince = now;
      if (now - videoIdleSince > VIDEO_TRANSITION_GRACE_MS) {
        endSession('потеряно видео собеседника');
        return;
      }
    } else {
      videoIdleSince = 0;
    }
    if (hasLiveRemote()) { idleSince = 0; return; }
    if (!idleSince) idleSince = now;
    if (now - idleSince > SESSION_GRACE_MS) endSession('нет живых удалённых аудиотреков');
  }

  function onRemoteTrack(track) {
    if (!cfg.enabled) return;
    engine.attachRemote(track);
    requestSessionStart();
  }

  function applyConfig(next) {
    const prev = { ...cfg };
    Object.assign(cfg, next);
    if (cfg.enabled && !prev.enabled) {
      engine.ensure();
      pcs.forEach(collectRemote);      // звонок мог начаться до включения
    }
    if (!cfg.enabled && prev.enabled) {
      clearTimeout(sessionStartTimer);
      sessionStartTimer = null;
      videoReadyAt = 0;
      endSession('выключено пользователем');
    }
    if (cfg.enabled !== prev.enabled || cfg.mode !== prev.mode) syncAll();
  }

  window.addEventListener('pagehide', () => endSession('pagehide'));

  // Диагностика: в консоли rulet.tv → __RUTV_DEBUG__.state()
  window.__RUTV_DEBUG__ = {
    beep: (s) => engine.beep(s),
    state: () => ({ cfg: { ...cfg }, effectiveVideoDelayMs: Math.max(3000, cfg.videoDelayMs ?? 3000), pcs: pcs.size, sessionActive, ctx: engine.ctx && engine.ctx.state }),
  };

  toBridge({ type: 'hello' });
  log('перехватчик WebRTC активен на', location.hostname);
})();
