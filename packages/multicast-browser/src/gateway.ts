/**
 * Resolve the page-realm `window.multicast` provider against the frozen
 * contract, and expose it to the conformance suite.
 *
 * Resolution is a structural check, not a cast. Two different implementations
 * install this global — the extension's injected surface and the standalone
 * bridge polyfill — and either may be a partially-initialised object. A blind
 * `as MulticastGateway` turns that into a `TypeError` at the first `subscribe`
 * call, thousands of lines away from the cause.
 */

import type {
	MulticastGateway,
	ResolvedTransport,
	SubscribeConfig,
	SubscriptionState,
} from '@blockcast/multicast-contract';
import type { ConformanceDriver } from '@blockcast/multicast-contract/conformance';

import type { BrowserScope } from './observe.ts';

function defaultScope(): BrowserScope {
	return globalThis as unknown as BrowserScope;
}

/**
 * The minimum surface that makes a global usable as a gateway.
 *
 * `getThroughputHistory` is NOT required: the contract marks it optional
 * precisely because an older deployed provider predates throughput history v1,
 * and requiring it here would reject a working provider.
 */
function looksLikeGateway(candidate: unknown): candidate is MulticastGateway {
	if (typeof candidate !== 'object' || candidate === null) return false;
	const surface = candidate as Partial<MulticastGateway>;
	return typeof surface.subscribe === 'function' && typeof surface.capabilities === 'function';
}

/**
 * Resolve the installed provider, or `null` when no usable one is present.
 *
 * Returns rather than throws. The caller is usually deciding whether to offer
 * multicast at all, and an absent provider is the expected state on most pages —
 * not an exception. Pair with `observeReadiness` + `evaluateReadiness` for the
 * actionable reason a provider is missing or unusable.
 */
export function getGateway(scope: BrowserScope = defaultScope()): MulticastGateway | null {
	return looksLikeGateway(scope.multicast) ? scope.multicast : null;
}

/** Whether a usable provider is installed in this realm. */
export function hasGateway(scope: BrowserScope = defaultScope()): boolean {
	return getGateway(scope) !== null;
}

/**
 * Optional affordances a provider may expose so the conformance suite can drive
 * the physical receiver behind a logical subscription.
 *
 * A production provider implements none of these — there is no way to inject
 * bytes into a real multicast group from the page — and the suite reports those
 * checks `skipped` rather than failing them. A fake or a loopback harness
 * implements them, which is what makes the same suite runnable against both.
 */
export interface BrowserDriverHooks {
	deliverBytes?(config: SubscribeConfig, payloads: readonly Uint8Array[]): Promise<void> | void;
	resolveTransport?(config: SubscribeConfig, transport: ResolvedTransport): Promise<void> | void;
	forceState?(config: SubscribeConfig, state: SubscriptionState): Promise<void> | void;
	physicalJoinCount?(config: SubscribeConfig): number;
}

/**
 * Build a `ConformanceDriver` over the installed provider.
 *
 * Hooks are taken from the provider itself when it exposes them, so a harness
 * that installs a driver-shaped provider on `window.multicast` needs no extra
 * wiring; `hooks` overrides that for an out-of-band harness.
 *
 * Throws when no usable provider is installed: unlike `getGateway`, running a
 * conformance suite against nothing is a caller error, not an expected state.
 */
