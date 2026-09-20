/**
 * Collect a `ReadinessObservation` from a live browser realm.
 *
 * `evaluateReadiness` in `@blockcast/multicast-contract` is a PURE function of a
 * caller-supplied observation — deliberately, because every gateway call routes
 * through `sendToIWA`, which auto-opens an IWA window as a side effect. That
 * purity is only useful if something actually assembles the observation, and
 * until this module nothing did: the contract package shipped with zero
 * consumers. This is the assembling half, and it is kept separate so the
 * side-effecting probes stay out of the frozen leaf.
 *
 * Every function here is a plain read. Nothing prompts, grants, or opens a
 * window — setup UX stays with the host (ratified in the contract freeze).
 */

import type {
	DirectSocketsObservation,
	LocalNetworkPermissionName,
	NetworkPermissionObservation,
	OptionalLocationObservation,
	PermissionResult,
	ProviderObservation,
	ReadinessObservation,
	SocketWorkerObservation,
} from '@blockcast/multicast-contract';

/** The legacy combined alias. Informational only — never gates readiness. */
export const LEGACY_LOCAL_NETWORK_PERMISSION = 'local-network-access';

/** The page-realm global the extension sets on its first inbound message. */
export const EXTENSION_AVAILABLE_FLAG = '__multicastExtensionAvailable';

/**
 * The subset of `window` this module reads. Declared structurally so the
 * adapter is testable without a DOM and usable from a worker or an IWA realm.
 */
export interface BrowserScope {
	readonly multicast?: unknown;
	readonly [EXTENSION_AVAILABLE_FLAG]?: unknown;
	readonly navigator?: {
		readonly permissions?: {
			query(descriptor: { name: string }): Promise<{ state: string }>;
		};
	};
}

function defaultScope(): BrowserScope {
	return globalThis as unknown as BrowserScope;
}

/**
 * Query one permission without prompting.
 *
 * Mirrors the deployed IWA probe. The
 * `unsupported`/`unknown` split is load-bearing and must not collapse into
 * `denied`: Chromium throws `TypeError` for permission names it does not
 * implement, and the local-network names have shipped under different spellings
 * across versions. Reporting "this build doesn't know the name" as a denial
 * sends the user to fix a permission that was never the problem.
 */
export async function queryPermission(
	name: string,
	scope: BrowserScope = defaultScope(),
): Promise<PermissionResult> {
	const permissions = scope.navigator?.permissions;
	if (!permissions?.query) return 'unsupported';
	try {
		const status = await permissions.query({ name });
		if (status.state === 'granted' || status.state === 'prompt' || status.state === 'denied') {
			return status.state;
		}
		return 'unknown';
	} catch (error) {
		return error instanceof TypeError ? 'unsupported' : 'unknown';
	}
}

/** Query both fine-grained local-network names plus the informational alias. */
export async function queryNetworkPermissions(
	scope: BrowserScope = defaultScope(),
): Promise<NetworkPermissionObservation> {
	// Named explicitly rather than looped over LOCAL_NETWORK_PERMISSION_NAMES:
	// the result is a fixed-shape record, and a loop would need a cast to build
	// it. `satisfies` keeps the two in sync without one.
	const [localNetwork, loopbackNetwork, legacyAlias] = await Promise.all([
		queryPermission('local-network' satisfies LocalNetworkPermissionName, scope),
		queryPermission('loopback-network' satisfies LocalNetworkPermissionName, scope),
		queryPermission(LEGACY_LOCAL_NETWORK_PERMISSION, scope),
	]);
	return {
		'local-network': localNetwork,
		'loopback-network': loopbackNetwork,
		legacyAlias,
	};
}

/**
 * Optional location permission.
 *
 * Reported because the provider already observes it, and never consulted by
 * readiness — location is outside subscription semantics for this cutover, and
 * the contract's conformance suite pins that separation.
 */
export async function queryOptionalLocation(
	scope: BrowserScope = defaultScope(),
): Promise<OptionalLocationObservation> {
	return { geolocation: await queryPermission('geolocation', scope) };
}

/**
 * Raw Direct Sockets diagnostics as the deployed provider reports them.
 *
 * Field names match the socket worker's wire shape, which uses `has*` for the
 * constructor probes. Everything is optional because an older provider omits
 * fields rather than reporting them false.
 */
export interface RawDirectSocketsDiagnostics {
	readonly available?: unknown;
	readonly hasUDPSocket?: unknown;
	readonly hasTCPSocket?: unknown;
	readonly hasTCPServerSocket?: unknown;
	readonly udpBind?: unknown;
	readonly error?: unknown;
}

