import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	LOCAL_NETWORK_PERMISSION_NAMES,
	SUBSCRIBE_DIRECT_SOCKET_CAPABILITIES,
	describeLegacyPermissionAlias,
	evaluateReadiness,
	type DirectSocketsObservation,
	type NetworkPermissionObservation,
	type ProviderObservation,
	type ReadinessObservation,
} from './readiness.ts';

const healthyProvider: ProviderObservation = {
	providerGlobalPresent: true,
	extensionResponded: true,
	iwaInstalled: true,
	iwaExtensionConnected: true,
};

const healthySockets: DirectSocketsObservation = {
	available: true,
	udp: true,
	tcp: true,
	tcpServer: true,
	udpBind: true,
};

const grantedPermissions: NetworkPermissionObservation = {
	'local-network': 'granted',
	'loopback-network': 'granted',
};

function observation(overrides: Partial<ReadinessObservation> = {}): ReadinessObservation {
	return {
		provider: healthyProvider,
		socketWorker: { api: true, ready: true, directSockets: healthySockets },
		permissions: grantedPermissions,
		...overrides,
	};
}

describe('evaluateReadiness', () => {
	test('reports ready when every gate is satisfied', () => {
		const readiness = evaluateReadiness(observation());
		assert.equal(readiness.ready, true);
		assert.equal(readiness.code, 'ready');
	});

	test('is pure: evaluating twice yields an identical result', () => {
		const input = observation();
		assert.deepEqual(evaluateReadiness(input), evaluateReadiness(input));
	});

	test('distinguishes "cannot observe yet" from "not ready"', () => {
		// Detection of a provider is a fire-and-forget probe with no built-in
		// timeout, so before the caller's deadline elapses, silence is not a
		// verdict. Collapsing the two sends a user to fix a permission that was
		// never the problem.
		const readiness = evaluateReadiness(
			observation({
				provider: { ...healthyProvider, providerGlobalPresent: false, extensionResponded: null },
			}),
		);
		assert.equal(readiness.code, 'provider-unobservable');
		assert.notEqual(readiness.code, 'provider-absent');
	});

	test('reports provider-absent once the deadline has elapsed', () => {
		const readiness = evaluateReadiness(
			observation({
				provider: { ...healthyProvider, providerGlobalPresent: false, extensionResponded: false },
			}),
		);
		assert.equal(readiness.code, 'provider-absent');
	});

	test('refuses to certify an extension provider whose IWA is not installed', () => {
		// The extension installs window.multicast at document_start knowing
		// nothing about the IWA, then routes every call through sendToIWA. With
		// no IWA the call queues and fails ~30s later as a misleading
		// `subscription-failed`, so readiness is the only place this can be
		// reported promptly and accurately.
		const readiness = evaluateReadiness(
			observation({ provider: { ...healthyProvider, iwaInstalled: false } }),
		);
		assert.equal(readiness.ready, false);
		assert.equal(readiness.code, 'iwa-not-installed');
	});

	test('refuses to certify an extension provider whose IWA handshake is disconnected', () => {
		const readiness = evaluateReadiness(
			observation({ provider: { ...healthyProvider, iwaExtensionConnected: false } }),
		);
		assert.equal(readiness.ready, false);
		assert.equal(readiness.code, 'iwa-extension-disconnected');
	});

	test('reports the missing IWA ahead of its downstream symptoms', () => {
		// Cause before symptom, like permission-denied before bind-failure: with
		// no IWA the socket worker and Direct Sockets are unavailable BECAUSE of
		// it, and naming those first sends the operator to the wrong fix.
		const readiness = evaluateReadiness(
			observation({
				provider: { ...healthyProvider, iwaInstalled: false },
				socketWorker: {
					api: false,
					ready: false,
					directSockets: { ...healthySockets, available: false, udp: false },
				},
			}),
		);
		assert.equal(readiness.code, 'iwa-not-installed');
	});

	test('does NOT gate the bridge-polyfill topology on the extension handshake', () => {
		// The polyfill installs window.multicast only AFTER connecting to the
		// bridge, and never speaks to the extension at all — its handshake field
		// is meaningless. Gating it here would report a healthy page as broken,
		// the same error class as the legacy permission alias.
		const readiness = evaluateReadiness(
			observation({
				provider: {
					providerGlobalPresent: true,
					extensionResponded: false,
					iwaInstalled: false,
					iwaExtensionConnected: false,
				},
			}),
		);
		assert.equal(readiness.ready, true);
		assert.equal(readiness.code, 'ready');
	});

	test('does not gate on the IWA before the extension probe has answered', () => {
		// `null` is not-yet-observed, not a verdict — same discipline the
		// provider-unobservable gate applies above.
		const readiness = evaluateReadiness(
			observation({
				provider: {
					providerGlobalPresent: true,
					extensionResponded: null,
					iwaInstalled: false,
					iwaExtensionConnected: false,
				},
			}),
		);
		assert.equal(readiness.code, 'ready');
	});

	test('names the individual missing Direct Sockets capabilities', () => {
		const readiness = evaluateReadiness(
			observation({
				socketWorker: {
					api: true,
					ready: true,
					directSockets: { ...healthySockets, available: false, udp: false, tcpServer: false },
				},
			}),
		);
		assert.equal(readiness.code, 'direct-sockets-unavailable');
		assert.deepEqual([...readiness.missingCapabilities].sort(), ['tcpServer', 'udp']);
	});

	// BLO-33764 review finding. A subscribe moves its payload over UDP on every
	// accepted origin (`ip-multicast`, `amt`, `tuner`); TCPSocket and
	// TCPServerSocket belong to the WebTransport bridge listener and the TLS
	// client worker. Gating a subscribe on the full set refuses a UDP-only
	// runtime that would have worked — and the provider's own support test
	// agrees, since `NativeMulticastManager.isSupported()` reads `hasUDPSocket`
	// alone.
	test('a narrowed capability set ignores capabilities the operation does not use', () => {
		const udpOnly = observation({
			socketWorker: {
				api: true,
				ready: true,
				directSockets: {
					...healthySockets,
					// `available` is the provider's own `udp && tcp && tcpServer`, so a
					// UDP-only runtime reports it false. The narrowed gate must not
					// re-impose the full requirement through the aggregate.
					available: false,
					udp: true,
					tcp: false,
					tcpServer: false,
				},
			},
		});

		assert.equal(
			evaluateReadiness(udpOnly, { requiredCapabilities: SUBSCRIBE_DIRECT_SOCKET_CAPABILITIES })
				.code,
			'ready',
		);

		// The default is unchanged: the setup assistant still reports the whole
		// provider as unhealthy on the same observation.
		const strict = evaluateReadiness(udpOnly);
		assert.equal(strict.code, 'direct-sockets-unavailable');
		assert.deepEqual([...strict.missingCapabilities].sort(), ['tcp', 'tcpServer']);
	});

	test('a narrowed capability set still blocks on the capability it does use', () => {
		const noUdp = observation({
			socketWorker: {
				api: true,
				ready: true,
				directSockets: { ...healthySockets, available: false, udp: false },
			},
		});

		const readiness = evaluateReadiness(noUdp, {
			requiredCapabilities: SUBSCRIBE_DIRECT_SOCKET_CAPABILITIES,
		});
		assert.equal(readiness.code, 'direct-sockets-unavailable');
		assert.deepEqual(readiness.missingCapabilities, ['udp']);
	});

	test('reports a denied permission separately from an ungranted one', () => {
		const denied = evaluateReadiness(
			observation({ permissions: { ...grantedPermissions, 'local-network': 'denied' } }),
		);
		assert.equal(denied.code, 'network-permission-denied');
		assert.deepEqual(denied.blockingPermissions, ['local-network']);

		const prompting = evaluateReadiness(
			observation({ permissions: { ...grantedPermissions, 'loopback-network': 'prompt' } }),
		);
		assert.equal(prompting.code, 'network-permission-required');
		assert.deepEqual(prompting.blockingPermissions, ['loopback-network']);
	});

	test('does not mistake an unsupported permission name for a denial', () => {
		// Chromium throws TypeError for names it does not implement, and the
		// local-network names have shipped under different spellings. Reporting
		// "unsupported" as "denied" tells the user to un-deny something they never
		// denied.
		const readiness = evaluateReadiness(
			observation({ permissions: { ...grantedPermissions, 'local-network': 'unsupported' } }),
		);
		assert.equal(readiness.code, 'network-permission-required');
		assert.notEqual(readiness.code, 'network-permission-denied');
	});

	test('permission gates are evaluated before the bind gate', () => {
		// The provider only attempts a bind once both permissions are granted, so
		// a bind result observed alongside an ungranted permission carries no
		// information and must not be reported as the cause.
		const readiness = evaluateReadiness(
			observation({
				socketWorker: {
					api: true,
					ready: true,
					directSockets: { ...healthySockets, udpBind: false, error: 'blocked' },
				},
				permissions: { ...grantedPermissions, 'local-network': 'prompt' },
			}),
		);
		assert.equal(readiness.code, 'network-permission-required');
	});

	test('separates an unattempted bind from a failed one', () => {
		const unattempted = evaluateReadiness(
			observation({
				socketWorker: { api: true, ready: true, directSockets: { ...healthySockets, udpBind: null } },
			}),
		);
		assert.equal(unattempted.code, 'udp-bind-unverified');
		assert.equal(unattempted.ready, false);

		const failed = evaluateReadiness(
			observation({
				socketWorker: {
					api: true,
					ready: true,
					directSockets: { ...healthySockets, udpBind: false, error: 'Access to local network is blocked.' },
				},
			}),
		);
		assert.equal(failed.code, 'udp-bind-failed');
		assert.match(failed.detail, /Access to local network is blocked\./);
	});

	test('requires both the worker API and a live worker', () => {
		for (const socketWorker of [
			{ api: false, ready: true, directSockets: healthySockets },
			{ api: true, ready: false, directSockets: healthySockets },
		]) {
			assert.equal(evaluateReadiness(observation({ socketWorker })).code, 'socket-worker-unavailable');
		}
	});

	test('every non-ready result carries an actionable detail', () => {
		const cases: ReadinessObservation[] = [
			observation({ provider: { ...healthyProvider, providerGlobalPresent: false, extensionResponded: false } }),
			observation({ socketWorker: { api: false, ready: false, directSockets: healthySockets } }),
			observation({ permissions: { ...grantedPermissions, 'local-network': 'denied' } }),
		];
		for (const input of cases) {
			const readiness = evaluateReadiness(input);
			assert.equal(readiness.ready, false);
			assert.ok(readiness.detail.length > 0, `${readiness.code} produced an empty detail`);
		}
	});
});

