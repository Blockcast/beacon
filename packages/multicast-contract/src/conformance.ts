/**
 * Executable conformance suite for the frozen v1 `window.multicast` contract.
 *
 * Every check here corresponds to a behaviour the v1 contract freeze (§6.5) named
 * as a verifying signal, and each one exists because the behaviour has a known
 * silent-failure mode — a provider can violate it while still looking healthy.
 *
 * The suite runs against a `ConformanceDriver` rather than against a browser, so
 * one definition of "conformant" covers the page providers, the test double in
 * ./fake-gateway.ts, and the iOS/Android adapters, which supply their own
 * drivers. A check whose driver hook is absent reports `skipped` and is counted
 * separately — a skipped check is NOT a pass, and `summarize` refuses to call a
 * run conformant while any check was skipped.
 */

import {
	EARLY_BYTES_RETENTION_LIMIT,
	MULTICAST_ERROR_CODES,
	multicastErrorCodeOf,
	type Capabilities,
	type MulticastErrorCode,
	type MulticastGateway,
	type ResolvedTransport,
	type SubscribeConfig,
	type Subscription,
	type SubscriptionState,
} from './gateway.ts';
import {
	evaluateReadiness,
	type ReadinessObservation,
} from './readiness.ts';

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
	readonly id: string;
	readonly title: string;
	readonly status: CheckStatus;
	readonly detail: string;
}

/**
 * Control surface a provider must expose to be conformance-testable.
 *
 * Only `gateway` is mandatory. Each optional hook gates the checks that cannot
 * be observed without it; those report `skipped` rather than silently passing.
 */
export interface ConformanceDriver {
	readonly gateway: MulticastGateway;
	/** Deliver payloads to the physical receiver backing `config`. */
	deliverBytes?(config: SubscribeConfig, payloads: readonly Uint8Array[]): Promise<void> | void;
	/** Drive a transport resolution on the receiver backing `config`. */
	resolveTransport?(config: SubscribeConfig, transport: ResolvedTransport): Promise<void> | void;
	/** Drive a lifecycle transition on the receiver backing `config`. */
	forceState?(config: SubscribeConfig, state: SubscriptionState): Promise<void> | void;
	/** Number of PHYSICAL joins currently open for `config`. The collapse oracle. */
	physicalJoinCount?(config: SubscribeConfig): number;
}

function pass(id: string, title: string, detail: string): CheckResult {
	return { id, title, status: 'pass', detail };
}
function fail(id: string, title: string, detail: string): CheckResult {
	return { id, title, status: 'fail', detail };
}
function skip(id: string, title: string, detail: string): CheckResult {
	return { id, title, status: 'skipped', detail };
}

/** A distinct, ordinary IP-multicast config for checks that need one. */
function sampleConfig(seed: number): SubscribeConfig {
	return { group: `232.0.0.${seed}`, port: 9876, consume: 'bytes' };
}

function collect<K extends 'bytes' | 'state' | 'transportchange'>(
	subscription: Subscription,
	type: K,
): Array<K extends 'bytes' ? ArrayBuffer : K extends 'state' ? SubscriptionState : ResolvedTransport> {
	const seen: unknown[] = [];
	subscription.addEventListener(type, (event) => {
		seen.push((event as CustomEvent<unknown>).detail);
	});
	return seen as never;
}

/**
 * Binary integrity across the base64 hop (the ArrayBuffer-collapse regression).
 *
 * The failure this catches is silent by construction: a raw `ArrayBuffer` sent
 * over the JSON-serialized extension hop arrives as `{}` with
 * `byteLength === undefined`, so a consumer's sequence-tracking branch is never
 * entered and the stream looks merely empty rather than broken. Asserting
 * `byteLength` and the exact bytes is what distinguishes the two.
 */
