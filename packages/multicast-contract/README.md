# `@blockcast/multicast-contract`

The frozen v1 `window.multicast` contract, its read-only readiness surface, and
an executable conformance suite.

Zero runtime dependencies, deliberately. This package is the sink of the import
DAG, which is what stops the canonical global declaration from being pulled into
a package cycle. Adding a dependency here — especially on `@blockcast/shared` or
`@blockcast/transport` — recreates the cycle this package exists to break and
drags an unpublished package into a public surface. CI asserts the dependency
set stays empty.

## What a page sees

```ts
import type { MulticastGateway, Subscription } from '@blockcast/multicast-contract';

// Feature-detect the GLOBAL, never its methods. The global is genuinely absent
// when no provider is installed; every member is required once it exists.
if (!window.multicast) throw new Error('no multicast provider installed');

const subscription = await window.multicast.subscribe({
  group: '232.0.0.99',   // IPv4 (IGMPv3) or IPv6 (MLDv2) literal
  port: 9876,
  source: '198.51.100.1', // omit for any-source multicast
  consume: 'bytes',
});

subscription.addEventListener('bytes', (event) => {
  // event.detail is an ArrayBuffer, always.
  decode(event.detail);
});
subscription.addEventListener('transportchange', (event) => {
  // 'native' | 'amt' — fires on every resolution, including failover.
  reportLeg(event.detail);
});

await subscription.unsubscribe();
```

### Five things that will bite you

1. **Compare error codes, never `instanceof`.** The provider hop is
   JSON-serialized, not structured-cloned, so an `Error` subclass loses its
   prototype chain in transit. Use `multicastErrorCodeOf(err)`.
2. **`not-ready` carries its cause on `err.readiness`, not in the code.** There
   is one `not-ready` member, not one per cause: the ten-way reason lives in the
   `Readiness` record (`err.readiness.code`), which is the same vocabulary
   `evaluateReadiness` returns. So "permission denied" reads as
   `err.code === 'not-ready' && err.readiness?.code === 'network-permission-denied'`,
   and that is deliberately distinct from `network-permission-required` — the
   first needs the user to reverse a refusal, the second needs a prompt that has
   not been shown yet. `err.readiness` is `undefined` on a provider predating
   this field; that means **unknown**, never *ready*. Note `origin-not-trusted`
   is a separate denial (of page origin, not of OS local-network access) and is
   not a readiness code at all.
3. **Attach your `bytes` listener promptly.** At most
   `EARLY_BYTES_RETENTION_LIMIT` (128) payloads are retained before the first
   listener attaches. On overflow the *entire* prefix is dropped — deliberately,
   because replaying a partial prefix and then resuming live delivery would
   fabricate a gap-free stream across a real discontinuity.
4. **`origin` is required on every non-legacy member.** A config carrying
   `relay`/`relayPort` but no `origin: 'amt'` matches the legacy IP-multicast
   member instead. TypeScript rejects it; plain JavaScript silently falls back to
   native multicast and ignores the relay.
5. **An optional capability field that is `undefined` means _unknown_, not
   _none_.** The provider predates the field. Treating absence as "none"
   disables transports that actually work.

## Readiness

`evaluateReadiness` is a pure function of a caller-supplied observation. It
reports; it never prompts, grants, or opens a window — prompting is host UX by
ratified decision, and on the deployed system a gateway call auto-opens a
provider window, so a self-probing readiness API would pop a window merely for
being asked a question.

```ts
import { evaluateReadiness } from '@blockcast/multicast-contract';

const readiness = evaluateReadiness(observation);
if (!readiness.ready) console.warn(readiness.code, readiness.detail);
```

Three distinctions the result type keeps apart, each of which sends a user to the
wrong fix when collapsed:

- `provider-unobservable` vs `provider-absent` — provider detection is a
  fire-and-forget probe with no built-in timeout, so before your deadline
  elapses, silence is not a verdict.
- `udp-bind-unverified` vs `udp-bind-failed` — the provider only attempts a bind
  once both permissions are granted, so `udpBind` is tri-state and `null` means
  *not attempted*.
