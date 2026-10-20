import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BRIDGE_TRANSPORT_POLICIES,
  bridgeInstanceId,
  createBridgeBootstrap,
  probeBridgeCapabilities,
} from '../src/bridge-bootstrap.js';
import { BridgeClient, initMulticastBridge } from '../src/multicast-bridge.js';

function makeScope({ permissions = null, multicast = undefined, ...rest } = {}) {
  const listeners = new Map();
  return {
    isSecureContext: true,
    WebTransport: class {},
    location: { protocol: 'https:', search: '', hostname: 'player.example.test', origin: 'https://player.example.test' },
    navigator: permissions ? { permissions } : {},
    multicast,
    addEventListener(type, listener) {
      const entries = listeners.get(type) || new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
    ...rest,
  };
}

/** Controller stub standing in for initMulticastBridge. */
function fakeInit(controllers) {
  return (opts) => {
    const controller = {
      opts,
      started: false,
      stopped: false,
      start() { this.started = true; },
      stop() { this.stopped = true; },
      emit(event) { opts.onStatus?.(event); },
    };
    controllers.push(controller);
    return controller;
  };
}

function bootstrapWith(scope, overrides = {}) {
  const controllers = [];
  const statuses = [];
  const bootstrap = createBridgeBootstrap({
    scope,
    init: fakeInit(controllers),
    onStatus: (status) => statuses.push(status),
    ...overrides,
  });
  return { bootstrap, controllers, statuses };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** What the extension's own injector posts: same window, same origin. */
function extensionReady(scope) {
  return {
    type: 'message',
    source: scope,
    origin: scope.location?.origin,
    data: { source: 'multicast-extension', message: { type: 'extension_ready' } },
  };
}

test('a bridge instance is identified by endpoint plus certificate pin', () => {
  const base = { host: 'beacon.local', wtPort: 33445, fingerprint: 'ab'.repeat(32) };
  assert.equal(bridgeInstanceId(base), `beacon.local:33445#${'ab'.repeat(32)}`);
  // A restart mints a fresh certificate, so the pin is the restart signal.
  assert.notEqual(bridgeInstanceId({ ...base, fingerprint: 'cd'.repeat(32) }), bridgeInstanceId(base));
  // CA-authenticated AutoTLS carries no pin and identifies by endpoint.
  assert.equal(bridgeInstanceId({ host: 'relay.gw.example', wtPort: 443, fingerprint: '' }), 'relay.gw.example:443#ca');
  // An explicit native descriptor id wins when one exists.
  assert.equal(bridgeInstanceId({ ...base, instanceId: 'bridge-7' }), 'bridge-7');
  assert.equal(bridgeInstanceId(null), null);
});

test('capabilities are reported before any probe', async () => {
  const caps = await probeBridgeCapabilities(makeScope({
    permissions: { query: async ({ name }) => ({ state: name === 'local-network' ? 'granted' : 'prompt' }) },
  }));
  assert.equal(caps.webTransport, true);
  assert.equal(caps.secureContext, true);
  assert.equal(caps.localNetwork, 'granted');
  assert.equal(caps.loopbackNetwork, 'prompt');
  // Mixed-content viability differs by host class on an HTTPS page: the
  // loopback bootstrap is permission-gated, the LAN one is not viable at all.
  assert.equal(caps.loopbackHttpProbe, true);
  assert.equal(caps.lanHttpProbe, false);
  assert.equal(caps.extensionSurface, false);

  const insecure = await probeBridgeCapabilities(makeScope({
    isSecureContext: false,
    WebTransport: undefined,
    location: { protocol: 'http:', search: '' },
  }));
  assert.equal(insecure.webTransport, false);
  assert.equal(insecure.secureContext, false);
  assert.equal(insecure.lanHttpProbe, true);
  // An unimplemented permission name is unsupported, never a granted guess.
  assert.equal(insecure.localNetwork, 'unsupported');
});

test('a capability read never contradicts the scope discovery resolves against', async (t) => {
  // `initMulticastBridge` resolves `WebTransport` against the real global
  // scope. A page that passes its own scope object must not be told the
  // browser is unsupported while discovery would have run fine.
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'WebTransport');
  Object.defineProperty(globalThis, 'WebTransport', { configurable: true, writable: true, value: class {} });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'WebTransport', previous);
    else delete globalThis.WebTransport;
  });
  const caps = await probeBridgeCapabilities(makeScope({ WebTransport: undefined }));
  assert.equal(caps.webTransport, true);
});

