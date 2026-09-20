/**
 * `@blockcast/multicast-contract` — the frozen v1 `window.multicast` contract.
 *
 * Zero runtime dependencies, by design. This package is the sink of the import
 * DAG so that nothing can pull the canonical global declaration into a cycle
 * (v1 contract freeze §3.3). Adding a dependency here — especially on
 * `@blockcast/shared` or `@blockcast/transport` — reintroduces the package cycle
 * this package exists to break, and drags an unpublished package into a public
 * surface.
 *
 * The conformance suite is a separate entry point (`./conformance`) so that a
 * production consumer importing the types never pulls in the test harness.
 */

export {
	MulticastError,
	MULTICAST_ERROR_CODES,
	isMulticastErrorCode,
	multicastErrorCodeOf,
	EARLY_BYTES_RETENTION_LIMIT,
	SUBSCRIPTION_EVENT_NAMES,
	THROUGHPUT_WINDOW_MILLISECONDS,
	THROUGHPUT_MIN_SAMPLE_INTERVAL_MILLISECONDS,
	type AddressFamilySupport,
	type Capabilities,
	type GatewayEventWire,
	type MulticastErrorCode,
	type MulticastErrorWire,
	type MulticastGateway,
	type ResolvedTransport,
	type SubscribeConfig,
	type SubscribeConfigAmt,
	type SubscribeConfigAtsc1Tuner,
	type SubscribeConfigBytes,
	type SubscribeConfigIpTuner,
	type SubscribeConfigTuner,
	type SubscribeOrigin,
	type SubscribeOriginSupport,
	type Subscription,
	type SubscriptionEventMap,
	type SubscriptionEventName,
	type SubscriptionState,
	type ThroughputHistory,
	type ThroughputRateUnavailableReason,
	type ThroughputSample,
	type ThroughputSubscriptionSample,
	type ThroughputTransport,
	type TransportCapabilityReport,
	type TunerStandard,
} from './gateway.ts';

export {
	DIRECT_SOCKET_CAPABILITIES,
	LOCAL_NETWORK_PERMISSION_NAMES,
	SUBSCRIBE_DIRECT_SOCKET_CAPABILITIES,
	describeLegacyPermissionAlias,
	evaluateReadiness,
	type DirectSocketCapability,
	type DirectSocketsObservation,
	type EvaluateReadinessOptions,
	type LocalNetworkPermissionName,
	type NetworkPermissionObservation,
	type OptionalLocationObservation,
	type PermissionResult,
	type ProviderObservation,
	type Readiness,
	type ReadinessCode,
	type ReadinessObservation,
	type SocketWorkerObservation,
} from './readiness.ts';
