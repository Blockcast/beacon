import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';

// The contract is consumed TYPE-ONLY by everything this package ships. Tests are
// excluded from the build and from the published `files`, so importing the
// contract's runtime here crosses no published boundary — and it is the only way
// to check the adapter against the real evaluator rather than against a mock of
// it. `assertNoRuntimeContractImports` below is what keeps shipped sources clean.
import { evaluateReadiness } from '../../multicast-contract/src/readiness.ts';

import {
	createBrowserConformanceDriver,
	getGateway,
	hasGateway,
	observeProvider,
	observeReadiness,
	queryNetworkPermissions,
	queryOptionalLocation,
	queryPermission,
	readSocketWorker,
	type BrowserScope,
} from './index.ts';

/** A scope whose `navigator.permissions.query` answers from a fixed table. */
function scopeWithPermissions(
	table: Readonly<Record<string, string | Error>>,
	extra: Partial<BrowserScope> = {},
): BrowserScope {
	return {
		...extra,
		navigator: {
			permissions: {
				async query({ name }: { name: string }) {
					const answer = table[name];
					if (answer === undefined) throw new TypeError(`unknown permission: ${name}`);
					if (answer instanceof Error) throw answer;
					return { state: answer };
				},
			},
		},
	} as BrowserScope;
}

const GRANTED = {
	'local-network': 'granted',
	'loopback-network': 'granted',
	'local-network-access': 'denied',
	geolocation: 'prompt',
} as const;

function healthySocketWorker() {
	return {
		api: true,
		ready: true,
		directSockets: {
			available: true,
			hasUDPSocket: true,
			hasTCPSocket: true,
			hasTCPServerSocket: true,
			udpBind: true,
		},
	};
}

/** Minimal object that satisfies the structural gateway check. */
function fakeProviderSurface(extra: Record<string, unknown> = {}) {
	return {
		async subscribe() {
			throw new Error('not used');
		},
		async capabilities() {
			return {
				iwaVersion: 'test',
				consumeModes: ['bytes'],
				transports: {},
				plugins: [],
			};
		},
		...extra,
	};
}

describe('queryPermission', () => {
	test('reports the three real states verbatim', async () => {
		const scope = scopeWithPermissions({ a: 'granted', b: 'prompt', c: 'denied' });
		assert.equal(await queryPermission('a', scope), 'granted');
		assert.equal(await queryPermission('b', scope), 'prompt');
		assert.equal(await queryPermission('c', scope), 'denied');
	});

	test('an unimplemented name is unsupported, never denied', async () => {
		// Chromium throws TypeError for names it does not implement. Collapsing
		// this into `denied` reports a healthy build as blocked.
		const scope = scopeWithPermissions({});
		assert.equal(await queryPermission('loopback-network', scope), 'unsupported');
	});

	test('a non-TypeError failure is unknown, never denied', async () => {
		const scope = scopeWithPermissions({ 'local-network': new DOMException('bad context') });
		assert.equal(await queryPermission('local-network', scope), 'unknown');
	});

	test('a realm with no permissions API is unsupported', async () => {
		assert.equal(await queryPermission('local-network', {} as BrowserScope), 'unsupported');
	});

	test('an unrecognised state string is unknown', async () => {
		const scope = scopeWithPermissions({ 'local-network': 'indeterminate' });
		assert.equal(await queryPermission('local-network', scope), 'unknown');
	});
});

describe('queryNetworkPermissions', () => {
	test('carries the legacy alias without letting it gate anything', async () => {
		// The live failure mode: current Chromium reports the legacy combined
		// alias `denied` while both fine-grained names are `granted`.
		const observation = await queryNetworkPermissions(scopeWithPermissions(GRANTED));
		assert.equal(observation['local-network'], 'granted');
		assert.equal(observation['loopback-network'], 'granted');
		assert.equal(observation.legacyAlias, 'denied');

		const readiness = evaluateReadiness({
			provider: {
				providerGlobalPresent: true,
				extensionResponded: false,
				iwaInstalled: false,
				iwaExtensionConnected: false,
			},
			socketWorker: readSocketWorker(healthySocketWorker()),
			permissions: observation,
		});
		assert.equal(readiness.code, 'ready', 'a denied legacy alias must not block readiness');
	});
});

describe('queryOptionalLocation', () => {
	test('reports geolocation and keeps it out of readiness', async () => {
		const scope = scopeWithPermissions({ ...GRANTED, geolocation: 'denied' });
		assert.equal((await queryOptionalLocation(scope)).geolocation, 'denied');

		// Location is outside subscription semantics for this cutover. The
		// observation the evaluator sees has no location field at all, which is
		// the structural guarantee — not merely an unused value.
		const observation = await observeReadiness(
			{ extensionDeadlineElapsed: true, socketWorker: healthySocketWorker() },
			scope,
		);
		assert.ok(!('location' in observation));
		assert.ok(!('geolocation' in observation));
	});
});

