import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	assertCapabilitiesRedacted,
	assertLocationOutsideReadiness as assertLocationInvariant,
	checkBinaryIntegrity,
	checkCollapse,
	checkEarlyBytesHandoff,
	checkErrorCodesCrossRealm,
	checkLifecycle,
	checkLocationOutsideReadiness as checkLocationInvariant,
	checkTransportChangeEmitted,
	checkUnsubscribeCompletes,
	runConformanceSuite,
	summarize,
	type CheckResult,
	type ConformanceDriver,
} from './conformance.ts';
import { FakeMulticastProvider } from './fake-gateway.ts';
import {
	EARLY_BYTES_RETENTION_LIMIT,
	type Capabilities,
	type SubscribeConfig,
} from './gateway.ts';
import type { ReadinessObservation } from './readiness.ts';

const readyObservation: ReadinessObservation = {
	provider: {
		providerGlobalPresent: true,
		extensionResponded: true,
		iwaInstalled: true,
		iwaExtensionConnected: true,
	},
	socketWorker: {
		api: true,
		ready: true,
		directSockets: { available: true, udp: true, tcp: true, tcpServer: true, udpBind: true },
	},
	permissions: { 'local-network': 'granted', 'loopback-network': 'granted' },
};

describe('the reference provider is conformant', () => {
	test('every check passes, and none is skipped', async () => {
		const report = await runConformanceSuite(new FakeMulticastProvider());
		const failures = report.checks.filter((check) => check.status !== 'pass');
		assert.deepEqual(
			failures.map((check) => `${check.id}: ${check.detail}`),
			[],
		);
		assert.equal(report.conformant, true);
		assert.equal(report.skipped, 0);
	});
});

/**
 * Negative controls.
 *
 * A conformance check that cannot fail is worse than no check: it reports
 * coverage it does not have. Each case below breaks exactly one guarantee and
 * asserts that the corresponding check notices — so the suite is verified
 * against a known-bad provider, not only against a known-good one.
 */
