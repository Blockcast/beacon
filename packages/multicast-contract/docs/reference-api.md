<!-- GENERATED FILE -- DO NOT EDIT.
     Source of truth: the emitted dist/*.d.ts in @blockcast/multicast-contract.
     Regenerate: npm run docs:reference
     CI gate: node scripts/gen-reference-api.mjs --check -->

# `@blockcast/multicast-contract` v1.0.0 -- API reference

This reference is the package's **emitted type declarations, verbatim**.
It is generated from `dist/`, so it cannot describe an API the package does
not actually ship. Prose, rationale, and worked examples live in the
package README; this file is the exhaustive surface.

## Entry points

| Import specifier | Declarations |
| --- | --- |
| `@blockcast/multicast-contract` | `dist/index.d.ts` |
| `@blockcast/multicast-contract/conformance` | `dist/conformance.d.ts` |
| `@blockcast/multicast-contract/fake-gateway` | `dist/fake-gateway.d.ts` |

## `dist/index.d.ts`

```ts
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
export { MulticastError, MULTICAST_ERROR_CODES, isMulticastErrorCode, multicastErrorCodeOf, EARLY_BYTES_RETENTION_LIMIT, SUBSCRIPTION_EVENT_NAMES, THROUGHPUT_WINDOW_MILLISECONDS, THROUGHPUT_MIN_SAMPLE_INTERVAL_MILLISECONDS, type AddressFamilySupport, type Capabilities, type GatewayEventWire, type MulticastErrorCode, type MulticastErrorWire, type MulticastGateway, type ResolvedTransport, type SubscribeConfig, type SubscribeConfigAmt, type SubscribeConfigAtsc1Tuner, type SubscribeConfigBytes, type SubscribeConfigIpTuner, type SubscribeConfigTuner, type SubscribeOrigin, type SubscribeOriginSupport, type Subscription, type SubscriptionEventMap, type SubscriptionEventName, type SubscriptionState, type ThroughputHistory, type ThroughputRateUnavailableReason, type ThroughputSample, type ThroughputSubscriptionSample, type ThroughputTransport, type TransportCapabilityReport, type TunerStandard, } from './gateway.ts';
export { DIRECT_SOCKET_CAPABILITIES, LOCAL_NETWORK_PERMISSION_NAMES, SUBSCRIBE_DIRECT_SOCKET_CAPABILITIES, describeLegacyPermissionAlias, evaluateReadiness, type DirectSocketCapability, type DirectSocketsObservation, type EvaluateReadinessOptions, type LocalNetworkPermissionName, type NetworkPermissionObservation, type OptionalLocationObservation, type PermissionResult, type ProviderObservation, type Readiness, type ReadinessCode, type ReadinessObservation, type SocketWorkerObservation, } from './readiness.ts';
```

## `dist/conformance.d.ts`

```ts
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
import { type Capabilities, type MulticastErrorCode, type MulticastGateway, type ResolvedTransport, type SubscribeConfig, type SubscriptionState } from './gateway.ts';
import { type ReadinessObservation } from './readiness.ts';
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
/**
 * Binary integrity across the base64 hop (the ArrayBuffer-collapse regression).
 *
 * The failure this catches is silent by construction: a raw `ArrayBuffer` sent
 * over the JSON-serialized extension hop arrives as `{}` with
 * `byteLength === undefined`, so a consumer's sequence-tracking branch is never
 * entered and the stream looks merely empty rather than broken. Asserting
 * `byteLength` and the exact bytes is what distinguishes the two.
 */
export declare function checkBinaryIntegrity(driver: ConformanceDriver): Promise<CheckResult>;
/**
 * Early-bytes retention and the overflow cliff.
 *
 * Two branches, and the second is the one that matters: on overflow the ENTIRE
 * retained prefix must be dropped with no replay. Replaying a prefix and then
 * resuming live delivery fabricates a gap-free stream across a real
 * discontinuity, which a late-attaching player cannot detect.
 */
export declare function checkEarlyBytesHandoff(driver: ConformanceDriver): Promise<CheckResult>;
/**
 * `transportchange` must be emitted on every resolution.
 *
 * The retired lowercase API documented the silent-failure path explicitly: a
 * receiver that resolves by assigning its `transport` field "notifies nobody",
 * and consumers needing that case had to read `transport` per packet. Freeze
 * §3.1 makes emission mandatory; this is the machine check.
 */
export declare function checkTransportChangeEmitted(driver: ConformanceDriver): Promise<CheckResult>;
/** Lifecycle: connecting → connected, and a transport bounce round trip. */
export declare function checkLifecycle(driver: ConformanceDriver): Promise<CheckResult>;
/**
 * Unsubscribe must drive the subscription to `closed` and say so.
 *
 * A provider that flips its internal state field without dispatching the event
 * leaves a consumer listening for `state === 'closed'` unable to observe its own
 * teardown — measured on one of the two live page providers.
 */
