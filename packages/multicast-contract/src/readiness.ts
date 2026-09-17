/**
 * Read-only readiness, permission, and provider-detection results.
 *
 * Scope is fixed by the v1 contract freeze: "Setup accordion and prompting
 * remain host UX. Expose only read-only readiness/capability/permission results
 * needed for actionable errors." So this module reports; it never prompts, never
 * grants, and never opens a window.
 *
 * `evaluateReadiness` is a PURE function of a caller-supplied observation. That
 * is deliberate and load-bearing, not a stylistic choice: on the deployed system
 * every gateway method call routes through `sendToIWA`, which AUTO-OPENS an IWA
 * window as a side effect. A readiness API that probed for itself would pop a
 * window as a consequence of asking "are you ready?". Keeping evaluation pure
 * puts that side effect back under host control, where the ratified decision
 * says prompting belongs.
 */

/**
 * Result of a `navigator.permissions.query` for one descriptor.
 *
 * `unsupported` and `unknown` are distinct and both real: Chromium throws
 * `TypeError` for permission names it does not implement (⇒ `unsupported`),
 * while other failures such as an unusual document context are `unknown`.
 * Neither may be collapsed into `denied` — the local-network names have shipped
 * behind different spellings across versions, and treating "this build doesn't
 * know the name" as a denial reports a healthy system as blocked.
 */
export type PermissionResult = 'granted' | 'prompt' | 'denied' | 'unsupported' | 'unknown';

/**
 * The authoritative fine-grained Local Network Access permission names on
 * current Chromium.
 *
 * ⚠️ The older `local-network-access` alias is NOT in this list and must not
 * gate readiness. Chromium retains it for compatibility but current builds
 * report it `denied` while both fine-grained permissions are `granted`, so
 * gating on it reports a working bridge as blocked. It is carried on
 * `NetworkPermissionObservation.legacyAlias` as INFORMATIONAL ONLY.
 */
export const LOCAL_NETWORK_PERMISSION_NAMES = ['local-network', 'loopback-network'] as const;

export type LocalNetworkPermissionName = (typeof LOCAL_NETWORK_PERMISSION_NAMES)[number];

export interface NetworkPermissionObservation {
	readonly 'local-network': PermissionResult;
	readonly 'loopback-network': PermissionResult;
	/**
	 * Legacy combined alias. Informational only — never gates readiness. Report
	 * it to a user as covered whenever both fine-grained names are granted.
	 */
	readonly legacyAlias?: PermissionResult;
}

/**
 * The four Direct Sockets capabilities, plus the verified bind.
 *
 * `available` is not a fifth independent capability — the provider computes it
 * as `udp && tcp && tcpServer`. It is carried separately because a provider may
 * report it without the individual flags.
 */
export interface DirectSocketsObservation {
	readonly available: boolean;
	readonly udp: boolean;
	readonly tcp: boolean;
	readonly tcpServer: boolean;
	/**
	 * Tri-state, and it MUST stay tri-state.
	 *
	 * A real ephemeral UDP bind is the only proof that Direct Sockets works:
	 * Chromium can expose the `UDPSocket` constructor while every bind is still
	 * refused by Local Network Access. But the provider only attempts the bind
	 * when both fine-grained permissions are already granted, so a boolean
	 * `false` conflates "the bind failed" with "we never tried". Those have
	 * different causes, different fixes, and different messages — `null` means
	 * NOT ATTEMPTED.
	 */
	readonly udpBind: boolean | null;
	readonly error?: string;
}

/**
 * The three Direct Sockets constructor capabilities, in report order.
 */
export const DIRECT_SOCKET_CAPABILITIES = ['udp', 'tcp', 'tcpServer'] as const;

export type DirectSocketCapability = (typeof DIRECT_SOCKET_CAPABILITIES)[number];