export async function checkBinaryIntegrity(driver: ConformanceDriver): Promise<CheckResult> {
	const id = 'binary-integrity';
	const title = 'bytes arrive as an ArrayBuffer with intact byteLength and payload';
	if (!driver.deliverBytes) return skip(id, title, 'driver.deliverBytes not supplied');

	const config = sampleConfig(11);
	const subscription = await driver.gateway.subscribe(config);
	const received = collect(subscription, 'bytes');
	const payload = Uint8Array.from([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80]);
	await driver.deliverBytes(config, [payload]);
	await subscription.unsubscribe();

	if (received.length !== 1) {
		return fail(id, title, `expected exactly 1 bytes event, observed ${received.length}`);
	}
	const [buffer] = received;
	if (!(buffer instanceof ArrayBuffer)) {
		return fail(id, title, `bytes detail is ${Object.prototype.toString.call(buffer)}, not an ArrayBuffer`);
	}
	if (buffer.byteLength !== payload.byteLength) {
		return fail(
			id,
			title,
			`byteLength is ${String(buffer.byteLength)}, expected ${payload.byteLength} (ArrayBuffer-collapse signature)`,
		);
	}
	const roundTripped = Array.from(new Uint8Array(buffer));
	if (roundTripped.join(',') !== Array.from(payload).join(',')) {
		return fail(id, title, `payload corrupted: got [${roundTripped.join(', ')}]`);
	}
	return pass(id, title, `${payload.byteLength} bytes round-tripped intact`);
}

/**
 * Early-bytes retention and the overflow cliff.
 *
 * Two branches, and the second is the one that matters: on overflow the ENTIRE
 * retained prefix must be dropped with no replay. Replaying a prefix and then
 * resuming live delivery fabricates a gap-free stream across a real
 * discontinuity, which a late-attaching player cannot detect.
 */
export async function checkEarlyBytesHandoff(driver: ConformanceDriver): Promise<CheckResult> {
	const id = 'early-bytes-handoff';
	const title = 'retains a bounded byte prefix, and drops the whole prefix on overflow';
	if (!driver.deliverBytes) return skip(id, title, 'driver.deliverBytes not supplied');

	const withinConfig = sampleConfig(12);
	const withinSubscription = await driver.gateway.subscribe(withinConfig);
	const under = Array.from({ length: EARLY_BYTES_RETENTION_LIMIT }, (_unused, index) =>
		Uint8Array.from([index & 0xff]),
	);
	await driver.deliverBytes(withinConfig, under);
	const replayed = collect(withinSubscription, 'bytes');
	await withinSubscription.unsubscribe();

	if (replayed.length !== EARLY_BYTES_RETENTION_LIMIT) {
		return fail(
			id,
			title,
			`at the ${EARLY_BYTES_RETENTION_LIMIT}-payload limit, expected the whole prefix replayed on listener attach, observed ${replayed.length}`,
		);
	}

	const overflowConfig = sampleConfig(13);
	const overflowSubscription = await driver.gateway.subscribe(overflowConfig);
	await driver.deliverBytes(overflowConfig, [...under, Uint8Array.from([0xaa])]);
	const afterOverflow = collect(overflowSubscription, 'bytes');
	await overflowSubscription.unsubscribe();

	if (afterOverflow.length !== 0) {
		return fail(
			id,
			title,
			`overflowing the ${EARLY_BYTES_RETENTION_LIMIT}-payload limit must drop the entire prefix, but ${afterOverflow.length} payloads were replayed — a consumer cannot see the gap`,
		);
	}
	return pass(
		id,
		title,
		`prefix of ${EARLY_BYTES_RETENTION_LIMIT} replayed; prefix of ${EARLY_BYTES_RETENTION_LIMIT + 1} dropped whole`,
	);
}

/**
 * `transportchange` must be emitted on every resolution.
 *
 * The retired lowercase API documented the silent-failure path explicitly: a
 * receiver that resolves by assigning its `transport` field "notifies nobody",
 * and consumers needing that case had to read `transport` per packet. Freeze
 * §3.1 makes emission mandatory; this is the machine check.
 */
export async function checkTransportChangeEmitted(driver: ConformanceDriver): Promise<CheckResult> {
	const id = 'transportchange-emitted';
	const title = 'transportchange fires on every transport resolution';
	if (!driver.resolveTransport) return skip(id, title, 'driver.resolveTransport not supplied');

	const config = sampleConfig(14);
	const subscription = await driver.gateway.subscribe(config);
	const observed = collect(subscription, 'transportchange');
	await driver.resolveTransport(config, 'native');
	await driver.resolveTransport(config, 'amt');
	await subscription.unsubscribe();

	if (observed.join(',') !== 'native,amt') {
		return fail(
			id,
			title,
			`expected ['native','amt'], observed [${observed.map((value) => String(value)).join(', ')}]`,
		);
	}
	return pass(id, title, 'both resolutions were observable to the page');
}