export declare function checkUnsubscribeCompletes(driver: ConformanceDriver): Promise<CheckResult>;
/**
 * Collapse: N identical subscribes ⇒ N independent event streams over ONE
 * physical join, with byte counters unmultiplied.
 */
export declare function checkCollapse(driver: ConformanceDriver): Promise<CheckResult>;
/**
 * Error codes must be comparable cross-realm via `.code`.
 *
 * `instanceof` is explicitly not part of the contract: the JSON-serialized
 * extension hop strips the prototype chain, and the two live providers do not
 * even agree on the thrown type.
 */
export declare function checkErrorCodesCrossRealm(driver: ConformanceDriver): Promise<CheckResult>;
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
export declare const CONSUME_REJECTION_VECTORS: readonly [{
    readonly name: "unsupported-consume-mode-is-capability-unsupported";
    readonly why: string;
    readonly config: {
        readonly group: "232.0.0.18";
        readonly port: 9876;
        readonly consume: "frames";
    };
    readonly expectErrorCode: "capability-unsupported";
}, {
    readonly name: "missing-consume-is-subscription-failed";
    readonly why: string;
    readonly config: {
        readonly group: "232.0.0.18";
        readonly port: 9876;
    };
    readonly expectErrorCode: "subscription-failed";
}];
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
export declare function checkConsumeRejectionAgreed(driver: ConformanceDriver): Promise<CheckResult>;
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
export declare function assertCapabilitiesRedacted(capabilities: Capabilities): CheckResult;
export declare function checkCapabilitiesRedacted(driver: ConformanceDriver): Promise<CheckResult>;
/**
 * Location must stay outside readiness.
 *
 * Ratified scope is "location is optional and outside subscription semantics".
 * That is easy to honour today and easy to break later by threading a
 * geolocation result into a readiness gate, so it is pinned: readiness must be
 * byte-identical across every possible location permission result.
 */
export declare function assertLocationOutsideReadiness(observation: ReadinessObservation): CheckResult;
/**
 * Run the location-independence invariant across every readiness path.
 *
 * Driver-independent by construction: the guarantee is a property of
 * `evaluateReadiness`, not of any provider, so the suite can and must observe
 * it on every run rather than leaving it to callers.
 */
export declare function checkLocationOutsideReadiness(): CheckResult;
export interface ConformanceReport {
    readonly checks: readonly CheckResult[];
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    /** True only when every check ran AND passed. A skip is never a pass. */
    readonly conformant: boolean;
}
export declare function summarize(checks: readonly CheckResult[]): ConformanceReport;
/** Run every driver-based check, in a fixed order, and summarize. */
export declare function runConformanceSuite(driver: ConformanceDriver): Promise<ConformanceReport>;
export type { MulticastErrorCode };
```

## `dist/fake-gateway.d.ts`

```ts
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
import { type Capabilities, type MulticastGateway, type ResolvedTransport, type SubscribeConfig, type SubscriptionState } from './gateway.ts';
import type { ConformanceDriver } from './conformance.ts';
export interface FakeMulticastProviderOptions {
    readonly iwaVersion?: string;
    /**
     * Capability report handed to the page. Defaults to a redacted report; supply
     * an unredacted one to exercise `assertCapabilitiesRedacted` negatively.
     */
    readonly capabilities?: Capabilities;
}
/**
 * In-memory provider plus the control hooks the conformance suite needs.
 * Implements `ConformanceDriver`, so it can be handed straight to
 * `runConformanceSuite`.
 */