- `network-permission-required` vs `network-permission-denied` — an
  `unsupported` permission name is not a denial. Chromium throws for names it
  does not implement, and the local-network names have shipped under different
  spellings.

`iwa-not-installed` and `iwa-extension-disconnected` gate the **extension
topology only**, keyed on `extensionResponded === true`. The two live providers
are asymmetric: the extension installs `window.multicast` at `document_start`
knowing nothing about the IWA and then routes every call through the IWA, so
presence of the global proves nothing; the bridge polyfill installs the global
only after it has connected, so presence already implies a live bridge and it
never speaks to the extension at all. Gating both topologies would report a
healthy polyfill-backed page as broken.

The authoritative permission names are `local-network` and `loopback-network`.
The older `local-network-access` alias reports `denied` on healthy systems and is
informational only; render it with `describeLegacyPermissionAlias`.

Location is optional and outside subscription semantics. `evaluateReadiness`
never consults it, and `runConformanceSuite` pins that separation on every run
via the driver-independent `location-outside-readiness-suite` check, which
sweeps one observation per readiness code.

## Conformance

```ts
import { runConformanceSuite } from '@blockcast/multicast-contract/conformance';

const report = await runConformanceSuite(driver);
if (!report.conformant) console.error(report.checks.filter((c) => c.status !== 'pass'));
```

Checks run against a `ConformanceDriver`, not against a browser, so one
definition of "conformant" covers the browser providers, the reference fake, and
the iOS/Android adapters. A driver that omits an optional control hook makes the
checks needing it report `skipped` — and **a skipped check is never a pass**:
`report.conformant` is false while anything was unobserved.

`FakeMulticastProvider` is a reference-conformant in-memory provider. Use it
instead of hand-rolling another `window.multicast` stub; it marshals bytes
through the same base64 hop as the real transport, so a consumer test that passes
against it also survives the serialization boundary.

```ts
import { runConformanceSuite } from '@blockcast/multicast-contract/conformance';
import { FakeMulticastProvider } from '@blockcast/multicast-contract/fake-gateway';

const report = await runConformanceSuite(new FakeMulticastProvider());
```

## Commands

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test, no install of anything beyond typescript
npm run build       # emits dist/ with declarations
```

## Installing alongside `@blockcast/mmt-transport`

`@blockcast/mmt-transport` ships its own `declare global` block for
`Window.multicast`, typed as its `WindowMulticastGateway`. This package declares
the same global as `MulticastGateway` — the one canonical declaration. Both in
one TypeScript program is a declaration-merge conflict.

Measured against `@blockcast/mmt-transport` 0.2.0, 0.2.1 and 0.2.2 (every stable
release published to date) on TypeScript 5.9.3:

| your code | `skipLibCheck: false` | `skipLibCheck: true` |
| --- | --- | --- |
| reads `window.multicast`; this package imported first | `TS2717` | clean |
| reads `window.multicast`; `mmt-transport` imported first | `TS2717` + `TS2322` | **`TS2322`, in your own file** |
| never names the global — uses `getGateway()` | `TS2717` | clean |

Two things follow.

**`TS2717` is unavoidable while both packages are installed.** It is reported
inside a dependency's `.d.ts`, so the usual `skipLibCheck: true` suppresses it.
It does not affect emit.

**`TS2322` is avoidable — and do not rely on import order to avoid it.** Which
declaration wins the merge is decided by module load order across the whole
program, not by one file's import list, so a build that is clean today can break
when an unrelated file is added. Instead, never name the global's type: use
`getGateway()` / `hasGateway()` from `@blockcast/multicast-browser`, which
returns `MulticastGateway | null`.

```ts
import { getGateway } from '@blockcast/multicast-browser';

const gateway = getGateway();       // MulticastGateway | null
if (gateway) await gateway.subscribe(config);
```

No `@blockcast/*` package depends on `mmt-transport`, so it reaches your tree
only if you install it yourself — there is no transitive path.