export interface RawSocketWorkerDiagnostics {
	readonly api?: unknown;
	readonly ready?: unknown;
	readonly directSockets?: RawDirectSocketsDiagnostics;
}

/**
 * Normalise raw provider diagnostics into the contract's observation shape.
 *
 * The one non-mechanical field is `udpBind`, and it MUST stay tri-state. A real
 * ephemeral UDP bind is the only proof Direct Sockets works, but the provider
 * only attempts it once both fine-grained permissions are granted — so a
 * boolean `false` conflates "the bind failed" with "we never tried". Those have
 * different causes, different fixes, and different messages, and the contract
 * has distinct codes for them (`udp-bind-failed` vs `udp-bind-unverified`).
 *
 * The deployed IWA collapses this with `udpBind: diagnostics.udpBind === true`,
 * which reports a not-yet-attempted bind as a hard
 * failure. Normalising here rather than there keeps the fix on the adapter
 * boundary every consumer crosses.
 */
export function readSocketWorker(
	raw: RawSocketWorkerDiagnostics | undefined,
): SocketWorkerObservation {
	const rawSockets = raw?.directSockets;
	const directSockets: DirectSocketsObservation = {
		available: rawSockets?.available === true,
		udp: rawSockets?.hasUDPSocket === true,
		tcp: rawSockets?.hasTCPSocket === true,
		tcpServer: rawSockets?.hasTCPServerSocket === true,
		udpBind:
			rawSockets?.udpBind === true ? true : rawSockets?.udpBind === false ? false : null,
		...(typeof rawSockets?.error === 'string' ? { error: rawSockets.error } : {}),
	};
	return { api: raw?.api === true, ready: raw?.ready === true, directSockets };
}

export interface ObserveProviderOptions {
	/**
	 * Whether the caller's extension-detection deadline has elapsed.
	 *
	 * Extension detection is a fire-and-forget probe with NO built-in timeout,
	 * so silence is indistinguishable from absence until the caller's own
	 * deadline expires. Before then `extensionResponded` stays `null`, which the
	 * contract reads as not-yet-observed rather than as a verdict. The deadline
	 * belongs to the caller because only the caller knows when it started
	 * probing.
	 */
	readonly extensionDeadlineElapsed: boolean;
	/** The provider realm is `isolated-app:` (the IWA itself). */
	readonly iwaInstalled?: boolean;
	/** The IWA completed its nonce-bound handshake with the extension. */
	readonly iwaExtensionConnected?: boolean;
}

/**
 * Detect which provider — if any — answered in this realm.
 *
 * `providerGlobalPresent` deliberately does not imply an installed extension:
 * the standalone bridge polyfill installs `window.multicast` too. The two
 * topologies are not interchangeable, which is why the IWA lifecycle fields are
 * carried separately and gated by the contract only when the extension answered.
 */
export function observeProvider(
	options: ObserveProviderOptions,
	scope: BrowserScope = defaultScope(),
): ProviderObservation {
	const extensionFlagged = scope[EXTENSION_AVAILABLE_FLAG] === true;
	return {
		providerGlobalPresent: scope.multicast !== undefined && scope.multicast !== null,
		extensionResponded: extensionFlagged ? true : options.extensionDeadlineElapsed ? false : null,
		iwaInstalled: options.iwaInstalled === true,
		iwaExtensionConnected: options.iwaExtensionConnected === true,
	};
}

export interface ObserveReadinessOptions extends ObserveProviderOptions {
	/**
	 * Socket worker and Direct Sockets diagnostics from the provider.
	 *
	 * Supplied rather than probed because they are NOT observable from a page
	 * realm: the socket worker lives in the IWA's `isolated-app:` realm and the
	 * extension exposes no page-facing diagnostic channel. A page-realm caller
	 * therefore cannot produce a complete observation, and this parameter is
	 * where that honesty is enforced — omitting it yields
	 * `socket-worker-unavailable`, which is the correct reading for a caller
	 * that genuinely cannot see the worker.
	 */
	readonly socketWorker?: RawSocketWorkerDiagnostics;
}

/** Assemble the full observation `evaluateReadiness` consumes. */
export async function observeReadiness(
	options: ObserveReadinessOptions,
	scope: BrowserScope = defaultScope(),
): Promise<ReadinessObservation> {
	return {
		provider: observeProvider(options, scope),
		socketWorker: readSocketWorker(options.socketWorker),
		permissions: await queryNetworkPermissions(scope),
	};
}