/** Lifecycle: connecting → connected, and a transport bounce round trip. */
export async function checkLifecycle(driver: ConformanceDriver): Promise<CheckResult> {
	const id = 'lifecycle';
	const title = 'connecting → connected, and connected → reconnecting → connected';
	if (!driver.forceState) return skip(id, title, 'driver.forceState not supplied');

	const config = sampleConfig(15);
	const subscription = await driver.gateway.subscribe(config);
	const states = collect(subscription, 'state');
	await driver.forceState(config, 'connected');
	await driver.forceState(config, 'reconnecting');
	await driver.forceState(config, 'connected');
	// Snapshot before teardown: unsubscribe legitimately appends `closed`, and
	// folding that into the bounce sequence would make this check fail against a
	// conformant provider.
	const bounce = [...states];
	await subscription.unsubscribe();

	if (bounce.join(',') !== 'connected,reconnecting,connected') {
		return fail(id, title, `observed state sequence [${bounce.join(', ')}]`);
	}
	return pass(id, title, 'bounce was fully observable');
}

/**
 * Unsubscribe must drive the subscription to `closed` and say so.
 *
 * A provider that flips its internal state field without dispatching the event
 * leaves a consumer listening for `state === 'closed'` unable to observe its own
 * teardown — measured on one of the two live page providers.
 */
export async function checkUnsubscribeCompletes(driver: ConformanceDriver): Promise<CheckResult> {
	const id = 'unsubscribe-completes';
	const title = 'unsubscribe() reaches state "closed" and announces it';
	const config = sampleConfig(16);
	const subscription = await driver.gateway.subscribe(config);
	const states = collect(subscription, 'state');
	await subscription.unsubscribe();

	if (subscription.state !== 'closed') {
		return fail(id, title, `state after unsubscribe is "${subscription.state}", expected "closed"`);
	}
	if (!states.includes('closed')) {
		return fail(
			id,
			title,
			'state reached "closed" but no state event announced it; a consumer cannot observe its own teardown',
		);
	}
	// Idempotence: a second unsubscribe must not throw or double-tear-down.
	await subscription.unsubscribe();
	return pass(id, title, 'closed, announced, and idempotent');
}

/**
 * Collapse: N identical subscribes ⇒ N independent event streams over ONE
 * physical join, with byte counters unmultiplied.
 */
export async function checkCollapse(driver: ConformanceDriver): Promise<CheckResult> {
	const id = 'collapse';
	const title = 'identical subscribes collapse onto one physical join';
	if (!driver.physicalJoinCount || !driver.deliverBytes) {
		return skip(id, title, 'driver.physicalJoinCount and driver.deliverBytes are both required');
	}

	const config = sampleConfig(17);
	const first = await driver.gateway.subscribe(config);
	const second = await driver.gateway.subscribe(config);
	const firstBytes = collect(first, 'bytes');
	const secondBytes = collect(second, 'bytes');

	const joins = driver.physicalJoinCount(config);
	if (joins !== 1) {
		await first.unsubscribe();
		await second.unsubscribe();
		return fail(id, title, `2 logical consumers opened ${joins} physical joins, expected 1`);
	}

	await driver.deliverBytes(config, [Uint8Array.from([0x42])]);
	if (firstBytes.length !== 1 || secondBytes.length !== 1) {
		await first.unsubscribe();
		await second.unsubscribe();
		return fail(
			id,
			title,
			`each consumer must receive its own copy; observed ${firstBytes.length} and ${secondBytes.length}`,
		);
	}

	// The physical join must survive the first teardown and only close on the last.
	await first.unsubscribe();
	const afterFirst = driver.physicalJoinCount(config);
	if (afterFirst !== 1) {
		await second.unsubscribe();
		return fail(
			id,
			title,
			`releasing 1 of 2 consumers closed the physical join (count ${afterFirst}); the surviving consumer is starved`,
		);
	}
	await second.unsubscribe();
	const afterLast = driver.physicalJoinCount(config);
	if (afterLast !== 0) {
		return fail(id, title, `physical join leaked after the last consumer released (count ${afterLast})`);
	}
	return pass(id, title, '1 physical join, 2 independent streams, released on the last consumer');
}

