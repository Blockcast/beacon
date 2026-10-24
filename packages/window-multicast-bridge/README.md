# `@blockcast/window-multicast-bridge`

Browser ESM polyfill that finds a local Blockcast bridge (the Beacon app, an
Isolated Web App, or a native BCDS bridge), connects to it over WebTransport, and
installs `window.multicast` on the page.

```js
import { initMulticastBridge } from '@blockcast/window-multicast-bridge';

window.addEventListener('multicast-bridge-ready', () => {
  // window.multicast is installed; resolve it with @blockcast/multicast-browser.
});
initMulticastBridge({ autoStart: true });
```

The package ships a minified ESM build in `dist/`:

| export | file | what it is |
| --- | --- | --- |
| `.` | `dist/multicast-bridge.js` | discovery, the BCDS-v1 WebTransport client, and `window.multicast` |
| `./bootstrap` | `dist/bridge-bootstrap.js` | the page-owned bootstrap coordinator described below |
| `./beacon-connect` | `dist/beacon-connect.js` | the iOS Connect Beacon link, described below |

Source lives in `src/`. Browsers load the built module directly, and bundlers
can consume it as an ordinary dependency.

## Page bootstrap coordinator

`src/bridge-bootstrap.js` is the canonical page-owned coordinator.
`createBridgeBootstrap()` owns the layers above discovery — capability
diagnostics, terminal status, a bounded discovery budget, and recovery — while
`initMulticastBridge()` keeps owning discovery, the BCDS-v1 WebTransport
handshake, and `window.multicast` installation. It never parses media and
never embeds a player.

Capabilities are reported before any probe (`probeBridgeCapabilities()`):
WebTransport support, secure context, per-host-class mixed-content viability,
and the fine-grained Local Network Access permissions. A missing capability is
a status with a reason (`webtransport-unsupported`, `insecure-context`,
`local-network-denied`), never an open-ended probe loop. The older
`local-network-access` alias stays informational: it reports `denied` on
Chromium builds where both fine-grained permissions are granted. A throw on the
launch path is held to the same contract rather than escaping: it terminates
with `launch-threw`, so a page carrying a hostile `window.multicast` accessor
gets a fallback instead of a `checking` status that never resolves.

Every stop is recoverable through a trigger rather than a timer: extension
readiness, a Local Network permission change, an origin approval
(`originApproved()`), or a bridge-instance change. A bridge instance is
identified by endpoint plus certificate pin, because the native bridge mints a
fresh certificate on each runtime start; an explicit descriptor `instanceId`
wins when one exists. Retries are bounded by `maxDiscoveryAttempts` and
`maxRetries`.

`transportPolicy` is honoured, not assumed. Only `auto` (and `moq-only`, which
skips the bridge outright) reports `fallback: 'moq-quic'`, returning the page
to the QUIC/MoQ path it started on. Under `multicast-only` a terminal status
carries no fallback: a forced native/AMT request that silently continued over
QUIC would read as multicast playback.

## Browser-page scope

This is a generic browser bridge with no native handoff or app-association
contract: Universal Links, App Links, AASA/asset-links files, the `/live*`
route, and `blockcast.network` hosts are not part of bridge discovery or
authorization. The optional `./beacon-connect` entry (below) builds Beacon's
universal link; discovery and authorization never read it. `initMulticastBridge()` discovers a local BCDS bridge and may
install `window.multicast` on any browser page (including a non-Blockcast
HTTPS origin, a mobile browser page, or a local development page); it does not
inspect the page host or pathname. Discovery uses the configured browser
origin for the bridge's exact origin allowlist and then connects directly over
WebTransport. A player may import and arm the bridge from any page; `/live*`
is not required for browser use.

Certificate pinning does not grant iOS background execution: when Beacon is
the same-device bridge, suspending Beacon suspends that bridge for the browser.
A separate always-running LAN gateway is independent of the phone app's
lifecycle.

## Connect Beacon (iOS)

Safari finds Beacon's bridge through Beacon's Safari extension. Chrome,
Firefox, Edge and the other iOS browsers have no extension, and WebKit blocks
an HTTPS page's loopback `/health` probe, so discovery cannot reach Beacon from
them. `./beacon-connect` gives any page a one-tap pairing link instead:

