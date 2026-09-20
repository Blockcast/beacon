import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
	MULTICAST_ERROR_CODES,
	MulticastError,
	isMulticastErrorCode,
	multicastErrorCodeOf,
} from './gateway.ts';
import { evaluateReadiness } from './readiness.ts';
import type {
	Capabilities,
	MulticastErrorCode,
	SubscribeConfig,
	SubscribeConfigAmt,
	SubscribeConfigBytes,
	SubscribeConfigTuner,
} from './gateway.ts';

/**
 * Compile-time exhaustiveness helper: narrowing `SubscribeConfig` on `origin`
 * must reach `never` once every member is handled. If a future member is added
 * without a branch here, `assertNever` fails to type-check — a build break, not
 * a silent runtime gap. Mirrors the discriminated-union test style used for the
 * `consume: 'bytes'` contract elsewhere in this package.
 */
function assertNever(x: never): never {
	throw new Error(`unexpected SubscribeConfig member: ${JSON.stringify(x)}`);
}

function describeOrigin(config: SubscribeConfig): string {
	switch (config.origin) {
		case undefined:
		case 'ip-multicast':
			return 'ip-multicast';
		case 'amt':
			// Narrowed to SubscribeConfigAmt: relay/relayPort are in scope.
			return `amt:${config.relay}:${config.relayPort}`;
		case 'tuner':
			// Narrowed to SubscribeConfigTuner: standard is in scope.
			return `tuner:${config.standard}`;
		default:
			return assertNever(config);
	}
}

test('MulticastError carries a stable code and message', () => {
	const err = new MulticastError('iwa-not-installed', 'IWA is not installed');
	assert.equal(err.code, 'iwa-not-installed');
	assert.equal(err.message, 'IWA is not installed');
	assert.ok(err instanceof Error);
	assert.ok(err instanceof MulticastError);
});

test('MulticastError preserves the cause when supplied', () => {
	const cause = new TypeError('bad config');
	const err = new MulticastError('subscription-failed', 'subscribe rejected', cause);
	assert.equal(err.cause, cause);
});

test('MulticastError name is "MulticastError" for stack traces', () => {
	const err = new MulticastError('capability-unsupported', 'no metadata mode');
	assert.equal(err.name, 'MulticastError');
});

test('back-compat: legacy IP-multicast literal (no origin) is a valid SubscribeConfig', () => {
	// The exact pre-BLO-12103 shape — { group, port, consume } with no origin —
	// must still type-check and narrow to the IP-multicast member.
	const legacy: SubscribeConfig = { group: '232.1.2.3', port: 5000, consume: 'bytes' };
	assert.equal(describeOrigin(legacy), 'ip-multicast');

	const legacyAsm: SubscribeConfigBytes = { group: '224.0.23.60', port: 4937, consume: 'bytes' };
	assert.equal(legacyAsm.origin, undefined);
	assert.equal(describeOrigin(legacyAsm), 'ip-multicast');
});

test('IP-multicast member accepts an explicit origin and an SSM source', () => {
	const explicit: SubscribeConfig = {
		group: '232.10.20.30',
		source: '198.51.100.7',
		port: 6000,
		consume: 'bytes',
		origin: 'ip-multicast',
	};
	assert.equal(describeOrigin(explicit), 'ip-multicast');
	assert.equal(explicit.source, '198.51.100.7');
});

test('AMT relay member constructs and narrows on origin', () => {
	const amt: SubscribeConfigAmt = {
		group: '232.1.1.1',
		source: '203.0.113.5',
		port: 5004,
		consume: 'bytes',
		origin: 'amt',
		relay: '192.0.2.10',
		relayPort: 2268,
	};
	const widened: SubscribeConfig = amt;
	assert.equal(describeOrigin(widened), 'amt:192.0.2.10:2268');
	assert.equal(amt.relayPort, 2268);
});

