/**
 * Page-owned bridge bootstrap coordinator (BLO-34021).
 *
 * One coordinator, shared by MoQtail/Shaka/WebCodecs pages, that owns the
 * layers ABOVE discovery: capability diagnostics, terminal status, bounded
 * discovery, and recovery. Discovery, the BCDS-v1 WebTransport handshake, and
 * `window.multicast` installation stay in `initMulticastBridge`; this module
 * never parses media and never embeds a player.
 *
 * Why it exists: `initMulticastBridge` reports readiness and disconnects, but
 * a page could not tell "no bridge on this LAN" from "this browser cannot
 * reach one" from "the extension took over", and an `extension_ready` message
 * stopped it permanently — the Safari one-shot dead end. Every stop here is a
 * status with a reason, and every recovery trigger (extension readiness,
 * permission change, origin approval, bridge-instance change) re-arms a fresh
 * controller under a bounded retry budget.
 *
 * Transport policy is honoured, not assumed: only `auto` may return the page
 * to its initial QUIC/MoQ path. Under `multicast-only` a failure stays a
 * failure, because a forced native/AMT request that silently succeeded over
 * QUIC would read as multicast playback.
 */

import { initMulticastBridge, shouldProbeHttpBridgeHost } from './multicast-bridge.js';

const TAG = '[bridge-bootstrap]';

/** Same names the Shaka/MSF player uses for `transportPolicy`. */
export const BRIDGE_TRANSPORT_POLICIES = Object.freeze(['auto', 'multicast-only', 'moq-only']);

/**
 * Fine-grained Local Network Access permissions are authoritative; the older
 * `local-network-access` alias reports `denied` on Chromium builds where both
 * fine-grained permissions are granted, so it stays informational. Same ruling
 * as the browser extension's setup state.
 */
const LOCAL_NETWORK_PERMISSIONS = Object.freeze(['local-network', 'loopback-network']);
const LOCAL_NETWORK_ALIAS = 'local-network-access';

/**
 * States from which nothing advances without a recovery trigger. `blocked`
 * and `disabled` are recoverable (a permission answer, an origin approval);
 * they are terminal in the sense the page cares about — the probe loop is
 * over and the status, not a timeout, is the answer.
 */
const TERMINAL_STATES = new Set(['unsupported', 'blocked', 'failed', 'disabled', 'stopped']);

/**
 * Identify a bridge *instance*, not an endpoint. The native bridge mints a
 * fresh certificate on every runtime start, so the pin is the restart signal
 * we already have on the wire; an explicit `instanceId` from a future health
 * descriptor wins when present. A CA-authenticated AutoTLS bridge has no pin,
 * so it identifies by endpoint alone.
 */
export function bridgeInstanceId(bridge) {
  if (!bridge) return null;
  if (bridge.instanceId) return String(bridge.instanceId);
  const port = bridge.wtPort ?? bridge.httpPort ?? '';
  return `${bridge.host}:${port}#${bridge.fingerprint || 'ca'}`;
}

async function queryPermission(permissions, name) {
  if (!permissions?.query) return 'unsupported';
  try {
    const status = await permissions.query({ name });
    return status?.state === 'granted' || status?.state === 'prompt' || status?.state === 'denied'
      ? status.state
      : 'unknown';
  } catch (err) {
    // Chromium throws TypeError for permission names it does not implement.
    return err instanceof TypeError ? 'unsupported' : 'unknown';
  }
}

/**
 * Read a global the page and the bridge must agree on. `initMulticastBridge`
 * resolves `WebTransport` against the real global scope, so a capability read
 * that only consulted an injected `scope` could declare the browser
 * unsupported while discovery was perfectly able to run — a false terminal,
 * which is the failure class this coordinator exists to remove.
 */
function readScoped(scope, key) {
  return scope?.[key] !== undefined ? scope[key] : globalThis[key];
}

/**
 * Report every capability the bootstrap depends on BEFORE probing, so a
 * missing one is a visible answer instead of a discovery timeout.
 */
