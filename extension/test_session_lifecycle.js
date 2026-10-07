const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function eventTarget(target = {}) {
  const listeners = new Map();
  target.addEventListener = (name, listener) => {
    const list = listeners.get(name) || [];
    list.push(listener);
    listeners.set(name, list);
  };
  target.dispatch = (name, event = {}) => {
    for (const listener of listeners.get(name) || []) listener(event);
  };
  return target;
}

function loadInjector() {
  const posted = [];
  const timers = new Map();
  let nextTimer = 1;
  const window = eventTarget({ postMessage: (message) => posted.push(message) });

  class Sender {
    replaceTrack() { return Promise.resolve(); }
  }
  class PeerConnection {
    constructor() {
      eventTarget(this);
      this.receivers = [];
      this.senders = [];
      this.connectionState = 'connected';
      this.signalingState = 'stable';
    }
    getReceivers() { return this.receivers; }
    getSenders() { return this.senders; }
    addTrack() {}
    addTransceiver() {}
    close() { this.connectionState = 'closed'; }
  }

  window.RTCPeerConnection = PeerConnection;
  window.RTCRtpSender = Sender;
  const context = {
    window,
    RTCRtpSender: Sender,
    location: { hostname: 'rulet.tv' },
    console: { log() {}, warn() {} },
    queueMicrotask,
    setTimeout: (fn, delay) => {
      const id = nextTimer++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => nextTimer++,
    clearInterval() {},
  };
  const source = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
  vm.runInNewContext(source, context);
  return { window, posted, timers };
}

function addTrack(pc, kind, muted = false) {
  const track = eventTarget({ kind, muted, readyState: 'live' });
  pc.receivers.push({ track });
  pc.dispatch('track', { track });
  return track;
}

function fireTimer(timers) {
  const [id, timer] = timers.entries().next().value;
  timers.delete(id);
  timer.fn();
  return timer;
}

function sessionEvents(posted) {
  return posted.map((message) => message.type).filter((type) => type === 'session_start' || type === 'session_end');
}

test('replacement video closes old dialog and waits at least three seconds', () => {
  const { window, posted, timers } = loadInjector();
  window.dispatch('message', {
    source: window,
    data: { __RUTV__: 1, dir: 'down', type: 'config', config: { enabled: true, videoDelayMs: 1000 } },
  });
  const pc = new window.RTCPeerConnection();
  addTrack(pc, 'video');
  addTrack(pc, 'audio');
  fireTimer(timers);
  assert.deepEqual(sessionEvents(posted), ['session_start']);

  const replacement = addTrack(pc, 'video', true);
  assert.deepEqual(sessionEvents(posted), ['session_start']);
  replacement.muted = false;
  replacement.dispatch('unmute');
  assert.deepEqual(sessionEvents(posted), ['session_start', 'session_end']);

  const wait = fireTimer(timers);
  assert.ok(wait.delay >= 3000, `waited ${wait.delay} ms`);
  assert.deepEqual(sessionEvents(posted), ['session_start', 'session_end', 'session_start']);
});
