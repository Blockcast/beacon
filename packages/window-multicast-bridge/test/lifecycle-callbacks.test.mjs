import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BridgeClient, initMulticastBridge } from '../src/multicast-bridge.js';

// Page callbacks run inside the bridge's own lifecycle transitions. These
// tests pin that a page bug in one of them cannot abort the transition, and
// that a stopped controller stops reacting to the page.

const PINNED_SEARCH = `?mc_bridge=beacon.local:33446&fingerprint=${'ab'.repeat(32)}&wt_port=34445`;

function makeWindowScope() {
  const listeners = new Map();
  const store = new Map();
  const windowScope = {
    location: {
      href: `https://player.example.test/watch${PINNED_SEARCH}`,
      origin: 'https://player.example.test',
      protocol: 'https:',
      hostname: 'player.example.test',
      pathname: '/watch',
      search: PINNED_SEARCH,
      hash: '',
    },
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    addEventListener(type, listener) {
      const entries = listeners.get(type) || new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
  };
  return { windowScope, listeners };
}

function mockGlobal(t, key, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else delete globalThis[key];
  });
}

function installPage(t) {
  const harness = makeWindowScope();
  // Registered first so it runs before the globals below are restored: a
  // controller is stopped while its window still exists, as in a page.
  const controllers = [];
  t.after(() => { for (const controller of controllers) controller.stop(); });
  mockGlobal(t, 'window', harness.windowScope);
  mockGlobal(t, 'location', harness.windowScope.location);
  mockGlobal(t, 'localStorage', harness.windowScope.localStorage);
  mockGlobal(t, 'document', {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  });
  mockGlobal(t, 'WebTransport', class WebTransportStub {});
  // A pinned endpoint never probes HTTP; any fetch is a test bug.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  const clients = [];
  t.mock.method(BridgeClient.prototype, 'connect', async function connectStub() {
    clients.push(this);
    this.connected = true;
    this._transport = 'webtransport';
  });
  t.mock.method(BridgeClient.prototype, 'disconnect', function disconnectStub() {
    this.connected = false;
  });
  return { ...harness, clients, controllers };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('a throwing onReady cannot orphan the installed window.multicast', async (t) => {
  const { windowScope, clients, controllers } = installPage(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const statuses = [];
  const controller = initMulticastBridge({
    autoStart: false,
    onReady() { throw new Error('page onReady bug'); },
    onStatus: (event) => statuses.push(event),
  });
  controllers.push(controller);

  controller.start();
  await settle();

  assert.equal(clients.length, 1, 'the pinned endpoint must reach the WebTransport connect');
  assert.equal(windowScope.multicast?.__blockcastBridgePolyfill, true);
  // The controller still owns the client it installed, so a later disconnect
  // can remove the surface and rediscover instead of stranding it.
  assert.equal(controller.connected, true);
  assert.ok(
    statuses.some((event) => event.phase === 'connect' && event.ok === true),
    'the connect must be reported as the success it was',
  );
  assert.ok(
    !statuses.some((event) => event.phase === 'connect' && event.ok === false),
    'a page callback failure is not a bridge connect failure',
  );
  assert.equal(typeof clients[0]._onDisconnect, 'function');
  clients[0]._onDisconnect();
  assert.equal(windowScope.multicast, undefined, 'the disconnect removes the surface it installed');
  assert.ok(warn.mock.calls.some((call) => /onReady handler threw/.test(String(call.arguments[0]))));
});

test('a throwing onDisconnect still reports the disconnect and removes the surface', async (t) => {
  const { windowScope, clients, controllers } = installPage(t);
  t.mock.method(console, 'warn', () => {});
  const statuses = [];
  const controller = initMulticastBridge({
    autoStart: false,
    onDisconnect() { throw new Error('page onDisconnect bug'); },
    onStatus: (event) => statuses.push(event),
  });
  controllers.push(controller);

  controller.start();
  await settle();
  assert.equal(windowScope.multicast?.__blockcastBridgePolyfill, true);

  assert.doesNotThrow(() => clients[0]._onDisconnect());
  assert.equal(windowScope.multicast, undefined);
  assert.ok(
    statuses.some((event) => event.phase === 'disconnect'),
    'the disconnect status must still reach the page coordinator',
  );
});

test('stop() detaches the extension_ready listener', async (t) => {
  const { windowScope, listeners } = installPage(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const statuses = [];
  const controller = initMulticastBridge({
    autoStart: false,
    onStatus: (event) => statuses.push(event),
  });
  assert.equal(listeners.get('message')?.size, 1, 'the controller listens for extension_ready');

  controller.stop();
  assert.equal(listeners.get('message')?.size ?? 0, 0);

  windowScope.dispatchEvent({
    type: 'message',
    data: { source: 'multicast-extension', message: { type: 'extension_ready' } },
  });
  assert.deepEqual(statuses, [], 'a stopped controller reports nothing');
  assert.equal(
    warn.mock.calls.filter((call) => /keeping bridge/.test(String(call.arguments[0]))).length,
    0,
    'a stopped controller must not claim to be keeping a bridge',
  );
});