/**
 * Error codes must be comparable cross-realm via `.code`.
 *
 * `instanceof` is explicitly not part of the contract: the JSON-serialized
 * extension hop strips the prototype chain, and the two live providers do not
 * even agree on the thrown type.
 */
export async function checkErrorCodesCrossRealm(driver: ConformanceDriver): Promise<CheckResult> {
	const id = 'error-codes-cross-realm';
	const title = 'rejections carry a stable, documented .code';
	const invalid = { group: '232.0.0.18', port: 9876, consume: 'frames' } as unknown as SubscribeConfig;
	try {
		await driver.gateway.subscribe(invalid);
	} catch (error) {
		const code = multicastErrorCodeOf(error);
		if (code === null) {
			return fail(
				id,
				title,
				`rejection carried no usable .code (${String(error)}); cross-realm callers cannot branch on it`,
			);
		}
		if (!(MULTICAST_ERROR_CODES as readonly string[]).includes(code)) {
			return fail(id, title, `rejection carried undocumented code "${code}"`);
		}
		return pass(id, title, `rejected with documented code "${code}"`);
	}
	return fail(id, title, 'an unsupported consume mode was accepted instead of rejected');
}

/**
 * The rejected inputs, and the one code every provider must answer each with.
 *
 * Exported because it is the single source of truth for two consumers that
 * cannot share a runtime: this suite (behavioural, against a live gateway) and
 * `provider-consume-code.test.ts` (source-level, against the four provider
 * entry points that cannot all be imported into one process). A future edit
 * that re-diverges one provider fails whichever of the two can see it.
 *
 * There are TWO vectors because the boundary between them is itself the thing
 * that drifts: an explicitly supplied bad mode and an absent `consume` are
 * different rejections, and collapsing them is the exact defect this pair
 * catches. `consume` is a REQUIRED field of every SubscribeConfig member —
 * unlike `origin` and `source`, which are declared optional — so omitting it
 * is a bad request, not an absent capability.
 */
export const CONSUME_REJECTION_VECTORS = [
	{
		name: 'unsupported-consume-mode-is-capability-unsupported',
		why:
			'An unsupported consume mode is a capability the provider does not have, ' +
			'not a subscription that failed. Ratified in the RULING next to ' +
			'MulticastErrorCode after the extension and the window bridge ' +
			'were found answering the same input with different codes.',
		config: { group: '232.0.0.18', port: 9876, consume: 'frames' },
		expectErrorCode: 'capability-unsupported',
	},
	{
		name: 'missing-consume-is-subscription-failed',
		why:
			'A MISSING required field is a malformed request, not an absent ' +
			'capability. `capability-unsupported` tells a caller that retrying is ' +
			'pointless; for a caller who simply omitted `consume`, supplying it is ' +
			'exactly the fix, so that code would send them the wrong way.',
		config: { group: '232.0.0.18', port: 9876 },
		expectErrorCode: 'subscription-failed',
	},
] as const satisfies ReadonlyArray<{
	name: string;
	why: string;
	config: unknown;
	expectErrorCode: MulticastErrorCode;
}>;

/**
 * A rejected `consume` mode must carry the AGREED code, not merely a documented
 * one — and an ABSENT `consume` must not be mistaken for an unsupported one.
 *
 * `checkErrorCodesCrossRealm` above asks only that the code be usable and in
 * the documented set, which both of the divergent providers satisfied — that is
 * precisely why the divergence survived the contract freeze. This check pins
 * WHICH code, so reverting any provider to `subscription-failed` (or widening
 * its capability branch to swallow a missing field) fails here instead of
 * silently re-diverging.
 */
export async function checkConsumeRejectionAgreed(driver: ConformanceDriver): Promise<CheckResult> {
	const id = 'consume-rejection-code-agreed';
	const title = 'consume rejections carry the agreed code';
	for (const { name, config, expectErrorCode } of CONSUME_REJECTION_VECTORS) {
		let observed: string | null | undefined;
		try {
			await driver.gateway.subscribe(config as unknown as SubscribeConfig);
			return fail(id, title, `[${name}] the config was accepted instead of rejected`);
		} catch (error) {
			observed = multicastErrorCodeOf(error);
		}
		if (observed !== expectErrorCode) {
			return fail(
				id,
				title,
				`[${name}] rejected with "${String(observed)}" where the contract ratifies ` +
					`"${expectErrorCode}"; a cross-realm caller branching on .code now gets a ` +
					'provider-dependent answer',
			);
		}
	}
	return pass(id, title, `both consume rejections carried the ratified code`);
}