export function createBrowserConformanceDriver(
	scope: BrowserScope = defaultScope(),
	hooks: BrowserDriverHooks = {},
): ConformanceDriver {
	const gateway = getGateway(scope);
	if (gateway === null) {
		throw new Error(
			'No usable window.multicast provider is installed in this realm; ' +
				'call evaluateReadiness(await observeReadiness(...)) for the actionable reason.',
		);
	}
	const provider = scope.multicast as BrowserDriverHooks;
	const bind = <K extends keyof BrowserDriverHooks>(name: K): BrowserDriverHooks[K] => {
		const override = hooks[name];
		if (typeof override === 'function') return override;
		const own = provider[name];
		return typeof own === 'function'
			? (own as (...args: never[]) => unknown).bind(provider) as BrowserDriverHooks[K]
			: undefined;
	};
	const driver: ConformanceDriver = { gateway };
	const deliverBytes = bind('deliverBytes');
	const resolveTransport = bind('resolveTransport');
	const forceState = bind('forceState');
	const physicalJoinCount = bind('physicalJoinCount');
	return {
		...driver,
		...(deliverBytes ? { deliverBytes } : {}),
		...(resolveTransport ? { resolveTransport } : {}),
		...(forceState ? { forceState } : {}),
		...(physicalJoinCount ? { physicalJoinCount } : {}),
	};
}

/**
 * The event a provider dispatches on the page realm once `window.multicast` is
 * installed. The standalone bridge polyfill installs the global only after
 * discovery and a handshake, so it is genuinely asynchronous: a page that calls
 * `getGateway()` at startup routinely sees `null` for a provider that arrives a
 * moment later.
 */
export const GATEWAY_READY_EVENT = 'multicast-bridge-ready';

/** A scope that can also deliver the provider's ready event. */
export interface GatewayWaitScope extends BrowserScope {
	addEventListener?(type: string, listener: () => void): void;
	removeEventListener?(type: string, listener: () => void): void;
}

export interface WaitForGatewayOptions {
	/**
	 * How long to wait for a provider, in milliseconds. Required: absence is the
	 * expected state on most pages, so there is no deadline that suits every
	 * caller. `0` checks once and returns.
	 */
	readonly timeoutMs: number;
	/** Aborting resolves `null` at once and removes every listener and timer. */
	readonly signal?: AbortSignal;
	/**
	 * Re-check interval, in milliseconds (default 100, floor 10). Polling covers
	 * a provider that installs the global without dispatching the event, such as
	 * an extension's injected surface.
	 */
	readonly pollMs?: number;
}

/**
 * Resolve the installed provider, waiting up to `timeoutMs` for one to arrive.
 *
 * Resolves the gateway as soon as `getGateway` would return one: immediately if
 * it is already installed, on the provider's ready event, or on the next poll.
 * Resolves `null` on timeout or abort. Never rejects, for the same reason
 * `getGateway` returns rather than throws.
 *
 * A ready event is a hint, not a verdict: the global is re-resolved through the
 * same structural check, so an event that fires before a usable surface exists
 * does not resolve the wait.
 */
export function waitForGateway(
	options: WaitForGatewayOptions,
	scope: GatewayWaitScope = defaultScope() as GatewayWaitScope,
): Promise<MulticastGateway | null> {
	const existing = getGateway(scope);
	if (existing !== null) return Promise.resolve(existing);
	if (options.signal?.aborted) return Promise.resolve(null);

	const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 0;
	if (timeoutMs === 0) return Promise.resolve(null);
	const pollMs = Math.max(10, Number.isFinite(options.pollMs) ? (options.pollMs as number) : 100);

	return new Promise((resolve) => {
		let settled = false;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (gateway: MulticastGateway | null) => {
			if (settled) return;
			settled = true;
			if (pollTimer !== undefined) clearTimeout(pollTimer);
			clearTimeout(deadline);
			scope.removeEventListener?.(GATEWAY_READY_EVENT, check);
			options.signal?.removeEventListener('abort', onAbort);
			resolve(gateway);
		};
		function check(): void {
			const gateway = getGateway(scope);
			if (gateway !== null) finish(gateway);
		}
		const poll = () => {
			check();
			if (!settled) pollTimer = setTimeout(poll, pollMs);
		};
		const onAbort = () => finish(null);
		const deadline = setTimeout(() => finish(getGateway(scope)), timeoutMs);

		scope.addEventListener?.(GATEWAY_READY_EVENT, check);
		options.signal?.addEventListener('abort', onAbort, { once: true });
		pollTimer = setTimeout(poll, pollMs);
	});
}