export declare class FakeMulticastProvider implements ConformanceDriver {
    #private;
    constructor(options?: FakeMulticastProviderOptions);
    get gateway(): MulticastGateway;
    physicalJoinCount(config: SubscribeConfig): number;
    deliverBytes(config: SubscribeConfig, payloads: readonly Uint8Array[]): void;
    resolveTransport(config: SubscribeConfig, transport: ResolvedTransport): void;
    forceState(config: SubscribeConfig, state: SubscriptionState): void;
}
```

## `dist/gateway.d.ts`

```ts
/**
 * The frozen v1 `window.multicast` contract.
 *
 * This file is the SINGLE source of truth for the page-facing global. It lives
 * in a zero-dependency leaf package that sits at the bottom of the import DAG so
 * that nothing can pull it into a cycle — the mechanism `@blockcast/mmt-base`
 * already uses, adopted by the v1 contract freeze §3.3.
 *
 * Base: `packages/multicast/src/types/gateway.ts` ("declaration A"), with the
 * two freeze-mandated corrections applied:
 *
 *   §3.1  `transportchange` is part of the frozen event map. A omitted it while
 *         the deployed bridge emits it and four consumers listen for it, so
 *         adopting A verbatim would have deleted a live event and made AMT
 *         failover unobservable to every player.
 *   §3.3  `TransportCapabilityReport` is INLINED here rather than imported from
 *         `@blockcast/shared`. `@blockcast/shared` has never been published to
 *         npm, so importing it would drag an unpublished package into the public
 *         surface. Publishing it instead would export an internal grab-bag as
 *         public API — worse, and irreversible.
 *
 * Discriminant mechanism (back-compat-preserving):
 *   - The original IP-multicast member carries `origin?: 'ip-multicast'`
 *     (OPTIONAL, defaulted). An existing `{ group, port, consume: 'bytes' }`
 *     literal with no `origin` field therefore still matches this member
 *     unchanged — the union only grows, it does not migrate.
 *   - Every NEW member carries a REQUIRED `origin` literal ('amt' | 'tuner'),
 *     so the absence of `origin` can only mean the legacy IP-multicast member.
 *
 * Address-family-agnostic (LOCKED): `group` and `source` are bare
 * strings that accept IPv4 (IGMPv3, RFC 3376) and IPv6 (MLDv2, RFC 3810)
 * literals, for both SSM and ASM. No member encodes or assumes an address
 * family. Do NOT add IPv4-only assumptions to any member here.
 */
/**
 * TYPE-ONLY, and it must stay that way. `./readiness.ts` imports nothing at all,
 * so this is a one-way edge inside the leaf package and erases entirely at
 * build time — it adds no runtime dependency and cannot form the import cycle
 * §3.3 exists to prevent. A value import here would.
 */
import type { Readiness } from './readiness.ts';
/**
 * Stable error codes safe to compare across realms (e.g. webpage vs iframe).
 *
 * ⚠️ THIS UNION IS OPEN WITHIN v1. Additions are MINOR, not breaking (§1 of the
 * v1 release ruling, closing a gap the freeze §6.1 left silent). Consumers MUST
 * branch with a `default` arm and MUST NOT write an exhaustive `assertNever`
 * over it — a `switch` that is exhaustive against the version you compiled
 * against will fall through on a newer provider's code.
 *
 * The reason this is load-bearing rather than a style note: `isMulticastErrorCode`
 * and `multicastErrorCodeOf` test membership against the `MULTICAST_ERROR_CODES`
 * array BUNDLED WITH THE CONSUMER, not the one the provider threw from. A page
 * pinned to `1.0.0` that receives `not-ready` from a `1.1.0` provider gets
 * `false` / `null` — the code reports as *not a multicast error at all*. That is
 * the same silent cross-realm failure the `_AllErrorCodesListed` guard below
 * prevents WITHIN a version, and it is structurally unavoidable ACROSS versions
 * with an array-based structural test. There is no fix at this layer; there is
 * only a reading rule:
 *
 *   **An unrecognized `code` string is a multicast error of an UNKNOWN KIND.**
 *   Degrade to generic handling. Never conclude "not ours".
 *
 * Cross-realm code MUST use `err.code === '...'`, never `instanceof`. Two
 * independent reasons, both measured on the deployed system:
 *   - The extension hop is `chrome.runtime.Port.postMessage`, which is
 *     JSON-serialized rather than structured-cloned, so an `Error` subclass
 *     loses its prototype chain and arrives as flattened primitives.
 *   - The two live page providers do not agree on the thrown type at all: the
 *     extension path throws a real `MulticastError`, while the bridge polyfill
 *     throws a plain `Error` with `.name` and `.code` patched on.
 *
 * `not-ready` was added before v1 publication. There is exactly ONE new code
 * here and not the two (`not-ready` + `permission-denied`) the gap report
 * proposed, for the reasons below:
 *
 *   - A readiness failure has TEN distinct causes, already enumerated, ordered,
 *     and given per-cause remedies by `ReadinessCode` in ./readiness.ts. Picking
 *     two of them for the error union encodes an arbitrary cut and guarantees a
 *     second breaking add the first time `udp-bind-failed` or
 *     `socket-worker-unavailable` needs distinguishing.
 *   - A bare `permission-denied` would also collide with `origin-not-trusted`,
 *     which is already a permission denial — of page origin rather than of OS
 *     local-network access. Two unrelated denials under one name is a
 *     documentation trap, not a vocabulary.
 *   - `network-permission-denied` (the user refused; not retryable) and
 *     `network-permission-required` (the prompt has not been shown yet;
 *     retryable after user action) are DIFFERENT remedies. One flat member
 *     cannot carry that, and retryability is what a caller branches on.
 *
 * So the union grows by one and the specific cause rides on
 * `MulticastError.readiness`, which is the ratified `Readiness` record itself —
 * no lossy re-encoding, and no vocabulary to keep in sync across three language
 * mirrors. `permission-denied` is expressed as
 * `code === 'not-ready' && readiness?.code === 'network-permission-denied'`.
 */
