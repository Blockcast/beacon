# Threat model: transparent ROUTE cache interception

Status: required input for the adapter work (BLO-59458) and the compat matrix
(BLO-59460). Parent plan: BLO-59454. The interception mechanism itself is
chosen in the ADR (BLO-59455); this document is written to hold for every
candidate (Service Worker, MV3 extension, injected page script, local native
proxy).

Baseline read: `packages/mabr-route-proxy` on `codex/mabr-route-proxy-0.2.3`
at `7ed320d`. Line references are to that commit.

## 1. What changes

Today the page opts in: it calls `session.installFetch()`, which patches the
page's own `fetch` and answers GETs under one scope directory from ROUTE
objects (`proxy.ts` `fetch()`). The blast radius is one page, one origin, one
session.

Transparent interception removes the page's consent. Whatever mechanism is
chosen, some component outside the page now decides which requests are
answered from bytes that arrived over **unauthenticated multicast or AMT**.
That widens three things at once:

| | `installFetch()` today | transparent adapter |
|---|---|---|
| who is answered | the page that installed it | every page the mechanism controls (SW: every page under its scope; extension: potentially every origin) |
| who chooses scope | the page, or derivation inside its own session | the adapter, possibly from data learned on the wire |
| fetch / XHR / MSE coverage | `fetch` only | whatever the mechanism sees, including requests the player never meant to cache |

## 2. Assets

1. **Playback integrity**: the bytes the player renders are the bytes the
   content owner published.
2. **Control-plane integrity**: DS discovery (`/slt/`), DRM licence and key
   requests, auth/token endpoints, and any non-media URL on the DS or page
   origin are never answered from multicast.
3. **Same-origin policy**: a page cannot read a response it could not read
   without the adapter.
4. **User privacy**: which services a user watches, and which multicast
   groups the network carries, is not observable by unrelated origins.
5. **Availability**: playback continues over unicast whenever the ROUTE path
   fails, is attacked, or is disabled.

## 3. Trust boundaries and attackers

- **Wire (untrusted).** UDP from DIMT/native multicast or an AMT relay. Any
  host that can send to the group (on-path, same L2, rogue AMT relay, spoofed
  SSM source where the network does not enforce RPF) controls: FDT
  `Content-Location`, `Content-Type`, TOI payloads, SLS/S-TSID documents and
  the SLS-carried manifests. ROUTE carries no authentication; the WASM
  `integrity` value (`route.ts:791`) is **FEC/completeness**, not
  authenticity, and defaults to `100` when the export is absent.
- **DS over HTTPS (trusted).** The DS origin reached by TLS: `/slt/`, the
  advertised `PresentationManifest`, unicast media.
- **Page origin (semi-trusted).** The player page. Trusted for its own
  origin; never trusted to read other origins' data.
- **Other origins (untrusted).** Any other site open in the same browser
  profile, which the adapter may also be able to see.
- **Adapter (trusted, privileged).** SW / extension / native proxy code.
  Its privileges are what is at stake.

Attackers considered:

- **A1 wire injector**: can send arbitrary ROUTE packets to a joined group.
- **A2 wire jammer**: can drop or corrupt multicast (or simply be a lossy
  network).
- **A3 hostile web origin**: any site the user visits while the adapter is
  installed.
- **A4 compromised/malicious DS-adjacent content**: out of scope. If the DS
  over HTTPS is compromised, unicast is compromised too.

## 4. Threats

### T1. Cache poisoning and shadowing (A1)

`MabrRouteProxy.put()` (`proxy.ts`) stores any completed object at its
`Content-Location` if the resolved URL starts with the scope. `fetch()` then
answers any GET/HEAD for that URL. What exists today:

- Scope check after WHATWG URL normalisation, so `../` and `%2e%2e` cannot
  escape a directory and absolute cross-origin locations are rejected
  (`index.test.ts` "refuses locations outside the baseUrl scope").
