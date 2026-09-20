/**
 * A reference-conformant in-memory `window.multicast` provider.
 *
 * It is the executable definition of "what a conformant provider does" —
 * `runConformanceSuite` passes against it by construction, so a check that this
 * fake fails is a bug in the check. And it replaces the six independent,
 * mutually-drifting inline `window.multicast = {…}` stubs that consumer tests
 * currently hand-roll (measured: `test-cdn-ssm-iwa-amt.mjs`,
 * `clock-timing-page.test.mjs`, `transport-aware-bridge-fallback.test.mjs`, and
 * three `e2e/tests/scenario-*.spec.mjs`), each covering a different subset of
 * the surface.
 *
 * It deliberately marshals bytes through the same base64 hop the real transport
 * uses (see `GatewayEventWire`), so a consumer test that passes here would also
 * survive the JSON-serialization boundary that collapsed raw ArrayBuffers. A fake that
 * handed out the original `ArrayBuffer` would let that whole class through.
 *
 * No timers anywhere: delivery, state, and teardown are all caller-driven, per
 * the repo's lifecycle rule.
 */

import {
	EARLY_BYTES_RETENTION_LIMIT,
	MulticastError,
	type Capabilities,
	type MulticastGateway,
	type ResolvedTransport,
	type SubscribeConfig,
	type Subscription,
	type SubscriptionState,
	type ThroughputHistory,
	type ThroughputSubscriptionSample,
	THROUGHPUT_MIN_SAMPLE_INTERVAL_MILLISECONDS,
	THROUGHPUT_WINDOW_MILLISECONDS,
} from './gateway.ts';
import type { ConformanceDriver } from './conformance.ts';

