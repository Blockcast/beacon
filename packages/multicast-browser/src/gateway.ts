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