test('tuner members construct for ATSC 1.0, ATSC 3.0, DVB, and MBMS and narrow on standard', () => {
	const atsc3: SubscribeConfigTuner = {
		group: '224.0.23.60',
		port: 4937,
		consume: 'bytes',
		origin: 'tuner',
		standard: 'atsc3',
	};
	const atsc1: SubscribeConfigTuner = {
		consume: 'bytes',
		origin: 'tuner',
		standard: 'atsc1',
		protocol: 'mpeg-ts',
	};
	const dvb: SubscribeConfigTuner = { ...atsc3, standard: 'dvb' };
	const mbms: SubscribeConfigTuner = { ...atsc3, standard: 'mbms' };

	assert.equal(describeOrigin(atsc1), 'tuner:atsc1');
	assert.equal(describeOrigin(atsc3), 'tuner:atsc3');
	assert.equal(describeOrigin(dvb), 'tuner:dvb');
	assert.equal(describeOrigin(mbms), 'tuner:mbms');
	assert.equal(atsc1.group, undefined);
	assert.equal(atsc1.port, undefined);
});

test('address-family-agnostic: IPv6 SSM (MLDv2) round-trips across all source members', () => {
	// ff3e::/.. is the IPv6 SSM scope (RFC 3810 MLDv2). group + source are bare
	// strings, so IPv6 literals are accepted with no per-member family field.
	const ipv6SsmGroup = 'ff3e::8000:1';
	const ipv6Source = '2001:db8::1';

	const mc: SubscribeConfig = {
		group: ipv6SsmGroup,
		source: ipv6Source,
		port: 5004,
		consume: 'bytes',
	};
	const amt: SubscribeConfig = {
		group: ipv6SsmGroup,
		source: ipv6Source,
		port: 5004,
		consume: 'bytes',
		origin: 'amt',
		relay: '2001:db8::a',
		relayPort: 2268,
	};
	const tuner: SubscribeConfig = {
		group: ipv6SsmGroup,
		source: ipv6Source,
		port: 5004,
		consume: 'bytes',
		origin: 'tuner',
		standard: 'atsc3',
	};

	for (const cfg of [mc, amt, tuner]) {
		assert.equal(cfg.group, 'ff3e::8000:1');
		assert.equal(cfg.source, '2001:db8::1');
	}
	assert.equal(describeOrigin(mc), 'ip-multicast');
	assert.equal(describeOrigin(amt), 'amt:2001:db8::a:2268');
	assert.equal(describeOrigin(tuner), 'tuner:atsc3');
});

test('address-family-agnostic: IPv6 ASM (MLDv2, no source) is valid', () => {
	// ff0e::/.. is an IPv6 ASM (any-source) group; omitting `source` selects ASM.
	const asm: SubscribeConfig = { group: 'ff0e::1234', port: 5004, consume: 'bytes' };
	assert.equal(asm.source, undefined);
	assert.equal(asm.group, 'ff0e::1234');
	assert.equal(describeOrigin(asm), 'ip-multicast');
});

test('Capabilities advertises origins, tuners, and address families', () => {
	const caps: Capabilities = {
		iwaVersion: '1.2.3',
		originContractVersion: 1,
		consumeModes: ['bytes'],
		// Minimal TransportCapabilityReport — only the required fields.
		transports: {
			nativeMulticast: { confirmed: true },
			amt: { available: true },
			moqRelay: { reachable: false },
			whip: { available: false },
			webTransportBridge: false,
			observedAt: 0,
		},
		plugins: [],
		origins: ['ip-multicast', 'amt', 'tuner'],
		tuners: ['atsc3', 'dvb', 'mbms'],
		addressFamilies: ['ipv4', 'ipv6'],
	};
	assert.deepEqual([...caps.origins!], ['ip-multicast', 'amt', 'tuner']);
	assert.deepEqual([...caps.tuners!], ['atsc3', 'dvb', 'mbms']);
	assert.deepEqual([...caps.addressFamilies!], ['ipv4', 'ipv6']);
});

test('Capabilities back-compat: the pre-BLO-12103 4-field shape still type-checks', () => {
	// origins/tuners/addressFamilies are optional, so the IWA gateway's original
	// constructor shape remains valid without edits to that package.
	const caps: Capabilities = {
		iwaVersion: '0.0.0',
		consumeModes: ['bytes'],
		transports: {
			nativeMulticast: { confirmed: false },
			amt: { available: false },
			moqRelay: { reachable: false },
			whip: { available: false },
			webTransportBridge: false,
			observedAt: 0,
		},
		plugins: [],
	};
	assert.equal(caps.origins, undefined);
	assert.equal(caps.tuners, undefined);
	assert.equal(caps.addressFamilies, undefined);
});

