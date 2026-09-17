/**
 * `@blockcast/multicast-browser` — the browser / extension / IWA adapter for the
 * frozen v1 `window.multicast` contract.
 *
 * Two jobs, and nothing else:
 *
 *   1. Resolve the installed provider against the contract's `MulticastGateway`
 *      (`./gateway.ts`), structurally rather than by cast.
 *   2. Assemble the `ReadinessObservation` that the contract's pure
 *      `evaluateReadiness` consumes (`./observe.ts`).
 *
 * Zero runtime dependencies, asserted in CI. The contract is consumed
 * type-only, so nothing here ships a copy of the canonical surface and no
 * compiled libmmt artifact is reachable from this package. Subscription
 * semantics, error codes, and the readiness verdict all stay in the frozen leaf;
 * this package only collects facts and hands them over.
 *
 * Setup prompting is deliberately absent — it remains host UX (ratified in the
 * contract freeze), and a readiness API that probed for itself would pop an IWA
 * window as a consequence of asking "are you ready?".
 */

export {
	createBrowserConformanceDriver,
	getGateway,
	hasGateway,
	type BrowserDriverHooks,
} from './gateway.ts';

export {
	EXTENSION_AVAILABLE_FLAG,
	LEGACY_LOCAL_NETWORK_PERMISSION,
	observeProvider,
	observeReadiness,
	queryNetworkPermissions,
	queryOptionalLocation,
	queryPermission,
	readSocketWorker,
	type BrowserScope,
	type ObserveProviderOptions,
	type ObserveReadinessOptions,
	type RawDirectSocketsDiagnostics,
	type RawSocketWorkerDiagnostics,
} from './observe.ts';
