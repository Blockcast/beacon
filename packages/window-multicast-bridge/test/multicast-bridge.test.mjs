import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BRIDGE_HOST_CANDIDATES,
  BridgeClient,
  bridgeDiscoveryScopeFromInputs,
  bridgeUrlParams,
  createTunerAPI,
  formatBridgeHost,
  isAutoTlsGatewayDomain,
  initMulticastBridge,
  loadBridgePairing,
  loadSavedGateway,
  multicastBridgeTransportOptionsFromConfig,
  normalizeBridgeHost,
  parseBridgeHostPort,
  readBridgeDiscoveryCache,
  rotateCachedBridgeFingerprint,
  saveBridgePairing,
  saveGateway,
  subscribeMulticastBridgeBytes,
  tryDesktopLanDiscovery,
  verifyBridgeEnrollment,
  writeBridgeDiscoveryCache,
  writeBridgeDiscoveryMiss,
} from '../src/multicast-bridge.js';

function makeWindowEventHarness(location = {}) {
  const listeners = new Map();
  const windowScope = {
    location: {
      href: 'https://example.test/live',
      origin: 'https://example.test',
      protocol: 'https:',
      hostname: 'example.test',
      search: '',
      ...location,
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

test('browser bridge is generic and has no native handoff or app-association contract', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/multicast-bridge.js'), 'utf8');
  const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../README.md'), 'utf8');

  assert.match(source, /export function initMulticastBridge/);
  assert.match(source, /window\.multicast/);
  assert.doesNotMatch(source, /APP_LINK_HOSTS|APP_LINK_PATH|blockcast\.network\/live/);
  assert.match(
    readme,
    /generic browser bridge with no native handoff or app-association\ncontract: Universal Links, App Links, AASA\/asset-links files/s,
  );
  assert.match(readme, /`\/live\*`.*not part of bridge discovery or\nauthorization/s);
  assert.match(readme, /install `window\.multicast` on any browser page/);
  assert.match(readme, /does not\ninspect the page host or pathname/s);
  assert.match(readme, /configured browser\s+origin.*exact origin allowlist/s);
});

test('WebTransport sends hello before starting readers that may emit telemetry', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/multicast-bridge.js'), 'utf8');
  const connectStart = source.indexOf('async _connectWebTransport(');
  const connectEnd = source.indexOf('\n  /** Open a bidi stream', connectStart);
  assert.ok(connectStart >= 0 && connectEnd > connectStart);
  const connectBody = source.slice(connectStart, connectEnd);
  const hello = connectBody.indexOf('await this._sendControlWithWriteAck({');
  const streams = connectBody.indexOf('this._readIncomingStreams(wt);');
  const datagrams = connectBody.indexOf('this._readIncomingDatagrams(wt);');
  assert.ok(hello >= 0, 'hello must wait for a successful control write');
  assert.ok(streams > hello, 'stream reader must start after hello');
  assert.ok(datagrams > hello, 'datagram reader must start after hello');
});

test('page origin does not become a browser bridge discovery allowlist', () => {
  const arbitraryPage = bridgeDiscoveryScopeFromInputs({
    search: '',
    hostname: 'player.example.test',
  });
  const blockcastPage = bridgeDiscoveryScopeFromInputs({
    search: '',
    hostname: 'blockcast.network',
  });
  const mobilePage = bridgeDiscoveryScopeFromInputs({
    search: '',
    hostname: 'm.example.test',
  });

  assert.equal(arbitraryPage, 'default');
  assert.equal(mobilePage, arbitraryPage);
  assert.equal(blockcastPage, arbitraryPage);
});

test('explicit pinned endpoints bypass HTTP, stale caches, and saved gateways', async (t) => {
  const storage = new Map();
  const { windowScope } = makeWindowEventHarness({ href: 'https://player.example.test/watch/42' });
  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  });
  mockGlobal(t, 'WebTransport', class {});
  const warnMock = t.mock.method(console, 'warn', () => {});
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('HTTP forbidden'); });
  const connectMock = t.mock.method(BridgeClient.prototype, 'connect', async function () {
    this.connected = true;
  });
  t.mock.method(BridgeClient.prototype, 'disconnect', function () { this.connected = false; });

  const fingerprint = 'ab'.repeat(32);
  saveGateway('gw-saved.tenant.bcast.id', '192.168.1.20', fingerprint);
  for (const host of ['beacon.local', 'relay.example.test', '127.0.0.1']) {
    for (const pinName of ['fingerprint', 'fp']) {
      windowScope.location.search = `?mc_bridge=${host}:33446&${pinName}=${fingerprint}&wt_port=34445&gw=gw-other.tenant.bcast.id`;
      const scope = bridgeDiscoveryScopeFromInputs({ search: windowScope.location.search });
      const cacheOptions = { scope };
      assert.equal(writeBridgeDiscoveryCache(33446, {
        host: 'wrong.local', fingerprint: 'cd'.repeat(32), httpPort: 33446, wtPort: 33445,
        bridgeProtocol: 'bcds-v1', webTransportBridge: true,
      }, cacheOptions), true);
      if (pinName === 'fp') writeBridgeDiscoveryMiss(33446, cacheOptions);
      const controller = initMulticastBridge({ autoStart: false });
      try {
        controller.start();
        await new Promise((resolve) => setImmediate(resolve));
        const call = connectMock.mock.calls.at(-1);
        assert.equal(call.arguments[0], host);
        assert.equal(call.arguments[2].fingerprint, fingerprint);
        assert.equal(call.arguments[2].wtPort, 34445);
        assert.equal(call.arguments[2].gatewayDomain, undefined);
        assert.equal(windowScope.multicast?.__blockcastBridgePolyfill, true);
      } finally {
        controller.stop();
      }
    }
  }
  assert.equal(connectMock.mock.callCount(), 6);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(warnMock.mock.callCount(), 2, 'only the two secure loopback cases need a policy diagnostic');
  for (const call of warnMock.mock.calls) {
    assert.match(call.arguments[0], /local-network permission; saved AutoTLS gateways are not substituted/);
  }
});

test('invalid pinned configuration fails closed without discovery or connection', async (t) => {
  const { windowScope } = makeWindowEventHarness();
  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'WebTransport', class {});
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('HTTP forbidden'); });
  const connectMock = t.mock.method(BridgeClient.prototype, 'connect', async () => {});
  for (const search of [
    '?mc_bridge=&fingerprint=',
    '?mc_bridge=beacon.local&fingerprint=',
    '?mc_bridge=beacon.local&fp=abcd',
    `?mc_bridge=&fingerprint=${'ab'.repeat(32)}&gw=gw-other.tenant.bcast.id`,
    `?mc_bridge=user@beacon.local&fingerprint=${'ab'.repeat(32)}`,
    `?mc_bridge=beacon.local&fingerprint=${'ab'.repeat(32)}&wt_port=65536`,
  ]) {
    windowScope.location.search = search;
    const controller = initMulticastBridge({ autoStart: false });
    try {
      controller.start();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(windowScope.multicast, undefined, search);
    } finally {
      controller.stop();
    }
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(connectMock.mock.callCount(), 0);
});

test('a failed pinned WebTransport handshake never retries with CA-only authentication', async (t) => {
  const attempts = [];
  mockGlobal(t, 'WebTransport', class {
    constructor(url, options) {
      attempts.push({ url, options });
      this.ready = Promise.reject(new Error('certificate mismatch'));
      this.closed = Promise.resolve();
    }
    close() {}
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new BridgeClient();
  for (const host of ['beacon.local', 'beacon.example.test', '::1']) {
    attempts.length = 0;
    const result = assert.rejects(client.connect(host, 33446, {
      fingerprint: 'AB:'.repeat(31) + 'AB', wtPort: 34445,
    }), /certificate mismatch/);
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1000);
    }
    await result;
    assert.equal(attempts.length, 3);
    for (const { url, options } of attempts) {
      assert.equal(url, `https://${formatBridgeHost(host)}:34445`);
      assert.deepEqual(options.serverCertificateHashes, [{
        algorithm: 'sha-256', value: new Uint8Array(32).fill(0xab),
      }]);
    }
  }
  await assert.rejects(client.connect('beacon.local', 33446, { fingerprint: 'abcd' }), /Invalid.*fingerprint/);
  assert.equal(attempts.length, 3);
});

test('late bridge discovery cannot overwrite an extension API installed during connect', async () => {
  const previousWindow = globalThis.window;
  const previousLocation = globalThis.location;
  const previousStorage = globalThis.localStorage;
  const previousWebTransport = globalThis.WebTransport;
  const previousDocument = globalThis.document;
  const store = new Map();
  const { windowScope } = makeWindowEventHarness({
    search: `?mc_bridge=127.0.0.1&fingerprint=${'ab'.repeat(32)}`,
  });
  windowScope.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };

  let resolveConnect;
  let connectCalls = 0;
  const originalConnect = BridgeClient.prototype.connect;
  BridgeClient.prototype.connect = async function connectForRaceTest() {
    connectCalls += 1;
    await new Promise((resolve) => { resolveConnect = resolve; });
    this.connected = true;
    this._transport = 'webtransport';
  };

  globalThis.window = windowScope;
  globalThis.location = windowScope.location;
  globalThis.localStorage = windowScope.localStorage;
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };
  globalThis.WebTransport = class WebTransportStub {};

  try {
    const controller = initMulticastBridge({ autoStart: false });
    const extensionSubscribe = () => 'extension';
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(connectCalls, 1, 'the test must reach the asynchronous WT connect');

    // Simulate the main-world extension injector winning while discovery's
    // WebTransport handshake is still pending.
    windowScope.multicast = { subscribe: extensionSubscribe };
    resolveConnect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(windowScope.multicast.subscribe, extensionSubscribe);
    assert.equal(windowScope.multicast.__blockcastBridgePolyfill, undefined);
    controller.stop();
  } finally {
    BridgeClient.prototype.connect = originalConnect;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousWebTransport === undefined) delete globalThis.WebTransport;
    else globalThis.WebTransport = previousWebTransport;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('extension_ready keeps the bridge when the extension surface is degraded', async () => {
  const previousWindow = globalThis.window;
  const previousLocation = globalThis.location;
  const previousStorage = globalThis.localStorage;
  const previousWebTransport = globalThis.WebTransport;
  const previousDocument = globalThis.document;
  const store = new Map();
  const { windowScope } = makeWindowEventHarness({
    search: `?mc_bridge=127.0.0.1&fingerprint=${'cd'.repeat(32)}`,
  });
  windowScope.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };

  let resolveConnect;
  let bridgeClient;
  const originalConnect = BridgeClient.prototype.connect;
  BridgeClient.prototype.connect = async function connectForExtensionReadyTest() {
    bridgeClient = this;
    await new Promise((resolve) => { resolveConnect = resolve; });
    this.connected = true;
    this._transport = 'webtransport';
  };

  globalThis.window = windowScope;
  globalThis.location = windowScope.location;
  globalThis.localStorage = windowScope.localStorage;
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };
  globalThis.WebTransport = class WebTransportStub {};

  let controller;
  try {
    controller = initMulticastBridge({ autoStart: false });
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(bridgeClient, 'the test must establish a bridge client');

    resolveConnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(windowScope.multicast?.__blockcastBridgePolyfill, true);
    const bridgeSurface = windowScope.multicast;

    // A content script can announce extension readiness even when its main
    // world injector failed. This degraded, marker-free surface intentionally
    // has no subscribe method; it is not an observable replacement, so the
    // bridge remains connected as the only usable transport.
    let markerReads = 0;
    const extensionSurface = new Proxy({ version: '0.1.5' }, {
      get(target, property, receiver) {
        if (property === '__blockcastBridgePolyfill') {
          markerReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    windowScope.multicast = extensionSurface;

    windowScope.dispatchEvent({
      type: 'message',
      data: {
        source: 'multicast-extension',
        message: { type: 'extension_ready' },
      },
    });

    assert.equal(windowScope.multicast, extensionSurface, 'the degraded extension surface survives');
    // Ownership now uses an own-property check.  A degraded proxy without an
    // own marker must not be read through its getter (and therefore records
    // zero marker reads).
    assert.equal(markerReads, 0, 'ownership uses an own-property check');
    assert.equal(bridgeClient.connected, true, 'the only usable bridge client remains connected');
    assert.equal(bridgeClient._transport, 'webtransport');
  } finally {
    controller?.stop();
    BridgeClient.prototype.connect = originalConnect;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousWebTransport === undefined) delete globalThis.WebTransport;
    else globalThis.WebTransport = previousWebTransport;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('extension_ready leaves a bridge-owned API usable when no replacement takes over', async (t) => {
  const previousWindow = globalThis.window;
  const previousLocation = globalThis.location;
  const previousStorage = globalThis.localStorage;
  const previousWebTransport = globalThis.WebTransport;
  const previousDocument = globalThis.document;
  const store = new Map();
  const { windowScope } = makeWindowEventHarness({
    search: `?mc_bridge=127.0.0.1&fingerprint=${'de'.repeat(32)}`,
  });
  windowScope.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };

  let resolveConnect;
  let bridgeClient;
  const originalConnect = BridgeClient.prototype.connect;
  BridgeClient.prototype.connect = async function connectForMarkerLiveTest() {
    bridgeClient = this;
    await new Promise((resolve) => { resolveConnect = resolve; });
    this.connected = true;
    this._transport = 'webtransport';
  };

  globalThis.window = windowScope;
  globalThis.location = windowScope.location;
  globalThis.localStorage = windowScope.localStorage;
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };
  globalThis.WebTransport = class WebTransportStub {};

  let controller;
  try {
    controller = initMulticastBridge({ autoStart: false });
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(bridgeClient, 'the test must establish a bridge client');

    resolveConnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const bridgeSurface = windowScope.multicast;
    const bridgeSubscribe = bridgeSurface?.subscribe;
    assert.equal(windowScope.multicast?.__blockcastBridgePolyfill, true);
    assert.equal(typeof bridgeSubscribe, 'function');
    const capabilities = await bridgeSurface.capabilities();
    assert.deepEqual(capabilities.origins, ['ip-multicast', 'amt']);
    assert.equal(capabilities.transports.amt.available, true);
    await assert.rejects(
      bridgeSubscribe.call(bridgeSurface, { group: '232.1.1.50', port: 8000 }),
      /consume: 'bytes'/,
    );

    // No extension injector replacement arrives with this readiness signal.
    // The marker proves that the live surface still belongs to this bridge;
    // disconnecting here would leave callers with a dead subscribe function.
    windowScope.dispatchEvent({
      type: 'message',
      data: {
        source: 'multicast-extension',
        message: { type: 'extension_ready' },
      },
    });

    assert.equal(windowScope.multicast, bridgeSurface, 'the bridge surface remains installed');
    assert.equal(windowScope.multicast.subscribe, bridgeSubscribe, 'subscribe remains callable');
    assert.equal(windowScope.multicast.__blockcastBridgePolyfill, true);
    assert.equal(bridgeClient.connected, true, 'the bridge transport remains live');
    assert.equal(bridgeClient._transport, 'webtransport');

    // Readiness alone must not permanently stop this controller. A later
    // transport loss must discover and install a new bridge-owned API. The
    // reconnect is deliberately bounded rather than an immediate handshake
    // loop when the native endpoint is flapping.
    const previousClient = bridgeClient;
    t.mock.method(Math, 'random', () => 0.5); // eliminate reconnect jitter
    t.mock.timers.enable({ apis: ['setTimeout'] });
    previousClient._handleDisconnect();
    for (let i = 0; i < 24; i += 1) await Promise.resolve();
    t.mock.timers.tick(7999);
    for (let i = 0; i < 24; i += 1) await Promise.resolve();
    assert.equal(bridgeClient, previousClient, 'flapping reconnect waits for the bounded delay');
    t.mock.timers.tick(1);
    for (let i = 0; i < 24; i += 1) await Promise.resolve();
    assert.notEqual(bridgeClient, previousClient, 'bridge remains revivable after extension_ready');
    resolveConnect();
    for (let i = 0; i < 24; i += 1) await Promise.resolve();
    assert.equal(bridgeClient.connected, true);
    assert.equal(windowScope.multicast?.__blockcastBridgePolyfill, true);
  } finally {
    controller?.stop();
    BridgeClient.prototype.connect = originalConnect;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousWebTransport === undefined) delete globalThis.WebTransport;
    else globalThis.WebTransport = previousWebTransport;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

for (const takeover of ['extension_ready', 'disconnect', 'stop']) {
test(`replacement extension surface survives bridge ${takeover}`, async () => {
  const previousWindow = globalThis.window;
  const previousLocation = globalThis.location;
  const previousStorage = globalThis.localStorage;
  const previousWebTransport = globalThis.WebTransport;
  const previousDocument = globalThis.document;
  const store = new Map();
  const { windowScope } = makeWindowEventHarness({
    search: `?mc_bridge=127.0.0.1&fingerprint=${'ef'.repeat(32)}`,
  });
  windowScope.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };

  let resolveConnect;
  let bridgeClient;
  const originalConnect = BridgeClient.prototype.connect;
  BridgeClient.prototype.connect = async function connectForReplacementTest() {
    bridgeClient = this;
    await new Promise((resolve) => { resolveConnect = resolve; });
    this.connected = true;
    this._transport = 'webtransport';
  };

  globalThis.window = windowScope;
  globalThis.location = windowScope.location;
  globalThis.localStorage = windowScope.localStorage;
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };
  globalThis.WebTransport = class WebTransportStub {};

  let controller;
  try {
    controller = initMulticastBridge({ autoStart: false });
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(bridgeClient, 'the test must establish a bridge client');

    resolveConnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const bridgeSurface = windowScope.multicast;
    assert.equal(bridgeSurface?.__blockcastBridgePolyfill, true);

    const extensionSubscribe = () => 'extension';
    // The extension replaces the bridge with its own standalone object.
    // Identity ownership prevents bridge teardown from deleting it.
    const extensionSurface = { subscribe: extensionSubscribe, version: '0.1.6' };
    windowScope.multicast = extensionSurface;
    if (takeover === 'extension_ready') {
      windowScope.dispatchEvent({
        type: 'message',
        data: {
          source: 'multicast-extension',
          message: { type: 'extension_ready' },
        },
      });
    } else if (takeover === 'disconnect') {
      bridgeClient._handleDisconnect();
    } else {
      controller.stop();
    }

    assert.equal(windowScope.multicast, extensionSurface, 'the replacement surface survives');
    assert.equal(windowScope.multicast.subscribe, extensionSubscribe);
    assert.equal(bridgeClient.connected, false, 'the lower-priority bridge client is released');
    assert.equal(bridgeClient._transport, null);
    assert.notEqual(windowScope.multicast, bridgeSurface, 'the bridge never restores its old surface');
  } finally {
    controller?.stop();
    BridgeClient.prototype.connect = originalConnect;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousWebTransport === undefined) delete globalThis.WebTransport;
    else globalThis.WebTransport = previousWebTransport;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
}

test('mid-handshake disconnect re-arms bridge polling after connect failure', async (t) => {
  const previousWindow = globalThis.window;
  const previousLocation = globalThis.location;
  const previousStorage = globalThis.localStorage;
  const previousWebTransport = globalThis.WebTransport;
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const store = new Map();
  const { windowScope } = makeWindowEventHarness({
    // A pinned fingerprint makes discovery deterministic and avoids a real
    // network probe. The bridge still has to complete the full connect path.
    search: `?mc_bridge=127.0.0.1&fingerprint=${'aa'.repeat(32)}`,
  });
  windowScope.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };

  let rejectFirstConnect;
  let bridgeClient;
  let connectCalls = 0;
  const originalConnect = BridgeClient.prototype.connect;
  BridgeClient.prototype.connect = function connectForRetryTest() {
    connectCalls += 1;
    if (connectCalls === 1) {
      bridgeClient = this;
      // Model a WebTransport session that becomes connected before its final
      // handshake step resolves. The real close callback can therefore enter
      // _handleDisconnect while initMulticastBridge's connectAttempt is live.
      this.connected = true;
      this._transport = 'webtransport';
      return new Promise((_, reject) => { rejectFirstConnect = reject; });
    }
    this.connected = true;
    this._transport = 'webtransport';
    return Promise.resolve();
  };

  globalThis.window = windowScope;
  globalThis.location = windowScope.location;
  globalThis.localStorage = windowScope.localStorage;
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };
  globalThis.WebTransport = class WebTransportStub {};
  globalThis.fetch = async () => {
    throw new Error('unexpected network probe');
  };

  let controller;
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    controller = initMulticastBridge({ autoStart: false });
    controller.start();

    // Let the explicit discovery result reach BridgeClient.connect().
    for (let i = 0; i < 8 && !bridgeClient; i += 1) await Promise.resolve();
    assert.ok(bridgeClient, 'the test must establish a bridge client');
    assert.equal(connectCalls, 1);
    assert.equal(typeof rejectFirstConnect, 'function');

    // This is the problematic interleaving: _handleDisconnect() calls
    // startPolling() while the original connectAttempt is still pending.
    bridgeClient._handleDisconnect();
    assert.equal(bridgeClient.connected, false);
    rejectFirstConnect(new Error('handshake failed'));
    for (let i = 0; i < 12; i += 1) await Promise.resolve();

    // The catch must clear the latch and arm a real timer. Reverting the
    // production fix leaves polling=true with no timer, so this tick would
    // never produce the second connection attempt.
    assert.equal(connectCalls, 1, 'retry must wait for the scheduled poll');
    t.mock.timers.tick(30_000);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    assert.equal(connectCalls, 2, 'mid-handshake failure must schedule a retry');
  } finally {
    controller?.stop();
    BridgeClient.prototype.connect = originalConnect;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousWebTransport === undefined) delete globalThis.WebTransport;
    else globalThis.WebTransport = previousWebTransport;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test('a foreign unusable surface prevents retry after a late handshake', async (t) => {
  const previousWindow = globalThis.window;
  const previousLocation = globalThis.location;
  const previousStorage = globalThis.localStorage;
  const previousWebTransport = globalThis.WebTransport;
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const store = new Map();
  const { windowScope } = makeWindowEventHarness({
    search: `?mc_bridge=127.0.0.1&fingerprint=${'ab'.repeat(32)}`,
  });
  windowScope.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };

  let resolveConnect;
  let bridgeClient;
  let connectCalls = 0;
  const originalConnect = BridgeClient.prototype.connect;
  BridgeClient.prototype.connect = function connectForForeignSurfaceTest() {
    connectCalls += 1;
    bridgeClient = this;
    this.connected = true;
    this._transport = 'webtransport';
    if (connectCalls === 1) {
      return new Promise((resolve) => { resolveConnect = resolve; });
    }
    return Promise.resolve();
  };

  globalThis.window = windowScope;
  globalThis.location = windowScope.location;
  globalThis.localStorage = windowScope.localStorage;
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };
  globalThis.WebTransport = class WebTransportStub {};
  globalThis.fetch = async () => {
    throw new Error('unexpected network probe');
  };

  const settle = async () => {
    for (let i = 0; i < 24; i += 1) await Promise.resolve();
  };
  let controller;
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    controller = initMulticastBridge({ autoStart: false });
    controller.start();
    await settle();
    assert.equal(connectCalls, 1, 'the test must reach the asynchronous WT connect');
    assert.equal(typeof resolveConnect, 'function');

    // A page/extension-owned object can occupy the property without exposing
    // the bridge API. It still wins the ownership race: installAPI refuses
    // every defined value, so this must not trigger an endless retry loop.
    const foreignSurface = { version: 'foreign', diagnosticOnly: true };
    windowScope.multicast = foreignSurface;
    resolveConnect();
    await settle();

    assert.equal(windowScope.multicast, foreignSurface);
    assert.equal(bridgeClient.connected, false, 'the losing bridge client is released');
    assert.equal(connectCalls, 1, 'an occupied property must suppress retry scheduling');

    // The old usable-replacement predicate re-armed an 8 s timer here. Advance
    // well past the capped backoff to prove no hidden retry is waiting.
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(connectCalls, 1, 'a foreign surface must not cause re-handshakes');
  } finally {
    controller?.stop();
    BridgeClient.prototype.connect = originalConnect;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousWebTransport === undefined) delete globalThis.WebTransport;
    else globalThis.WebTransport = previousWebTransport;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

for (const failureMode of ['reject', 'resolve-disconnected', 'close-then-reject', 'close-then-resolve', 'post-connect']) {
  test(`bridge discovery preserves bounded backoff after ${failureMode}`, async (t) => {
    const savedGlobals = new Map(['window', 'location', 'localStorage', 'WebTransport', 'document', 'fetch']
      .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const { windowScope } = makeWindowEventHarness({
      search: `?mc_bridge=127.0.0.1&fingerprint=${'aa'.repeat(32)}`,
    });
    const store = new Map();
    windowScope.localStorage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    };
    Object.assign(globalThis, {
      window: windowScope,
      location: windowScope.location,
      localStorage: windowScope.localStorage,
      WebTransport: class {},
      document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
      fetch: async () => { throw new Error('unexpected network probe'); },
    });
    let connectCalls = 0;
    let currentClient;
    let fail = true;
    t.mock.method(Math, 'random', () => 0.5); // Exercise exact delays, without jitter.
    t.mock.method(BridgeClient.prototype, 'connect', async function () {
      connectCalls += 1;
      currentClient = this;
      if (!fail || failureMode === 'post-connect') {
        this.connected = true;
        this._transport = 'webtransport';
        return;
      }
      if (failureMode === 'resolve-disconnected') return;
      if (failureMode === 'close-then-reject' || failureMode === 'close-then-resolve') {
        this.connected = true;
        this._transport = 'webtransport';
        this._handleDisconnect();
        if (failureMode === 'close-then-resolve') return;
      }
      throw new Error('handshake failed');
    });
    // Drain discovery, connect, catch and finally without advancing the timer.
    const settle = async () => { for (let i = 0; i < 24; i += 1) await Promise.resolve(); };
    let controller;
    try {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      controller = initMulticastBridge({ autoStart: false });
      controller.start();
      await settle();
      assert.equal(connectCalls, 1);
      if (failureMode === 'post-connect') currentClient._handleDisconnect();
      for (const delay of [8000, 12800, 20480, 32768, 52429, 60000, 60000]) {
        const before = connectCalls;
        t.mock.timers.tick(delay - 1);
        await settle();
        assert.equal(connectCalls, before, `must not retry before ${delay}ms`);
        t.mock.timers.tick(1);
        await settle();
        assert.equal(connectCalls, before + 1, `must retry at ${delay}ms`);
        if (failureMode === 'post-connect') {
          assert.equal(windowScope.multicast?.bridgeTransport, 'webtransport');
          currentClient._handleDisconnect();
        }
      }
      // Reaching the cap must not strand the latch: a later successful bridge
      // is still installed, and successful connection stops discovery polling.
      fail = false;
      t.mock.timers.tick(60000);
      await settle();
      assert.equal(windowScope.multicast?.bridgeTransport, 'webtransport');
      assert.equal(windowScope.multicast?.__blockcastBridgePolyfill, true);
      const connectedCalls = connectCalls;
      t.mock.timers.tick(120000);
      await settle();
      assert.equal(connectCalls, connectedCalls);
      // Surviving the stable-session interval restores the initial retry delay.
      currentClient._handleDisconnect();
      t.mock.timers.tick(7999);
      await settle();
      assert.equal(connectCalls, connectedCalls);
      t.mock.timers.tick(1);
      await settle();
      assert.equal(connectCalls, connectedCalls + 1);
      assert.equal(windowScope.multicast?.bridgeTransport, 'webtransport');
    } finally {
      controller?.stop();
      for (const [key, descriptor] of savedGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
}

function makeStreamIndexFrame(streamIndex, payload) {
  const frame = new Uint8Array(2 + payload.length);
  new DataView(frame.buffer).setUint16(0, streamIndex, true);
  frame.set(payload, 2);
  return frame;
}

function dispatchBcdsPacket(client, subscriptionId, payload, streamIndex = 7) {
  client._streamSubscriptions.set(streamIndex, subscriptionId);
  client._handleTransportFrame(makeStreamIndexFrame(streamIndex, payload));
}

function makeStreamMetadataFrame(streamIndex, payload, receiveTime, source = 'kernel-software', receiveTimeOrigin) {
  const sourceBytes = new TextEncoder().encode(source);
  const hasOrigin = Number.isFinite(receiveTimeOrigin);
  const frame = new Uint8Array(13 + sourceBytes.length + (hasOrigin ? 8 : 0) + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint16(0, streamIndex | 0x8000, true);
  view.setUint8(2, hasOrigin ? 2 : 1);
  view.setUint8(3, hasOrigin ? 1 : 0);
  view.setFloat64(4, receiveTime, true);
  view.setUint8(12, sourceBytes.length);
  frame.set(sourceBytes, 13);
  let payloadOffset = 13 + sourceBytes.length;
  if (hasOrigin) {
    view.setFloat64(payloadOffset, receiveTimeOrigin, true);
    payloadOffset += 8;
  }
  frame.set(payload, payloadOffset);
  return frame;
}

function makeDataStreamHeader(wireIndex) {
  const header = new Uint8Array([0x42, 0x43, 0x44, 0x53, 0x01, 0x00, 0x00, 0x00]);
  new DataView(header.buffer).setUint16(6, wireIndex, true);
  return header;
}

function makeLengthPrefixedFrame(bytes) {
  const frame = new Uint8Array(4 + bytes.byteLength);
  new DataView(frame.buffer).setUint32(0, bytes.byteLength, true);
  frame.set(bytes, 4);
  return frame;
}

function makeJsonBidiFrame(message) {
  return makeLengthPrefixedFrame(
    new TextEncoder().encode(JSON.stringify(message)),
  );
}

function makeDatagramDeliveryFrame(sequence, payload, epoch = 0) {
  const frame = new Uint8Array(12 + payload.byteLength);
  frame.set([0x42, 0x43, 0x44, 0x47, 0x01, epoch, 0x00, 0x00]);
  new DataView(frame.buffer).setUint32(8, sequence, true);
  frame.set(payload, 12);
  return frame;
}

function datagramProgress(rx, tx = 0, sx = 0) {
  return { v: 1, rx, tx, sx };
}

function datagramSendProgress(tx) {
  return JSON.stringify({ type: 'datagram_send_progress', dg: { v: 1, tx } });
}

function makeControlledReadableStream() {
  let controller;
  const stream = new ReadableStream({
    start(value) {
      controller = value;
    },
  });
  return {
    stream,
    enqueue(chunk) {
      controller.enqueue(chunk);
    },
    close() {
      controller.close();
    },
  };
}

function yieldToReaders() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function decodeControlFrame(frame) {
  const bytes = new Uint8Array(frame);
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(0, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
}

test('canonical bridge rejects malformed gateway domains before persistence', () => {
  assert.equal(isAutoTlsGatewayDomain('gw-test.bcast.id'), true);
  assert.equal(isAutoTlsGatewayDomain('bcast.id'), false);
  assert.equal(isAutoTlsGatewayDomain('gw-test.bcast.id/path'), true, 'shape helper remains deliberately minimal');

  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
  });
  try {
    for (const domain of [
      'gw-test.bcast.id/path',
      'gw-test.bcast.id?x=1',
      'gw_test.bcast.id',
      'gw-.bcast.id',
      '192.168.001.1',
      'bcast.id',
    ]) {
      saveGateway(domain, '192.168.1.244');
      assert.equal(store.get('multicast-bridge-gw'), undefined, domain);
    }

    saveGateway('GW-Test.BCAST.ID', '[FD00:0:0:0:0:0:0:1]');
    const saved = loadSavedGateway();
    assert.deepEqual({ gatewayDomain: saved?.gatewayDomain, localAddress: saved?.localAddress }, {
      gatewayDomain: 'gw-test.bcast.id',
      localAddress: 'fd00::1',
    });
  } finally {
    if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    else delete globalThis.localStorage;
  }
});

test('canonical bridge brackets and normalizes IPv6 URL authorities', () => {
  assert.equal(formatBridgeHost('[FD00:0:0:0:0:0:0:1]'), '[fd00::1]');
  assert.equal(formatBridgeHost('[fe80::1%25en0]'), null);
});

test('bridge authority brackets are reserved for IPv6 literals', () => {
  assert.deepEqual(parseBridgeHostPort('[FD00:0:0:0:0:0:0:1]:33445'), {
    host: 'fd00::1',
    port: 33445,
  });
  assert.deepEqual(parseBridgeHostPort('fd00::1'), {
    host: 'fd00::1',
    port: null,
  });

  for (const value of [
    '[example.test]:33446',
    '[192.168.1.1]:33446',
    '[example.test]',
    '[192.168.1.1]',
  ]) {
    assert.equal(parseBridgeHostPort(value), null, value);
    assert.equal(normalizeBridgeHost(value.replace(/:33446$/, '')), null, value);
  }
});

test('bridge discovery never sends lifecycle capability headers', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ host: new URL(url).hostname, options });
    return { ok: false };
  };

  const hosts = [
    'localhost',
    '127.0.0.1',
    '10.0.0.8',
    '[FD00::8]',
    'multicast-bridge.local',
  ];

  try {
    for (const host of hosts) {
      await tryDesktopLanDiscovery(33446, {
        force: true,
        prefixes: ['192.168.1'],
        hosts: [host],
        batchSize: 1,
        timeoutMs: 100,
      });
    }
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }

  assert.equal(requests.length, hosts.length);
  for (const { options } of requests) assert.equal(options.headers, undefined);
});

test('saved AutoTLS gateway preserves a known fingerprint for pinned loopback matching', () => {
  const previousLocalStorage = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return store.get(key) ?? null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };

  try {
    saveGateway(
      'gw-test.bcast.id',
      '100.72.10.26',
      '9f:26:0c:ab:28:37:91:b4:2a:1f:f3:28:63:4d:7e:53:07:67:59:55:02:7b:5f:8c:60:e6:83:ce:ef:1f:c9:fe',
    );

    const saved = loadSavedGateway();
    assert.match(String(saved?.savedAt), /^\d+$/);
    assert.deepEqual({
      gatewayDomain: saved?.gatewayDomain,
      localAddress: saved?.localAddress,
      fingerprint: saved?.fingerprint,
    }, {
      gatewayDomain: 'gw-test.bcast.id',
      localAddress: '100.72.10.26',
      fingerprint: '9f260cab283791b42a1ff328634d7e5307675955027b5f8c60e683ceef1fc9fe',
    });
  } finally {
    if (previousLocalStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = previousLocalStorage;
    }
  }
});

test('saved gateway rejects and evicts an unbounded savedAt, serves savedAt === now', (t) => {
  const NOW = 1_800_000_000_000;
  const store = new Map();
  mockGlobal(t, 'localStorage', {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  });
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(console, 'warn', () => {});

  const record = {
    gatewayDomain: 'gw-test.bcast.id',
    localAddress: '192.168.1.20',
    fingerprint: 'ab'.repeat(32),
  };
  const write = (savedAt) => store.set(
    'multicast-bridge-gw',
    JSON.stringify(savedAt === undefined ? record : { ...record, savedAt }),
  );

  // `now - savedAt` is negative here, so the pre-fix `< 30d` test passed and
  // the record outlived its window until wall-clock time caught up.
  write(NOW + 1);
  assert.equal(loadSavedGateway(), null, 'future savedAt must not serve');
  assert.equal(store.has('multicast-bridge-gw'), false, 'future savedAt must be evicted');

  // `NaN < 30d` is false, so the pre-fix predicate skipped the branch entirely
  // and fell through to the cross-check with the bad key still readable.
  write(undefined);
  assert.equal(loadSavedGateway(), null, 'absent savedAt must not serve');
  assert.equal(store.has('multicast-bridge-gw'), false, 'absent savedAt must be evicted');

  // Rejection is strictly `>`: a record saved this millisecond still serves.
  write(NOW);
  assert.equal(loadSavedGateway()?.gatewayDomain, 'gw-test.bcast.id');
  assert.equal(store.has('multicast-bridge-gw'), true, 'savedAt === now must survive');

  // The 30-day boundary itself is unchanged by the rewrite.
  write(NOW - 30 * 86400000);
  assert.equal(loadSavedGateway(), null, '30d old must not serve');
  write(NOW - (30 * 86400000 - 1));
  assert.equal(loadSavedGateway()?.gatewayDomain, 'gw-test.bcast.id');
});

test('discovery cache rejects poisoned fingerprints and normalizes valid pins', () => {
  const storage = new Map();
  const store = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const capability = { bridgeProtocol: 'bcds-v1', webTransportBridge: true };
  const base = {
    host: '192.168.1.10',
    httpPort: 33446,
    wtPort: 33445,
    ...capability,
  };

  store.setItem('multicast-bridge-discovery-cache-v1', JSON.stringify({
    status: 'found',
    httpPort: 33446,
    scope: 'default',
    expiresAt: 10_000,
    bridge: { ...base, fingerprint: 'deadbeef' },
  }));
  assert.equal(readBridgeDiscoveryCache(33446, 1, store), null);

  store.setItem('multicast-bridge-discovery-cache-v1', JSON.stringify({
    status: 'found',
    httpPort: 33446,
    scope: 'default',
    expiresAt: 10_000,
    bridge: {
      ...base,
      gatewayDomain: 'gw-test.bcast.id',
      fingerprint: '9F:26:0C:AB:28:37:91:B4:2A:1F:F3:28:63:4D:7E:53:07:67:59:55:02:7B:5F:8C:60:E6:83:CE:EF:1F:C9:FE',
    },
  }));
  assert.equal(
    readBridgeDiscoveryCache(33446, 1, store)?.bridge.fingerprint,
    '9f260cab283791b42a1ff328634d7e5307675955027b5f8c60e683ceef1fc9fe',
  );

  store.setItem('multicast-bridge-discovery-cache-v1', JSON.stringify({
    status: 'found',
    httpPort: 33446,
    scope: 'default',
    expiresAt: 10_000,
    bridge: { ...base, fingerprint: '' },
  }));
  assert.equal(readBridgeDiscoveryCache(33446, 1, store), null);
});

test('explicit certificate discovery uses the exact SHA-256 normalizer', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/multicast-bridge.js'), 'utf8');
  assert.match(src, /const fingerprint = normalizeFingerprint\(await fpResp\.text\(\)\);/);
  assert.doesNotMatch(src, /fpResp\.text\(\)\).*\{64,\}/);
});

