# beacon

Public home for the cross-platform `window.multicast` API: the frozen v1
contract, its executable conformance suite, and the platform adapters
(browser, Isolated Web App, iOS, Android).

## Packages

| package | what it is |
| --- | --- |
| [`@blockcast/multicast-contract`](packages/multicast-contract) | the frozen v1 contract, its read-only readiness surface, and the executable conformance suite. No dependencies. |
| [`@blockcast/multicast-browser`](packages/multicast-browser) | browser / extension / IWA adapter: structural provider resolution and readiness observation. Depends only on the contract, and consumes it type-only. |

iOS and Android adapters are not in this repository yet.

## Install

```sh
npm install @blockcast/multicast-browser
```

That pulls `@blockcast/multicast-contract` with it. Install the contract alone
if you are implementing a provider, or running the conformance suite against
one, rather than consuming a gateway.

## Quickstart

```ts
import { getGateway } from '@blockcast/multicast-browser';

const gateway = getGateway();          // MulticastGateway | null
if (!gateway) throw new Error('no multicast provider installed');

const subscription = await gateway.subscribe({
  group: '232.0.0.99',                 // IPv4 (IGMPv3) or IPv6 (MLDv2) literal
  port: 9876,
  source: '198.51.100.1',              // omit for any-source multicast
  consume: 'bytes',
});

subscription.addEventListener('bytes', (event) => {
  decode(event.detail);                // event.detail is an ArrayBuffer, always
});

await subscription.unsubscribe();
```

Attach the `bytes` listener promptly: at most `EARLY_BYTES_RETENTION_LIMIT`
(128) payloads are retained before the first listener attaches, and on overflow
the entire retained prefix is dropped rather than partially replayed.

Two reasons to prefer `getGateway()` over reading `window.multicast` directly:
it resolves the provider structurally rather than by cast, and it keeps you out
of the declaration-merge conflict with `@blockcast/mmt-transport` described
under *Installing alongside `@blockcast/mmt-transport`* in the
[contract README](packages/multicast-contract#readme).

Implementing a provider? The conformance suite is executable and ships in the
package:

```ts
import { runConformanceSuite } from '@blockcast/multicast-contract/conformance';

const report = await runConformanceSuite(driver);
if (!report.conformant) {
  // A skip is never a pass, so report both.
  console.error(report.checks.filter((check) => check.status !== 'pass'));
}
```

The [contract README](packages/multicast-contract#readme) is the place to go
next — error-code handling, readiness, and the five things that will bite you.
[`docs/reference-api.md`](packages/multicast-contract/docs/reference-api.md) is
the exhaustive surface, generated from the emitted declarations.

## Versioning

The v1 contract surface is frozen: `1.x` releases add nothing to it and remove
nothing from it. See
[`packages/multicast-contract/docs/RELEASE.md`](packages/multicast-contract/docs/RELEASE.md)
for the version policy, artifact verification, and rollback.

## Building from source

Each package is standalone — no workspace tooling, no lockfile, no private
source checkout. Build the contract first; the adapter's type resolution points
at its emitted declarations.

```sh
npm --prefix packages/multicast-contract install
npm --prefix packages/multicast-contract run build
npm --prefix packages/multicast-contract test

# The adapter lane is install-free: it resolves the contract from the sibling
# package's emitted declarations above, and its tests run on node's own type
# stripping. Its package.json dependency on the contract is there for consumers
# who install it from the registry.
packages/multicast-contract/node_modules/.bin/tsc -b packages/multicast-browser
npm --prefix packages/multicast-browser test
```

## License

MIT — see [LICENSE](LICENSE).