describe('the legacy local-network-access alias', () => {
	test('is not one of the authoritative permission names', () => {
		assert.deepEqual(LOCAL_NETWORK_PERMISSION_NAMES, ['local-network', 'loopback-network']);
		assert.ok(!(LOCAL_NETWORK_PERMISSION_NAMES as readonly string[]).includes('local-network-access'));
	});

	test('never gates readiness, even when it reports denied', () => {
		// Measured behaviour: current Chromium reports the alias denied while both
		// fine-grained permissions are granted. Gating on it reports a working
		// bridge as blocked.
		const readiness = evaluateReadiness(
			observation({ permissions: { ...grantedPermissions, legacyAlias: 'denied' } }),
		);
		assert.equal(readiness.ready, true);
	});

	test('is presented as covered when both fine-grained grants are present', () => {
		const described = describeLegacyPermissionAlias({ ...grantedPermissions, legacyAlias: 'denied' });
		assert.deepEqual(described, { state: 'granted', detail: 'Covered by local + loopback grants' });
	});

	test('is reported verbatim when the fine-grained grants are absent', () => {
		const described = describeLegacyPermissionAlias({
			'local-network': 'prompt',
			'loopback-network': 'granted',
			legacyAlias: 'denied',
		});
		assert.equal(described?.state, 'denied');
	});

	test('is omitted entirely when the provider did not report it', () => {
		assert.equal(describeLegacyPermissionAlias(grantedPermissions), null);
	});
});