test('multiple physical BCDS streams independently buffer and fan their base logical index into one subscription', async () => {
  const client = new BridgeClient();
  client.connected = true;

  const baseLogicalIndex = 7;
  const subscriptionId = 'server-sub';
  client._streamSubscriptions.set(baseLogicalIndex, subscriptionId);

  const packets = [];
  client.subscriptionCallbacks.set(subscriptionId, {
    onpacket(event) {
      packets.push(Array.from(new Uint8Array(event.data)));
    },
  });

  // BLO-8405 shards one logical flow over distinct physical BCDS wire
  // indices. The frame bodies retain the original logical index so all
  // shards must route to the same subscription.
  const shardCount = 4;
  const wireIndexA = baseLogicalIndex * shardCount;
  const wireIndexB = wireIndexA + 1;
  const streamA = makeControlledReadableStream();
  const streamB = makeControlledReadableStream();
  const consumeA = client._consumeUniStream(streamA.stream);
  const consumeB = client._consumeUniStream(streamB.stream);

  const frameA = makeLengthPrefixedFrame(
    makeStreamIndexFrame(baseLogicalIndex, [0xa1, 0xa2, 0xa3]),
  );
  const frameB = makeLengthPrefixedFrame(
    makeStreamIndexFrame(baseLogicalIndex, [0xb1, 0xb2]),
  );

  streamA.enqueue(makeDataStreamHeader(wireIndexA));
  streamA.enqueue(frameA.subarray(0, 6));
  await yieldToReaders();

  streamB.enqueue(makeDataStreamHeader(wireIndexB));
  streamB.enqueue(frameB.subarray(0, 5));
  await yieldToReaders();

  streamB.enqueue(frameB.subarray(5));
  await yieldToReaders();
  streamA.enqueue(frameA.subarray(6));
  streamA.close();
  streamB.close();
  await Promise.all([consumeA, consumeB]);

  assert.deepEqual(packets, [
    [0xb1, 0xb2],
    [0xa1, 0xa2, 0xa3],
  ]);
  assert.equal(client._debugStats.wtDataStreams, 2);
  assert.equal(client._debugStats.wtDataStreamFrames, 2);
  assert.equal(client._debugStats.wtDataStreamAbortedDrains, 0);
  assert.equal(client._debugStats.wtDataStreamProtocolErrors, 0);
  assert.equal(client.getStats().dataStreamBufferBytes, 0);
});

test('BCDS uni-stream accepts ArrayBuffer and typed-array-view chunks without copying unrelated bytes', async () => {
  const client = new BridgeClient();
  client.connected = true;
  client._streamSubscriptions.set(4, 'array-buffer-sub');
  const packets = [];
  client.subscriptionCallbacks.set('array-buffer-sub', {
    onpacket(event) { packets.push(Array.from(new Uint8Array(event.data))); },
  });

  const source = makeControlledReadableStream();
  const consuming = client._consumeUniStream(source.stream);
  const header = makeDataStreamHeader(4);
  const frame = makeLengthPrefixedFrame(makeStreamIndexFrame(4, [0xa1, 0xb2]));
  source.enqueue(header.buffer);

  // The view starts after a sentinel byte; a coercive `new Uint8Array(view)`
  // would lose the view's byte offset and deliver the wrong framing.
  const framed = new Uint8Array(frame.byteLength + 1);
  framed[0] = 0xff;
  framed.set(frame, 1);
  source.enqueue(new DataView(framed.buffer, 1, frame.byteLength));
  source.close();
  await consuming;

  assert.deepEqual(packets, [[0xa1, 0xb2]]);
  assert.equal(client._debugStats.wtDataStreamProtocolErrors, 0);
  assert.equal(client.getStats().dataStreamBufferBytes, 0);
});

test('BCDS uni-stream rejects arbitrary chunk values and cancels the reader', async () => {
  const client = new BridgeClient();
  client.connected = true;
  const source = makeControlledReadableStream();
  const consuming = client._consumeUniStream(source.stream);
  source.enqueue({ not: 'bytes' });
  await consuming;

  assert.equal(client._debugStats.wtDataStreamProtocolErrors, 1);
  assert.match(client._debugStats.wtLastDataStreamProtocolError, /byte buffer/);
  assert.equal(client.getStats().dataStreamBufferBytes, 0);
});

test('an empty BCDS uni-stream is a protocol error because the canonical header is mandatory', async () => {
  const client = new BridgeClient();
  client.connected = true;
  const source = makeControlledReadableStream();
  const consuming = client._consumeUniStream(source.stream);
  source.close();
  await consuming;

  assert.equal(client._debugStats.wtDataStreamProtocolErrors, 1);
  assert.match(client._debugStats.wtLastDataStreamProtocolError, /0\/8/);
});

test('BCDS uni-stream reports truncated canonical headers and packet frames at EOF', async () => {
  const headerSource = makeControlledReadableStream();
  const headerClient = new BridgeClient();
  headerClient.connected = true;
  const headerRead = headerClient._consumeUniStream(headerSource.stream);
  headerSource.enqueue(new Uint8Array([0x42, 0x43, 0x44]));
  headerSource.close();
  await headerRead;
  assert.equal(headerClient._debugStats.wtDataStreamProtocolErrors, 1);
  assert.match(headerClient._debugStats.wtLastDataStreamProtocolError, /truncated BCDS packet-stream header/);

  const frameSource = makeControlledReadableStream();
  const frameClient = new BridgeClient();
  frameClient.connected = true;
  const frameRead = frameClient._consumeUniStream(frameSource.stream);
  frameSource.enqueue(makeDataStreamHeader(2));
  const complete = makeLengthPrefixedFrame(makeStreamIndexFrame(2, [0x01, 0x02, 0x03]));
  frameSource.enqueue(complete.subarray(0, complete.byteLength - 1));
  frameSource.close();
  await frameRead;
  assert.equal(frameClient._debugStats.wtDataStreamProtocolErrors, 1);
  assert.match(frameClient._debugStats.wtLastDataStreamProtocolError, /truncated BCDS packet frame/);
  assert.equal(frameClient.getStats().dataStreamBufferBytes, 0);
});

test('subscribe messages carry latest reliable backlog and packet-ID policy when requested', () => {
  const client = new BridgeClient();
  const previousLocation = globalThis.location;
  globalThis.location = { href: 'https://example.test/player.html' };

  try {
    assert.deepEqual(
      client._buildSubscribeMessage({
        group: '232.1.1.50',
        port: 8000,
        source: '69.25.95.128',
        transportOpts: { reliableBacklog: 'latest', packetIds: [2, 515] },
      }, 'req-latest'),
      {
        type: 'subscribe',
        request_id: 'req-latest',
        client_type: 'bridge',
        group: '232.1.1.50',
        port: 8000,
        page_url: 'https://example.test/player.html',
        source: '69.25.95.128',
        reliable_backlog: 'latest',
        packet_ids: [2, 515],
      },
    );
  } finally {
    globalThis.location = previousLocation;
  }
});

// Shared with the IWA gateway and the native BCDS bridge, which both refuse a
// `packet_ids` list naming the MMTP signaling flow (BLO-35479). The page-side
// client refuses the same `signaling` vectors before it sends anything, so a
// bridge build that predates that refusal cannot accept a subscribe that the
// page's MMT receiver would then leave empty.
const PACKET_ID_CONTRACT = JSON.parse(readFileSync(
  new URL('./vectors/packet-id-allow-list-v1.json', import.meta.url),
  'utf8',
));

test('subscribe refuses the MMTP signaling packet_id before connecting or sending', async () => {
  const signaling = PACKET_ID_CONTRACT.reject.filter((vector) => vector.error === 'signaling');
  assert.ok(signaling.length > 0);
  const client = new BridgeClient();
  let connectAttempts = 0;
  client._ensureConnectedForSubscribe = async () => {
    connectAttempts += 1;
    throw new Error('must not connect');
  };
  const sent = [];
  client._sendSubscribeRequest = (entry) => {
    sent.push(entry);
    return Promise.reject(new Error('must not send'));
  };

  for (const vector of signaling) {
    await assert.rejects(
      client.subscribe('232.1.1.50', 8000, '69.25.95.128', { packetIds: vector.packetIds }),
      (error) => {
        assert.equal(error.name, 'MulticastError', vector.name);
        assert.equal(error.code, 'subscription-failed', vector.name);
        assert.equal(error.message, PACKET_ID_CONTRACT.errors.signaling, vector.name);
        return true;
      },
    );
  }
  assert.equal(connectAttempts, 0);
  assert.deepEqual(sent, []);

  // A list of track packet IDs passes the guard and proceeds to connect.
  await assert.rejects(
    client.subscribe('232.1.1.50', 8000, '69.25.95.128', { packetIds: [1, 4, 32769] }),
    /must not connect/,
  );
  assert.equal(connectAttempts, 1);
});

test('window.multicast bytes subscribe surfaces the signaling packet_id refusal', async () => {
  const client = new BridgeClient();
  client.connected = true;
  const sent = [];
  client._sendSubscribeRequest = (entry) => {
    sent.push(entry);
    return Promise.reject(new Error('must not send'));
  };

  await assert.rejects(
    subscribeMulticastBridgeBytes(client, { ...sharedBytesConfig, packetIds: [2, 0] }),
    (error) => {
      assert.equal(error.code, 'subscription-failed');
      assert.equal(error.message, PACKET_ID_CONTRACT.errors.signaling);
      return true;
    },
  );
  assert.deepEqual(sent, []);
});

test('WebTransport datagram reader dispatches frames and records byte diagnostics', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const frames = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = (bytes) => frames.push(Array.from(bytes));

  const reading = client._readIncomingDatagrams();
  source.enqueue(new Uint8Array([0x01, 0x02]));
  source.enqueue(new Uint8Array([0x03, 0x04, 0x05]));
  source.close();
  await reading;

  assert.deepEqual(frames, [[0x01, 0x02], [0x03, 0x04, 0x05]]);
  assert.equal(client._debugStats.wtDatagrams, 2);
  assert.equal(client._debugStats.wtDatagramBytes, 5);
  assert.equal(client._debugStats.wtDatagramReadErrors, 0);
  assert.ok(client._debugStats.wtLastDatagramAt > 0);
  assert.equal(client._wtDatagramReader, null);
});

test('stale WebTransport datagram readers cannot clear a replacement reader capability', async () => {
  const client = new BridgeClient();
  const sourceA = makeControlledReadableStream();
  const sourceB = makeControlledReadableStream();
  const frames = [];
  client.connected = true;
  client._handleTransportFrame = (bytes) => frames.push(Array.from(bytes));

  client._wt = { datagrams: { readable: sourceA.stream } };
  const readingA = client._readIncomingDatagrams();
  const readerA = client._wtDatagramReader;
  assert.ok(readerA);
  assert.equal(client._datagramCapable, true);
  assert.equal(client._datagramHeartbeatTimer, null);

  client._wt = { datagrams: { readable: sourceB.stream } };
  const readingB = client._readIncomingDatagrams();
  const readerB = client._wtDatagramReader;
  assert.ok(readerB);
  assert.notEqual(readerA, readerB);

  sourceA.enqueue(new Uint8Array([0xa1]));
  await yieldToReaders();

  assert.deepEqual(frames, []);
  assert.equal(client._datagramFramesReceived, 0);

  sourceB.enqueue(new Uint8Array([0xb1]));
  await yieldToReaders();

  assert.deepEqual(frames, [[0xb1]]);
  assert.equal(client._datagramFramesReceived, 1);

  sourceA.close();
  await readingA;

  assert.equal(client._wtDatagramReader, readerB);
  assert.equal(client._datagramCapable, true);
  assert.equal(client._datagramHeartbeatTimer, null);

  sourceB.close();
  await readingB;

  assert.equal(client._wtDatagramReader, null);
  assert.equal(client._datagramCapable, false);
  assert.equal(client._datagramHeartbeatTimer, null);
});

test('a retired WebTransport bidi reader ignores a late control frame', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const retiredWt = {};
  const replacementWt = {};
  client.connected = true;
  client._wt = retiredWt;

  const reading = client._readBidiStream(source.stream.getReader(), retiredWt);
  client._wt = replacementWt;
  source.enqueue(makeJsonBidiFrame({
    type: 'subscription_stream',
    subscription_id: 'stale-subscription',
    stream_index: 13,
  }));
  source.close();
  await reading;

  assert.equal(client._streamSubscriptions.has(13), false);
});

test('disconnect cancels the active WebTransport datagram reader', async () => {
  const client = new BridgeClient();
  let cancelled = 0;
  let closed = 0;
  client.connected = true;
  client._wtDatagramReader = {
    cancel: async () => { cancelled++; },
  };
  client._wt = { close() { closed++; } };

  client.disconnect();
  await yieldToReaders();

  assert.equal(cancelled, 1);
  assert.equal(closed, 1);
  assert.equal(client._wtDatagramReader, null);
  assert.equal(client.connected, false);
});

for (const closeOutcome of ['resolve', 'reject']) {
  test(`a retired WebTransport ${closeOutcome} cannot cancel a scheduled reconnect`, async (t) => {
    let settleClosed;
    mockGlobal(t, 'WebTransport', class WebTransportStub {
      constructor() {
        this.ready = Promise.resolve();
        this.closed = new Promise((resolve, reject) => {
          settleClosed = closeOutcome === 'resolve' ? resolve : reject;
        });
      }

      close() {}
    });
    mockGlobal(t, 'location', { href: 'https://example.test/live' });
    mockGlobal(t, 'document', { title: 'test page' });
    mockGlobal(t, 'navigator', { userAgent: 'test' });
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const client = new BridgeClient();
    client._openBidiStream = async () => {};
    client._sendControlWithWriteAck = async () => {};
    client._readIncomingStreams = () => {};
    client._readIncomingDatagrams = () => {};
    client._startKeepalive = () => {};
    client._markSubscriptionProgress = () => {};
    client._startSubscriptionWatchdog = () => {};
    client._replayActiveSubscriptions = async () => {};
    client._lastConnectArgs = {
      host: 'bridge.test',
      httpPort: 443,
      options: {},
    };
    client._desiredSubscriptions.set('subscription-1', new Set([{}]));
    client.activeSubscriptions.add('subscription-1');

    await client._connectWebTransport('bridge.test', 443, '');
    assert.equal(
      await client._recoverSubscriptionReplacedDuringTeardown('subscription-1'),
      true,
    );
    const reconnectTimer = client._reconnectTimer;
    assert.ok(reconnectTimer, 'disconnect must schedule reconnect');

    settleClosed(closeOutcome === 'reject' ? new Error('retired session') : undefined);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(client._wt, null);
    assert.equal(
      client._reconnectTimer,
      reconnectTimer,
      'retired session close must not clear reconnect',
    );
    client.disconnect();
  });
}

for (const closeOutcome of ['resolve', 'reject']) {
  test(`a retired WebTransport ${closeOutcome} cannot tear down a connected replacement`, async (t) => {
    const sessions = [];
    mockGlobal(t, 'WebTransport', class WebTransportStub {
      constructor() {
        let settleClosed;
        let rejectClosed;
        this.ready = Promise.resolve();
        this.closed = new Promise((resolve, reject) => {
          settleClosed = resolve;
          rejectClosed = reject;
        });
        this.settleClosed = () => {
          if (closeOutcome === 'reject') rejectClosed(new Error('retired session'));
          else settleClosed();
        };
        this.closeCalls = 0;
        sessions.push(this);
      }

      close() { this.closeCalls++; }
    });
    mockGlobal(t, 'location', { href: 'https://example.test/live' });
    mockGlobal(t, 'document', { title: 'test page' });
    mockGlobal(t, 'navigator', { userAgent: 'test' });
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const client = new BridgeClient();
    client._openBidiStream = async () => {};
    client._sendControlWithWriteAck = async () => {};
    client._readIncomingStreams = () => {};
    client._readIncomingDatagrams = () => {};
    client._startKeepalive = () => {};
    client._markSubscriptionProgress = () => {};
    client._startSubscriptionWatchdog = () => {};
    client._replayActiveSubscriptions = async () => {};
    client._lastConnectArgs = {
      host: 'bridge.test',
      httpPort: 443,
      options: {},
    };
    client._desiredSubscriptions.set('subscription-1', new Set([{}]));
    client.activeSubscriptions.add('subscription-1');

    await client._connectWebTransport('bridge.test', 443, '');
    const retiredWt = sessions[0];
    client._handleDisconnect();
    assert.equal(client.connected, false);

    await client._connectWebTransport('bridge.test', 443, '');
    const replacementWt = sessions[1];
    assert.equal(client._wt, replacementWt);
    assert.equal(client.connected, true);

    retiredWt.settleClosed();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(client._wt, replacementWt);
    assert.equal(client.connected, true, 'retired session close must not disconnect replacement');
    assert.equal(replacementWt.closeCalls, 0, 'retired session close must not close replacement');
    client.disconnect();
  });
}

test('a stale WebTransport handshake failure cannot clear or close its replacement', async (t) => {
  let rejectFirstReady;
  const sessions = [];
  mockGlobal(t, 'WebTransport', class WebTransportStub {
    constructor() {
      this.closeCalls = 0;
      this.closed = sessions.length === 0
        ? Promise.resolve()
        : new Promise((resolve) => { this.settleClosed = resolve; });
      this.ready = sessions.length === 0
        ? new Promise((_, reject) => { rejectFirstReady = reject; })
        : Promise.resolve();
      sessions.push(this);
    }

    close() { this.closeCalls++; }
  });
  mockGlobal(t, 'location', { href: 'https://example.test/live' });
  mockGlobal(t, 'document', { title: 'test page' });
  mockGlobal(t, 'navigator', { userAgent: 'test' });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const client = new BridgeClient();
  client._openBidiStream = async () => {};
  client._sendControlWithWriteAck = async () => {};
  client._readIncomingStreams = () => {};
  client._readIncomingDatagrams = () => {};
  client._startKeepalive = () => {};
  client._markSubscriptionProgress = () => {};
  client._startSubscriptionWatchdog = () => {};
  client._replayActiveSubscriptions = async () => {};

  const firstConnect = client._connectWebTransport('bridge.test', 443, '');
  const firstWt = sessions[0];
  assert.ok(firstWt);
  await client._connectWebTransport('bridge.test', 443, '');
  const replacementWt = sessions[1];
  assert.equal(client._wt, replacementWt);
  assert.equal(client.connected, true);

  rejectFirstReady(new Error('stale handshake failed'));
  // The prepatch cleanup captured `this._wt` after the replacement installed;
  // it then waited for the replacement's close grace period before rejecting.
  t.mock.timers.tick(750);
  await Promise.resolve();
  await Promise.resolve();
  await assert.rejects(firstConnect, /stale handshake failed/);

  assert.equal(client._wt, replacementWt);
  assert.equal(client.connected, true);
  assert.equal(firstWt.closeCalls, 1);
  assert.equal(replacementWt.closeCalls, 0);
  client.disconnect();
});

for (const phase of ['ready', 'bidi', 'hello']) {
  test(`a superseded ${phase} continuation cannot initialize the replacement`, async (t) => {
    let resumeFirst;
    let firstPaused;
    const paused = new Promise(resolve => { firstPaused = resolve; });
    const gate = new Promise(resolve => { resumeFirst = resolve; });
    const sessions = [];
    const opens = [];
    const hellos = [];
    mockGlobal(t, 'WebTransport', class {
      constructor() {
        this.id = sessions.length;
        this.ready = this.id === 0 && phase === 'ready' ? gate : Promise.resolve();
        this.closed = new Promise(() => {});
        sessions.push(this);
        if (this.id === 0 && phase === 'ready') firstPaused();
      }
      close() {}
      async createBidirectionalStream() {
        opens.push(this.id);
        if (this.id === 0 && phase === 'bidi') {
          firstPaused();
          await gate;
        }
        return {
          writable: new WritableStream({
            write: async () => {
              hellos.push(this.id);
              if (this.id === 0 && phase === 'hello') {
                firstPaused();
                await gate;
              }
            },
          }),
          readable: new ReadableStream(),
        };
      }
    });
    mockGlobal(t, 'location', { href: 'https://example.test/live' });
    mockGlobal(t, 'document', { title: 'test page' });
    mockGlobal(t, 'navigator', { userAgent: 'test' });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const client = new BridgeClient();
    const readers = [];
    client._readBidiStream = () => {};
    client._readIncomingStreams = () => readers.push(client._wt.id);
    client._readIncomingDatagrams = () => {};
    client._startKeepalive = () => {};
    client._startSubscriptionWatchdog = () => {};
    const first = client._connectWebTransport('bridge.test', 443, '');
    const rejected = assert.rejects(first, { name: 'AbortError' });
    await paused;
    await client._connectWebTransport('bridge.test', 443, '');
    const writer = client._bidiWriter;
    resumeFirst();
    await rejected;
    assert.equal(client._wt, sessions[1]);
    assert.equal(client._bidiWriter, writer);
    assert.deepEqual(opens, phase === 'ready' ? [1] : [0, 1]);
    assert.deepEqual(hellos, phase === 'hello' ? [0, 1] : [1]);
    assert.deepEqual(readers, [1]);
    client.disconnect();
  });
}

test('a retired WebTransport stream reader ignores a late incoming stream', async () => {
  const client = new BridgeClient();
  const retiredSource = makeControlledReadableStream();
  const retiredWt = { incomingUnidirectionalStreams: retiredSource.stream };
  const replacementWt = { incomingUnidirectionalStreams: new ReadableStream() };
  let consumed = 0;
  client.connected = true;
  client._consumeUniStream = () => { consumed++; };

  client._wt = retiredWt;
  const retiredRead = client._readIncomingStreams(retiredWt);
  client._wt = replacementWt;
  retiredSource.enqueue(new ReadableStream());
  retiredSource.close();
  await retiredRead;

  assert.equal(consumed, 0);
  client.disconnect();
});

test('transport options copy packet IDs instead of retaining caller-owned state', () => {
  const packetIds = [2, 515];
  const opts = multicastBridgeTransportOptionsFromConfig({
    reliableBacklog: 'latest',
    receiveTimestampSource: 'kernel-software',
    packetIds,
  });

  packetIds[0] = 99;
  assert.deepEqual(opts, {
    mode: 'native',
    reliableBacklog: 'latest',
    receiveTimestampSource: 'kernel-software',
    packetIds: [2, 515],
  });
});

test('canonical IP-multicast origin is native, including omitted origin', () => {
  assert.deepEqual(
    multicastBridgeTransportOptionsFromConfig({
      group: '232.0.0.1',
      port: 5001,
      consume: 'bytes',
      mode: 'tunnel',
      relay: '192.0.2.1',
      relayPort: 2268,
      amtRelay: '192.0.2.2',
      amtRelayPort: 2269,
    }),
    { mode: 'native' },
  );
  assert.deepEqual(
    multicastBridgeTransportOptionsFromConfig({
      group: '232.0.0.1',
      port: 5001,
      consume: 'bytes',
      origin: 'ip-multicast',
      mode: 'tunnel',
      amtRelay: '192.0.2.2',
      amtRelayPort: 2269,
    }),
    { origin: 'ip-multicast', mode: 'native' },
  );
});

test('canonical AMT origin remains tunnel-only and carries its relay', () => {
  assert.deepEqual(
    multicastBridgeTransportOptionsFromConfig({
      group: '232.0.0.1',
      port: 5001,
      consume: 'bytes',
      origin: 'amt',
      relay: '192.0.2.1',
      relayPort: 2268,
      mode: 'native',
    }),
    {
      origin: 'amt',
      mode: 'tunnel',
      amtRelay: '192.0.2.1',
      amtRelayPort: 2268,
    },
  );
});

function makeSharedSubscriptionClient({ failFirstUnsubscribe = false, transport } = {}) {
  const subscribeCalls = [];
  const unsubscribeCalls = [];
  const callbacks = new Map();
  let shouldFailUnsubscribe = failFirstUnsubscribe;
  let resolvedTransport = transport;

  return {
    subscribeCalls,
    unsubscribeCalls,
    callbacks,
    async subscribe(...args) {
      subscribeCalls.push(args);
      const subscriptionId = `native-${subscribeCalls.length}`;
      return {
        subscriptionId,
        get transport() { return resolvedTransport; },
        setCallbacks(value) {
          callbacks.set(subscriptionId, value);
        },
      };
    },
    setTransport(next) {
      resolvedTransport = next;
      for (const value of callbacks.values()) value.ontransportchange?.(next);
    },
    async unsubscribe(subscriptionId) {
      unsubscribeCalls.push(subscriptionId);
      if (shouldFailUnsubscribe) {
        shouldFailUnsubscribe = false;
        throw new Error('native unsubscribe failed');
      }
    },
  };
}

const sharedBytesConfig = Object.freeze({
  consume: 'bytes',
  group: '239.21.4.1',
  port: 8000,
});

test('a concurrent join retries after the previous last ref tears down its shared transport', async () => {
  const client = makeSharedSubscriptionClient();
  const first = await subscribeMulticastBridgeBytes(client, sharedBytesConfig);

  // The second call finds native-1, then yields at its already-resolved ready
  // promise. Teardown starts before that continuation can attach its ref.
  const secondPending = subscribeMulticastBridgeBytes(client, sharedBytesConfig);
  const firstTeardown = first.unsubscribe();
  const [second] = await Promise.all([secondPending, firstTeardown]);

  assert.equal(first.state, 'closed');
  assert.equal(second.id, 'native-2');
  assert.equal(second.state, 'connecting');
  assert.equal(client.subscribeCalls.length, 2);
  assert.deepEqual(client.unsubscribeCalls, ['native-1']);

  await second.unsubscribe();
  assert.deepEqual(client.unsubscribeCalls, ['native-1', 'native-2']);
});

test('a late logical subscriber inherits the shared transport state immediately', async () => {
  const client = makeSharedSubscriptionClient();
  const first = await subscribeMulticastBridgeBytes(client, sharedBytesConfig);

  client.callbacks.get('native-1').ontransportstate('connected');
  assert.equal(first.state, 'connected');

  const second = await subscribeMulticastBridgeBytes(client, sharedBytesConfig);
  assert.equal(second.id, 'native-1');
  assert.equal(second.state, 'connected');
  assert.equal(client.subscribeCalls.length, 1);

  await first.unsubscribe();
  await second.unsubscribe();
  assert.deepEqual(client.unsubscribeCalls, ['native-1']);
});

test('shared logical subscriptions expose initial and late resolved receiver transport', async () => {
  const client = makeSharedSubscriptionClient({ transport: 'native' });
  const first = await subscribeMulticastBridgeBytes(client, sharedBytesConfig);
  const second = await subscribeMulticastBridgeBytes(client, sharedBytesConfig);
  const firstChanges = [];
  const secondChanges = [];
  first.addEventListener('transportchange', (event) => firstChanges.push(event.detail));
  second.addEventListener('transportchange', (event) => secondChanges.push(event.detail));

  assert.equal(first.transport, 'native');
  assert.equal(second.transport, 'native');

  client.setTransport('amt');

  assert.equal(first.transport, 'amt');
  assert.equal(second.transport, 'amt');
  assert.deepEqual(firstChanges, ['amt']);
  assert.deepEqual(secondChanges, ['amt']);

  await first.unsubscribe();
  await second.unsubscribe();
});

test('throughput history counts one shared physical receiver before logical fan-out', async () => {
  const harness = makeReplayableBridgeClient(['native-throughput']);
  const config = { ...sharedBytesConfig, mode: 'native' };
  const first = await subscribeMulticastBridgeBytes(harness.client, config);
  const second = await subscribeMulticastBridgeBytes(harness.client, config);

  assert.deepEqual(harness.client.getThroughputHistory(1_000).samples.at(-1), {
    timestampMilliseconds: 1_000,
    aggregateBitsPerSecond: null,
    aggregateRateUnavailableReason: 'initial-baseline',
    subscriptions: [{
      id: 'bridge-receiver-1',
      transport: 'native',
      logicalConsumers: 2,
      bytesReceived: 0,
      bitsPerSecond: null,
      rateUnavailableReason: 'initial-baseline',
    }],
  });

  dispatchBcdsPacket(harness.client, 'native-throughput', new Uint8Array(1_000));

  assert.deepEqual(harness.client.getThroughputHistory(2_000).samples.at(-1), {
    timestampMilliseconds: 2_000,
    aggregateBitsPerSecond: 8_000,
    aggregateRateUnavailableReason: null,
    subscriptions: [{
      id: 'bridge-receiver-1',
      transport: 'native',
      logicalConsumers: 2,
      bytesReceived: 1_000,
      bitsPerSecond: 8_000,
      rateUnavailableReason: null,
    }],
  });

  await first.unsubscribe();
  assert.deepEqual(
    harness.client.getThroughputHistory(3_000).samples.at(-1).subscriptions,
    [{
      id: 'bridge-receiver-1',
      transport: 'native',
      logicalConsumers: 1,
      bytesReceived: 1_000,
      bitsPerSecond: 0,
      rateUnavailableReason: null,
    }],
  );
  await second.unsubscribe();
  const afterTeardown = harness.client.getThroughputHistory(3_500);
  assert.deepEqual(afterTeardown.samples.at(-1).subscriptions, []);
  assert.ok(afterTeardown.samples.some((sample) => sample.subscriptions.length === 1));
});

test('throughput reconnect replay creates a new receiver baseline even for a reused server ID', async () => {
  const harness = makeReplayableBridgeClient(['native-stable-throughput', 'native-stable-throughput']);
  const subscription = await subscribeMulticastBridgeBytes(harness.client, {
    ...sharedBytesConfig,
    mode: 'native',
  });
  harness.client.getThroughputHistory(1_000);

  harness.client.disconnect({
    preserveSubscriptions: true,
    notifySubscriptions: false,
    intentional: false,
  });
  const disconnected = harness.client.getThroughputHistory(1_500);
  assert.deepEqual(disconnected.samples.at(-1).subscriptions, []);

  harness.client.connected = true;
  await harness.client._replayActiveSubscriptions();
  const replayed = harness.client.getThroughputHistory(2_000);
  assert.deepEqual(replayed.samples.at(-1), {
    timestampMilliseconds: 2_000,
    aggregateBitsPerSecond: null,
    aggregateRateUnavailableReason: 'initial-baseline',
    subscriptions: [{
      id: 'bridge-receiver-2',
      transport: 'native',
      logicalConsumers: 1,
      bytesReceived: 0,
      bitsPerSecond: null,
      rateUnavailableReason: 'initial-baseline',
    }],
  });
  assert.ok(replayed.samples.some((sample) =>
    sample.subscriptions.some((receiver) => receiver.id === 'bridge-receiver-1')));

  await subscription.unsubscribe();
});

test('throughput history retains only the latest sixty one-second samples', () => {
  const client = new BridgeClient();
  for (let second = 0; second <= 65; second++) {
    client.getThroughputHistory(second * 1_000);
  }

  const history = client.getThroughputHistory(65_000);
  assert.equal(history.samples.length, 60);
  assert.equal(history.samples[0].timestampMilliseconds, 6_000);
  assert.equal(history.samples.at(-1).timestampMilliseconds, 65_000);
});

test('throughput history excludes tuner acquisition packets', async () => {
  const harness = makeReplayableBridgeClient(['tuner-throughput']);
  await subscribeMulticastBridgeBytes(harness.client, {
    consume: 'bytes',
    origin: 'tuner',
    standard: 'atsc3',
    group: '224.0.23.60',
    port: 4937,
    mode: 'native',
  });
  harness.client.getThroughputHistory(1_000);

  dispatchBcdsPacket(harness.client, 'tuner-throughput', new Uint8Array(512));

  assert.deepEqual(
    harness.client.getThroughputHistory(2_000).samples.at(-1).subscriptions,
    [],
  );
});

test('BridgeClient retains subscribe transport and publishes later server transitions', async () => {
  const client = new BridgeClient();
  client.connected = true;
  client._sendSubscribeRequest = async () => ({
    subscriptionId: 'resolved-transport',
    transport: 'native',
  });

  const subscription = await client.subscribe('232.1.1.50', 8000, '69.25.95.128', {
    mode: 'auto',
  });
  const changes = [];
  subscription.setCallbacks({ ontransportchange: (transport) => changes.push(transport) });

  assert.equal(subscription.transport, 'native');
  client._handleControlMessage(JSON.stringify({
    type: 'subscription_transport',
    subscription_id: 'resolved-transport',
    transport: 'amt',
  }));
  assert.equal(subscription.transport, 'amt');
  assert.deepEqual(changes, ['amt']);
});

test('BridgeClient parses resolved receiver transport from subscribe_response', () => {
  const client = new BridgeClient();
  let result;
  client.pendingRequests.set('req-resolved-transport', {
    resolve(value) { result = value; },
    reject(error) { throw error; },
  });

  client._handleControlMessage(JSON.stringify({
    type: 'subscribe_response',
    request_id: 'req-resolved-transport',
    success: true,
    subscription_id: 'resolved-transport',
    transport: 'amt',
  }));

  assert.deepEqual(result, {
    subscriptionId: 'resolved-transport',
    transport: 'amt',
  });
});

test('a failed subscribe_response rejects with the bridge failure code when it has one', () => {
  // BLO-35597: the native bridge answers an AMT relay's ICMP refusal of tunnel
  // admission with a typed code. The page must see the code, not only the text.
  const client = new BridgeClient();
  const rejected = [];
  for (const id of ['req-refused', 'req-untyped']) {
    client.pendingRequests.set(id, {
      resolve() { throw new Error('a failed subscribe must not resolve'); },
      reject(error) { rejected.push(error); },
    });
  }

  client._handleControlMessage(JSON.stringify({
    type: 'subscribe_response',
    request_id: 'req-refused',
    success: false,
    error: 'AMT relay 192.0.2.1:2268 refused tunnel admission',
    code: 'amt_relay_refused',
  }));
  client._handleControlMessage(JSON.stringify({
    type: 'subscribe_response',
    request_id: 'req-untyped',
    success: false,
    error: 'bind failed',
  }));

  assert.equal(rejected.length, 2);
  assert.equal(rejected[0].message, 'AMT relay 192.0.2.1:2268 refused tunnel admission');
  assert.equal(rejected[0].code, 'amt_relay_refused');
  assert.equal(rejected[1].message, 'bind failed');
  assert.equal('code' in rejected[1], false);
});

test('a rejected final unsubscribe restores the logical ref and remains retryable', async () => {
  const client = makeSharedSubscriptionClient({ failFirstUnsubscribe: true });
  const first = await subscribeMulticastBridgeBytes(client, sharedBytesConfig);
  const last = await subscribeMulticastBridgeBytes(client, sharedBytesConfig);

  assert.equal(first.id, 'native-1');
  assert.equal(last.id, 'native-1');
  assert.equal(client.subscribeCalls.length, 1);

  await first.unsubscribe();
  assert.equal(first.state, 'closed');
  assert.deepEqual(client.unsubscribeCalls, []);

  await assert.rejects(last.unsubscribe(), /native unsubscribe failed/);
  assert.notEqual(last.state, 'closed');
  assert.deepEqual(client.unsubscribeCalls, ['native-1']);

  const joinedAfterFailure = await subscribeMulticastBridgeBytes(client, sharedBytesConfig);
  assert.equal(joinedAfterFailure.id, 'native-1');
  assert.equal(client.subscribeCalls.length, 1, 'the rejected native subscription must remain shared');

  await joinedAfterFailure.unsubscribe();
  assert.equal(joinedAfterFailure.state, 'closed');
  assert.deepEqual(client.unsubscribeCalls, ['native-1']);

  const retry = last.unsubscribe();
  assert.equal(last.unsubscribe(), retry, 'concurrent retries must share one native teardown');
  await retry;
  assert.equal(last.state, 'closed');
  assert.deepEqual(client.unsubscribeCalls, ['native-1', 'native-1']);

  const replacement = await subscribeMulticastBridgeBytes(client, sharedBytesConfig);
  assert.equal(replacement.id, 'native-2');
  assert.equal(client.subscribeCalls.length, 2);
  await replacement.unsubscribe();
});

function makeReplayableBridgeClient(subscriptionIds) {
  const client = new BridgeClient();
  const ids = [...subscriptionIds];
  const controls = [];
  let subscribeCalls = 0;

  client.connected = true;
  client._sendSubscribeRequest = async () => {
    subscribeCalls++;
    const subscriptionId = ids.shift();
    if (!subscriptionId) throw new Error('missing test subscription ID');
    return subscriptionId;
  };
  client._sendControl = (message, meta) => {
    controls.push(message);
    meta?.writeOutcome?.resolve();
    if (message.type === 'unsubscribe') {
      queueMicrotask(() => client._handleControlMessage(JSON.stringify({
        type: 'unsubscribe_response',
        request_id: message.request_id,
      })));
    }
    return true;
  };

  return {
    client,
    controls,
    get subscribeCalls() { return subscribeCalls; },
  };
}

test('rejected async subscription callbacks are logged without escaping dispatch', async () => {
  const harness = makeReplayableBridgeClient([
    'native-async-callback',
    'native-async-callback',
  ]);
  const first = await harness.client.subscribe('239.21.4.1', 8000);
  const second = await harness.client.subscribe('239.21.4.1', 8000);
  const secondPackets = [];
  first.setCallbacks({
    async onpacket() {
      throw new Error('async packet callback failed');
    },
  });
  second.setCallbacks({
    onpacket: ({ data }) => secondPackets.push([...new Uint8Array(data)]),
  });

  const callbackErrors = [];
  const previousError = console.error;
  try {
    console.error = (...args) => callbackErrors.push(args);
    dispatchBcdsPacket(harness.client, 'native-async-callback', new Uint8Array([0x01]));
    await Promise.resolve();
  } finally {
    console.error = previousError;
  }

  assert.deepEqual(secondPackets, [[0x01]]);
  assert.equal(callbackErrors.length, 1);
  assert.match(String(callbackErrors[0][0]), /onpacket callback failed/);
  assert.match(String(callbackErrors[0][1]), /async packet callback failed/);
});

test('subscription callback throws do not starve siblings or reconnect scheduling', async () => {
  const harness = makeReplayableBridgeClient([
    'native-callback-failure',
    'native-callback-failure',
  ]);
  const first = await harness.client.subscribe('239.21.4.1', 8000);
  const second = await harness.client.subscribe('239.21.4.1', 8000);
  const secondEvents = [];
  first.setCallbacks({
    onpacket() { throw new Error('first packet callback failed'); },
    onerror() { throw new Error('first error callback failed'); },
    ontransportstate() { throw new Error('first state callback failed'); },
  });
  second.setCallbacks({
    onpacket() { secondEvents.push('packet'); },
    onerror() { secondEvents.push('error'); },
    ontransportstate(state) { secondEvents.push(state); },
  });

  const callbackErrors = [];
  const previousError = console.error;
  let reconnects = 0;
  try {
    console.error = (...args) => callbackErrors.push(args);
    dispatchBcdsPacket(harness.client, 'native-callback-failure', new Uint8Array([0x01]));
    harness.client._handleControlMessage(JSON.stringify({
      type: 'subscribe_error',
      subscription_id: 'native-callback-failure',
      error: 'server subscription failed',
    }));
    harness.client._lastConnectArgs = { host: 'bridge.test', httpPort: 33446, options: {} };
    harness.client._scheduleReconnect = () => { reconnects++; };
    harness.client._handleDisconnect();
  } finally {
    console.error = previousError;
  }

  assert.deepEqual(secondEvents, ['packet', 'error', 'reconnecting']);
  assert.equal(reconnects, 1);
  assert.equal(callbackErrors.length, 3);
});