/**
 * RULING: an unsupported `consume` mode is `capability-unsupported`,
 * never `subscription-failed`. Every provider MUST use that code, and
 * `checkConsumeRejectionAgreed` in ./conformance.ts enforces it.
 *
 * The two codes are not interchangeable and the distinction is the one a
 * caller branches on:
 *
 *   - `capability-unsupported` — the provider cannot do the thing asked for.
 *     Retrying is pointless; the caller must ask for something else. An
 *     unsupported `consume` mode is exactly this: `bytes` is the only mode the
 *     frozen v1 surface defines, so `consume: 'frames'` names a capability no
 *     provider has, and it is rejected before any subscription is attempted.
 *   - `subscription-failed` — a well-formed, supported request that did not
 *     succeed. It says something went wrong along the way, which invites a
 *     retry that can never work here.
 *
 * The same reasoning already decides the neighbouring case: an unrecognized
 * `origin` is `capability-unsupported` in the IWA gateway dispatch, and
 * `consume` is the same kind of rejection one field over.
 *
 * This is stated here rather than left to each provider because it was decided
 * by whichever file was edited first, and the two live providers disagreed —
 * the extension threw `subscription-failed` and the window bridge threw
 * `capability-unsupported`, so a cross-realm caller following the ratified
 * `err.code === '...'` guidance got a code that depended on which provider
 * happened to be installed.
 *
 * Malformed input that is not a `consume` mode keeps `subscription-failed`: a
 * missing config object, a missing group/port, a relay without an origin. Those
 * are bad requests, not absent capabilities.
 *
 * That explicitly includes an ABSENT `consume`. `consume` is a REQUIRED field
 * of every SubscribeConfig member — contrast `origin?` and `source?`, which are
 * declared optional — so omitting it is a bad request and stays
 * `subscription-failed`. The capability branch must therefore test
 * `consume !== undefined && consume !== 'bytes'`, never `consume !== 'bytes'`
 * alone: the caller who forgot the field can fix it and retry, and
 * `capability-unsupported` is precisely the code that tells them not to bother.
 * Both halves of the boundary are pinned by `CONSUME_REJECTION_VECTORS`.
 */
export type MulticastErrorCode = 'iwa-not-installed' | 'origin-not-trusted' | 'capability-unsupported' | 'not-ready' | 'subscription-failed';
/**
 * The codes THIS BUILD knows about — a snapshot of an OPEN set, never the
 * complete one. A newer provider may throw a code absent from this array, and
 * that code is still a valid multicast error (see `MulticastErrorCode`).
 *
 * Safe to iterate for logging or documentation. NOT safe to treat as the
 * universe of possible codes: do not use it to validate, reject, or route
 * error codes arriving from another realm.
 */
export declare const MULTICAST_ERROR_CODES: readonly ["iwa-not-installed", "origin-not-trusted", "capability-unsupported", "not-ready", "subscription-failed"];
export declare class MulticastError extends Error {
    readonly code: MulticastErrorCode;
    readonly cause?: unknown;
    /**
     * The readiness verdict that caused this error. Present only when `code` is
     * `not-ready`, and REQUIRED there: a `not-ready` with no verdict is exactly
     * the unactionable failure this member exists to replace, so emit the
     * `evaluateReadiness` result rather than constructing the code bare.
     *
     * Optional in the type because the field crosses the JSON hop on
     * `GatewayEventWire` and an older provider predating this ruling cannot send
     * it. Absence means UNKNOWN, never "ready".
     */
    readonly readiness?: Readiness;
    constructor(code: MulticastErrorCode, message: string, cause?: unknown, readiness?: Readiness);
}
/**
 * Structural test for a multicast error that survives the realm/serialization
 * hops described on `MulticastErrorCode`. Prefer this over `instanceof`.
 *
 * ⚠️ ONE-WAY SIGNAL. `true` proves the value is a code this build knows.
 * `false` does NOT prove the value is not a multicast error — it tests against
 * the `MULTICAST_ERROR_CODES` array bundled with YOU, and the set is OPEN
 * within v1, so a code added by a newer provider reads as `false` here. Use
 * this to recognize a known code, never to reject an unknown one.
 */