- Origin-root scope refused when derived (`route.ts:1046`).
- `cache: 'no-store' | 'reload'` always bypass the cache, which is what keeps
  discovery off multicast (`route.test.ts` "discovery skips DS URLs that
  multicast injected into the cache").

What is **not** covered and becomes worse under transparent interception:

- **T1a. In-scope substitution.** Inside the scope directory, A1 can replace
  any manifest or segment. `put()` deletes and re-inserts on every write, so
  the **last writer wins**: a legitimate object can be overwritten after the
  player first fetched it, and a later range request or retry gets different
  bytes.
- **T1b. Non-media shadowing inside scope.** The scope is a directory, not a
  type. If the DS places a licence endpoint, token, `/slt/`-like listing, JSON
  config or HTML under the manifest directory, it is shadowable. Under
  `installFetch()` only that page's `fetch` was exposed; under an SW or
  extension, every request to that URL from every controlled page is.
- **T1c. Requests the player did not issue.** A transparent mechanism also
  sees `<img>`, `<script>`, navigations, XHR from unrelated scripts, and
  `no-cors` requests. `fetch()` answers any GET/HEAD regardless of
  destination. A poisoned in-scope `.js` URL becomes script execution in the
  page origin if the page ever loads it.
- **T1d. Pre-scope window.** `RouteMabrSession` constructs its proxy with no
  `baseUrl`, so until `rescope` runs the scope is the page's directory
  (`proxy.ts` constructor, `route.ts:842`). On the SLS-derived path (SLT omits
  `PresentationManifest`), non-manifest SLS parts are `put()` before the scope
  is established (`route.ts` `#ingestManifest`). The general object path has
  the same gap: `#ingest` `put()`s every FDT object with `integrity >= 100`
  and a `contentLocation`, with no scope-established guard. In a page this is
  the page directory; in an SW it would be the SW script's directory, which is very
  often the origin root.
- **T1e. Cache eviction as a weapon.** `maxEntries` (default 256) is an
  insertion-order LRU with no per-entry or total byte budget. A1 can flood
  in-scope locations to evict real segments (forces T5) or send large objects
  to exhaust memory. In an SW or extension background context, memory
  exhaustion kills the worker for every page it serves.

### T2. Scope derivation from untrusted data (A1)

The scope decides what can be shadowed, so where it comes from matters.

- Explicit `baseUrl`/`scope`: page-chosen, trusted. Used as given.
- SLT `PresentationManifest` over HTTPS: trusted; cross-origin manifests are
  rejected (`route.ts:270`).
- **SLS-carried manifest location (multicast): untrusted.** When the SLT
  omits `PresentationManifest`, `#scopeManifestLocation` derives root and
  scope from a `Content-Location` A1 controls. The origin is pinned to the
  `sltUrl` origin and the origin root is refused, but **any non-root
  directory on the DS origin is reachable**, including `https://ds/slt/` (a
  manifest named `/slt/x.mpd` gives scope `/slt/`). Ranking picks the
  "best" candidate, so A1 can also out-rank the real manifest
  (`manifestRank`) and choose both the scope and `session.manifestUrl`.
- For an SW/extension the adapter is tempted to derive scope from whatever
  the player requests. That makes scope a function of attacker-influenced
  traffic (T1, T4).

### T3. Mechanism privilege scope (A3, A1)

- **Service Worker.** Can only be registered by script from its own origin
  and controls only that origin's pages under its path scope. It does see
  cross-origin subresource requests made by those pages and can answer them
  with a synthesised `Response`. An SW registered at `/` intercepts every
  request every page on the origin makes, for as long as it stays
  registered, including after the player page is closed. A poisoned SW
  state persists across reloads.
- **MV3 extension.** Host permissions decide which origins it can touch.
  `<all_urls>` plus content scripts gives the adapter (and any bug in it)
  read/write over every site. Exposing `window.multicast` from an extension
  to all pages would bypass the bridge's own origin admission
  (`window-multicast-bridge` README: exact origin allowlist,
  `originApproved()`), letting any site join groups (A3 uses the user's
  network for scanning or bandwidth abuse, and receives broadcast payloads).
- **Injected page script.** Same privilege as the page, but it patches
  globals shared with every other script in the page, including third-party
  ads and analytics.
- **Local native proxy.** Listens on a local port reachable by every origin
  (DNS rebinding, CSRF-style requests to `127.0.0.1`), unless bound to an
  authenticated scheme.

### T4. Cross-origin leakage (A3)

- **T4a. CORS bypass.** A synthesised `Response` from an SW or extension is
  not subject to the CORS check the DS would have applied. A page that could
  not read DS media over unicast can read it through the adapter. The same
  holds for `mode: 'no-cors'`: the network would return an opaque response,
  the adapter returns a readable one.
- **T4b. Credentials and auth.** The cache answers regardless of cookies,
  `Authorization`, signed-URL tokens, or Referer policy. If DS content is
  entitlement-gated over unicast, the adapter serves it to an unentitled
  page. Conversely, a careless miss path that rebuilds the request can add
  or strip credentials.
- **T4c. Cross-site cache probing.** One shared cache across pages and
  sites makes hit/miss observable: a hit is local and fast, a miss is a
  network round-trip. A3 can time `fetch(dsSegmentUrl)` to learn what the
  user (or another tab) is watching and which groups the network carries.
  Browsers partition the HTTP cache by top-level site for exactly this
  reason; an adapter-level cache undoes that partition.
- **T4d. Telemetry leakage.** `onCacheEvent` reports every URL. In an SW or
  extension this sees requests from every controlled page, not just the
  player.

### T5. Downgrade to unicast (A2, A1)

Fallback to the network is the safety property (asset 5), so forced
fallback is expected and acceptable as a **cost** attack (CDN egress) but
must never become a **correctness** attack:

- **T5a.** A2 drops or corrupts multicast: misses go to unicast. Acceptable,
  but must be visible (telemetry) so a sustained downgrade is detectable.
- **T5b.** A1 injects a manifest whose `BaseURL` / playlist URIs are
  absolute and point to an attacker origin. Those segments miss the cache
  (out of scope) and the player fetches them over the network **from the
  attacker**. Cache-scope enforcement does not stop this: it is a manifest
  integrity failure that is laundered through the unicast fallback.
- **T5c.** An adapter error path that fails *closed* (returns 5xx/empty
  instead of falling through) turns any wire fault into an outage.

### T6. Integrity of manifest vs segments (A1)

The manifest is the root of trust for a presentation: it names every
segment URL, codec, timing, DRM signalling and key URI. Today a manifest
retained from the SLS bundle is cached and, on the SLS-derived path, becomes
`session.manifestUrl` directly. So:

- **T6a. Manifest substitution** gives A1 total control: arbitrary segment
  URLs (T5b), altered DRM/key URIs (HLS `#EXT-X-KEY` URI pointing to an
  attacker), live-edge manipulation, or a different presentation entirely.
- **T6b. Segment substitution** (manifest authentic) lets A1 replace media
  bytes inside the scope: content replacement, and malformed MP4 that
  exercises MSE/decoder parsers (memory-safety surface in the browser).
  Encrypted (CENC/SAMPLE-AES) segments limit this to denial of playback.
- **T6c. Init/media mismatch.** Init segment from one source, media from
  another; produces decode errors or, worse, silent wrong output.

No ROUTE/FDT field available to the proxy today authenticates either. FEC
recovery (`raptorq`) restores the bytes A1 sent, not the bytes the content
owner sent.

## 5. Required mitigations (testable)

Each requirement is a MUST for the adapter (BLO-59458) unless marked
otherwise. Test names are the contract: the adapter PR must contain a test
with that name (or record the rename on BLO-59458), and the compat matrix
(BLO-59460) must run the `compat:` ones in every claimed cell.

### Scope and poisoning

| ID | Requirement | Test |
|---|---|---|
| R1 | The cache scope comes only from trusted sources: explicit config, or the HTTPS-fetched SLT `PresentationManifest`. A multicast-derived manifest location MUST NOT set or widen the scope under a transparent adapter. | `adapter: refuses to derive scope from an SLS-carried manifest location` |
| R2 | The scope is never an origin root and never contains `/slt/` or any configured control path (licence, token, config). Configured control paths are excluded even when inside scope. | `adapter: control paths inside scope are never answered from ROUTE` |
| R3 | No object is cached before the scope is established, on either store path (`#ingestManifest` SLS parts and `#ingest` FDT objects); nothing is stored under a default (page or worker) directory. The test injects one object through each path before scope is set. | `adapter: drops objects received before scope is established` |
| R4 | Only media is answered. A request is eligible only if ALL hold: (a) `request.destination` is `''`, `video`, `audio` or `track`; (b) the URL is the trusted manifest URL (R1/R8) or a segment named by it (R10), and the stored type is a manifest or media/init segment; (c) the initiating client is a configured player page: SW — `clients.get(event.clientId).url` path-matches the configured player URL; extension — the request's tab/frame URL matches it; native proxy — `Origin` is the player origin (R16). Script, style, document, image, worker and navigation requests always go to the network. The adapter does NOT attempt to tell the player's `fetch` from another script's `fetch` inside the same player page (`destination` is `''` for both); see §6. | `adapter: non-media destinations always reach the network` |
| R5 | First-write-wins per URL for the lifetime of an entry: once a URL has been served, a later object at the same location does not replace it (a new TOI for a live manifest is the one allowed update and must itself pass R9). | `adapter: a served segment is not replaced by a later injected object` |
| R6 | Total byte budget and per-object byte cap in addition to `maxEntries`; over-budget objects are dropped, not cached. | `adapter: oversized and over-budget objects are dropped` |
| R7 | `cache: no-store` and `reload` keep bypassing the cache through every mechanism (SW `event.request.cache`, extension, native proxy). | `adapter: no-store and reload bypass ROUTE` (+ `compat: discovery bypasses ROUTE`) |

### Manifest and segment integrity

| ID | Requirement | Test |
|---|---|---|
| R8 | Default mode: the manifest is fetched over HTTPS from the DS; ROUTE answers segments only. A multicast-carried manifest is used only when an authenticity check (R9) passes. | `adapter: default mode loads the manifest over unicast` |
| R9 | A multicast manifest, if allowed, MUST be authenticated against the DS over HTTPS (signature or digest published by the DS). Unverified manifests are dropped and the request falls through. | `adapter: unverified multicast manifest falls through to unicast` |
| R10 | ROUTE answers a segment only if its URL is referenced by the currently active, trusted manifest (resolved), so injected in-scope objects the manifest does not name are never served. | `adapter: segments not named by the trusted manifest are not served` |
| R11 | Segment authenticity: segments are served from ROUTE only when a per-segment digest from a trusted channel matches, OR the adapter is in an explicitly documented `unauthenticated-segments` mode that is off by default and allowlisted per DS origin. Until a digest channel exists, R11 is satisfied by the second branch plus the README warning. | `adapter: unauthenticated-segments mode is off by default` and, once a digest channel exists, `adapter: segment digest mismatch falls through to unicast` |
| R12 | The `integrity` value from route.wasm is treated as completeness only; it is never described or used as authentication. A missing `route_pop_completed_integrity` export does not count as 100 for a transparent adapter. | `adapter: missing integrity export is treated as incomplete` |

### Mechanism privilege

| ID | Requirement | Test |
|---|---|---|
| R13 | SW: registered on a path scope no wider than the player mount (never `/` unless the origin is player-only), and unregisters / clears its cache when the opt-in flag is turned off. | `adapter: service worker scope equals the configured player path` |
| R14 | Extension: host permissions limited to configured DS and player origins (optional host permissions requested at runtime); no `<all_urls>`; content scripts only on opted-in origins. Verified from the built manifest. | `adapter: extension manifest requests no <all_urls> host permission` |
| R15 | No adapter exposes `window.multicast` to an origin that the bridge's origin admission has not approved; the adapter reuses `window-multicast-bridge` and never relays groups on behalf of a page. | `adapter: unapproved origin cannot subscribe through the adapter` |
| R16 | Native/local proxy (if chosen): binds loopback only, rejects requests whose `Host`/`Origin` is not the configured player origin (DNS-rebinding guard). | `adapter: local proxy rejects foreign Host and Origin` |

### Cross-origin leakage

| ID | Requirement | Test |
|---|---|---|
| R17 | A request is answered from ROUTE only if the network would have given the page a readable response: same-origin, or `cors` mode to a DS origin on the per-player allowlist with a recorded successful CORS response for that initiator. The record is keyed (DS origin, initiator origin) and set only by the adapter's own unicast fall-through for that pair: SW/extension — the forwarded fetch resolved with `response.type === 'cors'`; native proxy — the upstream response carried `Access-Control-Allow-Origin` equal to the request `Origin` (or `*` for non-credentialed requests). No record means the request goes to the network. `no-cors` requests to another origin are never answered from ROUTE. | `adapter: cross-origin no-cors and non-allowlisted cors requests reach the network` |
| R18 | Entitlement-gated DS paths (configured) are never answered from ROUTE; requests carrying credentials (`credentials: include` with cookies, `Authorization`) to non-public paths fall through. | `adapter: credentialed requests to gated paths reach the network` |
| R19 | The cache is partitioned per top-level site; a hit in one partition is a miss in another's. Partition key by mechanism: SW — the registration's own storage (browsers key SW + Cache Storage by top-level site under storage partitioning); entries MUST NOT be shared through any channel outside that partition (extension messaging, native helper). Extension — top-level origin of the requesting tab (`tabs.get(tabId).url`); if it is unreadable (not a granted host, R14) the request is not answered from ROUTE. Native proxy — request `Origin` (top-level site is not observable; see §6). | `adapter: cache is partitioned by top-level site` |
| R20 | Miss fall-through forwards the original request unchanged (mode, credentials, referrer policy, headers, integrity attribute). | `adapter: miss forwards the original request unchanged` |
| R21 | Telemetry (`onCacheEvent`) is delivered only to the player that owns the session, not to other controlled pages or origins. | `adapter: cache events are not delivered to other clients` |

### Downgrade and failure

| ID | Requirement | Test |
|---|---|---|
| R22 | Every adapter error (WASM trap, decode error, budget exceeded, worker crash, extension disabled) falls through to the network; nothing returns a synthesised error. | `adapter: forced failure still plays over unicast` (already in BLO-59458's verifying signal) |
| R23 | Downgrade is visible: hit/miss counters and a "ROUTE unavailable" state are exported so sustained forced fallback is detectable. | `adapter: sustained miss rate is reported` |
| R24 | Manifest-referenced absolute URLs outside the trusted DS origins are never fetched on the strength of a multicast manifest (follows from R8/R9; asserted separately because it is the T5b laundering path). | `adapter: injected manifest cannot redirect segments to another origin` |

### Compat matrix (BLO-59460)

Run in every claimed player × browser × format cell:

- `compat: discovery bypasses ROUTE` (R7)
- `compat: forced failure still plays over unicast` (R22)
- `compat: non-media destinations always reach the network` (R4)
- `compat: injected in-scope object is not served` (R5, R10): the harness
  injects a ROUTE object at an in-scope URL the manifest does not name and
  one that overwrites a served segment, and asserts the player receives
  neither.

## 6. Residual risk (accepted, documented)

- **Unauthenticated segment bytes** (T6b) remain until a DS-published digest
  or signature channel exists. Mitigated to: opt-in, per-origin allowlist,
  manifest-referenced URLs only, first-write-wins. Encrypted content reduces
  this to denial of playback. The README must say this plainly.
- **Cost downgrade** (T5a): A2 can always force unicast. Detected (R23), not
  prevented.
- **Same-document scripts** (R4): any script running in the player page can
  `fetch` an eligible media URL and receive the ROUTE copy. Such a script
  could fetch the same URL from the network anyway; the exposure is only that
  it reads unauthenticated (T6b) bytes, which the player itself already does.
- **Native proxy partitioning** (R19): keyed by `Origin`, not top-level site,
  so a player origin embedded under two sites shares one partition.
- **Decoder attack surface**: malformed MP4 reaching MSE. Not mitigable in
  the adapter beyond R10/R11; relies on browser hardening.

## 7. Out of scope

- DS/HTTPS compromise (A4).
- Native SDK local-origin delivery (BLO-59459), except R16 if a local proxy
  is chosen for browsers.
- ATSC 3 A/360 signalling signatures: not checked against the current
  route.wasm build. If route.wasm gains signature verification of SLS/FDT,
  it can satisfy R9, and possibly R11, through the same tests.