test('duplicate server IDs retain independent direct subscribers through final teardown', async () => {
  const harness = makeReplayableBridgeClient([
    'native-shared-id',
    'native-shared-id',
    'native-shared-id',
  ]);
  const firstPackets = [];
  const updatedFirstPackets = [];
  const secondPackets = [];
  const first = await harness.client.subscribe('239.21.4.1', 8000);
  const second = await harness.client.subscribe('239.21.4.1', 8000);
  first.setCallbacks({ onpacket: ({ data }) => firstPackets.push([...new Uint8Array(data)]) });
  second.setCallbacks({ onpacket: ({ data }) => secondPackets.push([...new Uint8Array(data)]) });

  const dispatch = (value) => {
    dispatchBcdsPacket(harness.client, 'native-shared-id', new Uint8Array([value]));
  };

  dispatch(0x01);
  assert.deepEqual(firstPackets, [[0x01]]);
  assert.deepEqual(secondPackets, [[0x01]]);
  assert.equal(harness.client._desiredSubscriptions.get('native-shared-id')?.size, 2);

  first.setCallbacks({
    onpacket: ({ data }) => updatedFirstPackets.push([...new Uint8Array(data)]),
  });
  dispatch(0x02);
  assert.deepEqual(firstPackets, [[0x01]]);
  assert.deepEqual(updatedFirstPackets, [[0x02]]);
  assert.deepEqual(secondPackets, [[0x01], [0x02]]);

  await first.unsubscribe();
  await harness.client._replayActiveSubscriptions();
  dispatch(0x03);
  assert.deepEqual(firstPackets, [[0x01]]);
  assert.deepEqual(updatedFirstPackets, [[0x02]]);
  assert.deepEqual(secondPackets, [[0x01], [0x02], [0x03]]);
  assert.equal(harness.client._desiredSubscriptions.get('native-shared-id')?.size, 1);
  assert.equal(
    harness.controls.filter((message) => message.type === 'unsubscribe').length,
    0,
    'removing one local consumer must retain the shared server subscription',
  );

  await second.unsubscribe();
  assert.deepEqual(
    harness.controls.filter((message) => message.type === 'unsubscribe')
      .map((message) => message.subscription_id),
    ['native-shared-id'],
  );
  assert.equal(harness.client._desiredSubscriptions.size, 0);
});

test('replay absorbs distinct subscription IDs that converge on one server ID', async () => {
  const harness = makeReplayableBridgeClient([
    'native-old-a',
    'native-old-b',
    'native-old-b',
  ]);
  const first = await harness.client.subscribe('239.21.4.1', 8000);
  const second = await harness.client.subscribe('239.21.4.1', 8000);

  await harness.client._replayActiveSubscriptions();

  assert.equal(harness.subscribeCalls, 3, 'the absorbed replay entry must not issue another join');
  assert.equal(first.subscriptionId, 'native-old-b');
  assert.equal(second.subscriptionId, 'native-old-b');
  assert.deepEqual([...harness.client._desiredSubscriptions.keys()], ['native-old-b']);
  assert.equal(harness.client._desiredSubscriptions.get('native-old-b')?.size, 2);
});

test('a same-endpoint join during final teardown waits for it instead of resetting the transport', async () => {
  const harness = makeReplayableBridgeClient(['native-stable-id']);
  const original = await harness.client.subscribe('239.21.4.1', 8000);
  let finishTeardown;
  harness.client._sendUnsubscribeRequest = () => new Promise((resolve) => {
    finishTeardown = resolve;
  });
  let transportResets = 0;
  harness.client._handleDisconnect = () => { transportResets++; };

  const teardown = original.unsubscribe();
  await yieldToReaders();
  let replacementSent = 0;
  harness.client._sendSubscribeRequest = async () => {
    replacementSent++;
    return 'native-stable-id';
  };
  const replacementPending = harness.client.subscribe('239.21.4.1', 8000);
  await yieldToReaders();
  assert.equal(replacementSent, 0, 'the join must not reach the server before the unsubscribe completes');

  finishTeardown();
  await teardown;
  const replacement = await replacementPending;

  assert.equal(replacementSent, 1);
  assert.equal(transportResets, 0);
  assert.equal(replacement.active, true);
  assert.equal(harness.client._desiredSubscriptions.get('native-stable-id')?.size, 1);
});

test('final unsubscribe still resets transport when an unpredicted same-ID replacement installs during teardown', async () => {
  const harness = makeReplayableBridgeClient(['native-stable-id']);
  const original = await harness.client.subscribe('239.21.4.1', 8000);
  let finishTeardown;
  harness.client._sendUnsubscribeRequest = () => new Promise((resolve) => {
    finishTeardown = resolve;
  });

  const teardown = original.unsubscribe();
  await yieldToReaders();
  // A different endpoint cannot be matched to the teardown before sending,
  // yet this server answers with the same ID: only the backstop can catch it.
  harness.client._sendSubscribeRequest = async () => 'native-stable-id';
  const replacement = await harness.client.subscribe('239.21.4.9', 8000);
  let transportResets = 0;
  let resetSeen;
  const reset = new Promise((resolve) => { resetSeen = resolve; });
  harness.client._handleDisconnect = () => {
    transportResets++;
    resetSeen();
  };

  finishTeardown();
  await teardown;
  // The backstop runs after the release resolves, not inside it.
  await reset;

  assert.equal(transportResets, 1);
  assert.equal(replacement.active, true);
  assert.equal(harness.client._desiredSubscriptions.get('native-stable-id')?.size, 1);
});

// A BridgeClient on a fake BCDS server with the IWA's semantics: one
// subscription per `group:port@source` id, a duplicate subscribe reuses it and
// ignores its packet_ids (webtransport-server.ts:2479-2496), and an
// unsubscribe removes it before acknowledging (:2553-2580). A new session
// starts with an empty table. `holdUnsubscribes` keeps unsubscribe frames in
// flight until `releaseUnsubscribes()`; subscribes to a group in
// `holdSubscribesFor` wait unanswered until `releaseSubscribes()`.
function makeBcdsServerClient(t) {
  mockGlobal(t, 'location', { href: 'https://example.test/player.html' });
  const client = new BridgeClient();
  const harness = {
    client,
    frames: [],
    server: new Map(),
    session: 1,
    resets: 0,
    holdUnsubscribes: false,
    heldUnsubscribes: [],
    releaseUnsubscribes() {
      for (const release of harness.heldUnsubscribes.splice(0)) release();
    },
    holdSubscribesFor: new Set(),
    heldSubscribes: [],
    releaseSubscribes() {
      for (const release of harness.heldSubscribes.splice(0)) release();
    },
  };
  const respond = (response) => queueMicrotask(() => {
    client._handleControlMessage(JSON.stringify(response));
  });
  client.connected = true;
  client._lastConnectArgs = { host: 'bridge.test', httpPort: 1, options: {} };
  client.connect = async () => {
    harness.session++;
    harness.server.clear();
    client.connected = true;
    await client._replayActiveSubscriptions(null);
  };
  client._scheduleReconnect = () => {};
  const handleDisconnect = client._handleDisconnect.bind(client);
  client._handleDisconnect = (...args) => {
    harness.resets++;
    return handleDisconnect(...args);
  };
  client._sendControl = (message, meta) => {
    if (!client.connected) return false;
    const session = harness.session;
    harness.frames.push({ ...message, session });
    meta?.writeOutcome?.resolve();
    if (message.type === 'subscribe') {
      const id = `${message.group}:${message.port}${message.source ? `@${message.source}` : ''}`;
      if (!harness.server.has(id)) harness.server.set(id, message.packet_ids);
      const answer = () => respond({
        type: 'subscribe_response',
        request_id: message.request_id,
        success: true,
        subscription_id: id,
      });
      if (harness.holdSubscribesFor.has(message.group)) harness.heldSubscribes.push(answer);
      else answer();
    } else if (message.type === 'unsubscribe') {
      const process = () => {
        if (harness.session !== session) return;
        harness.server.delete(message.subscription_id);
        respond({ type: 'unsubscribe_response', request_id: message.request_id, success: true });
      };
      if (harness.holdUnsubscribes) harness.heldUnsubscribes.push(process);
      else process();
    }
    return true;
  };
  return harness;
}

const switchConfig = Object.freeze({ consume: 'bytes', group: '239.21.4.1', port: 8000 });
const switchId = '239.21.4.1:8000';

function subscriptionFrames(frames) {
  return frames
    .filter(({ type }) => type === 'subscribe' || type === 'unsubscribe')
    .map(({ type, group, subscription_id: id, packet_ids: packetIds, session }) => (
      type === 'subscribe' ? { type, group, packetIds, session } : { type, id, session }
    ));
}

function mmtpPacketForLifecycleTest(packetId, marker = 0) {
  return new Uint8Array([0x40, 0x00, packetId >> 8, packetId & 0xff, marker]);
}

test('a packet-ID switch on one endpoint unsubscribes on the wire before the new subscribe', async (t) => {
  const harness = makeBcdsServerClient(t);
  const other = await subscribeMulticastBridgeBytes(harness.client, {
    consume: 'bytes', group: '239.21.4.2', port: 8000, packetIds: [7],
  });
  const first = await subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [1] });
  harness.frames.length = 0;

  // The player's switch: release and resubscribe in one synchronous step.
  const released = first.unsubscribe();
  const switched = subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [2] });
  const [, second] = await Promise.all([released, switched]);

  assert.deepEqual(subscriptionFrames(harness.frames), [
    { type: 'unsubscribe', id: switchId, session: 1 },
    { type: 'subscribe', group: '239.21.4.1', packetIds: [2], session: 1 },
  ]);
  await yieldToReaders(); // let the detached replacement backstop run
  assert.deepEqual(harness.server.get(switchId), [2], 'the server must hold the new packet IDs');
  assert.equal(harness.resets, 0, 'no session reset');
  assert.equal(harness.session, 1, 'no reconnect');
  assert.equal(first.state, 'closed');
  assert.equal(second.id, switchId);

  assert.deepEqual(harness.server.get('239.21.4.2:8000'), [7], 'the other membership is untouched');
  assert.equal(other.id, '239.21.4.2:8000');
  assert.equal(harness.client._desiredSubscriptions.get('239.21.4.2:8000')?.size, 1);
  const otherBytes = [];
  const secondBytes = [];
  other.addEventListener('bytes', ({ detail }) => otherBytes.push((detail.data ?? detail).byteLength));
  second.addEventListener('bytes', ({ detail }) => secondBytes.push((detail.data ?? detail).byteLength));
  dispatchBcdsPacket(harness.client, '239.21.4.2:8000', mmtpPacketForLifecycleTest(7), 3);
  dispatchBcdsPacket(harness.client, switchId, mmtpPacketForLifecycleTest(2), 4);
  assert.deepEqual(otherBytes, [5]);
  assert.deepEqual(secondBytes, [5]);
});

test('a switch survives two successive packet-ID changes without a reset', async (t) => {
  const harness = makeBcdsServerClient(t);
  let current = await subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [1] });
  harness.frames.length = 0;

  for (const packetIds of [[2], [3]]) {
    const released = current.unsubscribe();
    const switched = subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds });
    [, current] = await Promise.all([released, switched]);
  }

  assert.deepEqual(subscriptionFrames(harness.frames), [
    { type: 'unsubscribe', id: switchId, session: 1 },
    { type: 'subscribe', group: '239.21.4.1', packetIds: [2], session: 1 },
    { type: 'unsubscribe', id: switchId, session: 1 },
    { type: 'subscribe', group: '239.21.4.1', packetIds: [3], session: 1 },
  ]);
  await yieldToReaders(); // let the detached replacement backstop run
  assert.deepEqual(harness.server.get(switchId), [3]);
  assert.equal(harness.resets, 0);
  assert.equal(harness.client._desiredSubscriptions.get(switchId)?.size, 1);
});

test('a switch whose unsubscribe is in flight when the bridge disconnects joins the next session', async (t) => {
  const harness = makeBcdsServerClient(t);
  const other = await subscribeMulticastBridgeBytes(harness.client, {
    consume: 'bytes', group: '239.21.4.2', port: 8000,
  });
  const first = await subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [1] });
  harness.frames.length = 0;
  harness.holdUnsubscribes = true;

  const released = first.unsubscribe();
  const switched = subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [2] });
  await yieldToReaders();
  assert.deepEqual(subscriptionFrames(harness.frames), [
    { type: 'unsubscribe', id: switchId, session: 1 },
  ], 'the join must wait for the unsubscribe it would collide with');

  // The transport dies with the unsubscribe unacknowledged.
  harness.client._handleDisconnect();
  const [, second] = await Promise.all([released, switched]);

  assert.equal(harness.session, 2, 'the join reconnects instead of failing');
  assert.deepEqual(
    subscriptionFrames(harness.frames).filter(({ group }) => group === '239.21.4.1'),
    [{ type: 'subscribe', group: '239.21.4.1', packetIds: [2], session: 2 }],
    'the join is never sent on the session its unsubscribe may still reach',
  );
  assert.equal(second.id, switchId);
  assert.equal(first.state, 'closed');
  assert.equal(harness.client._desiredSubscriptions.get(switchId)?.size, 1);
  assert.equal(
    harness.client._desiredSubscriptions.get('239.21.4.2:8000')?.size,
    1,
    'the other subscription is replayed, not dropped',
  );
  assert.equal(other.id, '239.21.4.2:8000');
});

test('a switch whose unsubscribe is in flight fails closed when the bridge cannot reconnect', async (t) => {
  const harness = makeBcdsServerClient(t);
  // Another live subscription makes the disconnect preserve subscriptions, so
  // the held join tries to follow them onto a next session that never comes.
  await subscribeMulticastBridgeBytes(harness.client, { consume: 'bytes', group: '239.21.4.2', port: 8000 });
  const first = await subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [1] });
  harness.frames.length = 0;
  harness.holdUnsubscribes = true;
  harness.client._lastConnectArgs = null;

  const released = first.unsubscribe();
  const switched = subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [2] });
  await yieldToReaders();
  harness.client._handleDisconnect();

  await released;
  await assert.rejects(switched, /Not connected to bridge/);
  assert.deepEqual(subscriptionFrames(harness.frames), [
    { type: 'unsubscribe', id: switchId, session: 1 },
  ]);
  assert.equal(harness.client._desiredSubscriptions.has(switchId), false);
});

test('identical-key subscribers still share one server subscription', async (t) => {
  const harness = makeBcdsServerClient(t);
  const config = { ...switchConfig, packetIds: [1] };
  const first = await subscribeMulticastBridgeBytes(harness.client, config);
  const second = await subscribeMulticastBridgeBytes(harness.client, config);
  await first.unsubscribe();
  const third = await subscribeMulticastBridgeBytes(harness.client, config);

  assert.deepEqual(subscriptionFrames(harness.frames), [
    { type: 'subscribe', group: '239.21.4.1', packetIds: [1], session: 1 },
  ], 'a retained shared subscription needs no further server frames');
  assert.equal(second.id, switchId);
  assert.equal(third.id, switchId);
  assert.equal(harness.client._desiredSubscriptions.get(switchId)?.size, 1);

  await Promise.all([second.unsubscribe(), third.unsubscribe()]);
  await yieldToReaders(); // let the detached replacement backstop run
  assert.deepEqual(subscriptionFrames(harness.frames).slice(1), [
    { type: 'unsubscribe', id: switchId, session: 1 },
  ]);
  assert.equal(harness.resets, 0);
});

test('a held switch on the only stream follows a lost session to the next one', async (t) => {
  const harness = makeBcdsServerClient(t);
  const first = await subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [1] });
  harness.frames.length = 0;
  harness.holdUnsubscribes = true;
  let apiRemoved = 0;
  harness.client._onDisconnect = () => { apiRemoved++; };

  const released = first.unsubscribe();
  const switched = subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [2] });
  await yieldToReaders();
  // Nothing else is desired: only the held join keeps the page registry
  // alive across the lost session.
  harness.client._handleDisconnect();
  const [, second] = await Promise.all([released, switched]);

  assert.equal(apiRemoved, 0, 'the client stays in use for the held join');
  assert.equal(harness.session, 2);
  assert.deepEqual(subscriptionFrames(harness.frames), [
    { type: 'unsubscribe', id: switchId, session: 1 },
    { type: 'subscribe', group: '239.21.4.1', packetIds: [2], session: 2 },
  ]);
  assert.equal(second.id, switchId);
  assert.deepEqual(harness.server.get(switchId), [2]);
  assert.equal(harness.client._desiredSubscriptions.get(switchId)?.size, 1);

  harness.holdUnsubscribes = false;
  await second.unsubscribe();
  assert.equal(harness.client._desiredSubscriptions.size, 0, 'no orphaned entry survives the release');
  assert.equal(harness.server.has(switchId), false, 'the server membership is released');
});

test('a held switch is rejected, not installed, when its client is disconnected on purpose', async (t) => {
  const harness = makeBcdsServerClient(t);
  const first = await subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [1] });
  harness.frames.length = 0;
  harness.holdUnsubscribes = true;

  const released = first.unsubscribe();
  const switched = subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [2] });
  await yieldToReaders();
  // Teardown drops every subscription and invalidates the page registry the
  // held join belongs to. The owner then reconnects the same client before
  // the join resumes, as `connect()` clears the manual-disconnect latch.
  harness.client.disconnect();
  harness.client._manualDisconnect = false;
  const reconnected = harness.client.connect();

  await released;
  await assert.rejects(switched, /Disconnected/);
  await reconnected;
  assert.deepEqual(subscriptionFrames(harness.frames), [
    { type: 'unsubscribe', id: switchId, session: 1 },
  ], 'the rejected join never reaches the new session');
  assert.equal(harness.client._desiredSubscriptions.size, 0);

  harness.holdUnsubscribes = false;
  const again = await subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [2] });
  assert.deepEqual(harness.server.get(switchId), [2]);
  await again.unsubscribe();
  assert.equal(harness.client._desiredSubscriptions.size, 0, 'no orphaned entry survives the release');
  assert.equal(harness.server.has(switchId), false, 'the server membership is released');
});

test('a held switch survives the client retiring a transport whose unsubscribe write stalls', async (t) => {
  const harness = makeBcdsServerClient(t);
  const first = await subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [1] });
  harness.frames.length = 0;
  const sendControl = harness.client._sendControl;
  harness.client._sendControl = (message, meta) => {
    if (message.type !== 'unsubscribe') return sendControl(message, meta);
    // Accepted but never flushed (transport backpressure): the write settles
    // neither way, so the client must retire this transport itself.
    harness.frames.push({ ...message, session: harness.session });
    harness.client._sendControl = sendControl;
    return true;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });

  // The only stream switches filter: nothing else is desired when the client
  // retires the session after the unsubscribe deadline.
  const released = first.unsubscribe();
  const switched = subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [2] });
  t.mock.timers.tick(5000);
  const [, second] = await Promise.all([released, switched]);

  assert.equal(harness.resets, 1, 'the stalled write retires the session');
  assert.equal(harness.session, 2, 'the join follows the client onto its next session');
  assert.deepEqual(subscriptionFrames(harness.frames), [
    { type: 'unsubscribe', id: switchId, session: 1 },
    { type: 'subscribe', group: '239.21.4.1', packetIds: [2], session: 2 },
  ]);
  assert.equal(second.id, switchId);
  assert.deepEqual(harness.server.get(switchId), [2]);
  assert.equal(harness.client._desiredSubscriptions.get(switchId)?.size, 1);

  await second.unsubscribe();
  assert.equal(harness.client._desiredSubscriptions.size, 0, 'no orphaned entry survives the release');
  assert.equal(harness.server.has(switchId), false, 'the server membership is released');
});

test('a subscribe joining an on-demand reconnect is rejected, without reconnecting, when that session drops every subscription', async (t) => {
  const harness = makeBcdsServerClient(t);
  harness.client.connected = false;
  const connect = harness.client.connect;
  let dropsDuringHello = true;
  let connectCalls = 0;
  harness.client.connect = async () => {
    connectCalls++;
    if (!dropsDuringHello) return connect();
    dropsDuringHello = false;
    await yieldToReaders();
    // The session opens and closes during hello with nothing desired: the
    // disconnect preserves nothing and invalidates the page registry.
    harness.client.connected = true;
    harness.client._handleDisconnect();
    throw new DOMException('WebTransport connection superseded', 'AbortError');
  };
  // The page layer abandons a client when it reports the lost session.
  let abandoned = 0;
  harness.client._onDisconnect = () => { abandoned++; };

  // The first subscribe owns the on-demand reconnect; the second joins it.
  const owner = subscribeMulticastBridgeBytes(harness.client, {
    consume: 'bytes', group: '239.21.4.2', port: 8000,
  });
  const joined = subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [1] });

  await assert.rejects(owner, { name: 'AbortError' });
  await assert.rejects(joined, /Disconnected/);
  assert.deepEqual(subscriptionFrames(harness.frames), [], 'no join outlives the invalidated registry');
  assert.equal(harness.client._desiredSubscriptions.size, 0);
  assert.equal(harness.server.size, 0);
  // The abandoned client must stay closed: a session opened for the rejected
  // join would be owned by nobody, and its eventual close would report a
  // second disconnect from a client the page already replaced.
  assert.equal(abandoned, 1);
  assert.equal(connectCalls, 1, 'the rejected join starts no connect of its own');
  assert.equal(harness.client.connected, false);
  harness.client._handleDisconnect();
  assert.equal(abandoned, 1, 'no orphaned session reports a second disconnect');
});

test('a switch is not held behind an unrelated subscribe still in flight', async (t) => {
  const harness = makeBcdsServerClient(t);
  const first = await subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [1] });
  // Slow discovery on another group: its subscribe stays unanswered.
  harness.holdSubscribesFor.add('239.21.4.2');
  const unrelated = subscribeMulticastBridgeBytes(harness.client, {
    consume: 'bytes', group: '239.21.4.2', port: 8000,
  });
  await yieldToReaders();
  harness.frames.length = 0;

  const released = first.unsubscribe();
  const second = await subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [2] });
  assert.deepEqual(subscriptionFrames(harness.frames), [
    { type: 'unsubscribe', id: switchId, session: 1 },
    { type: 'subscribe', group: '239.21.4.1', packetIds: [2], session: 1 },
  ], 'the join waits for its own unsubscribe only');
  assert.equal(second.id, switchId);

  harness.holdSubscribesFor.clear();
  harness.releaseSubscribes();
  await Promise.all([released, unrelated]);
  await yieldToReaders(); // let the detached replacement backstop run
  assert.equal(harness.resets, 0, 'the replacement check ignores a join ordered after the teardown');
  assert.deepEqual(harness.server.get(switchId), [2]);
});

test('a release resolves when its server unsubscribe settles, not behind an unrelated subscribe', async (t) => {
  const harness = makeBcdsServerClient(t);
  const config = { ...switchConfig, packetIds: [1] };
  const first = await subscribeMulticastBridgeBytes(harness.client, config);
  // Slow discovery on another group: its subscribe stays unanswered.
  harness.holdSubscribesFor.add('239.21.4.2');
  const unrelated = subscribeMulticastBridgeBytes(harness.client, {
    consume: 'bytes', group: '239.21.4.2', port: 8000,
  });
  await yieldToReaders();
  harness.frames.length = 0;

  // A pool awaits the release before subscribing again; the page registry
  // waits on the same teardown before resubscribing an identical key.
  let releaseSettled = false;
  const released = first.unsubscribe().then(() => { releaseSettled = true; });
  const again = subscribeMulticastBridgeBytes(harness.client, config);
  await yieldToReaders();

  assert.equal(releaseSettled, true, 'the release does not wait for the unrelated join');
  assert.deepEqual(subscriptionFrames(harness.frames), [
    { type: 'unsubscribe', id: switchId, session: 1 },
    { type: 'subscribe', group: '239.21.4.1', packetIds: [1], session: 1 },
  ], 'the identical-key join follows the acknowledged unsubscribe');
  const second = await again;
  assert.equal(second.id, switchId);

  harness.holdSubscribesFor.clear();
  harness.releaseSubscribes();
  await Promise.all([released, unrelated]);
  await yieldToReaders(); // let the detached replacement backstop run
  assert.equal(harness.resets, 0, 'the detached backstop ignores the join ordered after the teardown');
  assert.deepEqual(harness.server.get(switchId), [1]);
  assert.equal(harness.client._desiredSubscriptions.get(switchId)?.size, 1);
});

test('a same-endpoint join during stale replay cleanup waits for it instead of resetting', async (t) => {
  const harness = makeBcdsServerClient(t);
  const first = await subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [1] });
  harness.client._handleDisconnect();
  // Reconnect with the replay subscribe unanswered, then switch during it.
  harness.holdSubscribesFor.add(switchConfig.group);
  const reconnected = harness.client.connect();
  harness.holdUnsubscribes = true;
  const released = first.unsubscribe();
  const switched = subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [2] });
  await yieldToReaders();

  // The server answers the replay subscribe, then the final unsubscribe.
  harness.holdSubscribesFor.clear();
  harness.holdUnsubscribes = false;
  harness.releaseSubscribes();
  harness.releaseUnsubscribes();
  const [, second] = await Promise.all([released, switched, reconnected]);

  assert.deepEqual(subscriptionFrames(harness.frames).filter(({ session }) => session === 2), [
    { type: 'subscribe', group: '239.21.4.1', packetIds: [1], session: 2 },
    { type: 'unsubscribe', id: switchId, session: 2 },
    { type: 'unsubscribe', id: switchId, session: 2 },
    { type: 'subscribe', group: '239.21.4.1', packetIds: [2], session: 2 },
  ], 'the replay orphan is released before the join is sent');
  assert.equal(harness.resets, 1, 'only the initial disconnect');
  assert.equal(harness.session, 2);
  assert.equal(second.id, switchId);
  assert.deepEqual(harness.server.get(switchId), [2]);
  assert.equal(harness.client._desiredSubscriptions.get(switchId)?.size, 1);
});

test('stale replay cleanup never resets a same-endpoint join that sends while it drains', async (t) => {
  // The join's unsubscribe can settle, and the join send, in any microtask of
  // the orphan cleanup, including the tick after its drain returns. Sweep
  // both answer orders across gaps wider than those paths are deep.
  for (const unsubscribeFirst of [false, true]) {
    for (let gap = 0; gap <= 12; gap++) {
      const label = `${unsubscribeFirst ? 'unsubscribe' : 'replay subscribe'} answered first, gap ${gap}`;
      await t.test(label, async (st) => {
        const harness = makeBcdsServerClient(st);
        const first = await subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [1] });
        harness.client._handleDisconnect();
        harness.holdSubscribesFor.add(switchConfig.group);
        const reconnected = harness.client.connect();
        harness.holdUnsubscribes = true;
        const released = first.unsubscribe();
        const switched = subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [2] });
        await yieldToReaders();

        harness.holdSubscribesFor.clear();
        harness.holdUnsubscribes = false;
        const [answerFirst, answerSecond] = unsubscribeFirst
          ? [() => harness.releaseUnsubscribes(), () => harness.releaseSubscribes()]
          : [() => harness.releaseSubscribes(), () => harness.releaseUnsubscribes()];
        answerFirst();
        for (let tick = 0; tick < gap; tick++) await Promise.resolve();
        answerSecond();
        const [, second] = await Promise.all([released, switched, reconnected]);
        await yieldToReaders(); // let the detached replacement backstop run

        assert.equal(harness.resets, 1, 'only the initial disconnect');
        assert.equal(harness.client.connected, true);
        assert.equal(second.id, switchId);
        assert.deepEqual(harness.server.get(switchId), [2], 'the server holds the join');
        assert.equal(harness.client._desiredSubscriptions.get(switchId)?.size, 1);
      });
    }
  }
});

test('same-endpoint packet-ID consumers share one receiver instead of resetting', async (t) => {
  const harness = makeBcdsServerClient(t);
  const first = await subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [1] });
  harness.frames.length = 0;

  // Main's per-endpoint packet-ID contract keeps one physical receiver and
  // filters each logical consumer locally; a make-before-break acquisition
  // must therefore not manufacture a second server subscription or reset.
  const second = await subscribeMulticastBridgeBytes(harness.client, { ...switchConfig, packetIds: [2] });
  await first.unsubscribe();
  assert.deepEqual(subscriptionFrames(harness.frames), [], 'the shared receiver needs no wire switch');
  assert.equal(harness.resets, 0, 'sharing does not retire the session');
  assert.deepEqual(harness.server.get(switchId), [1], 'the older server filter remains valid for page filtering');
  assert.equal(second.id, switchId);
});

test('an identical-key subscribe during the last release resubscribes after it', async (t) => {
  const harness = makeBcdsServerClient(t);
  const config = { ...switchConfig, packetIds: [1] };
  const first = await subscribeMulticastBridgeBytes(harness.client, config);
  harness.frames.length = 0;
  harness.holdUnsubscribes = true;

  const released = first.unsubscribe();
  const again = subscribeMulticastBridgeBytes(harness.client, config);
  await yieldToReaders();
  assert.deepEqual(subscriptionFrames(harness.frames), [
    { type: 'unsubscribe', id: switchId, session: 1 },
  ]);
  harness.releaseUnsubscribes();
  const [, second] = await Promise.all([released, again]);

  assert.deepEqual(subscriptionFrames(harness.frames), [
    { type: 'unsubscribe', id: switchId, session: 1 },
    { type: 'subscribe', group: '239.21.4.1', packetIds: [1], session: 1 },
  ]);
  await yieldToReaders(); // let the detached replacement backstop run
  assert.equal(harness.resets, 0);
  assert.equal(first.state, 'closed');
  assert.equal(second.id, switchId);
  assert.deepEqual(harness.server.get(switchId), [1]);
  assert.equal(harness.client._desiredSubscriptions.get(switchId)?.size, 1, 'one live shared subscription');
});

test('shared bytes teardown follows the subscription ID replaced by reconnect replay', async () => {
  const harness = makeReplayableBridgeClient(['native-before-reconnect', 'native-after-reconnect']);
  const subscription = await subscribeMulticastBridgeBytes(harness.client, sharedBytesConfig);

  assert.equal(subscription.id, 'native-before-reconnect');
  await harness.client._replayActiveSubscriptions();

  assert.equal(subscription.id, 'native-after-reconnect');
  assert.deepEqual([...harness.client._desiredSubscriptions.keys()], ['native-after-reconnect']);
  assert.deepEqual([...harness.client.activeSubscriptions], ['native-after-reconnect']);
  assert.equal(harness.client.subscriptionCallbacks.has('native-before-reconnect'), false);
  assert.equal(harness.client.subscriptionCallbacks.has('native-after-reconnect'), true);

  await subscription.unsubscribe();
  assert.equal(subscription.state, 'closed');
  assert.deepEqual(
    harness.controls.filter((message) => message.type === 'unsubscribe')
      .map((message) => message.subscription_id),
    ['native-after-reconnect'],
  );
  assert.equal(harness.client._desiredSubscriptions.size, 0);
  assert.equal(harness.client.activeSubscriptions.size, 0);
  assert.equal(harness.client.subscriptionCallbacks.size, 0);
});

test('unsubscribe during replay tears down the late replacement without resurrecting it', async () => {
  const harness = makeReplayableBridgeClient(['native-before-race']);
  const subscription = await subscribeMulticastBridgeBytes(harness.client, sharedBytesConfig);
  let resolveReplay;
  harness.client._sendSubscribeRequest = () => new Promise((resolve) => {
    resolveReplay = resolve;
  });

  const replay = harness.client._replayActiveSubscriptions();
  await yieldToReaders();
  assert.equal(typeof resolveReplay, 'function');

  await subscription.unsubscribe();
  assert.equal(subscription.state, 'closed');
  resolveReplay('native-after-cancelled-replay');
  await replay;

  assert.deepEqual(
    harness.controls.filter((message) => message.type === 'unsubscribe')
      .map((message) => message.subscription_id),
    ['native-before-race', 'native-after-cancelled-replay'],
  );
  assert.equal(harness.client._desiredSubscriptions.size, 0);
  assert.equal(harness.client.activeSubscriptions.size, 0);
  assert.equal(harness.client.subscriptionCallbacks.size, 0);
  assert.equal(harness.client._streamSubscriptions.size, 0);
});

test('retired replay cannot mutate replacement subscription state', async () => {
  const harness = makeReplayableBridgeClient(['native-before-replay']);
  const retiredWt = {};
  const replacementWt = {};
  harness.client._wt = retiredWt;
  await harness.client.subscribe('239.21.4.1', 8000);

  let resolveReplay;
  harness.client._sendSubscribeRequest = () => new Promise((resolve) => {
    resolveReplay = resolve;
  });
  const replay = harness.client._replayActiveSubscriptions();
  await yieldToReaders();
  assert.equal(typeof resolveReplay, 'function');

  const replacementEntries = new Set([{
    subscriptionId: 'native-current',
    callbacks: {},
  }]);
  const replacementFanout = { sentinel: true };
  harness.client._desiredSubscriptions.set('native-current', replacementEntries);
  harness.client.activeSubscriptions.add('native-current');
  harness.client.subscriptionCallbacks.set('native-current', replacementFanout);
  harness.client._streamSubscriptions.set(11, 'native-current');
  harness.client._controlWriteGeneration++;
  harness.client._wt = replacementWt;

  resolveReplay('native-late-replay');
  await replay;

  assert.deepEqual(
    [...harness.client._desiredSubscriptions.keys()],
    ['native-before-replay', 'native-current'],
  );
  assert.equal(harness.client.activeSubscriptions.has('native-before-replay'), true);
  assert.equal(harness.client.activeSubscriptions.has('native-current'), true);
  assert.equal(
    harness.client.subscriptionCallbacks.get('native-current'),
    replacementFanout,
  );
  assert.deepEqual([...harness.client._streamSubscriptions], [[11, 'native-current']]);
  assert.deepEqual(
    harness.controls.filter((message) => message.type === 'unsubscribe'),
    [],
  );
});

test('stale replay drains replacement ownership added during an earlier pending join', async () => {
  const harness = makeReplayableBridgeClient(['native-before-race']);
  const original = await harness.client.subscribe('239.21.4.1', 8000);
  let resolveReplay;
  let resolveEarlierPending;
  let resolveReplacement;
  let request = 0;
  harness.client._sendSubscribeRequest = () => new Promise((resolve) => {
    request++;
    if (request === 1) resolveReplay = resolve;
    else if (request === 2) resolveEarlierPending = resolve;
    else resolveReplacement = resolve;
  });

  const replay = harness.client._replayActiveSubscriptions();
  await yieldToReaders();
  await original.unsubscribe();
  const earlierPending = harness.client.subscribe('239.21.4.2', 8001);
  resolveReplay('native-after-race');
  await yieldToReaders();

  const replacementPending = harness.client.subscribe('239.21.4.1', 8000);
  resolveEarlierPending('native-unrelated');
  await earlierPending;
  await yieldToReaders();

  assert.deepEqual(
    harness.controls.filter((message) => message.type === 'unsubscribe')
      .map((message) => message.subscription_id),
    ['native-before-race'],
    'stale replay cleanup must wait while replacement ownership is pending',
  );

  resolveReplacement('native-after-race');
  const [replacement] = await Promise.all([replacementPending, replay]);
  assert.equal(replacement.active, true);
  assert.deepEqual(
    [...harness.client._desiredSubscriptions.keys()],
    ['native-unrelated', 'native-after-race'],
  );
  assert.deepEqual(
    harness.controls.filter((message) => message.type === 'unsubscribe')
      .map((message) => message.subscription_id),
    ['native-before-race'],
  );
});

test('stale replay unsubscribe timeout retires the transport immediately', async (t) => {
  const harness = makeReplayableBridgeClient(['native-before-timeout']);
  const original = await harness.client.subscribe('239.21.4.1', 8000);
  let resolveReplay;
  harness.client._sendSubscribeRequest = () => new Promise((resolve) => {
    resolveReplay = resolve;
  });

  const replay = harness.client._replayActiveSubscriptions();
  await Promise.resolve();
  assert.equal(typeof resolveReplay, 'function');
  await original.unsubscribe();

  // Preserve the real control-write acknowledgement but deliberately omit the
  // server's unsubscribe_response so the production timeout path is exercised.
  let cleanupWritten;
  const cleanupStarted = new Promise((resolve) => { cleanupWritten = resolve; });
  harness.client._sendControl = (message, meta) => {
    harness.controls.push(message);
    meta?.writeOutcome?.resolve();
    if (message.subscription_id === 'native-orphan-timeout') cleanupWritten();
    return true;
  };
  let transportResets = 0;
  harness.client._handleDisconnect = () => { transportResets++; };
  t.mock.timers.enable({ apis: ['setTimeout'] });

  resolveReplay('native-orphan-timeout');
  await cleanupStarted;
  t.mock.timers.tick(5000);
  await replay;

  assert.equal(transportResets, 1);
  assert.equal(harness.client._desiredSubscriptions.size, 0);
  assert.deepEqual(
    harness.controls.filter((message) => message.type === 'unsubscribe')
      .map((message) => message.subscription_id),
    ['native-before-timeout', 'native-orphan-timeout'],
  );
});

test('stale replay cleanup retires a transport whose unsubscribe write stalls', async (t) => {
  const harness = makeReplayableBridgeClient(['native-before-stalled-write']);
  const original = await harness.client.subscribe('239.21.4.1', 8000);
  let resolveReplay;
  harness.client._sendSubscribeRequest = () => new Promise((resolve) => {
    resolveReplay = resolve;
  });

  const replay = harness.client._replayActiveSubscriptions();
  await Promise.resolve();
  await original.unsubscribe();

  let cleanupWritten;
  const cleanupStarted = new Promise((resolve) => { cleanupWritten = resolve; });
  harness.client._sendControl = (message) => {
    harness.controls.push(message);
    if (message.subscription_id === 'native-orphan-stalled-write') cleanupWritten();
    // Deliberately never settle meta.writeOutcome: this models a writer.write()
    // held indefinitely by transport backpressure.
    return true;
  };
  let transportResets = 0;
  harness.client._handleDisconnect = () => { transportResets++; };
  t.mock.timers.enable({ apis: ['setTimeout'] });

  resolveReplay('native-orphan-stalled-write');
  await cleanupStarted;
  t.mock.timers.tick(5000);
  await replay;

  assert.equal(transportResets, 1);
  assert.equal(harness.client.pendingRequests.size, 0);
  assert.deepEqual(
    harness.controls.filter((message) => message.type === 'unsubscribe')
      .map((message) => message.subscription_id),
    ['native-before-stalled-write', 'native-orphan-stalled-write'],
  );
});