/**
 * Key names that carry a routing coordinate on the INTERNAL capability report:
 * a relay address, an ingress endpoint, a mesh peer address. None of the three
 * is ever page-actionable, on any transport member, present or future.
 *
 * Keyed by coordinate rather than by transport on purpose. Enumerating
 * `(member, key)` pairs pins the check to the member list of the day: it goes
 * stale the moment a transport is added, and — since the public type was
 * narrowed — it would also have to name members the type no longer declares,
 * putting internal path names back into the shipped bundle that the narrowing
 * removed. Scanning every member for these three keys is both stricter and
 * vendor-neutral.
 */
const COORDINATE_KEYS = ['relay', 'endpoint', 'peer'] as const;

/**
 * Infrastructure coordinates must not reach the page.
 *
 * The internal capability report carries routing coordinates for several
 * transport paths. Those are internal routing facts; the source definition
 * carries an explicit redaction obligation for page-level surfaces, and this
 * contract makes the report public API, so the obligation has to be enforced
 * rather than remembered.
 *
 * ⚠️ Reads the RUNTIME object, deliberately and permanently, and asserts more
 * than the public `TransportCapabilityReport` declares. TypeScript erases: a
 * provider that structurally assigns an internal report still sends every field
 * that report holds, including members the narrowed public type dropped. A
 * check written against the declared type can only catch the leaks the type
 * already admits to — i.e. exactly the ones least likely to happen. Do NOT
 * "simplify" this to match the type; that silently reopens the leak.
 *
 * Tolerates a malformed or absent `transports` rather than throwing: a
 * conformance check that throws reports nothing, which reads as "not run"
 * rather than "leaked".
 */
export function assertCapabilitiesRedacted(capabilities: Capabilities): CheckResult {
	const id = 'capabilities-redacted';
	const title = 'capabilities() does not leak infrastructure coordinates to the page';
	const transports = capabilities.transports as unknown as Record<string, unknown> | null | undefined;
	const leaked: string[] = [];
	for (const [member, value] of Object.entries(transports ?? {})) {
		if (typeof value !== 'object' || value === null) continue;
		for (const key of COORDINATE_KEYS) {
			if ((value as Record<string, unknown>)[key] !== undefined) {
				leaked.push(`transports.${member}.${key}`);
			}
		}
	}
	if (leaked.length > 0) {
		return fail(id, title, `page-visible capabilities leaked: ${leaked.join(', ')}`);
	}
	return pass(id, title, 'relay, endpoint, and peer are all absent');
}

export async function checkCapabilitiesRedacted(driver: ConformanceDriver): Promise<CheckResult> {
	return assertCapabilitiesRedacted(await driver.gateway.capabilities());
}

/**
 * Location must stay outside readiness.
 *
 * Ratified scope is "location is optional and outside subscription semantics".
 * That is easy to honour today and easy to break later by threading a
 * geolocation result into a readiness gate, so it is pinned: readiness must be
 * byte-identical across every possible location permission result.
 */
export function assertLocationOutsideReadiness(observation: ReadinessObservation): CheckResult {
	const id = 'location-outside-readiness';
	const title = 'readiness is independent of the optional location permission';
	const baseline = JSON.stringify(evaluateReadiness(observation));
	for (const geolocation of ['granted', 'prompt', 'denied', 'unsupported', 'unknown'] as const) {
		const withLocation = {
			...observation,
			// A location result must not be reachable by the readiness evaluator at
			// all; carrying it alongside must not perturb the outcome.
			permissions: { ...observation.permissions },
			location: { geolocation },
		} as ReadinessObservation;
		if (JSON.stringify(evaluateReadiness(withLocation)) !== baseline) {
			return fail(id, title, `readiness changed when location was "${geolocation}"`);
		}
	}
	return pass(id, title, 'readiness is invariant across all five location results');
}

/**
 * Observations spanning every distinct readiness outcome, used to run the
 * location-independence invariant without a driver.
 *
 * Pinning the invariant against ONE observation only proves location is ignored
 * on whichever path that observation happens to take. The guarantee is that
 * location is unreachable from the evaluator on EVERY path, so the check sweeps
 * a representative observation per readiness code — a future edit that consults
 * location inside a single branch is then still caught.
 */