/**
 * The capabilities a *subscribe* actually consumes.
 *
 * All three subscribe origins the gateway accepts — `ip-multicast`, `amt`, and
 * `tuner` — move their payload over `UDPSocket`. `TCPSocket` and
 * `TCPServerSocket` belong to adjacent infrastructure (the WebTransport bridge
 * listener and the TLS client worker), never to the datagram path a subscriber
 * opens, so requiring them to subscribe refuses subscriptions that would have
 * worked. The provider's own support test agrees: `NativeMulticastManager
 * .isSupported()` gates on `hasUDPSocket` alone.
 */
export const SUBSCRIBE_DIRECT_SOCKET_CAPABILITIES = ['udp'] as const;

export interface EvaluateReadinessOptions {
	/**
	 * Which Direct Sockets capabilities the caller's operation needs.
	 *
	 * Defaults to all three, which is the right answer for the setup assistant:
	 * it reports whether the whole provider is healthy. A caller gating one
	 * specific operation should narrow it to what that operation uses — see
	 * `SUBSCRIBE_DIRECT_SOCKET_CAPABILITIES`.
	 */
	readonly requiredCapabilities?: readonly DirectSocketCapability[];
}

export interface SocketWorkerObservation {
	/** The `Worker` constructor exists in the provider's realm. */
	readonly api: boolean;
	/** A socket worker instance is actually live. */
	readonly ready: boolean;
	readonly directSockets: DirectSocketsObservation;
}

/**
 * Whether a page can see a multicast provider at all.
 *
 * `providerGlobalPresent` deliberately does NOT imply `extensionInstalled`: the
 * standalone bridge polyfill installs `window.multicast` too, and it declines
 * to overwrite a surface the extension already installed (the extension, which
 * owns the surface, does overwrite the polyfill's). Presence of the global
 * proves only that SOME provider answered.
 *
 * The two providers are NOT interchangeable for readiness purposes. The
 * extension installs the global at document_start regardless of IWA state; the
 * polyfill installs it only after connecting to the IWA bridge. `iwaInstalled`
 * and `iwaExtensionConnected` therefore gate the extension topology only — see
 * `evaluateReadiness`.
 */
export interface ProviderObservation {
	/** `typeof window.multicast !== 'undefined'`. */
	readonly providerGlobalPresent: boolean;
	/**
	 * The extension answered a probe within the caller's deadline.
	 *
	 * `null` means the deadline has not elapsed yet — still waiting. Extension
	 * detection is a fire-and-forget probe with NO built-in timeout, so absence
	 * is indistinguishable from silence until the caller's own deadline expires.
	 * Do not report `false` before then.
	 */
	readonly extensionResponded: boolean | null;
	/** The provider is running from an `isolated-app:` realm. */
	readonly iwaInstalled: boolean;
	/** The IWA completed its nonce-bound handshake with the extension. */
	readonly iwaExtensionConnected: boolean;
}

/**
 * A full readiness observation. Every field is a fact the host already has;
 * assembling it is the host's job, evaluating it is this module's.
 */
export interface ReadinessObservation {
	readonly provider: ProviderObservation;
	readonly socketWorker: SocketWorkerObservation;
	readonly permissions: NetworkPermissionObservation;
}

/**
 * Why a provider is not ready, in the order the deployed setup flow resolves
 * them. Ordering is part of the contract: a permission denial is reported before
 * a bind failure because the provider does not even attempt the bind until the
 * permissions are granted, so the bind result carries no information yet.
 */
export type ReadinessCode =
	| 'ready'
	| 'provider-absent'
	| 'provider-unobservable'
	| 'iwa-not-installed'
	| 'iwa-extension-disconnected'
	| 'socket-worker-unavailable'
	| 'direct-sockets-unavailable'
	| 'network-permission-denied'
	| 'network-permission-required'
	| 'udp-bind-unverified'
	| 'udp-bind-failed';