```html
<a id="beacon-connect" hidden>Connect Beacon</a>
```

```js
import { initMulticastBridge } from '@blockcast/window-multicast-bridge';
import { offerBeaconConnect } from '@blockcast/window-multicast-bridge/beacon-connect';

offerBeaconConnect(document.getElementById('beacon-connect'));
initMulticastBridge({ autoStart: true });
```

The offer follows the bridge's window events, so it works whoever builds the
controller: this page, `createBridgeBootstrap()`, or a player library. Every
transition `onStatus` reports is also dispatched on `window` as
`multicast-bridge-status`, with `detail: { phase, ok, reason }` and no endpoint
or pin. The link appears on a discovery miss or a failed connect, so a page
that is already paired never flashes it, and a stale pin offers it again. It is
withdrawn on `multicast-bridge-ready`. `offer.onStatus` takes the same events
from any other feed.

It is offered only on iOS, over HTTPS, in the top-level page. The tap goes to
`https://www.blockcast.network/beacon/connect`, or to
`https://blockcast.network/beacon/connect` from a page on `www`. `return=`
names Chrome, Firefox or Edge; every other iOS browser, and an iPad browser
that requests desktop sites without its product token, is returned to Safari.
`to=` names the page, without credentials or discovery-steering fields and
escaped to RFC 3986, as Beacon parses it. Beacon starts its bridge and reopens
the page in that browser with the bridge's pin in the fragment.
`initMulticastBridge()` keeps the pin as a pairing, so later visits connect
with no tap. Beacon applies its own origin admission to `to`.

iOS opens Beacon only for a navigation made while the user's tap is being
handled, in the top-level frame, to a host other than the top-level page's.
Keep the control a real link; the helper rebuilds its href inside the tap. The
helper shows and hides it with `hidden`, so do not give it a `display` rule
without a matching `[hidden] { display: none }`. When iOS does not hand the tap
to Beacon (Beacon not installed, or a private tab, where Chrome and Firefox
never open apps from links), it opens the web page at that address instead.
`beaconConnectUrl()` returns the bare href for pages that render their own
control.

## Discovery boundary

When a trusted caller supplies a known hostname and certificate pin, the browser
connects directly; it does not fetch `/health` or `/certificate.sha256`:

```text
https://player.example/watch?mc_bridge=beacon.local&wt_port=33445&fingerprint=<64-hex-SHA256>
```

The OS must resolve the actual advertised `.local` hostname; a DNS-SD service
instance name alone is not a hostname. The pin is SHA-256 of the complete leaf
certificate DER, supplied through an authenticated channel, not learned from
HTTP or an unsigned Bonjour TXT record. Explicit pins bypass discovery caches
and saved gateways. A wrong, expired, or malformed pin fails closed. A known
hostname does not establish the initial pin's trust, and a server pin does not
replace the bridge's origin-admission policy.

Presence of both `mc_bridge` and `fingerprint` (or `fp`) selects this strict
path, even if a value is empty. Empty or malformed values are configuration
errors, not permission to discover another gateway; remove the parameters to
request ordinary discovery. A bare `fingerprint` without `mc_bridge` is not
bridge configuration.

An explicit loopback pin on an HTTPS page is dialled directly and remains
subject to browser local-network permission. It is never rerouted through a
saved AutoTLS gateway to bypass that policy.

WebTransport pinned certificates must be valid for no more than 14 days. The
native bridge currently issues a fresh certificate on each runtime start, so
the caller must supply the current pin after a restart or rotation. This direct
path does not add a pin-distribution service or manual certificate UI.

Ordinary HTTPS JavaScript cannot enumerate DNS-SD/mDNS services or issue
DNS-SD/mDNS queries. Without explicit pinned configuration, discovery probes the native
bridge's loopback `/health` endpoint (`localhost` or `127.0.0.1`; `localhost`
also covers a bridge bound to `::1`),
validates the BCDS-v1 capability and complete SHA-256 certificate fingerprint,
and then opens a direct WebTransport (QUIC) connection pinned to that
fingerprint.
This HTTP bootstrap depends on browser policy and is blocked by Safari on
HTTPS pages; it is not a universal mobile discovery mechanism.