test('ordinary unsubscribe timeout retires its queued write before same-ID replacement', async (t) => {
  const harness = makeReplayableBridgeClient(['native-late-write', 'native-late-write']);
  const original = await harness.client.subscribe('239.21.4.1', 8000);
  let settleOldWrite;
  let oldTransportRetired = false;
  let serverActive = true;
  harness.client._sendControl = BridgeClient.prototype._sendControl;
  harness.client._transport = 'webtransport';
  harness.client._bidiWriter = {
    write() {
      return new Promise((resolve) => {
        settleOldWrite = () => {
          if (!oldTransportRetired) serverActive = false;
          resolve();
        };
      });
    },
    close() {
      oldTransportRetired = true;
      return Promise.resolve();
    },
  };
  let transportResets = 0;
  harness.client._wt = {
    close() {
      transportResets++;
      oldTransportRetired = true;
    },
  };
  let apiRemoved = 0;
  harness.client._onDisconnect = () => { apiRemoved++; };
  harness.client._lastConnectArgs = { host: 'bridge.test', httpPort: 443, options: {} };
  harness.client.connect = async () => {
    harness.client._manualDisconnect = false;
    harness.client.connected = true;
    harness.client._transport = 'webtransport';
    harness.client._bidiWriter = {
      write: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    harness.client._wt = { close() {} };
  };
  const sendSubscribeRequest = harness.client._sendSubscribeRequest;
  harness.client._sendSubscribeRequest = async (...args) => {
    const subscriptionId = await sendSubscribeRequest(...args);
    serverActive = true;
    return subscriptionId;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const teardown = original.unsubscribe();
  assert.equal(typeof settleOldWrite, 'function');
  t.mock.timers.tick(5000);
  await teardown;

  assert.equal(harness.client.connected, false);
  assert.notEqual(harness.client._reconnectTimer, null);
  t.mock.timers.tick(1500);
  await Promise.resolve();
  await harness.client._reconnectPromise;
  const replacement = await harness.client.subscribe('239.21.4.1', 8000);
  settleOldWrite();
  await Promise.resolve();

  assert.equal(transportResets, 1);
  assert.equal(apiRemoved, 0, 'forced retirement must preserve replacement capability');
  assert.equal(replacement.active, true);
  assert.equal(serverActive, true, 'retired transport must not deliver the stale unsubscribe');
  assert.equal(harness.client._desiredSubscriptions.get('native-late-write')?.size, 1);
  assert.equal(harness.client.pendingRequests.size, 0);
});

test('stale replay cleanup queues a second real reconnect and restores server delivery', async (t) => {
  const harness = makeReplayableBridgeClient(['native-before-cleanup']);
  const original = await harness.client.subscribe('239.21.4.1', 8000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  let resolveReplay;
  let resolveReplacement;
  let finishCleanup;
  let cleanupStarted;
  const cleanupHasStarted = new Promise((resolve) => { cleanupStarted = resolve; });
  let serverActive = true;
  let request = 0;
  harness.client._sendSubscribeRequest = () => {
    request++;
    if (request === 1) {
      return new Promise((resolve) => { resolveReplay = resolve; });
    }
    if (request === 2) {
      return new Promise((resolve) => { resolveReplacement = resolve; });
    }
    serverActive = true;
    return Promise.resolve('native-after-cleanup');
  };
  const transportUnsubscribes = [];
  harness.client._sendUnsubscribeRequest = (subscriptionId) => {
    transportUnsubscribes.push(subscriptionId);
    if (subscriptionId === 'native-after-cleanup') {
      cleanupStarted();
      return new Promise((resolve) => {
        finishCleanup = () => {
          // The real server stores one entry per stable ID. Its stale
          // unsubscribe therefore removes the replacement subscribe too.
          serverActive = false;
          resolve();
        };
      });
    }
    serverActive = false;
    return Promise.resolve();
  };
  let transportResets = 0;
  let observeCleanupReset;
  const cleanupReset = new Promise((resolve) => { observeCleanupReset = resolve; });
  const installTransport = () => {
    harness.client._wt = {
      close() {
        transportResets++;
        serverActive = false;
        if (transportResets === 2) observeCleanupReset();
      },
    };
  };
  installTransport();
  harness.client._lastConnectArgs = { host: 'bridge.test', httpPort: 443, options: {} };
  harness.client.connect = async () => {
    harness.client._manualDisconnect = false;
    harness.client.connected = true;
    installTransport();
    await harness.client._replayActiveSubscriptions();
  };

  // Enter the production reconnect scheduler. The first connect attempt owns
  // `_reconnectPromise` while stale replay cleanup requests another reset.
  harness.client._handleDisconnect();
  t.mock.timers.tick(1500);
  await flushMicrotasks();
  assert.notEqual(harness.client._reconnectPromise, null);
  await original.unsubscribe();
  resolveReplay('native-after-cleanup');
  await cleanupHasStarted;

  // A different endpoint that this server answers with the same ID: the
  // client cannot match it to the cleanup before sending, so only the reset
  // backstop can catch it. A same-endpoint join waits for the cleanup instead
  // (see 'a same-endpoint join during stale replay cleanup waits for it').
  const replacementPending = harness.client.subscribe('239.21.4.9', 8000);
  serverActive = true;
  resolveReplacement('native-after-cleanup');
  const replacement = await replacementPending;
  const packets = [];
  replacement.setCallbacks({
    onpacket: ({ data }) => packets.push([...new Uint8Array(data)]),
  });
  finishCleanup();
  await cleanupReset;
  assert.equal(
    harness.client._reconnectAfterCurrent,
    true,
    'reset during replay must queue recovery behind the active reconnect',
  );
  await harness.client._reconnectPromise;
  await flushMicrotasks();
  assert.notEqual(harness.client._reconnectTimer, null);

  t.mock.timers.tick(1500);
  await flushMicrotasks();
  await harness.client._reconnectPromise;
  await flushMicrotasks();

  if (serverActive) {
    dispatchBcdsPacket(harness.client, 'native-after-cleanup', new Uint8Array([0x2a]));
  }

  assert.equal(replacement.active, true);
  assert.equal(serverActive, true, 'reconnect replay must recreate the de-duplicated server entry');
  assert.deepEqual(packets, [[0x2a]], 'replacement delivery must resume after cleanup');
  assert.equal(transportResets, 2, 'initial disconnect and stale-cleanup reset both retire transport');
  assert.equal(request, 3, 'initial replay, replacement, and reconnect replay must each subscribe');
  assert.equal(harness.client._desiredSubscriptions.get('native-after-cleanup')?.size, 1);
  assert.equal(harness.client.activeSubscriptions.has('native-after-cleanup'), true);
  assert.equal(harness.client.subscriptionCallbacks.has('native-after-cleanup'), true);
  assert.deepEqual(
    transportUnsubscribes,
    ['native-before-cleanup', 'native-after-cleanup'],
  );
});

test('intentional disconnect invalidates shared bytes before an identical resubscribe', async () => {
  const harness = makeReplayableBridgeClient(['native-before-disconnect', 'native-after-disconnect']);
  const first = await subscribeMulticastBridgeBytes(harness.client, sharedBytesConfig);

  harness.client.disconnect({ notifySubscriptions: false });
  assert.equal(first.state, 'closed');
  assert.equal(harness.client._desiredSubscriptions.size, 0);

  harness.client.connected = true;
  const second = await subscribeMulticastBridgeBytes(harness.client, sharedBytesConfig);
  assert.equal(harness.subscribeCalls, 2);
  assert.equal(second.id, 'native-after-disconnect');

  await first.unsubscribe();
  assert.equal(
    harness.controls.filter((message) => message.type === 'unsubscribe').length,
    0,
    'the invalidated handle must not tear down its replacement',
  );

  await second.unsubscribe();
  assert.deepEqual(
    harness.controls.filter((message) => message.type === 'unsubscribe')
      .map((message) => message.subscription_id),
    ['native-after-disconnect'],
  );
});

test('shared unsubscribe rollback preserves every real BridgeClient map and remains reusable', async () => {
  const harness = makeReplayableBridgeClient(['native-transactional']);
  const subscription = await subscribeMulticastBridgeBytes(harness.client, sharedBytesConfig);
  const desired = harness.client._desiredSubscriptions.get(subscription.id);
  const callbacks = harness.client.subscriptionCallbacks.get(subscription.id);
  harness.client._streamSubscriptions.set(17, subscription.id);
  const successfulSendControl = harness.client._sendControl;
  harness.client._sendControl = () => { throw new Error('control send failed'); };

  await assert.rejects(subscription.unsubscribe(), /control send failed/);

  assert.notEqual(subscription.state, 'closed');
  assert.equal(harness.client._desiredSubscriptions.get(subscription.id), desired);
  assert.equal(harness.client.subscriptionCallbacks.get(subscription.id), callbacks);
  assert.equal(harness.client.activeSubscriptions.has(subscription.id), true);
  assert.equal(harness.client._streamSubscriptions.get(17), subscription.id);
  assert.equal(harness.client.pendingRequests.size, 0);

  const joinedAfterFailure = await subscribeMulticastBridgeBytes(harness.client, sharedBytesConfig);
  assert.equal(joinedAfterFailure.id, subscription.id);
  assert.equal(harness.subscribeCalls, 1, 'the restored real subscription must remain shared');

  harness.client._sendControl = successfulSendControl;
  await joinedAfterFailure.unsubscribe();
  await subscription.unsubscribe();
  assert.deepEqual(
    harness.controls.filter((message) => message.type === 'unsubscribe')
      .map((message) => message.subscription_id),
    ['native-transactional'],
  );
});

test('asynchronous control write failure restores real unsubscribe state and shared ref', async () => {
  const harness = makeReplayableBridgeClient(['native-async-write']);
  const subscription = await subscribeMulticastBridgeBytes(harness.client, sharedBytesConfig);
  const desired = harness.client._desiredSubscriptions.get(subscription.id);
  const callbacks = harness.client.subscriptionCallbacks.get(subscription.id);
  harness.client._streamSubscriptions.set(23, subscription.id);
  harness.client._sendControl = BridgeClient.prototype._sendControl;
  harness.client._transport = 'webtransport';
  harness.client._bidiWriter = {
    write() {
      return Promise.reject(new Error('async control write failed'));
    },
  };

  await assert.rejects(subscription.unsubscribe(), /async control write failed/);

  assert.notEqual(subscription.state, 'closed');
  assert.equal(harness.client._desiredSubscriptions.get(subscription.id), desired);
  assert.equal(harness.client.subscriptionCallbacks.get(subscription.id), callbacks);
  assert.equal(harness.client.activeSubscriptions.has(subscription.id), true);
  assert.equal(harness.client._streamSubscriptions.get(23), subscription.id);
  assert.equal(harness.client.pendingRequests.size, 0);
  assert.equal(harness.client._debugStats.wtControlWriteErrors, 1);

  const joinedAfterFailure = await subscribeMulticastBridgeBytes(
    harness.client,
    sharedBytesConfig,
  );
  assert.equal(joinedAfterFailure.id, subscription.id);
  assert.equal(harness.subscribeCalls, 1, 'the restored native subscription must remain shared');

  const successfulUnsubscribes = [];
  harness.client._bidiWriter = {
    write(frame) {
      const message = decodeControlFrame(frame);
      successfulUnsubscribes.push(message.subscription_id);
      queueMicrotask(() => harness.client._handleControlMessage(JSON.stringify({
        type: 'unsubscribe_response',
        request_id: message.request_id,
      })));
      return Promise.resolve();
    },
  };
  await joinedAfterFailure.unsubscribe();
  await subscription.unsubscribe();
  assert.deepEqual(successfulUnsubscribes, ['native-async-write']);
  assert.equal(harness.client._desiredSubscriptions.size, 0);
  assert.equal(harness.client.activeSubscriptions.size, 0);
  assert.equal(harness.client.subscriptionCallbacks.size, 0);
  assert.equal(harness.client._streamSubscriptions.size, 0);
});

test('disconnect during an in-flight unsubscribe write cannot resurrect real client state', async () => {
  const harness = makeReplayableBridgeClient([
    'native-before-control-reset',
    'native-after-control-reset',
  ]);
  const subscription = await subscribeMulticastBridgeBytes(
    harness.client,
    sharedBytesConfig,
  );
  harness.client._streamSubscriptions.set(29, subscription.id);
  const successfulSendControl = harness.client._sendControl;
  let resolveWrite;
  let writes = 0;
  harness.client._sendControl = BridgeClient.prototype._sendControl;
  harness.client._transport = 'webtransport';
  harness.client._bidiWriter = {
    write() {
      writes++;
      return new Promise((resolve) => {
        resolveWrite = resolve;
      });
    },
    close() {
      return Promise.resolve();
    },
  };

  const unsubscribe = subscription.unsubscribe();
  await Promise.resolve();
  assert.equal(writes, 1, 'the unsubscribe control write must be in flight');
  const generationBeforeDisconnect = harness.client._controlWriteGeneration;
  harness.client.disconnect({ notifySubscriptions: false });

  await assert.rejects(unsubscribe, /Bridge control channel reset/);
  assert.equal(subscription.state, 'closed');
  assert.equal(harness.client.connected, false);
  assert.equal(
    harness.client._controlWriteGeneration,
    generationBeforeDisconnect + 1,
  );
  assert.equal(harness.client._desiredSubscriptions.size, 0);
  assert.equal(harness.client.activeSubscriptions.size, 0);
  assert.equal(harness.client.subscriptionCallbacks.size, 0);
  assert.equal(harness.client._streamSubscriptions.size, 0);
  assert.equal(harness.client.pendingRequests.size, 0);

  resolveWrite();
  await yieldToReaders();

  harness.client.connected = true;
  harness.client._sendControl = successfulSendControl;
  const replacement = await subscribeMulticastBridgeBytes(
    harness.client,
    sharedBytesConfig,
  );
  assert.equal(replacement.id, 'native-after-control-reset');
  assert.equal(harness.subscribeCalls, 2);
  await replacement.unsubscribe();
});

test('reconnect-preserving disconnect closes a shared ref when native rollback is suppressed', async () => {
  const harness = makeReplayableBridgeClient([
    'native-a-before-reset',
    'native-b-before-reset',
    'native-b-after-reset',
    'native-a-after-reset',
  ]);
  const subscriptionA = await subscribeMulticastBridgeBytes(
    harness.client,
    sharedBytesConfig,
  );
  const configB = {
    ...sharedBytesConfig,
    group: '239.21.4.2',
  };
  const subscriptionB = await subscribeMulticastBridgeBytes(harness.client, configB);
  const successfulSendControl = harness.client._sendControl;
  let resolveWrite;
  let writes = 0;
  harness.client._sendControl = BridgeClient.prototype._sendControl;
  harness.client._transport = 'webtransport';
  harness.client._bidiWriter = {
    write() {
      writes++;
      return new Promise((resolve) => {
        resolveWrite = resolve;
      });
    },
    close() {
      return Promise.resolve();
    },
  };

  const unsubscribeA = subscriptionA.unsubscribe();
  await Promise.resolve();
  assert.equal(writes, 1, 'subscription A teardown must be in flight');

  harness.client._handleDisconnect();

  await assert.rejects(unsubscribeA, /Bridge control channel reset/);
  assert.equal(subscriptionA.state, 'closed');
  assert.equal(subscriptionA.id, 'native-a-before-reset');
  assert.deepEqual(
    [...harness.client._desiredSubscriptions.keys()],
    ['native-b-before-reset'],
    'subscription B keeps the reconnect-preserving path active',
  );
  assert.deepEqual([...harness.client.activeSubscriptions], ['native-b-before-reset']);
  assert.equal(harness.client.subscriptionCallbacks.has('native-a-before-reset'), false);
  assert.equal(harness.client.subscriptionCallbacks.has('native-b-before-reset'), true);

  resolveWrite();
  await yieldToReaders();

  harness.client.connected = true;
  harness.client._sendControl = successfulSendControl;
  await harness.client._replayActiveSubscriptions();
  assert.equal(subscriptionB.id, 'native-b-after-reset');

  const replacementA = await subscribeMulticastBridgeBytes(
    harness.client,
    sharedBytesConfig,
  );
  assert.equal(replacementA.id, 'native-a-after-reset');
  assert.equal(harness.subscribeCalls, 4);

  await subscriptionB.unsubscribe();
  await replacementA.unsubscribe();
});

test('failed cancelled-replay cleanup resets the transport to retire the replacement', async () => {
  const harness = makeReplayableBridgeClient(['native-before-cleanup-failure']);
  const subscription = await subscribeMulticastBridgeBytes(harness.client, sharedBytesConfig);
  let resolveReplay;
  harness.client._sendSubscribeRequest = () => new Promise((resolve) => {
    resolveReplay = resolve;
  });

  const replay = harness.client._replayActiveSubscriptions();
  await yieldToReaders();
  assert.equal(typeof resolveReplay, 'function');

  await subscription.unsubscribe();
  assert.equal(subscription.state, 'closed');

  let transportCloses = 0;
  harness.client._wt = {
    close() {
      transportCloses++;
    },
  };
  harness.client._sendControl = (message, meta) => {
    harness.controls.push(message);
    meta?.writeOutcome?.reject(new Error('cancelled replay cleanup write failed'));
    return true;
  };

  resolveReplay('native-after-cancelled-replay');
  await replay;

  assert.equal(transportCloses, 1);
  assert.equal(harness.client.connected, false);
  assert.deepEqual(
    harness.controls.filter((message) => message.type === 'unsubscribe')
      .map((message) => message.subscription_id),
    ['native-before-cleanup-failure', 'native-after-cancelled-replay'],
  );
  assert.equal(harness.client._desiredSubscriptions.size, 0);
  assert.equal(harness.client.activeSubscriptions.size, 0);
  assert.equal(harness.client.subscriptionCallbacks.size, 0);
  assert.equal(harness.client.pendingRequests.size, 0);
});

test('retired replay cleanup rejection cannot disconnect the replacement transport', async () => {
  const harness = makeReplayableBridgeClient(['native-before-cleanup-race']);
  const original = await harness.client.subscribe('239.21.4.1', 8000);
  const retiredWt = { id: 'retired' };
  const replacementWt = { id: 'replacement' };
  harness.client._wt = retiredWt;

  let resolveReplay;
  harness.client._sendSubscribeRequest = () => new Promise((resolve) => {
    resolveReplay = resolve;
  });
  const replay = harness.client._replayActiveSubscriptions();
  await yieldToReaders();
  assert.equal(typeof resolveReplay, 'function');

  await original.unsubscribe();
  let rejectCleanup;
  let cleanupStarted;
  const cleanupHasStarted = new Promise((resolve) => { cleanupStarted = resolve; });
  harness.client._sendUnsubscribeRequest = () => new Promise((_, reject) => {
    rejectCleanup = reject;
    cleanupStarted();
  });

  // Let the replay enter the cleanup catch while it still owns the retired
  // transport, then install the replacement from the warning callback. This
  // exercises the guard immediately before the fix: the old implementation
  // would disconnect the replacement because it checked only `connected`.
  const warn = console.warn;
  console.warn = (...args) => {
    harness.client._wt = replacementWt;
    warn(...args);
  };

  resolveReplay('native-after-cleanup-race');
  await cleanupHasStarted;
  rejectCleanup(new Error('retired cleanup failed'));
  try {
    await replay;
  } finally {
    console.warn = warn;
  }

  assert.equal(harness.client._wt, replacementWt);
  assert.equal(harness.client.connected, true);
});

test('colon-containing endpoint tuples cannot alias one shared native subscription', async () => {
  const client = makeSharedSubscriptionClient();
  const first = await subscribeMulticastBridgeBytes(client, {
    consume: 'bytes',
    source: '2001:db8::1',
    group: 'ff3e::8000',
    port: 9000,
  });
  const second = await subscribeMulticastBridgeBytes(client, {
    consume: 'bytes',
    source: '2001:db8',
    group: ':1:ff3e::8000',
    port: 9000,
  });

  assert.equal(first.id, 'native-1');
  assert.equal(second.id, 'native-2');
  assert.equal(client.subscribeCalls.length, 2);

  await Promise.all([first.unsubscribe(), second.unsubscribe()]);
  assert.deepEqual(client.unsubscribeCalls.sort(), ['native-1', 'native-2']);
});

test('subscribe messages carry optional receive timestamp source', () => {
  const client = new BridgeClient();
  const previousLocation = globalThis.location;
  globalThis.location = { href: 'https://example.test/timing/' };

  try {
    assert.deepEqual(
      client._buildSubscribeMessage({
        group: '232.0.0.2',
        port: 5002,
        source: '69.25.95.199',
        transportOpts: {
          reliableBacklog: 'ordered',
          receiveTimestampSource: 'kernel-software',
        },
      }, 'req-timing'),
      {
        type: 'subscribe',
        request_id: 'req-timing',
        client_type: 'bridge',
        page_url: 'https://example.test/timing/',
        group: '232.0.0.2',
        port: 5002,
        source: '69.25.95.199',
        reliable_backlog: 'ordered',
        receive_timestamp_source: 'kernel-software',
      },
    );
  } finally {
    globalThis.location = previousLocation;
  }
});

test('bytes subscriptions preserve optional packet receiveTime metadata', async () => {
  let callbacks;
  const packet = new Uint8Array([0x42, 0x43]).buffer;
  const bridgeClient = {
    async subscribe(group, port, source, transportOpts) {
      assert.equal(group, '232.0.0.2');
      assert.equal(port, 5002);
      assert.equal(source, '69.25.95.199');
      assert.equal(transportOpts.receiveTimestampSource, 'kernel-software');
      return {
        subscriptionId: 'timing-sub',
        setCallbacks(next) {
          callbacks = next;
        },
      };
    },
    async unsubscribe() {},
  };

  const sub = await subscribeMulticastBridgeBytes(bridgeClient, {
    group: '232.0.0.2',
    port: 5002,
    source: '69.25.95.199',
    consume: 'bytes',
    receiveTimestampSource: 'kernel-software',
  });

  const details = [];
  sub.addEventListener('bytes', (event) => details.push(event.detail));
  callbacks.onpacket({
    data: packet,
    receiveTime: 123.5,
    receiveTimeOrigin: 1_700_000_000_000,
    receiveTimestampSource: 'kernel-software',
  });

  assert.deepEqual(details, [{
    data: packet,
    receiveTime: 123.5,
    receiveTimeOrigin: 1_700_000_000_000,
    receiveTimestampSource: 'kernel-software',
  }]);
  await sub.unsubscribe();
});

test('stream-index metadata v1 frames are rejected', () => {
  const client = new BridgeClient();
  const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const events = [];
  const warnings = [];
  const previousWarn = console.warn;

  client._streamSubscriptions.set(3, 'sub-timing');
  client.subscriptionCallbacks.set('sub-timing', {
    onpacket(event) {
      events.push(event);
    },
  });

  try {
    console.warn = (...args) => warnings.push(args.join(' '));
    client._handleStreamMessage(makeStreamMetadataFrame(3, payload, 12.75));
    client._handleStreamMessage(makeStreamMetadataFrame(3, payload, 12.75));
  } finally {
    console.warn = previousWarn;
  }

  assert.equal(events.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unsupported metadata version 1/);
  assert.equal(client._debugStats.wtStreamMetadataDrops, 2);
});

test('malformed stream-index metadata frames increment the hard-drop counter', () => {
  const client = new BridgeClient();
  const payload = new Uint8Array([0xca, 0xfe]);
  const events = [];
  const warnings = [];
  const previousWarn = console.warn;

  for (const streamIndex of [5, 6, 7]) {
    client._streamSubscriptions.set(streamIndex, 'sub-malformed-metadata');
  }
  client.subscriptionCallbacks.set('sub-malformed-metadata', {
    onpacket(event) {
      events.push(event);
    },
  });

  const tooShort = makeStreamIndexFrame(5 | 0x8000, new Uint8Array());
  const invalidSourceLength = makeStreamMetadataFrame(
    6,
    payload,
    12.75,
    'kernel-software',
    1_700_000_000_000,
  );
  invalidSourceLength[12] = 0xff;
  const truncatedOrigin = makeStreamMetadataFrame(7, payload, 12.75);
  truncatedOrigin[2] = 2;
  truncatedOrigin[3] = 1;

  try {
    console.warn = (...args) => warnings.push(args.join(' '));
    client._handleStreamMessage(tooShort);
    client._handleStreamMessage(invalidSourceLength);
    client._handleStreamMessage(truncatedOrigin);
  } finally {
    console.warn = previousWarn;
  }

  assert.equal(events.length, 0);
  assert.equal(warnings.length, 3);
  assert.equal(client._debugStats.wtStreamMetadataDrops, 3);
});

test('v2 frames without receiveTimeOrigin deliver media and warn once per stream', () => {
  const client = new BridgeClient();
  const payload = new Uint8Array([0xca, 0xfe]);
  const frame = makeStreamMetadataFrame(4, payload, 18.25);
  frame[2] = 2;
  const events = [];
  const warnings = [];
  const previousWarn = console.warn;

  client._streamSubscriptions.set(4, 'sub-timing-v2-missing-origin');
  client.subscriptionCallbacks.set('sub-timing-v2-missing-origin', {
    onpacket(event) {
      events.push(event);
    },
  });

  try {
    console.warn = (...args) => warnings.push(args.join(' '));
    client._handleStreamMessage(frame);
    client._handleStreamMessage(frame);
  } finally {
    console.warn = previousWarn;
  }

  assert.equal(events.length, 2);
  assert.deepEqual(Array.from(new Uint8Array(events[0].data)), Array.from(payload));
  assert.equal(events[0].receiveTime, undefined);
  assert.equal(events[0].receiveTimeOrigin, undefined);
  assert.equal(events[0].receiveTimestampSource, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /delivering payload without timing metadata/);
});

test('stream-index metadata frames preserve receive time and origin on packet callbacks', () => {
  const client = new BridgeClient();
  const payload = new Uint8Array([0xca, 0xfe]);
  const events = [];

  client._streamSubscriptions.set(4, 'sub-timing-v2');
  client.subscriptionCallbacks.set('sub-timing-v2', {
    onpacket(event) {
      events.push(event);
    },
  });

  client._handleStreamMessage(makeStreamMetadataFrame(
    4,
    payload,
    18.25,
    'kernel-software',
    1_700_000_000_000,
  ));

  assert.equal(events.length, 1);
  assert.deepEqual(Array.from(new Uint8Array(events[0].data)), Array.from(payload));
  assert.equal(events[0].receiveTime, 18.25);
  assert.equal(events[0].receiveTimeOrigin, 1_700_000_000_000);
  assert.equal(events[0].receiveTimestampSource, 'kernel-software');
});

test('FEC diagnostics are sent only for connected active subscriptions', () => {
  const client = new BridgeClient();
  const sent = [];
  client._sendControl = (message) => sent.push(message);
  const snapshot = {
    version: 1,
    packetId: 3,
    observedAt: 1234,
    stats: { sourceSymbols: 10, repairSymbols: 2, blocks: [] },
  };

  assert.equal(client.reportFecDiagnostics(snapshot), false);
  client.connected = true;
  assert.equal(client.reportFecDiagnostics(snapshot), false);

  client.activeSubscriptions.add('232.1.1.62:8000@192.168.1.117');
  assert.equal(client.reportFecDiagnostics(snapshot), true);
  assert.deepEqual(sent, [{
    type: 'subscription_diagnostics',
    subscription_ids: ['232.1.1.62:8000@192.168.1.117'],
    fec_track: snapshot,
  }]);

  assert.equal(client.reportFecDiagnostics(null), false);
  assert.equal(sent.length, 1);
});

test('subscribe messages carry ATSC 1.0 tuner acquisition metadata', () => {
  const client = new BridgeClient();
  const previousLocation = globalThis.location;
  globalThis.location = { href: 'https://example.test/atsc3-tuner/' };

  try {
    assert.deepEqual(
      client._buildSubscribeMessage({
        transportOpts: {
          origin: 'tuner',
          standard: 'atsc1',
          protocol: 'mpeg-ts',
          reliableBacklog: 'ordered',
        },
      }, 'req-atsc1'),
      {
        type: 'subscribe',
        request_id: 'req-atsc1',
        client_type: 'bridge',
        page_url: 'https://example.test/atsc3-tuner/',
        origin: 'tuner',
        standard: 'atsc1',
        protocol: 'mpeg-ts',
        reliable_backlog: 'ordered',
      },
    );
  } finally {
    globalThis.location = previousLocation;
  }
});

test('tuner facade exposes distinct ATSC 3 default and addressless ATSC 1 selectors', async () => {
  const calls = [];
  const bridgeClient = {
    async subscribe(...args) {
      calls.push(args);
      return {
        subscriptionId: `sub-${calls.length}`,
        setCallbacks() {},
      };
    },
    tunerStatus() {},
    tunerTune() {},
    tunerSetPlp() {},
  };
  const tuner = createTunerAPI(bridgeClient);

  assert.deepEqual(tuner.endpoint, {
    group: '224.0.23.60',
    port: 4937,
    consume: 'bytes',
  });
  assert.deepEqual(tuner.atsc3Endpoint, tuner.endpoint);
  assert.deepEqual(tuner.llsEndpoint, tuner.endpoint);
  assert.deepEqual(tuner.atsc1Endpoint, {
    origin: 'tuner',
    standard: 'atsc1',
    protocol: 'mpeg-ts',
    consume: 'bytes',
  });
  assert.deepEqual(tuner.endpointForStandard('atsc1'), tuner.atsc1Endpoint);
  assert.deepEqual(tuner.endpointForStandard('atsc3'), tuner.atsc3Endpoint);

  await tuner.subscribeBytes({ standard: 'atsc1' });
  assert.deepEqual(calls[0], [
    undefined,
    undefined,
    undefined,
    { origin: 'tuner', standard: 'atsc1', protocol: 'mpeg-ts' },
  ]);

  await tuner.subscribeBytes();
  assert.deepEqual(calls[1], [
    '224.0.23.60',
    4937,
    undefined,
    { origin: 'tuner', standard: 'atsc3' },
  ]);
});

test('shared byte subscription follows the replayed server ID through final unsubscribe', async () => {
  const client = new BridgeClient();
  const assignedIds = ['sub-before-reconnect', 'sub-after-reconnect'];
  const unsubscribeCalls = [];
  client.connected = true;
  client._sendSubscribeRequest = async () => assignedIds.shift();

  const sub = await subscribeMulticastBridgeBytes(client, {
    group: '239.1.2.3',
    port: 5000,
    consume: 'bytes',
  });
  assert.equal(sub.id, 'sub-before-reconnect');

  await client._replayActiveSubscriptions();
  assert.equal(sub.id, 'sub-after-reconnect');
  assert.equal(client._desiredSubscriptions.has('sub-before-reconnect'), false);
  assert.equal(client._desiredSubscriptions.has('sub-after-reconnect'), true);

  client._sendUnsubscribeRequest = async (subscriptionId) => {
    unsubscribeCalls.push(subscriptionId);
  };
  await sub.unsubscribe();
  assert.deepEqual(unsubscribeCalls, ['sub-after-reconnect']);
});

// ── BLO-8405: chunk-list reassembly behavioral equivalence ──

// Directly exercise _appendDataStreamBytes with a registered stream + token,
// capturing every dispatched frame's reassembled bytes.
function makeAppendHarness() {
  const client = new BridgeClient();
  client.connected = true;
  const streamIndex = 3;
  const token = {};
  client._dataStreamBuffers.set(streamIndex, new Uint8Array(0));
  client._dataStreamTokens.set(streamIndex, token);
  const frames = [];
  client._handleTransportFrame = (bytes) => {
    // Snapshot immediately: subarray views must be valid at dispatch time.
    frames.push(Array.from(bytes));
  };
  return { client, streamIndex, token, frames };
}

function u8(...bytes) {
  return new Uint8Array(bytes);
}

test('single frame delivered across many small chunks yields one frame with correct bytes', async () => {
  const { client, streamIndex, token, frames } = makeAppendHarness();
  const payload = Array.from({ length: 37 }, (_, i) => (i * 7 + 1) & 0xff);
  const frame = makeLengthPrefixedFrame(new Uint8Array(payload));

  // Feed one byte at a time — the worst case for the old O(n^2) realloc path.
  for (let i = 0; i < frame.byteLength; i++) {
    const ret = await client._appendDataStreamBytes(streamIndex, frame.subarray(i, i + 1), token);
    assert.equal(ret, true);
  }

  assert.deepEqual(frames, [payload]);
  assert.equal(client._debugStats.wtDataStreamFrames, 1);
  assert.equal(client._debugStats.wtDataStreamFrameBytes, payload.length);
  assert.equal(client._debugStats.wtDataStreamChunks, frame.byteLength);
  assert.equal(client._debugStats.wtDataStreamBytes, frame.byteLength);
  assert.equal(client.getStats().dataStreamBufferBytes, 0);
});

test('multiple frames packed in one chunk all dispatch in order', async () => {
  const { client, streamIndex, token, frames } = makeAppendHarness();
  const a = [0x10, 0x11];
  const b = [0x20, 0x21, 0x22, 0x23];
  const c = [0x30];
  const combined = new Uint8Array([
    ...makeLengthPrefixedFrame(u8(...a)),
    ...makeLengthPrefixedFrame(u8(...b)),
    ...makeLengthPrefixedFrame(u8(...c)),
  ]);

  const ret = await client._appendDataStreamBytes(streamIndex, combined, token);
  assert.equal(ret, true);
  assert.deepEqual(frames, [a, b, c]);
  assert.equal(client._debugStats.wtDataStreamFrames, 3);
  assert.equal(client.getStats().dataStreamBufferBytes, 0);
});

test('BCDS delivery credit is cumulative and emitted at the eight-frame send boundary', async () => {
  const { client, streamIndex, token } = makeAppendHarness();
  const progress = [];
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  const sevenFrames = new Uint8Array(
    Array.from({ length: 7 }, (_, value) =>
      Array.from(makeLengthPrefixedFrame(u8(value + 1)))
    ).flat(),
  );
  await client._appendDataStreamBytes(streamIndex, sevenFrames, token);
  assert.deepEqual(progress, []);

  await client._appendDataStreamBytes(
    streamIndex,
    makeLengthPrefixedFrame(u8(8)),
    token,
  );
  assert.deepEqual(progress, [{ type: 'media_progress', delivered_frames: 8 }]);
  assert.equal(client.getStats().wtMediaFramesDelivered, 8);
});

test('partial BCDS delivery credit flushes after a bounded delay and is cancelled by epoch reset', async () => {
  const { client, streamIndex, token } = makeAppendHarness();
  const progress = [];
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  await client._appendDataStreamBytes(
    streamIndex,
    makeLengthPrefixedFrame(u8(0x11)),
    token,
  );
  assert.deepEqual(progress, []);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(progress, [{ type: 'media_progress', delivered_frames: 1 }]);

  await client._appendDataStreamBytes(
    streamIndex,
    makeLengthPrefixedFrame(u8(0x22)),
    token,
  );
  client._resetMediaProgress();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(progress.length, 1, 'a stale connection epoch must not report on the next connection');
});

test('bidi control writes serialize and coalesce queued cumulative media progress', async () => {
  const client = new BridgeClient();
  const writes = [];
  const resolvers = [];
  client.connected = true;
  client._transport = 'webtransport';
  client._bidiWriter = {
    write(frame) {
      writes.push(new Uint8Array(frame));
      return new Promise((resolve) => resolvers.push(resolve));
    },
  };

  assert.equal(client._sendControl({ type: 'media_progress', delivered_frames: 8 }), true);
  assert.equal(client._sendControl({ type: 'media_progress', delivered_frames: 16 }), true);
  assert.equal(client._sendControl({ type: 'media_progress', delivered_frames: 24 }), true);
  assert.equal(writes.length, 1, 'only one writer.write may be in flight');
  assert.deepEqual(decodeControlFrame(writes[0]), {
    type: 'media_progress',
    delivered_frames: 8,
  });
  assert.equal(client.getStats().wtControlMessagesCoalesced, 1);

  resolvers.shift()();
  await yieldToReaders();
  assert.equal(writes.length, 2);
  assert.deepEqual(decodeControlFrame(writes[1]), {
    type: 'media_progress',
    delivered_frames: 24,
  });
  assert.equal(client.getStats().wtControlMessagesSent, 2);
  assert.equal(client.getStats().wtControlQueueDepthMax, 1);

  resolvers.shift()();
  await yieldToReaders();
});

test('BLO-35598: subscription control overtakes queued telemetry and telemetry stays bounded', async () => {
  const client = new BridgeClient();
  const writes = [];
  const resolvers = [];
  client.connected = true;
  client._transport = 'webtransport';
  client._bidiWriter = {
    write(frame) {
      writes.push(decodeControlFrame(new Uint8Array(frame)));
      return new Promise((resolve) => resolvers.push(resolve));
    },
  };
  const subscriptionId = '232.1.1.60:8000@69.25.95.192';
  client.activeSubscriptions.add(subscriptionId);

  // One write in flight and the writer stalls (the native side stopped
  // reading). Telemetry keeps arriving at its own cadence meanwhile.
  client._sendControl({ type: 'media_progress', delivered_frames: 1 });
  assert.equal(writes.length, 1);
  for (let i = 0; i < 1000; i++) {
    client._sendControl({ type: 'media_progress', delivered_frames: 2 + i });
    client._sendControl({ type: 'keepalive', subscriptions: [subscriptionId], timestamp: i });
    client.reportFecDiagnostics({ version: 1, packetId: 0, observedAt: i, stats: { blocks: [] } });
    client.reportFecDiagnostics({ version: 1, packetId: 1, observedAt: i, stats: { blocks: [] } });
  }
  // Bounded: one entry per telemetry key, not one per report.
  assert.equal(client._controlWriteQueue.length, 4);

  // A player is removed and another subscribes while the backlog exists.
  client._sendControl({ type: 'unsubscribe', request_id: 'u1', subscription_id: subscriptionId });
  client._sendControl({ type: 'subscribe', request_id: 's1', group: '232.1.1.60', port: 8000 });
  assert.equal(client._controlWriteQueue.length, 6);
  assert.ok(client.getStats().wtControlQueueDepthMax <= 6);

  const drain = async () => {
    while (resolvers.length > 0) {
      resolvers.shift()();
      await yieldToReaders();
    }
  };
  await drain();
  assert.deepEqual(
    writes.slice(1, 3).map((message) => message.type),
    ['unsubscribe', 'subscribe'],
    'requests must be written before any queued telemetry, in their own order',
  );
  const telemetry = writes.slice(3);
  assert.equal(telemetry.length, 4);
  // Latest-wins: only the newest snapshot of each kind reaches the wire.
  assert.deepEqual(
    telemetry.find((message) => message.type === 'media_progress'),
    { type: 'media_progress', delivered_frames: 1001 },
  );
  assert.equal(telemetry.find((message) => message.type === 'keepalive').timestamp, 999);
  const diagnostics = telemetry.filter((message) => message.type === 'subscription_diagnostics');
  assert.deepEqual(diagnostics.map((message) => message.fec_track.packetId).sort(), [0, 1]);
  assert.ok(diagnostics.every((message) => message.fec_track.observedAt === 999));

  // Once drained, a new telemetry frame queues again rather than being
  // folded into an entry that was already written.
  client._sendControl({ type: 'keepalive', subscriptions: [], timestamp: 5000 });
  await drain();
  assert.equal(writes.at(-1).timestamp, 5000);
});

test('BLO-35598: a subscribe on a dead control channel fails immediately, not by timeout', async (t) => {
  mockGlobal(t, 'location', { href: 'https://blockcast.network/live' });
  const client = new BridgeClient();
  client.connected = true;
  client._transport = 'webtransport';
  client._bidiWriter = null;
  const started = Date.now();
  await assert.rejects(
    client._sendSubscribeRequest(
      { group: '232.1.1.60', port: 8000, source: '69.25.95.192', transportOpts: {} },
      { transport: null },
    ),
    /Bridge control channel unavailable/,
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(client.pendingRequests.size, 0);
});

test('frame whose 4-byte length prefix straddles a chunk boundary parses correctly', async () => {
  const { client, streamIndex, token, frames } = makeAppendHarness();
  const payload = [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02];
  const frame = makeLengthPrefixedFrame(u8(...payload));

  // Split so the u32LE length prefix spans two chunks (2 bytes + rest),
  // then further split the body across another boundary.
  assert.equal(await client._appendDataStreamBytes(streamIndex, frame.subarray(0, 2), token), true);
  assert.equal(client.getStats().dataStreamBufferBytes, 2);
  assert.equal(await client._appendDataStreamBytes(streamIndex, frame.subarray(2, 5), token), true);
  assert.equal(await client._appendDataStreamBytes(streamIndex, frame.subarray(5), token), true);

  assert.deepEqual(frames, [payload]);
  assert.equal(client._debugStats.wtDataStreamFrames, 1);
  assert.equal(client.getStats().dataStreamBufferBytes, 0);
});

test('oversized frameLen triggers protocol-error reset and false return', async () => {
  const { client, streamIndex, token, frames } = makeAppendHarness();
  // 16 MiB is the max; 16 MiB + 1 is oversized.
  const oversized = new Uint8Array(4);
  new DataView(oversized.buffer).setUint32(0, 16 * 1024 * 1024 + 1, true);

  const ret = await client._appendDataStreamBytes(streamIndex, oversized, token);
  assert.equal(ret, false);
  assert.deepEqual(frames, []);
  assert.equal(client._debugStats.wtDataStreamOversizedFrames, 1);
  assert.equal(client._debugStats.wtDataStreamBufferResets, 1);
  assert.equal(client._debugStats.wtDataStreamProtocolErrors, 1);
  // Buffer reset to empty.
  assert.equal(client.getStats().dataStreamBufferBytes, 0);
});

test('incomplete trailing frame is retained across calls and completes on next chunk', async () => {
  const { client, streamIndex, token, frames } = makeAppendHarness();
  const payload = [0xaa, 0xbb, 0xcc, 0xdd];
  const frame = makeLengthPrefixedFrame(u8(...payload));

  // First: length prefix + partial body. Nothing dispatched, leftover retained.
  const head = frame.subarray(0, 6); // 4-byte len + 2 payload bytes
  assert.equal(await client._appendDataStreamBytes(streamIndex, head, token), true);
  assert.deepEqual(frames, []);
  assert.equal(client.getStats().dataStreamBufferBytes, 6);
  assert.equal(client._debugStats.wtDataStreamFrames, 0);

  // Second: remaining body completes the frame.
  assert.equal(await client._appendDataStreamBytes(streamIndex, frame.subarray(6), token), true);
  assert.deepEqual(frames, [payload]);
  assert.equal(client._debugStats.wtDataStreamFrames, 1);
  assert.equal(client.getStats().dataStreamBufferBytes, 0);
});

test('equivalence oracle: same byte stream in one chunk vs N random splits => identical frames', async () => {
  // Build a byte stream of several frames of varied lengths, including a
  // zero-length frame and one large enough to force multi-chunk straddles.
  const payloads = [
    [],
    [0x01],
    Array.from({ length: 5 }, (_, i) => i + 1),
    Array.from({ length: 200 }, (_, i) => (i * 13 + 5) & 0xff),
    [0xff, 0xfe, 0xfd],
    Array.from({ length: 1000 }, (_, i) => (i * 31 + 7) & 0xff),
  ];
  const stream = new Uint8Array(
    payloads.flatMap((p) => Array.from(makeLengthPrefixedFrame(new Uint8Array(p)))),
  );

  async function run(chunkSizes) {
    const { client, streamIndex, token, frames } = makeAppendHarness();
    let offset = 0;
    for (const size of chunkSizes) {
      const end = Math.min(offset + size, stream.byteLength);
      if (end > offset) {
        assert.equal(
          await client._appendDataStreamBytes(streamIndex, stream.subarray(offset, end), token),
          true,
        );
      }
      offset = end;
      if (offset >= stream.byteLength) break;
    }
    // Feed any remainder as one final chunk.
    if (offset < stream.byteLength) {
      await client._appendDataStreamBytes(streamIndex, stream.subarray(offset), token);
    }
    assert.equal(client.getStats().dataStreamBufferBytes, 0);
    return frames;
  }

  const single = await run([stream.byteLength]);
  assert.deepEqual(single, payloads);

  // A handful of deterministic-but-irregular split patterns.
  const splitPlans = [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [3, 7, 2, 100, 1, 500],
    [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
    [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
    [13, 29, 7, 3, 61, 2, 11, 200, 400],
  ];
  for (const plan of splitPlans) {
    const split = await run(plan);
    assert.deepEqual(split, single, `split plan ${JSON.stringify(plan)} must match single-chunk dispatch`);
  }
});

// ── BLO-8405: batch-yield resume path (chunk-list state survives the await) ──

// Mirror of the module-private DISPATCH_BATCH_FRAMES in
// src/multicast-bridge.js — the frame count between dispatch-loop yields.
const DISPATCH_BATCH_FRAMES = 64;

// Build a length-prefixed byte stream of `count` frames, each with a distinct
// varied-length payload that encodes its index (order + byte oracle).
function makeIndexedFrameStream(count) {
  const payloads = Array.from({ length: count }, (_, i) => {
    const len = 1 + (i % 5); // 1..5 bytes; non-zero (zero-len covered elsewhere)
    return Array.from({ length: len }, (_, j) => (i * 7 + j) & 0xff);
  });
  const stream = new Uint8Array(
    payloads.flatMap((p) => Array.from(makeLengthPrefixedFrame(new Uint8Array(p)))),
  );
  return { payloads, stream };
}

test('batch-yield: >64 frames in one append cross the dispatch yield boundary and stay in order', async () => {
  const { client, streamIndex, token, frames } = makeAppendHarness();

  // 200 complete frames in ONE chunk. The drain loop yields after frame 64,
  // 128, and 192 (frames still pending each time), crossing the
  // DISPATCH_BATCH_FRAMES=64 boundary three times inside a
  // single loop invocation. If the chunk-list head offset did NOT survive the
  // await, a frame would be dropped, duplicated, or reordered at the boundary.
  const N = 200;
  const { payloads, stream } = makeIndexedFrameStream(N);

  const ret = await client._appendDataStreamBytes(streamIndex, stream, token);
  assert.equal(ret, true);

  // Every frame dispatched exactly once, in order, with correct bytes — across
  // all three yield boundaries.
  assert.deepEqual(frames, payloads);
  assert.equal(frames.length, N);
  assert.equal(client._debugStats.wtDataStreamFrames, N);
  assert.equal(client._debugStats.wtDataStreamYields, 3);
  assert.equal(client._debugStats.wtDataStreamAbortedDrains, 0);
  assert.equal(client.getStats().dataStreamBufferBytes, 0);
});

test('batch-yield: dispatch budget continues across small WebTransport chunks', async () => {
  const { client, streamIndex, token, frames } = makeAppendHarness();

  for (let index = 0; index < DISPATCH_BATCH_FRAMES; index += 1) {
    assert.equal(
      await client._appendDataStreamBytes(
        streamIndex,
        makeLengthPrefixedFrame(u8(index)),
        token,
      ),
      true,
    );
  }

  assert.equal(frames.length, DISPATCH_BATCH_FRAMES);
  assert.equal(client._debugStats.wtDataStreamYields, 1);
  assert.equal(client.getStats().dataStreamBufferBytes, 0);
});

// ── BLO-8405: drain-abort lifecycle (coherent accumulator after mid-drain abort) ──

test('batch-yield abort mid-drain leaves a coherent accumulator; the remainder resumes without replay', async () => {
  const { client, streamIndex, token, frames } = makeAppendHarness();

  // 100 complete frames in one chunk: the drain reaches the first yield after
  // frame 64, then aborts.
  const N = 100;
  const { payloads, stream } = makeIndexedFrameStream(N);

  // Simulate a competing re-registration of the same stream index landing while
  // the drain loop is mid-flight: the moment the 64th frame dispatches, swap in
  // a fresh token and reset the buffer exactly as _consumeUniStream does on a
  // new BCDS header. The post-yield recheck must then see the token mismatch
  // and abort.
  const newToken = {};
  let flipped = false;
  client._handleTransportFrame = (bytes) => {
    frames.push(Array.from(bytes));
    if (!flipped && frames.length === DISPATCH_BATCH_FRAMES) {
      flipped = true;
      client._dataStreamBuffers.set(streamIndex, new Uint8Array(0));
      client._dataStreamTokens.set(streamIndex, newToken);
    }
  };

  const ret = await client._appendDataStreamBytes(streamIndex, stream, token);

  // The method reports the abort.
  assert.equal(ret, false);
  assert.equal(flipped, true);
  assert.equal(client._debugStats.wtDataStreamYields, 1);
  assert.equal(client._debugStats.wtDataStreamAbortedDrains, 1);

  // Exactly the frames up to the yield boundary dispatched — no partial or
  // duplicate frame straddling the abort point.
  assert.equal(frames.length, DISPATCH_BATCH_FRAMES);
  assert.deepEqual(frames, payloads.slice(0, DISPATCH_BATCH_FRAMES));

  // Coherence: the aborted call never persisted its local (head-advanced)
  // accumulator, so nothing is pinned. The map holds only the fresh empty
  // buffer written by the simulated re-registration.
  const buffered = client._dataStreamBuffers.get(streamIndex);
  assert.equal(buffered.byteLength, 0);
  assert.equal(buffered.chunks, undefined, 'no head-advanced chunk-list pinned after abort');
  assert.equal(client.getStats().dataStreamBufferBytes, 0);

  // Feed the not-yet-dispatched remainder as the next chunk under the fresh
  // token. It must parse ONLY frames 64..99 — the already-dispatched frames
  // 0..63 must not replay, and the partial state from the aborted drain must
  // not contaminate the resume.
  const dispatchedBytes = stream.subarray(
    0,
    payloads
      .slice(0, DISPATCH_BATCH_FRAMES)
      .reduce((sum, p) => sum + 4 + p.length, 0),
  ).byteLength;
  const remainder = stream.subarray(dispatchedBytes);

  const resumed = [];
  client._handleTransportFrame = (bytes) => resumed.push(Array.from(bytes));

  const ret2 = await client._appendDataStreamBytes(streamIndex, remainder, newToken);
  assert.equal(ret2, true);
  assert.deepEqual(resumed, payloads.slice(DISPATCH_BATCH_FRAMES));
  assert.equal(resumed[0][0] & 0xff, payloads[DISPATCH_BATCH_FRAMES][0] & 0xff);
  assert.equal(
    frames.length + resumed.length,
    N,
    'every frame dispatched exactly once across the abort — no drop, no duplicate',
  );
  assert.equal(client.getStats().dataStreamBufferBytes, 0);
});

// ── Datagram delivery accounting ─────────────────────────────────────────────
// These exist so post-accept datagram non-delivery is measurable end to end.
// The service worker counts what Quinn accepted; the client counts what
// actually arrived.

test('datagram-only media still reports progress carrying a dg block', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const progress = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  const reading = client._readIncomingDatagrams();
  for (let i = 0; i < 8; i++) source.enqueue(new Uint8Array([i]));
  source.close();
  await reading;

  // Two regressions guarded here.
  // 1. The flush used to gate on the stream counter alone, so a datagram-only
  //    session — exactly the one worth measuring — reported nothing.
  // 2. `dg` used to be withheld until a datagram arrived, which made a client
  //    losing everything indistinguishable from a client with no telemetry.
  //    Capability is announced up front with rx: 0.
  assert.deepEqual(progress, [
    { type: 'media_progress', delivered_frames: 0, dg: datagramProgress(0) },
    { type: 'media_progress', delivered_frames: 0, dg: datagramProgress(8) },
  ]);
  assert.equal(client._datagramFramesReceived, 8);
  // The ENQUEUED counter is what a stubbed `_sendControl` can establish.
  // `_datagramFramesReported` only advances when a write RESOLVES, which needs
  // a real writer — see 'a rejected progress frame does not report its own
  // progress'.
  assert.equal(client._datagramFramesEnqueued, 8);
});

test('datagram reader close flushes short batch before capability teardown', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const progress = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  const reading = client._readIncomingDatagrams();
  source.enqueue(new Uint8Array([0x01]));
  source.close();
  await reading;
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(progress, [
    { type: 'media_progress', delivered_frames: 0, dg: datagramProgress(0) },
    { type: 'media_progress', delivered_frames: 0, dg: datagramProgress(1) },
  ]);
  assert.equal(client._datagramFramesReceived, 1);
  assert.equal(client._datagramFramesEnqueued, 1);
  assert.equal(client._datagramCapable, false);
  assert.equal(client._mediaProgressTimer, null);
});

test('datagram capability is announced once without an unnegotiated heartbeat', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const progress = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  const reading = client._readIncomingDatagrams();
  assert.equal(client._datagramCapable, true);
  // Total non-delivery must be reportable as 100% loss rather than silence, so the
  // bridge has to learn this client reports datagrams before one ever lands.
  assert.deepEqual(progress, [
    { type: 'media_progress', delivered_frames: 0, dg: datagramProgress(0) },
  ]);
  assert.equal(client._datagramAccountingActive, false);
  assert.equal(client._datagramHeartbeatTimer, null);

  source.close();
  await reading;

  // Capability is torn down without ever starting an unnegotiated heartbeat.
  assert.equal(client._datagramCapable, false);
  assert.equal(client._datagramHeartbeatTimer, null);
});

test('a dropped capability announcement is re-announced until accounting activates', async (t) => {
  // Mirrors WT_DATAGRAM_CAPABILITY_RETRY_MS in the bridge source.
  const RETRY_MS = 500;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const progress = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};
  // _sendControl only reports that the frame was ENQUEUED. This test stands in
  // for the case where _drainControlWrites then clears the queue on a write
  // rejection, so the announcement never reaches the server.
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  const reading = client._readIncomingDatagrams();
  assert.equal(progress.length, 1, 'the one-shot announcement is sent');
  assert.notEqual(
    client._datagramCapabilityTimer, null,
    'a dropped announcement must remain retryable',
  );

  // No datagram ever arrives and no stream progress occurs. Without the retry
  // the client is now stuck forever: no announcement means no server
  // watermark, and no watermark means the heartbeat never starts.
  t.mock.timers.tick(RETRY_MS);
  assert.equal(progress.length, 2, 're-announced after the retry interval');
  t.mock.timers.tick(RETRY_MS);
  assert.equal(progress.length, 3, 'still re-announcing while unacknowledged');

  // The server finally sees one and responds with a watermark.
  client._noteDatagramSendWatermark(10);
  assert.equal(client._datagramAccountingActive, true);
  assert.equal(
    client._datagramCapabilityTimer, null,
    'acknowledgement stops the re-announcement',
  );

  const settled = progress.length;
  t.mock.timers.tick(RETRY_MS);
  assert.equal(progress.length, settled, 'no further capability retries');

  source.close();
  await reading;
  client._resetMediaProgress();
  assert.equal(client._datagramCapabilityTimer, null);
});

test('a capability announcement is re-sent onto a live transport with dg.v intact', async (t) => {
  // Mirrors WT_DATAGRAM_CAPABILITY_RETRY_MS in the bridge source.
  const RETRY_MS = 500;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = new BridgeClient();
  const onWire = [];
  // A REAL WritableStream, not a hand-rolled writer. See the sibling test
  // below for why a stub that recovers from a rejection cannot be trusted.
  const stream = new WritableStream({
    write(chunk) { onWire.push(new Uint8Array(chunk)); },
  });
  const writer = stream.getWriter();
  writer.closed.catch(() => {});
  client.connected = true;
  client._transport = 'webtransport';
  client._bidiWriter = writer;
  const source = makeControlledReadableStream();
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};

  const reading = client._readIncomingDatagrams();
  await yieldToReaders();

  // Unlike the sibling test above, this drives the real encoder and
  // _drainControlWrites instead of stubbing _sendControl. A test that stubs
  // _sendControl cannot observe the encoder, which is how an earlier
  // encoder-level strip of this same announcement went unseen.
  assert.equal(onWire.length, 1, 'the announcement reached the transport once');

  // No datagram arrives and no stream progress occurs, so the retry timer is the
  // only thing that can re-announce from here.
  t.mock.timers.tick(RETRY_MS);
  await yieldToReaders();

  assert.equal(onWire.length, 2, 're-announced while the transport is healthy');
  const resent = decodeControlFrame(onWire[1]);
  assert.equal(resent.type, 'media_progress');
  // dg.v is what the service worker keys sequencing off. A retry that reached
  // the wire but dropped the version would deadlock negotiation just as quietly
  // as no retry at all, so assert on the decoded frame rather than the call.
  assert.equal(resent.dg.v, 1, 'the retried frame still announces capability');
  assert.equal(client.getStats().wtControlFramesWritten, 2, 'both are confirmed on the wire');
  assert.equal(
    client._datagramCapabilityAnnouncementsWritten, 2,
    'and both are counted as announcements the server had a chance to hear',
  );

  source.close();
  await reading;
});

test('a rejected control write drops the writer instead of retrying into a dead stream', async (t) => {
  const RETRY_MS = 500;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = new BridgeClient();
  let sinkCalls = 0;
  // A real WritableStream is load-bearing here. A WritableStreamDefaultWriter
  // LATCHES ERRORED on the first rejection: every later write() rejects from the
  // stored error without ever calling the sink (verified — 1 sink invocation for
  // 4 attempts). A stub that rejects once and then resolves models a transport
  // that cannot exist, and any retry it "proves" is a production no-op.
  const stream = new WritableStream({
    write() {
      sinkCalls++;
      return Promise.reject(new Error('bidi write rejected'));
    },
  });
  const writer = stream.getWriter();
  writer.closed.catch(() => {});
  client.connected = true;
  client._transport = 'webtransport';
  client._bidiWriter = writer;
  const source = makeControlledReadableStream();
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};

  const reading = client._readIncomingDatagrams();
  await yieldToReaders();

  assert.equal(sinkCalls, 1, 'the announcement reached the transport once');
  assert.equal(client.getStats().wtControlWriteErrors, 1, 'and that write was rejected');
  assert.equal(client._bidiWriter, null, 'the dead writer is dropped');
  assert.equal(client.getStats().wtControlWriteDead, 1);
  assert.equal(client.getStats().wtControlFramesWritten, 0, 'nothing was confirmed on the wire');
  assert.equal(
    client._datagramCapabilityAnnouncementsWritten, 0,
    'so no announcement can be assumed heard — this is what distinguishes a ' +
    'dead control stream from a server that heard us and stayed silent',
  );

  t.mock.timers.tick(RETRY_MS);
  await yieldToReaders();

  assert.equal(sinkCalls, 1, 'no re-announcement reaches the transport');

  // The reason dropping the writer matters more than losing the frame: while it
  // stayed installed, _sendControl kept returning true, so _flushMediaProgress
  // advanced the counters that drive the STREAM credit baseline for frames the
  // server never received. Datagram telemetry was not the only casualty.
  client._mediaFramesDelivered = 7;
  client._flushMediaProgress();
  assert.equal(
    client._mediaFramesReported, 0,
    'reported counters must not advance for frames that cannot be sent',
  );

  source.close();
  await reading;
});