export async function probeBridgeCapabilities(scope = globalThis) {
  const pageProtocol = scope.location?.protocol;
  const permissions = scope.navigator?.permissions;
  const [localNetwork, loopbackNetwork, localNetworkAlias] = await Promise.all([
    queryPermission(permissions, LOCAL_NETWORK_PERMISSIONS[0]),
    queryPermission(permissions, LOCAL_NETWORK_PERMISSIONS[1]),
    queryPermission(permissions, LOCAL_NETWORK_ALIAS),
  ]);
  return {
    webTransport: readScoped(scope, 'WebTransport') !== undefined,
    // Only an explicit `false` is a verdict; a non-browser scope is unknown.
    secureContext: readScoped(scope, 'isSecureContext') !== false,
    pageProtocol: pageProtocol ?? null,
    // Mixed-content viability, per host class. Safari blocks the loopback
    // bootstrap from an HTTPS page even though the loopback origin is
    // potentially trustworthy, so a `true` here is permission-gated, not free.
    loopbackHttpProbe: shouldProbeHttpBridgeHost('127.0.0.1', pageProtocol),
    lanHttpProbe: shouldProbeHttpBridgeHost('192.168.1.10', pageProtocol),
    localNetwork,
    loopbackNetwork,
    localNetworkAlias,
    extensionSurface: hasUsableMulticastSurface(scope),
  };
}

function hasUsableMulticastSurface(scope) {
  try {
    return typeof scope.multicast?.subscribe === 'function';
  } catch {
    return false;
  }
}

/**
 * First blocking capability, or null. Returned as `[state, reason, detail]`.
 */
function capabilityBlock(caps) {
  if (!caps.webTransport) {
    return ['unsupported', 'webtransport-unsupported', 'This browser has no WebTransport'];
  }
  if (!caps.secureContext) {
    return ['unsupported', 'insecure-context', 'WebTransport requires a secure context'];
  }
  for (const [name, state] of [
    [LOCAL_NETWORK_PERMISSIONS[0], caps.localNetwork],
    [LOCAL_NETWORK_PERMISSIONS[1], caps.loopbackNetwork],
  ]) {
    if (state === 'denied') {
      return ['blocked', 'local-network-denied', `${name} permission is denied`];
    }
  }
  return null;
}

/**
 * @param {object} options
 * @param {'auto'|'multicast-only'|'moq-only'} [options.transportPolicy]
 * @param {number} [options.maxDiscoveryAttempts] failed discovery/connect rounds before a terminal status
 * @param {number} [options.maxRetries] recovery re-arms allowed for the page lifetime
 * @param {(status: object) => void} [options.onStatus]
 * @param {object} [options.bridge] options forwarded to `initMulticastBridge` (bridgeHttpPort, …)
 * @param {object} [options.scope] window-like scope; defaults to the page window
 * @param {typeof initMulticastBridge} [options.init] test seam
 * @param {typeof probeBridgeCapabilities} [options.capabilities] test seam
 */