export declare function isMulticastErrorCode(value: unknown): value is MulticastErrorCode;
/**
 * Reads a stable error code off any thrown value, or null when absent.
 *
 * ⚠️ `null` is AMBIGUOUS and must not be read as "not a multicast error". It
 * means one of two things this function cannot distinguish: the value carried
 * no `.code` at all, OR it carried a code from an OPEN-set addition this build
 * predates (see `MulticastErrorCode`). Branch on the codes you handle and send
 * everything else — including `null` — down a generic failure path. Do not use
 * `=== null` to decide an error belongs to some other subsystem.
 *
 * When you need the raw string regardless of vintage, read
 * `(error as { code?: unknown }).code` directly.
 */
export declare function multicastErrorCodeOf(error: unknown): MulticastErrorCode | null;
export type SubscriptionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';
/**
 * Tuner standards an IWA can drive over the air. ATSC 1.0 delivers MPEG-TS;
 * ATSC 3.0, DVB, and MBMS deliver their native multicast payload formats.
 */
export type TunerStandard = 'atsc1' | 'atsc3' | 'dvb' | 'mbms';
/**
 * The acquisition source for a subscription's bytes — the union discriminant.
 * Absent on a literal ⇒ the legacy IP-multicast member (back-compat).
 */
export type SubscribeOrigin = 'ip-multicast' | 'amt' | 'tuner';
/**
 * Native IP multicast (IGMPv3 / MLDv2 join via Direct Sockets). The original,
 * back-compatible member. `origin` is OPTIONAL here and defaults to
 * 'ip-multicast'; this is what keeps every pre-discriminant `{ group, port,
 * consume: 'bytes' }` literal valid.
 */
export interface SubscribeConfigBytes {
    /** IPv4 (RFC 3376) or IPv6 (RFC 3810) multicast group literal. */
    group: string;
    port: number;
    /** SSM source literal (IPv4 or IPv6). Omit for any-source multicast (ASM). */
    source?: string;
    consume: 'bytes';
    /** Catalog-derived packet ownership used by byte consumers and diagnostics. */
    tracks?: ReadonlyArray<{
        name: string;
        packetId: number;
    }>;
    /** Optional, defaulted. Omitting it selects this IP-multicast member. */
    origin?: 'ip-multicast';
    /** MMTP packet IDs admitted to this logical consumer. Empty or omitted means all IDs. */
    packetIds?: readonly number[];
}
/**
 * AMT relay source (Automatic Multicast Tunneling, RFC 7450). Relay discovery is
 * out of band (DRIAD, RFC 8777); the caller supplies the resolved endpoint.
 *
 * Migration trap (freeze §3.4, measured): the retired lowercase API allowed
 * `origin` to be OPTIONAL even for AMT. A literal
 * `{ group, port, consume: 'bytes', relay, relayPort }` with no `origin` matches
 * `SubscribeConfigBytes`, which has no `relay` field. In TypeScript that is a
 * compile error; from JavaScript it is a SILENT runtime fallback to native
 * multicast with the relay ignored. Audit every AMT call site for an explicit
 * `origin: 'amt'` rather than renaming mechanically.
 */
export interface SubscribeConfigAmt {
    group: string;
    port: number;
    /** SSM source literal (IPv4 or IPv6). Omit for ASM. */
    source?: string;
    consume: 'bytes';
    origin: 'amt';
    /** AMT relay address — IPv4 or IPv6 literal (or DRIAD-resolved host). */
    relay: string;
    /** AMT relay UDP port (RFC 7450 IANA default is 2268). */
    relayPort: number;
    /** MMTP packet IDs admitted to this logical consumer. Empty or omitted means all IDs. */
    packetIds?: readonly number[];
}
/**
 * ATSC 1.0 is an MPEG-2 transport stream on an RF channel, not an IP/UDP
 * multicast flow. Its real selectors are frequency, program number, and PID, so
 * assigning an IPv4 group would be synthetic (and must never reuse the ATSC 3.0
 * LLS well-known endpoint). Tuning selects the RF channel separately; this
 * subscription consumes the currently tuned transport stream.
 */
export interface SubscribeConfigAtsc1Tuner {
    consume: 'bytes';
    origin: 'tuner';
    standard: 'atsc1';
    protocol: 'mpeg-ts';
    group?: never;
    port?: never;
    source?: never;
}
/** IP-multicast tuner standards retain their actual on-air group and port. */
export interface SubscribeConfigIpTuner {
    group: string;
    port: number;
    /** SSM source literal (IPv4 or IPv6). Omit for ASM. */
    source?: string;
    consume: 'bytes';
    origin: 'tuner';
    standard: Exclude<TunerStandard, 'atsc1'>;
    protocol?: string;
}
export type SubscribeConfigTuner = SubscribeConfigAtsc1Tuner | SubscribeConfigIpTuner;
/**
 * Discriminated union of every way `window.multicast.subscribe()` can acquire
 * bytes. Narrow on `origin` (then `standard` for the tuner member).
 */