test('a stalled control write retires the transport and schedules reconnect', async (t) => {
  const WRITE_TIMEOUT_MS = 5000;
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const client = new BridgeClient();
  let sinkCalls = 0;
  let reconnects = 0;
  // A sink under backpressure that never settles must not leave the control
  // plane and reconnect machinery waiting forever.
  const stream = new WritableStream({
    write() { sinkCalls++; return new Promise(() => {}); },
  });
  const writer = stream.getWriter();
  writer.closed.catch(() => {});
  // Chrome runs a WebTransport send stream's sink abort a second time once a pending write
  // rejects; if close() has reset the transport by then, that second abort crashes the
  // renderer (BLO-45882). So a timed-out write must be retired by close() alone.
  const order = [];
  const abort = writer.abort.bind(writer);
  writer.abort = (reason) => { order.push('abort'); return abort(reason); };
  client.connected = true;
  client._transport = 'webtransport';
  client._bidiWriter = writer;
  client._lastConnectArgs = { host: '127.0.0.1', wsPort: 33446, options: {} };
  client._scheduleReconnect = () => { reconnects++; };
  const source = makeControlledReadableStream();
  client._wt = { datagrams: { readable: source.stream }, close() { order.push('close'); } };
  client._handleTransportFrame = () => {};

  const reading = client._readIncomingDatagrams();
  await Promise.resolve();
  await Promise.resolve();

  t.mock.timers.tick(WRITE_TIMEOUT_MS);
  for (let i = 0; i < 12; i++) await Promise.resolve();

  assert.equal(client._datagramCapabilityTimer, null, 'disconnect stops capability retries');
  assert.equal(client.getStats().wtControlWriteErrors, 1);
  assert.equal(client._bidiWriter, null, 'the stalled writer is retired');
  assert.equal(client.getStats().wtControlWriteDead, 1);
  assert.equal(client.connected, false, 'the dead control stream disconnects the session');
  assert.equal(reconnects, 1, 'the existing reconnect path is scheduled');
  assert.equal(client.getStats().wtControlFramesWritten, 0);
  assert.equal(sinkCalls, 1, 'the transport was only ever handed one frame');
  assert.deepEqual(order, ['close'], 'a timed-out control write is retired by closing the transport, never by aborting the writer');

  await reading;
});

test('a frozen cohort declares itself on the wire so the server stops scoring it', () => {
  const MAX_PENDING = 8192;
  const client = new BridgeClient();
  const progress = [];
  client.connected = true;
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  for (let sequence = 1; sequence <= MAX_PENDING + 1; sequence++) {
    client._noteDatagramFrameReceived(sequence);
  }
  assert.equal(client._datagramPendingOverflowed, true, 'the cap tripped');

  progress.length = 0;
  client._datagramCapable = true;
  client._flushMediaProgress();

  // tx/sx are pinned from here and cannot resume without a reconnect. Without
  // this flag the server keeps treating the pinned pair as a live measurement:
  // lostFrames 0 over a cohort that stopped counting, i.e. a confident zero on
  // a connection that is measuring nothing. The freeze itself stays terminal —
  // making it VISIBLE is the fix, not making it recoverable.
  assert.equal(progress.length, 1);
  assert.equal(progress[0].dg.fz, 1, 'the frozen cohort is flagged');
  assert.equal(progress[0].dg.tx, 0, 'and its watermark is still pinned');
  assert.equal(progress[0].dg.sx, 0);
});

test('a healthy cohort carries no freeze flag', () => {
  const client = new BridgeClient();
  const progress = [];
  client.connected = true;
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  // No _datagramCapable here: the authoritative watermark below activates
  // accounting, which is enough to make dg reportable, and setting capability
  // as well would start the 1s heartbeat interval and hang the runner.
  // Ordinary traffic with real loss: sequences 1 and 3 arrive, 2 does not.
  client._noteDatagramFrameReceived(1);
  client._noteDatagramFrameReceived(3);
  client._noteDatagramSendWatermark(3);
  client._settleDatagramSendWatermark(3);

  progress.length = 0;
  client._flushMediaProgress();

  assert.equal(progress.length, 1);
  // An inverted guard here would put fz on every frame, breaking both the
  // byte-identity claim and the server's ability to tell a stalled connection
  // from a working one.
  assert.equal(Object.hasOwn(progress[0].dg, 'fz'), false, 'no flag on the normal path');
  assert.equal(progress[0].dg.tx, 3);
  assert.equal(progress[0].dg.sx, 2, 'the genuinely missing sequence is still not credited');

  client._resetMediaProgress();
});

test('the freeze flag survives coalescing and the real encoder', async () => {
  const MAX_PENDING = 8192;
  const client = new BridgeClient();
  const onWire = [];
  const stream = new WritableStream({
    write(chunk) { onWire.push(new Uint8Array(chunk)); },
  });
  const writer = stream.getWriter();
  writer.closed.catch(() => {});
  client.connected = true;
  client._transport = 'webtransport';
  client._bidiWriter = writer;

  for (let sequence = 1; sequence <= MAX_PENDING + 1; sequence++) {
    client._noteDatagramFrameReceived(sequence);
  }
  assert.equal(client._datagramPendingOverflowed, true, 'the cap tripped');

  onWire.length = 0;
  client._datagramCapable = true;
  client._flushMediaProgress();
  await yieldToReaders();

  // `_sendControl` does NOT put this on the wire: it builds a coalescing entry
  // with named fields and `_drainControlWrites` RE-ENCODES the frame from that
  // entry. A field carried only on the message object is silently dropped
  // before the transport. Asserting on a stubbed `_sendControl` cannot see
  // that, which is exactly how `fz` shipped unreachable the first time.
  assert.ok(onWire.length >= 1, 'a frame reached the transport');
  const decoded = decodeControlFrame(onWire[onWire.length - 1]);
  assert.equal(decoded.type, 'media_progress');
  assert.equal(decoded.dg.fz, 1, 'the freeze flag survived the encoder');

  client._resetMediaProgress();
});

test('a rejected progress frame does not report its own progress', async () => {
  const client = new BridgeClient();
  let sinkCalls = 0;
  const stream = new WritableStream({
    write() {
      sinkCalls++;
      return Promise.reject(new Error('bidi write rejected'));
    },
  });
  const writer = stream.getWriter();
  writer.closed.catch(() => {});
  client.connected = true;
  client._transport = 'webtransport';
  client._bidiWriter = writer;

  // The rejected frame itself carries non-zero stream AND aligned datagram
  // progress. Dropping the writer protects every LATER frame, but this one was
  // already enqueued with `_sendControl` returning true — so if the counters
  // commit on enqueue, exactly one frame's worth of stream credit and datagram
  // settlement is claimed for a frame that never left the process, and no
  // retry can ever correct it.
  client._mediaFramesDelivered = 12;
  client._noteDatagramFrameReceived(1);
  client._noteDatagramSendWatermark(1);
  client._settleDatagramSendWatermark(1);
  client._flushMediaProgress();
  await yieldToReaders();

  assert.equal(sinkCalls, 1, 'the frame was handed to the transport');
  assert.equal(client.getStats().wtControlWriteErrors, 1, 'and rejected');
  assert.equal(
    client._mediaFramesReported, 0,
    'stream credit is not reported for a frame the server never received',
  );
  assert.equal(
    client._datagramFramesReported, 0,
    'nor is datagram settlement',
  );
  // Rewound to the last resolved report, so the two counters stay consistent
  // and a reconnect re-sends the unconfirmed span rather than skipping it.
  assert.equal(client._mediaFramesEnqueued, 0);
  assert.equal(client._datagramFramesEnqueued, 0);

  client._resetMediaProgress();
});

test('a late rejection from a superseded writer cannot kill its replacement', async () => {
  const client = new BridgeClient();
  client.connected = true;
  client._transport = 'webtransport';

  // Writer A stalls, then rejects only after a reconnect has installed B.
  let rejectA;
  const streamA = new WritableStream({
    write() { return new Promise((_, reject) => { rejectA = reject; }); },
  });
  const writerA = streamA.getWriter();
  writerA.closed.catch(() => {});
  client._bidiWriter = writerA;

  client._sendControl({ type: 'ping' });
  await yieldToReaders();
  assert.ok(rejectA, 'writer A has an in-flight write');

  // Reconnect: generation bumps and a fresh writer is installed.
  const onWireB = [];
  const streamB = new WritableStream({
    write(chunk) { onWireB.push(new Uint8Array(chunk)); },
  });
  const writerB = streamB.getWriter();
  writerB.closed.catch(() => {});
  client._resetControlWrites();
  client._bidiWriter = writerB;

  rejectA(new Error('writer A died'));
  await yieldToReaders();

  // The catch runs for a generation that no longer exists. Unguarded, it nulls
  // whatever writer is installed NOW — so a dying old stream would take out a
  // healthy new one and leave the session permanently control-mute.
  assert.equal(client._bidiWriter, writerB, 'the replacement writer survives');
  assert.equal(client.getStats().wtControlWriteDead, 0, 'B was not marked dead');
  assert.equal(client.getStats().wtControlWriteStaleRejections, 1);

  assert.equal(client._sendControl({ type: 'ping' }), true, 'B is still usable');
  await yieldToReaders();
  assert.equal(onWireB.length, 1, 'and its frames reach the transport');
});

test('a legacy payload that happens to start with BCDG is never eaten', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const payloads = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = (bytes) => payloads.push(Array.from(bytes));
  client._sendControl = () => true;

  // Deliberately NOT setting _datagramCapabilityAnnouncementsWritten: this
  // connection never announced, so the server cannot be sequencing it and the
  // payload space is entirely legacy.
  const reading = client._readIncomingDatagrams();

  // Byte-for-byte a well-formed envelope. Nothing about the bytes distinguishes
  // it from media that merely begins with those four values — the envelope is a
  // magic prefix over an opaque payload space, so it is not self-delimiting.
  const collides = makeDatagramDeliveryFrame(7, new Uint8Array([0xde, 0xad]));
  source.enqueue(collides);
  // A prefix match that would fail envelope validation anyway: right magic,
  // wrong version. This used to `return null` and drop the packet outright.
  const mismatched = new Uint8Array([0x42, 0x43, 0x44, 0x47, 0x63, 0, 0, 0, 1, 0, 0, 0, 0xbe]);
  source.enqueue(mismatched);
  source.close();
  await reading;

  assert.deepEqual(payloads, [Array.from(collides), Array.from(mismatched)],
    'both reach the media path with every byte intact');
  assert.equal(client._datagramSequencedFramesReceived, 0, 'and neither is sequenced');
});

test('a BCDG envelope is decoded once the announcement is confirmed', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const payloads = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = (bytes) => payloads.push(Array.from(bytes));
  client._sendControl = () => true;
  // The necessary precondition, and the reason gating on it cannot mis-handle a
  // real batch: the service worker only sequences a connection whose capability
  // it learned from this announcement, so the announcement always precedes the
  // first sequenced datagram.
  client._datagramCapabilityAnnouncementsWritten = 1;

  const reading = client._readIncomingDatagrams();
  source.enqueue(makeDatagramDeliveryFrame(7, new Uint8Array([0xde, 0xad])));
  // Right magic, wrong version: passed through rather than dropped, because a
  // silently discarded packet is indistinguishable from network loss.
  source.enqueue(new Uint8Array([0x42, 0x43, 0x44, 0x47, 0x63, 0, 0, 0, 1, 0, 0, 0, 0xbe]));
  source.close();
  await reading;

  assert.deepEqual(payloads[0], [0xde, 0xad], 'the header is stripped');
  assert.equal(client._datagramSequencedFramesReceived, 1);
  assert.equal(payloads[1].length, 13, 'the mismatched one is passed through whole');
  assert.equal(client.getStats().wtDatagramEnvelopeMismatches, 1);
});

test('a stalled watermark bounds pending sequences without fabricating loss', () => {
  // Mirrors WT_DATAGRAM_MAX_PENDING_SEQUENCES (2x the 4096 late-correction
  // horizon); neither constant is exported.
  const MAX_PENDING = 8192;
  const OVERFLOW = 500;
  const client = new BridgeClient();
  client.connected = true;

  // The reliable control stream is stalled: datagrams keep arriving and no
  // authoritative watermark ever lands to adjudicate them. Unbounded, this set
  // would grow for the lifetime of the connection.
  for (let sequence = 1; sequence <= MAX_PENDING + OVERFLOW; sequence++) {
    client._noteDatagramFrameReceived(sequence);
  }

  assert.equal(
    client._datagramPendingSequences.size, MAX_PENDING,
    'pending sequences are capped instead of growing with the stall',
  );
  assert.equal(client.getStats().wtDatagramPendingOverflow, OVERFLOW);
  // Every datagram still counts toward the legacy total — only the aligned
  // cohort is frozen.
  assert.equal(client._datagramFramesReceived, MAX_PENDING + OVERFLOW);

  // The stall now clears with a watermark covering everything. Settling it
  // would score the OVERFLOW untracked sequences as missing — fabricating loss
  // for datagrams that demonstrably arrived. The cohort must stay frozen.
  client._noteDatagramSendWatermark(MAX_PENDING + OVERFLOW);
  assert.equal(
    client._datagramSettlementTimer, null,
    'a frozen cohort must not arm settlement',
  );

  // Belt and braces: settling directly must also be refused.
  client._settleDatagramSendWatermark(MAX_PENDING + OVERFLOW);
  assert.equal(client._datagramSettledSendWatermark, 0);
  assert.equal(client._datagramSettledFramesReceived, 0);
  assert.equal(
    client._datagramFinalizedLossFrames, 0,
    'no loss may be attributed to frames that were received but untracked',
  );

  client._resetMediaProgress();
  assert.equal(client._datagramPendingOverflowed, false, 'reconnect clears the freeze');
  assert.equal(client._datagramPendingSequences.size, 0);
});

test('capability re-announcement is bounded when the server never acknowledges', async (t) => {
  // Mirrors WT_DATAGRAM_CAPABILITY_RETRY_MS / WT_DATAGRAM_CAPABILITY_MAX_RETRIES.
  const RETRY_MS = 500;
  const MAX_RETRIES = 5;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const progress = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  const reading = client._readIncomingDatagrams();
  assert.equal(progress.length, 1, 'the one-shot announcement is sent');

  // A server with datagram media disabled returns before recording anything and
  // never publishes a watermark, so nothing can ever acknowledge. That is the
  // PRODUCTION DEFAULT, so an unbounded retry would leave permanent control
  // traffic on a path whose whole invariant is to stay inert when disabled.
  // Tick well past the cap to prove it stops rather than merely slows.
  for (let i = 0; i < MAX_RETRIES + 4; i++) t.mock.timers.tick(RETRY_MS);

  assert.equal(
    progress.length, 1 + MAX_RETRIES,
    'at most MAX_RETRIES re-announcements follow the initial one',
  );
  assert.equal(client._datagramCapabilityTimer, null, 'the timer stops itself');
  assert.equal(client.getStats().wtDatagramCapabilityRetriesExhausted, 1);

  source.close();
  await reading;
});

test('authoritative server watermark activates the datagram heartbeat', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};
  client._sendControl = () => true;

  const reading = client._readIncomingDatagrams();
  assert.equal(client._datagramHeartbeatTimer, null);

  client._handleControlMessage(datagramSendProgress(1));
  assert.equal(client._datagramAccountingActive, true);
  assert.ok(client._datagramHeartbeatTimer);

  source.close();
  await reading;
  assert.equal(client._datagramHeartbeatTimer, null);
});

test('a client with no datagram reader never sends a dg block', async () => {
  const client = new BridgeClient();
  const progress = [];
  client.connected = true;
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  client._mediaFramesDelivered = 4;
  client._flushMediaProgress();

  // Legacy wire shape preserved for non-datagram sessions.
  assert.deepEqual(progress, [{ type: 'media_progress', delivered_frames: 4 }]);
  assert.equal(client._datagramCapable, false);
});

test('a WebTransport session keeps advertising capability after re-announcement stops', async (t) => {
  // Mirrors WT_DATAGRAM_CAPABILITY_RETRY_MS / WT_DATAGRAM_CAPABILITY_MAX_RETRIES.
  const RETRY_MS = 500;
  const MAX_RETRIES = 5;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const progress = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  const reading = client._readIncomingDatagrams();
  for (let i = 0; i < MAX_RETRIES + 4; i++) t.mock.timers.tick(RETRY_MS);
  assert.equal(client._datagramCapabilityTimer, null, 're-announcement has stopped');

  // The bounded retry stops the EXTRA timer-driven frames, not the capability
  // advertisement itself: the service worker sets `sequenceCapable` only from a
  // `dg` block, so a server that was idle at connect time and starts sending
  // later still has to be able to learn this client is sequence-aware.
  progress.length = 0;
  client._mediaFramesDelivered = 4;
  client._flushMediaProgress();

  assert.deepEqual(progress, [{
    type: 'media_progress',
    delivered_frames: 4,
    dg: { v: 1, rx: 0, tx: 0, sx: 0 },
  }], 'dg still rides along on a frame that was being sent anyway');
  assert.equal(client._datagramAccountingActive, false, 'nothing was negotiated');

  source.close();
  await reading;
});

test('capability stops riding along once the datagram reader closes', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const progress = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  const reading = client._readIncomingDatagrams();
  source.close();
  await reading;

  // Advertising outlives the retry budget but not the reader. With nothing ever
  // negotiated, teardown returns the session to the pre-existing wire shape.
  progress.length = 0;
  client._mediaFramesDelivered = 4;
  client._flushMediaProgress();

  assert.deepEqual(progress, [{ type: 'media_progress', delivered_frames: 4 }]);
  assert.equal(client._datagramCapable, false);
});

test('datagram receipts never inflate the stream credit counter', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};
  client._sendControl = () => true;

  const reading = client._readIncomingDatagrams();
  for (let i = 0; i < 12; i++) source.enqueue(new Uint8Array([i]));
  source.close();
  await reading;

  // delivered_frames drives the bridge's stream credit window. If datagram
  // receipts leaked into it, the window would credit sends that never happened.
  assert.equal(client._mediaFramesDelivered, 0);
  assert.equal(client.getStats().wtMediaFramesDelivered, 0);
  assert.equal(client._datagramFramesReceived, 12);
});

test('reliable accepted watermark settles an aligned sender/receiver cohort', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const progress = [];
  const payloads = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = (bytes) => payloads.push(Array.from(bytes));
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  // Envelope decoding requires a confirmed capability announcement: the service
  // worker only sequences a connection whose capability it learned from us, so
  // before that the payload space is entirely legacy. These tests stub
  // `_sendControl`, so nothing resolves on its own — assert the precondition.
  client._datagramCapabilityAnnouncementsWritten = 1;

  const reading = client._readIncomingDatagrams();
  source.enqueue(makeDatagramDeliveryFrame(1, new Uint8Array([0xa1])));
  // Sequence 2 is intentionally absent. The receiver no longer invents tx
  // from sequence 3; the reliable server control message is authoritative.
  source.enqueue(makeDatagramDeliveryFrame(3, new Uint8Array([0xa3])));
  client._handleControlMessage(datagramSendProgress(3));

  assert.equal(client._datagramSendWatermark, 3);
  assert.equal(client._datagramSettledSendWatermark, 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  source.close();
  await reading;

  assert.deepEqual(payloads, [[0xa1], [0xa3]], 'the BCDG envelope must not reach media parsing');
  assert.deepEqual(progress.at(-1), {
    type: 'media_progress',
    delivered_frames: 0,
    dg: datagramProgress(2, 3, 2),
  });
  assert.equal(client._datagramSequencedFramesReceived, 2);
  assert.equal(client._datagramSettledFramesReceived, 2);
  assert.equal(client._datagramSettledSendWatermark, 3);
});

test('BCDG epoch rollover preserves monotonic settlement and missing-range guards', async () => {
  const MAX_SEQUENCE = 0xffffffff;
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};
  client._datagramAccountingActive = true;
  client._sendControl = () => true;
  client._datagramSettledSendWatermark = MAX_SEQUENCE - 1;
  client._datagramSettledFramesReceived = MAX_SEQUENCE - 1;

  // The receiver expands epoch 1 / sequence 1 to the accepted-frame ordinal
  // immediately following epoch 0 / sequence 0xffffffff.
  // Envelope decoding requires a confirmed capability announcement: the service
  // worker only sequences a connection whose capability it learned from us, so
  // before that the payload space is entirely legacy. These tests stub
  // `_sendControl`, so nothing resolves on its own — assert the precondition.
  client._datagramCapabilityAnnouncementsWritten = 1;

  const reading = client._readIncomingDatagrams();
  source.enqueue(makeDatagramDeliveryFrame(MAX_SEQUENCE, new Uint8Array([0xaa])));
  source.enqueue(makeDatagramDeliveryFrame(1, new Uint8Array([0xbb]), 1));
  await yieldToReaders();
  client._noteDatagramSendWatermark(MAX_SEQUENCE + 1);
  client._settleDatagramSendWatermark(MAX_SEQUENCE + 1);

  assert.equal(client._datagramSettledSendWatermark, MAX_SEQUENCE + 1);
  assert.equal(client._datagramSettledFramesReceived, MAX_SEQUENCE + 1);
  assert.deepEqual(client._datagramMissingSequenceRanges, []);
  assert.equal(client._datagramPendingSequences.size, 0);
  assert.equal(client.getStats().wtDatagramSequenceRollovers, 1);
  source.close();
  await reading;
  client._resetMediaProgress();
});