test('an unsupported capability is a terminal status, not a probe loop', async () => {
  const scope = makeScope({ WebTransport: undefined });
  const { bootstrap, controllers } = bootstrapWith(scope);
  const status = await bootstrap.start();
  assert.equal(status.state, 'unsupported');
  assert.equal(status.reason, 'webtransport-unsupported');
  assert.equal(status.terminal, true);
  assert.equal(controllers.length, 0, 'no discovery may run without WebTransport');
  // Auto may return the page to the QUIC/MoQ path it started on.
  assert.equal(status.fallback, 'moq-quic');
});

test('a forced multicast request never reports a usable QUIC fallback', async () => {
  const scope = makeScope({ WebTransport: undefined });
  const { bootstrap } = bootstrapWith(scope, { transportPolicy: 'multicast-only' });
  const status = await bootstrap.start();
  assert.equal(status.state, 'unsupported');
  assert.equal(status.fallback, null);
  assert.throws(() => createBridgeBootstrap({ scope, transportPolicy: 'native' }), TypeError);
  assert.deepEqual([...BRIDGE_TRANSPORT_POLICIES], ['auto', 'multicast-only', 'moq-only']);
});

test('moq-only skips the bridge instead of failing it', async () => {
  const { bootstrap, controllers } = bootstrapWith(makeScope(), { transportPolicy: 'moq-only' });
  const status = await bootstrap.start();
  assert.equal(status.state, 'disabled');
  assert.equal(status.reason, 'transport-policy');
  assert.equal(status.fallback, 'moq-quic');
  assert.equal(controllers.length, 0);
});

test('a denied Local Network permission blocks, and answering the prompt re-arms', async () => {
  const handles = [];
  const permissions = {
    query: async ({ name }) => {
      const handle = {
        name,
        state: name === 'loopback-network' ? 'denied' : 'granted',
        addEventListener(type, listener) { if (type === 'change') this.onchange = listener; },
        removeEventListener() { this.onchange = null; },
      };
      handles.push(handle);
      return handle;
    },
  };
  const scope = makeScope({ permissions });
  const { bootstrap, controllers } = bootstrapWith(scope);

  const blocked = await bootstrap.start();
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.reason, 'local-network-denied');
  assert.equal(controllers.length, 0);
  await flush();

  // The user grants it: the permission-change watcher must recover, which is
  // exactly the transition the one-shot bootstrap could never make.
  permissions.query = async ({ name }) => ({ state: 'granted', name, addEventListener() {}, removeEventListener() {} });
  const watcher = handles.find((handle) => handle.onchange);
  assert.ok(watcher, 'a change watcher must be registered for the local-network permissions');
  watcher.onchange();
  await flush();
  assert.equal(controllers.length, 1, 'discovery re-arms after the permission changes');
  assert.equal(bootstrap.status.state, 'discovering');
  assert.equal(bootstrap.status.reason, 'permission-changed');
});

test('an already-installed extension surface is honoured without probing', async () => {
  const scope = makeScope({ multicast: { subscribe() {} } });
  const { bootstrap, controllers } = bootstrapWith(scope);
  const status = await bootstrap.start();
  assert.equal(status.state, 'extension');
  assert.equal(status.reason, 'extension-surface');
  assert.equal(status.terminal, false, 'the page has a working surface, so this is not a failure');
  assert.equal(controllers.length, 0);
});

test('discovery is bounded and names the layer that failed', async () => {
  const { bootstrap, controllers, statuses } = bootstrapWith(makeScope(), { maxDiscoveryAttempts: 3 });
  await bootstrap.start();
  const controller = controllers[0];
  assert.equal(controller.started, true);

  // Another tab holding the discovery lock is not a failed round.
  controller.emit({ phase: 'discovery', ok: false, reason: 'lock-busy' });
  assert.equal(bootstrap.status.attempts, 0);

  controller.emit({ phase: 'discovery', ok: false, reason: 'miss' });
  controller.emit({ phase: 'connect', ok: false, detail: 'certificate mismatch' });
  assert.equal(bootstrap.status.state, 'discovering');
  assert.equal(bootstrap.status.attempts, 2);

  controller.emit({ phase: 'discovery', ok: false, reason: 'miss' });
  assert.equal(bootstrap.status.state, 'failed');
  assert.equal(bootstrap.status.reason, 'discovery-exhausted');
  assert.equal(bootstrap.status.terminal, true);
  assert.equal(controller.stopped, true, 'the bounded budget must stop the probe loop');
  assert.ok(statuses.some((status) => status.reason === 'connect-failed' &&
    status.detail === 'certificate mismatch'));
});