export function createBridgeBootstrap(options = {}) {
  const policy = String(options.transportPolicy ?? 'auto').trim().toLowerCase();
  if (!BRIDGE_TRANSPORT_POLICIES.includes(policy)) {
    throw new TypeError(`Unsupported transport policy: ${options.transportPolicy}`);
  }
  const scope = options.scope ?? globalThis.window ?? globalThis;
  const init = options.init ?? initMulticastBridge;
  const probe = options.capabilities ?? probeBridgeCapabilities;
  const maxDiscoveryAttempts = options.maxDiscoveryAttempts ?? 5;
  const maxRetries = options.maxRetries ?? 5;

  let controller = null;
  let stopped = false;
  let starting = null;
  // Serialises `launch()`: only the newest generation may own `controller` or
  // be heard by `onBridgeStatus`. Two triggers in one task is the normal
  // Chromium path — answering the Local Network prompt settles `local-network`
  // and `loopback-network` together, firing both watchers.
  let launchGen = 0;
  let attempts = 0;
  let retries = 0;
  let instanceId = null;
  let capabilities = null;
  let status = { state: 'idle', reason: null, detail: '', terminal: false, fallback: null, attempts: 0, retries: 0, bridgeInstance: null, capabilities: null, at: Date.now() };

  /**
   * Only `auto` may hand the page back to the QUIC/MoQ path it started on.
   * A forced multicast request that reported a usable QUIC fallback would be
   * indistinguishable from multicast having worked.
   */
  function fallbackFor(state) {
    if (!TERMINAL_STATES.has(state)) return null;
    return policy === 'auto' || policy === 'moq-only' ? 'moq-quic' : null;
  }

  function emit(state, reason, detail = '', extra = {}) {
    status = {
      state,
      reason,
      detail,
      terminal: TERMINAL_STATES.has(state),
      fallback: fallbackFor(state),
      attempts,
      retries,
      bridgeInstance: instanceId,
      capabilities,
      at: Date.now(),
      ...extra,
    };
    options.onStatus?.(status);
    return status;
  }

  function teardownController() {
    const previous = controller;
    controller = null;
    previous?.stop();
  }

  function fail(state, reason, detail) {
    teardownController();
    emit(state, reason, detail);
  }

  /** Bridge-layer events from `initMulticastBridge`. */
  function onBridgeStatus(event, gen) {
    // A superseded controller must not spend the shared discovery budget: its
    // misses would terminate the healthy controller that replaced it.
    if (stopped || gen !== launchGen || !controller) return;
    switch (event.phase) {
      case 'discovery':
        if (event.ok) return;
        // `lock-busy` is another tab holding the discovery lock, not a miss.
        if (event.reason === 'lock-busy') return;
        attempts += 1;
        if (attempts >= maxDiscoveryAttempts) {
          fail('failed', 'discovery-exhausted', `No BCDS bridge after ${attempts} discovery rounds`);
          return;
        }
        emit('discovering', 'discovery-miss', 'No bridge answered this round');
        return;
      case 'connect':
        if (!event.ok) {
          attempts += 1;
          if (attempts >= maxDiscoveryAttempts) {
            fail('failed', 'connect-exhausted', event.detail || 'BCDS WebTransport never completed');
            return;
          }
          emit('discovering', 'connect-failed', event.detail || 'BCDS WebTransport handshake failed');
          return;
        }
        {
          const next = bridgeInstanceId(event.bridge);
          const changed = instanceId !== null && next !== instanceId;
          attempts = 0;
          instanceId = next;
          emit('connected', changed ? 'bridge-instance-changed' : 'connected',
            `BCDS-v1 session on ${event.bridge?.host}`,
            // Normalised to this coordinator's own label so the public status
            // field does not simply track `BridgeClient._transport`, which is
            // private and free to change shape. It already reads
            // `'webtransport'|null`, so the two agree today; the mapping is
            // what keeps a change on that side from reshaping this status.
            { transport: event.transport ? 'webtransport' : null });
        }
        return;
      case 'disconnect':
        // The controller keeps its own bounded backoff; surface the layer.
        emit('recovering', 'bridge-disconnected', 'BCDS session closed; retrying');
        return;
      case 'extension':
        // Readiness alone is not takeover: a content script can signal while
        // its main-world injector failed, and the bridge must stay alive.
        if (!event.takeover) return;
        teardownController();
        emit('extension', 'extension-takeover', 'An extension owns window.multicast');
        return;
      default:
    }
  }

  /** Requesting the MoQ-only path is an answer, not a bridge failure. */
  function policyDisabled() {
    return emit('disabled', 'transport-policy', 'transportPolicy=moq-only skips the bridge');
  }

  async function launch(trigger) {
    // Every entry point — `start()`, every recovery trigger — routes through
    // here, so this is the only place the transport policy has to be honoured.
    if (policy === 'moq-only') return policyDisabled();
    const gen = ++launchGen;
    try {
      const probed = await probe(scope);
      if (stopped || gen !== launchGen) return status;
      // Published only after the guard, like every other write to shared state:
      // a superseded launch whose probe resolves late would otherwise overwrite
      // the live one's capabilities, which `emit()` snapshots and
      // `bootstrap.capabilities` hands to the page.
      capabilities = probed;

      if (capabilities.extensionSurface) {
        // The page already has a usable surface; probing would race it.
        return emit('extension', 'extension-surface', 'window.multicast already installed');
      }
      const block = capabilityBlock(capabilities);
      if (block) return emit(block[0], block[1], block[2]);

      const started = init({
        ...options.bridge,
        autoStart: false,
        onStatus: (event) => onBridgeStatus(event, gen),
      });
      // Nothing may be adopted that a newer launch has already replaced, or the
      // orphan keeps polling the LAN past the page's own `stop()`.
      if (stopped || gen !== launchGen) {
        started.stop();
        return status;
      }
      controller = started;
      emit('discovering', trigger, 'Probing for a BCDS-v1 bridge');
      started.start();
      return status;
    } catch (err) {
      // Every status this module emits is produced in here, so an escaping
      // throw is the one way to stop without one — leaving the page waiting on
      // a non-terminal `checking` forever, and with no fallback. Two of the
      // three triggers are fire-and-forget, so it is an unhandled rejection
      // too. A throwing `window.multicast` accessor reaches this today:
      // `hasWindowMulticastApi` does not guard its read, so a probe that
      // correctly reports no extension surface can still throw out of `init`.
      if (stopped || gen !== launchGen) return status;
      fail('failed', 'launch-threw', err?.message || String(err));
      return status;
    }
  }

  /** Track the in-flight launch so `start()` cannot return a stale snapshot. */
  function beginLaunch(trigger) {
    const pending = launch(trigger).finally(() => {
      if (starting === pending) starting = null;
    });
    starting = pending;
    return pending;
  }

  /**
   * Re-arm after a recovery trigger: extension readiness, a Local Network
   * permission change, an origin approval, or a bridge-instance change.
   */
  function retry(reason = 'retry') {
    if (stopped) return Promise.resolve(status);
    // Checked before the budget: a `moq-only` launch can only ever return
    // `disabled`, so spending a re-arm on one would report `retry-exhausted`
    // for a recovery that was never attempted.
    if (policy === 'moq-only') return Promise.resolve(policyDisabled());
    if (retries >= maxRetries) {
      // A spent budget refuses to re-arm. It must not destroy a session
      // already in hand — only a coordinator with nothing running has failed.
      if (!controller) {
        fail('failed', 'retry-exhausted', `Recovery budget of ${maxRetries} re-arms is spent`);
      }
      return Promise.resolve(status);
    }
    retries += 1;
    attempts = 0;
    teardownController();
    return beginLaunch(reason);
  }

  function start() {
    if (stopped) return Promise.resolve(status);
    if (controller || starting) return starting ?? Promise.resolve(status);
    if (policy === 'moq-only') return Promise.resolve(policyDisabled());
    emit('checking', 'capabilities', 'Reading browser capabilities');
    return beginLaunch('bootstrap');
  }

  // Recovery trigger: extension readiness. `initMulticastBridge` treats this
  // as permanent; here it re-arms so a failed injector is not a dead page.
  const onMessage = (event) => {
    // The extension's injector posts from this window. Without an origin
    // check any cross-origin frame or opener could drain the recovery budget
    // and permanently deny recovery. The origin arm is deliberately wider than
    // the `source` test: it also admits a same-origin frame or opener, which
    // grants nothing a same-origin document cannot already do via `parent.*`,
    // and keeps the trigger working in a scope with no usable `source`.
    if (event?.source !== scope && event?.origin !== scope.location?.origin) return;
    if (event?.data?.source !== 'multicast-extension') return;
    if (event.data?.message?.type !== 'extension_ready') return;
    if (hasUsableMulticastSurface(scope)) {
      if (controller) {
        teardownController();
        emit('extension', 'extension-takeover', 'An extension owns window.multicast');
      }
      return;
    }
    if (!controller && !stopped) retry('extension-ready');
  };
  scope.addEventListener?.('message', onMessage);

  // Recovery trigger: the user answers a Local Network permission prompt.
  const permissionWatchers = [];
  if (scope.navigator?.permissions?.query) {
    for (const name of LOCAL_NETWORK_PERMISSIONS) {
      Promise.resolve(scope.navigator.permissions.query({ name })).then((handle) => {
        if (!handle || stopped) return;
        const onChange = () => { if (!stopped) retry('permission-changed'); };
        handle.addEventListener?.('change', onChange);
        permissionWatchers.push(() => handle.removeEventListener?.('change', onChange));
      }).catch(() => { /* permission name this browser does not implement */ });
    }
  }

  return {
    start,
    retry,
    /** The page calls this after native admits its origin (see BLO-34022). */
    originApproved() { return retry('origin-approved'); },
    get status() { return status; },
    get capabilities() { return capabilities; },
    get bridgeInstance() { return instanceId; },
    stop(reason = 'stopped') {
      if (stopped) return status;
      stopped = true;
      scope.removeEventListener?.('message', onMessage);
      for (const off of permissionWatchers) off();
      teardownController();
      console.log(`${TAG} bootstrap stopped (${reason})`);
      return emit('stopped', reason, 'Bootstrap stopped by the page');
    },
  };
}