function locationInvariantObservations(): readonly ReadinessObservation[] {
	const healthySockets = {
		available: true,
		udp: true,
		tcp: true,
		tcpServer: true,
		udpBind: true as boolean | null,
	};
	const granted = {
		'local-network': 'granted',
		'loopback-network': 'granted',
	} as const;
	const base: ReadinessObservation = {
		provider: {
			providerGlobalPresent: true,
			extensionResponded: true,
			iwaInstalled: true,
			iwaExtensionConnected: true,
		},
		socketWorker: { api: true, ready: true, directSockets: healthySockets },
		permissions: granted,
	};

	return [
		// ready
		base,
		// provider-unobservable
		{
			...base,
			provider: { ...base.provider, providerGlobalPresent: false, extensionResponded: null },
		},
		// provider-absent
		{ ...base, provider: { ...base.provider, providerGlobalPresent: false } },
		// iwa-not-installed
		{ ...base, provider: { ...base.provider, iwaInstalled: false } },
		// iwa-extension-disconnected
		{ ...base, provider: { ...base.provider, iwaExtensionConnected: false } },
		// socket-worker-unavailable
		{ ...base, socketWorker: { ...base.socketWorker, ready: false } },
		// direct-sockets-unavailable
		{
			...base,
			socketWorker: {
				...base.socketWorker,
				directSockets: { ...healthySockets, udp: false, available: false },
			},
		},
		// network-permission-denied
		{ ...base, permissions: { ...granted, 'local-network': 'denied' } },
		// network-permission-required
		{ ...base, permissions: { ...granted, 'loopback-network': 'prompt' } },
		// udp-bind-unverified
		{
			...base,
			socketWorker: {
				...base.socketWorker,
				directSockets: { ...healthySockets, udpBind: null },
			},
		},
		// udp-bind-failed
		{
			...base,
			socketWorker: {
				...base.socketWorker,
				directSockets: { ...healthySockets, udpBind: false },
			},
		},
	];
}

/**
 * Run the location-independence invariant across every readiness path.
 *
 * Driver-independent by construction: the guarantee is a property of
 * `evaluateReadiness`, not of any provider, so the suite can and must observe
 * it on every run rather than leaving it to callers.
 */
export function checkLocationOutsideReadiness(): CheckResult {
	const id = 'location-outside-readiness-suite';
	const title = 'readiness is independent of the optional location permission on every path';
	const observations = locationInvariantObservations();
	for (const observation of observations) {
		const result = assertLocationOutsideReadiness(observation);
		if (result.status !== 'pass') {
			return fail(id, title, `${evaluateReadiness(observation).code}: ${result.detail}`);
		}
	}
	return pass(
		id,
		title,
		`readiness is invariant across all five location results on ${observations.length} readiness paths`,
	);
}

export interface ConformanceReport {
	readonly checks: readonly CheckResult[];
	readonly passed: number;
	readonly failed: number;
	readonly skipped: number;
	/** True only when every check ran AND passed. A skip is never a pass. */
	readonly conformant: boolean;
}

export function summarize(checks: readonly CheckResult[]): ConformanceReport {
	const passed = checks.filter((check) => check.status === 'pass').length;
	const failed = checks.filter((check) => check.status === 'fail').length;
	const skipped = checks.filter((check) => check.status === 'skipped').length;
	return { checks, passed, failed, skipped, conformant: failed === 0 && skipped === 0 };
}

/** Run every driver-based check, in a fixed order, and summarize. */
export async function runConformanceSuite(driver: ConformanceDriver): Promise<ConformanceReport> {
	const checks: CheckResult[] = [];
	for (const check of [
		checkBinaryIntegrity,
		checkEarlyBytesHandoff,
		checkTransportChangeEmitted,
		checkLifecycle,
		checkUnsubscribeCompletes,
		checkCollapse,
		checkErrorCodesCrossRealm,
		checkConsumeRejectionAgreed,
		checkCapabilitiesRedacted,
	]) {
		checks.push(await check(driver));
	}
	// Driver-independent, so it always runs: the README advertises that the
	// suite pins location independence, and `report.conformant` must not be able
	// to go true while that guarantee is unobserved.
	checks.push(checkLocationOutsideReadiness());
	return summarize(checks);
}

export type { MulticastErrorCode };