test('a bridge restart is reported as an instance change, and a disconnect is not terminal', async () => {
  const { bootstrap, controllers } = bootstrapWith(makeScope());
  await bootstrap.start();
  const controller = controllers[0];
  const bridge = { host: 'beacon.local', wtPort: 33445, fingerprint: 'ab'.repeat(32) };

  controller.emit({ phase: 'connect', ok: true, bridge, transport: 'webtransport' });
  assert.equal(bootstrap.status.state, 'connected');
  assert.equal(bootstrap.status.reason, 'connected');
  assert.equal(bootstrap.status.transport, 'webtransport');
  assert.equal(bootstrap.bridgeInstance, bridgeInstanceId(bridge));

  controller.emit({ phase: 'disconnect', bridge });
  assert.equal(bootstrap.status.state, 'recovering');
  assert.equal(bootstrap.status.terminal, false);

  // The bridge restarted with a fresh certificate: same endpoint, new instance.
  const restarted = { ...bridge, fingerprint: 'cd'.repeat(32) };
  controller.emit({ phase: 'connect', ok: true, bridge: restarted });
  assert.equal(bootstrap.status.state, 'connected');
  assert.equal(bootstrap.status.reason, 'bridge-instance-changed');
  assert.equal(bootstrap.bridgeInstance, bridgeInstanceId(restarted));
  assert.equal(bootstrap.status.attempts, 0, 'a live session resets the discovery budget');
});

test('extension readiness without a usable surface re-arms instead of dead-ending', async () => {
  const scope = makeScope();
  const { bootstrap, controllers } = bootstrapWith(scope, { maxDiscoveryAttempts: 1 });
  await bootstrap.start();
  controllers[0].emit({ phase: 'discovery', ok: false, reason: 'miss' });
  assert.equal(bootstrap.status.state, 'failed');

  // A content script can signal readiness while its main-world injector
  // failed. Safari's one-shot bootstrap stayed dead here.
  scope.dispatchEvent(extensionReady(scope));
  await flush();
  assert.equal(controllers.length, 2);
  assert.equal(bootstrap.status.state, 'discovering');
  assert.equal(bootstrap.status.reason, 'extension-ready');

  // Now the extension really does own the surface: stand down.
  scope.multicast = { subscribe() {} };
  scope.dispatchEvent(extensionReady(scope));
  await flush();
  assert.equal(bootstrap.status.state, 'extension');
  assert.equal(bootstrap.status.reason, 'extension-takeover');
  assert.equal(controllers[1].stopped, true);
});

test('recovery is bounded, and a spent budget never destroys a live session', async () => {
  const scope = makeScope();
  const { bootstrap, controllers } = bootstrapWith(scope, { maxRetries: 2 });
  await bootstrap.start();
  await bootstrap.originApproved();
  await bootstrap.retry('bridge-instance-changed');
  assert.equal(controllers.length, 3);

  // The budget refuses another re-arm, but the session already in hand is not
  // the coordinator's to destroy: it may still be the page's working bridge.
  const live = controllers.at(-1);
  const exhausted = await bootstrap.retry('origin-approved');
  assert.equal(controllers.length, 3, 'a spent budget stops re-arming');
  assert.equal(live.stopped, false, 'a spent budget must not tear down a live controller');
  assert.equal(exhausted.state, 'discovering', 'the status in hand is returned unchanged');

  // With nothing left running, the spent budget is the terminal answer.
  live.emit({ phase: 'extension', takeover: true });
  assert.equal(live.stopped, true);
  const failed = await bootstrap.retry('origin-approved');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.reason, 'retry-exhausted');

  const stopped = bootstrap.stop();
  assert.equal(stopped.state, 'stopped');
  scope.dispatchEvent(extensionReady(scope));
  await flush();
  assert.equal(controllers.length, 3, 'a stopped bootstrap ignores recovery triggers');
});

