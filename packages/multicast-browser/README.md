# `@blockcast/multicast-browser`

The browser / extension / IWA adapter for the frozen v1 `window.multicast`
contract (`@blockcast/multicast-contract`).

The contract package is a deliberately **pure** leaf: `evaluateReadiness` is a
pure function of a caller-supplied observation, and the gateway surface is types
only. Something has to bind that to a real browser realm, and until this package
nothing did — the contract shipped with zero consumers. This is that binding, and
nothing more:

| job | entry point |
|---|---|
| Resolve the installed provider against `MulticastGateway` | `getGateway`, `hasGateway` |
| Collect the facts `evaluateReadiness` consumes | `observeReadiness` and its parts |
| Run the contract's conformance suite in a browser realm | `createBrowserConformanceDriver` |

## Zero runtime dependencies

Asserted in CI, for the same reason the contract asserts it: this is a public
surface, and a runtime edge from here would drag the unpublished workspace — and
eventually a compiled libmmt artifact — into it. The contract is consumed
**type-only**, so the emitted JS imports no bare specifier at all. A test pins
that shipped sources use `import type`; the CI lane pins it again on the built
output.

## Usage

```ts
import { evaluateReadiness } from '@blockcast/multicast-contract';
import { getGateway, observeReadiness } from '@blockcast/multicast-browser';

const gateway = getGateway();
if (gateway === null) {
  // Not an exception — an absent provider is the expected state on most pages.
  const readiness = evaluateReadiness(
    await observeReadiness({ extensionDeadlineElapsed: true }),
  );
  console.warn(readiness.code, readiness.detail); // e.g. 'provider-absent'
} else {
  const subscription = await gateway.subscribe(config);
}
```

Nothing here prompts, grants, or opens a window. Setup UX stays with the host
(ratified in the contract freeze), and that is not only a layering preference: on the
deployed system every gateway call routes through `sendToIWA`, which auto-opens
an IWA window as a side effect — so a readiness API that probed for itself would
pop a window as a consequence of asking "are you ready?".

## Three places this is easy to get wrong

Each of these has a live failure mode behind it, and each is pinned by a test.

**`udpBind` is tri-state and must stay tri-state.** A real ephemeral UDP bind is
the only proof Direct Sockets works, but the provider only attempts it once both
fine-grained permissions are granted. So `null` means NOT ATTEMPTED, and
collapsing it to `false` reports "we never tried" as "the bind failed" —
different cause, different fix, different message, and the contract has separate
codes (`udp-bind-unverified` vs `udp-bind-failed`). The deployed IWA currently
collapses it; `readSocketWorker` does not.

**The legacy `local-network-access` alias must never gate readiness.** Current
Chromium reports it `denied` while both fine-grained names are `granted`, so
gating on it reports a working bridge as blocked. It is carried on
`legacyAlias` as informational only.

**`extensionResponded` stays `null` until the caller's deadline elapses.**
Extension detection is a fire-and-forget probe with no built-in timeout, so
silence is indistinguishable from absence until then — and the contract reads
`null` as not-yet-observed rather than as a verdict. The deadline is the caller's
parameter because only the caller knows when it started probing.

## What this package cannot see, and says so

`observeReadiness` takes socket-worker diagnostics as a **parameter** rather than
probing for them, because they are not observable from a page realm: the socket
worker lives in the IWA's `isolated-app:` realm, and the extension exposes no
page-facing diagnostic channel. Omitting them yields
`socket-worker-unavailable`, which is the honest reading for a caller that
genuinely cannot see the worker. Inventing a healthy default would certify a
provider nobody checked.

## Build and test

The contract's **declarations** are the type source, so build it first:

```bash
pnpm --filter @blockcast/multicast-contract build
cd packages/multicast-browser
npm install --ignore-scripts   # typescript only
npm run typecheck
npm test                       # unit + browser conformance
npm run build
```

CI runs exactly this in `.github/workflows/multicast-contract.yml`, after the
contract's own steps. The `tsconfig.json` path mapping is replaced with a
published pin when the package is extracted to its public repository.