export type SubscribeConfig = SubscribeConfigBytes | SubscribeConfigAmt | SubscribeConfigTuner;
/**
 * Receiver transports covered by the physical multicast-ingress counter, and the
 * payload of a `transportchange` event.
 *
 * The deployed emitter folds its internal spellings down to exactly these two
 * (`native`/`native-ssm`/`ssm` → `native`; `amt`/`tunnel` → `amt`), so the event
 * detail is a bare string and NOT an object. Do not confuse this with the
 * separate `TrackTransportResolution[]`-carrying "transport change" concept on
 * the extension's `onTransportChange` callback surface — different shape,
 * different delivery mechanism, deliberately outside this contract.
 */
export type ResolvedTransport = 'native' | 'amt';
export type ThroughputTransport = ResolvedTransport;
/**
 * Map of event names → CustomEvent payload for `Subscription`.
 *
 * `transportchange` is frozen in by §3.1 and MUST be emitted on every transport
 * resolution. The retired lowercase API documented a silent-failure path — "a
 * receiver that resolves by assigning its `transport` field notifies nobody" —
 * and consumers that needed that case had to read `transport` per packet. The
 * freeze makes emission mandatory; `assertTransportChangeEmitted` in
 * ./conformance.ts is the machine check.
 *
 * Adding a new key here is how Phase 2 / 3 extend the surface (`gap`,
 * `metadata`, `frame`, `parserReset`). Additive keys are a MINOR bump.
 */
export interface SubscriptionEventMap {
    bytes: CustomEvent<ArrayBuffer>;
    state: CustomEvent<SubscriptionState>;
    error: CustomEvent<MulticastError>;
    transportchange: CustomEvent<ResolvedTransport>;
}
export type SubscriptionEventName = keyof SubscriptionEventMap;
export declare const SUBSCRIPTION_EVENT_NAMES: readonly SubscriptionEventName[];
/**
 * Contract returned by `window.multicast.subscribe()`.
 *
 * Deliberately NOT an `EventTarget` subclass: both deployed providers wrap a
 * private `EventTarget` and forward only these two methods, so `dispatchEvent`
 * is not part of the contract and `sub instanceof EventTarget` is false.
 */
export interface Subscription {
    readonly id: string;
    readonly state: SubscriptionState;
    addEventListener<K extends SubscriptionEventName>(type: K, listener: (ev: SubscriptionEventMap[K]) => void, options?: AddEventListenerOptions | boolean): void;
    removeEventListener<K extends SubscriptionEventName>(type: K, listener: (ev: SubscriptionEventMap[K]) => void, options?: EventListenerOptions | boolean): void;
    /** Replace this consumer's MMTP packet-ID filter without rejoining the socket. */
    setPacketIds(packetIds: readonly number[]): Promise<void>;
    unsubscribe(): Promise<void>;
}
/**
 * Number of `bytes` payloads retained before the first `bytes` listener
 * attaches. On overflow the ENTIRE retained prefix is dropped and no prefix is
 * replayed, because replaying a prefix and then resuming live delivery would
 * fabricate a gap-free stream across a real discontinuity.
 *
 * Frozen as a named constant because it is a correctness cliff for
 * late-attaching players, and because the deployed implementation carries it as
 * a bare inline literal that no test could reference.
 */
export declare const EARLY_BYTES_RETENTION_LIMIT: 128;
export declare const THROUGHPUT_WINDOW_MILLISECONDS: 60000;
export declare const THROUGHPUT_MIN_SAMPLE_INTERVAL_MILLISECONDS: 1000;
export type ThroughputRateUnavailableReason = 'initial-baseline' | 'receiver-discontinuity' | 'invalid-counter' | 'clock-rollback' | 'zero-elapsed';
/**
 * One physical receiver in a throughput sample. Identical logical consumers
 * share this counter, so `logicalConsumers` can grow without multiplying
 * `bytesReceived` or `bitsPerSecond`.
 */
export interface ThroughputSubscriptionSample {
    /** Stable physical subscription identifier for this receiver lifetime. */
    readonly id: string;
    readonly transport: ThroughputTransport;
    readonly logicalConsumers: number;
    readonly bytesReceived: number;
    /** Null until a valid prior counter sample exists, or after a discontinuity. */
    readonly bitsPerSecond: number | null;
    /** Explains a null rate; null means bitsPerSecond is valid. */
    readonly rateUnavailableReason: ThroughputRateUnavailableReason | null;
}
/** One timestamped snapshot of all active physical multicast receivers. */
export interface ThroughputSample {
    readonly timestampMilliseconds: number;
    /** Null when an exact aggregate rate cannot be derived for every active receiver. */
    readonly aggregateBitsPerSecond: number | null;
    readonly aggregateRateUnavailableReason: ThroughputRateUnavailableReason | null;
    readonly subscriptions: ReadonlyArray<ThroughputSubscriptionSample>;
}
/**
 * Bounded multicast/AMT receiver-ingress history. This accounting domain does
 * NOT include MoQ: every MoQ player owns an independent unicast connection and
 * must be measured and summed by the player layer.
 */