describe('each check fails on a provider that violates its guarantee', () => {
	test('binary integrity catches a byteLength-less payload (the BLO-4339 shape)', async () => {
		const provider = new FakeMulticastProvider();
		const driver: ConformanceDriver = {
			gateway: {
				...provider.gateway,
				subscribe: async (config) => {
					const subscription = await provider.gateway.subscribe(config);
					return {
						...subscription,
						addEventListener: (type, listener, options) => {
							// Hand the page a JSON-collapsed object instead of an ArrayBuffer.
							const wrapped = ((event: Event) => {
								if (type !== 'bytes') return (listener as (ev: Event) => void)(event);
								return (listener as (ev: Event) => void)(
									new CustomEvent('bytes', { detail: {} as never }),
								);
							}) as never;
							subscription.addEventListener(type, wrapped, options);
						},
					};
				},
			},
			deliverBytes: (config, payloads) => provider.deliverBytes(config, payloads),
		};
		const result = await checkBinaryIntegrity(driver);
		assert.equal(result.status, 'fail');
		assert.match(result.detail, /not an ArrayBuffer/);
	});

	test('early-bytes catches a provider that replays a partial prefix after overflow', async () => {
		// A provider that keeps the most recent 128 instead of dropping the whole
		// prefix. It looks healthier — and it fabricates a gap-free stream.
		const provider = new SlidingWindowProvider();
		const result = await checkEarlyBytesHandoff(provider);
		assert.equal(result.status, 'fail');
		assert.match(result.detail, /drop the entire prefix/);
	});

	test('transportchange catches a receiver that resolves silently', async () => {
		const provider = new FakeMulticastProvider();
		const result = await checkTransportChangeEmitted({
			gateway: provider.gateway,
			// Assigns the transport without announcing it — the documented
			// "notifies nobody" path that freeze §3.1 outlaws.
			resolveTransport: () => {},
		});
		assert.equal(result.status, 'fail');
	});

	test('unsubscribe catches a provider that sets closed without announcing it', async () => {
		const provider = new FakeMulticastProvider();
		const result = await checkUnsubscribeCompletes({
			gateway: {
				...provider.gateway,
				subscribe: async (config) => {
					const inner = await provider.gateway.subscribe(config);
					let state = inner.state;
					return {
						...inner,
						get state() {
							return state;
						},
						addEventListener: (type, listener, options) => {
							if (type === 'state') return; // swallow the announcement
							inner.addEventListener(type, listener, options);
						},
						unsubscribe: async () => {
							state = 'closed';
							await inner.unsubscribe();
						},
					};
				},
			},
		});
		assert.equal(result.status, 'fail');
		assert.match(result.detail, /no state event announced it/);
	});

	test('collapse catches a provider that opens one physical join per consumer', async () => {
		const provider = new FakeMulticastProvider();
		const result = await checkCollapse({
			gateway: provider.gateway,
			deliverBytes: (config, payloads) => provider.deliverBytes(config, payloads),
			// Report the truth for a non-collapsing provider: one join per consumer.
			physicalJoinCount: (config) => provider.physicalJoinCount(config) * 2,
		});
		assert.equal(result.status, 'fail');
		assert.match(result.detail, /expected 1/);
	});

	test('error codes catch a rejection with no usable code', async () => {
		const provider = new FakeMulticastProvider();
		const result = await checkErrorCodesCrossRealm({
			gateway: {
				...provider.gateway,
				// A bare Error with no `.code` — the deployed bridge's subscribe
				// timeout has exactly this shape.
				subscribe: () => Promise.reject(new Error('Subscribe timeout')),
			},
		});
		assert.equal(result.status, 'fail');
		assert.match(result.detail, /no usable \.code/);
	});

	/**
	 * One case per coordinate. `tailscale` is NOT declared on the public
	 * `TransportCapabilityReport` any more (BLO-33832) — which is exactly why it
	 * needs a test: the type says the field cannot exist, the runtime says it
	 * can, and the check has to believe the runtime. The `as unknown as` hop
	 * models a provider structurally assigning an internal report.
	 */
	for (const [label, member, key, value, pattern] of [
		['an AMT relay address', 'amt', 'relay', '198.51.100.7', /transports\.amt\.relay/],
		['a WHIP endpoint', 'whip', 'endpoint', 'https://whip.example/ingest', /transports\.whip\.endpoint/],
		['a mesh peer address the public type no longer declares', 'tailscale', 'peer', '100.64.0.7', /transports\.tailscale\.peer/],
	] as const) {
		test(`redaction catches ${label}`, () => {
			const leaky = {
				iwaVersion: 'leaky',
				consumeModes: ['bytes'],
				transports: {
					nativeMulticast: { confirmed: true },
					amt: { available: true },
					moqRelay: { reachable: false },
					whip: { available: false },
					webTransportBridge: false,
					observedAt: 0,
					[member]: { available: true, [key]: value },
				},
				plugins: [],
			} as unknown as Capabilities;
			const result = assertCapabilitiesRedacted(leaky);
			assert.equal(result.status, 'fail');
			assert.match(result.detail, pattern);
		});
	}

	test('redaction tolerates a provider that sends no transports at all', () => {
		// Must produce a verdict, not a TypeError — a thrown conformance check
		// reports nothing, which reads as "not run" rather than "leaked".
		assert.equal(assertCapabilitiesRedacted({} as unknown as Capabilities).status, 'pass');
	});
});