function bytesToBase64(payload: Uint8Array): string {
	let binary = '';
	for (const byte of payload) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToArrayBuffer(encoded: string): ArrayBuffer {
	const binary = atob(encoded);
	const out = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
	return out.buffer;
}

/**
 * Canonical collapse identity for a config.
 *
 * Options are key-sorted and `undefined` values dropped so that two literals
 * differing only in property order or in an explicitly-undefined field still
 * collapse. `source` normalizes to `'*'` for ASM, matching the deployed key.
 */
function collapseKey(config: SubscribeConfig): string {
	if (config.origin === 'tuner' && config.standard === 'atsc1') {
		return JSON.stringify({ origin: 'tuner', standard: 'atsc1', protocol: 'mpeg-ts' });
	}
	const withAddress = config as Extract<SubscribeConfig, { group: string }>;
	const endpoint = {
		source: withAddress.source ?? '*',
		group: withAddress.group,
		port: Number(withAddress.port),
	};
	const options: Record<string, unknown> = {};
	if (config.origin !== undefined) options['origin'] = config.origin;
	if (config.origin === 'amt') {
		options['relay'] = config.relay;
		options['relayPort'] = config.relayPort;
	}
	const sorted = Object.fromEntries(
		Object.entries(options)
			.filter(([, value]) => value !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
	);
	return JSON.stringify({ endpoint, options: sorted });
}

interface LogicalConsumer {
	readonly id: string;
	readonly target: EventTarget;
	state: SubscriptionState;
	bytesListenerAttached: boolean;
	earlyBytes: ArrayBuffer[];
	earlyBytesOverflowed: boolean;
	closed: boolean;
}

interface PhysicalReceiver {
	readonly key: string;
	readonly id: string;
	transport: ResolvedTransport;
	bytesReceived: number;
	readonly consumers: Set<LogicalConsumer>;
}

export interface FakeMulticastProviderOptions {
	readonly iwaVersion?: string;
	/**
	 * Capability report handed to the page. Defaults to a redacted report; supply
	 * an unredacted one to exercise `assertCapabilitiesRedacted` negatively.
	 */
	readonly capabilities?: Capabilities;
}

function defaultCapabilities(iwaVersion: string): Capabilities {
	return {
		iwaVersion,
		originContractVersion: 1,
		consumeModes: ['bytes'],
		// Redacted by construction: no relay, endpoint, or peer.
		transports: {
			nativeMulticast: { confirmed: true },
			amt: { available: true },
			moqRelay: { reachable: false },
			whip: { available: false },
			webTransportBridge: false,
			networkHint: 'unknown',
			observedAt: 0,
		},
		plugins: [],
		origins: ['ip-multicast', 'amt', 'tuner'],
		tuners: ['atsc1', 'atsc3'],
		addressFamilies: ['ipv4', 'ipv6'],
	};
}

/**
 * In-memory provider plus the control hooks the conformance suite needs.
 * Implements `ConformanceDriver`, so it can be handed straight to
 * `runConformanceSuite`.
 */
export class FakeMulticastProvider implements ConformanceDriver {
	readonly #receivers = new Map<string, PhysicalReceiver>();
	readonly #capabilities: Capabilities;
	#nextId = 0;

	constructor(options: FakeMulticastProviderOptions = {}) {
		const iwaVersion = options.iwaVersion ?? 'fake-provider-1';
		this.#capabilities = options.capabilities ?? defaultCapabilities(iwaVersion);
	}

	get gateway(): MulticastGateway {
		return {
			subscribe: (config) => this.#subscribe(config),
			capabilities: () => Promise.resolve(this.#capabilities),
			getThroughputHistory: () => this.#throughputHistory(),
		};
	}

	// ---- ConformanceDriver control surface -------------------------------

	physicalJoinCount(config: SubscribeConfig): number {
		return this.#receivers.has(collapseKey(config)) ? 1 : 0;
	}

	deliverBytes(config: SubscribeConfig, payloads: readonly Uint8Array[]): void {
		const receiver = this.#requireReceiver(config, 'deliverBytes');
		for (const payload of payloads) {
			// Marshal through the real wire encoding, not a shortcut.
			const decoded = base64ToArrayBuffer(bytesToBase64(payload));
			receiver.bytesReceived += payload.byteLength;
			for (const consumer of receiver.consumers) this.#deliverToConsumer(consumer, decoded);
		}
	}

	resolveTransport(config: SubscribeConfig, transport: ResolvedTransport): void {
		const receiver = this.#requireReceiver(config, 'resolveTransport');
		receiver.transport = transport;
		// Emission is unconditional on resolution: a receiver that assigns its
		// transport without announcing it notifies nobody (freeze §3.1).
		for (const consumer of receiver.consumers) {
			consumer.target.dispatchEvent(
				new CustomEvent<ResolvedTransport>('transportchange', { detail: transport }),
			);
		}
	}

	forceState(config: SubscribeConfig, state: SubscriptionState): void {
		const receiver = this.#requireReceiver(config, 'forceState');
		for (const consumer of receiver.consumers) this.#setConsumerState(consumer, state);
	}

	// ---- internals -------------------------------------------------------

	#requireReceiver(config: SubscribeConfig, operation: string): PhysicalReceiver {
		const receiver = this.#receivers.get(collapseKey(config));
		if (!receiver) {
			throw new Error(`${operation}: no active receiver for this config`);
		}
		return receiver;
	}

	#subscribe(config: SubscribeConfig): Promise<Subscription> {
		if (typeof config !== 'object' || config === null) {
			return Promise.reject(
				new MulticastError('subscription-failed', 'subscribe() requires a config object.'),
			);
		}
		// `!== undefined` is load-bearing, and this reference provider must carry
		// the same split as every live one or it becomes the odd provider out —
		// which is the consume-mode defect one input over. `consume` is REQUIRED, so
		// omitting it is a malformed request that keeps `subscription-failed`.
		if (config.consume !== undefined && config.consume !== 'bytes') {
			return Promise.reject(
				new MulticastError(
					'capability-unsupported',
					`Unsupported consume mode: ${String((config as { consume?: unknown }).consume)}`,
				),
			);
		}
		if (config.consume === undefined) {
			return Promise.reject(
				new MulticastError('subscription-failed', "subscribe() requires consume: 'bytes'."),
			);
		}
		const isAddresslessTuner = config.origin === 'tuner' && config.standard === 'atsc1';
		if (!isAddresslessTuner) {
			const withAddress = config as Extract<SubscribeConfig, { group: string }>;
			if (typeof withAddress.group !== 'string' || !Number.isFinite(Number(withAddress.port))) {
				return Promise.reject(
					new MulticastError(
						'subscription-failed',
						'subscribe() requires group and numeric port.',
					),
				);
			}
		}

		const key = collapseKey(config);
		let receiver = this.#receivers.get(key);
		if (!receiver) {
			this.#nextId += 1;
			receiver = {
				key,
				id: `physical-${this.#nextId}`,
				transport: 'native',
				bytesReceived: 0,
				consumers: new Set(),
			};
			this.#receivers.set(key, receiver);
		}

		this.#nextId += 1;
		const consumer: LogicalConsumer = {
			id: `logical-${this.#nextId}`,
			target: new EventTarget(),
			state: 'connecting',
			bytesListenerAttached: false,
			earlyBytes: [],
			earlyBytesOverflowed: false,
			closed: false,
		};
		receiver.consumers.add(consumer);
		const boundReceiver = receiver;

		// Not an EventTarget subclass: the contract exposes exactly the two
		// listener methods, so `dispatchEvent` must not be reachable from a page.
		const subscription: Subscription = {
			id: consumer.id,
			get state() {
				return consumer.state;
			},
			addEventListener: (type, listener, options) => {
				consumer.target.addEventListener(type, listener as EventListener, options);
				if (type === 'bytes' && !consumer.bytesListenerAttached) {
					consumer.bytesListenerAttached = true;
					const buffered = consumer.earlyBytes;
					consumer.earlyBytes = [];
					for (const payload of buffered) {
						consumer.target.dispatchEvent(
							new CustomEvent<ArrayBuffer>('bytes', { detail: payload }),
						);
					}
				}
			},
			removeEventListener: (type, listener, options) => {
				consumer.target.removeEventListener(type, listener as EventListener, options);
			},
			setPacketIds: (packetIds) => {
				if (consumer.closed) {
					return Promise.reject(
						new MulticastError('subscription-failed', 'Subscription is closed.'),
					);
				}
				if (!Array.isArray(packetIds) || packetIds.some((id) => !Number.isInteger(id))) {
					return Promise.reject(
						new MulticastError('subscription-failed', 'packetIds must be integers.'),
					);
				}
				return Promise.resolve();
			},
			unsubscribe: () => {
				if (consumer.closed) return Promise.resolve();
				consumer.closed = true;
				consumer.earlyBytes = [];
				consumer.earlyBytesOverflowed = false;
				boundReceiver.consumers.delete(consumer);
				// Announce, don't just assign: a consumer must be able to observe
				// its own teardown.
				this.#setConsumerState(consumer, 'closed');
				if (boundReceiver.consumers.size === 0) {
					this.#receivers.delete(boundReceiver.key);
				}
				return Promise.resolve();
			},
		};
		return Promise.resolve(subscription);
	}

	#setConsumerState(consumer: LogicalConsumer, state: SubscriptionState): void {
		if (consumer.state === state) return;
		consumer.state = state;
		consumer.target.dispatchEvent(
			new CustomEvent<SubscriptionState>('state', { detail: state }),
		);
	}

	#deliverToConsumer(consumer: LogicalConsumer, payload: ArrayBuffer): void {
		if (consumer.closed) return;
		if (!consumer.bytesListenerAttached) {
			// Once the prefix has overflowed, nothing further is retained: a
			// partial prefix followed by live bytes would look gap-free.
			if (consumer.earlyBytesOverflowed) return;
			if (consumer.earlyBytes.length >= EARLY_BYTES_RETENTION_LIMIT) {
				consumer.earlyBytes = [];
				consumer.earlyBytesOverflowed = true;
				return;
			}
			consumer.earlyBytes.push(payload);
			return;
		}
		consumer.target.dispatchEvent(new CustomEvent<ArrayBuffer>('bytes', { detail: payload }));
	}

	#throughputHistory(): ThroughputHistory {
		const subscriptions: ThroughputSubscriptionSample[] = [...this.#receivers.values()].map(
			(receiver) => ({
				id: receiver.id,
				transport: receiver.transport,
				// Derived at sample time, never a stored counter: logical fan-out
				// must not multiply the physical byte count.
				logicalConsumers: receiver.consumers.size,
				bytesReceived: receiver.bytesReceived,
				bitsPerSecond: null,
				rateUnavailableReason: 'initial-baseline',
			}),
		);
		return {
			version: 1,
			accounting: 'physical-multicast-ingress',
			vantage: 'page-bridge',
			windowMilliseconds: THROUGHPUT_WINDOW_MILLISECONDS,
			minSampleIntervalMilliseconds: THROUGHPUT_MIN_SAMPLE_INTERVAL_MILLISECONDS,
			samples: [
				{
					timestampMilliseconds: 0,
					aggregateBitsPerSecond: null,
					aggregateRateUnavailableReason: 'initial-baseline',
					subscriptions,
				},
			],
		};
	}
}