test('moq-only skips the bridge on every trigger, not just start()', async () => {
  const scope = makeScope();
  const { bootstrap, controllers } = bootstrapWith(scope, { transportPolicy: 'moq-only' });
  await bootstrap.start();

  // The listeners are registered unconditionally, so a single postMessage --
  // or the user answering a Local Network prompt -- must not put a moq-only
  // page into LAN discovery.
  scope.dispatchEvent(extensionReady(scope));
  await flush();
  const retried = await bootstrap.retry('permission-changed');
  const approved = await bootstrap.originApproved();

  assert.equal(controllers.length, 0, 'moq-only never builds a bridge controller');
  for (const status of [retried, approved, bootstrap.status]) {
    assert.equal(status.state, 'disabled');
    assert.equal(status.reason, 'transport-policy');
  }
});

test('concurrent triggers never orphan a controller', async () => {
  const scope = makeScope();
  const { bootstrap, controllers } = bootstrapWith(scope, { maxDiscoveryAttempts: 3 });
  await bootstrap.start();

  // Chromium settles `local-network` and `loopback-network` together, so both
  // watchers fire in one task and both see `controller === null`.
  bootstrap.retry('permission-changed');
  bootstrap.retry('permission-changed');
  await flush();

  const live = controllers.at(-1);
  assert.equal(controllers.filter((c) => !c.stopped).length, 1, 'exactly one controller survives');
  assert.equal(live.stopped, false);

  // A superseded controller must not spend the shared discovery budget.
  for (const orphan of controllers.filter((c) => c !== live)) {
    orphan.emit({ phase: 'discovery', ok: false, reason: 'miss' });
    orphan.emit({ phase: 'discovery', ok: false, reason: 'miss' });
    orphan.emit({ phase: 'discovery', ok: false, reason: 'miss' });
  }
  assert.equal(bootstrap.status.attempts, 0, 'an orphan may not terminate the healthy controller');
  assert.notEqual(bootstrap.status.state, 'failed');

  bootstrap.stop();
  assert.ok(controllers.every((c) => c.stopped), 'stop() leaves no LAN probe loop running');
});

test('a superseded launch never publishes its late probe', async () => {
  const scope = makeScope();
  // One controllable probe per launch, so resolution order can be inverted:
  // the superseded launch is made to settle *after* the one that replaced it.
  const pending = [];
  const capabilities = () => new Promise((resolve) => pending.push(resolve));
  const { bootstrap } = bootstrapWith(scope, { capabilities });

  const base = {
    webTransport: true,
    secureContext: true,
    localNetwork: 'granted',
    loopbackNetwork: 'prompt',
    loopbackHttpProbe: true,
    lanHttpProbe: false,
    extensionSurface: false,
  };

  bootstrap.start();
  bootstrap.retry('permission-changed');
  await flush();
  assert.equal(pending.length, 2, 'each launch probes for itself');

  // Generation 2 publishes first; generation 1 -- already superseded -- lands
  // afterwards and must be discarded by the staleness guard.
  pending[1]({ ...base, loopbackNetwork: 'granted' });
  await flush();
  pending[0]({ ...base, loopbackNetwork: 'denied' });
  await flush();

  // The only assertion that discriminates: generation 1 returns at the guard
  // without emitting either way, so nothing downstream of `emit()` -- the
  // published `status` snapshot, `capabilityBlock` -- can tell the two apart.
  assert.equal(bootstrap.capabilities.loopbackNetwork, 'granted',
    'a superseded probe must not overwrite the live launch capabilities');
});

test('a cross-origin frame cannot drive recovery', async () => {
  const scope = makeScope();
  const { bootstrap, controllers } = bootstrapWith(scope, { maxDiscoveryAttempts: 1 });
  await bootstrap.start();
  controllers[0].emit({ phase: 'discovery', ok: false, reason: 'miss' });
  assert.equal(bootstrap.status.state, 'failed');

  scope.dispatchEvent({
    type: 'message',
    source: { name: 'evil-iframe' },
    origin: 'https://attacker.example',
    data: { source: 'multicast-extension', message: { type: 'extension_ready' } },
  });
  await flush();
  assert.equal(controllers.length, 1, 'only the injector in this window may re-arm');
  assert.equal(bootstrap.status.state, 'failed');
});