LAN discovery is a separate platform capability. An installed IWA, browser
extension, or native platform proxy can use its platform DNS-SD stack to
discover `_multicast-bridge._udp.local.` and provide a concrete configured
private endpoint to the browser. A regular page does not enumerate that
service itself. The bridge remains bridge-only: it carries multicast bytes to
`window.multicast`, while the browser owns presentation resolution and media
rendering.

## Batched packet delivery (`packets` event)

A bytes subscription returned by this bridge also emits `packets`: every
packet the reader decoded in one dispatch batch, in arrival order, as one
frozen array. Each element is exactly what one `bytes` event would have
carried (an `ArrayBuffer`, or `{ data, receiveTime, receiveTimeOrigin?,
receiveTimestampSource }` when the frame had timing metadata). The batch ends
where the reader's synchronous run already ends — at its existing yield point,
or at the end of a WebTransport read — so no packet waits on a timer and the
batch adds no size constant of its own.

`packets` is a provider extension, not part of the frozen v1
`window.multicast` contract. Feature-detect it before use and listen to exactly
one of the two surfaces:

```js
if (subscription.eventTypes?.includes('packets')) {
  subscription.addEventListener('packets', (event) => {
    for (const packet of event.detail) consume(packet);
  });
} else {
  subscription.addEventListener('bytes', (event) => consume(event.detail));
}
```

A subscription only builds the events some listener asked for, so a
`packets`-only consumer never pays for a per-packet DOM event (measured `dispatchEvent` + `CustomEvent` at about 22 ms of main thread per
second at ~450 packets/s on a Kirin 659). `bench/packet-dispatch.mjs` drives the
real reader into a real subscription and reports DOM events and CPU time per
packet for both surfaces.

## Declared delivery (`subscription.delivery`)

A bytes subscription reports how its packets reach the page, as the bridge
**server** declared it in `subscribe_response`:

- `'ordered-relay'`: every packet travels the subscription's one reliable BCDS
  uni stream in socket-read order. The server may drop its oldest queued
  packet on overflow but never reorders, so the page sees a subsequence of the
  socket's receive order. `native-bcds-bridge` (the iOS Beacon bridge) declares
  this; it sends no datagram media.
- `'datagram'`, or `undefined` when the server made no declaration: no
  ordering promise.

`@blockcast/mmt-transport`'s `MulticastTransport` reads it once per join and, for
`'ordered-relay'`, has `FECManager` decide FEC block fate by stream order
instead of the datagram inactivity deadline: a relay pause carries no loss
information. With that deadline, 50-200 ms pauses on the stream failed ~7-9% of
blocks on iPhone Safari, with only ~0.2% wire loss. The client
passes the declaration through and never infers it; a server that can also
send WT datagram media for a subscription (for example the IWA service worker
with datagram media enabled) must not declare `'ordered-relay'`. The value is
fixed for the life of a page subscription; a reconnect replay that declares
differently is logged, not applied.

## Building and testing

```sh
npm --prefix packages/window-multicast-bridge install --include=dev
npm --prefix packages/window-multicast-bridge run build   # src/ -> minified dist/
npm --prefix packages/window-multicast-bridge test
npm --prefix packages/window-multicast-bridge run test:dist  # same suite on the minified dist/
```

`test/vectors/` holds the cross-language contract vectors the native bridge also
tests against (`packet-id-allow-list-v1.json`, `bridge-enrollment-v1.json`).
Change them in step with the bridge servers; `test/vectors.test.mjs` pins their
digests, so a change has to update the pin too.

## Releasing

The bridge versions independently of the contract and the adapter, so it rides
its own tag: push `window-multicast-bridge-v<version>`, matching `version` in
this `package.json`. CI builds, tests and packs it, checks the tag against the
packed version, and publishes with provenance through npm trusted publishing.
The first publish of the name needs the one-time bootstrap in
[`../multicast-contract/docs/RELEASE.md`](../multicast-contract/docs/RELEASE.md).