export interface ThroughputHistory {
    readonly version: 1;
    readonly accounting: 'physical-multicast-ingress';
    /** Which process owns this physical-ingress observation. */
    readonly vantage: 'iwa' | 'page-bridge';
    readonly windowMilliseconds: typeof THROUGHPUT_WINDOW_MILLISECONDS;
    /** Calls are caller-driven; this is only the recorder's coalescing floor. */
    readonly minSampleIntervalMilliseconds: typeof THROUGHPUT_MIN_SAMPLE_INTERVAL_MILLISECONDS;
    readonly samples: ReadonlyArray<ThroughputSample>;
}
/**
 * Inlined from `@blockcast/shared` per freeze §3.3 — see the file header.
 *
 * ⚠️ DELIBERATELY NARROWER than shared's copy, and the two are now independently
 * maintained by ruling. Shared carries infrastructure detail;
 * this type carries only what a PAGE can act on. Every member here is a
 * protocol a browser can actually dial. Before adding one, ask whether a page
 * can do anything with it — an internal node-to-node path cannot, and belongs
 * in shared's copy only. Removing a member after `1.0.0` is a MAJOR bump under
 * freeze §6.1, so the cost of a wrong add is permanent.
 *
 * ⚠️ Redaction obligation carried over from the source definition: the internal
 * report holds routing coordinates for several of these paths. Those are
 * infrastructure facts, and this type is reachable from a PUBLIC page API via
 * `Capabilities.transports`. A provider MUST redact them before handing a
 * report to the page; `assertCapabilitiesRedacted` in ./conformance.ts is the
 * machine check, and it reads the RUNTIME object — narrowing this type does not
 * narrow what a provider actually sends.
 */
export interface TransportCapabilityReport {
    /** SSM native multicast via Direct Sockets. */
    readonly nativeMulticast: {
        readonly confirmed: boolean;
        readonly lastPacketAt?: number;
    };
    /** AMT tunnel availability (RFC 7450 / DRIAD RFC 8777). `relay` must be absent on the page surface. */
    readonly amt: {
        readonly available: boolean;
        readonly relay?: string;
        readonly rttMs?: number;
    };
    /** MoQ relay (WebTransport). */
    readonly moqRelay: {
        readonly reachable: boolean;
        readonly rttMs?: number;
        readonly cause?: string;
    };
    /** WHIP/WebRTC ingress/egress relay advertised by catalog. */
    readonly whip: {
        readonly available: boolean;
        readonly endpoint?: string;
        readonly rttMs?: number;
    };
    /** Chrome extension WebTransport bridge detected. */
    readonly webTransportBridge: boolean;
    readonly networkHint?: 'wifi' | 'cellular' | 'ethernet' | 'unknown';
    /** Unix timestamp (ms) of the last observation update. */
    readonly observedAt: number;
}
/**
 * IP address families this build can join, mapped to their group-management
 * protocols. 'ipv4' ⇒ IGMPv3 (RFC 3376), 'ipv6' ⇒ MLDv2 (RFC 3810).
 */
export type AddressFamilySupport = 'ipv4' | 'ipv6';
export type SubscribeOriginSupport = SubscribeOrigin;
/**
 * `window.multicast.capabilities()` — snapshot of what this build supports.
 *
 * On every OPTIONAL member, `undefined` means UNKNOWN (the provider predates the
 * field), NOT "none". Treating absence as "none" silently disables working
 * transports against an older deployed provider.
 */
export interface Capabilities {
    readonly iwaVersion: string;
    /** Version of the webpage-facing origin capability contract, when advertised. */
    readonly originContractVersion?: 1;
    readonly consumeModes: ReadonlyArray<'bytes'>;
    readonly transports: TransportCapabilityReport;
    readonly plugins: ReadonlyArray<never>;
    /** Which `SubscribeConfig.origin` members this build can service. */
    readonly origins?: ReadonlyArray<SubscribeOriginSupport>;
    /** Over-the-air tuner standards. Empty array ⇒ no tuner stack; undefined ⇒ unknown. */
    readonly tuners?: ReadonlyArray<TunerStandard>;
    /** Address families this build can join. undefined ⇒ unknown. */
    readonly addressFamilies?: ReadonlyArray<AddressFamilySupport>;
}
/**
 * Canonical webpage-facing view of `window.multicast`.
 *
 * Feature-detect the GLOBAL, never its methods: the global is genuinely absent
 * when no provider is installed, but every member below is required once it
 * exists. `getThroughputHistory` is the sole exception — it is undefined only on
 * a deployed provider predating throughput history v1.
 */
