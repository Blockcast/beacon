# ADR 0001: Interception mechanism for unmodified browser players

- Status: Proposed (awaiting CTO sign-off)
- Date: 2026-11-26
- Tracking: BLO-59455 (plan BLO-59454)
- Base: `codex/mabr-route-proxy-0.2.3` @ 7ed320d

## Context

`@blockcast/mabr-route-proxy` serves ROUTE-delivered DASH/HLS objects from a URL
cache, but only after page code calls `session.installFetch()`. The goal is that
ordinary DASH/HLS URLs loaded by unmodified Shaka, hls.js and dash.js are served
from ROUTE/multicast with no change to player code, while native SDKs keep
local-origin delivery.

Facts that constrain the choice (all from this repo):

1. `window.multicast` is installed in the **page** by
   `@blockcast/window-multicast-bridge` (WebTransport to a local bridge), and the
   `route.wasm` consumer runs in the page. Whatever answers a request needs the
   bytes the page-world session holds.
2. The cache is keyed by ROUTE Content-Location, **scope-limited** to the
   manifest's directory, never an origin root (ROUTE bytes arrive over
   unauthenticated multicast/AMT; a root scope lets an on-path injector shadow
   `/slt/` or any URL on the origin).
3. A miss, `cache: 'no-store'` or `'reload'` goes to the network.

## Candidates

"Unmodified" means no change to player code or player config. Columns: **P** =
Shaka/hls.js/dash.js unmodified, **Cov** = fetch / XHR / MSE-append coverage,
**Br** = Chromium / Firefox / Safari, **XO** = cross-origin segment URLs,
**Burden** = install and permission cost, **Fail** = failure mode.

| # | Candidate | P | Cov | Br | XO | Burden | Fail |
|---|---|---|---|---|---|---|---|
| A | Page-world patch of `fetch` + `XMLHttpRequest`, injected by a WebExtension content script (`world: MAIN`, `document_start`) | Yes: players call global `fetch`/XHR (Shaka uses fetch where available and XHR otherwise; hls.js and dash.js use either) | fetch yes, XHR yes, MSE not touched (not needed: bytes reach MSE via the player's own fetch/XHR) | Chromium MV3 yes; Firefox MV3 yes; Safari Web Extension yes (extension install via App Store app) | Yes: the patch sees the absolute URL; scope check decides | One extension install; host permissions limited to opted-in origins | Patch absent/throws: no interception, player does plain unicast. Scope miss: network |
| B | Same patch shipped as a plain `<script>` / ESM the site operator adds once | Yes (no player change, but one page tag) | same as A | All browsers (no extension) | Yes | Operator edits page template once; no user install | Same as A |
| C | Service Worker `fetch` handler | Yes for fetch and XHR (both are SW-visible) | Network requests only; MSE n/a | All current browsers | Only same-origin pages can register it; cross-origin segment fetches are interceptable only for the controlled page's requests, and opaque responses cannot be synthesised for CORS-mode players | Page must register a script (a page change) at the origin root or the scope it wants; broad scope is the exact shadowing risk in constraint 2 | SW dead/unregistered: network. But the SW has no `window.multicast`; needs a page-to-SW message channel and WASM or WebTransport duplicated in the worker |
| D | MV3 `declarativeNetRequest` / `webRequest` | Yes in principle | Network only | Chromium (blocking `webRequest` removed in MV3); Firefox keeps blocking `webRequest`; Safari partial | Yes | Extension + broad host permissions | **Rejected**: DNR can redirect or block but cannot synthesise a response body from multicast; redirect targets are static or extension-hosted, so it cannot serve live ROUTE objects |
| E | Patch `MediaSource`/`SourceBuffer.appendBuffer` | Yes | MSE only | Chromium/Firefox/Safari (MSE; iOS Safari lacks MSE, uses ManagedMediaSource) | n/a | Same injection need as A | **Rejected as primary**: appends carry no URL identity, so ROUTE Content-Location lookup is impossible; the player has already requested the segment (unicast bytes already spent); manifests are not covered |
| F | Local-origin native proxy (127.0.0.1 / BCDS) | Yes | Everything at the HTTP layer | All, but page needs HTTP(S) to localhost (mixed content, Local Network Access prompts) | Rewrite or CONNECT needed; MITM TLS for HTTPS origins | Native app install | Proxy down: URL unreachable unless the player is pointed elsewhere. This is already the **native SDK** path |

## Decision

1. **Primary: A, with B as the same artifact.** One mechanism-neutral resolver
   (BLO-59457) decides hit/miss for a request; one thin adapter patches page-world
   `fetch` and `XMLHttpRequest` and calls it. It is delivered as a WebExtension
   content script (A) for users, and as a script/ESM include (B) for operators who
   cannot ask users to install anything. The patch lives in the page world because
   `window.multicast` and `route.wasm` do too; this avoids duplicating WASM or a
   WebTransport session in another context.
2. **Service Worker (C): not primary; kept as an optional later adapter** behind
   the same resolver interface, for operators who want interception before page
   scripts run. It is not chosen first because it still requires a page change to
   register, cannot reach `window.multicast`, and is the widest-scope shadowing
   risk.
3. **Rejected: D** (cannot synthesise bodies) and **E as a primary** (no URL
   identity). E may be used later only as a *detector* (is the player stalled on
   unicast?), never to serve content.
4. **Honest limit:** a browser cannot intercept requests of a page with *zero*
   script on it and *no* extension. "Unmodified" here means no player code or
   config change; the minimum footprint is one extension or one tag.

## Boundary with native SDKs

The native path is **unchanged**: native SDKs (and F) keep local-origin delivery
through the BCDS bridge. The browser adapter is used only when
`window.multicast` resolves and the page is a browser player; it never runs in or
changes native SDK code, and native delivery does not depend on any browser
interception package. Neither path falls back into the other: browser miss goes to
the network, native follows its existing logic.

## Preserved constraints

- **Scope-limited cache.** The adapter delegates to the existing cache; only URLs
  under the manifest's directory are answered. The extension does not widen it.
- **Never an origin-root scope.** `start()` still throws for a root manifest unless
  `baseUrl` and `scope` are explicit; the extension must not supply a root scope
  by default. Extension host permissions are an opt-in list of origins, separate
  from (and not a substitute for) cache scope.
- **Miss means network.** Cache miss, `no-store`, `reload`, non-GET/HEAD, resolver
  error, WASM load failure or bridge absence all call the original `fetch`/XHR.
  Every adapter path wraps the resolver so any throw falls through to unicast.
- Telemetry stays best-effort (`onCacheEvent`) and never alters playback.

## Consequences

- BLO-59457 defines the resolver API with no `fetch` coupling; BLO-59458 builds
  the page-world fetch+XHR adapter and the extension/script packaging on it.
- Safari needs a separate Web Extension container build; plan for it as follow-up,
  not in the first slice.
- XHR patching must preserve `responseType`, progress events and abort semantics
  that Shaka/dash.js rely on; this is the main implementation risk.

## Not verified

Support claims for Firefox/Safari extension APIs and Safari MSE behaviour are
from documentation knowledge, not tested here. No browser run was done for this
ADR; the first adapter slice must include a Shaka, hls.js and dash.js e2e.