test('reliable accepted watermark reports total datagram loss after grace', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const progress = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  const reading = client._readIncomingDatagrams();
  // Quinn accepted 100 datagrams, but none reached the reader. This state is
  // now produced by the real reliable control path rather than test injection.
  client._handleControlMessage(datagramSendProgress(100));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client._datagramSettledSendWatermark, 0, 'in-flight grace must not be skipped');
  assert.deepEqual(progress.at(-1).dg, datagramProgress(0));

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(progress.at(-1).dg, datagramProgress(0, 100, 0));
  source.close();
  await reading;
});

test('reader close before grace still reports the final settled watermark', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const progress = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  const reading = client._readIncomingDatagrams();
  client._handleControlMessage(datagramSendProgress(4));
  source.close();
  await reading;

  assert.equal(client._datagramCapable, false);
  assert.equal(client._datagramAccountingActive, true);
  assert.equal(client._datagramHeartbeatTimer, null);
  assert.equal(client._datagramSettledSendWatermark, 0);

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(progress.at(-1), {
    type: 'media_progress',
    delivered_frames: 0,
    dg: datagramProgress(0, 4, 0),
  });
});

test('datagrams arriving after grace correct the settled non-delivery cohort', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const progress = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  // Envelope decoding requires a confirmed capability announcement: the service
  // worker only sequences a connection whose capability it learned from us, so
  // before that the payload space is entirely legacy. These tests stub
  // `_sendControl`, so nothing resolves on its own — assert the precondition.
  client._datagramCapabilityAnnouncementsWritten = 1;

  const reading = client._readIncomingDatagrams();
  source.enqueue(makeDatagramDeliveryFrame(1, new Uint8Array([0xa1])));
  client._handleControlMessage(datagramSendProgress(4));
  // sx only moves when the settlement grace fires, so this waits for the
  // timer rather than for a duration that merely usually outlasts it.
  await waitFor(() => progress.at(-1)?.dg?.sx === 1, 'the settlement grace to publish the cohort');

  assert.deepEqual(progress.at(-1).dg, datagramProgress(1, 4, 1));
  assert.deepEqual(client._datagramMissingSequenceRanges, [{ start: 2, end: 4 }]);

  // Sequence 3 arrives after the published grace boundary. It must correct sx
  // (splitting the compact gap) rather than remain permanent loss, and a
  // duplicate must not credit twice.
  source.enqueue(makeDatagramDeliveryFrame(3, new Uint8Array([0xa3])));
  await waitFor(() => progress.at(-1)?.dg?.sx === 2, 'the post-grace correction');
  assert.deepEqual(progress.at(-1).dg, datagramProgress(2, 4, 2));
  assert.deepEqual(client._datagramMissingSequenceRanges, [
    { start: 2, end: 2 },
    { start: 4, end: 4 },
  ]);

  source.enqueue(makeDatagramDeliveryFrame(3, new Uint8Array([0xa3])));
  await waitFor(() => progress.at(-1)?.dg?.rx === 3, 'the duplicate to be counted');
  assert.deepEqual(progress.at(-1).dg, datagramProgress(3, 4, 2));
  assert.equal(client._datagramSettledFramesReceived, 2);

  source.close();
  await reading;
});

test('long-running intermittent datagram loss keeps correction state and lookup work bounded', () => {
  const client = new BridgeClient();
  const correctionHorizon = 4096;
  const settlementBatch = 256;
  const finalWatermark = correctionHorizon * 16;
  client._datagramAccountingActive = true;
  client._sendControl = () => true;

  for (let watermark = settlementBatch;
    watermark <= finalWatermark;
    watermark += settlementBatch) {
    const first = watermark - settlementBatch + 1;
    for (let sequence = first; sequence <= watermark; sequence++) {
      // Lose every odd datagram so the retained ledger is the worst sparse
      // shape: one single-sequence range for each missing frame.
      if (sequence % 2 === 0) client._datagramPendingSequences.add(sequence);
    }
    client._datagramSendWatermark = watermark;
    client._settleDatagramSendWatermark(watermark);

    // Correct one recent loss per batch to exercise lookup near the end of a
    // full sparse range set for the lifetime of the simulated session.
    client._noteDatagramFrameReceived(watermark - 1);
  }

  const retainedMissingFrames = client._datagramMissingSequenceRanges
    .reduce((total, range) => total + range.end - range.start + 1, 0);
  const stats = client.getStats();
  assert.equal(client._datagramSettledSendWatermark, finalWatermark);
  assert.equal(
    client._datagramSequencedFramesReceived,
    finalWatermark / settlementBatch,
    'every recent late correction must be found in the retained sparse ledger',
  );
  assert.ok(client._datagramFinalizedLossFrames > 0);
  assert.equal(
    client._datagramFinalizedLossFrames + retainedMissingFrames,
    client._datagramSettledSendWatermark - client._datagramSettledFramesReceived,
    'finalized plus correctable gaps must equal the published tx - sx loss',
  );
  assert.ok(
    client._datagramMissingSequenceRanges[0].start >=
      finalWatermark - correctionHorizon + 1,
    'no gap older than the correction horizon may remain retained',
  );
  assert.ok(stats.wtDatagramMissingRangesPeak <= correctionHorizon / 2);
  assert.ok(client._datagramMissingSequenceRanges.length <= correctionHorizon / 2);
  assert.ok(stats.wtDatagramMissingLookupStepsMax > 1);
  assert.ok(
    stats.wtDatagramMissingLookupStepsMax <= Math.ceil(Math.log2(correctionHorizon + 1)),
    'binary-search work per correction must remain logarithmically bounded',
  );

  const rawBeforeFinalizedArrival = client._datagramFramesReceived;
  const sequencedBeforeFinalizedArrival = client._datagramSequencedFramesReceived;
  const settledBeforeFinalizedArrival = client._datagramSettledFramesReceived;
  client._noteDatagramFrameReceived(1);
  assert.equal(client._datagramFramesReceived, rawBeforeFinalizedArrival + 1);
  assert.equal(client._datagramSequencedFramesReceived, sequencedBeforeFinalizedArrival);
  assert.equal(client._datagramSettledFramesReceived, settledBeforeFinalizedArrival);

  client._resetMediaProgress();
});

test('a large sparse watermark advance aggregates expired gaps without retaining them', () => {
  const client = new BridgeClient();
  const correctionHorizon = 4096;
  const watermark = correctionHorizon * 16;
  for (let sequence = 2; sequence <= watermark; sequence += 2) {
    client._datagramPendingSequences.add(sequence);
  }
  client._datagramSendWatermark = watermark;
  client._settleDatagramSendWatermark(watermark);

  assert.ok(client._datagramFinalizedLossFrames > correctionHorizon);
  assert.ok(client._datagramMissingSequenceRanges.length <= correctionHorizon / 2);
  assert.ok(client._debugStats.wtDatagramMissingRangesPeak <= correctionHorizon / 2);
  assert.ok(
    client._datagramMissingSequenceRanges[0].start >= watermark - correctionHorizon + 1,
  );
});

test('reliable accepted watermark reports a lost trailing datagram suffix', async () => {
  const client = new BridgeClient();
  const source = makeControlledReadableStream();
  const progress = [];
  client.connected = true;
  client._wt = { datagrams: { readable: source.stream } };
  client._handleTransportFrame = () => {};
  client._sendControl = (message) => {
    progress.push(message);
    return true;
  };

  // Envelope decoding requires a confirmed capability announcement: the service
  // worker only sequences a connection whose capability it learned from us, so
  // before that the payload space is entirely legacy. These tests stub
  // `_sendControl`, so nothing resolves on its own — assert the precondition.
  client._datagramCapabilityAnnouncementsWritten = 1;

  const reading = client._readIncomingDatagrams();
  for (let sequence = 1; sequence <= 3; sequence++) {
    source.enqueue(makeDatagramDeliveryFrame(sequence, new Uint8Array([sequence])));
  }
  // Accepted sequences 4 and 5 are the lost suffix. A receiver-derived max
  // would stop at 3 forever; the reliable accepted watermark reaches 5.
  client._handleControlMessage(datagramSendProgress(5));
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.deepEqual(progress.at(-1).dg, datagramProgress(3, 5, 3));
  source.close();
  await reading;
});

test('queued media progress coalesces the datagram counter to the newest snapshot', async () => {
  const client = new BridgeClient();
  const writes = [];
  const resolvers = [];
  client.connected = true;
  client._transport = 'webtransport';
  client._bidiWriter = {
    write(frame) {
      writes.push(new Uint8Array(frame));
      return new Promise((resolve) => resolvers.push(resolve));
    },
  };

  assert.equal(client._sendControl({ type: 'media_progress', delivered_frames: 8, dg: datagramProgress(10, 12, 10) }), true);
  assert.equal(client._sendControl({ type: 'media_progress', delivered_frames: 16, dg: datagramProgress(25, 30, 25) }), true);
  assert.equal(client._sendControl({ type: 'media_progress', delivered_frames: 24, dg: datagramProgress(41, 50, 41) }), true);

  assert.equal(writes.length, 1);
  assert.deepEqual(decodeControlFrame(writes[0]), {
    type: 'media_progress',
    delivered_frames: 8,
    dg: datagramProgress(10, 12, 10),
  });

  resolvers.shift()();
  await yieldToReaders();
  // Cumulative counters coalesce losslessly under per-field max: the newest
  // snapshot supersedes the ones it skipped.
  assert.deepEqual(decodeControlFrame(writes[1]), {
    type: 'media_progress',
    delivered_frames: 24,
    dg: datagramProgress(41, 50, 41),
  });

  resolvers.shift()();
  await yieldToReaders();
});

test('media progress omits dg entirely until a datagram arrives', async () => {
  const client = new BridgeClient();
  const writes = [];
  const resolvers = [];
  client.connected = true;
  client._transport = 'webtransport';
  client._bidiWriter = {
    write(frame) {
      writes.push(new Uint8Array(frame));
      return new Promise((resolve) => resolvers.push(resolve));
    },
  };

  assert.equal(client._sendControl({ type: 'media_progress', delivered_frames: 8 }), true);

  // A bridge that predates datagram accounting must see the exact legacy shape.
  assert.deepEqual(decodeControlFrame(writes[0]), {
    type: 'media_progress',
    delivered_frames: 8,
  });

  resolvers.shift()();
  await yieldToReaders();
});

test('queued media progress preserves a zero datagram receive report', async () => {
  const client = new BridgeClient();
  const writes = [];
  const resolvers = [];
  client.connected = true;
  client._transport = 'webtransport';
  client._bidiWriter = {
    write(frame) {
      writes.push(new Uint8Array(frame));
      return new Promise((resolve) => resolvers.push(resolve));
    },
  };

  assert.equal(client._sendControl({
    type: 'media_progress',
    delivered_frames: 0,
    dg: datagramProgress(0),
  }), true);

  assert.equal(writes.length, 1);
  assert.deepEqual(decodeControlFrame(writes[0]), {
    type: 'media_progress',
    delivered_frames: 0,
    dg: datagramProgress(0),
  });

  resolvers.shift()();
  await yieldToReaders();
});

test('connection epoch reset clears the datagram receive ledger', () => {
  const client = new BridgeClient();
  client._datagramFramesReceived = 42;
  client._datagramFramesReported = 40;
  client._datagramSequencedFramesReceived = 30;
  client._datagramSettledFramesReceived = 28;
  client._datagramSettledSendWatermark = 32;
  client._datagramPendingSequences.add(33);
  client._datagramMissingSequenceRanges.push({ start: 29, end: 32 });
  client._datagramFinalizedLossFrames = 20;
  client._debugStats.wtDatagramMissingRangesPeak = 7;
  client._debugStats.wtDatagramMissingLookupStepsMax = 3;
  client._noteDatagramSendWatermark(35);
  assert.notEqual(client._datagramSettlementTimer, null);

  client._resetMediaProgress();

  // The bridge's matching sent-counter is per QUIC connection. A ledger that
  // survived a reconnect would exceed it and report negative loss.
  assert.equal(client._datagramFramesReceived, 0);
  assert.equal(client._datagramFramesReported, 0);
  assert.equal(client._datagramSequencedFramesReceived, 0);
  assert.equal(client._datagramSendWatermark, 0);
  assert.equal(client._datagramSettledSendWatermark, 0);
  assert.equal(client._datagramSettledFramesReceived, 0);
  assert.equal(client._datagramPendingSequences.size, 0);
  assert.equal(client._datagramMissingSequenceRanges.length, 0);
  assert.equal(client._datagramFinalizedLossFrames, 0);
  assert.equal(client._debugStats.wtDatagramMissingRangesPeak, 0);
  assert.equal(client._debugStats.wtDatagramMissingLookupStepsMax, 0);
  assert.equal(client._datagramAccountingActive, false);
  assert.equal(client._datagramSettlementTimer, null);
});

// ── ROOT-01 / BLO-22696: legacy-surface discriminators ──────────────
// These counters exist to answer "is anyone still on the compatibility path?"
// with a measurement instead of a source search. Two properties matter and are
// asserted here: they must MOVE when the legacy path is taken, and they must
// not perturb the behaviour they observe.

test('tuner option resolution distinguishes explicit ATSC3 from the backward-compatible default', async () => {
  const client = new BridgeClient();
  const calls = [];
  client.subscribe = async (...args) => {
    calls.push(args);
    return { subscriptionId: `sub-${calls.length}`, setCallbacks() {} };
  };
  const tuner = createTunerAPI(client);

  // Counters start present and zero. Presence is load-bearing: a deployed
  // bridge revision WITHOUT this instrumentation omits the key entirely, which
  // a reader must treat as "unobservable", never as "zero use".
  assert.equal(client.getStats().bridgeAtscStandardExplicit, 0);
  assert.equal(client.getStats().bridgeAtscStandardDefaulted, 0);

  await tuner.subscribeBytes();                       // defaulted → 'atsc3'
  assert.equal(client.getStats().bridgeAtscStandardDefaulted, 1);
  assert.equal(client.getStats().bridgeAtscStandardExplicit, 0);

  await tuner.subscribeBytes({ standard: 'atsc3' });  // explicit, same value
  assert.equal(client.getStats().bridgeAtscStandardDefaulted, 1);
  assert.equal(client.getStats().bridgeAtscStandardExplicit, 1);

  await tuner.subscribeBytes({ standard: 'atsc1' });  // explicit, other value
  assert.equal(client.getStats().bridgeAtscStandardExplicit, 2);

  // Counting happens at the API surface, before identical endpoints collapse
  // onto one shared subscription — caller intent is what we need, not wire
  // messages. The explicit atsc3 call above reused the defaulted call's
  // subscription and never reached client.subscribe a second time, yet it is
  // still counted. That is the intended behaviour, and it is precisely why a
  // wire-level observer cannot reconstruct these counts.
  assert.equal(calls.length, 2);
});

test('defaulted and explicit ATSC3 are indistinguishable once resolved', async () => {
  // The premise of the whole ROOT-01 instrumentation: a caller that omits
  // `standard` and one that passes 'atsc3' produce identical subscribe
  // arguments, so nothing downstream of this point can tell them apart.
  // Separate clients, because one client would share the subscription.
  const record = async (options) => {
    const client = new BridgeClient();
    const calls = [];
    client.subscribe = async (...args) => {
      calls.push(args);
      return { subscriptionId: 'sub', setCallbacks() {} };
    };
    await createTunerAPI(client).subscribeBytes(options);
    return { calls, stats: client.getStats() };
  };

  const defaulted = await record(undefined);
  const explicit = await record({ standard: 'atsc3' });

  assert.deepEqual(defaulted.calls[0], explicit.calls[0]);
  // Identical on the wire, distinguishable only in the counters.
  assert.equal(defaulted.stats.bridgeAtscStandardDefaulted, 1);
  assert.equal(defaulted.stats.bridgeAtscStandardExplicit, 0);
  assert.equal(explicit.stats.bridgeAtscStandardDefaulted, 0);
  assert.equal(explicit.stats.bridgeAtscStandardExplicit, 1);
});

test('explicit/defaulted ATSC discrimination treats an explicit null as defaulted', async () => {
  const client = new BridgeClient();
  client.subscribe = async () => ({ subscriptionId: 'sub', setCallbacks() {} });
  const tuner = createTunerAPI(client);

  // `?? 'atsc3'` collapses null and undefined, so the counter must too —
  // otherwise it would report a caller as explicit while the wire says atsc3.
  await tuner.subscribeBytes({ standard: null });
  await tuner.subscribeBytes({ standard: undefined });
  assert.equal(client.getStats().bridgeAtscStandardDefaulted, 2);
  assert.equal(client.getStats().bridgeAtscStandardExplicit, 0);
});

test('legacy-surface instrumentation never perturbs the behaviour it observes', async () => {
  // A bridgeClient with no _debugStats at all (the shape the pre-existing
  // tuner test uses) must keep working: instrumentation is strictly additive
  // and is not allowed to throw on a partial client.
  const calls = [];
  const bare = {
    async subscribe(...args) {
      calls.push(args);
      return { subscriptionId: 'sub-1', setCallbacks() {} };
    },
    tunerStatus() {}, tunerTune() {}, tunerSetPlp() {},
  };
  const tuner = createTunerAPI(bare);

  await tuner.subscribeBytes();
  await tuner.subscribeBytes({ standard: 'atsc1' });

  assert.deepEqual(calls[0], ['224.0.23.60', 4937, undefined, { origin: 'tuner', standard: 'atsc3' }]);
  assert.deepEqual(calls[1], [undefined, undefined, undefined,
    { origin: 'tuner', standard: 'atsc1', protocol: 'mpeg-ts' }]);
});

test('ATSC instrumentation survives hostile _debugStats without changing tuner behaviour', async () => {
  // The counters measure the compatibility surface, so they must never become
  // a new way for it to fail. Each of these stats shapes would break a bare
  // `++`: a frozen object throws under module strict mode, a missing key
  // yields NaN, and a throwing setter propagates out of subscribeBytes.
  // In every case the tuner call must still be delivered unchanged.
  const hostileStats = [
    ['empty', {}],
    ['frozen', Object.freeze({ bridgeAtscStandardExplicit: 0, bridgeAtscStandardDefaulted: 0 })],
    ['throwing setter', {
      get bridgeAtscStandardDefaulted() { return 0; },
      set bridgeAtscStandardDefaulted(_v) { throw new Error('nope'); },
    }],
    ['non-finite', { bridgeAtscStandardDefaulted: NaN, bridgeAtscStandardExplicit: Infinity }],
    ['non-numeric', { bridgeAtscStandardDefaulted: '3', bridgeAtscStandardExplicit: null }],
  ];

  for (const [label, _debugStats] of hostileStats) {
    const calls = [];
    const client = {
      _debugStats,
      async subscribe(...args) {
        calls.push(args);
        return { subscriptionId: 'sub-1', setCallbacks() {} };
      },
      tunerStatus() {}, tunerTune() {}, tunerSetPlp() {},
    };
    const before = _debugStats.bridgeAtscStandardDefaulted;

    await createTunerAPI(client).subscribeBytes();

    assert.deepEqual(
      calls[0],
      ['224.0.23.60', 4937, undefined, { origin: 'tuner', standard: 'atsc3' }],
      `${label}: tuner behaviour must be unchanged`,
    );
    // Instrumentation may advance a healthy counter, but it must never
    // INTRODUCE a non-finite value: an unwritable or already-poisoned counter
    // is left exactly as it was, so the reader still classifies the revision
    // as unobservable instead of serialising garbage as an observation.
    const after = _debugStats.bridgeAtscStandardDefaulted;
    assert.ok(
      Object.is(after, before) || Number.isFinite(after),
      `${label}: instrumentation must not poison the counter (${String(before)} -> ${String(after)})`,
    );
  }
});

test('a well-formed stats object still counts explicit vs defaulted ATSC', async () => {
  // The hardening above must not silently disable the measurement itself.
  const _debugStats = { bridgeAtscStandardExplicit: 0, bridgeAtscStandardDefaulted: 0 };
  const client = {
    _debugStats,
    async subscribe() { return { subscriptionId: 'sub-1', setCallbacks() {} }; },
    tunerStatus() {}, tunerTune() {}, tunerSetPlp() {},
  };
  const tuner = createTunerAPI(client);

  await tuner.subscribeBytes();
  await tuner.subscribeBytes({ standard: 'atsc3' });
  await tuner.subscribeBytes();

  assert.equal(_debugStats.bridgeAtscStandardDefaulted, 2);
  assert.equal(_debugStats.bridgeAtscStandardExplicit, 1);
});

test('bridge host candidates probe loopback by name and never as an IPv6 literal', () => {
  // `localhost` resolves to ::1 as well as 127.0.0.1 in browsers, and a
  // `[::1]` probe can never be allow-listed by a page CSP (host-source has no
  // bracketed-IPv6 production), so it only produced connect-src violations.
  assert.deepEqual([...BRIDGE_HOST_CANDIDATES], ['localhost', '127.0.0.1', 'multicast-bridge.local']);
  assert.ok(Object.isFrozen(BRIDGE_HOST_CANDIDATES));
  for (const host of BRIDGE_HOST_CANDIDATES) {
    assert.equal(host.includes(':'), false, host);
    assert.equal(formatBridgeHost(host), host, `${host} must not be bracketed`);
  }
});

// ── Pinned handoff via fragment, persisted pairing, multi-hash connect ──
// BLO-34184. The pin travels in the fragment so the certificate fingerprint
// never reaches the server or its logs, and a successful pinned connect is
// remembered so the handoff is a one-time event rather than a per-visit tap.

const HASH_A = 'ab'.repeat(32);
const HASH_B = 'cd'.repeat(32);
const HASH_C = 'ef'.repeat(32);