describe('lifecycle and location', () => {
	test('a transport bounce is fully observable', async () => {
		const result = await checkLifecycle(new FakeMulticastProvider());
		assert.equal(result.status, 'pass');
	});

	test('readiness is invariant across every location permission result', () => {
	assert.equal(assertLocationInvariant(readyObservation).status, 'pass');
	});

	test('the suite itself observes location independence, on every readiness path', () => {
		// The README advertises that the conformance suite pins location
		// independence. If the suite does not actually run the check, a future
		// readiness edit could make location load-bearing while `conformant`
		// still reports true — the guarantee would be advertised but unobserved.
		const result = checkLocationInvariant();
		assert.equal(result.status, 'pass');
		assert.match(result.detail, /readiness paths/);
	});

	test('the published report cannot be conformant without the location check', async () => {
		const report = await runConformanceSuite(new FakeMulticastProvider());
		const ids = report.checks.map((check) => check.id);
		assert.ok(
			ids.includes('location-outside-readiness-suite'),
			`suite must run the location check; ran: ${ids.join(', ')}`,
		);
	});
});

describe('summarize', () => {
	test('a skipped check is never counted as conformant', () => {
		const checks: CheckResult[] = [
			{ id: 'a', title: 'a', status: 'pass', detail: '' },
			{ id: 'b', title: 'b', status: 'skipped', detail: 'driver hook absent' },
		];
		const report = summarize(checks);
		assert.equal(report.failed, 0);
		assert.equal(report.skipped, 1);
		assert.equal(
			report.conformant,
			false,
			'a run with an unobserved guarantee must not report as conformant',
		);
	});

	test('a driver with no control hooks skips rather than passes', async () => {
		const provider = new FakeMulticastProvider();
		const report = await runConformanceSuite({ gateway: provider.gateway });
		assert.ok(report.skipped > 0);
		assert.equal(report.conformant, false);
	});
});

/**
 * A provider that retains a sliding window of the most recent payloads instead
 * of dropping the whole prefix on overflow. Used only as a negative control.
 *
 * Standalone rather than a wrapper around `FakeMulticastProvider`: delegating
 * would leave both providers buffering the same prefix and replay it twice, so
 * the control would fail for the wrong reason.
 */
class SlidingWindowProvider implements ConformanceDriver {
	readonly #consumers = new Map<
		string,
		{ target: EventTarget; retained: ArrayBuffer[]; attached: boolean; key: string }
	>();
	#nextId = 0;

	get gateway() {
		return {
			subscribe: (config: SubscribeConfig) => {
				this.#nextId += 1;
				const id = `sliding-${this.#nextId}`;
				const entry = {
					target: new EventTarget(),
					retained: [] as ArrayBuffer[],
					attached: false,
					key: JSON.stringify(config),
				};
				this.#consumers.set(id, entry);
				return Promise.resolve({
					id,
					state: 'connecting' as const,
					addEventListener: (
						type: string,
						listener: (event: never) => void,
						options?: AddEventListenerOptions | boolean,
					) => {
						entry.target.addEventListener(type, listener as EventListener, options);
						if (type === 'bytes' && !entry.attached) {
							entry.attached = true;
							for (const payload of entry.retained) {
								entry.target.dispatchEvent(new CustomEvent('bytes', { detail: payload }));
							}
							entry.retained = [];
						}
					},
					removeEventListener: () => {},
					setPacketIds: () => Promise.resolve(),
					unsubscribe: () => {
						this.#consumers.delete(id);
						return Promise.resolve();
					},
				} as never);
			},
			capabilities: () => Promise.reject(new Error('not needed for this control')),
		} as never;
	}

	physicalJoinCount(config: SubscribeConfig): number {
		const key = JSON.stringify(config);
		return [...this.#consumers.values()].some((entry) => entry.key === key) ? 1 : 0;
	}

	deliverBytes(config: SubscribeConfig, payloads: readonly Uint8Array[]): void {
		const key = JSON.stringify(config);
		for (const entry of this.#consumers.values()) {
			if (entry.key !== key) continue;
			for (const payload of payloads) {
				const copy = payload.slice().buffer;
				if (entry.attached) {
					entry.target.dispatchEvent(new CustomEvent('bytes', { detail: copy }));
					continue;
				}
				entry.retained.push(copy);
				// The bug under test: evict the oldest instead of dropping the prefix.
				if (entry.retained.length > EARLY_BYTES_RETENTION_LIMIT) entry.retained.shift();
			}
		}
	}
}