export interface Readiness {
	readonly ready: boolean;
	readonly code: ReadinessCode;
	/** One actionable sentence naming what the user or operator must do. */
	readonly detail: string;
	/**
	 * Direct Sockets capabilities that are missing, when `code` is
	 * `direct-sockets-unavailable`. Empty when the provider reported the
	 * aggregate flag false without naming an individual capability.
	 */
	readonly missingCapabilities: readonly string[];
	/** Permission names that are not `granted`, when a permission code is set. */
	readonly blockingPermissions: readonly LocalNetworkPermissionName[];
}

function readinessResult(
	code: ReadinessCode,
	detail: string,
	extra?: {
		missingCapabilities?: readonly string[];
		blockingPermissions?: readonly LocalNetworkPermissionName[];
	},
): Readiness {
	return {
		ready: code === 'ready',
		code,
		detail,
		missingCapabilities: extra?.missingCapabilities ?? [],
		blockingPermissions: extra?.blockingPermissions ?? [],
	};
}

/**
 * Evaluate a readiness observation into an actionable result.
 *
 * Pure and side-effect-free by contract. Gate order mirrors the deployed setup
 * flow; see `ReadinessCode` for why the order is load-bearing.
 *
 * `options.requiredCapabilities` narrows the Direct Sockets gate to what the
 * caller's operation actually uses. It defaults to all three, so every existing
 * caller keeps its exact behaviour.
 */