function makeStore(initial = []) {
  const map = new Map(initial);
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** Install a page scope whose bridge connect is stubbed, and run `body`. */
async function withStubbedBridge(t, { search = '', hash = '', store = makeStore(), location = {}, init = {} }, body) {
  const { windowScope } = makeWindowEventHarness({ search, hash, ...location });
  windowScope.location.pathname = '/live';
  const replaceStateCalls = [];
  windowScope.history = {
    state: null,
    replaceState(state, title, url) {
      replaceStateCalls.push(url);
      const [path, nextHash = ''] = String(url).split('#');
      windowScope.location.pathname = path.split('?')[0];
      windowScope.location.hash = nextHash ? `#${nextHash}` : '';
    },
  };
  windowScope.localStorage = store;

  const connects = [];
  const clients = [];
  const originalConnect = BridgeClient.prototype.connect;
  BridgeClient.prototype.connect = async function stubConnect(host, httpPort, options) {
    connects.push({ host, httpPort, options });
    clients.push(this);
    // Mirror the real `connect()`, which records the args it was called with in
    // a fresh options object. `_scheduleReconnect` replays exactly this, and
    // the rotation handler reads its `fingerprint` as the set this session
    // offered — so a stub that skipped it would leave both paths unexercised
    // and make `offered` vacuously empty in every test here.
    this._lastConnectArgs = { host, httpPort, options: { ...options } };
    this.connected = true;
    this._transport = 'webtransport';
  };

  // Nothing else in this harness observes the network, so a rung that reaches
  // it does so unnoticed — the pairing rung silently spent up to its 2s
  // enrollment timeout on the one path documented as costing no network I/O.
  // Wrap whatever `fetch` is installed rather than faking a response, so a
  // caller that stubs health/enrollment replies keeps them and the probing
  // rungs keep relying on a request to an unroutable host failing fast, which
  // is what real `fetch` does in Node. Counting is the whole point.
  const fetches = [];
  const outerFetch = globalThis.fetch;
  mockGlobal(t, 'fetch', (url, init) => {
    fetches.push(String(url));
    return outerFetch(url, init);
  });

  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', store);
  mockGlobal(t, 'document', {
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', title: 'test',
  });
  mockGlobal(t, 'WebTransport', class WebTransportStub {});

  const controller = initMulticastBridge({ autoStart: false, ...init });
  try {
    await body({ controller, windowScope, connects, clients, replaceStateCalls, store, fetches });
  } finally {
    controller.stop();
    BridgeClient.prototype.connect = originalConnect;
  }
}

test('pinned parameters are read from the URL fragment', async (t) => {
  await withStubbedBridge(
    t,
    { hash: `#mc_bridge=127.0.0.1&fp=${HASH_A}&wt_port=34000` },
    async ({ controller, connects }) => {
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(connects.length, 1);
      assert.equal(connects[0].host, '127.0.0.1');
      assert.equal(connects[0].options.fingerprint, HASH_A);
      assert.equal(connects[0].options.wtPort, 34000);
    },
  );
});

test('the fragment pin is stripped from the URL once it has been read', async (t) => {
  await withStubbedBridge(
    t,
    { search: '?utm=x', hash: `#mc_bridge=127.0.0.1&fp=${HASH_A}&keep=me` },
    async ({ controller, windowScope, replaceStateCalls, connects }) => {
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(replaceStateCalls.length, 1, 'exactly one replaceState');
      assert.equal(replaceStateCalls[0], '/live?utm=x#keep=me');
      assert.doesNotMatch(windowScope.location.hash, /mc_bridge|fp=/);
      // Stripping must not blind the rungs that read the pin afterwards.
      assert.equal(connects[0].host, '127.0.0.1');
    },
  );
});

// BLO-34184 review follow-up. The strip used to rebuild the remainder with
// `new URLSearchParams(hash).toString()`, which normalises every surviving
// segment: `#/player/42` came back as `#%2Fplayer%2F42=` and `#watch` as
// `#watch=`. Hash routes and bare anchors are the two commonest fragment
// shapes on a page that takes this handoff, and the `#keep=me` case above is
// well-behaved enough to miss it.
test('stripping the pin leaves the rest of the fragment byte-for-byte', async (t) => {
  const cases = [
    // A hash-router route: slashes must not percent-encode.
    [`#/player/42&mc_bridge=127.0.0.1&fp=${HASH_A}`, '/live#/player/42'],
    // A bare anchor: must not acquire a trailing `=`, or `:target` stops matching.
    [`#watch&mc_bridge=127.0.0.1&fp=${HASH_A}`, '/live#watch'],
    // Reserved characters inside an unrelated value must survive unrewritten.
    [`#access_token=xyz.abc-_~&mc_bridge=127.0.0.1&fp=${HASH_A}`, '/live#access_token=xyz.abc-_~'],
    // Pin-only fragment still strips to no fragment at all.
    [`#mc_bridge=127.0.0.1&fp=${HASH_A}`, '/live'],
    // BLO-34184 review follow-up: the *concatenated* return shape. Every
    // fixture above is `&`-joined, which is the shape that already worked —
    // these are the shape an app emits when it appends `#…` to `to=` instead
    // of merging into `to=`'s existing fragment. Must read the pin and
    // normalise the remainder back to a single `&`-joined fragment.
    [`#watch#mc_bridge=127.0.0.1&fp=${HASH_A}`, '/live#watch'],
    [`#/player/42#mc_bridge=127.0.0.1&fp=${HASH_A}&wt_port=34000`, '/live#/player/42'],
    // The mirror: pin first, app fragment appended after. Distinct failure
    // mode from the two above — unfixed, the pin still reads, but `#watch` is
    // swallowed into `fp`'s value and then stripped, silently destroying the
    // caller's anchor. Passes only because the `&`-join is order-independent;
    // a rewrite tracking separator positions would break this while both
    // fixtures above stayed green.
    [`#mc_bridge=127.0.0.1&fp=${HASH_A}#watch`, '/live#watch'],
  ];

  for (const [hash, expected] of cases) {
    await withStubbedBridge(t, { hash }, async ({ controller, replaceStateCalls, connects }) => {
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(replaceStateCalls.length, 1, `exactly one replaceState for ${hash}`);
      assert.equal(replaceStateCalls[0], expected, `remainder preserved for ${hash}`);
      // Negative control: the pin still has to reach the rung that connects.
      assert.equal(connects[0].host, '127.0.0.1', `pin still read for ${hash}`);
    });
  }
});

// BLO-34184 review follow-up (BLO-34253). Every other `hash:` fixture here
// carries a full `mc_bridge` + `fp` pin, which is the one shape that takes the
// early return in `discoverBridge` and never touches the discovery cache. A
// *partial* fragment — `#gw=` alone, or `mc_bridge` without a fingerprint —
// falls through and steers discovery, so its result must be written under an
// isolated scope, exactly as `?gw=` is. It used to land on the unscoped key a
// clean same-origin load reads.
test('a fragment-steered load does not write the discovery cache a clean load reads', async (t) => {
  for (const hash of ['#gw=gw-other.tenant.bcast.id', '#mc_bridge=192.168.1.9']) {
    const store = makeStore();
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('HTTP forbidden'); });
    await withStubbedBridge(t, { hash, store }, async ({ controller }) => {
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const keys = [...store.map.keys()].filter((key) => key.startsWith('multicast-bridge-discovery-cache-v1'));
    assert.ok(keys.length > 0, `discovery recorded something for ${hash}`);
    assert.ok(
      !keys.includes('multicast-bridge-discovery-cache-v1'),
      `${hash} must not write the default-scope key: ${keys.join(', ')}`,
    );
  }
});

test('a successful pinned connect is persisted and reused without the pin', async (t) => {
  const store = makeStore();
  await withStubbedBridge(
    t,
    { hash: `#mc_bridge=192.168.1.9&fp=${HASH_A}&wt_port=34001`, store },
    async ({ controller }) => {
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  );

  const saved = loadBridgePairing({ storage: store });
  assert.equal(saved.host, '192.168.1.9');
  assert.equal(saved.wtPort, 34001);
  assert.deepEqual(saved.hashes, [HASH_A]);
  assert.ok(Number.isFinite(saved.storedAt));

  // Second visit: no pin in the URL at all, and the bridge is still found.
  await withStubbedBridge(t, { store }, async ({ controller, connects, fetches }) => {
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(connects.length, 1, 'the pairing rung must answer without probing');
    assert.equal(connects[0].host, '192.168.1.9');
    assert.deepEqual(connects[0].options.fingerprint, [HASH_A]);
    // Rung 0 is documented as costing no network I/O, and that is the whole
    // reason it runs ahead of the probing rungs. An enrollment fetch here is
    // unusable by construction (the attestation carries one hash, this
    // descriptor carries the `[current, next]` list) and on the stale record
    // this rung exists to detect it is a silently-dropped request that bills
    // its full 2s timeout to the fast path, before `connect()` is even called.
    assert.deepEqual(fetches, [], 'the pairing rung must reach the network zero times');
  });
});

// BLO-34193 review follow-up. The rendezvous descriptor carries the same
// shape as the pairing one — `fingerprint` is the *list* of hashes offered to
// the winning endpoint — so the enrollment fetch is unusable by construction
// there too: the attestation carries one hash and the equality can never hold.
// Worse than wasted here, because the rendezvous response publishes `wtPort`
// only, so the enrollment request goes to the caller's *default* HTTP port —
// on any bridge not sitting there, a flat 2 s added to a rung that budgeted
// 1.5 s for its own fetch and raced its connects to keep latency down.
test('a rendezvous win is not followed by an enrollment fetch', async (t) => {
  const bridges = { bridges: [{ host: '127.0.0.1', wtPort: 34002, hashes: [HASH_A, HASH_B] }] };
  mockGlobal(t, 'fetch', async (url) => {
    if (String(url).startsWith('https://rendezvous.example.test/')) {
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => bridges,
      };
    }
    // Every other rung probes a host that is not there.
    throw new Error('no bridge');
  });

  await withStubbedBridge(
    t,
    { init: { rendezvousUrl: 'https://rendezvous.example.test' } },
    async ({ controller, connects, fetches }) => {
      controller.start();
      for (let i = 0; i < 50 && connects.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.equal(connects.length, 1, 'the rendezvous rung answers');
      assert.equal(connects[0].host, '127.0.0.1');
      assert.deepEqual(connects[0].options.fingerprint, [HASH_A, HASH_B]);
      assert.ok(
        fetches.includes('https://rendezvous.example.test/v1/bridges'),
        'the rendezvous GET is the one request this rung owns',
      );
      assert.deepEqual(
        fetches.filter((url) => url.endsWith('/enrollment')),
        [],
        'an enrollment fetch here is discarded on arrival and bills 2 s to discovery',
      );
    },
  );
});

// BLO-34193 review follow-up. The acceptance criterion is behavioural — "a
// subsequent discovery with that record present performs no rendezvous fetch"
// — and was guarded only by a source-text assertion on statement order, which
// survives no rename and would miss the lookup being started from a different
// path. This observes the property itself.
test('a seeded pairing starts no rendezvous fetch', async (t) => {
  const store = makeStore();
  assert.ok(saveBridgePairing({ host: '192.168.1.9', wtPort: 34001, hashes: [HASH_A] }, { storage: store }));

  await withStubbedBridge(
    t,
    { store, init: { rendezvousUrl: 'https://rendezvous.example.test' } },
    async ({ controller, connects, fetches }) => {
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(connects.length, 1, 'the pairing rung answers');
      assert.equal(connects[0].host, '192.168.1.9');
      // `rendezvousUrl` is configured, so the rung is armed: zero fetches can
      // only mean the pairing return ran above the lookup start.
      assert.deepEqual(fetches, [], 'a paired visit must cost no network I/O');
    },
  );
});

test('a pairing is dropped when the remembered endpoint no longer connects', async (t) => {
  const store = makeStore();
  assert.ok(saveBridgePairing({ host: '192.168.1.9', wtPort: 34001, hashes: [HASH_A] }, { storage: store }));

  const { windowScope } = makeWindowEventHarness({ search: '' });
  windowScope.localStorage = store;
  const originalConnect = BridgeClient.prototype.connect;
  BridgeClient.prototype.connect = async function failingConnect() {
    throw new Error('CERTIFICATE_VERIFY_FAILED');
  };
  t.after(() => { BridgeClient.prototype.connect = originalConnect; });

  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', store);
  mockGlobal(t, 'document', {
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', title: 'test',
  });
  mockGlobal(t, 'WebTransport', class WebTransportStub {});
  mockGlobal(t, 'fetch', async () => { throw new Error('no bridge'); });

  const controller = initMulticastBridge({ autoStart: false });
  try {
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(loadBridgePairing({ storage: store }), null, 'dead pairing must not persist');
  } finally {
    controller.stop();
  }
});

test('pairing records round-trip, reject junk, and expire', () => {
  const store = makeStore();
  assert.equal(saveBridgePairing({ host: '', wtPort: 34000, hashes: [HASH_A] }, { storage: store }), null);
  assert.equal(saveBridgePairing({ host: '10.0.0.4', wtPort: 0, hashes: [HASH_A] }, { storage: store }), null);
  assert.equal(saveBridgePairing({ host: '10.0.0.4', wtPort: 34000, hashes: ['nope'] }, { storage: store }), null);
  assert.equal(loadBridgePairing({ storage: store }), null);

  const stored = saveBridgePairing(
    { host: '10.0.0.4', wtPort: 34000, httpPort: 33446, hashes: [HASH_A, HASH_B, HASH_A] },
    { storage: store, now: 1000 },
  );
  assert.deepEqual(stored.hashes, [HASH_A, HASH_B], 'duplicate hashes collapse');
  assert.equal(stored.httpPort, 33446);

  // `httpPort` is optional, so an out-of-range value is blanked rather than
  // rejecting the record — rung 0 then falls back to the caller's port. Left
  // unchecked it survives a load and the next successful connect re-persists
  // it, which makes a hand-written value sticky. `normalizeCachedBridge`
  // rejects the same set in the sibling store.
  for (const httpPort of [99999, -5, 0, '0x82a2']) {
    const junkStore = makeStore();
    assert.equal(
      saveBridgePairing({ host: '10.0.0.4', wtPort: 34000, httpPort, hashes: [HASH_A] }, { storage: junkStore }).httpPort,
      null,
      `httpPort ${httpPort} must not be stored`,
    );
    junkStore.setItem(
      'multicast-bridge-pairing-v1',
      JSON.stringify({ host: '10.0.0.4', wtPort: 34000, httpPort, hashes: [HASH_A], storedAt: 1000 }),
    );
    const loaded = loadBridgePairing({ storage: junkStore, now: 1000 });
    assert.equal(loaded.httpPort, null, `hand-written httpPort ${httpPort} must not survive a load`);
    assert.equal(loaded.wtPort, 34000, 'the rest of the record still authenticates');
  }

  assert.ok(loadBridgePairing({ storage: store, now: 1000 + 86400000 }));
  assert.equal(loadBridgePairing({ storage: store, now: 1000 + 31 * 86400000 }), null, 'expired');
  assert.equal(store.map.size, 0, 'an expired record is evicted, not re-read forever');
});

// BLO-34168 scope change (2026-09-16): "bound the stored pin TTL to cert
// validity". The bound is derived rather than picked, so assert the derivation
// and not just the number — a cert that passed the pin at `storedAt` was valid
// then, and WebTransport §11.1 caps it at 14 days total validity, so it cannot
// outlive `storedAt + 14d`. A record surviving past that holds a hash that can
// no longer authenticate anything while still steering the first connect.
test('a pairing does not outlive the certificate validity its pin is bounded by', () => {
  const store = makeStore();
  assert.ok(saveBridgePairing(
    { host: '10.0.0.4', wtPort: 34000, hashes: [HASH_A] },
    { storage: store, now: 1000 },
  ));

  // This bridge mints 13 days (native-bcds-bridge/src/lib.rs: `not_after = now
  // + days(13)`), so a record one day short of the spec ceiling is still live.
  assert.ok(
    loadBridgePairing({ storage: store, now: 1000 + 13 * 86400000 }),
    'inside the minted cert lifetime the pairing must still serve',
  );
  assert.equal(
    loadBridgePairing({ storage: store, now: 1000 + 14 * 86400000 }),
    null,
    'at the §11.1 ceiling every hash in the record is expired — drop it',
  );
  assert.equal(store.map.size, 0, 'and evict, so it cannot steer a later load');
});

// The TTL is the stated bound on how long a poisoned record can steer the first
// connect ("shorten it, do not remove it"), and a future-dated `storedAt` is the
// one input that removes it: `now - storedAt` goes negative, so the `>= TTL`
// test never fires and the record is immortal until wall-clock time catches up.
// The reachable path is not adversarial — pair while the device clock runs fast,
// then correct it.
test('a pairing dated in the future is dropped, not held immortal', () => {
  const store = makeStore();
  assert.ok(saveBridgePairing(
    { host: '10.0.0.4', wtPort: 34000, hashes: [HASH_A] },
    { storage: store, now: 10 * 86400000 },
  ));

  // The rejection is strictly `storedAt > now`, so the equal boundary still
  // serves. Pinned here rather than left to the incidental `clock === storedAt`
  // read in 'latencyMs spans the pairing retry': tightening to `>=` should fail
  // where a reader looks for the choice, not as an unrelated latency test.
  assert.ok(
    loadBridgePairing({ storage: store, now: 10 * 86400000 }),
    'storedAt === now is inside the window — only a strictly future date is rejected',
  );

  // Read it back with the clock corrected backwards by a day. Under the plain
  // `>= TTL` test this record would outlive the TTL by exactly that skew.
  assert.equal(
    loadBridgePairing({ storage: store, now: 9 * 86400000 }),
    null,
    'a record that claims to come from the future cannot be TTL-bounded — drop it',
  );
  assert.equal(store.map.size, 0, 'and evict, so it cannot steer a later load');
});

test('a pairing is capped at PAIRING_MAX_HASHES on both write and read', () => {
  // `saveBridgePairing` is exported and every stored hash is offered in the one
  // `serverCertificateHashes` attempt, so the cap has to hold at the store
  // boundary — not just in the rotation handler that happens to be the only
  // caller producing more than one hash today.
  //
  // The bound is the rendezvous union's size, not the direct pairing's
  // `[current, next]`: a record written by `connectRendezvousCandidate` carries
  // a whole collapsed-key union and the hash that authenticated is unknowable,
  // so anything smaller drops the winner's pin. The ceiling still has to hold —
  // this record is read back into a connect payload.
  const store = makeStore();
  const many = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(64, '0'));
  const stored = saveBridgePairing(
    { host: '10.0.0.4', wtPort: 34000, hashes: many },
    { storage: store, now: 1000 },
  );
  assert.deepEqual(stored.hashes, many.slice(0, 128), 'the write is capped');

  // A record written by an older build (or a hand-edited store) is capped on
  // read too, so an over-long list can never reach the connect payload.
  store.setItem(
    'multicast-bridge-pairing-v1',
    JSON.stringify({ host: '10.0.0.4', wtPort: 34000, hashes: many, storedAt: 1000 }),
  );
  assert.deepEqual(
    loadBridgePairing({ storage: store, now: 1000 }).hashes,
    many.slice(0, 128),
    'the read is capped',
  );
});

test('every stored hash is offered in one WebTransport attempt', async () => {
  const seen = [];
  const previousWebTransport = globalThis.WebTransport;
  globalThis.WebTransport = class WebTransportStub {
    constructor(url, options) {
      seen.push({ url, options });
      this.ready = Promise.reject(new Error('stub refuses'));
      this.ready.catch(() => {});
      this.closed = Promise.resolve();
    }
    close() {}
  };
  try {
    const client = new BridgeClient();
    await assert.rejects(
      client.connect('192.168.1.9', 33446, { fingerprint: [HASH_A, HASH_B], wtPort: 34000 }),
      /All WebTransport candidates failed/,
    );
    assert.ok(seen.length >= 1);
    const hashes = seen[0].options.serverCertificateHashes;
    assert.equal(hashes.length, 2, 'both hashes go out in a single attempt');
    assert.deepEqual(hashes.map((h) => h.algorithm), ['sha-256', 'sha-256']);
    assert.equal(hashes[0].value[0], 0xab);
    assert.equal(hashes[1].value[0], 0xcd);
  } finally {
    if (previousWebTransport === undefined) delete globalThis.WebTransport;
    else globalThis.WebTransport = previousWebTransport;
  }
});

test('certificate_rotation refreshes the stored hashes and ignores unusable announcements', () => {
  const client = new BridgeClient();
  const rotations = [];
  client._onCertificateRotation = (hashes) => rotations.push(hashes);

  client._handleControlMessage(JSON.stringify({ type: 'certificate_rotation', current: HASH_A, next: HASH_B }));
  assert.deepEqual(rotations.at(-1), [HASH_A, HASH_B]);

  client._handleControlMessage(JSON.stringify({ type: 'certificate_rotation', hashes: [HASH_B] }));
  assert.deepEqual(rotations.at(-1), [HASH_B]);

  // The producing half is not deployed everywhere yet: an announcement that
  // carries nothing usable must leave the existing pairing alone.
  client._handleControlMessage(JSON.stringify({ type: 'certificate_rotation' }));
  client._handleControlMessage(JSON.stringify({ type: 'certificate_rotation', hashes: ['garbage'] }));
  assert.equal(rotations.length, 2);
});

test('an in-session rotation updates the persisted pairing', async (t) => {
  const store = makeStore();
  await withStubbedBridge(
    t,
    { hash: `#mc_bridge=192.168.1.9&fp=${HASH_A}&wt_port=34001`, store },
    async ({ controller, clients }) => {
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(loadBridgePairing({ storage: store }).hashes, [HASH_A]);

      clients[0]._handleControlMessage(
        JSON.stringify({ type: 'certificate_rotation', current: HASH_A, next: HASH_B }),
      );
      assert.deepEqual(loadBridgePairing({ storage: store }).hashes, [HASH_A, HASH_B]);

      // The persisted record alone is not enough: nothing re-reads it in this
      // session. `_scheduleReconnect` replays `_lastConnectArgs.options` by
      // reference, so this is the set an in-session reconnect after the swap
      // would offer to `serverCertificateHashes` — stale, it wedges forever,
      // because a page holding subscriptions never falls back to rediscovery.
      assert.deepEqual(
        clients[0]._lastConnectArgs.options.fingerprint,
        [HASH_A, HASH_B],
        'the live client must be re-armed, not just the stored pairing',
      );
      // The union is with what this session *offered*, so the pre-rotation
      // hash has to survive an announcement that names only the successor.
      clients[0]._handleControlMessage(
        JSON.stringify({ type: 'certificate_rotation', hashes: [HASH_C] }),
      );
      assert.deepEqual(clients[0]._lastConnectArgs.options.fingerprint, [HASH_C, HASH_A, HASH_B]);
    },
  );
});

test('a supplied bridge parameter outranks a remembered pairing', async (t) => {
  // Rung 0 must stay strictly below supplied configuration. The drop path only
  // fires when the pairing fails to connect, so while the paired bridge still
  // answers, a remembered endpoint would beat the visitor's own `?mc_bridge=`
  // for the full pairing TTL with nothing attributing the choice to the pairing.
  const store = makeStore();
  assert.ok(saveBridgePairing(
    { host: '192.168.1.9', wtPort: 34001, httpPort: 33446, hashes: [HASH_A] },
    { storage: store },
  ));
  mockGlobal(t, 'fetch', async (url) => (
    new URL(url).hostname === '192.168.1.50'
      ? {
        ok: true,
        json: async () => ({
          bridgeProtocol: 'bcds-v1',
          webTransportBridge: true,
          fingerprint: HASH_B,
          httpPort: 33446,
          wtPort: 34002,
        }),
      }
      : { ok: false }
  ));

  await withStubbedBridge(
    t,
    { search: '?mc_bridge=192.168.1.50', store },
    async ({ controller, connects }) => {
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.equal(connects.length, 1);
      assert.equal(connects[0].host, '192.168.1.50', 'the supplied host must win over the pairing');
      assert.equal(connects[0].options.fingerprint, HASH_B);
    },
  );
});

test('a rotation on a CA-validated session writes no pairing', async (t) => {
  // Every CA rung returns `fingerprint: ''`, so the success-path save no-ops
  // through `saveBridgePairing`'s empty-hash guard. The rotation handler
  // injects `hashes`, which would satisfy that same guard on behalf of a host
  // that has no pin — and the next load would then offer those hashes as
  // `serverCertificateHashes` against a CA-signed certificate.
  const store = makeStore();
  mockGlobal(t, 'fetch', async (url) => (
    new URL(url).hostname === '192-168-1-9.gw-test.bcast.id'
      ? {
        ok: true,
        json: async () => ({
          bridgeProtocol: 'bcds-v1',
          webTransportBridge: true,
          gatewayDomain: 'gw-test.bcast.id',
          localAddress: '192.168.1.9',
          httpPort: 33446,
          wtPort: 34001,
        }),
      }
      : { ok: false }
  ));

  await withStubbedBridge(
    t,
    { search: '?gw=192-168-1-9.gw-test.bcast.id', store },
    async ({ controller, clients, connects }) => {
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.equal(connects[0]?.host, '192-168-1-9.gw-test.bcast.id');
      assert.equal(connects[0].options.fingerprint, '', 'the AutoTLS rung is CA-validated');
      assert.equal(loadBridgePairing({ storage: store }), null, 'a CA host is not worth remembering');

      clients[0]._handleControlMessage(
        JSON.stringify({ type: 'certificate_rotation', current: HASH_A, next: HASH_B }),
      );
      assert.equal(
        loadBridgePairing({ storage: store }),
        null,
        'a rotation must not pin a host that authenticated through a CA',
      );
      // Same hazard on the live half. `connect()` only builds the DNS/AutoTLS
      // candidate while `hashes` is empty, so arming a pin here would strip
      // this session's own rung on the next reconnect — breaking the reconnect
      // the re-arm exists to keep alive.
      assert.equal(
        clients[0]._lastConnectArgs.options.fingerprint,
        '',
        'a rotation must not arm the live args of a CA-validated session either',
      );
    },
  );
});

test('an AutoTLS-routed session writes no pairing even when the bridge carries a pin', async (t) => {
  // `normalizeBridgeHealth` blanks the fingerprint only when the health
  // response omits one, so a response advertising a pin *and* an AutoTLS
  // domain keeps both — the documented `multicast-bridge.local` bootstrap
  // shape. `connect()` builds the AutoTLS candidate first and unconditionally,
  // so the session authenticates CA-style against the gateway host while
  // `bridge.fingerprint` stays non-empty. Saving that would write a record
  // describing the direct private-IP endpoint this session never connected to,
  // and rung 0 would then steer the next load onto the PNA-blocked path
  // AutoTLS exists to bypass.
  const store = makeStore();
  mockGlobal(t, 'fetch', async (url) => (
    new URL(url).hostname === 'multicast-bridge.local'
      ? {
        ok: true,
        json: async () => ({
          bridgeProtocol: 'bcds-v1',
          webTransportBridge: true,
          fingerprint: HASH_A,
          gatewayDomain: 'gw-test.bcast.id',
          localAddress: '192.168.1.9',
          httpPort: 33446,
          wtPort: 34001,
        }),
      }
      : { ok: false }
  ));

  await withStubbedBridge(
    t,
    // An http page, because `multicast-bridge.local` is served over http and
    // `canProbeBridgeHost` refuses that from an https page — this rung is the
    // documented public-app bootstrap, not a secure-page one.
    { store, location: { href: 'http://example.test/live', origin: 'http://example.test', protocol: 'http:' } },
    async ({ controller, clients, connects }) => {
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The bridge really does carry both — otherwise this asserts nothing.
      assert.equal(connects[0]?.options.fingerprint, HASH_A, 'the bridge carries a pin');
      assert.equal(connects[0].options.gatewayDomain, 'gw-test.bcast.id', 'and a gateway domain');
      assert.equal(
        loadBridgePairing({ storage: store }),
        null,
        'a gateway-routed session must not be remembered as a direct pinned endpoint',
      );
      // The positive half: the route *is* remembered, by `saveGateway`. Without
      // this, the case would keep passing if `installAPI` stopped installing on
      // this rung — `saveBridgePairing` would never run and the null above would
      // hold for the wrong reason.
      const savedGateway = loadSavedGateway();
      assert.equal(savedGateway?.gatewayDomain, 'gw-test.bcast.id', 'the gateway route is remembered');
      assert.equal(savedGateway?.localAddress, '192.168.1.9', 'with the local address to build it from');

      // The rotation handler must not reintroduce it either: the injected
      // hashes are non-empty by construction and `bridge.fingerprint` is a
      // real pin here, so both of its existing clauses pass.
      clients[0]._handleControlMessage(
        JSON.stringify({ type: 'certificate_rotation', current: HASH_A, next: HASH_B }),
      );
      assert.equal(
        loadBridgePairing({ storage: store }),
        null,
        'a rotation must not pin a gateway-routed host either',
      );
    },
  );
});

test('bridge-ready carries the winning rung, latency, and platform', async (t) => {
  await withStubbedBridge(
    t,
    { hash: `#mc_bridge=127.0.0.1&fp=${HASH_A}` },
    async ({ controller, windowScope }) => {
      const details = [];
      windowScope.addEventListener('multicast-bridge-ready', (event) => details.push(event.detail));
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(details.length, 1);
      assert.equal(details[0].rung, 'pinned');
      assert.ok(Number.isFinite(details[0].latencyMs) && details[0].latencyMs >= 0);
      assert.equal(typeof details[0].platform, 'string');
    },
  );
});

test('a pairing is never laundered through the discovery cache', async (t) => {
  // The pairing store is the durable cache for this rung; the 15s discovery
  // cache must not shadow it. A cached round trip would drop `fromPairing`
  // (leaving a dead record retried instead of dropped) and, for a [current,
  // next] pair, stringify `fingerprint` into one unusable value. Today the
  // capability check keeps pairing descriptors out; this pins that, so making
  // one cacheable fails here instead of silently regressing the drop path.
  const store = makeStore();
  assert.ok(saveBridgePairing(
    { host: '192.168.1.9', wtPort: 34001, httpPort: 33446, hashes: [HASH_A] },
    { storage: store },
  ));

  await withStubbedBridge(t, { store }, async ({ controller, connects }) => {
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(connects[0].options.fingerprint, [HASH_A]);
  });

  assert.equal(
    readBridgeDiscoveryCache(33446, Date.now(), store),
    null,
    'the pairing rung must not populate the discovery cache',
  );
});

test('a multi-hash pairing reaches connect intact', async (t) => {
  const store = makeStore();
  assert.ok(saveBridgePairing(
    { host: '192.168.1.9', wtPort: 34001, httpPort: 33446, hashes: [HASH_A, HASH_B] },
    { storage: store },
  ));

  await withStubbedBridge(t, { store }, async ({ controller, connects }) => {
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(connects[0].options.fingerprint, [HASH_A, HASH_B]);
    assert.equal(connects[0].options.wtPort, 34001);
  });
});

// BLO-34184 review follow-up. `AbortError` is raised only when an attempt is
// superseded — by `stop()` or by a newer connect — so it must never be read as
// "the remembered endpoint is dead". Before the guard, a teardown mid-handshake
// landed in the pairing-retry branch, which dropped a healthy record and then
// recursed into `tryConnectOnce` past the `stopped` check on `tryConnect`,
// restarting discovery after `stop()` had returned.
test('stop() during an in-flight pairing connect drops neither the pairing nor the teardown', async (t) => {
  const store = makeStore();
  assert.ok(saveBridgePairing({ host: '192.168.1.9', wtPort: 34001, hashes: [HASH_A] }, { storage: store }));

  const { windowScope } = makeWindowEventHarness({ search: '' });
  windowScope.localStorage = store;

  const connects = [];
  let releaseConnect;
  const connectGate = new Promise((resolve) => { releaseConnect = resolve; });
  const originalConnect = BridgeClient.prototype.connect;
  BridgeClient.prototype.connect = async function stubConnect(host) {
    connects.push(host);
    if (connects.length === 1) {
      await connectGate;
      throw new DOMException('WebTransport connection superseded', 'AbortError');
    }
    this.connected = true;
    this._transport = 'webtransport';
  };
  t.after(() => { BridgeClient.prototype.connect = originalConnect; });

  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', store);
  mockGlobal(t, 'document', {
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', title: 'test',
  });
  mockGlobal(t, 'WebTransport', class WebTransportStub {});
  mockGlobal(t, 'fetch', async () => { throw new Error('no bridge'); });

  const controller = initMulticastBridge({ autoStart: false });
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(connects.length, 1, 'the pairing connect is in flight');

  controller.stop();
  releaseConnect();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(window.multicast, undefined, 'stop() must leave the API uninstalled');
  assert.equal(connects.length, 1, 'no connect may be started after stop()');
  assert.ok(
    loadBridgePairing({ storage: store }),
    'a supersession is not evidence the endpoint is dead — the pairing must survive',
  );
});

// BLO-34184 review follow-up. The pairing is keyed by the *pairing* scope, not
// the discovery scope: keying it by `?mc_bridge=` would write it under a key
// the next pin-free load cannot compute, so the query-param handoff would never
// re-pair and the record would sit unreachable for the full TTL.
test('a query-param pinned handoff re-pairs on the next clean visit', async (t) => {
  const store = makeStore();
  await withStubbedBridge(
    t,
    { search: `?mc_bridge=192.168.1.9&fp=${HASH_A}&wt_port=34001`, store },
    async ({ controller }) => {
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  );

  assert.deepEqual(
    [...store.map.keys()],
    ['multicast-bridge-pairing-v1'],
    'the record must not be keyed by the pin that created it',
  );

  // Second visit: no pin anywhere, so only a reachable record can answer.
  await withStubbedBridge(t, { store }, async ({ controller, connects }) => {
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(connects.length, 1, 'the pairing rung must answer the clean revisit');
    assert.equal(connects[0].host, '192.168.1.9');
    assert.deepEqual(connects[0].options.fingerprint, [HASH_A]);
  });
});

// BLO-34184 review follow-up. The fragment read is destructive, but a *miss*
// destroys nothing, so memoizing one only blinds the window to a pin that
// arrives later (SPA soft navigation, or a same-document `#mc_bridge=` link).
test('a pin arriving after the first read is still harvested', () => {
  const { windowScope } = makeWindowEventHarness({ search: '' });
  windowScope.location.hash = '';
  windowScope.location.pathname = '/live';
  windowScope.history = { state: null, replaceState() {} };

  assert.equal(bridgeUrlParams(windowScope).get('fp'), null, 'no pin yet');

  windowScope.location.hash = `#mc_bridge=192.168.1.9&fp=${HASH_A}`;
  assert.equal(bridgeUrlParams(windowScope).get('fp'), HASH_A, 'a later pin must still be seen');

  // The hit is still memoized, so the destructive read stays a one-time event.
  windowScope.location.hash = `#mc_bridge=10.0.0.4&fp=${HASH_B}`;
  assert.equal(bridgeUrlParams(windowScope).get('fp'), HASH_A, 'the harvested pin is sticky');
});

// BLO-34184 review follow-up. A dead pinned endpoint is QUIC to a closed UDP
// port, so each attempt burns the full connect timeout. The pairing is a
// remembered guess, so it gets one attempt (~5s) rather than the full
// three-attempt budget (~16.5s) before rediscovery starts.
test('a stale pairing is bounded to a single connect attempt', async (t) => {
  const store = makeStore();
  assert.ok(saveBridgePairing({ host: '192.168.1.9', wtPort: 34001, hashes: [HASH_A] }, { storage: store }));

  await withStubbedBridge(t, { store }, async ({ controller, connects }) => {
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(connects[0].options.connectAttempts, 1);
  });

  // A live-discovery rung keeps the full budget — the bound is pairing-only.
  await withStubbedBridge(
    t,
    { hash: `#mc_bridge=192.168.1.9&fp=${HASH_A}&wt_port=34001` },
    async ({ controller, connects }) => {
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(connects[0].options.connectAttempts, undefined);
    },
  );
});

// BLO-34184 review follow-up. An announcement is unioned with the hashes the
// session offered in `serverCertificateHashes`: a producer that sends only
// [next] would otherwise discard the still-valid current hash and strand the
// pairing.
test('a rotation announcing only the next hash keeps the offered one', () => {
  const client = new BridgeClient();
  const rotations = [];
  client._onCertificateRotation = (hashes) => rotations.push(hashes);
  client._lastConnectArgs = { host: '192.168.1.9', httpPort: 33446, options: { fingerprint: [HASH_A] } };

  client._handleControlMessage(JSON.stringify({ type: 'certificate_rotation', hashes: [HASH_B] }));
  assert.deepEqual(rotations.at(-1), [HASH_B, HASH_A], 'announced first, offered retained');

  // Monotonic growth is bounded: every stored hash rides the one connect.
  client._lastConnectArgs.options.fingerprint = [HASH_A, HASH_B, HASH_A, HASH_B];
  client._handleControlMessage(JSON.stringify({
    type: 'certificate_rotation',
    hashes: ['ef'.repeat(32), '12'.repeat(32), '34'.repeat(32), '56'.repeat(32), '78'.repeat(32)],
  }));
  assert.equal(rotations.at(-1).length, 4);
});

// BLO-34184 review follow-up. `latencyMs` must cover the whole wait the user
// sat through. The pairing-retry path re-enters `tryConnectOnce`, so a
// per-pass timestamp reported the rediscovery alone and hid the dead-pinned-
// candidate stall that `connectAttempts: 1` exists to bound — precisely the
// case the measurement exists to expose.
test('latencyMs spans the pairing retry, not just the second pass', async (t) => {
  // The pairing delete is a no-op here: the documented "the drop did not take"
  // case (storage full, disabled, or throwing) that `pairingRetried` bounds.
  // The second pass then re-reads the same record and connects, which reaches
  // a successful install without stubbing a discovery rung. Scoped to that one
  // key — swallowing every delete would also strand the discovery lock, and the
  // second pass would never get past `lockBusy`.
  const store = makeStore();
  const realRemoveItem = store.removeItem;
  store.removeItem = (key) => {
    if (key !== 'multicast-bridge-pairing-v1') realRemoveItem(key);
  };
  // Seed `storedAt` from the same mocked clock the load will read. Saving under
  // the real `Date.now()` and then reading under this much smaller mocked one
  // dates the record ~1.8e12 ms in the future, which `loadBridgePairing` now
  // rejects outright rather than holding immortal.
  let clock = 1_000_000;
  assert.ok(saveBridgePairing(
    { host: '192.168.1.9', wtPort: 34001, hashes: [HASH_A] },
    { storage: store, now: clock },
  ));
  t.mock.method(Date, 'now', () => clock);

  const { windowScope } = makeWindowEventHarness({ search: '' });
  windowScope.localStorage = store;

  const connects = [];
  const originalConnect = BridgeClient.prototype.connect;
  BridgeClient.prototype.connect = async function stubConnect(host) {
    connects.push(host);
    if (connects.length === 1) {
      clock += 5000; // the dead pinned candidate burns its one attempt
      throw new Error('CERTIFICATE_VERIFY_FAILED');
    }
    clock += 1000; // the retry itself is fast
    this.connected = true;
    this._transport = 'webtransport';
  };
  t.after(() => { BridgeClient.prototype.connect = originalConnect; });

  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', store);
  mockGlobal(t, 'document', {
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', title: 'test',
  });
  mockGlobal(t, 'WebTransport', class WebTransportStub {});
  mockGlobal(t, 'fetch', async () => { throw new Error('no bridge'); });

  const details = [];
  windowScope.addEventListener('multicast-bridge-ready', (event) => details.push(event.detail));

  const controller = initMulticastBridge({ autoStart: false });
  try {
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(connects.length, 2, 'the failed pairing must be retried once');
    assert.equal(details.length, 1);
    assert.ok(
      details[0].latencyMs >= 6000,
      `latency must span both passes, got ${details[0].latencyMs}`,
    );
  } finally {
    controller.stop();
  }
});

// BLO-34184 review follow-up. `rung` survives the discovery cache — a cached
// entry keeps whichever rung first found it — so a cache hit would otherwise
// report that rung at near-zero latency and read as "the live rung is
// extremely fast" rather than "the cache served it".
test('bridge-ready distinguishes a cache hit from the rung that filled it', async (t) => {
  const store = makeStore();
  assert.ok(writeBridgeDiscoveryCache(33446, {
    host: '192.168.1.9',
    fingerprint: HASH_A,
    httpPort: 33446,
    wtPort: 34001,
    discoveryMethod: 'desktop-lan',
    bridgeProtocol: 'bcds-v1',
    webTransportBridge: true,
  }, { storage: store }));

  await withStubbedBridge(t, { store }, async ({ controller, windowScope }) => {
    const details = [];
    windowScope.addEventListener('multicast-bridge-ready', (event) => details.push(event.detail));
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(details[0].rung, 'desktop-lan', 'the originating rung is still reported');
    assert.equal(details[0].servedFromCache, true, 'but the cache is credited for this load');
  });

  // Negative control: a live rung must not be reported as cache-served.
  await withStubbedBridge(
    t,
    { hash: `#mc_bridge=192.168.1.9&fp=${HASH_A}&wt_port=34001` },
    async ({ controller, windowScope }) => {
      const details = [];
      windowScope.addEventListener('multicast-bridge-ready', (event) => details.push(event.detail));
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(details[0].rung, 'pinned');
      assert.equal(details[0].servedFromCache, false);
    },
  );
});

// BLO-34168 scope change (2026-09-16): gate the ladder on `typeof WebTransport`
// and never on an OS version, and report the share of loads that cannot reach
// any rung (iOS < 26.4, where WebKit has no WebTransport). Without that, "no
// WebTransport" and "no bridge found" are the same silence, so the population
// the gate exists to size is unmeasurable.
//
// Review follow-up (Ally, 35922a1): this outcome is reported as a property, not
// an event. The listener here is attached BEFORE init on purpose — it is the
// ordering most favourable to an event, so a dispatch from any point inside
// init would be caught. Production has the opposite ordering (every consumer
// awaits init and registers afterwards), which is why no event can work here.
test('a browser without WebTransport reports itself instead of failing silently', async (t) => {
  const { windowScope } = makeWindowEventHarness();
  const events = [];
  for (const type of ['multicast-bridge-unavailable', 'multicast-bridge-ready']) {
    windowScope.addEventListener(type, (e) => events.push({ type, ...e.detail }));
  }

  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) CriOS/140.0';
  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'navigator', { userAgent: ua });
  mockGlobal(t, 'localStorage', makeStore());
  mockGlobal(t, 'document', {
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', title: 'test',
  });
  mockGlobal(t, 'WebTransport', undefined);

  const controller = initMulticastBridge({ autoStart: false });
  try {
    assert.equal(
      controller.unavailableReason,
      'no-webtransport',
      'the reason is readable the instant init returns, with no listener race',
    );
    assert.equal(controller.connected, false);

    // start() is where a latched dispatch would land, and production calls it
    // before registering too (blockcast-shaka-msf.js:2057 vs :2076).
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      events, [],
      'no event on this path: consumers register after init, so it could not be heard',
    );
    assert.equal(
      controller.unavailableReason,
      'no-webtransport',
      'and the reason survives start() rather than being a one-shot',
    );
  } finally {
    controller.stop();
  }
});

// The same two properties must be readable on the branch that CAN connect —
// otherwise `unavailableReason` reads as undefined there and a consumer cannot
// tell "available" from "got the other shape".
test('the controller exposes the same readable shape when WebTransport exists', async (t) => {
  await withStubbedBridge(
    t,
    { hash: `#mc_bridge=192.168.1.9&fp=${HASH_A}&wt_port=34001` },
    async ({ controller }) => {
      assert.equal(
        controller.unavailableReason, null,
        'null, not undefined: the bridge may yet connect',
      );
      assert.equal(controller.connected, false, 'not connected yet, but the property is real');

      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(controller.connected, true, 'and it tracks the live client, not a constant');
      assert.equal(controller.unavailableReason, null);
    },
  );
});

// BLO-34184 review follow-up (Ally, suggestion at 4896874). The fragment strip
// is a side effect of `bridgeUrlParams`, and every other caller sits below the
// extension check — so a page that already provides `window.multicast` never
// harvested, and the pin survived in the URL to ride along in a copied link.
// That is the one thing carrying it in the fragment exists to prevent.
//
// The surface is installed *before* init here, which is the real ordering (the
// extension's inject.js runs first) and the one that skips the most checks:
// `start()` and the init-time check both return before `tryConnectOnce` is ever
// reached, so harvesting at that function — the narrowest reading of the
// suggestion — would leave this path exactly as broken.
test('the fragment pin is stripped even when an extension surface preempts discovery', async (t) => {
  const { windowScope } = makeWindowEventHarness({
    search: '',
    hash: `#watch&mc_bridge=127.0.0.1&fp=${HASH_A}&wt_port=34000`,
  });
  windowScope.location.pathname = '/live';
  const replaceStateCalls = [];
  windowScope.history = {
    state: null,
    replaceState(state, title, url) {
      replaceStateCalls.push(url);
      const [path, nextHash = ''] = String(url).split('#');
      windowScope.location.pathname = path.split('?')[0];
      windowScope.location.hash = nextHash ? `#${nextHash}` : '';
    },
  };
  // The extension surface is already there when the page boots.
  windowScope.multicast = { subscribe() {} };

  const connects = [];
  const originalConnect = BridgeClient.prototype.connect;
  BridgeClient.prototype.connect = async function stubConnect(...args) {
    connects.push(args);
  };
  t.after(() => { BridgeClient.prototype.connect = originalConnect; });

  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', makeStore());
  mockGlobal(t, 'document', {
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', title: 'test',
  });
  mockGlobal(t, 'WebTransport', class WebTransportStub {});

  const controller = initMulticastBridge({ autoStart: false });
  try {
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(connects.length, 0, 'the extension surface still wins — no connect');
    assert.equal(replaceStateCalls.length, 1, 'but the pin is harvested and stripped');
    assert.equal(windowScope.location.hash, '#watch', 'and unrelated fragment content survives');
    assert.ok(
      !replaceStateCalls[0].includes(HASH_A),
      'the fingerprint must not remain in the URL',
    );
  } finally {
    controller.stop();
  }
});

// --- Durable bridge enrollment (BLO-34059) -----------------------------------
//
// Vectors come from the shared contract file the producer reads too
// (packages/native-bcds-bridge/vectors/bridge-enrollment-v1.json, BLO-34022).
// Both sides hardcode `bcds-enrollment-v1\n<id>\n<fp>\n<not_before>\n<not_after>`
// independently; each asserts its own reconstruction against this file, which
// is what makes a change to that format fail a lane on whichever side moves
// first, instead of leaving this consumer silently never enrolling behind a
// green suite.
//
// Fixed vectors, so the suite needs no live bridge. Two distinct P-256 keys:
// BRIDGE_A is the bridge a page enrols, BRIDGE_B is a different bridge (which
// is also what `bcds_revoke_enrollment` leaves behind — a freshly minted id).

const ENROLLMENT_CONTRACT = JSON.parse(readFileSync(
  new URL('./vectors/bridge-enrollment-v1.json', import.meta.url),
  'utf8',
));

function enrollmentVector(name) {
  const found = ENROLLMENT_CONTRACT.vectors.find((entry) => entry.name === name);
  if (!found) throw new Error(`no enrollment vector named ${name}`);
  return found;
}

const ATTEST_A1 = enrollmentVector('bridge-a-cert-1').attestation;
const ATTEST_A2 = enrollmentVector('bridge-a-cert-2-rotated').attestation;
const ATTEST_B = enrollmentVector('bridge-b').attestation;
const ATTEST_A1_EXPIRED = enrollmentVector('bridge-a-cert-1-expired').attestation;
// A third key that correctly signs an attestation naming BRIDGE_B's id. The
// signature is valid; only the id-to-key derivation is a lie.
const ATTEST_ID_SUBSTITUTED = enrollmentVector('id-substituted').attestation;

const FP_A1 = ATTEST_A1.fingerprint;
const FP_A2 = ATTEST_A2.fingerprint; // BRIDGE_A after its certificate rotated on schedule
const FP_B = ATTEST_B.fingerprint;
const NOT_BEFORE = ATTEST_A1.not_before;
const NOT_AFTER = ATTEST_A1.not_after; // 2100-01-01
const NOW_MS = 1800000000000; // 2027-01-15, inside A/B and past every expired vector

const BRIDGE_A = { publicKey: ATTEST_A1.public_key, bridgeId: ATTEST_A1.bridge_id };
const BRIDGE_B = { publicKey: ATTEST_B.public_key, bridgeId: ATTEST_B.bridge_id };

function cachedBridge(overrides = {}) {
  return {
    host: 'multicast-bridge.local',
    fingerprint: FP_A1,
    httpPort: 33446,
    wtPort: 33445,
    bridgeProtocol: 'bcds-v1',
    webTransportBridge: true,
    enrollment: { bridgeId: BRIDGE_A.bridgeId, publicKey: BRIDGE_A.publicKey },
    ...overrides,
  };
}

// WebCrypto resolves on the libuv threadpool, so the rotation completes over
// several event-loop turns rather than a fixed number of microtask ticks.
async function waitFor(predicate, what) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test('a genuine enrollment attestation verifies and yields the durable identity', async () => {
  const verified = await verifyBridgeEnrollment(ATTEST_A1, { now: NOW_MS });
  assert.deepEqual(verified, {
    bridgeId: BRIDGE_A.bridgeId,
    publicKey: BRIDGE_A.publicKey,
    fingerprint: FP_A1,
    notBefore: NOT_BEFORE,
    notAfter: NOT_AFTER,
  });
});

test('the shared enrollment contract pins the signed message format', async () => {
  // This is what makes the shared file load-bearing rather than decorative on
  // this side. The producer asserts `attestation_message()` reproduces
  // `message` (identity.rs, attestation_message_matches_the_shared_contract_vectors);
  // here the page's own reconstruction is checked against the same string.
  // Move the format on either side and a lane fails on whichever moves first —
  // instead of this consumer verifying nothing, pinning nothing, and never
  // enrolling behind a green suite.
  assert.ok(ENROLLMENT_CONTRACT.vectors.length >= 5);
  for (const entry of ENROLLMENT_CONTRACT.vectors) {
    const a = entry.attestation;
    assert.equal(
      entry.message,
      `bcds-enrollment-v1\n${a.bridge_id}\n${a.fingerprint}\n${a.not_before}\n${a.not_after}`,
      entry.name,
    );
    // The two encodings that are easy to get wrong and fail closed if they are:
    // fixed-width r||s rather than ASN.1 DER, and an uncompressed P-256 point.
    assert.equal(a.signature.length, 128, entry.name);
    assert.equal(a.public_key.length, 130, entry.name);
    assert.ok(a.public_key.startsWith('04'), entry.name);
  }
});

test('an enrollment attestation is verified, not trusted', async () => {
  const cases = {
    // Negative control. BRIDGE_A really did sign ATTEST_A1 — but over FP_A1.
    // Swapping in the certificate a page would rather pin must fail, so this
    // suite cannot pass by never actually running the signature check.
    'forged fingerprint': { ...ATTEST_A1, fingerprint: FP_A2 },
    'tampered signature': {
      ...ATTEST_A1,
      signature: ATTEST_A1.signature.slice(0, -2) + (ATTEST_A1.signature.endsWith('a7') ? 'a6' : 'a7'),
    },
    // Signature is valid; bridge_id simply is not the SHA-256 of public_key.
    'bridge_id not derived from public_key': ATTEST_ID_SUBSTITUTED,
    'expired not_after': ATTEST_A1_EXPIRED,
    'tampered not_after': { ...ATTEST_A1, not_after: NOT_AFTER + 1 },
    'substituted public key': { ...ATTEST_A1, public_key: BRIDGE_B.publicKey },
    'unknown schema': { ...ATTEST_A1, schema: 2 },
    'truncated signature': { ...ATTEST_A1, signature: ATTEST_A1.signature.slice(0, 126) },
    'non-integer not_after': { ...ATTEST_A1, not_after: String(NOT_AFTER) },
    'missing body': null,
  };
  for (const [name, bad] of Object.entries(cases)) {
    assert.equal(await verifyBridgeEnrollment(bad, { now: NOW_MS }), null, name);
  }
  // The window has two ends and both are signed. ATTEST_A1 is genuine and
  // unexpired here — only `now` is before the bridge said it was valid.
  assert.equal(await verifyBridgeEnrollment(ATTEST_A1, { now: (NOT_BEFORE - 1) * 1000 }), null);
  assert.ok(await verifyBridgeEnrollment(ATTEST_A1, { now: NOT_BEFORE * 1000 }));
});

test('a pinned public key decides which bridge an attestation may speak for', async () => {
  // The crux of surviving a rotation: the page checks the certificate the
  // bridge offers now against the key it already enrolled, not against
  // whichever key the response carried.
  const pinnedPublicKey = BRIDGE_A.publicKey;
  assert.equal(
    (await verifyBridgeEnrollment(ATTEST_A2, { now: NOW_MS, pinnedPublicKey })).fingerprint,
    FP_A2,
  );
  for (const [name, attested, pin] of [
    ['a different bridge', ATTEST_B, pinnedPublicKey],
    ['an id-substituted key', ATTEST_ID_SUBSTITUTED, pinnedPublicKey],
    ['a malformed pin', ATTEST_A2, `${pinnedPublicKey.slice(0, -1)}`],
  ]) {
    assert.equal(await verifyBridgeEnrollment(attested, { now: NOW_MS, pinnedPublicKey: pin }), null, name);
  }
});