describe('readSocketWorker', () => {
	test('preserves the udpBind tri-state', () => {
		// `null` means NOT ATTEMPTED: the provider only tries the bind once both
		// fine-grained permissions are granted. Collapsing it to `false` reports
		// "we never tried" as "the bind failed" — different cause, different fix,
		// different message, and a different contract code.
		assert.equal(readSocketWorker({ directSockets: { udpBind: true } }).directSockets.udpBind, true);
		assert.equal(
			readSocketWorker({ directSockets: { udpBind: false } }).directSockets.udpBind,
			false,
		);
		assert.equal(readSocketWorker({ directSockets: {} }).directSockets.udpBind, null);
		assert.equal(readSocketWorker(undefined).directSockets.udpBind, null);
	});

	test('an unattempted bind reads as unverified, not failed', () => {
		const base = {
			provider: {
				providerGlobalPresent: true,
				extensionResponded: false,
				iwaInstalled: false,
				iwaExtensionConnected: false,
			},
			permissions: {
				'local-network': 'granted',
				'loopback-network': 'granted',
			},
		} as const;
		const unattempted = { ...healthySocketWorker(), directSockets: { available: true, hasUDPSocket: true, hasTCPSocket: true, hasTCPServerSocket: true } };
		assert.equal(
			evaluateReadiness({ ...base, socketWorker: readSocketWorker(unattempted) }).code,
			'udp-bind-unverified',
		);
		assert.equal(
			evaluateReadiness({
				...base,
				socketWorker: readSocketWorker({
					...unattempted,
					directSockets: { ...unattempted.directSockets, udpBind: false },
				}),
			}).code,
			'udp-bind-failed',
		);
	});

	test('missing capability flags default to absent, not present', () => {
		const observed = readSocketWorker({ api: true, ready: true, directSockets: { available: true } });
		assert.deepEqual(
			[observed.directSockets.udp, observed.directSockets.tcp, observed.directSockets.tcpServer],
			[false, false, false],
		);
	});

	test('carries a provider error string through verbatim', () => {
		const observed = readSocketWorker({ directSockets: { error: 'bind refused' } });
		assert.equal(observed.directSockets.error, 'bind refused');
		// Absent rather than an empty string, so `detail` falls back correctly.
		assert.ok(!('error' in readSocketWorker({ directSockets: {} }).directSockets));
	});
});

describe('observeProvider', () => {
	test('extensionResponded stays null until the caller deadline elapses', () => {
		// Extension detection is fire-and-forget with no built-in timeout, so
		// silence is indistinguishable from absence until the deadline expires.
		const silent: BrowserScope = { multicast: fakeProviderSurface() };
		assert.equal(
			observeProvider({ extensionDeadlineElapsed: false }, silent).extensionResponded,
			null,
		);
		assert.equal(
			observeProvider({ extensionDeadlineElapsed: true }, silent).extensionResponded,
			false,
		);
	});

	test('the extension flag wins over a not-yet-elapsed deadline', () => {
		const answered: BrowserScope = {
			multicast: fakeProviderSurface(),
			__multicastExtensionAvailable: true,
		};
		assert.equal(
			observeProvider({ extensionDeadlineElapsed: false }, answered).extensionResponded,
			true,
		);
	});

	test('provider presence does not imply an extension', () => {
		// The standalone bridge polyfill installs window.multicast too, and never
		// speaks to the extension at all.
		const polyfilled: BrowserScope = { multicast: fakeProviderSurface() };
		const observed = observeProvider({ extensionDeadlineElapsed: true }, polyfilled);
		assert.equal(observed.providerGlobalPresent, true);
		assert.equal(observed.extensionResponded, false);
		// And the IWA lifecycle gates must not fire for it: the polyfill only
		// installs the global AFTER connecting to the IWA, so presence already
		// implies a live bridge.
		assert.equal(
			evaluateReadiness({
				provider: observed,
				socketWorker: readSocketWorker(healthySocketWorker()),
				permissions: { 'local-network': 'granted', 'loopback-network': 'granted' },
			}).code,
			'ready',
		);
	});

	test('an extension with no IWA reports the IWA gate, not a permission problem', () => {
		const scope: BrowserScope = {
			multicast: fakeProviderSurface(),
			__multicastExtensionAvailable: true,
		};
		const readiness = evaluateReadiness({
			provider: observeProvider({ extensionDeadlineElapsed: true }, scope),
			socketWorker: readSocketWorker(healthySocketWorker()),
			permissions: { 'local-network': 'granted', 'loopback-network': 'granted' },
		});
		assert.equal(readiness.code, 'iwa-not-installed');
	});

	test('a connected IWA clears both lifecycle gates', () => {
		const scope: BrowserScope = {
			multicast: fakeProviderSurface(),
			__multicastExtensionAvailable: true,
		};
		const readiness = evaluateReadiness({
			provider: observeProvider(
				{ extensionDeadlineElapsed: true, iwaInstalled: true, iwaExtensionConnected: true },
				scope,
			),
			socketWorker: readSocketWorker(healthySocketWorker()),
			permissions: { 'local-network': 'granted', 'loopback-network': 'granted' },
		});
		assert.equal(readiness.code, 'ready');
	});

	test('a bare page is unobservable before the deadline and absent after it', async () => {
		const empty = scopeWithPermissions(GRANTED);
		assert.equal(
			evaluateReadiness(await observeReadiness({ extensionDeadlineElapsed: false }, empty)).code,
			'provider-unobservable',
		);
		assert.equal(
			evaluateReadiness(await observeReadiness({ extensionDeadlineElapsed: true }, empty)).code,
			'provider-absent',
		);
	});
});