export interface MulticastGateway {
    subscribe(config: SubscribeConfig): Promise<Subscription>;
    capabilities(): Promise<Capabilities>;
    /** Undefined only for an older deployed provider that predates history v1. */
    getThroughputHistory?(): ThroughputHistory | Promise<ThroughputHistory>;
}
declare global {
    interface Window {
        /**
         * Injected by a multicast provider into trusted page realms. `undefined`
         * when no provider is installed/connected — callers must feature-detect.
         *
         * This is the ONE canonical declaration of the global (freeze §3.3).
         * Earlier duplicate `declare global` blocks in other Blockcast packages
         * are each retired at their own removal gate, on evidence of zero live
         * callers.
         */
        multicast?: MulticastGateway;
    }
}
/**
 * JSON-safe wire shape for a gateway event crossing the IWA → extension →
 * webpage hop.
 *
 * That hop is `chrome.runtime.Port.postMessage`, which is JSON-serialized and
 * NOT structured-clone. An `ArrayBuffer` sent raw collapses to `{}` and arrives
 * with `byteLength === undefined`; a production regression saw 6500+ packets all
 * fail silently this way, because the receiving sequence-tracking branch was
 * never entered. Bytes are therefore base64-encoded at the marshaler and decoded
 * back to an `ArrayBuffer` at the page. Any adapter that "simplifies" this
 * reintroduces that regression.
 *
 * The 'error' variant flattens `MulticastError` to primitives because Error
 * subclasses lose their prototype chain across JSON serialization. `readiness`
 * survives the hop unchanged: `Readiness` is already JSON-safe (booleans,
 * strings, string arrays), which is one reason the not-ready ruling carries the
 * cause as a record rather than as extra union members.
 */
export type GatewayEventWire = {
    type: 'bytes';
    data: string;
} | {
    type: 'state';
    data: SubscriptionState;
} | {
    type: 'transportchange';
    data: ResolvedTransport;
} | {
    type: 'error';
    data: MulticastErrorWire;
};
/**
 * A `MulticastError` flattened for a JSON-serialized hop, and the ONE shape both
 * the event stream and every request/response envelope carry it in.
 *
 * It is named and shared because it was previously spelled out inline at nine
 * sites across three packages, and a hand-copied field list is the same drift
 * hazard the not-ready ruling closed for `MULTICAST_ERROR_CODES`: this type declared
 * `readiness` while the marshaler, the response envelopes and the page-side
 * reviver all silently dropped it, so `not-ready` arrived with no cause — the
 * exact collapse the ruling exists to undo, one hop further along. One type
 * means adding a field is one edit, and omitting it at a hop is a type error
 * rather than a field that quietly goes missing in transit.
 *
 * Fields beyond `code`/`message` are optional because a producer predating them
 * cannot send them. Absence means UNKNOWN — never a positive claim.
 */
export interface MulticastErrorWire {
    code: MulticastErrorCode;
    message: string;
    stack?: string;
    causeMessage?: string;
    /** Set when `code` is 'not-ready'. Absence means UNKNOWN, not ready. */
    readiness?: Readiness;
}
```

## `dist/readiness.d.ts`

```ts
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
export declare const LOCAL_NETWORK_PERMISSION_NAMES: readonly ["local-network", "loopback-network"];
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
export declare const DIRECT_SOCKET_CAPABILITIES: readonly ["udp", "tcp", "tcpServer"];
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
export declare const SUBSCRIBE_DIRECT_SOCKET_CAPABILITIES: readonly ["udp"];
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
export type ReadinessCode = 'ready' | 'provider-absent' | 'provider-unobservable' | 'iwa-not-installed' | 'iwa-extension-disconnected' | 'socket-worker-unavailable' | 'direct-sockets-unavailable' | 'network-permission-denied' | 'network-permission-required' | 'udp-bind-unverified' | 'udp-bind-failed';
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
export declare function evaluateReadiness(observation: ReadinessObservation, options?: EvaluateReadinessOptions): Readiness;
/**
 * How to present the legacy `local-network-access` alias without reporting a
 * healthy system as blocked. Returns null when there is nothing to show.
 */
export declare function describeLegacyPermissionAlias(permissions: NetworkPermissionObservation): {
    state: PermissionResult;
    detail: string;
} | null;
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
```