export function evaluateReadiness(
	observation: ReadinessObservation,
	options?: EvaluateReadinessOptions,
): Readiness {
	const { provider, socketWorker, permissions } = observation;

	// "Cannot observe" is NOT "not ready". A host that collapses the two reports
	// a transient probe gap as a hard failure and sends the user to fix a
	// permission that was never the problem.
	if (provider.extensionResponded === null && !provider.providerGlobalPresent) {
		return readinessResult(
			'provider-unobservable',
			'No multicast provider has answered yet and the detection deadline has not elapsed; re-read before reporting a failure.',
		);
	}

	if (!provider.providerGlobalPresent) {
		return readinessResult(
			'provider-absent',
			'No multicast provider is installed in this page realm: window.multicast is undefined.',
		);
	}

	// The IWA lifecycle gates apply ONLY to the extension topology, and the
	// asymmetry between the two live providers is why:
	//
	//   - The extension installs `window.multicast` unconditionally at
	//     document_start (packages/extension/src/inject/inject.ts), knowing
	//     nothing about the IWA. Presence of the global proves nothing, and
	//     every call then routes through `sendToIWA`, which queues for 15s and
	//     fails with a generic "IWA bridge not available" if the IWA never
	//     connects. Without these gates readiness certifies exactly that.
	//   - The bridge polyfill installs the global only AFTER it has discovered
	//     and connected to the IWA's WebTransport listener
	//     (packages/window-multicast-bridge/src/multicast-bridge.js), so there
	//     presence already IMPLIES a live bridge, and it never speaks to the
	//     extension at all — its nonce handshake field is meaningless.
	//
	// So gate on `extensionResponded === true`. Gating unconditionally would
	// report a healthy polyfill-backed page as broken, the same error class as
	// the legacy permission alias and the tri-state bind below. `null` stays
	// ungated for the same reason it does above: not-yet-observed is not a
	// verdict.
	if (provider.extensionResponded === true) {
		if (!provider.iwaInstalled) {
			return readinessResult(
				'iwa-not-installed',
				'The extension is present but the Multicast Gateway IWA is not installed; install it to enable multicast/AMT support.',
			);
		}

		if (!provider.iwaExtensionConnected) {
			return readinessResult(
				'iwa-extension-disconnected',
				'The IWA is installed but has not completed its nonce-bound handshake with the extension; reopen the provider window to reconnect.',
			);
		}
	}

	if (!socketWorker.api || !socketWorker.ready) {
		return readinessResult(
			'socket-worker-unavailable',
			'The provider socket worker is not running yet.',
		);
	}

	const directSockets = socketWorker.directSockets;
	const required = options?.requiredCapabilities ?? DIRECT_SOCKET_CAPABILITIES;
	const missingCapabilities = DIRECT_SOCKET_CAPABILITIES.filter(
		(name) => required.includes(name) && !directSockets[name],
	);

	// `available` is the provider's own `udp && tcp && tcpServer`, so it is a
	// valid proxy ONLY when all three are actually required. Consulting it for a
	// narrowed set re-imposes the full requirement through the aggregate and
	// refuses, say, a UDP-only subscribe on a runtime that simply has no
	// TCPServerSocket — the failure this option exists to prevent. The two
	// socket-worker handlers disagree on purpose: `CHECK_DIRECT_SOCKETS` reports
	// `available: hasUDPSocket` for the subscribe path, `GET_SETUP_DIAGNOSTICS`
	// the strict AND for the setup assistant.
	const aggregateBlocks =
		required.length === DIRECT_SOCKET_CAPABILITIES.length && !directSockets.available;

	if (aggregateBlocks || missingCapabilities.length > 0) {
		const named =
			missingCapabilities.length > 0
				? `Direct Sockets capabilities unavailable: ${missingCapabilities.join(', ')}.`
				: directSockets.error ?? 'Direct Sockets is unavailable in this build.';
		return readinessResult('direct-sockets-unavailable', named, { missingCapabilities });
	}

	const denied = LOCAL_NETWORK_PERMISSION_NAMES.filter(
		(name) => permissions[name] === 'denied',
	);
	if (denied.length > 0) {
		return readinessResult(
			'network-permission-denied',
			`Local network access was denied: ${denied.join(', ')}. The user must re-allow it in the provider window.`,
			{ blockingPermissions: denied },
		);
	}

	const ungranted = LOCAL_NETWORK_PERMISSION_NAMES.filter(
		(name) => permissions[name] !== 'granted',
	);
	if (ungranted.length > 0) {
		return readinessResult(
			'network-permission-required',
			`Local network access has not been granted yet: ${ungranted.join(', ')}. The user must accept the prompts in the provider window.`,
			{ blockingPermissions: ungranted },
		);
	}

	// Both permissions are granted, so a bind either succeeded, failed, or was
	// never attempted — and the third case is not a failure to report as one.
	if (directSockets.udpBind === null) {
		return readinessResult(
			'udp-bind-unverified',
			'Permissions are granted but no UDP bind has been verified yet; readiness is still unproven.',
		);
	}

	if (!directSockets.udpBind) {
		return readinessResult(
			'udp-bind-failed',
			directSockets.error
				? `Direct Sockets cannot open a UDP socket: ${directSockets.error}`
				: 'Direct Sockets cannot open a UDP socket.',
		);
	}

	return readinessResult('ready', 'Effective capabilities and network permissions are granted.');
}

/**
 * How to present the legacy `local-network-access` alias without reporting a
 * healthy system as blocked. Returns null when there is nothing to show.
 */
export function describeLegacyPermissionAlias(
	permissions: NetworkPermissionObservation,
): { state: PermissionResult; detail: string } | null {
	if (permissions.legacyAlias === undefined) return null;
	const covered =
		permissions['local-network'] === 'granted' && permissions['loopback-network'] === 'granted';
	if (covered) {
		return { state: 'granted', detail: 'Covered by local + loopback grants' };
	}
	return { state: permissions.legacyAlias, detail: 'Legacy combined alias; informational only' };
}

/**
 * Optional location permission result.
 *
 * Ratified scope (v1 contract freeze): "Location is optional and outside subscription
 * semantics for this cutover." It is reported here because the provider already
 * observes it, and never consulted by `evaluateReadiness` — a subscription must
 * never depend on it. `assertLocationOutsideReadiness` in ./conformance.ts pins
 * that separation so a future edit cannot quietly make location load-bearing.
 */
export interface OptionalLocationObservation {
	readonly geolocation: PermissionResult;
}