describe('observeReadiness', () => {
	test('a page realm that cannot see the socket worker says so', async () => {
		// The socket worker lives in the IWA isolated-app: realm and the extension
		// exposes no page-facing diagnostic channel, so a page-realm caller
		// genuinely cannot complete the observation. Reporting
		// socket-worker-unavailable is the honest reading; inventing a healthy
		// default would certify a provider nobody has checked.
		const scope = scopeWithPermissions(GRANTED, { multicast: fakeProviderSurface() });
		const readiness = evaluateReadiness(
			await observeReadiness({ extensionDeadlineElapsed: true }, scope),
		);
		assert.equal(readiness.code, 'socket-worker-unavailable');
	});

	test('end-to-end ready on a fully-observed healthy provider', async () => {
		const scope = scopeWithPermissions(GRANTED, { multicast: fakeProviderSurface() });
		const readiness = evaluateReadiness(
			await observeReadiness(
				{ extensionDeadlineElapsed: true, socketWorker: healthySocketWorker() },
				scope,
			),
		);
		assert.equal(readiness.ready, true);
		assert.equal(readiness.code, 'ready');
	});

	test('a denied fine-grained permission is reported before the bind', async () => {
		const scope = scopeWithPermissions(
			{ ...GRANTED, 'loopback-network': 'denied' },
			{ multicast: fakeProviderSurface() },
		);
		const readiness = evaluateReadiness(
			await observeReadiness(
				{ extensionDeadlineElapsed: true, socketWorker: healthySocketWorker() },
				scope,
			),
		);
		assert.equal(readiness.code, 'network-permission-denied');
		assert.deepEqual(readiness.blockingPermissions, ['loopback-network']);
	});
});

describe('getGateway', () => {
	test('accepts a provider missing only the optional throughput history', () => {
		// getThroughputHistory is optional in the contract because an older
		// deployed provider predates history v1. Requiring it rejects a working
		// provider.
		const scope: BrowserScope = { multicast: fakeProviderSurface() };
		assert.ok(getGateway(scope));
		assert.equal(hasGateway(scope), true);
	});

	test('rejects partial and non-object surfaces instead of casting', () => {
		for (const candidate of [
			undefined,
			null,
			42,
			'multicast',
			{},
			{ subscribe() {} },
			{ capabilities() {} },
			{ subscribe: true, capabilities: true },
		]) {
			assert.equal(getGateway({ multicast: candidate } as BrowserScope), null, String(candidate));
		}
	});
});

describe('createBrowserConformanceDriver', () => {
	test('throws with an actionable message when no provider is installed', () => {
		assert.throws(() => createBrowserConformanceDriver({} as BrowserScope), /observeReadiness/);
	});

	test('adopts driver hooks the provider exposes, bound to the provider', () => {
		const seen: string[] = [];
		const provider = fakeProviderSurface({
			tag: 'provider',
			deliverBytes(this: { tag: string }) {
				seen.push(this.tag);
			},
			physicalJoinCount: () => 3,
		});
		const driver = createBrowserConformanceDriver({ multicast: provider } as BrowserScope);
		assert.equal(typeof driver.deliverBytes, 'function');
		assert.equal(typeof driver.physicalJoinCount, 'function');
		// Absent hooks stay absent so the suite reports those checks `skipped`
		// rather than calling undefined.
		assert.ok(!('forceState' in driver));
		assert.ok(!('resolveTransport' in driver));
		driver.deliverBytes?.({} as never, []);
		assert.deepEqual(seen, ['provider'], 'hook must keep the provider as its receiver');
	});

	test('explicit hooks override the provider', () => {
		const provider = fakeProviderSurface({ physicalJoinCount: () => 1 });
		const driver = createBrowserConformanceDriver({ multicast: provider } as BrowserScope, {
			physicalJoinCount: () => 9,
		});
		assert.equal(driver.physicalJoinCount?.({} as never), 9);
	});
});

describe('published boundary', () => {
	test('shipped sources import the contract type-only', () => {
		// A runtime import would put the frozen leaf — and anything it ever grows
		// a dependency on — into this package's runtime graph, which is the
		// dependency the CI zero-dependency assertion exists to forbid.
		const offenders: string[] = [];
		for (const file of readdirSync(new URL('.', import.meta.url))) {
			if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
			const source = readFileSync(new URL(file, import.meta.url), 'utf8');
			for (const statement of source.match(/^import[\s\S]*?from\s+'[^']+';$/gm) ?? []) {
				if (!statement.includes('multicast-contract')) continue;
				if (!/^import\s+type\s/.test(statement)) offenders.push(`${file}: ${statement}`);
			}
		}
		assert.deepEqual(offenders, []);
	});
});