test('discovery pins the enrollment the bridge signs for the certificate it serves', async (t) => {
  const storage = memoryStorage();
  const { windowScope } = makeWindowEventHarness();
  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', storage);
  mockGlobal(t, 'WebTransport', class {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(BridgeClient.prototype, 'connect', async function () { this.connected = true; });
  t.mock.method(BridgeClient.prototype, 'disconnect', function () { this.connected = false; });

  const health = {
    bridgeProtocol: 'bcds-v1', webTransportBridge: true,
    httpPort: 33446, wtPort: 33445, fingerprint: FP_A1, localAddress: '127.0.0.1',
  };
  // `enrollmentStatus` stands in for the origin-admission gate: an unadmitted
  // page gets 403 here exactly as it does on /health, and enrollment never
  // relaxes that — it only decides whether a pin can survive a rotation.
  for (const [enrollmentStatus, body, expected] of [
    [200, ATTEST_A1, { bridgeId: BRIDGE_A.bridgeId, publicKey: BRIDGE_A.publicKey }],
    [403, null, undefined],
    [404, null, undefined],
    // Signed by the right bridge, but for some other lifecycle's certificate.
    [200, ATTEST_A2, undefined],
  ]) {
    storage.map.clear();
    mockGlobal(t, 'fetch', async (url) => {
      if (String(url).endsWith('/enrollment')) {
        return { ok: enrollmentStatus === 200, status: enrollmentStatus, json: async () => body };
      }
      if (String(url).endsWith('/health')) return { ok: true, json: async () => health };
      throw new Error('unexpected probe');
    });
    const controller = initMulticastBridge({ autoStart: false });
    try {
      controller.start();
      await waitFor(
        () => readBridgeDiscoveryCache(33446, Date.now(), storage)?.status === 'found',
        `a cached bridge for /enrollment ${enrollmentStatus}`,
      );
      const cached = readBridgeDiscoveryCache(33446, Date.now(), storage).bridge;
      assert.equal(cached.fingerprint, FP_A1);
      assert.deepEqual(cached.enrollment, expected, `/enrollment ${enrollmentStatus}`);
    } finally {
      controller.stop();
    }
  }
});

test('a certificate rotation keeps the cached bridge when the pinned key re-proves it', async () => {
  const storage = memoryStorage();
  assert.equal(writeBridgeDiscoveryCache(33446, cachedBridge(), { storage }), true);

  const cached = readBridgeDiscoveryCache(33446, Date.now(), storage);
  assert.equal(cached.status, 'found');
  assert.equal(cached.bridge.fingerprint, FP_A1);
  assert.deepEqual(cached.bridge.enrollment, {
    bridgeId: BRIDGE_A.bridgeId,
    publicKey: BRIDGE_A.publicKey,
  });

  // The bridge restarted: new certificate, same enrollment key.
  const rotated = await rotateCachedBridgeFingerprint(cached.bridge, ATTEST_A2, { now: NOW_MS });
  assert.equal(rotated.fingerprint, FP_A2);
  assert.deepEqual(rotated.enrollment, cached.bridge.enrollment);
  assert.equal(rotated.host, cached.bridge.host);
  assert.equal(rotated.wtPort, cached.bridge.wtPort);

  assert.equal(writeBridgeDiscoveryCache(33446, rotated, { storage }), true);
  const reread = readBridgeDiscoveryCache(33446, Date.now(), storage);
  assert.equal(reread.status, 'found');
  assert.equal(reread.bridge.fingerprint, FP_A2, 'the entry survived the rotation');
  assert.deepEqual(reread.bridge.enrollment, cached.bridge.enrollment);
});

// BLO-34184 review follow-up (Ally, 5228677383). The rotation recursion re-enters
// `tryConnectOnce` with a seeded bridge, which skips `discoverBridgeCoordinated`
// and therefore its `fromCache` flag. That branch is reachable ONLY behind
// `if (fromCache && ...)`, so leaving the flag unthreaded under-reported the one
// case `servedFromCache` exists to catch: a load the discovery cache served and
// that merely needed re-pinning was counted as a fresh discovery.
test('a re-pinned cached bridge is still reported as cache-served', async (t) => {
  const store = makeStore();
  assert.ok(writeBridgeDiscoveryCache(33446, cachedBridge({
    host: '192.168.1.9',
    discoveryMethod: 'desktop-lan',
  }), { storage: store }));

  // The bridge restarted: the pinned certificate is gone, so the first connect
  // fails and /enrollment re-proves the same identity on a new fingerprint.
  mockGlobal(t, 'fetch', async (url) => {
    if (!String(url).endsWith('/enrollment')) throw new Error('unexpected fetch');
    return { ok: true, status: 200, json: async () => ATTEST_A2 };
  });

  await withStubbedBridge(t, { store }, async ({ controller, windowScope, connects }) => {
    const succeedingConnect = BridgeClient.prototype.connect;
    BridgeClient.prototype.connect = async function stubConnect(host, httpPort, options) {
      if (connects.length === 0) {
        connects.push({ host, httpPort, options });
        throw new Error('quic handshake failed: stale pin');
      }
      return succeedingConnect.call(this, host, httpPort, options);
    };

    const details = [];
    windowScope.addEventListener('multicast-bridge-ready', (event) => details.push(event.detail));
    controller.start();
    await waitFor(() => details.length > 0, 'the rotated pin to connect');

    assert.equal(connects.length, 2, 'the rotation must drive a second connect');
    assert.equal(connects[0].options.fingerprint, FP_A1, 'first pass offered the stale pin');
    assert.equal(connects[1].options.fingerprint, FP_A2, 'second pass offered the rotated pin');
    assert.equal(details[0].rung, 'desktop-lan', 'the originating rung still survives');
    assert.equal(details[0].servedFromCache, true, 'and the cache is still credited');
  });
});

// BLO-42173 (Ally review 5474231550). A cache hit probes nothing, so a consumer
// reading `discovery ok:true` as "the endpoint answered" tells a viewer who has
// since stopped the bridge that it is installed and unresponsive, and withholds
// the install step. The flag is what lets the consumer tell the two apart.
test('a cache-served discovery says so on the status event', async (t) => {
  const store = makeStore();
  assert.ok(writeBridgeDiscoveryCache(33446, cachedBridge({ host: '127.0.0.1' }), { storage: store }));

  const events = [];
  await withStubbedBridge(t, { store, init: { onStatus: (e) => events.push(e) } },
      async ({ controller }) => {
        controller.start();
        await waitFor(() => events.some((e) => e.phase === 'discovery' && e.ok),
            'a discovery hit served from the cache');
        assert.equal(events.find((e) => e.phase === 'discovery' && e.ok).fromCache, true);
      });
});

test('a different bridge id never inherits the previous pin', async () => {
  const pinned = cachedBridge();
  // A revocation mints a fresh identity, so the page sees a new bridge_id.
  assert.equal(await rotateCachedBridgeFingerprint(pinned, ATTEST_B, { now: NOW_MS }), null);
  assert.equal(await rotateCachedBridgeFingerprint(pinned, ATTEST_A1_EXPIRED, { now: NOW_MS }), null);
  assert.equal(await rotateCachedBridgeFingerprint(pinned, ATTEST_ID_SUBSTITUTED, { now: NOW_MS }), null);
  // No pin at all cannot be rotated into one.
  assert.equal(
    await rotateCachedBridgeFingerprint(cachedBridge({ enrollment: undefined }), ATTEST_A2, { now: NOW_MS }),
    null,
  );
  // Poisoned storage: a bridge id that disagrees with its own pinned key.
  assert.equal(
    await rotateCachedBridgeFingerprint(
      cachedBridge({ enrollment: { bridgeId: BRIDGE_B.bridgeId, publicKey: BRIDGE_A.publicKey } }),
      ATTEST_A2,
      { now: NOW_MS },
    ),
    null,
  );
});

test('a malformed cached enrollment is dropped without losing the fingerprint pin', () => {
  const storage = memoryStorage();
  for (const enrollment of [
    { bridgeId: BRIDGE_A.bridgeId },
    { bridgeId: BRIDGE_A.bridgeId, publicKey: 'zz'.repeat(65) },
    { bridgeId: BRIDGE_A.bridgeId.slice(0, 62), publicKey: BRIDGE_A.publicKey },
    'not-an-object',
  ]) {
    assert.equal(writeBridgeDiscoveryCache(33446, cachedBridge({ enrollment }), { storage }), true);
    const entry = readBridgeDiscoveryCache(33446, Date.now(), storage);
    assert.equal(entry.status, 'found');
    assert.equal(entry.bridge.fingerprint, FP_A1);
    assert.equal(entry.bridge.enrollment, undefined, JSON.stringify(enrollment));
  }
});

test('a rotated certificate reconnects the cached bridge instead of burning the cache TTL', async (t) => {
  const storage = memoryStorage();
  const { windowScope } = makeWindowEventHarness();
  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', storage);
  mockGlobal(t, 'WebTransport', class {});
  t.mock.method(console, 'warn', () => {});
  writeBridgeDiscoveryCache(33446, cachedBridge({ host: '127.0.0.1' }), { storage });

  const origins = [];
  mockGlobal(t, 'fetch', async (url) => {
    origins.push(String(url));
    return { ok: true, json: async () => ATTEST_A2 };
  });
  // The stale pin fails the handshake exactly as a real restart would.
  const connectMock = t.mock.method(BridgeClient.prototype, 'connect', async function (host, port, opts) {
    if (opts.fingerprint === FP_A1) throw new Error('certificate hash mismatch');
    this.connected = true;
  });
  t.mock.method(BridgeClient.prototype, 'disconnect', function () { this.connected = false; });

  const controller = initMulticastBridge({ autoStart: false });
  try {
    controller.start();
    await waitFor(() => connectMock.mock.callCount() === 2, 'the rotated reconnect');
    assert.equal(connectMock.mock.calls[0].arguments[2].fingerprint, FP_A1);
    assert.equal(connectMock.mock.calls[1].arguments[2].fingerprint, FP_A2);
    assert.deepEqual(origins, ['http://127.0.0.1:33446/enrollment']);
    assert.equal(windowScope.multicast?.__blockcastBridgePolyfill, true);
    // The rotation is written back, so a sibling tab skips the dead pin too.
    assert.equal(readBridgeDiscoveryCache(33446, Date.now(), storage).bridge.fingerprint, FP_A2);
  } finally {
    controller.stop();
  }
});

test('an unreachable /enrollment leaves the cached pin unconfirmed, not condemned', async (t) => {
  const storage = memoryStorage();
  const { windowScope } = makeWindowEventHarness();
  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', storage);
  mockGlobal(t, 'WebTransport', class {});
  t.mock.method(console, 'warn', () => {});
  writeBridgeDiscoveryCache(33446, cachedBridge({ host: '127.0.0.1' }), { storage });

  // A blip, not a verdict: the bridge never got to say whether it still holds
  // the pinned key. Contrast the two tests below, where it does answer and the
  // entry is rightly dropped.
  let probes = 0;
  mockGlobal(t, 'fetch', async () => {
    probes += 1;
    throw new TypeError('Failed to fetch');
  });
  t.mock.method(BridgeClient.prototype, 'connect', async () => {
    throw new Error('certificate hash mismatch');
  });
  t.mock.method(BridgeClient.prototype, 'disconnect', function () { this.connected = false; });

  const controller = initMulticastBridge({ autoStart: false });
  try {
    controller.start();
    await waitFor(() => probes >= 1, 'the enrollment re-probe');
    // The clear decision is two awaits past the rejection, so settle before
    // asserting its absence rather than racing it.
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(
      readBridgeDiscoveryCache(33446, Date.now(), storage),
      'a transport failure must not cost an enrolled bridge its cache entry',
    );
  } finally {
    controller.stop();
  }
});

test('a re-proof on the SAME certificate keeps the pin, it does not condemn it', async (t) => {
  const storage = memoryStorage();
  const { windowScope } = makeWindowEventHarness();
  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', storage);
  mockGlobal(t, 'WebTransport', class {});
  t.mock.method(console, 'warn', () => {});
  writeBridgeDiscoveryCache(33446, cachedBridge({ host: '127.0.0.1' }), { storage });

  // /enrollment is on httpPort, the handshake is on wtPort, and the connect
  // catch is broad — so the bridge can prove with the PINNED key that it is on
  // the PINNED certificate while the WT listener is still coming up. That is a
  // positive confirmation, and must not be read as a failure to re-prove.
  let probes = 0;
  mockGlobal(t, 'fetch', async () => {
    probes += 1;
    return { ok: true, json: async () => ATTEST_A1 };
  });
  const connectMock = t.mock.method(BridgeClient.prototype, 'connect', async () => {
    throw new Error('WebTransport handshake failed');
  });
  t.mock.method(BridgeClient.prototype, 'disconnect', function () { this.connected = false; });

  const controller = initMulticastBridge({ autoStart: false });
  try {
    controller.start();
    await waitFor(() => probes >= 1, 'the enrollment re-probe');
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(
      readBridgeDiscoveryCache(33446, Date.now(), storage)?.bridge.fingerprint,
      FP_A1,
      'a cryptographic confirmation of the pin must not delete the pin',
    );
    // Nothing rotated, so there is no second pin worth an immediate redial.
    assert.equal(connectMock.mock.callCount(), 1);
  } finally {
    controller.stop();
  }
});

test('a served non-OK /enrollment is an answer, so it does condemn the pin', async (t) => {
  const storage = memoryStorage();
  const { windowScope } = makeWindowEventHarness();
  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', storage);
  mockGlobal(t, 'WebTransport', class {});
  t.mock.method(console, 'warn', () => {});
  writeBridgeDiscoveryCache(33446, cachedBridge({ host: '127.0.0.1' }), { storage });

  // 403 (origin no longer admitted) or 404 (enrollment revoked outright): the
  // bridge replied, and the reply cannot re-prove the pin.
  mockGlobal(t, 'fetch', async () => ({ ok: false, status: 403 }));
  t.mock.method(BridgeClient.prototype, 'connect', async () => {
    throw new Error('certificate hash mismatch');
  });
  t.mock.method(BridgeClient.prototype, 'disconnect', function () { this.connected = false; });

  const controller = initMulticastBridge({ autoStart: false });
  try {
    controller.start();
    await waitFor(
      () => readBridgeDiscoveryCache(33446, Date.now(), storage) === null,
      'the answered-and-unprovable pin to be dropped',
    );
  } finally {
    controller.stop();
  }
});

test('a bridge that can no longer prove its pin loses the cache entry', async (t) => {
  const storage = memoryStorage();
  const { windowScope } = makeWindowEventHarness();
  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', storage);
  mockGlobal(t, 'WebTransport', class {});
  t.mock.method(console, 'warn', () => {});
  writeBridgeDiscoveryCache(33446, cachedBridge({ host: '127.0.0.1' }), { storage });

  // Post-revocation the bridge attests a brand new identity.
  mockGlobal(t, 'fetch', async () => ({ ok: true, json: async () => ATTEST_B }));
  const connectMock = t.mock.method(BridgeClient.prototype, 'connect', async () => {
    throw new Error('certificate hash mismatch');
  });
  t.mock.method(BridgeClient.prototype, 'disconnect', function () { this.connected = false; });

  const controller = initMulticastBridge({ autoStart: false });
  try {
    controller.start();
    await waitFor(
      () => readBridgeDiscoveryCache(33446, Date.now(), storage) === null,
      'the unprovable pin to be dropped',
    );
    assert.equal(connectMock.mock.callCount(), 1, 'the old pin is not retried against a new bridge id');
    assert.equal(windowScope.multicast, undefined);
  } finally {
    controller.stop();
  }

});

// subscribe() is a demand for the bridge. A session that closed while the
// client held no subscriptions leaves connected=false with the connect
// arguments intact and nothing scheduled (measured on Chrome iOS and desktop
// Chrome against a Beacon bridge, 2026-09-16), and the next subscribe used to
// fail closed with "Not connected to bridge" although the bridge was reachable.
function closedSessionClient() {
  const client = new BridgeClient();
  client._lastConnectArgs = {
    host: '127.0.0.1',
    httpPort: 33446,
    options: { fingerprint: 'ab'.repeat(32), wtPort: 33445 },
  };
  client.connected = false;
  client._manualDisconnect = false;
  const connectCalls = [];
  client.connect = async (host, httpPort, options) => {
    connectCalls.push({ host, httpPort, options });
    client.connected = true;
    client._transport = 'webtransport';
  };
  const subscribeRequests = [];
  client._sendSubscribeRequest = async (entry) => {
    subscribeRequests.push(entry);
    return { subscriptionId: 'sub-1', transport: 'amt' };
  };
  return { client, connectCalls, subscribeRequests };
}

test('subscribe() on a closed session reconnects with the last connect arguments first', async () => {
  const { client, connectCalls, subscribeRequests } = closedSessionClient();
  const handle = await client.subscribe('232.1.1.61', 8000, '69.25.95.192', { mode: 'tunnel', amtRelay: 'relay.test' });
  assert.deepEqual(connectCalls, [{
    host: '127.0.0.1',
    httpPort: 33446,
    options: { fingerprint: 'ab'.repeat(32), wtPort: 33445 },
  }]);
  assert.equal(subscribeRequests.length, 1, 'the subscribe request is sent only after the session is back');
  assert.equal(handle.subscriptionId, 'sub-1');
  assert.equal(handle.transport, 'amt');
  assert.ok(client.activeSubscriptions.has('sub-1'));
  assert.equal(client._reconnectPromise, null);
});

test('subscribe() supersedes a pending reconnect backoff timer instead of waiting for it', async (t) => {
  const { client, connectCalls } = closedSessionClient();
  let backoffFired = 0;
  client._reconnectTimer = setTimeout(() => { backoffFired++; }, 60_000);
  t.after(() => { if (client._reconnectTimer) clearTimeout(client._reconnectTimer); });
  await client.subscribe('232.1.1.61', 8000, '69.25.95.192', { mode: 'tunnel', amtRelay: 'relay.test' });
  assert.equal(client._reconnectTimer, null);
  assert.equal(connectCalls.length, 1);
  assert.equal(backoffFired, 0);
});

test('subscribe() joins an in-flight reconnect rather than opening a second session', async () => {
  const { client, connectCalls, subscribeRequests } = closedSessionClient();
  let finishReconnect;
  client._reconnectPromise = new Promise((resolve) => { finishReconnect = resolve; });
  const pending = client.subscribe('232.1.1.61', 8000, '69.25.95.192', { mode: 'tunnel', amtRelay: 'relay.test' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subscribeRequests.length, 0, 'nothing is sent while the reconnect is in flight');
  client.connected = true;
  client._transport = 'webtransport';
  finishReconnect();
  const handle = await pending;
  assert.equal(handle.subscriptionId, 'sub-1');
  assert.equal(connectCalls.length, 0, 'the in-flight attempt is joined, not duplicated');
});

test('subscribe() after an intentional disconnect stays refused: teardown is not a lost session', async () => {
  const { client, connectCalls } = closedSessionClient();
  client._manualDisconnect = true;
  await assert.rejects(
    client.subscribe('232.1.1.61', 8000, '69.25.95.192', { mode: 'tunnel', amtRelay: 'relay.test' }),
    /Not connected to bridge/,
  );
  assert.equal(connectCalls.length, 0);
});

test('subscribe() on a client that never connected is refused without a reconnect attempt', async () => {
  const { client, connectCalls } = closedSessionClient();
  client._lastConnectArgs = null;
  await assert.rejects(
    client.subscribe('232.1.1.61', 8000, '69.25.95.192', { mode: 'tunnel', amtRelay: 'relay.test' }),
    /Not connected to bridge/,
  );
  assert.equal(connectCalls.length, 0);
});

test('subscribe() propagates a failed on-demand reconnect and stays fail-closed', async () => {
  const { client, connectCalls, subscribeRequests } = closedSessionClient();
  client.connect = async (...args) => {
    connectCalls.push(args);
    throw new Error('All WebTransport candidates failed: certificate mismatch');
  };
  await assert.rejects(
    client.subscribe('232.1.1.61', 8000, '69.25.95.192', { mode: 'tunnel', amtRelay: 'relay.test' }),
    /All WebTransport candidates failed/,
  );
  assert.equal(connectCalls.length, 1);
  assert.equal(subscribeRequests.length, 0);
  assert.equal(client._reconnectPromise, null);
});

// The on-demand path is a second writer to the reconnect state machine. These
// three pin what the six tests above cannot see (they run with no desired
// subscriptions and stub connect() wholesale): a failure must re-arm the
// backoff it superseded, a disconnect during the attempt must not be
// swallowed, and a client that holds nothing must not start retrying.
function heldSubscription(client) {
  client._desiredSubscriptions.set('232.1.1.60:8000:69.25.95.192', {
    group: '232.1.1.60', port: 8000, source: '69.25.95.192', transportOpts: {},
  });
}

test('a failed on-demand reconnect re-arms the backoff for subscriptions the client already holds', async (t) => {
  const { client, connectCalls } = closedSessionClient();
  t.after(() => { if (client._reconnectTimer) clearTimeout(client._reconnectTimer); });
  // The session dropped while a subscription was held, so _handleDisconnect
  // armed a backoff; the demand supersedes that timer and then fails.
  heldSubscription(client);
  let supersededBackoffFired = 0;
  client._reconnectTimer = setTimeout(() => { supersededBackoffFired++; }, 5);
  client._reconnectAttempts = 2;
  client.connect = async (...args) => {
    connectCalls.push(args);
    throw new Error('All WebTransport candidates failed: bridge unreachable');
  };
  await assert.rejects(
    client.subscribe('232.1.1.61', 8000, '69.25.95.192', { mode: 'tunnel', amtRelay: 'relay.test' }),
    /All WebTransport candidates failed/,
  );
  assert.equal(connectCalls.length, 1);
  assert.ok(client._reconnectTimer, 'the backoff this attempt superseded is armed again');
  assert.equal(client._reconnectAttempts, 3, 'the failure advances the backoff like a timer-path failure');
  assert.equal(client._reconnectPromise, null);
  assert.equal(client._reconnectAfterCurrent, false);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(supersededBackoffFired, 0, 'the superseded timer itself never fires');
});

test('a disconnect during the on-demand attempt is re-armed, not swallowed', async (t) => {
  const { client, connectCalls } = closedSessionClient();
  t.after(() => { if (client._reconnectTimer) clearTimeout(client._reconnectTimer); });
  heldSubscription(client);
  client.connect = async (...args) => {
    connectCalls.push(args);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The fresh session drops while subscriptions are replayed:
    // _handleDisconnect reaches _scheduleReconnect while this attempt still
    // owns _reconnectPromise, so the request is deferred onto the attempt.
    client._scheduleReconnect();
    assert.equal(client._reconnectAfterCurrent, true, 'precondition: the reconnect was deferred, not armed');
    assert.equal(client._reconnectTimer, null, 'precondition: no timer while the attempt is in flight');
    client.connected = false;
  };
  await assert.rejects(
    client.subscribe('232.1.1.61', 8000, '69.25.95.192', { mode: 'tunnel', amtRelay: 'relay.test' }),
    /Not connected to bridge/,
  );
  assert.equal(connectCalls.length, 1);
  assert.equal(client._reconnectAfterCurrent, false, 'the deferred reconnect is drained by the attempt epilogue');
  assert.ok(client._reconnectTimer, 'and armed as a backoff timer');
  assert.equal(client._reconnectPromise, null);
});

test('a failed on-demand reconnect with no held subscriptions starts no background retry loop', async () => {
  const { client, connectCalls } = closedSessionClient();
  client.connect = async (...args) => {
    connectCalls.push(args);
    throw new Error('All WebTransport candidates failed: bridge unreachable');
  };
  await assert.rejects(
    client.subscribe('232.1.1.61', 8000, '69.25.95.192', { mode: 'tunnel', amtRelay: 'relay.test' }),
    /All WebTransport candidates failed/,
  );
  assert.equal(connectCalls.length, 1);
  assert.equal(client._reconnectTimer, null, 'a disconnect with no desired subscriptions never auto-reconnected; a refused demand does not change that');
  assert.equal(client._reconnectAttempts, 0);
  assert.equal(client._reconnectAfterCurrent, false);
});

test('a stale client reporting a second disconnect leaves the replacement surface installed', async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  // Discovery backoff only has to elapse, not be measured.
  mockGlobal(t, 'setTimeout', (fn, ms, ...args) => realSetTimeout(fn, ms >= 500 ? 5 : ms, ...args));
  const settle = () => new Promise((resolve) => realSetTimeout(resolve, 5));
  await withStubbedBridge(
    t,
    { hash: `#mc_bridge=127.0.0.1&fp=${HASH_A}&wt_port=34000` },
    async ({ controller, windowScope, clients }) => {
      controller.start();
      for (let i = 0; i < 50 && !windowScope.multicast; i++) await settle();
      const clientA = clients[0];
      const surfaceA = windowScope.multicast;
      assert.ok(surfaceA, 'client A installs its surface');
      clientA._handleDisconnect();
      assert.equal(windowScope.multicast, undefined, 'its drop removes the surface and rediscovers');
      for (let i = 0; i < 100 && !windowScope.multicast; i++) await settle();
      const surfaceB = windowScope.multicast;
      assert.ok(surfaceB && surfaceB !== surfaceA, 'client B installs a replacement surface');

      // Client A is reconnected after the page abandoned it (a re-armed
      // backoff, or an on-demand subscribe through a retained surface A),
      // and that session closes too.
      clientA.connected = true;
      clientA._handleDisconnect();
      await new Promise((resolve) => realSetTimeout(resolve, 60));
      assert.equal(windowScope.multicast, surfaceB, 'a stale client must not remove the replacement surface');
      assert.equal(clients.length, 2, 'nor restart discovery');
    },
  );
});

for (const target of ['an unrelated group', 'the same endpoint']) {
  test(`a subscribe to ${target} right after an awaited release survives the replacement backstop`, async (t) => {
    const harness = makeBcdsServerClient(t);
    const client = harness.client;
    const first = await client.subscribe('239.21.4.1', 8000, undefined, { packetIds: [1] });
    // A genuine unpredicted replacement: the same endpoint, sent before the
    // release, so the backstop must retire the session.
    const replacement = client.subscribe('239.21.4.1', 8000, undefined, { packetIds: [2] });
    await first.unsubscribe();
    const group = target === 'an unrelated group' ? '239.21.4.2' : '239.21.4.1';
    const next = client.subscribe(group, 8000, undefined, { packetIds: [3] });
    const [nextOutcome, replacementOutcome] = await Promise.allSettled([next, replacement]);
    assert.equal(nextOutcome.status, 'fulfilled', nextOutcome.reason?.message);
    assert.equal(replacementOutcome.status, 'fulfilled', replacementOutcome.reason?.message);
  });
}
// BLO-35664. Chromium validates `RequestInit.targetAddressSpace` against an
// enum whose members change by release, and a value outside it makes `fetch()`
// reject with a TypeError before anything is sent. A declaration naming a
// different space than the one the host resolves to is a network error. Both
// rules were measured on a public HTTPS page probing a loopback /health in
// Chrome for Testing 125.0.6422.141 and Chromium 151.0.7922.34; this model maps
// each release's spellings to the space they declare.
const CHROMIUM_TARGET_ADDRESS_SPACES = Object.freeze({
  // Through M138, Private Network Access: "local" is loopback; no "loopback".
  pna: Object.freeze({ local: 'loopback', private: 'lan', public: 'public', unknown: null }),
  // M139+, Local Network Access: "local" is the LAN; "private" is its alias.
  lna: Object.freeze({ loopback: 'loopback', local: 'lan', private: 'lan', public: 'public', unknown: null }),
  // Not a shipped release: LNA after its deprecated "private" alias is
  // removed. It pins that the LAN spelling is feature-detected too.
  lnaWithoutPrivateAlias: Object.freeze({ loopback: 'loopback', local: 'lan', public: 'public', unknown: null }),
});

function installChromiumFetch(t, era, { resolveSpace, respond }) {
  const spaces = CHROMIUM_TARGET_ADDRESS_SPACES[era];
  // Requests built only to ask the enum a question; fetch() never builds one.
  const probes = [];
  class ChromiumRequest {
    constructor(input, init = {}) {
      if (input === 'about:blank') probes.push(init.targetAddressSpace);
      const value = init.targetAddressSpace;
      if (value !== undefined && !Object.hasOwn(spaces, value)) {
        throw new TypeError(
          "Failed to read the 'targetAddressSpace' property from 'RequestInit': " +
          `The provided value '${value}' is not a valid enum value of type IPAddressSpace.`,
        );
      }
      this.url = String(input);
    }
  }
  const sent = [];
  mockGlobal(t, 'Request', ChromiumRequest);
  mockGlobal(t, 'fetch', async (input, init = {}) => {
    // fetch() converts its init through the same constructor, so an unknown
    // spelling rejects here and never reaches the network (or `sent`).
    const request = new ChromiumRequest(input, init);
    const url = new URL(request.url);
    sent.push({ url: request.url, targetAddressSpace: init.targetAddressSpace });
    const declared = init.targetAddressSpace === undefined ? null : spaces[init.targetAddressSpace];
    if (declared && declared !== resolveSpace(url.hostname)) throw new TypeError('Failed to fetch');
    return respond(url);
  });
  return { sent, probes };
}

function isLoopbackTestHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function bcdsHealth(extra = {}) {
  return {
    bridgeProtocol: 'bcds-v1', webTransportBridge: true,
    httpPort: 33446, wtPort: 33445, fingerprint: FP_A1, localAddress: '127.0.0.1',
    ...extra,
  };
}

function jsonResponse(body) {
  return body === null
    ? { ok: false, status: 404, json: async () => null, text: async () => '' }
    : { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

// The first `discovery` status is the outcome of one full unpinned ladder.
async function firstUnpinnedDiscovery(t, storage) {
  const { windowScope } = makeWindowEventHarness();
  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', storage);
  mockGlobal(t, 'WebTransport', class {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(BridgeClient.prototype, 'connect', async function () { this.connected = true; });
  t.mock.method(BridgeClient.prototype, 'disconnect', function () { this.connected = false; });

  let controller;
  const discovered = new Promise((resolve) => {
    controller = initMulticastBridge({
      autoStart: false,
      onStatus: (event) => { if (event.phase === 'discovery') resolve(event); },
    });
  });
  try {
    controller.start();
    return await discovered;
  } finally {
    controller.stop();
  }
}

test('unpinned loopback discovery reaches the bridge on Chromium releases without a "loopback" address space (BLO-35664)', async (t) => {
  const { sent } = installChromiumFetch(t, 'pna', {
    resolveSpace: (hostname) => (isLoopbackTestHost(hostname) ? 'loopback' : 'public'),
    respond: (url) => jsonResponse(
      isLoopbackTestHost(url.hostname) && url.pathname === '/health' ? bcdsHealth() : null,
    ),
  });

  const discovery = await firstUnpinnedDiscovery(t, memoryStorage());

  assert.equal(discovery.ok, true, 'a running loopback bridge must be found without the pinned handoff');
  assert.equal(discovery.bridge.host, 'localhost');
  assert.equal(discovery.bridge.discoveryMethod, 'health');
  assert.equal(discovery.bridge.fingerprint, FP_A1);
  assert.equal(discovery.bridge.wtPort, 33445);
  const probe = sent.find(({ url }) => url === 'http://localhost:33446/health');
  assert.ok(probe, 'the loopback /health probe must actually be sent');
  assert.equal(
    probe.targetAddressSpace,
    undefined,
    'no spelling of loopback is safe here: "loopback" is not in the enum and "local" means the LAN from M139',
  );
});

test('loopback probes keep naming the loopback space where the browser defines it', async (t) => {
  const { sent } = installChromiumFetch(t, 'lna', {
    resolveSpace: (hostname) => (isLoopbackTestHost(hostname) ? 'loopback' : 'public'),
    respond: (url) => jsonResponse(
      isLoopbackTestHost(url.hostname) && url.pathname === '/health' ? bcdsHealth() : null,
    ),
  });

  const discovery = await firstUnpinnedDiscovery(t, memoryStorage());

  assert.equal(discovery.ok, true);
  assert.equal(discovery.bridge.host, 'localhost');
  const probe = sent.find(({ url }) => url === 'http://localhost:33446/health');
  assert.equal(probe?.targetAddressSpace, 'loopback');
});

test('the AutoTLS probe names the LAN wherever the enum defines "private"', async (t) => {
  const gatewayDomain = 'gw-saved.tenant.bcast.id';
  const autoTlsHost = `192-168-1-20.${gatewayDomain}`;
  for (const [era, expectedHint] of [
    ['pna', 'private'],
    ['lna', 'private'],
    // Without the alias there is no spelling the AutoTLS probe can rely on, so
    // it goes unhinted rather than throwing before the request is sent.
    ['lnaWithoutPrivateAlias', undefined],
  ]) {
    await t.test(era, async (st) => {
      const storage = memoryStorage();
      mockGlobal(st, 'localStorage', storage);
      saveGateway(gatewayDomain, '192.168.1.20', FP_A1);
      const { sent } = installChromiumFetch(st, era, {
        resolveSpace: (hostname) => (
          isLoopbackTestHost(hostname) ? 'loopback' : hostname === autoTlsHost ? 'lan' : 'public'
        ),
        // Only the AutoTLS endpoint answers, so a rejected AutoTLS probe
        // cannot be rescued by the loopback rungs below it.
        respond: (url) => jsonResponse(
          url.hostname === autoTlsHost && url.pathname === '/health'
            ? bcdsHealth({ gatewayDomain, localAddress: '192.168.1.20' })
            : null,
        ),
      });

      const discovery = await firstUnpinnedDiscovery(st, storage);

      assert.equal(discovery.ok, true, `${era}: the saved AutoTLS gateway must still be discovered`);
      assert.equal(discovery.bridge.discoveryMethod, 'autotls');
      assert.equal(discovery.bridge.host, autoTlsHost);
      const probe = sent.find(({ url }) => url === `https://${autoTlsHost}:33446/health`);
      assert.ok(probe, `${era}: the AutoTLS probe must actually be sent`);
      assert.equal(probe.targetAddressSpace, expectedHint, `${era}: "private" is the LAN spelling wherever the enum defines it`);
    });
  }
});

test('the address-space enum is asked once per spelling, not once per probed host', async (t) => {
  const { sent, probes } = installChromiumFetch(t, 'lna', {
    resolveSpace: (hostname) => (isLoopbackTestHost(hostname) ? 'loopback' : 'public'),
    // Nothing answers, so the ladder walks every loopback candidate.
    respond: () => jsonResponse(null),
  });

  const discovery = await firstUnpinnedDiscovery(t, memoryStorage());

  assert.equal(discovery.ok, false);
  const loopbackProbes = sent.filter(({ url }) => isLoopbackTestHost(new URL(url).hostname));
  assert.ok(loopbackProbes.length >= 2, `expected several loopback probes, saw ${loopbackProbes.length}`);
  for (const probe of loopbackProbes) assert.equal(probe.targetAddressSpace, 'loopback', probe.url);
  assert.deepEqual(probes, ['loopback'], 'the answer cannot change within a page, so it is computed once');
});

test('a LAN probe names the LAN only where the enum still defines "private"', async (t) => {
  for (const [era, expectedHint] of [['pna', 'private'], ['lna', 'private'], ['lnaWithoutPrivateAlias', undefined]]) {
    await t.test(era, async (st) => {
      const { sent } = installChromiumFetch(st, era, {
        resolveSpace: (hostname) => (hostname === '192.168.1.244' ? 'lan' : 'public'),
        respond: (url) => jsonResponse(
          url.pathname === '/health'
            ? bcdsHealth({ fingerprint: 'ef'.repeat(32), localAddress: '192.168.1.244' })
            : null,
        ),
      });

      const bridge = await tryDesktopLanDiscovery(33446, {
        force: true,
        prefixes: ['192.168.1'],
        hosts: ['192.168.1.244'],
        batchSize: 1,
        timeoutMs: 100,
      });

      assert.equal(bridge?.host, '192.168.1.244', `${era}: the LAN bridge must still be found`);
      assert.equal(sent[0]?.targetAddressSpace, expectedHint);
    });
  }
});

// BLO-43633. On a loopback-served desktop page `ipv4LanPrefix` has nothing to
// infer, so the sweep falls back to two blind /24s: 2 x 254 probes at a 700 ms
// timeout with no early exit, and nothing answers, so it pays all 11.2 s —
// in front of first play, on exactly the deployment where the bridge is most
// likely to be loopback or mDNS anyway.
function installLoopbackDesktopPage(t, { storage = new Map(), onFetch, search = '' } = {}) {
  const { windowScope, listeners } = makeWindowEventHarness({
    href: `http://localhost:8080/players/shaka-msf.html${search}`,
    origin: 'http://localhost:8080',
    protocol: 'http:',
    hostname: 'localhost',
    search,
  });
  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  });
  mockGlobal(t, 'WebTransport', class {});
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', onFetch);
  return { windowScope, listeners };
}

const settle = async (turns = 4) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('the blind LAN sweep never runs in front of bridge discovery (BLO-43633)', async (t) => {
  const lanProbes = [];
  const { windowScope } = installLoopbackDesktopPage(t, {
    onFetch: async (url) => {
      // Every LAN probe runs to the full timeout and never answers — the exact
      // shape of a desktop page with no bridge on 192.168.0/1.0/24.
      if (String(url).startsWith('http://192.168.')) {
        lanProbes.push(String(url));
        return new Promise(() => {});
      }
      throw new Error('no bridge here');
    },
  });

  const statuses = [];
  const controller = initMulticastBridge({ autoStart: false, onStatus: (event) => statuses.push(event) });
  try {
    controller.start();
    await settle();

    // Discovery must reach its verdict without a single probe on the wire. On
    // `main` the sweep sits inside the ladder, so these probes are issued and
    // the `discovery` status never arrives at all.
    assert.deepEqual(lanProbes, [], 'no LAN probe may be issued before the page has loaded');
    assert.deepEqual(
      statuses.map(({ phase, ok, reason }) => ({ phase, ok, reason })),
      [{ phase: 'discovery', ok: false, reason: 'miss' }],
    );

    windowScope.dispatchEvent({ type: 'load' });
    await settle();
    assert.ok(lanProbes.length > 0, 'the sweep still runs, once the page has loaded');
    assert.ok(
      lanProbes.some((url) => url.startsWith('http://192.168.1.1:33446/health')),
      'the deferred sweep covers the default prefixes',
    );
  } finally {
    controller.stop();
  }
});

test('a bridge on a default LAN prefix is still discovered, after load (BLO-43633)', async (t) => {
  const { windowScope } = installLoopbackDesktopPage(t, {
    onFetch: async (url) => {
      if (String(url) === 'http://192.168.1.5:33446/health') {
        return jsonResponse(bcdsHealth({ fingerprint: FP_A1, localAddress: '192.168.1.5' }));
      }
      throw new Error('no bridge here');
    },
  });
  const connectMock = t.mock.method(BridgeClient.prototype, 'connect', async function () {
    this.connected = true;
  });
  t.mock.method(BridgeClient.prototype, 'disconnect', function () { this.connected = false; });

  const controller = initMulticastBridge({ autoStart: false });
  try {
    controller.start();
    await settle();
    assert.equal(connectMock.mock.callCount(), 0);

    windowScope.dispatchEvent({ type: 'load' });
    await settle(8);

    assert.equal(connectMock.mock.calls.at(-1)?.arguments[0], '192.168.1.5');
    const scope = bridgeDiscoveryScopeFromInputs({ search: '' });
    const cached = readBridgeDiscoveryCache(33446, Date.now(), undefined, scope);
    assert.equal(cached?.status, 'found');
    assert.equal(cached.bridge.host, '192.168.1.5');
  } finally {
    controller.stop();
  }
});

// The re-entry guard is about the ARMING, not the sweep: the discovery lock
// already makes a second concurrent sweep a no-op, so what is left to prevent
// is one `load` listener per missed poll — which would turn a single `load`
// into N sweeps the moment that lock lapses (its TTL is 7s, shorter than the
// 11.2s two-prefix sweep it would have to cover).
test('a second discovery miss before load does not arm a second sweep (BLO-43633)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { windowScope, listeners } = installLoopbackDesktopPage(t, {
    onFetch: async (url) => {
      if (String(url).startsWith('http://192.168.')) return new Promise(() => {});
      throw new Error('no bridge here');
    },
  });
  const armed = () => listeners.get('load')?.size ?? 0;

  const controller = initMulticastBridge({ autoStart: false });
  try {
    controller.start();
    await settle();
    assert.equal(armed(), 1);

    // Let the miss backoff fire a second discovery pass, still before `load`.
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(armed(), 1, 'one armed sweep, not one per missed poll');

    windowScope.dispatchEvent({ type: 'load' });
    await settle();
  } finally {
    controller.stop();
  }
});

// A supplied `?mc_bridge=` is configuration, not a discovery hint, so the
// ladder never swept for one. Deferring the sweep must not quietly give a
// pinned page a fallback to some other bridge on its LAN.
test('an explicit mc_bridge page never arms the deferred sweep (BLO-43633)', async (t) => {
  const lanProbes = [];
  const { windowScope } = installLoopbackDesktopPage(t, {
    search: '?mc_bridge=beacon.local',
    onFetch: async (url) => {
      if (String(url).startsWith('http://192.168.')) lanProbes.push(String(url));
      throw new Error('no bridge here');
    },
  });

  const controller = initMulticastBridge({ autoStart: false });
  try {
    controller.start();
    await settle();
    windowScope.dispatchEvent({ type: 'load' });
    await settle();
    assert.deepEqual(lanProbes, []);
  } finally {
    controller.stop();
  }
});