test('initMulticastBridge really emits the transitions the coordinator consumes', async (t) => {
  const events = [];
  const listeners = new Map();
  const windowScope = {
    location: { href: 'https://player.example.test/watch', origin: 'https://player.example.test', protocol: 'https:', hostname: 'player.example.test', search: '' },
    addEventListener(type, listener) {
      const entries = listeners.get(type) || new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent() { return true; },
  };
  for (const [key, value] of [['window', windowScope], ['location', windowScope.location], ['WebTransport', class {}]]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('no bridge'); });

  const missController = initMulticastBridge({ autoStart: false, onStatus: (event) => events.push(event) });
  missController.start();
  await flush();
  missController.stop();
  assert.deepEqual(events.at(0), { phase: 'discovery', ok: false, reason: 'miss' });

  events.length = 0;
  const fingerprint = 'ab'.repeat(32);
  windowScope.location.search = `?mc_bridge=beacon.local&fingerprint=${fingerprint}`;
  t.mock.method(BridgeClient.prototype, 'connect', async function () {
    this.connected = true;
    this._transport = 'webtransport';
  });
  t.mock.method(BridgeClient.prototype, 'disconnect', function () { this.connected = false; });
  const controller = initMulticastBridge({ autoStart: false, onStatus: (event) => events.push(event) });
  controller.start();
  await flush();
  try {
    const discovery = events.find((event) => event.phase === 'discovery');
    const connect = events.find((event) => event.phase === 'connect');
    assert.equal(discovery.ok, true);
    assert.equal(discovery.bridge.host, 'beacon.local');
    assert.equal(connect.ok, true);
    assert.equal(connect.transport, 'webtransport');
    assert.equal(bridgeInstanceId(connect.bridge), `beacon.local:33445#${fingerprint}`);
  } finally {
    controller.stop();
    delete windowScope.multicast;
  }
});

test('a throw on the launch path is a terminal status, not an open-ended wait', async () => {
  const scope = makeScope();
  const { bootstrap, statuses } = bootstrapWith(scope, {
    init: () => { throw new Error('boom: init failed'); },
  });

  // Every status this module emits is produced inside `launch()`, so an
  // escaping throw is the one way to stop without one -- leaving the page on a
  // non-terminal `checking` it cannot tell apart from the coordinator dying.
  const status = await bootstrap.start();

  assert.equal(status.state, 'failed');
  assert.equal(status.reason, 'launch-threw');
  assert.equal(status.terminal, true);
  assert.equal(status.fallback, 'moq-quic', 'a dead coordinator must hand auto back to QUIC');
  assert.match(status.detail, /boom: init failed/);
  assert.equal(statuses.at(-1).reason, 'launch-threw');
});

test('a throw on a fire-and-forget recovery trigger still reports, and never goes unhandled', async () => {
  const scope = makeScope();
  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on('unhandledRejection', onRejection);
  try {
    const { bootstrap } = bootstrapWith(scope, {
      init: () => { throw new Error('boom: init failed'); },
    });
    await bootstrap.start();

    // `retry('extension-ready')` is fired without an await or a `.catch()`, so
    // before the boundary existed this path threw into nothing at all.
    scope.dispatchEvent(extensionReady(scope));
    await flush();
    await flush();

    assert.deepEqual(rejections, [], 'the launch boundary swallows nothing into an unhandled rejection');
    assert.equal(bootstrap.status.state, 'failed');
    assert.equal(bootstrap.status.reason, 'launch-threw');
    assert.equal(bootstrap.status.terminal, true);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('moq-only never spends the recovery budget it cannot use', async () => {
  const scope = makeScope();
  const { bootstrap, controllers } = bootstrapWith(scope, { transportPolicy: 'moq-only', maxRetries: 1 });
  await bootstrap.start();

  // A moq-only launch can only ever return `disabled`, so charging it a re-arm
  // would report `retry-exhausted` for recovery that was never attempted.
  for (let i = 0; i < 4; i += 1) await bootstrap.retry('permission-changed');

  assert.equal(controllers.length, 0);
  assert.equal(bootstrap.status.state, 'disabled');
  assert.equal(bootstrap.status.reason, 'transport-policy');
  assert.equal(bootstrap.status.retries, 0, 'no budget is spent on a launch that cannot occur');
});