/**
 * The array and the union are two hand-maintained lists of the same thing, and
 * `isMulticastErrorCode` — the ratified structural test every cross-realm
 * consumer is told to prefer over `instanceof` — reads only the array. A member
 * added to the union but not the array therefore makes a REAL, thrown code
 * report as not-a-code across the realm hop, silently, with no type error.
 *
 * This switch fails to compile if the union grows without the array growing
 * (`assertNever` receives a live member), and fails at runtime if the array
 * grows without the union (the default branch is reached). Both directions.
 */
test('MULTICAST_ERROR_CODES covers MulticastErrorCode exhaustively, both ways', () => {
	// A Record keyed by the union, NOT a switch: `Record<MulticastErrorCode, _>`
	// makes TypeScript demand every member as a key, so this object is a
	// compile-time enumeration of the union that the runtime can then walk. A
	// switch + assertNever catches a member added to the union, but NOT a member
	// deleted from the array while the union keeps it — and that third case is
	// the dangerous one, because it is exactly what makes a live thrown code
	// report as not-a-code.
	const classification: Record<MulticastErrorCode, 'readiness' | 'other'> = {
		'not-ready': 'readiness',
		'iwa-not-installed': 'other',
		'origin-not-trusted': 'other',
		'capability-unsupported': 'other',
		'subscription-failed': 'other',
	};
	const fromUnion = Object.keys(classification) as MulticastErrorCode[];

	// union ⊆ array — a member the array forgot fails its own structural test.
	for (const code of fromUnion) {
		assert.ok(isMulticastErrorCode(code), `${code} is in the union but not the array`);
	}
	// array ⊆ union, and no duplicates.
	assert.deepEqual([...MULTICAST_ERROR_CODES].sort(), [...fromUnion].sort());
	assert.equal(new Set(MULTICAST_ERROR_CODES).size, MULTICAST_ERROR_CODES.length);
});

test("not-ready carries the readiness verdict; 'permission-denied' is a derived reading", () => {
	// The BLO-33718 ruling: the union grew by one, and the ten-way cause rides on
	// the ratified Readiness record rather than being re-encoded as more members.
	const readiness = evaluateReadiness({
		provider: {
			providerGlobalPresent: true,
			extensionResponded: true,
			iwaInstalled: true,
			iwaExtensionConnected: true,
		},
		socketWorker: {
			api: true,
			ready: true,
			directSockets: { available: true, udp: true, tcp: true, tcpServer: true, udpBind: null },
		},
		permissions: { 'local-network': 'denied', 'loopback-network': 'granted' },
	});
	assert.equal(readiness.code, 'network-permission-denied');

	const err = new MulticastError('not-ready', readiness.detail, undefined, readiness);
	assert.equal(multicastErrorCodeOf(err), 'not-ready');
	assert.deepEqual(err.readiness?.blockingPermissions, ['local-network']);

	// This is the discrimination the old vocabulary could not express: a denial
	// the user must reverse, vs a prompt not yet shown. Both would have been one
	// flat `permission-denied`, and both were `subscription-failed` before.
	assert.notEqual(readiness.code, 'network-permission-required');

	// Survives the JSON hop that flattens Error subclasses (see GatewayEventWire).
	const wire = JSON.parse(
		JSON.stringify({ code: err.code, message: err.message, readiness: err.readiness }),
	);
	assert.equal(wire.readiness.code, 'network-permission-denied');
	assert.deepEqual(wire.readiness.blockingPermissions, ['local-network']);
});

test('a not-ready from an older provider has no verdict, and that is UNKNOWN not ready', () => {
	const err = new MulticastError('not-ready', 'provider predates BLO-33718');
	assert.equal(err.readiness, undefined);
	assert.ok(isMulticastErrorCode(err.code));
});
