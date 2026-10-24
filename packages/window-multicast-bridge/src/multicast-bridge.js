/**
 * Multicast Bridge Polyfill
 *
 * Standalone ES module that discovers the IWA bridge through mDNS,
 * AutoTLS, or loopback, connects via WebTransport (QUIC), and exposes
 * lowercase `window.multicast`.
 *
 * Transport: WebTransport (QUIC) only.
 *    - No mixed content issues (HTTPS-native)
 *    - Unreliable datagrams possible (no HOL blocking)
 *    - Uses serverCertificateHashes for self-signed cert verification
 *
 * There is no WebSocket fallback: production is WebTransport-only (the
 * `moq-relay-ws` route was removed), so the bridge fails hard when
 * WebTransport cannot connect rather than masking the gap behind a non-prod
 * WS path. See BLO-8314 / BLO-9073.
 *
 * If the extension already set `window.multicast`, this module is a no-op.
 */

const TAG = '[multicast-bridge]';
const DEFAULT_HTTP_PORT = 33446;
const DEFAULT_WT_PORT = 33445;
const DESKTOP_LAN_SCAN_DEFAULT_PREFIXES = ['192.168.1', '192.168.0'];
const DESKTOP_LAN_SCAN_BATCH_SIZE = 32;
const DESKTOP_LAN_SCAN_PROBE_TIMEOUT_MS = 700;
const POLL_INTERVAL = 5000;
const POLL_MAX_INTERVAL = 60000;
const POLL_BACKOFF_FACTOR = 1.6;
const POLL_JITTER_RATIO = 0.2;
const POLL_LOCK_RETRY_MS = 1200;
const SUBSCRIBE_TIMEOUT = 10000;
const UNSUBSCRIBE_TIMEOUT = 5000;
const WT_CONTROL_WRITE_TIMEOUT_MS = 5000;

/**
 * MMTP `packet_id` of the signaling flow, reserved by ISO/IEC 23008-1
 * (`MMTP_SIGNALING_PACKET_ID` in `@blockcast/mmt-base`). The FFmpeg
 * `moq_mmt` muxer sends the AL-FEC message on it, so it is never a track's,
 * and the MMT receiver drops it even when a join's allow-list names it. Both bridges
 * refuse a `packet_ids` list naming it; refusing here as well means a bridge
 * build that predates that refusal cannot accept a subscribe that delivers
 * nothing.
 */
const MMTP_SIGNALING_PACKET_ID = 0;
/**
 * Same text as the IWA and native bridges' refusal; pinned by
 * packages/native-bcds-bridge/vectors/packet-id-allow-list-v1.json.
 */
const SIGNALING_PACKET_ID_REFUSAL =
  'packet_ids must not include 0: packet_id 0 is the MMTP signaling flow ' +
  '(reserved by ISO/IEC 23008-1), not a track, and the receiver discards it';

/**
 * Largest `packet_ids` list either bridge accepts (IWA
 * `MAX_PACKET_IDS_PER_SUBSCRIPTION`, native-bcds-bridge's same-named cap).
 */
const MAX_PACKET_IDS_PER_SUBSCRIPTION = 64;

/**
 * Validate a `setPacketIds()` list the way both bridges validate `packet_ids`,
 * de-duplicated in caller order. An empty list asks for every packet ID.
 */
function normalizeSetPacketIds(packetIds) {
  if (!Array.isArray(packetIds)) {
    throw makeMulticastError('subscription-failed', 'packet_ids must be an array');
  }
  if (packetIds.length > MAX_PACKET_IDS_PER_SUBSCRIPTION) {
    throw makeMulticastError(
      'subscription-failed',
      `packet_ids must contain at most ${MAX_PACKET_IDS_PER_SUBSCRIPTION} entries`,
    );
  }
  const seen = new Set();
  for (const packetId of packetIds) {
    if (packetId === MMTP_SIGNALING_PACKET_ID) {
      throw makeMulticastError('subscription-failed', SIGNALING_PACKET_ID_REFUSAL);
    }
    if (!Number.isInteger(packetId) || packetId < 1 || packetId > 0xffff) {
      throw makeMulticastError(
        'subscription-failed',
        'packet_ids entries must be integers in the range 1-65535',
      );
    }
    seen.add(packetId);
  }
  return [...seen];
}

/**
 * Whether a recorded packet-ID filter report is newer than an incoming one, by
 * arrival order on the control stream. A report without an order (a server
 * response the page did not number) is never treated as stale.
 */
function packetIdReportSupersedes(recordedSeq, incomingSeq) {
  return Number.isInteger(recordedSeq) && Number.isInteger(incomingSeq) && recordedSeq > incomingSeq;
}

/** A packet-ID list as a filter: a Set, or null for every packet ID. */
function packetIdFilter(packetIds) {
  return Array.isArray(packetIds) && packetIds.length > 0 ? new Set(packetIds) : null;
}

/**
 * The one filter that serves every consumer sharing a receiver: null (every
 * packet ID) as soon as one consumer asked for all of them, or when the union
 * of individually legal lists exceeds what a bridge accepts. Forwarding
 * everything is always a legal request, and each consumer is still delivered
 * only its own list.
 */
function packetIdFilterUnion(lists) {
  const union = new Set();
  const size = packetIdUnionSize(lists);
  if (size === null || size > MAX_PACKET_IDS_PER_SUBSCRIPTION) return null;
  for (const packetIds of lists) for (const packetId of packetIds) union.add(packetId);
  return union;
}

/** Distinct packet IDs across the lists, or null if one asks for all of them. */
function packetIdUnionSize(lists) {
  const union = new Set();
  for (const packetIds of lists) {
    const filter = packetIdFilter(packetIds);
    if (!filter) return null;
    for (const packetId of filter) union.add(packetId);
  }
  return union.size;
}

/**
 * Warn when a bridge is about to be asked for every packet ID only because
 * the consumers' lists spill over the cap: a bandwidth cliff, not a gradual
 * cost. Called where the request is sent, so it fires once per transition.
 */
function warnIfPacketIdUnionOverCap(lists) {
  const size = packetIdUnionSize(lists);
  if (size === null || size <= MAX_PACKET_IDS_PER_SUBSCRIPTION) return;
  console.warn(
    `${TAG} Consumers of one endpoint need ${size} packet IDs, over the ` +
      `bridges' ${MAX_PACKET_IDS_PER_SUBSCRIPTION}; forwarding every packet ID instead`,
  );
}

/** True when every packet `inner` admits is also admitted by `outer`. */
function packetIdFilterCovers(outer, inner) {
  if (!outer) return true;
  if (!inner) return false;
  for (const packetId of inner) if (!outer.has(packetId)) return false;
  return true;
}

function samePacketIdFilter(a, b) {
  return packetIdFilterCovers(a, b) && packetIdFilterCovers(b, a);
}

/** MMTP packet_id from the fixed four-byte header prefix, or undefined. */
function mmtpPacketIdOf(data) {
  let bytes;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, Math.min(4, data.byteLength));
  } else return undefined;
  return bytes.byteLength >= 4 ? (bytes[2] << 8) | bytes[3] : undefined;
}

/**
 * The MMTP packet_id of a packet event, read once where the event is created
 * (`_handleStreamMessage`) from the frame bytes already in hand. The key is a
 * module-private Symbol, so `Object.keys`, `for...in`, `JSON.stringify` and
 * structured clone never see it, and `bytesEventDetail` builds the public
 * `window.multicast` detail without it.
 */
const MMTP_PACKET_ID = Symbol('mmtpPacketId');

/**
 * A packet event as `_handleStreamMessage` creates it: a plain object (its
 * prototype is `Object.prototype`) carrying `data` and, under
 * `MMTP_PACKET_ID`, the packet ID read at ingest. A constructor rather than a
 * literal so V8 gives the object in-object room for the ID and for the
 * receive-time fields some frames add: no descriptor, no builtin call and no
 * out-of-object property storage per packet.
 */
function PacketEvent(data, packetId) {
  this.data = data;
  this[MMTP_PACKET_ID] = packetId;
}
PacketEvent.prototype = Object.prototype;

/**
 * Same result as `mmtpPacketIdOf(payload)` for `payload =
 * frame.subarray(offset)`, read in place without a view.
 */
function mmtpPacketIdAt(frame, offset) {
  return frame.byteLength - offset >= 4 ? (frame[offset + 2] << 8) | frame[offset + 3] : undefined;
}

/**
 * A packet event's MMTP packet_id: the one read at ingest, or, for an event
 * this module did not create (a caller-supplied bridge client), read from its
 * data.
 */
function packetIdOfEvent(event) {
  if (event !== null && typeof event === 'object' && MMTP_PACKET_ID in event) {
    return event[MMTP_PACKET_ID];
  }
  return mmtpPacketIdOf(event?.data);
}

/**
 * Keep only the items a consumer's own filter admits, reading packet `i`'s ID
 * from `events[i]`. `items` is `events` itself or a parallel array derived
 * from it (the bytes layer's details). Returns `items` itself, allocating
 * nothing, when the filter admits every packet: the steady state of a
 * consumer the bridge already filters for.
 */
function packetsAdmittedBy(filter, items, events = items) {
  if (!filter) return items;
  let admitted = null;
  for (let i = 0; i < items.length; i++) {
    const packetId = packetIdOfEvent(events[i]);
    const admits = packetId !== undefined && filter.has(packetId);
    if (admitted) {
      if (admits) admitted.push(items[i]);
    } else if (!admits) {
      admitted = items.slice(0, i);
    }
  }
  return admitted ?? items;
}

/**
 * An ATSC 1.0 tuner subscription: it has no group/port/source address and its
 * payload is MPEG-TS. Reads the same three fields from a subscribe config or
 * from transport options.
 */
function isAddresslessAtsc1MpegTs(opts) {
  return opts?.origin === 'tuner' && opts?.standard === 'atsc1' && opts?.protocol === 'mpeg-ts';
}

/**
 * Whether packet-ID lists apply to a subscription. False only for an
 * addressless ATSC 1.0 tuner subscription, which carries MPEG-TS: an MMTP
 * packet-ID filter over it reads transport-stream bytes as MMTP headers and
 * drops essentially every packet.
 */
function carriesMmtpPacketIds(transportOpts) {
  return !isAddresslessAtsc1MpegTs(transportOpts);
}

function mpegTsPacketIdRefusal(label) {
  return makeMulticastError(
    'capability-unsupported',
    `${label} carries ATSC 1.0 MPEG-TS, not MMTP; it has no packet IDs to filter by`,
  );
}

/**
 * Coalescing key for a latest-wins telemetry control frame, or null for a
 * request that must be delivered in order. `media_progress` has its own
 * cumulative coalescing in `_sendControl`.
 */
function controlTelemetryKey(msg) {
  if (msg?.type === 'keepalive') return 'keepalive';
  if (msg?.type === 'subscription_diagnostics') {
    const ids = Array.isArray(msg.subscription_ids) ? msg.subscription_ids.join(',') : '';
    return `subscription_diagnostics:${ids}:${msg.fec_track?.packetId}`;
  }
  return null;
}
const KEEPALIVE_INTERVAL = 2000;
const WT_CONNECT_TIMEOUT = 5000; // WebTransport connect timeout — avoids Chrome's ~30s default QUIC timeout on failure
const WT_RECONNECT_BASE_DELAY_MS = 1500;
const WT_RECONNECT_MAX_DELAY_MS = 30000;
// A transport that survives this long is considered healthy.  A short-lived
// post-connect session keeps the discovery backoff it inherited, so a bridge
// that accepts a handshake and immediately dies cannot spin through QUIC
// handshakes.  A stable session gets the normal base delay on its next loss.
const BRIDGE_STABLE_CONNECTION_MS = 15000;
const WT_FAILED_CLOSE_GRACE_MS = 750;
const WT_SUBSCRIPTION_STALE_MS = 7000;
const WT_SUBSCRIPTION_WATCHDOG_MS = 1000;
const WT_CANDIDATE_CONNECT_ATTEMPTS = 3;
const WT_CANDIDATE_RETRY_DELAY_MS = 500;
const LOWERCASE_MARKER = '__blockcastBridgePolyfill';
const DISCOVERY_CACHE_KEY = 'multicast-bridge-discovery-cache-v1';
const DISCOVERY_LOCK_KEY = 'multicast-bridge-discovery-lock-v1';
const DEFAULT_DISCOVERY_SCOPE = 'default';
const DISCOVERY_CACHE_SUCCESS_TTL_MS = 15000;
const DISCOVERY_CACHE_MISS_TTL_MS = 3000;
const DISCOVERY_LOCK_TTL_MS = 7000;
const WT_CHUNK_MAGIC = 0x48434342; // "BCCH" little-endian
const WT_CHUNK_VERSION = 1;
const WT_CHUNK_HEADER_BYTES = 18;
const WT_CHUNK_TTL_MS = 10000;
const WT_CHUNK_MAX_MESSAGES = 64;
const WT_CHUNK_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const WT_DATAGRAM_DELIVERY_MAGIC = 0x47444342; // "BCDG" little-endian
const WT_DATAGRAM_DELIVERY_VERSION = 1;
const WT_DATAGRAM_DELIVERY_HEADER_BYTES = 12;
const WT_DATAGRAM_DELIVERY_MAX_SEQUENCE = 0xffffffff;
const WT_DATAGRAM_DELIVERY_MAX_EPOCH = 0xff;
const WT_DATAGRAM_DELIVERY_MAX_LOGICAL_SEQUENCE =
  WT_DATAGRAM_DELIVERY_MAX_SEQUENCE * (WT_DATAGRAM_DELIVERY_MAX_EPOCH + 1);
const WT_DATA_STREAM_MAGIC = new Uint8Array([0x42, 0x43, 0x44, 0x53]); // "BCDS"
const WT_DATA_STREAM_VERSION = 1;
const WT_DATA_STREAM_FLAGS = 0;
const WT_DATA_STREAM_HEADER_BYTES = 8;
const WT_DATA_STREAM_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const WT_DATA_STREAM_DISPATCH_BATCH_FRAMES = 64;
const WT_STREAM_METADATA_INDEX_FLAG = 0x8000;
const WT_STREAM_METADATA_INDEX_MASK = 0x7fff;
const WT_STREAM_METADATA_VERSION = 2;
const WT_STREAM_METADATA_FLAG_RECEIVE_TIME_ORIGIN = 1 << 0;
const WT_STREAM_METADATA_HEADER_BYTES = 13;
const WT_STREAM_METADATA_RECEIVE_TIME_ORIGIN_BYTES = 8;
// Match the IWA service worker's media send batch. The cumulative progress
// message is application credit: it is emitted only after Chrome has read and
// dispatched each BCDS frame, rather than when Quinn merely ACKs its bytes.
const WT_MEDIA_PROGRESS_BATCH_FRAMES = 8;
// Flush a short final batch without emitting one control frame per browser
// task. Continuous traffic still reports immediately at the batch boundary.
const WT_MEDIA_PROGRESS_MAX_WAIT_MS = 25;
// Datagram telemetry reports on a slow heartbeat only after the server has
// confirmed that datagram accounting is active by publishing an accepted-send
// watermark. Deliberately far slower than WT_MEDIA_PROGRESS_MAX_WAIT_MS: this
// is a liveness signal, not a per-frame credit.
const WT_DATAGRAM_PROGRESS_HEARTBEAT_MS = 1000;
// Re-announce datagram capability until the server activates accounting.
// _sendControl only enqueues, so the one-shot announcement can be lost between
// "returned true" and the wire; without a re-announcement, negotiation
// deadlocks — no announcement means no server watermark, and no watermark means
// the heartbeat that would re-announce never starts.
const WT_DATAGRAM_CAPABILITY_RETRY_MS = 500;
// Bounded, because the case it covers is a server that HEARD the announcement
// and stayed silent — datagram media disabled, too old to parse `dg.v`, or
// enabled but idle so it publishes no watermark — which is indistinguishable
// from one that has not acknowledged yet. Retrying forever would leave
// permanent control traffic on a path that is inert by design when the server
// has datagram media disabled.
//
// It does NOT cover a rejected control write. That is terminal rather than
// transient: the WritableStream latches errored and `_drainControlWrites` drops
// the writer, so subsequent attempts never reach the transport and only a
// reconnect recovers. See `_datagramCapabilityAnnouncementsWritten` for how the
// two are told apart after the fact.
const WT_DATAGRAM_CAPABILITY_MAX_RETRIES = 5;
// The accepted-send watermark arrives on the reliable bidi stream, which can
// overtake datagrams sent just before it. Hold each watermark before settling
// its receive cohort so ordinary reordering/scheduling delay is not counted as
// end-to-end loss. Continuous traffic settles in bounded snapshots rather than
// postponing one ever-growing watermark forever.
const WT_DATAGRAM_SETTLEMENT_GRACE_MS = 250;
// Late datagrams may correct an already-reported settled cohort, but retaining
// every historical gap makes sparse loss consume unbounded memory and turns
// each correction into a session-long scan. Keep only the newest settled
// sequence positions correctable; older gaps are folded into finalized loss.
const WT_DATAGRAM_LATE_CORRECTION_HORIZON = 4096;
// Sequences received ABOVE the settled watermark wait here until an
// authoritative watermark adjudicates them. If that watermark stalls — the
// reliable control stream is flow-control blocked, or its writes keep being
// rejected — datagrams keep arriving with nothing to settle them and this set
// would grow for the lifetime of the connection. The late-correction horizon
// above does not bound it: that governs ranges which have ALREADY settled.
// Sized well clear of any normal settlement burst, since tripping it costs
// measurement rather than correctness.
const WT_DATAGRAM_MAX_PENDING_SEQUENCES = WT_DATAGRAM_LATE_CORRECTION_HORIZON * 2;
// Durable bridge enrollment (BLO-34022). The bridge signs the binding between
// its long-lived identity key and this lifecycle's certificate, so a scheduled
// rotation of the certificate no longer looks like a different bridge.
const BRIDGE_ENROLLMENT_SCHEMA = 1;
const BRIDGE_ENROLLMENT_MESSAGE_PREFIX = 'bcds-enrollment-v1';
// Uncompressed P-256 point: 0x04 || X || Y.
const BRIDGE_ENROLLMENT_PUBLIC_KEY_BYTES = 65;
const ATSC_LLS_MULTICAST_GROUP = '224.0.23.60';
const ATSC_LLS_MULTICAST_PORT = 4937;

// Automatic discovery is a capability negotiation, not a generic port scan.
// Only an IWA endpoint that explicitly serves the BCDS bridge contract may be
// promoted into window.multicast.  In particular, a MoQ-only relay can expose
// a fingerprint or a WebTransport port without carrying the BCDS packet
// stream that this client consumes.
export const BCDS_BRIDGE_PROTOCOL = 'bcds-v1';

export function isBcdsBridgeCapability(value) {
  return value &&
    typeof value === 'object' &&
    value.bridgeProtocol === BCDS_BRIDGE_PROTOCOL &&
    value.webTransportBridge === true;
}

function isValidPort(value) {
  // Endpoint ports are decimal URL-authority values.  Number() would accept
  // booleans and non-decimal strings such as `0x82a2`, which are not valid
  // bridge metadata and can make a caller dial a different endpoint than it
  // requested.
  const port = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function parsePort(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * Host values cross several boundaries in the bridge protocol: native code
 * reports an unbracketed IPv6 literal, URL.hostname reports a bracketed one,
 * and handoff/query parameters can contain either form. Keep one canonical
 * representation internally (no brackets) and add brackets only while
 * constructing a URL. Scoped IPv6 literals are intentionally rejected here:
 * browsers do not accept zone identifiers in WebTransport/HTTP URLs, so
 * silently dropping the scope would be capable of dialing the wrong LAN.
 */
function isValidIpv4Literal(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) =>
    /^\d{1,3}$/.test(part) &&
    (part.length === 1 || part[0] !== '0') &&
    Number(part) <= 255
  );
}

function parseIpv6Hextets(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text.includes('%') || (text.match(/::/g) || []).length > 1) return null;

  const hasCompression = text.includes('::');
  const [left, right = ''] = hasCompression ? text.split('::') : [text, ''];
  const parsePart = (part) => {
    if (!part) return [];
    const fields = part.split(':');
    const result = [];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      if (field.includes('.')) {
        if (index !== fields.length - 1 || !isValidIpv4Literal(field)) return null;
        const octets = field.split('.').map(Number);
        result.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(field)) {
        result.push(parseInt(field, 16));
      } else {
        return null;
      }
    }
    return result;
  };

  const leftHextets = parsePart(left);
  const rightHextets = parsePart(right);
  if (!leftHextets || !rightHextets) return null;
  const count = leftHextets.length + rightHextets.length;
  if (hasCompression) {
    if (count >= 8) return null;
    return leftHextets.concat(new Array(8 - count).fill(0), rightHextets);
  }
  return count === 8 ? leftHextets : null;
}

function isValidIpv6Literal(value) {
  return parseIpv6Hextets(value) !== null;
}

function canonicalizeIpv6(value) {
  const hextets = parseIpv6Hextets(value);
  if (!hextets) return null;
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < hextets.length;) {
    if (hextets[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < hextets.length && hextets[end] === 0) end += 1;
    if (end - start >= 2 && end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  if (bestStart < 0) return hextets.map((part) => part.toString(16)).join(':');
  const left = hextets.slice(0, bestStart).map((part) => part.toString(16)).join(':');
  const right = hextets.slice(bestStart + bestLength).map((part) => part.toString(16)).join(':');
  return `${left}::${right}`;
}

function unbracketHost(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.startsWith('[') || text.endsWith(']')) {
    if (!text.startsWith('[') || !text.endsWith(']')) return null;
    return text.slice(1, -1).trim() || null;
  }
  return text;
}

/** Return a canonical host (IPv6 without brackets), or null if malformed. */
export function normalizeBridgeHost(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const bracketed = text.startsWith('[') || text.endsWith(']');
  const host = unbracketHost(text);
  if (!host || /[\s/?#@]/.test(host)) return null;
  // Brackets are URL-authority syntax for IPv6 literals, never for DNS or
  // IPv4. Reject malformed bracketed values instead of normalizing them into
  // a different bridge endpoint.
  if (bracketed && !isValidIpv6Literal(host)) return null;
  if (isValidIpv6Literal(host)) return canonicalizeIpv6(host);
  if (isValidIpv4Literal(host)) return host;
  if (host.includes(':')) return null;
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/.test(host) ? host : null;
}

/** Format a host for an authority component (`[fd00::1]` when needed). */
export function formatBridgeHost(value) {
  const host = normalizeBridgeHost(value);
  if (!host) return null;
  return isValidIpv6Literal(host) ? `[${host}]` : host;
}

/**
 * Parse the host portion accepted by `mc_bridge` direct-discovery inputs. A port is
 * unambiguous only after a bracketed IPv6 literal; an unbracketed value with
 * multiple colons is therefore treated as the IPv6 host with no port.
 */
export function parseBridgeHostPort(value, { defaultPort = null } = {}) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  let hostText = text;
  let portText = null;
  const bracketed = text.startsWith('[');
  if (bracketed) {
    const close = text.indexOf(']');
    if (close < 0) return null;
    hostText = text.slice(1, close);
    const suffix = text.slice(close + 1);
    if (suffix) {
      if (!suffix.startsWith(':')) return null;
      portText = suffix.slice(1);
    }
  } else {
    const colonCount = (text.match(/:/g) || []).length;
    if (colonCount === 1) {
      const separator = text.lastIndexOf(':');
      hostText = text.slice(0, separator);
      portText = text.slice(separator + 1);
    }
  }

  // `hostText` has had URL-authority brackets removed above.  Preserve the
  // syntactic rule here instead of letting `[example.test]` normalize into a
  // distinct unbracketed DNS endpoint.
  if (bracketed && !isValidIpv6Literal(hostText)) return null;
  const host = normalizeBridgeHost(hostText);
  if (!host || portText === '') return null;
  let port = defaultPort;
  if (portText != null) {
    if (!/^\d+$/.test(portText)) return null;
    port = Number(portText);
    if (!isValidPort(port)) return null;
  }
  if (port != null && !isValidPort(port)) return null;
  return { host, port };
}

function hostUrl(protocol, host, port) {
  const formatted = formatBridgeHost(host);
  if (!formatted || !isValidPort(port)) return null;
  return `${protocol}://${formatted}:${port}`;
}

function hasOwn(value, key) {
  return value != null && Object.prototype.hasOwnProperty.call(value, key);
}

function healthPort(health, key, fallback) {
  const value = hasOwn(health, key) ? health[key] : fallback;
  return parsePort(value) ?? Number.NaN;
}

function normalizeFingerprint(value) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/:/g, '').trim();
  return /^[0-9a-f]{64}$/i.test(clean) ? clean.toLowerCase() : null;
}

function parseExplicitPort(value, name) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  const port = Number(text);
  if (!isValidPort(port)) throw new Error(`Invalid ${name}: ${value}`);
  return port;
}

// Stream metadata source labels are plain UTF-8; one decoder serves every
// stream (TextDecoder.decode without {stream: true} keeps no state).
const STREAM_METADATA_SOURCE_DECODER = new TextDecoder();

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function yieldDataStreamDispatch() {
  if (typeof globalThis.scheduler?.yield === 'function') {
    await globalThis.scheduler.yield();
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// BLO-8405: reliable BCDS packet-stream reassembly. Incoming chunks are kept in
// a list with a head-consume offset so every received byte is copied at most
// once — into the frame it belongs to (subarray when a frame lies inside one
// chunk, one coalescing copy only when it straddles). The previous code
// reallocated and copied the whole pending buffer on every chunk (O(n^2) when a
// frame arrives across many chunks); an E3 byte-sink experiment attributed
// ~49.5% of lost sender goodput to that consumer-side consumption cost.
//
// The accumulator's `byteLength` field is the count of buffered-but-not-yet-
// parsed bytes, identical in meaning to the old Uint8Array.byteLength, so the
// stats surface (dataStreamBufferBytes = Σ buffer.byteLength) is unchanged.
function createDataStreamAccumulator() {
  return { chunks: [], head: 0, byteLength: 0, dispatchFrames: 0 };
}

/**
 * Normalize one Web Streams chunk without allowing coercive typed-array
 * construction. WebTransport exposes Uint8Array chunks, but test doubles and
 * alternate browser implementations may surface an ArrayBuffer or a view;
 * arbitrary values are a protocol error, not an empty packet.
 */
function normalizeDataStreamChunk(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/**
 * Peel a BCDG delivery envelope off a datagram, or pass the payload through.
 *
 * `sequencingPossible` gates the whole check. The envelope is a magic prefix on
 * an OPAQUE payload space, so it is not self-delimiting: a legacy media
 * datagram whose first bytes happen to be `BCDG` would otherwise be read as an
 * envelope even on a connection where sequencing was never negotiated. The
 * service worker only sequences a connection whose `sequenceCapable` it set
 * from our `dg.v` announcement, so an announcement confirmed on the wire is a
 * NECESSARY precondition for any envelope to exist — and it always precedes the
 * first sequenced batch, so gating on it cannot mis-handle one.
 *
 * This narrows the collision window; it does not close it. Once we have
 * announced, a server that is NOT sequencing (datagram media disabled, the
 * production default) still shares the payload space with the envelope. Closing
 * it properly needs framing that cannot collide, which is a wire change for
 * both ends.
 *
 * A prefix match that then fails validation is passed through as legacy rather
 * than dropped. Dropping is the one outcome with no recovery and no signal: a
 * corrupted frame is at least visible downstream, whereas a silently discarded
 * one looks exactly like network loss.
 */
function unwrapDatagramDeliveryFrame(bytes, sequencingPossible) {
  if (!sequencingPossible ||
      bytes.byteLength < WT_DATAGRAM_DELIVERY_HEADER_BYTES ||
      bytes[0] !== 0x42 || bytes[1] !== 0x43 ||
      bytes[2] !== 0x44 || bytes[3] !== 0x47) {
    return { payload: bytes, sequence: null };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== WT_DATAGRAM_DELIVERY_MAGIC ||
      bytes[4] !== WT_DATAGRAM_DELIVERY_VERSION) {
    return { payload: bytes, sequence: null, envelopeMismatch: true };
  }
  const sequence = view.getUint32(8, true);
  if (sequence === 0) {
    return { payload: bytes, sequence: null, envelopeMismatch: true };
  }
  const epoch = bytes[5];
  return {
    payload: bytes.subarray(WT_DATAGRAM_DELIVERY_HEADER_BYTES),
    // Sequence zero is reserved, so each epoch contributes 0xffffffff valid
    // values rather than 2^32. The result remains exactly the sender's
    // cumulative accepted-frame ordinal across rollover.
    sequence: epoch * WT_DATAGRAM_DELIVERY_MAX_SEQUENCE + sequence,
    epoch,
  };
}

// Read the u32LE frame-length prefix at the current head, peeking across a chunk
// boundary if the 4-byte prefix straddles two chunks. Caller guarantees
// acc.byteLength >= 4.
function readDataStreamFrameLen(acc) {
  const first = acc.chunks[0];
  const head = acc.head;
  if (first.byteLength - head >= 4) {
    return (
      first[head] |
      (first[head + 1] << 8) |
      (first[head + 2] << 16) |
      (first[head + 3] << 24)
    ) >>> 0;
  }
  const lp = coalesceDataStreamSpan(acc, 0, 4);
  return (lp[0] | (lp[1] << 8) | (lp[2] << 16) | (lp[3] << 24)) >>> 0;
}

// Copy `len` bytes starting at logical offset `logicalStart` (relative to head)
// into a fresh Uint8Array. Used only when a frame (or its length prefix)
// straddles chunk boundaries; the bytes are guaranteed buffered by the caller.
function coalesceDataStreamSpan(acc, logicalStart, len) {
  const out = new Uint8Array(len);
  const chunks = acc.chunks;
  let pos = acc.head + logicalStart;
  let i = 0;
  while (i < chunks.length && pos >= chunks[i].byteLength) {
    pos -= chunks[i].byteLength;
    i++;
  }
  let written = 0;
  while (written < len) {
    const c = chunks[i];
    const take = Math.min(len - written, c.byteLength - pos);
    out.set(c.subarray(pos, pos + take), written);
    written += take;
    pos = 0;
    i++;
  }
  return out;
}

// Advance the head by `n` consumed bytes: drop fully-consumed leading chunks and
// partial-consume the new leading chunk via the head offset. Caller guarantees
// n <= acc.byteLength.
function advanceDataStreamHead(acc, n) {
  acc.byteLength -= n;
  const chunks = acc.chunks;
  let remaining = n;
  while (remaining > 0) {
    const avail = chunks[0].byteLength - acc.head;
    if (remaining < avail) {
      acc.head += remaining;
      remaining = 0;
    } else {
      remaining -= avail;
      chunks.shift();
      acc.head = 0;
    }
  }
}
// BLO-9413/BLO-9769: single source of truth for local-bridge discovery order,
// LOOPBACK FIRST. A loopback connect to a missing bridge refuses instantly,
// while `multicast-bridge.local` mDNS resolution can hang up to the full
// connect timeout (observed: 5s stall on the first WT attempt before a
// working retry). Local-bridge users (the common case) connect on the first
// candidate; remote-bridge users pay only two instant loopback refusals
// before the mDNS candidate. Keep the list defined once; iwa-install.js in
// moq-server carries the same list for the install banner.
//
// No IPv6 loopback literal. Browsers resolve `localhost` to both 127.0.0.1
// and ::1 (RFC 6761), so a bridge bound to ::1 is still reached through the
// `localhost` candidate. A `http://[::1]:<port>` probe, on the other hand,
// can never be allow-listed by a page's Content-Security-Policy, because the
// CSP `host-source` grammar has no production for a bracketed IPv6 literal
// (Chromium and Firefox both drop such an entry at parse time), so on every
// CSP-bearing page it only logged a connect-src violation per load.
export const BRIDGE_HOST_CANDIDATES = Object.freeze(['localhost', '127.0.0.1', 'multicast-bridge.local']);
const ATSC_LLS_ENDPOINT = Object.freeze({
  group: ATSC_LLS_MULTICAST_GROUP,
  port: ATSC_LLS_MULTICAST_PORT,
  consume: 'bytes',
});
// ATSC 1.0 TS has no IP/UDP destination. This logical selector deliberately
// stays addressless; 224.0.23.60:4937 belongs exclusively to ATSC 3.0 LLS.
const ATSC_TUNER_ENDPOINT = Object.freeze({
  origin: 'tuner',
  standard: 'atsc1',
  protocol: 'mpeg-ts',
  consume: 'bytes',
});

/**
 * Check if a host is a DNS hostname (not IP, not localhost, not .local).
 * DNS hostnames with CA-signed certs don't need fingerprint-based discovery.
 */
function isDnsHostname(host) {
  const normalized = normalizeBridgeHost(host);
  if (!normalized || normalized === 'localhost') return false;
  host = normalized;
  if (host.endsWith('.local')) return false;
  // IPv4
  if (isValidIpv4Literal(host)) return false;
  // IPv6 (contains colons)
  if (host.startsWith('[') || /^[0-9a-f:]+$/i.test(host)) return false;
  // Has at least one dot → likely a DNS hostname
  return host.includes('.');
}

function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

async function writeControlFrameWithDeadline(writer, frame) {
  let timeoutId;
  let write;
  try {
    write = Promise.resolve(writer.write(frame));
  } catch (error) {
    write = Promise.reject(error);
  }
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error('Bridge control write timeout');
      error.code = 'control-write-timeout';
      reject(error);
    }, WT_CONTROL_WRITE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([write, deadline]);
  } finally {
    clearTimeout(timeoutId);
    // Never abort the writer on timeout. With the write still pending in Chrome's sink,
    // abort() runs the sink abort twice: once now, and again when the pending write rejects,
    // after the caller's disconnect has already called wt.close() and reset the transport's
    // Mojo remote. That second AbortStream crashes the renderer (Chrome 125 and 138 on
    // Android 9, 5/5 runs, BLO-45882). wt.close() alone rejects the pending write without
    // a sink abort. Do not abort a WebTransport writer and close its transport in the same
    // turn, in either order; if an abort is ever needed, await it before closing.
  }
}

function summarizeTunerStatusForLog(response) {
  if (!response || typeof response !== 'object') return null;
  const status = response.status || {};
  const signal = response.signal || {};
  const counters = response.counters || {};
  const extractor = counters.udpExtractor || {};
  return {
    success: response.success,
    state: status.state,
    locked: status.locked,
    frequencyKHz: status.frequencyKHz,
    plpId: status.plpId,
    signalLocked: signal.locked,
    snrDb: signal.snrDb,
    packetsRead: counters.packetsRead,
    bytesRead: counters.bytesRead,
    tsTransfersInFlight: counters.tsTransfersInFlight,
    transportEpochAgeMs: counters.transportEpochAgeMs,
    lastTsReadAgeMs: counters.lastTsReadAgeMs,
    lastUdpDispatchAgeMs: counters.lastUdpDispatchAgeMs,
    tsWatchdogRecoveries: counters.tsWatchdogRecoveries,
    extractorChunks: extractor.chunks,
    extractorBytes: extractor.bytes,
    extractorTsPackets: extractor.tsPackets,
    extractorAlpPackets: extractor.alpPackets,
    extractorIpv4Packets: extractor.ipv4Packets,
    extractorCompressedPackets: extractor.compressedPackets,
    extractorEmittedDatagrams: extractor.emittedDatagrams,
    extractorFramingMode: extractor.framingMode,
  };
}

/** Convert hex fingerprint string to a BufferSource for serverCertificateHashes. */
function hexToBytes(hex) {
  hex = hex.replace(/:/g, '');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Exact-width lowercase hex, or null. Length is part of the type here. */
function enrollmentHex(value, byteLength) {
  if (typeof value !== 'string') return null;
  const clean = value.trim().toLowerCase();
  return clean.length === byteLength * 2 && /^[0-9a-f]+$/.test(clean) ? clean : null;
}

/**
 * Verify a `GET /enrollment` attestation (BLO-34022) and return the durable
 * bridge identity it proves, or null.
 *
 * The page verifies rather than trusts: an attestation that does not check out
 * is no enrollment at all. Three things are checked beyond the signature —
 * `bridge_id` really is the SHA-256 of `public_key` (it is self-certifying, so
 * taking the published id on faith would leave an id-substitution path open),
 * `now` is inside the signed `not_before`/`not_after` window, and — when the
 * caller already pinned a key — that the published key is that key.
 *
 * `pinnedPublicKey` is what makes a certificate rotation safe to accept: the
 * signature is then checked against the key the page enrolled, not against
 * whichever key the response happened to carry.
 *
 * Enrollment is device identity only. It is not an origin grant, does not
 * bypass the exact-`Origin` admission gate or Local Network permission, and is
 * never a capability to install `window.multicast`.
 */
export async function verifyBridgeEnrollment(attestation, options = {}) {
  const {
    now = Date.now(),
    pinnedPublicKey = null,
    subtle = globalThis.crypto?.subtle,
  } = options;
  if (!subtle || !attestation || typeof attestation !== 'object') return null;
  if (attestation.schema !== BRIDGE_ENROLLMENT_SCHEMA) return null;

  const bridgeId = enrollmentHex(attestation.bridge_id, 32);
  const publicKey = enrollmentHex(attestation.public_key, BRIDGE_ENROLLMENT_PUBLIC_KEY_BYTES);
  const signature = enrollmentHex(attestation.signature, 64);
  const fingerprint = normalizeFingerprint(attestation.fingerprint);
  if (!bridgeId || !publicKey || !signature || !fingerprint) return null;
  // Uncompressed P-256 point; importKey('raw') rejects anything else anyway,
  // but a wrong-shaped key should not reach WebCrypto as a thrown DOMException.
  if (!publicKey.startsWith('04')) return null;
  const { not_before: notBefore, not_after: notAfter } = attestation;
  if (!Number.isSafeInteger(notBefore) || !Number.isSafeInteger(notAfter)) return null;
  // Wire timestamps are seconds since the epoch; `now` is milliseconds. The
  // window is signed, so enforce both ends: a lower bound that is checked on
  // one side and not the other is not a validity window.
  const nowSeconds = Math.floor(now / 1000);
  if (nowSeconds < notBefore || nowSeconds >= notAfter) return null;

  if (pinnedPublicKey !== null &&
      enrollmentHex(pinnedPublicKey, BRIDGE_ENROLLMENT_PUBLIC_KEY_BYTES) !== publicKey) {
    return null;
  }

  const digest = await subtle.digest('SHA-256', hexToBytes(publicKey));
  if (bytesToHex(new Uint8Array(digest)) !== bridgeId) return null;

  // Signed over the fields exactly as published. Re-serializing from the
  // normalized copies would verify a message the bridge never signed.
  const message = [
    BRIDGE_ENROLLMENT_MESSAGE_PREFIX,
    attestation.bridge_id,
    attestation.fingerprint,
    notBefore,
    notAfter,
  ].join('\n');

  try {
    const key = await subtle.importKey(
      'raw',
      hexToBytes(publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    // Fixed-width r||s, not ASN.1 DER: `crypto.subtle.verify` rejects DER.
    const ok = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      hexToBytes(signature),
      new TextEncoder().encode(message),
    );
    if (!ok) return null;
  } catch {
    return null;
  }

  return { bridgeId, publicKey, fingerprint, notBefore, notAfter };
}

/**
 * Re-pin a cached bridge onto the certificate it is offering right now.
 *
 * Returns the cached bridge carrying the rotated fingerprint when
 * `attestation` verifies against the PINNED public key and names the pinned
 * bridge id. Returns null otherwise — a different bridge id (including the
 * fresh one `bcds_revoke_enrollment` mints), an unverifiable attestation, an
 * expired one, or no pin at all. Null means "not the bridge you enrolled", so
 * the caller must drop the entry rather than keep dialling a dead pin.
 */
export async function rotateCachedBridgeFingerprint(cachedBridge, attestation, options = {}) {
  const pinned = normalizeCachedEnrollment(cachedBridge?.enrollment);
  if (!pinned) return null;
  const verified = await verifyBridgeEnrollment(attestation, {
    ...options,
    pinnedPublicKey: pinned.publicKey,
  });
  if (!verified) return null;
  // A pinned key that verified implies the pinned id, unless localStorage was
  // edited so the two disagree. Fail that closed rather than adopting either.
  if (verified.bridgeId !== pinned.bridgeId) return null;
  return normalizeCachedBridge({ ...cachedBridge, fingerprint: verified.fingerprint });
}

/**
 * Check if a host is loopback (exempt from mixed content on HTTPS pages).
 * Chrome treats localhost and 127.0.0.1 as "potentially trustworthy" origins.
 */
function isLoopback(host) {
  const normalized = normalizeBridgeHost(host);
  if (normalized === 'localhost' || normalized === '127.0.0.1') return true;
  const hextets = normalized && parseIpv6Hextets(normalized);
  return hextets?.every((part, index) => part === 0 || index === 7 && part === 1) === true;
}

function isSecurePage(pageProtocol = globalThis.location?.protocol) {
  return pageProtocol === 'https:';
}

export function shouldProbeHttpBridgeHost(host, pageProtocol = globalThis.location?.protocol) {
  if (!isSecurePage(pageProtocol)) return true;
  return isLoopback(host);
}

/** Check if a host is a private/LAN IP (RFC 1918, CGNAT, link-local) */
export function isPrivateIp(host) {
  const normalized = normalizeBridgeHost(host);
  if (!normalized) return false;
  if (isValidIpv4Literal(normalized)) {
    const octets = normalized.split('.').map(Number);
    if ((octets[0] === 192 && octets[1] === 168) || octets[0] === 10) return true;
    if (octets[0] === 100) {
      const second = octets[1];
      return second >= 64 && second <= 127;
    }
    if (octets[0] === 172) {
      const second = octets[1];
      return second >= 16 && second <= 31;
    }
    return octets[0] === 169 && octets[1] === 254;
  }

  const hextets = parseIpv6Hextets(normalized);
  if (!hextets) return false;
  // RFC 4193 ULA and RFC 4291 link-local addresses are local network
  // destinations. IPv4-mapped literals inherit the mapped IPv4 scope.
  if ((hextets[0] & 0xfe00) === 0xfc00 || (hextets[0] & 0xffc0) === 0xfe80) return true;
  if (hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff) {
    const mapped = `${hextets[6] >> 8}.${hextets[6] & 0xff}.${hextets[7] >> 8}.${hextets[7] & 0xff}`;
    return isPrivateIp(mapped);
  }
  return false;
}

// `RequestInit.targetAddressSpace` is a WebIDL enum whose members depend on the
// Chromium release (BLO-35664), so a spelling is safe to send only where the
// running browser defines it:
//
//   through M138 (Private Network Access):  "local" | "private" | "public" | "unknown"
//             "local" means loopback, and there is no "loopback" at all.
//   M139+        (Local Network Access):    "loopback" | "local" | "private" | "public" | "unknown"
//             "local" means the LAN, and "private" is normalized to "local".
//
// WebIDL rejects a value outside the enum, so `fetch()` rejects with a
// TypeError before any byte is sent. A hard-coded "loopback" therefore failed
// every unpinned loopback /health probe on the older enum (measured in Chrome
// 125, the release on the Android phone where unpinned discovery never found a
// running Beacon bridge), silently, while the pinned rung, which sends no HTTP
// at all, still connected. "local" cannot stand in for it either: it names the
// LAN from M139 on, and declaring a space the host does not resolve to is a
// network error on both enums.
//
// "private" names the LAN in both measured enums, so it is the LAN spelling.
// LNA keeps it only as a deprecated alias of "local", though, so it is
// feature-detected exactly like "loopback": each spelling is sent only where
// the running enum defines it, and otherwise the hint is omitted. A release
// that drops the alias then probes the LAN unhinted instead of throwing.
// Omitting a hint is safe: the browser classifies the address it actually
// resolves on its own, a loopback URL is potentially trustworthy (so never
// mixed content), and an enum without "private" can only be an LNA one, where
// the AutoTLS probe is HTTPS and private IP literals are exempt from
// mixed-content blocking.
const LAN_TARGET_ADDRESS_SPACE = 'private';
const LOOPBACK_TARGET_ADDRESS_SPACE = 'loopback';

// Request constructor -> Map(spelling -> accepted). The enum cannot change
// within a page, so each spelling is probed once; keying on the constructor
// (not a single module-level answer) lets a test that swaps globalThis.Request
// for another release's enum get that release's answer.
const targetAddressSpaceSupport = new WeakMap();

/**
 * Whether this browser's `RequestInit` accepts `targetAddressSpace: value`.
 * Constructing a `Request` runs the same init conversion `fetch()` does,
 * synchronously and without sending anything. A browser without the member
 * ignores it, which is also a yes: the hint can never throw there.
 */
function browserAcceptsTargetAddressSpace(value) {
  const RequestConstructor = globalThis.Request;
  if (typeof RequestConstructor !== 'function') return false;
  let accepted = targetAddressSpaceSupport.get(RequestConstructor);
  if (!accepted) {
    accepted = new Map();
    targetAddressSpaceSupport.set(RequestConstructor, accepted);
  }
  if (!accepted.has(value)) {
    try {
      new RequestConstructor('about:blank', { targetAddressSpace: value });
      accepted.set(value, true);
    } catch {
      accepted.set(value, false);
    }
  }
  return accepted.get(value);
}

/** `space` where this browser's `targetAddressSpace` enum defines it, else null. */
function definedTargetAddressSpace(space) {
  return browserAcceptsTargetAddressSpace(space) ? space : null;
}

/** Get the Chrome PNA/LNA `targetAddressSpace` hint for a host, if any. */
function pnaTarget(host) {
  if (isLoopback(host)) return definedTargetAddressSpace(LOOPBACK_TARGET_ADDRESS_SPACE);
  if (isPrivateIp(host)) return definedTargetAddressSpace(LAN_TARGET_ADDRESS_SPACE);
  return null;
}

/**
 * Pick protocol for a bridge host.
 * - .local, loopback, and private IPs: always http for bootstrap (/health)
 * - Public DNS/IP on HTTPS page: https (AutoTLS or explicit TLS bridge)
 * - Non-loopback on HTTP page: http
 */
export function bridgeProto(host) {
  const normalized = normalizeBridgeHost(host) || host;
  if (normalized?.endsWith('.local')) return 'http';
  if (isLoopback(host)) return 'http';
  if (isPrivateIp(host)) return 'http';
  return isSecurePage() ? 'https' : 'http';
}

export function canProbeBridgeHost(host, { explicitBridge = false } = {}) {
  return bridgeProto(host) !== 'http' ||
    shouldProbeHttpBridgeHost(host) ||
    (explicitBridge && isPrivateIp(host));
}

function ipv4LanPrefix(host) {
  if (!isValidIpv4Literal(host)) return null;
  if (!isPrivateIp(host)) return null;
  return host.split('.').slice(0, 3).join('.');
}

function normalizeLanScanPrefix(value) {
  const prefix = String(value || '').trim();
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(prefix)) return prefix;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(prefix)) return prefix.split('.').slice(0, 3).join('.');
  return null;
}

function splitScanPrefixes(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map(normalizeLanScanPrefix)
    .filter(Boolean);
}

function isDisabledParam(value) {
  return ['false', '0', 'off', 'no'].includes(String(value || '').toLowerCase());
}

function isEnabledParam(value) {
  return ['true', '1', 'on', 'yes'].includes(String(value || '').toLowerCase());
}

export function desktopLanScanPrefixesFromInputs({
  search = globalThis.location?.search || '',
  hostname = globalThis.location?.hostname || '',
} = {}) {
  const params = new URLSearchParams(search);
  const scanParam = params.get('mc_scan') || params.get('mc_lan_scan') || '';
  if (isDisabledParam(scanParam)) return [];

  const prefixes = [];
  const addPrefix = (prefix) => {
    const normalized = normalizeLanScanPrefix(prefix);
    if (normalized && !prefixes.includes(normalized)) prefixes.push(normalized);
  };

  for (const key of ['mc_scan_prefix', 'mc_network', 'networkPrefix']) {
    for (const prefix of splitScanPrefixes(params.get(key))) addPrefix(prefix);
  }

  if (scanParam && !isEnabledParam(scanParam)) {
    for (const prefix of splitScanPrefixes(scanParam)) addPrefix(prefix);
  }

  addPrefix(ipv4LanPrefix(hostname));

  if (prefixes.length === 0 || isEnabledParam(scanParam)) {
    for (const prefix of DESKTOP_LAN_SCAN_DEFAULT_PREFIXES) addPrefix(prefix);
  }

  return prefixes;
}

function canUseDesktopLanScan(options = {}) {
  if (options.force) return true;
  if (typeof fetch !== 'function') return false;
  // Public HTTPS pages cannot bootstrap directly from http://192.168.x.y
  // without mixed-content failures. Those pages need AutoTLS or an
  // allowlisted bridge origin.
  return !isSecurePage();
}

// ── Pinned bridge parameters (query + fragment) ──
// The handoff carries the certificate fingerprint. In the query it reaches the
// server in the request line and lands in access logs, referrers, and anything
// that samples location.search; in the fragment it never leaves the browser.
// Accept both, prefer the fragment, and strip the fragment once it is read so a
// copied/shared link does not carry the pin either.
const PINNED_PARAM_KEYS = Object.freeze([
  'mc_bridge', 'fingerprint', 'fp', 'wt_port', 'wtPort', 'gw',
]);

/** Per-window so a page harvests once; tests get isolation from fresh scopes. */
const consumedFragmentPins = new WeakMap();

/**
 * A fragment segment's key under `URLSearchParams` semantics, so the strip
 * matches the same segments `harvested` parsed. Falls back to the raw key on a
 * malformed escape (`#%zz&mc_bridge=…`) — `decodeURIComponent` throws there,
 * and losing the strip over a segment we were going to keep anyway would leave
 * the pin in the URL.
 */
function fragmentKey(segment) {
  const rawKey = segment.split('=')[0].replace(/\+/g, ' ');
  try {
    return decodeURIComponent(rawKey);
  } catch {
    return rawKey;
  }
}

function consumeFragmentPin(windowScope) {
  if (!windowScope || typeof windowScope !== 'object') return null;
  if (consumedFragmentPins.has(windowScope)) return consumedFragmentPins.get(windowScope);

  let harvested = null;
  try {
    // Interior `#` joins as `&`. `to=` is handed to the app `%23`-encoded
    // inside a query param, so an app that appends rather than parse-and-merges
    // returns `/live#watch#mc_bridge=…&fp=…`. Parsed as-is, `watch#mc_bridge`
    // is one key and `mc_bridge` is never seen; what follows depends on whether
    // a pinned sibling survived the append. With `&fp=…` the branch still runs
    // on `fp`, so the pin is consumed without its host and `mc_bridge=` is left
    // in the URL that then gets shared — worse than a miss. Without one
    // (`#watch#mc_bridge=…` alone) every `has()` is false and the handoff
    // silently does nothing — no error, no fallback. RFC 3986 bars a bare `#`
    // inside a fragment (a literal is `%23`), but the WHATWG parser appends one
    // anyway, so `location.hash` really can carry it. The rewrite is therefore
    // lossless for the segment keys read here, and lossy only in the write-back
    // below: an interior `#` that survives the strip is rebuilt as `&`.
    const hash = String(windowScope.location?.hash || '')
      .replace(/^#/, '')
      .replace(/#/g, '&');
    const fragment = hash ? new URLSearchParams(hash) : null;
    if (fragment && PINNED_PARAM_KEYS.some((key) => fragment.has(key))) {
      harvested = fragment;
      // Rebuild the remainder from the raw string. Re-serialising a
      // URLSearchParams normalises every surviving segment: a hash route
      // (`#/player/42`) percent-encodes its slashes, a bare anchor (`#watch`)
      // gains a trailing `=`, and reserved characters inside an unrelated
      // value get rewritten. Only the write-back has to be lossless —
      // `harvested` stays the parsed view.
      const rest = hash
        .split('&')
        .filter((segment) => !PINNED_PARAM_KEYS.includes(fragmentKey(segment)))
        .join('&');
      const { pathname = '', search = '' } = windowScope.location || {};
      windowScope.history?.replaceState?.(
        windowScope.history.state ?? null,
        '',
        `${pathname}${search}${rest ? `#${rest}` : ''}`,
      );
    }
  } catch (err) {
    console.warn(`${TAG} Could not read pinned fragment:`, err.message);
  }
  // Only a hit is memoized. The read is destructive, but a miss destroys
  // nothing — `replaceState` runs solely inside the branch below — so caching
  // a miss would buy nothing and permanently blind this window to a pin that
  // arrives later (SPA soft navigation, or a same-document `#mc_bridge=` link).
  if (harvested) consumedFragmentPins.set(windowScope, harvested);
  return harvested;
}

/**
 * Query params overlaid with the (one-time) fragment pin. Every discovery rung
 * reads bridge parameters through this so the fragment survives the strip.
 */
export function bridgeUrlParams(windowScope = globalThis.window) {
  const params = new URLSearchParams(windowScope?.location?.search || '');
  const fragment = consumeFragmentPin(windowScope);
  if (fragment) for (const [key, value] of fragment) params.set(key, value);
  return params;
}

// ── Gateway domain persistence (localStorage) ──
// Saves gateway domain + LAN IP so HTTPS pages can bootstrap AutoTLS
// without ?gw= param on subsequent visits.
const GW_STORAGE_KEY = 'multicast-bridge-gw';

/**
 * A usable AutoTLS gateway domain needs a gateway label under the AutoTLS
 * apex (gw-xxx.bcast.id, relay.gw-xxx.tenant.bcast.id): the wildcard DNS +
 * LE cert live at *.gw-xxx[...]. A bare registrable domain (bcast.id) has
 * neither — the authoritatives answer NODATA for dashed-IP children — so a
 * saved entry like {bcast.id, 100.76.6.82} would retry ERR_NAME_NOT_RESOLVED
 * on every discovery poll, forever. `.local` names are mDNS/HTTP-only and
 * never valid AutoTLS hosts.
 */
export function isAutoTlsGatewayDomain(domain) {
  if (typeof domain !== 'string') return false;
  if (domain.endsWith('.local')) return false;
  return domain.split('.').filter(Boolean).length >= 3;
}

/**
 * Validate and canonicalize a gateway DNS name before it is persisted or
 * interpolated into an AutoTLS URL. Keep this separate from
 * isAutoTlsGatewayDomain(): the latter is intentionally byte-copied into the
 * player-side discovery module and its body is a compatibility contract for
 * that bundle. This stricter gate prevents malformed labels, IP literals, and
 * bare/poisoned values from reaching the URL builder.
 */
function normalizeGatewayDomain(domain) {
  if (typeof domain !== 'string') return null;
  const normalized = domain.trim().toLowerCase();
  if (!normalized || domain !== domain.trim() || normalized.length > 253 ||
      normalized.endsWith('.') || /[/?#@\s]/.test(normalized)) {
    return null;
  }
  // Reject valid and malformed dotted-decimal spellings. A malformed numeric
  // value such as 192.168.001.1 would otherwise pass the label-count check.
  if (/^\d+(?:\.\d+){3}$/.test(normalized) ||
      isValidIpv4Literal(normalized) || isValidIpv6Literal(normalized)) {
    return null;
  }
  const labels = normalized.split('.');
  if (labels.some((label) =>
    label.length === 0 || label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    return null;
  }
  return normalized;
}

/** Domains allowed in saved-gateway storage: AutoTLS shapes plus `.local`
 * (kept for resolveBridgeWtHost's mDNS branch; never used as an AutoTLS
 * candidate). */
function isStorableGatewayDomain(domain) {
  const normalized = normalizeGatewayDomain(domain);
  return normalized !== null &&
    (isAutoTlsGatewayDomain(normalized) || normalized.endsWith('.local'));
}

export function saveGateway(gatewayDomain, localAddress, fingerprint = '') {
  try {
    if (gatewayDomain && localAddress) {
      const cleanGatewayDomain = normalizeGatewayDomain(gatewayDomain);
      const cleanLocalAddress = normalizeBridgeHost(localAddress);
      if (!cleanGatewayDomain || !cleanLocalAddress || !isStorableGatewayDomain(cleanGatewayDomain)) {
        console.warn(`${TAG} Not saving gateway "${gatewayDomain}": no gateway label (need gw-xxx.<apex>) — dashed-IP names built on it can never resolve`);
        return;
      }
      const cleanFingerprint = String(fingerprint || '').replace(/:/g, '');
      localStorage.setItem(GW_STORAGE_KEY, JSON.stringify({
        gatewayDomain: cleanGatewayDomain,
        localAddress: cleanLocalAddress,
        ...(cleanFingerprint ? { fingerprint: cleanFingerprint } : {}),
        savedAt: Date.now(),
      }));
      console.log(`${TAG} Saved gateway: ${cleanLocalAddress} / ${cleanGatewayDomain}`);
    }
  } catch (e) { console.warn(`${TAG} localStorage save failed:`, e.message); }
}

export function loadSavedGateway() {
  try {
    const saved = localStorage.getItem(GW_STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      // Expire after 30 days
      const gatewayDomain = normalizeGatewayDomain(data.gatewayDomain);
      const localAddress = normalizeBridgeHost(data.localAddress);
      const now = Date.now();
      // `savedAt > now` is rejected rather than clamped: the 30-day window is
      // derived from the state that was valid at `savedAt`, so a future
      // `savedAt` does not describe a shorter window — it describes one this
      // code cannot bound at all, and `now - savedAt` being negative would keep
      // the record alive until wall-clock time caught up. A device clock running
      // fast at save time, corrected afterwards, is the reachable path. A
      // missing `savedAt` is the same case: `NaN` compares false either way, so
      // it must be rejected explicitly or the key survives every later load.
      // Only the unusable-`savedAt` cases warn; a plain 30-day expiry is the
      // normal path and would be noise.
      const unusableSavedAt = !Number.isFinite(data.savedAt) || data.savedAt > now;
      if (unusableSavedAt || now - data.savedAt >= 30 * 86400000) {
        if (unusableSavedAt) {
          console.warn(`${TAG} Evicting saved gateway with unusable savedAt ${data.savedAt} (now ${now})`);
        }
        localStorage.removeItem(GW_STORAGE_KEY);
      } else if (gatewayDomain && localAddress) {
        if (isStorableGatewayDomain(gatewayDomain)) {
          return {
            ...data,
            gatewayDomain,
            localAddress,
            fingerprint: data.fingerprint ? String(data.fingerprint) : '',
          };
        }
        // Self-heal state persisted before the saveGateway guard existed
        // (e.g. bare "bcast.id" from an early bridge /health): evict so
        // bootstrap rediscovery runs instead of retrying a name that can
        // never resolve.
        console.warn(`${TAG} Evicting poisoned saved gateway "${data.gatewayDomain}" (no gateway label)`);
        localStorage.removeItem(GW_STORAGE_KEY);
      }
    }
    // Cross-check bridge-discovery's persisted bridges (shared localStorage)
    const bridgeDiscoveries = localStorage.getItem('iwa-bridge-discoveries');
    if (bridgeDiscoveries) {
      const bridges = JSON.parse(bridgeDiscoveries);
      for (const b of bridges) {
        const gatewayDomain = normalizeGatewayDomain(b.gatewayDomain);
        const localAddress = normalizeBridgeHost(b.localAddress);
        if (localAddress && gatewayDomain && isStorableGatewayDomain(gatewayDomain)) {
          console.log(`${TAG} Found gateway in bridge-discovery cache: ${localAddress} / ${gatewayDomain}`);
          // Promote to our own key for faster future lookups
          saveGateway(gatewayDomain, localAddress, b.fingerprint);
          return {
            gatewayDomain,
            localAddress,
            fingerprint: b.fingerprint ? String(b.fingerprint) : '',
            savedAt: Date.now(),
          };
        }
      }
    }
  } catch (e) { console.warn(`${TAG} loadSavedGateway failed:`, e.message); }
  return null;
}

/** Build IP-in-hostname for AutoTLS: 192.168.1.181 + gw-xxx.bcast.id → 192-168-1-181.gw-xxx.bcast.id */
function ipInHostname(ip, gwDomain) {
  return isValidIpv4Literal(ip) ? `${ip.replace(/\./g, '-')}.${gwDomain}` : null;
}

export function resolveBridgeWtHost(host, { gatewayDomain, localAddress } = {}) {
  const cleanGatewayDomain = normalizeGatewayDomain(gatewayDomain);
  if (!cleanGatewayDomain || !isStorableGatewayDomain(cleanGatewayDomain)) return null;
  if (cleanGatewayDomain.endsWith('.local')) return 'localhost';
  if (isValidIpv4Literal(host)) return ipInHostname(host, cleanGatewayDomain);
  if (localAddress && isValidIpv4Literal(localAddress) &&
      (host?.endsWith('.local') || isLoopback(host))) {
    return ipInHostname(localAddress, cleanGatewayDomain);
  }
  return null;
}

function bridgeFetchOptions(host, timeoutMs = 2000) {
  const opts = { signal: AbortSignal.timeout(timeoutMs) };
  const pna = pnaTarget(host);
  if (pna) opts.targetAddressSpace = pna;
  return opts;
}

function bridgeHttpUrl(protocol, host, port) {
  return hostUrl(protocol, host, port);
}

function getStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeDiscoveryScope(scope) {
  return scope ? String(scope) : DEFAULT_DISCOVERY_SCOPE;
}

function discoveryStorageKey(baseKey, scope) {
  const normalized = normalizeDiscoveryScope(scope);
  return normalized === DEFAULT_DISCOVERY_SCOPE
    ? baseKey
    : `${baseKey}:${encodeURIComponent(normalized)}`;
}

/**
 * `params` defaults to the query alone, but callers that steer discovery from
 * `bridgeUrlParams()` must pass that overlaid view: a fragment-carried
 * `#gw=`/`#mc_bridge=` steers discovery exactly as its `?` twin does, so it has
 * to isolate the cache key the same way. Without it a *partial* fragment pin —
 * one that misses the early return in `discoverBridge` — writes its result
 * under `DEFAULT_DISCOVERY_SCOPE`, which is the key a clean load then reads.
 * The scope cannot re-read `location.hash` itself: `initMulticastBridge`
 * harvests and `replaceState`-strips the fragment before computing the scope,
 * which is correct for the privacy goal and is why the parsed view is threaded
 * in instead.
 */
export function bridgeDiscoveryScopeFromInputs({
  search = globalThis.location?.search || '',
  hostname = globalThis.location?.hostname || '',
  params = new URLSearchParams(search),
} = {}) {
  const mcBridge = params.get('mc_bridge') || '';
  const gateway = params.get('gw') || '';
  const localPageHost = hostname?.endsWith('.local') ? hostname : '';

  if (!mcBridge && !gateway && !localPageHost) return DEFAULT_DISCOVERY_SCOPE;
  return JSON.stringify({
    mc_bridge: mcBridge,
    gw: gateway,
    localPageHost,
  });
}

/**
 * The scope a *pairing* is stored under. Deliberately narrower than the
 * discovery scope: it omits the pin, because a pairing exists precisely to be
 * retrieved on a later, pin-free visit. Keying it by `?mc_bridge=` would write
 * the record under a key the next clean load cannot compute, stranding it for
 * the full TTL — the query-param handoff would then never re-pair. Only the
 * stable part of the page identity belongs here.
 */
export function bridgePairingScopeFromInputs({
  hostname = globalThis.location?.hostname || '',
} = {}) {
  const localPageHost = hostname?.endsWith('.local') ? hostname : '';
  return localPageHost ? JSON.stringify({ localPageHost }) : DEFAULT_DISCOVERY_SCOPE;
}

/**
 * A cached enrollment is a comparand, never a trust anchor. It is only ever
 * compared field-for-field against an attestation this page verified in the
 * current lifecycle, so poisoned localStorage can at worst fail that match —
 * which is why the id-to-key derivation is not re-checked here (it is async,
 * and `rotateCachedBridgeFingerprint` re-establishes it anyway).
 */
function normalizeCachedEnrollment(value) {
  if (!value || typeof value !== 'object') return null;
  const bridgeId = enrollmentHex(value.bridgeId, 32);
  const publicKey = enrollmentHex(value.publicKey, BRIDGE_ENROLLMENT_PUBLIC_KEY_BYTES);
  return bridgeId && publicKey ? { bridgeId, publicKey } : null;
}

function normalizeCachedBridge(bridge) {
  if (!bridge || typeof bridge !== 'object' || !bridge.host) return null;
  const host = normalizeBridgeHost(String(bridge.host));
  if (!host) return null;
  const httpPort = parsePort(bridge.httpPort);
  const wtPort = parsePort(bridge.wtPort);
  if (httpPort === null || wtPort === null || !isValidPort(httpPort) || !isValidPort(wtPort)) return null;
  if (!isBcdsBridgeCapability(bridge)) return null;
  const rawGatewayDomain = bridge.gatewayDomain == null ? '' : String(bridge.gatewayDomain);
  const gatewayDomain = rawGatewayDomain ? normalizeGatewayDomain(rawGatewayDomain) : '';
  if (rawGatewayDomain && !gatewayDomain) return null;
  const rawFingerprint = bridge.fingerprint == null ? '' : String(bridge.fingerprint);
  // AutoTLS uses a CA-validated hostname and therefore has no pin. Every
  // fingerprint-bearing cached entry must still carry a complete SHA-256 pin;
  // otherwise poisoned localStorage can bypass the live-discovery invariant.
  const fingerprint = rawFingerprint.trim() === ''
    ? (isAutoTlsGatewayDomain(gatewayDomain) ? '' : null)
    : normalizeFingerprint(rawFingerprint);
  if (fingerprint === null) return null;
  // An unusable enrollment is dropped, not fatal: the entry is still a valid
  // fingerprint-pinned bridge, it just cannot survive a certificate rotation.
  const enrollment = normalizeCachedEnrollment(bridge.enrollment);
  return {
    host,
    fingerprint,
    httpPort,
    wtPort,
    ...(enrollment ? { enrollment } : {}),
    gatewayDomain,
    localAddress: bridge.localAddress ? normalizeBridgeHost(String(bridge.localAddress)) || '' : '',
    discoveryMethod: bridge.discoveryMethod ? String(bridge.discoveryMethod) : 'cache',
    bridgeProtocol: BCDS_BRIDGE_PROTOCOL,
    webTransportBridge: true,
  };
}

export function nextBridgePollDelay(currentDelayMs = POLL_INTERVAL, reason = 'miss') {
  if (reason === 'reset') return POLL_INTERVAL;
  if (reason === 'lock-busy') return currentDelayMs;

  const current = Number.isFinite(currentDelayMs) && currentDelayMs > 0
    ? currentDelayMs
    : POLL_INTERVAL;
  return Math.min(POLL_MAX_INTERVAL, Math.max(POLL_INTERVAL, Math.ceil(current * POLL_BACKOFF_FACTOR)));
}

function jitterDelay(delayMs, random = Math.random) {
  const jitter = 1 + ((random() * 2 - 1) * POLL_JITTER_RATIO);
  return Math.max(250, Math.round(delayMs * jitter));
}

export function readBridgeDiscoveryCache(httpPort, now = Date.now(), storage, scope = DEFAULT_DISCOVERY_SCOPE) {
  const store = getStorage(storage);
  if (!store) return null;
  const requestedHttpPort = parsePort(httpPort);
  if (requestedHttpPort === null || !isValidPort(requestedHttpPort)) return null;

  const normalizedScope = normalizeDiscoveryScope(scope);
  const key = discoveryStorageKey(DISCOVERY_CACHE_KEY, normalizedScope);
  const entry = parseJson(store.getItem(key));
  if (
    !entry ||
    parsePort(entry.httpPort) !== requestedHttpPort ||
    normalizeDiscoveryScope(entry.scope) !== normalizedScope ||
    Number(entry.expiresAt) <= now
  ) {
    try { store.removeItem(key); } catch {}
    return null;
  }

  if (entry.status === 'miss') {
    return { status: 'miss', expiresAt: Number(entry.expiresAt) };
  }

  if (entry.status === 'found') {
    const bridge = normalizeCachedBridge(entry.bridge);
    if (bridge) return { status: 'found', bridge, expiresAt: Number(entry.expiresAt) };
  }

  try { store.removeItem(key); } catch {}
  return null;
}

export function writeBridgeDiscoveryCache(httpPort, bridge, options = {}) {
  const store = getStorage(options.storage);
  const normalized = normalizeCachedBridge(bridge);
  const normalizedHttpPort = parsePort(httpPort);
  if (!store || !normalized || normalizedHttpPort === null || !isValidPort(normalizedHttpPort)) return false;

  try {
    const now = options.now ?? Date.now();
    const scope = normalizeDiscoveryScope(options.scope);
    store.setItem(discoveryStorageKey(DISCOVERY_CACHE_KEY, scope), JSON.stringify({
      status: 'found',
      httpPort: normalizedHttpPort,
      scope,
      bridge: normalized,
      savedAt: now,
      expiresAt: now + (options.ttlMs ?? DISCOVERY_CACHE_SUCCESS_TTL_MS),
    }));
    return true;
  } catch {
    return false;
  }
}

export function writeBridgeDiscoveryMiss(httpPort, options = {}) {
  const store = getStorage(options.storage);
  const normalizedHttpPort = parsePort(httpPort);
  if (!store || normalizedHttpPort === null || !isValidPort(normalizedHttpPort)) return false;

  try {
    const now = options.now ?? Date.now();
    const scope = normalizeDiscoveryScope(options.scope);
    store.setItem(discoveryStorageKey(DISCOVERY_CACHE_KEY, scope), JSON.stringify({
      status: 'miss',
      httpPort: normalizedHttpPort,
      scope,
      savedAt: now,
      expiresAt: now + (options.ttlMs ?? DISCOVERY_CACHE_MISS_TTL_MS),
    }));
    return true;
  } catch {
    return false;
  }
}

export function clearBridgeDiscoveryCache(options = {}) {
  const store = getStorage(options.storage);
  if (!store) return false;
  try {
    store.removeItem(discoveryStorageKey(DISCOVERY_CACHE_KEY, normalizeDiscoveryScope(options.scope)));
    return true;
  } catch {
    return false;
  }
}

export function tryAcquireBridgeDiscoveryLock(httpPort, options = {}) {
  const store = getStorage(options.storage);
  const normalizedHttpPort = parsePort(httpPort);
  const now = options.now ?? Date.now();
  const owner = options.owner || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ttlMs = options.ttlMs ?? DISCOVERY_LOCK_TTL_MS;
  const scope = normalizeDiscoveryScope(options.scope);
  if (!store) return owner;
  if (normalizedHttpPort === null || !isValidPort(normalizedHttpPort)) return null;

  try {
    const key = discoveryStorageKey(DISCOVERY_LOCK_KEY, scope);
    const existing = parseJson(store.getItem(key));
    if (
      existing &&
      parsePort(existing.httpPort) === normalizedHttpPort &&
      normalizeDiscoveryScope(existing.scope) === scope &&
      Number(existing.expiresAt) > now &&
      existing.owner
    ) {
      return null;
    }

    store.setItem(key, JSON.stringify({
      httpPort: normalizedHttpPort,
      scope,
      owner,
      expiresAt: now + ttlMs,
    }));

    const saved = parseJson(store.getItem(key));
    return saved?.owner === owner ? owner : null;
  } catch {
    return owner;
  }
}

export function releaseBridgeDiscoveryLock(owner, options = {}) {
  if (!owner) return;
  const store = getStorage(options.storage);
  if (!store) return;

  try {
    const scope = normalizeDiscoveryScope(options.scope);
    const key = discoveryStorageKey(DISCOVERY_LOCK_KEY, scope);
    const existing = parseJson(store.getItem(key));
    if (existing?.owner === owner) {
      store.removeItem(key);
    }
  } catch {}
}

// ── Persisted pairing (localStorage) ──
// A pinned handoff is a one-time event: remember the endpoint and the hashes it
// authenticated with, so the next page load reconnects without another tap.
// The record is origin-partitioned by localStorage and then keyed by the
// *pairing* scope — narrower than the discovery cache's, which includes the pin
// (see `bridgePairingScopeFromInputs`). It holds `[current, next]` hashes so a
// rotation that happens while the page is closed still connects.
//
// SECURITY: like the discovery cache at `readBridgeDiscoveryCache`, this record
// dictates host, port, and cert hash, so an origin-local write can steer the
// first connect away from live discovery — and at higher precedence, since the
// pairing is consulted before every probing rung. That is a deliberate trade
// for the one-tap goal: the actor class is unchanged (anyone who can write this
// origin's localStorage can already poison discovery), and a wrong record fails
// the TLS pin and is dropped on the spot. The TTL is the bound on that window —
// shorten it, do not remove it. Note it bounds *idle* time, not absolute age:
// every successful install re-saves the record with a fresh `storedAt`, so a
// page visited weekly keeps one alive indefinitely. That is the intended
// one-tap UX and costs nothing here — a record that survives is one that keeps
// passing the pin — but the TTL is not a cap on how long a poisoned record can
// live.
//
// The window is *derived, not chosen*: a cert that passed the pin at `storedAt`
// was valid then, and WebTransport §11.1 caps a `serverCertificateHashes` cert
// at 14 days total validity, so it expires no later than `storedAt + 14d`. Past
// that the stored `current` hash cannot authenticate anything and the record is
// only a steering primitive. (This bridge mints 13 — see
// `packages/native-bcds-bridge/src/lib.rs`, `not_after = now + days(13)`.)
// One case is deliberately given up: a `next` hash learned by rotation has a
// later validity window and can outlive the bound, so a record dropped at 14
// days idle may discard a still-good successor. That costs one rediscovery
// through rungs 1/2/3 — the specified fallback — and is preferred over holding
// a steering record for longer than any pin in it can be valid.
const PAIRING_KEY = 'multicast-bridge-pairing-v1';
const PAIRING_TTL_MS = 14 * 86400000;
// Offered together in a single `serverCertificateHashes` list, so the store
// bound is also the connect payload bound. It is `PAIRING_MAX_HASHES`, declared
// at the rendezvous section below because that rung is what sizes it: a record
// written by `connectRendezvousCandidate` must keep the *whole* union that
// connect offered, and WebTransport does not report which hash matched, so any
// smaller bound discards the winner's own pin on a contended key.
//
// The rotation handler is the one place allowed to shrink the set, and
// `ROTATION_MERGE_MAX_HASHES` is its bound: an announcement comes from the
// bridge itself, so it is the signal that converts a record full of strangers'
// hashes back into this device's own. Keeping it small is what makes that
// pruning happen at all.
const ROTATION_MERGE_MAX_HASHES = 4;

function normalizeHashes(value) {
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map(normalizeFingerprint).filter(Boolean))];
}

// `httpPort` is the one optional field in the record, so an out-of-range value
// is blanked rather than rejecting the whole pairing: rung 0 falls back to the
// caller's `httpPort` and the record still authenticates. Range-checked like
// the sibling store's `normalizeCachedBridge` — a hand-written `99999`/`-5`/`0`
// otherwise survives a load and is re-persisted by the next successful connect,
// which makes it sticky.
function optionalPort(value) {
  return isValidPort(value) ? parsePort(value) : null;
}

export function saveBridgePairing(bridge, options = {}) {
  const store = getStorage(options.storage);
  if (!store) return null;
  // A record describes the *direct* pinned endpoint — it has no field for a
  // gateway route, and rung 0 rebuilds no AutoTLS candidate from it. A bridge
  // carrying a `gatewayDomain` was reached through the AutoTLS candidate
  // `connect()` builds first and unconditionally, so remembering it here would
  // describe a route this session never took and steer the next load onto the
  // direct private-IP path AutoTLS exists to bypass — the one Chrome PNA blocks
  // on an HTTPS page. `normalizeBridgeHealth` blanks the fingerprint only when
  // the health response omits one, so a response advertising a pin *and* a
  // domain keeps both and reaches here with a non-empty `fingerprint`; the
  // empty-hash guard below does not catch that shape. That shape is already
  // remembered by `saveGateway`, which stores the route rather than dropping it.
  // Deliberately conservative in one case: if the AutoTLS candidate *fails*,
  // `connect()` falls through to the pinned candidate and the session does take
  // the direct route this record describes — but it is still not written, so on
  // a deployment with broken AutoTLS one-tap pairing never engages and each load
  // re-pays the failing gateway attempt. Preferred over risking a wrong route.
  if (bridge?.gatewayDomain) return null;
  const host = normalizeBridgeHost(bridge?.host || '');
  const wtPort = parsePort(bridge?.wtPort);
  const hashes = normalizeHashes(bridge?.hashes ?? bridge?.fingerprint).slice(0, PAIRING_MAX_HASHES);
  if (!host || wtPort === null || !isValidPort(wtPort) || hashes.length === 0) return null;

  const record = {
    host,
    wtPort,
    httpPort: optionalPort(bridge?.httpPort),
    hashes,
    storedAt: options.now ?? Date.now(),
  };
  try {
    store.setItem(discoveryStorageKey(PAIRING_KEY, options.scope), JSON.stringify(record));
    console.log(`${TAG} Saved bridge pairing: ${host}:${wtPort} (${hashes.length} hash(es))`);
  } catch (e) {
    console.warn(`${TAG} Could not save bridge pairing:`, e.message);
    return null;
  }
  return record;
}

export function loadBridgePairing(options = {}) {
  const store = getStorage(options.storage);
  if (!store) return null;
  const now = options.now ?? Date.now();
  try {
    const record = parseJson(store.getItem(discoveryStorageKey(PAIRING_KEY, options.scope)));
    const host = normalizeBridgeHost(record?.host || '');
    const wtPort = parsePort(record?.wtPort);
    const hashes = normalizeHashes(record?.hashes).slice(0, PAIRING_MAX_HASHES);
    if (!host || wtPort === null || !isValidPort(wtPort) || hashes.length === 0) return null;
    // `storedAt > now` is rejected rather than clamped: the TTL window is
    // *derived* from the cert that passed the pin at `storedAt`, so a future
    // `storedAt` does not describe a shorter window — it describes one this
    // code cannot bound at all, and `now - storedAt` being negative would keep
    // the record alive until wall-clock time caught up. Clock skew corrected
    // after a pairing is the reachable path.
    if (
      !Number.isFinite(record.storedAt) ||
      record.storedAt > now ||
      now - record.storedAt >= PAIRING_TTL_MS
    ) {
      clearBridgePairing(options);
      return null;
    }
    return { host, wtPort, httpPort: optionalPort(record.httpPort), hashes, storedAt: record.storedAt };
  } catch (e) {
    console.warn(`${TAG} Could not read bridge pairing:`, e.message);
    return null;
  }
}

export function clearBridgePairing(options = {}) {
  const store = getStorage(options.storage);
  if (!store) return;
  try {
    store.removeItem(discoveryStorageKey(PAIRING_KEY, options.scope));
  } catch {}
}

// ── Rendezvous (rung 3) ──
// The edge answers `GET <base>/v1/bridges` keyed on the *caller's own public
// address* with every bridge pin published from that address — so the response
// is a set of strangers' candidates, not an answer. See
// `trafficcontrol/internal/rendezvous/response.go`. Only a pinned handshake
// tells them apart, which is why this rung races pinned connects and has no
// unpinned path at all.
//
// SECURITY (BLO-34188 DPIA, and BLO-34189 § A/B.2): a pin proves "this cert
// matches a hash someone at your keying identifier published", never "this is
// your bridge". On a shared public address — café Wi-Fi, CGNAT — an attacker
// publishes a genuine pin for a cert whose key they hold and wins the race
// against their own LAN address. Loopback is the one class where the address
// itself carries the identity proof: only a process on this device can bind it.
// So non-loopback candidates are dropped *at the parse boundary* below — not
// connected, not persisted, not queued — rather than delegated to
// `canProbeBridgeHost`, whose `explicitBridge && isPrivateIp` arm would admit
// them. Rendezvous candidates are never marked `explicitBridge`. The edge
// already refuses to serve `lan_ips` (DPIA F3), so this filter is defence in
// depth, and it is the half that survives a change at either end.
//
// SIZE: the same doctrine applied to the one dimension the filter above does
// not cover — how *much* the edge may say. `response.go` reasons about up to 64
// unrelated households at one key, so these caps sit above the honest envelope
// and bite only on an edge that is compromised, rolled back, or misconfigured.
// Without them a body of tens of thousands of distinct loopback ports becomes
// one `WebTransport` plus one timer each in `connectRendezvousCandidate`, and a
// cache write large enough to evict the pairing record from the storage quota.
const RENDEZVOUS_PATH = '/v1/bridges';
const RENDEZVOUS_TIMEOUT_MS = 1500;
const RENDEZVOUS_KEY = 'multicast-bridge-rendezvous-v1';
const RENDEZVOUS_MAX_CANDIDATES = 128;
const RENDEZVOUS_MAX_ENDPOINTS = 64;
// The one cap that must sit *above* the envelope rather than merely near it,
// because the collapse case is the default case: every candidate that survives
// the parse is loopback by construction, and a default-configured bridge binds
// `DEFAULT_WT_PORT` 33445 (`packages/native-bcds-bridge/src/lib.rs`), so all 64
// households at one key land on a single `127.0.0.1:33445` endpoint and share
// one hash union. A union smaller than the envelope does not degrade the race —
// it makes every household past the cut *unable to complete the handshake at
// all*, silently and on every subsequent load, because its own pin was never
// offered. 128 is that envelope twice over: 64 households each publishing
// `[current, next]` across a rotation. That is the *edge's* enforced product,
// not this file's: `bridgepin.MaxLookupResults = 64` bounds a lookup and
// `bridgepin.MaxHashes = 2` is rejected at publish by `ErrHashCount`
// (`traffic_ops/traffic_ops_golang/bridgepin/bridgepins.go`). The client's own
// caps cannot derive it — `RENDEZVOUS_MAX_CANDIDATES` is 128 and nothing bounds
// a candidate's `hashes` array, so a body that passes the candidate cap can
// still offer 256 on one key, which is exactly the shape this cap is for. Zero
// margin on 64 × 2 is deliberate per the doctrine above, but it means a change
// at the edge makes this cap bite — hence the warning at the truncation site.
// A hash costs one entry in a constructor argument; unlike an endpoint it
// carries no connect and no timer.
const RENDEZVOUS_MAX_HASHES_PER_ENDPOINT = 128;
// The pairing store's bound, declared here because this is the constant that
// sizes it. `connectRendezvousCandidate` persists the endpoint it won, and the
// hash that actually authenticated is unknowable — WebTransport reports only
// that one of the offered hashes matched. So the record must keep everything
// the connect offered, or the winner's own pin is dropped on exactly the
// contended key this cap exists to serve: 64 households share one
// `127.0.0.1:33445`, a 4-hash record stores households 0 and 1, and the other
// 62 fail the pinned rung-0 connect on every subsequent load and re-pay full
// discovery. Costs ~8 KB of `localStorage`, inside the 64 KB budgeted above,
// and widens nothing — the next load offers exactly the set this load offered,
// to the same loopback address.
const PAIRING_MAX_HASHES = RENDEZVOUS_MAX_HASHES_PER_ENDPOINT;
// UTF-16 code units, not bytes — `String.length`, which is also the unit
// browsers meter the `localStorage` quota in, so it is the right measure here.
const RENDEZVOUS_MAX_CACHE_CHARS = 64 * 1024;

/**
 * Candidates from one rendezvous body, in response order (the edge hoists
 * loopback to the front before serving). Anything malformed, non-loopback, or
 * hash-less is dropped on receipt — a candidate with no hashes has no pinned
 * connect, and the alternative to dropping it is the unpinned connect this
 * rung must never make. Truncated at `RENDEZVOUS_MAX_CANDIDATES`: response
 * order is the edge's own preference, so the first N are the ones to keep.
 */
export function parseRendezvousBridges(body) {
  const list = Array.isArray(body?.bridges) ? body.bridges : [];
  const out = [];
  for (const entry of list) {
    if (out.length >= RENDEZVOUS_MAX_CANDIDATES) break;
    const host = normalizeBridgeHost(entry?.host || '');
    const wtPort = parsePort(entry?.wtPort);
    const hashes = normalizeHashes(entry?.hashes);
    if (!host || !isLoopback(host) || wtPort === null || !isValidPort(wtPort) || hashes.length === 0) continue;
    out.push({ host, wtPort, hashes });
  }
  return out;
}

/**
 * One endpoint per `host:port`, carrying the union of every candidate hash
 * published for it, in first-seen order. This is the shape the connect race
 * needs: at one IPv4 key up to 64 unrelated households all publish host
 * `127.0.0.1` — and, on the default port, the *same* `host:port` — so they
 * collapse to a single connect offering every hash, and only the real bridge's
 * certificate completes the handshake. Both the endpoint count and each hash
 * union are capped, but for opposite reasons: an endpoint costs a connect and a
 * timer, so `RENDEZVOUS_MAX_ENDPOINTS` is a real resource bound, while a hash
 * costs one list entry and its cap is only a backstop against a single
 * flooding candidate — which is why it sits well above the envelope. Dropping
 * a household's hash here does not slow the race, it makes that household
 * permanently unable to connect.
 */
function groupRendezvousEndpoints(candidates) {
  const byEndpoint = new Map();
  let dropped = 0;
  for (const c of candidates) {
    const key = `${c.host}:${c.wtPort}`;
    const existing = byEndpoint.get(key);
    if (existing) {
      const union = normalizeHashes([...existing.hashes, ...c.hashes]);
      dropped += Math.max(0, union.length - RENDEZVOUS_MAX_HASHES_PER_ENDPOINT);
      existing.hashes = union.slice(0, RENDEZVOUS_MAX_HASHES_PER_ENDPOINT);
    } else if (byEndpoint.size < RENDEZVOUS_MAX_ENDPOINTS) {
      dropped += Math.max(0, c.hashes.length - RENDEZVOUS_MAX_HASHES_PER_ENDPOINT);
      byEndpoint.set(key, { host: c.host, wtPort: c.wtPort, hashes: c.hashes.slice(0, RENDEZVOUS_MAX_HASHES_PER_ENDPOINT) });
    }
  }
  // Truncating here is a *permanent* failure for the households whose pin was
  // cut, and nothing downstream can tell: the rung still reports a healthy
  // candidate count and the connect still succeeds for someone. The cap sits
  // exactly on the edge's enforced 64 × 2, so an edge that raises `MaxHashes`
  // makes this bite on honest traffic — this line is the only thing that would
  // say so. Diagnostic output only; nothing reads it back.
  if (dropped > 0) {
    console.warn(`${TAG} Rendezvous hash cap dropped ${dropped} hash(es) — the edge envelope may have outgrown RENDEZVOUS_MAX_HASHES_PER_ENDPOINT (${RENDEZVOUS_MAX_HASHES_PER_ENDPOINT})`);
  }
  return [...byEndpoint.values()];
}

/**
 * Start the rendezvous lookup. Returns a promise of candidates that **never
 * rejects**: a rendezvous error contributes nothing and the other rungs decide.
 * Called before rungs 1 and 2 and awaited after them, so the HTTPS round trip
 * overlaps the local probes instead of serialising behind them.
 *
 * The base URL comes from the page's bridge configuration. No rendezvous host
 * is hardcoded here or anywhere in this file — a per-site literal is exactly
 * the thing that cannot be rotated or withdrawn.
 */
export function startRendezvousLookup(baseUrl, options = {}) {
  if (!baseUrl) return null;
  const startedAt = Date.now();
  return (async () => {
    let candidates = [];
    try {
      candidates = await rendezvousCandidates(baseUrl, options);
    } catch (e) {
      // Fail closed and quietly. Reaching here means a bug rather than a
      // network failure (those are handled below), so it is still reported.
      console.warn(`${TAG} Rendezvous lookup failed:`, e?.message);
    }
    // One structured line per rendezvous attempt. Diagnostic output only —
    // nothing in this flow reads it back.
    console.log(`${TAG} discovery rung`, {
      rung: 'rendezvous',
      latencyMs: Date.now() - startedAt,
      candidates: candidates.length,
    });
    return candidates;
  })();
}

async function rendezvousCandidates(baseUrl, { scope, storage, now } = {}) {
  const store = getStorage(storage);
  const cacheKey = discoveryStorageKey(RENDEZVOUS_KEY, scope);
  const cached = store ? parseJson(safeGetItem(store, cacheKey)) : null;

  const headers = {};
  // Only with a cached body to fall back on. An `If-None-Match` sent without
  // one buys a 304 that this client cannot turn into candidates.
  if (typeof cached?.etag === 'string' && cached.etag && Array.isArray(cached.body?.bridges)) {
    headers['If-None-Match'] = cached.etag;
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), RENDEZVOUS_TIMEOUT_MS) : null;
  let resp;
  try {
    resp = await fetch(`${String(baseUrl).replace(/\/+$/, '')}${RENDEZVOUS_PATH}`, {
      // No ambient authority: the response is keyed on the network address
      // alone and must never be personalised by a cookie (DPIA § 2).
      credentials: 'omit',
      cache: 'no-store',
      headers,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch {
    return [];           // network error, or the 1.5 s abort
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (resp.status === 304) {
    // A 304 with no cached body contributes nothing rather than erroring: the
    // record can be evicted between the write and the conditional request.
    return parseRendezvousBridges(cached?.body);
  }
  if (!resp.ok) return [];

  let body;
  try {
    body = await resp.json();
  } catch {
    return [];
  }
  if (store) {
    const etag = resp.headers?.get?.('ETag');
    // Written whole so the pair can never disagree; absent together on a
    // response with no ETag, which is simply a cache miss next time. An
    // oversized body is not cached at all — the quota it would take is shared
    // with the pairing record, and that record is worth more than this one.
    const record = etag ? JSON.stringify({ etag, body, storedAt: now ?? Date.now() }) : null;
    safeSetItem(store, cacheKey, record && record.length <= RENDEZVOUS_MAX_CACHE_CHARS ? record : null);
  }
  return parseRendezvousBridges(body);
}

function safeGetItem(store, key) {
  try { return store.getItem(key); } catch { return null; }
}

function safeSetItem(store, key, value) {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch { /* quota or a disabled store — the rung works without the cache */ }
}

/**
 * Race one pinned connect per endpoint; first success wins and the rest are
 * aborted. Returns a descriptor for the winner, or null.
 *
 * Every attempt carries `serverCertificateHashes` by construction — an
 * endpoint reaches here only through `parseRendezvousBridges`, which drops
 * hash-less entries, and the guard below is the second lock on the same door.
 * There is deliberately no unpinned fallback: an unpinned connect to a
 * rendezvous-supplied address authenticates nothing at all.
 */
export async function connectRendezvousCandidate(candidates, { httpPort, pairingScope } = {}) {
  const endpoints = groupRendezvousEndpoints(candidates);
  if (endpoints.length === 0 || typeof WebTransport === 'undefined') return null;

  const sessions = [];
  const attempts = [];
  for (const endpoint of endpoints) {
    const url = hostUrl('https', endpoint.host, endpoint.wtPort);
    if (!url || endpoint.hashes.length === 0) continue;
    const wt = new WebTransport(url, {
      serverCertificateHashes: endpoint.hashes.map((fp) => ({ algorithm: 'sha-256', value: hexToBytes(fp) })),
    });
    sessions.push(wt);
    attempts.push(
      Promise.race([
        Promise.resolve(wt.ready).then(() => endpoint),
        // Bounds a losing endpoint that neither completes nor fails — QUIC to a
        // closed UDP port. Left to fire rather than cleared on settle: the
        // rejection lands on a promise `Promise.any` is already watching, and
        // the timer must not hold a page (or a test runner) open meanwhile.
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('rendezvous connect timeout')), WT_CONNECT_TIMEOUT).unref?.();
        }),
      ]),
    );
  }
  if (attempts.length === 0) return null;

  let winner = null;
  try {
    // `Promise.any` is first *fulfilled*, not first settled — a losing
    // endpoint failing fast must not decide the race.
    winner = await Promise.any(attempts);
  } catch {
    winner = null;
  }
  // Every session is closed, the winner's included: this is a probe, and the
  // caller opens the session it will actually use. The cost is one extra
  // loopback handshake against the alternative of threading a live transport
  // out of discovery.
  for (const wt of sessions) {
    try { wt.close(); } catch { /* already failed or closed */ }
  }
  if (!winner) return null;

  // Remember the endpoint so the next visit skips the fetch entirely. The
  // whole offered union is stored, not a prefix of it: WebTransport does not
  // report which hash matched, so any truncation here is a coin flip on
  // whether the winner's own pin survives. `PAIRING_MAX_HASHES` is sized to
  // this union for that reason. The live `certificate_rotation` handler later
  // prunes the strangers back out once the bridge announces its own hashes.
  saveBridgePairing({ ...winner, httpPort }, { scope: pairingScope });
  console.log(`${TAG} Rendezvous bridge: ${winner.host}:${winner.wtPort} (${winner.hashes.length} hash(es))`);
  return {
    host: winner.host,
    fingerprint: winner.hashes,
    httpPort,
    wtPort: winner.wtPort,
    discoveryMethod: 'rendezvous',
  };
}

export function multicastBridgeTransportOptionsFromConfig(config = {}) {
  const opts = {};

  if (config.protocol !== undefined) opts.protocol = config.protocol;
  if (config.origin !== undefined) opts.origin = config.origin;
  if (config.standard !== undefined) opts.standard = config.standard;
  if (config.fec !== undefined) opts.fec = config.fec;
  // The canonical origin discriminant owns acquisition. IP-multicast is
  // native-only, including the omitted-origin default. AMT is tunnel-only.
  if (config.origin === 'amt') {
    opts.mode = 'tunnel';
    if (config.relay !== undefined) opts.amtRelay = config.relay;
    if (config.relayPort !== undefined) opts.amtRelayPort = config.relayPort;
  } else if (config.origin === undefined || config.origin === 'ip-multicast') {
    opts.mode = 'native';
  }
  if (config.reliableBacklog) opts.reliableBacklog = config.reliableBacklog;
  if (config.receiveTimestampSource !== undefined) {
    opts.receiveTimestampSource = config.receiveTimestampSource;
  }
  if (Array.isArray(config.packetIds)) opts.packetIds = [...config.packetIds];

  return opts;
}

function normalizeResolvedMulticastTransport(value) {
  if (value === 'native' || value === 'native-ssm' || value === 'ssm') return 'native';
  if (value === 'amt' || value === 'tunnel') return 'amt';
  return undefined;
}

/**
 * How a bridge subscription hands packets to the page, as the SERVER declared
 * it in its subscribe_response (window.multicast `delivery`).
 *
 * `'ordered-relay'`: every packet travels the subscription's one reliable BCDS
 * uni stream in socket-read order (native-bcds-bridge; its FrameRing drops the
 * oldest queued packet on overflow but never reorders). The page's FEC layer
 * then decides block fate by stream order instead of a datagram deadline,
 * because a pause on this stream carries no loss information. Only the server
 * knows whether it also sends datagram media, so the client never infers this;
 * an absent or unknown declaration stays undefined (no ordering promise).
 */
function normalizeMulticastDelivery(value) {
  return value === 'ordered-relay' || value === 'datagram' ? value : undefined;
}

function makeMulticastError(code, message, cause) {
  const err = new Error(message);
  err.name = 'MulticastError';
  err.code = code;
  if (cause !== undefined) err.cause = cause;
  return err;
}

function bytesEventDetail(event) {
  const receiveTime = Number(event?.receiveTime ?? event?.receiveTimestamp ?? event?.kernelReceiveTime);
  if (!Number.isFinite(receiveTime)) return event?.data;
  const receiveTimeOrigin = Number(
    event?.receiveTimeOrigin ??
    event?.receiveTimeOriginMilliseconds ??
    event?.receiveTimestampOrigin ??
    event?.timeOriginMilliseconds
  );
  return {
    data: event?.data,
    receiveTime,
    ...(Number.isFinite(receiveTimeOrigin) ? { receiveTimeOrigin } : {}),
    receiveTimestampSource: event?.receiveTimestampSource || event?.timestampSource || 'kernel-software',
  };
}

const BRIDGE_BYTES_SUBSCRIPTIONS = Symbol.for('blockcast.windowMulticastBridge.bytesSubscriptions');

/**
 * Events a bytes subscription from this bridge emits.
 *
 * `packets` (BLO-36599) carries every packet the bridge decoded in one reader
 * dispatch batch, in arrival order, as a frozen array whose elements are
 * exactly what `bytes` would have carried one event at a time (an ArrayBuffer,
 * or `{ data, receiveTime, receiveTimeOrigin?, receiveTimestampSource }` when
 * the frame had timing metadata). The batch boundary is the reader's own yield
 * point, so no packet waits on a timer. A consumer should listen to exactly one
 * of `bytes` or `packets`; both carry the same packets.
 */
const BYTES_SUBSCRIPTION_EVENT_TYPES = Object.freeze([
  'bytes',
  'packets',
  'state',
  'error',
  'transportchange',
]);
const THROUGHPUT_WINDOW_MS = 60_000;
const THROUGHPUT_SAMPLE_INTERVAL_MS = 1_000;

function ensureBridgeThroughputState(bridgeClient) {
  if (!bridgeClient._throughputHistoryState) {
    bridgeClient._throughputHistoryState = {
      baselines: new Map(),
      samples: [],
      nextReceiverId: 0,
    };
  }
  return bridgeClient._throughputHistoryState;
}

function activateSharedThroughputReceiver(bridgeClient, shared) {
  if (!shared.throughputEligible || shared.throughputActive) return;
  const state = ensureBridgeThroughputState(bridgeClient);
  shared.throughputReceiverId = `bridge-receiver-${++state.nextReceiverId}`;
  shared.throughputBytesReceived = 0;
  shared.throughputActive = true;
}

function retireSharedThroughputReceiver(shared) {
  shared.throughputActive = false;
  shared.throughputReceiverId = undefined;
  shared.throughputBytesReceived = 0;
}

function packetByteLength(event) {
  const data = event?.data;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  return Number.isSafeInteger(data?.byteLength) && data.byteLength >= 0
    ? data.byteLength
    : 0;
}

function markBridgeThroughputDiscontinuity(bridgeClient) {
  const sharedSubscriptions = bridgeClient[BRIDGE_BYTES_SUBSCRIPTIONS];
  if (!sharedSubscriptions) return;
  for (const shared of sharedSubscriptions.values()) {
    retireSharedThroughputReceiver(shared);
  }
}

function cloneThroughputSample(sample) {
  return {
    timestampMilliseconds: sample.timestampMilliseconds,
    aggregateBitsPerSecond: sample.aggregateBitsPerSecond,
    aggregateRateUnavailableReason: sample.aggregateRateUnavailableReason ?? null,
    subscriptions: sample.subscriptions.map((subscription) => ({ ...subscription })),
  };
}

function sampleBridgeThroughput(bridgeClient, now) {
  if (!Number.isFinite(now)) throw new TypeError('Throughput sample timestamp must be finite.');
  const state = ensureBridgeThroughputState(bridgeClient);
  const sharedSubscriptions = bridgeClient[BRIDGE_BYTES_SUBSCRIPTIONS];
  const counters = sharedSubscriptions
    ? [...sharedSubscriptions.values()].flatMap((shared) => {
        const transport = normalizeResolvedMulticastTransport(shared.latestTransport);
        if (
          !shared.throughputEligible ||
          !shared.throughputActive ||
          !shared.throughputReceiverId ||
          !transport ||
          shared.refs.size === 0
        ) {
          return [];
        }
        return [{
          id: shared.throughputReceiverId,
          transport,
          logicalConsumers: shared.refs.size,
          bytesReceived: shared.throughputBytesReceived,
        }];
    })
    : [];
  const invalidCounterCount = sharedSubscriptions
    ? [...sharedSubscriptions.values()].filter((shared) => {
        const transport = normalizeResolvedMulticastTransport(shared.latestTransport);
        return shared.throughputEligible && shared.throughputActive &&
          shared.throughputReceiverId && shared.refs.size > 0 &&
          (!transport || !Number.isFinite(shared.throughputBytesReceived) ||
            shared.throughputBytesReceived < 0);
      }).length
    : 0;

  const activeIds = new Set(counters.map((counter) => counter.id));
  const hasReceiverDiscontinuity =
    activeIds.size !== state.baselines.size ||
    counters.some((counter) => {
      const baseline = state.baselines.get(counter.id);
      return baseline === undefined ||
        baseline.transport !== counter.transport ||
        counter.bytesReceived < baseline.bytesReceived;
    });
  const previousSample = state.samples.at(-1);
  let clockRollback = false;
  if (previousSample && now < previousSample.timestampMilliseconds) {
    state.samples = [];
    state.baselines.clear();
    clockRollback = true;
  } else if (
    previousSample &&
    !hasReceiverDiscontinuity &&
    now - previousSample.timestampMilliseconds < THROUGHPUT_SAMPLE_INTERVAL_MS
  ) {
      return {
        version: 1,
        accounting: 'physical-multicast-ingress',
        vantage: 'page-bridge',
        windowMilliseconds: THROUGHPUT_WINDOW_MS,
        minSampleIntervalMilliseconds: THROUGHPUT_SAMPLE_INTERVAL_MS,
        samples: state.samples.map(cloneThroughputSample),
    };
  }

  for (const id of state.baselines.keys()) {
    if (!activeIds.has(id)) state.baselines.delete(id);
  }
  const subscriptions = counters.map((counter) => {
    const baseline = state.baselines.get(counter.id);
    const elapsedMilliseconds = baseline ? now - baseline.timestampMilliseconds : 0;
    const continuous = baseline !== undefined &&
      baseline.transport === counter.transport &&
      counter.bytesReceived >= baseline.bytesReceived &&
      elapsedMilliseconds > 0;
    const bitsPerSecond = continuous
      ? Math.round(
          ((counter.bytesReceived - baseline.bytesReceived) * 8 * 1_000) /
          elapsedMilliseconds,
        )
      : null;
    state.baselines.set(counter.id, {
      timestampMilliseconds: now,
      bytesReceived: counter.bytesReceived,
      transport: counter.transport,
    });
    return {
      ...counter,
      bitsPerSecond,
      rateUnavailableReason: bitsPerSecond === null
        ? clockRollback
          ? 'clock-rollback'
          : baseline === undefined
          ? 'initial-baseline'
          : baseline.transport !== counter.transport || counter.bytesReceived < baseline.bytesReceived
            ? 'receiver-discontinuity'
            : elapsedMilliseconds <= 0
              ? 'zero-elapsed'
              : 'receiver-discontinuity'
        : null,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const aggregateBitsPerSecond = invalidCounterCount > 0
    ? null
    : subscriptions.length === 0
    ? 0
    : subscriptions.length > 0 &&
    subscriptions.every((subscription) => subscription.bitsPerSecond !== null)
    ? subscriptions.reduce((total, subscription) => total + subscription.bitsPerSecond, 0)
    : null;

  state.samples.push({
    timestampMilliseconds: now,
    aggregateBitsPerSecond,
    aggregateRateUnavailableReason: aggregateBitsPerSecond === null
      ? invalidCounterCount > 0
        ? 'invalid-counter'
        : clockRollback
        ? 'clock-rollback'
        : subscriptions.find((subscription) => subscription.rateUnavailableReason)?.rateUnavailableReason || 'initial-baseline'
      : null,
    subscriptions,
  });
  const cutoff = now - THROUGHPUT_WINDOW_MS;
  state.samples = state.samples.filter((sample) => sample.timestampMilliseconds > cutoff);
  return {
    version: 1,
    accounting: 'physical-multicast-ingress',
    vantage: 'page-bridge',
    windowMilliseconds: THROUGHPUT_WINDOW_MS,
    minSampleIntervalMilliseconds: THROUGHPUT_SAMPLE_INTERVAL_MS,
    samples: state.samples.map(cloneThroughputSample),
  };
}

function sortedOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])
  );
}

function bridgeBytesSubscriptionKey(config, transportOpts, addresslessAtsc1) {
  const endpoint = addresslessAtsc1
    ? { origin: 'tuner', standard: 'atsc1', protocol: 'mpeg-ts' }
    : {
        source: config.source || '*',
        group: config.group,
        port: Number(config.port),
      };
  return JSON.stringify({
    endpoint,
    transportOpts: sortedOptions(transportOpts),
  });
}

function getBridgeBytesSubscriptions(bridgeClient) {
  if (!bridgeClient[BRIDGE_BYTES_SUBSCRIPTIONS]) {
    Object.defineProperty(bridgeClient, BRIDGE_BYTES_SUBSCRIPTIONS, {
      value: new Map(),
      enumerable: false,
    });
  }
  return bridgeClient[BRIDGE_BYTES_SUBSCRIPTIONS];
}

function invalidateBridgeBytesSubscriptions(bridgeClient) {
  const sharedSubscriptions = bridgeClient[BRIDGE_BYTES_SUBSCRIPTIONS];
  if (!sharedSubscriptions) return;

  for (const shared of sharedSubscriptions.values()) {
    retireSharedThroughputReceiver(shared);
    for (const ref of [...shared.refs]) {
      if (ref.state !== 'closed') ref.dispatchState('closed');
    }
  }
  sharedSubscriptions.clear();
}

/**
 * Page-side `window.multicast.subscribe({..., consume: 'bytes'})`.
 *
 * Consumers with different packet filters share one receiver and can use
 * setPacketIds() in place. If the last consumer releases before the next joins
 * (the same synchronous step is fine), the new join waits for that teardown.
 */
export async function subscribeMulticastBridgeBytes(bridgeClient, config) {
  if (!config || typeof config !== 'object') {
    throw makeMulticastError('subscription-failed', 'subscribe() expects { group, port, consume: "bytes" }.');
  }
  // `!== undefined` is load-bearing: `consume` is a REQUIRED SubscribeConfig
  // field, so omitting it (or passing an array, whose `.consume` is undefined)
  // is a malformed request and keeps `subscription-failed` below. See the
  // RULING next to MulticastErrorCode (BLO-33765).
  if (config.consume !== undefined && config.consume !== 'bytes') {
    throw makeMulticastError('capability-unsupported', `Unsupported consume mode: ${String(config.consume)}`);
  }
  if (config.consume === undefined) {
    throw makeMulticastError('subscription-failed', 'subscribe() expects { group, port, consume: "bytes" }.');
  }
  const addresslessAtsc1 = isAddresslessAtsc1MpegTs(config);
  if (addresslessAtsc1 &&
      (config.group !== undefined || config.port !== undefined || config.source !== undefined)) {
    throw makeMulticastError(
      'subscription-failed',
      'ATSC 1.0 MPEG-TS is addressless; group, port, and source must be omitted.'
    );
  }
  if (!addresslessAtsc1 && (!config.group || !Number.isFinite(Number(config.port)))) {
    throw makeMulticastError('subscription-failed', 'subscribe() requires group and numeric port.');
  }

  const transportOpts = multicastBridgeTransportOptionsFromConfig(config);
  // Consumers of one endpoint share a receiver whatever their packet-ID lists:
  // the receiver forwards their union and each consumer is delivered only its
  // own list (reconcileSharedPacketIds). Keying on the list gave each list its
  // own logical receiver, which the bridge server then collapsed onto the
  // first list's filter.
  const { packetIds: requestedPacketIds, ...sharedTransportOpts } = transportOpts;
  const requestKey = bridgeBytesSubscriptionKey(config, sharedTransportOpts, addresslessAtsc1);
  const sharedSubscriptions = getBridgeBytesSubscriptions(bridgeClient);
  let shared;
  while (true) {
    shared = sharedSubscriptions.get(requestKey);
    if (!shared) {
      const createdShared = {
        nativeSubscription: null,
        refs: new Set(),
        ready: null,
        teardown: null,
        latestState: 'connecting',
        latestTransport: undefined,
        throughputEligible: config.origin !== 'tuner',
        throughputActive: false,
        throughputReceiverId: undefined,
        throughputBytesReceived: 0,
        // The list this receiver last requested of the bridge.
        packetIds: requestedPacketIds,
        packetIdChain: Promise.resolve(),
        // False for a payload that is not MMTP: its consumers are never
        // packet-ID filtered and cannot replace a packet-ID list.
        packetIdsApply: !addresslessAtsc1,
      };
      shared = createdShared;
      sharedSubscriptions.set(requestKey, createdShared);
      createdShared.ready = bridgeClient.subscribe(
        config.group,
        config.port === undefined ? undefined : Number(config.port),
        config.source,
        transportOpts
      ).then((result) => {
        createdShared.nativeSubscription = result;
        createdShared.latestTransport = normalizeResolvedMulticastTransport(result.transport);
        activateSharedThroughputReceiver(bridgeClient, createdShared);
        const deliverPackets = (events) => {
          if (events.length === 0) return;
          createdShared.latestState = 'connected';
          activateSharedThroughputReceiver(bridgeClient, createdShared);
          // One detail per packet, shared by every logical consumer of this
          // physical receiver (they already share the payload ArrayBuffer).
          const details = new Array(events.length);
          let bytes = 0;
          for (let i = 0; i < events.length; i++) {
            bytes += packetByteLength(events[i]);
            details[i] = bytesEventDetail(events[i]);
          }
          createdShared.throughputBytesReceived += bytes;
          Object.freeze(details);
          for (const ref of [...createdShared.refs]) {
            if (ref.state === 'closed') continue;
            ref.dispatchState('connected');
            const admitted = packetsAdmittedBy(ref.packetIdFilter, details, events);
            if (admitted.length === 0) continue;
            ref.deliverPackets(admitted === details ? details : Object.freeze(admitted));
          }
        };
        result.setCallbacks({
          onpackets: deliverPackets,
          onpacket(event) {
            deliverPackets([event]);
          },
          onerror(error) {
            for (const ref of [...createdShared.refs]) {
              if (ref.state === 'closed') continue;
              const err = makeMulticastError(
                error?.code || 'subscription-failed',
                error?.message || 'Bridge subscription failed',
                error
              );
              ref.target.dispatchEvent(new CustomEvent('error', { detail: err }));
            }
          },
          ontransportstate(next) {
            createdShared.latestState = next;
            if (next === 'connected') activateSharedThroughputReceiver(bridgeClient, createdShared);
            for (const ref of [...createdShared.refs]) {
              if (ref.state !== 'closed') ref.dispatchState(next);
            }
          },
          ontransportchange(next) {
            const transport = normalizeResolvedMulticastTransport(next);
            if (!transport || createdShared.latestTransport === transport) return;
            createdShared.latestTransport = transport;
            for (const ref of [...createdShared.refs]) {
              if (ref.state !== 'closed') ref.dispatchTransport(transport);
            }
          },
        });
        return createdShared;
      }).catch((error) => {
        if (sharedSubscriptions.get(requestKey) === createdShared) {
          sharedSubscriptions.delete(requestKey);
        }
        throw error;
      });
    }

    if (shared.teardown) {
      // A packet-ID switch has no live refs on the retiring receiver. Replace
      // it in the registry immediately so the new physical subscription can
      // enter BridgeClient.subscribe(); that layer tracks the same-endpoint
      // teardown and keeps the successor alive across a lost session. Waiting
      // here leaves `_heldSubscriptions` at zero and makes disconnect discard
      // the only successor demand.
      if (shared.refs.size === 0) {
        if (sharedSubscriptions.get(requestKey) === shared) {
          sharedSubscriptions.delete(requestKey);
        }
        continue;
      }
      try {
        await shared.teardown;
      } catch {
        // The final logical ref is restored on failure; retry acquisition
        // against the still-live shared subscription.
      }
      continue;
    }

    await shared.ready;
    if (shared.nativeSubscription?.active === false) {
      if (sharedSubscriptions.get(requestKey) === shared) {
        sharedSubscriptions.delete(requestKey);
      }
      continue;
    }
    if (sharedSubscriptions.get(requestKey) === shared && !shared.teardown) break;
  }

  const target = new EventTarget();
  let state = 'connecting';
  let unsubscribePromise = null;
  // Which packet surfaces this consumer asked for. Sticky: a consumer that
  // only listens to `packets` never pays for a per-packet `bytes` event, and
  // one that only listens to `bytes` never pays for a batch array event. An
  // event with no listener was never observable, so skipping it drops
  // nothing a listener could have received.
  let bytesRequested = false;
  let packetsRequested = false;

  const dispatchState = (next) => {
    if (state === next) return;
    state = next;
    target.dispatchEvent(new CustomEvent('state', { detail: next }));
  };
  const dispatchTransport = (next) => {
    target.dispatchEvent(new CustomEvent('transportchange', { detail: next }));
  };
  const deliverPackets = (details) => {
    if (packetsRequested) {
      target.dispatchEvent(new CustomEvent('packets', { detail: details }));
    }
    if (!bytesRequested) return;
    for (const detail of details) {
      // A bytes listener may unsubscribe mid-batch; nothing after that.
      if (state === 'closed') return;
      target.dispatchEvent(new CustomEvent('bytes', { detail }));
    }
  };

  const sub = {
    get id() { return shared.nativeSubscription?.subscriptionId || ''; },
    get state() { return state; },
    get transport() { return shared.latestTransport; },
    // Preserve the underlying bridge's physical-filter capability bit. It is
    // intentionally optional: extension/native providers may not expose it.
    get packetIdsMutable() { return shared.nativeSubscription?.packetIdsMutable; },
    /**
     * How packets reach the page, as the bridge server declared it
     * (`'ordered-relay'` | `'datagram'`), or undefined when it made no
     * ordering promise. See normalizeMulticastDelivery.
     */
    get delivery() { return shared.nativeSubscription?.delivery; },
    /**
     * Events this subscription emits. `packets` is a provider extension, not
     * part of the frozen v1 contract: feature-detect it here before relying on
     * it, and listen to `bytes` otherwise.
     */
    get eventTypes() { return BYTES_SUBSCRIPTION_EVENT_TYPES; },
    addEventListener(type, listener, listenerOptions) {
      if (type === 'bytes') bytesRequested = true;
      else if (type === 'packets') packetsRequested = true;
      target.addEventListener(type, listener, listenerOptions);
    },
    removeEventListener(type, listener, listenerOptions) {
      target.removeEventListener(type, listener, listenerOptions);
    },
    /**
     * Replace this consumer's packet-ID filter without rejoining (frozen v1
     * contract). Consumers sharing the receiver keep theirs. Resolves with
     * the applied receiver list when the bridge reports it; older providers
     * resolve with undefined; a list that never reached the bridge (no live
     * subscription record, as during a preserved-subscription reconnect)
     * resolves with null, and the receiver's filter is unchanged. Rejects with
     * `capability-unsupported` on an addressless ATSC 1.0 tuner receiver
     * (MPEG-TS), and for a list adding a packet ID this consumer was not
     * already asking for that its receiver neither forwards nor can be made
     * to forward.
     */
    async setPacketIds(packetIds) {
      const normalized = normalizeSetPacketIds(packetIds);
      // Changed inside the receiver's serialized step: an overlapping call
      // cannot have its applied list rolled back by an earlier failure.
      return serializeSharedPacketIdChange(shared, async () => {
        if (state === 'closed' || !shared.refs.has(ref)) {
          throw makeMulticastError('subscription-failed', 'Subscription is closed');
        }
        if (!shared.packetIdsApply) throw mpegTsPacketIdRefusal('This subscription');
        const previous = ref.packetIds;
        // A narrowing asks for no packet this consumer was not already asking
        // for, so its own filter satisfies it even on a receiver that cannot
        // replace the bridge's filter.
        const narrowing = packetIdFilterCovers(packetIdFilter(previous), packetIdFilter(normalized));
        // Delivery follows the new list before the bridge does: a widening
        // must not drop the first packets the bridge forwards for it.
        setRefPacketIds(shared, ref, normalized.length > 0 ? normalized : undefined);
        try {
          return await reconcileSharedPacketIdsNow(shared, { requireCoverage: !narrowing });
        } catch (error) {
          setRefPacketIds(shared, ref, previous);
          throw error?.code ? error : makeMulticastError(
            'subscription-failed',
            error?.message || 'Bridge packet-ID filter update failed',
            error,
          );
        }
      });
    },
    unsubscribe() {
      if (state === 'closed') return Promise.resolve();
      if (unsubscribePromise) return unsubscribePromise;

      unsubscribePromise = (async () => {
        shared.refs.delete(ref);
        if (shared.refs.size > 0 || sharedSubscriptions.get(requestKey) !== shared) {
          dispatchState('closed');
          // The remaining consumers may need fewer packets.
          if (shared.refs.size > 0) narrowSharedPacketIds(shared);
          return;
        }

        // Started synchronously: a caller that releases this subscription and
        // subscribes a different key for the same endpoint in one step must
        // reach the bridge client's final unsubscribe
        // first, or the client cannot see it and hold the new join behind it.
        // The executor turns a synchronous throw into a rejection.
        const teardown = new Promise((resolve) => {
          resolve(typeof shared.nativeSubscription?.unsubscribe === 'function'
            ? shared.nativeSubscription.unsubscribe()
            : bridgeClient.unsubscribe(shared.nativeSubscription?.subscriptionId));
        });
        shared.teardown = teardown;
        try {
          await teardown;
        } catch (error) {
          const ownsSharedEntry = sharedSubscriptions.get(requestKey) === shared;
          if (ownsSharedEntry && shared.nativeSubscription?.active !== false) {
            shared.refs.add(ref);
          } else {
            // A disconnect or reconnect reset can suppress native rollback.
            // Do not restore a logical ref after its desired subscription is gone.
            if (ownsSharedEntry) sharedSubscriptions.delete(requestKey);
            dispatchState('closed');
          }
          throw error;
        } finally {
          if (shared.teardown === teardown) shared.teardown = null;
        }

        if (sharedSubscriptions.get(requestKey) === shared) {
          sharedSubscriptions.delete(requestKey);
        }
        retireSharedThroughputReceiver(shared);
        dispatchState('closed');
      })().finally(() => {
        unsubscribePromise = null;
      });
      return unsubscribePromise;
    },
  };

  const ref = {
    target,
    get state() { return state; },
    dispatchState,
    dispatchTransport,
    deliverPackets,
    /** This consumer's own list; undefined for every packet ID. */
    packetIds: undefined,
    /** Delivery filter: exactly `packetIds`, or null (see setRefPacketIds). */
    packetIdFilter: null,
  };
  // Filtered from its first packet, before the receiver widens for it.
  setRefPacketIds(shared, ref, requestedPacketIds);
  shared.refs.add(ref);
  dispatchState(shared.latestState || 'connecting');
  try {
    await reconcileSharedPacketIds(shared, { requireCoverage: false });
  } catch (error) {
    await sub.unsubscribe().catch(() => {});
    throw error;
  }

  return sub;
}

/**
 * Set a consumer's packet-ID list and, with it, its delivery filter: exactly
 * its own list, whatever the receiver currently forwards. The receiver's
 * filter is a union that any other consumer can widen (by joining, or with
 * setPacketIds), and the bridge applies a widening before it is acknowledged,
 * so a filter relaxed to "the receiver already filters for me" would deliver
 * another consumer's packets for that round trip. Filtering as tightly as the
 * consumer asked never withholds a packet it asked for. A payload that is not
 * MMTP has no packet IDs to read and is never filtered.
 */
function setRefPacketIds(shared, ref, packetIds) {
  ref.packetIds = packetIds;
  ref.packetIdFilter = shared.packetIdsApply ? packetIdFilter(packetIds) : null;
}

/**
 * Make a shared receiver forward the union of its consumers' packet-ID lists.
 * Serialized per receiver so updates reach the bridge in order. A bridge that
 * cannot replace its filter (`capability-unsupported`) is tolerated with
 * `requireCoverage: false`, as it was before setPacketIds, and with
 * `requireCoverage` too when the list the receiver last requested covers the
 * union: the receiver keeps its filter and consumers get what of theirs it
 * carries. Every other failure rejects.
 */
function reconcileSharedPacketIds(shared, options) {
  return serializeSharedPacketIdChange(shared, () => reconcileSharedPacketIdsNow(shared, options));
}

function serializeSharedPacketIdChange(shared, change) {
  const result = shared.packetIdChain.then(change, change);
  shared.packetIdChain = result.catch(() => {});
  return result;
}

async function reconcileSharedPacketIdsNow(shared, { requireCoverage = true } = {}) {
  // Nothing to filter by: the receiver forwards the stream whole.
  if (!shared.packetIdsApply) return;
  const union = packetIdFilterUnion([...shared.refs].map((ref) => ref.packetIds));
  const native = shared.nativeSubscription;
  if (samePacketIdFilter(packetIdFilter(shared.packetIds), union)) {
    return shared.packetIds ? [...shared.packetIds] : [];
  }
  const next = union ? [...union] : [];
  if (!union) warnIfPacketIdUnionOverCap([...shared.refs].map((ref) => ref.packetIds));
  try {
    if (native?.active === false) {
      throw makeMulticastError('subscription-failed', 'Bridge receiver is no longer active');
    }
    if (typeof native?.setPacketIds !== 'function') {
      throw makeMulticastError(
        'capability-unsupported',
        'This bridge receiver cannot replace its packet-ID filter',
      );
    }
    const applied = await native.setPacketIds(next);
    // null: the list never reached the bridge. The receiver keeps its previous
    // filter, so the shared record keeps it too and the next change re-sends.
    if (applied === null) return null;
    shared.packetIds = Array.isArray(applied) ? applied : (union ? next : undefined);
    return applied;
  } catch (error) {
    if (error?.code !== 'capability-unsupported') throw error;
    // A receiver that cannot replace its filter keeps the list it last
    // requested. Consumers filter on the page, so one that covers the union
    // serves every one of them: a narrowing, or a widening back within it.
    if (packetIdFilterCovers(packetIdFilter(shared.packetIds), union)) {
      return shared.packetIds ? [...shared.packetIds] : [];
    }
    if (requireCoverage) throw error;
    console.warn(`${TAG} ${error.message}`);
  }
}

function narrowSharedPacketIds(shared) {
  reconcileSharedPacketIds(shared, { requireCoverage: false }).catch((error) => {
    console.warn(`${TAG} Failed to narrow a shared packet-ID filter:`, error?.message || error);
  });
}

/** Return the real acquisition selector for a tuner broadcast standard. */
/**
 * The `window.multicast.capabilities()` contract for a BCDS bridge surface.
 *
 * This is the one definition shared by every surface that fronts a BCDS
 * bridge client: the page bridge installed by initMulticastBridge() and the
 * Safari extension's page-bridge.js, which imports this module rather than
 * restating the object. Two copies drifted before (BLO-35597): the Safari copy
 * lacked `originContractVersion` and advertised `['ip-multicast', 'tuner']`, so
 * the Shaka MSF adapter refused every catalog-selected AMT leg. Since BLO-41252
 * split that refusal into three, the missing version is caught first and the
 * message reads "multicast origin contract version mismatch: IWA reports none,
 * this reader requires 1" — the bogus `origins` is never examined.
 *
 * The browser side is a thin BCDS client; the native bridge owns both the UDP
 * and the AMT packet sources (native-bcds-bridge selects AMT per subscribe from
 * `mode`/`amtRelay`). So both origins are available exactly when the session to
 * that bridge is up, and none are while it is down.
 *
 * `tuner` is absent from `origins` and `tuners` is not reported at all. The
 * bridge does front a tuner (createTunerAPI below: tuner_tune/tuner_status,
 * plus an addressless ATSC-1 subscribe), but whether one is attached and
 * delivering is knowable only by asking it — tuner.status() — and this builder
 * does no I/O. The contract spells that "unknown" as an absent `tuners`
 * (gateway.ts: empty array means NO tuner stack), so it stays absent. A
 * hardcoded `tuners: ['atsc1', 'atsc3']` used to sit here, claiming two
 * consumable OTA standards even while the session was down. Do not re-add it:
 * the IWA derives origins FROM tuners (multicast-gateway.ts lists 'tuner' iff
 * a standard is consumable), so a non-empty `tuners` here reads as a licence
 * to put 'tuner' back into `origins` — the second half of the BLO-35597 copy's
 * defect, and after BLO-41252 the one arm with a message of its own
 * ("multicast origin unsupported by IWA: amt"), reached only once the version
 * matches.
 *
 * `networkHint` is the caller's knowledge of where the bridge runs; it is
 * required rather than defaulted.
 */
export function multicastBridgeCapabilities(bridgeClient, { networkHint } = {}) {
  if (typeof networkHint !== 'string' || networkHint.length === 0) {
    throw new TypeError('multicastBridgeCapabilities requires a networkHint');
  }
  const connected = bridgeClient?.connected === true;
  return {
    iwaVersion: 'bridge-polyfill',
    originContractVersion: 1,
    consumeModes: ['bytes'],
    transports: {
      nativeMulticast: {
        confirmed: connected,
        lastPacketAt: undefined,
      },
      amt: { available: connected },
      moqRelay: { reachable: false },
      webTransportBridge: bridgeClient?._transport === 'webtransport',
      networkHint,
      observedAt: Date.now(),
    },
    plugins: [],
    origins: connected ? ['ip-multicast', 'amt'] : [],
  };
}

export function tunerEndpointForStandard(standard = 'atsc3') {
  return standard === 'atsc1' ? ATSC_TUNER_ENDPOINT : ATSC_LLS_ENDPOINT;
}

/**
 * ROOT-01 / BLO-22696: advance an instrumentation counter without ever
 * changing observable bridge behaviour.
 *
 * These counters exist to measure the compatibility surface, so they must
 * never become a new way for it to fail. A stats object can legitimately be
 * absent, partial, frozen, or expose throwing accessors — foreign providers,
 * older bridge revisions, and `Object.freeze` in tests all produce one. A bare
 * `++` throws on a frozen target (this module is strict mode) and writes `NaN`
 * when the key is missing, which would poison the very signal being collected.
 *
 * Only a counter that is already a finite number is advanced; anything else is
 * left untouched. That keeps the reader's contract coherent — a partial stats
 * object stays partial and is reported as UNOBSERVABLE rather than as a count.
 */
function bumpBridgeStat(stats, key) {
  try {
    if (!stats || typeof stats !== 'object') return;
    const current = stats[key];
    if (!Number.isFinite(current)) return;
    stats[key] = current + 1;
  } catch {
    // Frozen target or throwing setter: instrumentation stays invisible.
  }
}

/** Build the tuner facade exposed as `window.multicast.tuner`. */
export function createTunerAPI(bridgeClient) {
  const subscribeTunerBytes = (options = {}) => {
    // ROOT-01 / BLO-22696: record explicit vs defaulted BEFORE the default is
    // applied — this is the last point at which the two are distinguishable.
    // `?? 'atsc3'` treats null and undefined alike, so "explicit" is exactly
    // `standard != null`. Never allowed to throw: a missing or partial
    // bridgeClient must leave tuner behaviour unchanged.
    const standardWasExplicit = options?.standard != null;
    bumpBridgeStat(
      bridgeClient?._debugStats,
      standardWasExplicit ? 'bridgeAtscStandardExplicit' : 'bridgeAtscStandardDefaulted',
    );
    const standard = options?.standard ?? 'atsc3';
    const endpoint = tunerEndpointForStandard(standard);
    return subscribeMulticastBridgeBytes(bridgeClient, {
      ...endpoint,
      ...(options && typeof options === 'object' ? options : {}),
      consume: 'bytes',
      origin: 'tuner',
      standard,
      ...(standard === 'atsc1' ? { protocol: 'mpeg-ts' } : {}),
    });
  };

  return {
    // Backward-compatible default: subscribe()/subscribeBytes() tune ATSC 3
    // unless a caller explicitly selects ATSC 1. Never use this field as the
    // ATSC 1 selector; use atsc1Endpoint or endpointForStandard('atsc1').
    endpoint: ATSC_LLS_ENDPOINT,
    atsc1Endpoint: ATSC_TUNER_ENDPOINT,
    atsc3Endpoint: ATSC_LLS_ENDPOINT,
    llsEndpoint: ATSC_LLS_ENDPOINT,
    endpointForStandard: tunerEndpointForStandard,
    status: (options) => bridgeClient.tunerStatus(options),
    tune: (options) => bridgeClient.tunerTune(options),
    setPlp: (options) => bridgeClient.tunerSetPlp(options),
    subscribe: subscribeTunerBytes,
    subscribeBytes: subscribeTunerBytes,
  };
}

function normalizeBridgeHealth(host, httpPort, health, discoveryMethod) {
  if (!isBcdsBridgeCapability(health)) return null;
  const normalizedHost = normalizeBridgeHost(host);
  if (!normalizedHost) return null;
  const rawFingerprint = hasOwn(health, 'fingerprint') ? health.fingerprint : '';
  const rawGatewayDomain = health.gatewayDomain == null ? '' : String(health.gatewayDomain);
  const gatewayDomain = rawGatewayDomain ? normalizeGatewayDomain(rawGatewayDomain) : '';
  if (rawGatewayDomain && !gatewayDomain) return null;
  // A gateway domain on a raw IPv4/IPv6 health endpoint only tells us how a
  // later AutoTLS candidate may be derived; it does not make this endpoint's
  // self-signed certificate CA-authenticated. Only DNS hosts can omit the pin
  // at this stage. In particular, an IPv6 literal must retain its pin because
  // the IP-in-hostname convention is IPv4-only.
  const isAutoTls = isAutoTlsGatewayDomain(gatewayDomain) &&
    !isValidIpv4Literal(normalizedHost) && !isValidIpv6Literal(normalizedHost);
  // CA-authenticated AutoTLS hosts are the only bridge shape that may omit a
  // certificate pin. Loopback/LAN and domain-less health responses must carry
  // a complete SHA-256 pin before they can be promoted into WebTransport.
  const fingerprint = typeof rawFingerprint === 'string' && rawFingerprint.trim() === ''
    ? (isAutoTls ? '' : null)
    : normalizeFingerprint(rawFingerprint);
  if (fingerprint === null) return null;
  const localAddress = health.localAddress
    ? normalizeBridgeHost(String(health.localAddress)) || ''
    : '';
  const bridgeHttpPort = healthPort(health, 'httpPort', httpPort);
  const wtPort = healthPort(health, 'wtPort', undefined);
  if (!isValidPort(bridgeHttpPort) || !isValidPort(wtPort)) return null;

  if (gatewayDomain && localAddress) {
    saveGateway(gatewayDomain, localAddress, fingerprint);
  }

  return {
    host: normalizedHost,
    fingerprint,
    httpPort: bridgeHttpPort,
    wtPort,
    wtRunning: health.wtRunning !== false,
    gatewayDomain,
    localAddress,
    discoveryMethod,
    bridgeProtocol: BCDS_BRIDGE_PROTOCOL,
    webTransportBridge: true,
  };
}

async function tryBridgeHealth(host, httpPort, discoveryMethod = 'health', timeoutMs = 2000) {
  const base = bridgeHttpUrl(bridgeProto(host), host, httpPort);
  if (!base) return null;
  try {
    const resp = await fetch(`${base}/health`, bridgeFetchOptions(host, timeoutMs));
    if (!resp.ok) return null;
    const health = await resp.json();
    const bridge = normalizeBridgeHealth(host, httpPort, health, discoveryMethod);
    if (bridge) {
      console.log(`${TAG} Bridge health via ${base}/health` +
        (bridge.gatewayDomain && bridge.localAddress ? ` (AutoTLS ${bridge.localAddress} / ${bridge.gatewayDomain})` : ''));
    }
    return bridge;
  } catch {
    return null;
  }
}

export async function tryDesktopLanDiscovery(httpPort, options = {}) {
  if (!canUseDesktopLanScan(options)) return null;

  const prefixes = (options.prefixes || desktopLanScanPrefixesFromInputs())
    .map(normalizeLanScanPrefix)
    .filter(Boolean);
  const uniquePrefixes = [...new Set(prefixes)];
  if (uniquePrefixes.length === 0) return null;

  const batchSize = options.batchSize || DESKTOP_LAN_SCAN_BATCH_SIZE;
  const timeoutMs = options.timeoutMs || DESKTOP_LAN_SCAN_PROBE_TIMEOUT_MS;
  const discoveryMethod = options.discoveryMethod || 'desktop-lan-scan';
  for (const prefix of uniquePrefixes) {
    const hosts = options.hosts || Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
    console.log(`${TAG} Scanning ${prefix}.1-254:${httpPort} for desktop Chrome bridge discovery...`);

    for (let start = 0; start < hosts.length; start += batchSize) {
      const batch = hosts.slice(start, start + batchSize);
      const results = await Promise.all(batch.map((host) =>
        tryBridgeHealth(host, httpPort, discoveryMethod, timeoutMs)
      ));
      const bridge = results.find(Boolean);
      if (bridge) {
        console.log(`${TAG} Bridge discovered via desktop LAN scan: ${bridge.host}:${bridge.httpPort}`);
        return bridge;
      }
    }
  }

  return null;
}

/**
 * Try AutoTLS HTTPS discovery via IP-in-hostname.
 * Supports: ?gw=192-168-1-181.gw-xxx.bcast.id (full), ?gw=gw-xxx.bcast.id (bare), or saved gateway.
 * Returns bridge info or null.
 */
async function tryAutoTlsDiscovery(httpPort) {
  if (typeof window === 'undefined') return null;
  const params = bridgeUrlParams();
  const gwParam = params.get('gw');
  const bridgeParam = params.get('mc_bridge');
  if (bridgeParam) return null; // mc_bridge takes precedence

  const gwHosts = [];

  if (gwParam) {
    if (/^\d{1,3}-/.test(gwParam)) {
      // Full IP-in-hostname: 192-168-1-181.gw-xxx.bcast.id — try directly,
      // after checking the domain part carries a gateway label (a dashed
      // name directly under the apex can never resolve).
      const gwParamDomain = gwParam.replace(/^[^.]+\./, '');
      const cleanDomain = normalizeGatewayDomain(gwParamDomain);
      const ipLabel = gwParam.slice(0, gwParam.indexOf('.'));
      if (cleanDomain && isAutoTlsGatewayDomain(cleanDomain) &&
          /^\d+(?:-\d+){3}$/.test(ipLabel) &&
          isValidIpv4Literal(ipLabel.replace(/-/g, '.'))) {
        gwHosts.push(`${ipLabel}.${cleanDomain}`);
      } else {
        console.warn(`${TAG} Ignoring ?gw=${gwParam}: "${gwParamDomain}" has no gateway label (need gw-xxx.<apex>)`);
      }
    } else if (isAutoTlsGatewayDomain(normalizeGatewayDomain(gwParam) || '')) {
      // Bare domain: gw-xxx.bcast.id — construct IP-in-hostname from saved localAddress
      const saved = loadSavedGateway();
      if (saved?.localAddress) {
        const savedHost = ipInHostname(saved.localAddress, normalizeGatewayDomain(gwParam));
        if (savedHost) gwHosts.push(savedHost);
      }
    } else {
      console.warn(`${TAG} Ignoring ?gw=${gwParam}: no gateway label (need gw-xxx.<apex>)`);
    }
  }

  // Also try saved gateway (bootstrap HTTPS pages from previous ?gw= session).
  // loadSavedGateway evicts poisoned entries, but `.local` domains are
  // storable and must never become AutoTLS candidates.
  const saved = loadSavedGateway();
  if (saved?.localAddress && isAutoTlsGatewayDomain(saved?.gatewayDomain)) {
    const savedHost = ipInHostname(saved.localAddress, saved.gatewayDomain);
    if (savedHost && !gwHosts.includes(savedHost)) gwHosts.push(savedHost);
  }

  // Bootstrap: when ?gw= is bare domain with no saved localAddress, probe the
  // HTTP bootstrap endpoints to discover the bridge's LAN IP from /health.
  if (gwHosts.length === 0 && gwParam) {
    for (const host of BRIDGE_HOST_CANDIDATES) {
      if (!canProbeBridgeHost(host)) continue;

      const bridge = await tryBridgeHealth(host, httpPort, 'bootstrap-health', 2000);
      const domain = normalizeGatewayDomain(bridge?.gatewayDomain || gwParam);
      if (bridge?.localAddress && domain && isAutoTlsGatewayDomain(domain)) {
        console.log(`${TAG} Bootstrap: discovered localAddress=${bridge.localAddress} via ${host}`);
        saveGateway(domain, bridge.localAddress, bridge.fingerprint);
        const bridgeHost = ipInHostname(bridge.localAddress, domain);
        if (bridgeHost) gwHosts.push(bridgeHost);
        break;
      }
    }
  }

  for (const gwHost of gwHosts) {
    try {
      console.log(`${TAG} Trying AutoTLS: https://${gwHost}:${httpPort}/health`);
      const base = bridgeHttpUrl('https', gwHost, httpPort);
      if (!base) continue;
      // IP-in-hostname resolves to a LAN address. Name it with the one
      // spelling that means the LAN in every measured Chromium release
      // ("local" means loopback through M138, so it declared the wrong space
      // there), and only where the running enum still defines it.
      const lanSpace = definedTargetAddressSpace(LAN_TARGET_ADDRESS_SPACE);
      const resp = await fetch(`${base}/health`, {
        ...bridgeFetchOptions(gwHost, 3000),
        ...(lanSpace ? { targetAddressSpace: lanSpace } : {}),
      });
      if (resp.ok) {
        const health = await resp.json();
        if (!isBcdsBridgeCapability(health)) continue;
        const domain = normalizeGatewayDomain(health.gatewayDomain || gwHost.replace(/^[^.]+\./, ''));
        const localAddr = normalizeBridgeHost(health.localAddress || '') || '';
        if (!domain || !isAutoTlsGatewayDomain(domain)) continue;
        const wtPort = parsePort(health.wtPort);
        const bridgeHttpPort = healthPort(health, 'httpPort', httpPort);
        if (wtPort === null || !isValidPort(wtPort) || !isValidPort(bridgeHttpPort)) continue;
        console.log(`${TAG} Bridge discovered via AutoTLS: ${gwHost}`);
        saveGateway(domain, localAddr, health.fingerprint);
        return {
          host: gwHost,
          fingerprint: '',
          httpPort: bridgeHttpPort,
          wtPort,
          gatewayDomain: domain,
          localAddress: localAddr,
          bridgeProtocol: BCDS_BRIDGE_PROTOCOL,
          webTransportBridge: true,
          discoveryMethod: 'autotls',
        };
      }
    } catch (err) {
      console.warn(`${TAG} AutoTLS ${gwHost} failed:`, err.message);
    }
  }
  return null;
}

/**
 * Read the bridge's published enrollment attestation, unverified.
 *
 * Behind the same origin-admission gate as /health: a page the bridge has not
 * admitted gets 403, and enrollment never relaxes that. A bridge predating
 * BLO-34022 404s. Both are "no enrollment", not an error.
 *
 * `unreachable` keeps those served denials distinct from never getting an
 * answer at all. Collapsing the two would let a transient blip stand in for a
 * disproof, and the re-pin path drops a cache entry on a disproof — so an
 * enrolled bridge would lose its entry to a blip that a bridge without
 * enrollment survives.
 *
 * @returns {Promise<{ attestation: object|null, unreachable: boolean }>}
 */
async function fetchBridgeEnrollment(bridge) {
  const base = bridgeHttpUrl(bridgeProto(bridge.host), bridge.host, bridge.httpPort);
  if (!base) return { attestation: null, unreachable: true };
  let resp;
  try {
    resp = await fetch(`${base}/enrollment`, bridgeFetchOptions(bridge.host, 2000));
  } catch {
    return { attestation: null, unreachable: true };
  }
  // Served, so this is an answer: a non-OK status, or a body that is not JSON,
  // both prove this bridge publishes no usable enrollment right now.
  if (!resp.ok) return { attestation: null, unreachable: false };
  try {
    return { attestation: await resp.json(), unreachable: false };
  } catch {
    return { attestation: null, unreachable: false };
  }
}

/**
 * Bind a freshly discovered bridge to the enrollment it signed for the
 * certificate we are about to pin. An absent, unverifiable, or
 * certificate-mismatched attestation leaves the bridge exactly as discovered:
 * enrollment buys survival across a rotation, it is not a precondition for
 * using a bridge at all.
 */
async function attachBridgeEnrollment(bridge) {
  // A descriptor whose `fingerprint` is a *list* is skipped rather than
  // enrolled — the persisted pairing (`[current, next]`) and the rendezvous
  // rung (every hash published for the winning endpoint) both have that shape.
  // The certificate check below is one attested hash against this field, so on
  // a list it can never hold and the fetch would be discarded on arrival.
  // Keying on the shape rather than on `fromPairing` is what makes that true of
  // both rungs: a hash list is exactly the condition the check cannot satisfy.
  // Skipping is not a lost capability: rotation survival on those rungs is
  // carried by the stored list plus the live `certificate_rotation` handler,
  // and `rotateCachedBridgePin` is gated on `fromCache`, which neither
  // descriptor is (both fail `isBcdsBridgeCapability`, so the discovery cache
  // rejects them). What the fetch does cost is the thing rung 0 exists to
  // avoid: on the stale record that rung is built to detect, an unreachable
  // host burns the full 2s `fetchBridgeEnrollment` timeout before `connect()`
  // is even called, so `connectAttempts: 1` does not bound it and `latencyMs`
  // bills it to discovery. On rendezvous the same 2s lands on a rung that
  // budgeted 1.5s for its own fetch, and against an `httpPort` the edge never
  // published — it serves `wtPort` only, so that port is the caller's default.
  if (!bridge?.fingerprint || Array.isArray(bridge.fingerprint)) return bridge;
  const { attestation } = await fetchBridgeEnrollment(bridge);
  const verified = await verifyBridgeEnrollment(attestation);
  // The attestation must cover the certificate we are actually pinning;
  // otherwise it binds this key to some other lifecycle's certificate.
  if (!verified || verified.fingerprint !== bridge.fingerprint) return bridge;
  return { ...bridge, enrollment: { bridgeId: verified.bridgeId, publicKey: verified.publicKey } };
}

/**
 * Use explicit pinned configuration directly; otherwise discover the bridge
 * via AutoTLS, then the allowlisted mDNS/loopback/LAN health endpoints.
 * @returns {{ host: string, fingerprint: string, httpPort: number, wtPort: number }} or null
 */
async function discoverBridge(httpPort, { pairingScope, rendezvousUrl } = {}) {
  const params = bridgeUrlParams();
  // A supplied pin is trusted configuration, not a discovery hint. Never
  // replace it using HTTP metadata, saved gateways, or CA-only authentication.
  if (params.has('mc_bridge') && (params.has('fingerprint') || params.has('fp'))) {
    try {
      const bridge = parseBridgeHostPort(params.get('mc_bridge'));
      const fingerprint = normalizeFingerprint(params.get('fingerprint') ?? params.get('fp'));
      const wtPort = parseExplicitPort(params.get('wt_port') ?? params.get('wtPort'), 'wt_port') ?? DEFAULT_WT_PORT;
      if (!bridge || !fingerprint) throw new Error('A valid mc_bridge and SHA-256 fingerprint are required');
      if (isSecurePage() && isLoopback(bridge.host)) {
        console.warn(`${TAG} Direct pinned loopback connection requires browser local-network permission; saved AutoTLS gateways are not substituted.`);
      }
      return {
        host: bridge.host,
        fingerprint,
        httpPort: bridge.port ?? httpPort,
        wtPort,
        discoveryMethod: 'pinned',
      };
    } catch (err) {
      console.warn(`${TAG} Rejecting malformed pinned bridge parameters:`, err.message);
      return null;
    }
  }

  // 0. Persisted pairing from an earlier pinned handoff. Costs no network I/O,
  //    so trying it ahead of the probing rungs is strictly cheaper than racing
  //    them; a stale record is dropped by the caller on connect failure.
  //    Remembered stays strictly below *supplied*: any explicit bridge
  //    parameter means the visitor is steering this load, and the drop path
  //    only fires when the pairing fails to connect — so while the old bridge
  //    still answers, an unpinned `?mc_bridge=`/`?gw=` would be ignored for the
  //    full TTL with nothing attributing it to the pairing.
  const steering = PINNED_PARAM_KEYS.some((key) => params.has(key));
  const paired = steering ? null : loadBridgePairing({ scope: pairingScope });
  if (paired) {
    console.log(`${TAG} Using persisted pairing: ${paired.host}:${paired.wtPort}`);
    return {
      host: paired.host,
      fingerprint: paired.hashes,
      httpPort: paired.httpPort ?? httpPort,
      wtPort: paired.wtPort,
      discoveryMethod: 'pairing',
      fromPairing: true,
    };
  }

  // 3. Rendezvous. Started *here* and awaited at the bottom so the HTTPS round
  //    trip overlaps rungs 1 and 2 rather than serialising behind them, while
  //    still deciding last. Deliberately below the pairing return above: a
  //    paired visit must cost no network I/O at all. Skipped while the visitor
  //    is steering this load with an explicit bridge parameter — rendezvous is
  //    the automatic path, and its candidates are never `explicitBridge`.
  //
  //    The cost of overlapping is that an unpaired load where rung 1 or 2 wins
  //    still sends the GET, giving the edge an address sighting it did not
  //    need. That is budgeted (BLO-34188 DPIA § 2: the request carries no
  //    cookie and no body, and the address is the one the edge already sees on
  //    any request). Aborting on a rung-1/2 win is deliberately *not* the
  //    remedy — by then the request has left the device, so the sighting has
  //    already happened and only the overlap would be lost. The remedy that
  //    works is the pairing return above, which makes the steady state after
  //    one successful discovery cost nothing.
  const rendezvous = steering ? null : startRendezvousLookup(rendezvousUrl, { scope: pairingScope });

  // 1. AutoTLS: try ?gw= param and/or saved gateway from localStorage.
  //    Bypasses Chrome PNA loopback block on HTTPS pages.
  const autoTls = await tryAutoTlsDiscovery(httpPort);
  if (autoTls) return autoTls;

  // 2. Build host list for mDNS/loopback discovery. Explicit ?mc_bridge must
  // win over localhost; otherwise a developer with a local bridge running can
  // silently connect to the wrong IWA while trying to verify a LAN bridge.
  // An explicit .local host with a pin was handled above without HTTP.
  const hosts = [];
  const explicitHosts = new Set();
  const explicitHttpPorts = new Map();
  let hasExplicitBridge = false;
  const addHost = (host) => {
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  if (typeof window !== 'undefined') {
    const bridgeParam = params.get('mc_bridge');
      const rawGwDomain = params.get('gw');
      const gwDomain = rawGwDomain ? normalizeGatewayDomain(rawGwDomain) : '';
    let pinnedWtPort = null;
    try {
      const rawWtPort = params.get('wt_port') ?? params.get('wtPort');
      pinnedWtPort = parseExplicitPort(rawWtPort, 'wt_port');
    } catch (err) {
      console.warn(`${TAG} Rejecting malformed explicit bridge parameters:`, err.message);
      return null;
    }

    if (bridgeParam) {
      hasExplicitBridge = true;
      // mc_bridge can be hostname, hostname:port, or IP
      const parsedBridge = parseBridgeHostPort(bridgeParam);
      if (!parsedBridge) {
        console.warn(`${TAG} Rejecting malformed mc_bridge=${bridgeParam}`);
        return null;
      }
      const h = parsedBridge.host;
      const p = parsedBridge.port;
      if (p !== null) explicitHttpPorts.set(h, p);
      // DNS hostnames (e.g., relay.gw-abc.bcast.id) use CA-signed certs.
      // No fingerprint fetch needed — browser does standard TLS validation.
      if (isDnsHostname(h)) {
        const wtPort = pinnedWtPort ?? p ?? DEFAULT_WT_PORT;
        console.log(`${TAG} DNS hostname detected: ${h}:${wtPort} — CA cert mode (no fingerprint)`);
        return { host: h, fingerprint: '', httpPort: p || httpPort, wtPort, discoveryMethod: 'dns' };
      }

      // IP + gateway domain → construct IP-in-hostname for direct WebTransport (skips HTTP discovery).
      // Usage: ?mc_bridge=192.168.1.181&gw=relay.gw-xxx.tenant.bcast.id
      // The LE wildcard cert covers *.gw-xxx.tenant.bcast.id, so TLS validates.
      if (gwDomain && isAutoTlsGatewayDomain(gwDomain) && isValidIpv4Literal(h)) {
        const ipHost = `${h.replace(/\./g, '-')}.${gwDomain}`;
        const wtPort = pinnedWtPort ?? p ?? DEFAULT_WT_PORT;
        console.log(`${TAG} IP + gateway domain: ${ipHost}:${wtPort} — CA cert mode`);
        return {
          host: ipHost, fingerprint: '', httpPort: p || httpPort, wtPort,
          gatewayDomain: gwDomain, discoveryMethod: 'ip-gateway',
        };
      }

      addHost(h);
      explicitHosts.add(h);
    }
    // If page is served from a .local hostname, try bridge there too
    if (window.location.hostname.endsWith('.local')) {
      addHost(window.location.hostname);
    }
  }
  if (!hasExplicitBridge) {
    for (const host of BRIDGE_HOST_CANDIDATES) addHost(host);
  }

  // Try /health first. This is the default bootstrap flow for public PIM apps:
  // http://multicast-bridge.local:33446/health advertises localAddress +
  // gatewayDomain, then WebTransport connects to the AutoTLS hostname.
  for (const host of hosts) {
    if (!canProbeBridgeHost(host, { explicitBridge: explicitHosts.has(host) })) continue;

    const probePort = explicitHttpPorts.get(host) || httpPort;
    const bridge = await tryBridgeHealth(host, probePort, 'health', 2000);
    if (bridge) return bridge;
  }

  // Desktop LAN scanning uses the same strict /health predicate and remains
  // part of automatic discovery, but it is no longer a rung of this ladder.
  // It probes 254 hosts per prefix with no early exit, so when nothing answers
  // it pays every probe to full timeout — 5.6s per /24, and 11.2s for the two
  // blind defaults a loopback-served page falls back to, in front of first
  // play on exactly the deployment where the bridge is most likely to be
  // loopback or mDNS anyway (BLO-43633). The controller runs it after `load`
  // and upgrades the transport when it lands; this ladder reports its miss now.
  // With the sweep gone, rendezvous (rung 3) is the last rung here; a deferred
  // sweep only adopts a LAN bridge when nothing else connected first.
  if (!hasExplicitBridge) {
    // `rendezvous` is non-null only on this branch — every explicit-bridge
    // param is a `PINNED_PARAM_KEYS` entry.
    if (rendezvous) {
      return await connectRendezvousCandidate(await rendezvous, { httpPort, pairingScope });
    }
    return null;
  }

  // Try discovery via fingerprint fetch. Loopback/.local use http://.
  // Chrome Private Network Access: private network fetches from public pages need targetAddressSpace.
  for (const host of hosts) {
    if (!canProbeBridgeHost(host, { explicitBridge: explicitHosts.has(host) })) continue;

    try {
      const probePort = explicitHttpPorts.get(host) || httpPort;
      const base = bridgeHttpUrl(bridgeProto(host), host, probePort);
      if (!base) continue;
      const fpResp = await fetch(
        `${base}/certificate.sha256`,
        bridgeFetchOptions(host, 2000),
      );
      if (!fpResp.ok) continue;

      const fingerprint = normalizeFingerprint(await fpResp.text());
      if (fingerprint === null) continue;

      // Explicit ?mc_bridge is still subject to the same capability check as
      // mDNS/loopback discovery. A certificate endpoint alone is not enough:
      // it could belong to an unrelated HTTPS service and must never be
      // promoted into a BCDS WebTransport candidate.
      let bridgeHttpPort = probePort;
      let wtPort = DEFAULT_WT_PORT;
      let gatewayDomain = '';
      let localAddress = '';
      try {
        // Fresh timeout — the fingerprint fetch may have consumed most of the original signal.
        const healthResp = await fetch(
          `${base}/health`,
          bridgeFetchOptions(host, 2000),
        );
        if (!healthResp.ok) continue;
        const health = await healthResp.json();
        const normalized = normalizeBridgeHealth(host, probePort, health, 'explicit-health');
        if (!normalized) continue;
        bridgeHttpPort = normalized.httpPort;
        wtPort = normalized.wtPort;
        gatewayDomain = normalized.gatewayDomain;
        localAddress = normalized.localAddress;
        // The pin fetched above must match the capability response as well;
        // do not silently trust a changed certificate between probes.
        if (normalized.fingerprint !== fingerprint) continue;
      } catch { continue; }

      return {
        host, fingerprint, httpPort: bridgeHttpPort, wtPort, gatewayDomain, localAddress,
        discoveryMethod: 'explicit-fingerprint',
      };
    } catch { /* expected when bridge not running */ }
  }

  return null;
}

/**
 * The subscription id a BCDS server derives from a subscribe frame. Both
 * servers key a session's subscriptions by endpoint alone; packet_ids and the
 * other transport options are not part of the id:
 * the IWA bridge's WebTransport server (`handleSubscribeRequest`) and the
 * native bridge's subscribe control path. Fields are read exactly as `_buildSubscribeMessage`
 * puts them on the wire.
 */
function bcdsServerSubscriptionId({ group, port, source, transportOpts }) {
  if (transportOpts?.origin === 'tuner' && transportOpts.standard === 'atsc1' &&
      transportOpts.protocol === 'mpeg-ts') {
    return 'tuner:atsc1:mpeg-ts';
  }
  return `${group}:${port}${source ? `@${source}` : ''}`;
}

/**
 * Core bridge client — manages the WebTransport (QUIC) connection,
 * control protocol, subscription lifecycle, and keepalive heartbeat.
 *
 * Control protocol (JSON):
 * - WebTransport: bidi stream with length-prefix framing for control,
 *   incoming uni streams for binary data
 *
 * WebTransport-only: there is no WebSocket media-transport fallback. If
 * WebTransport cannot connect, the client fails hard (BLO-8314 / BLO-9073).
 */
export class BridgeClient {
  constructor() {
    /** @type {'webtransport'|null} */
    this._transport = null;
    this._wt = null;
    this._wtStreamReader = null;
    this._wtDatagramReader = null;
    /** @type {WritableStreamDefaultWriter|null} bidi stream writer for WebTransport control */
    this._bidiWriter = null;
    /** @type {Array<{ frame?: Uint8Array, mediaProgress?: number, writeOutcome?: { resolve: Function, reject: Function } }>} */
    this._controlWriteQueue = [];
    /** @type {{ frame?: Uint8Array, mediaProgress?: number, writeOutcome?: { resolve: Function, reject: Function } }|null} */
    this._controlWriteInFlight = null;
    this._controlWritePumping = false;
    this._controlWriteGeneration = 0;
    /** @type {{ mediaProgress: number, hasDatagramProgress?: boolean, datagramProgress?: number, datagramVersion?: number, datagramSendWatermark?: number, datagramSequencedFrames?: number }|null} */
    this._queuedMediaProgress = null;
    // Latest-wins telemetry frames (keepalive, FEC diagnostics) still queued,
    // keyed by what they describe. See `_sendControl`.
    this._queuedTelemetry = new Map();
    this.connected = false;
    this._keepaliveTimer = null;
    this._subscriptionWatchdogTimer = null;
    this._lastSubscriptionProgressAt = 0;
    this._lastControlActivityAt = 0;

    /** @type {Map<string, { resolve: Function, reject: Function }>} */
    this.pendingRequests = new Map();
    /** @type {Map<string, { onpacket?: Function, onerror?: Function }>} */
    this.subscriptionCallbacks = new Map();
    /** @type {Set<string>} */
    this.activeSubscriptions = new Set();
    /** @type {Map<string, Set<{ subscriptionId?: string, group: string, port: number, source?: string, transportOpts: object, callbacks: { onpacket?: Function, onerror?: Function, ontransportstate?: Function } }>>} */
    this._desiredSubscriptions = new Map();
    /**
     * The packet-ID filter the server reports in force per subscription id,
     * and whether `set_packet_ids` can replace it. Server state: cleared with
     * the connection and re-recorded from each (replayed) subscribe response.
     * @type {Map<string, { known: boolean, mutable: boolean, packetIds: Set<number> | null, reportSeq?: number }>}
     */
    this._serverPacketIdFilters = new Map();
    /**
     * Arrival order of the control responses that report a packet-ID filter,
     * keyed by the resolved response (see packetIdReportSupersedes). The page
     * resumes a subscribe response's continuation sooner than a
     * set_packet_ids response's, so the order they are applied in is not the
     * order the server sent them.
     * @type {WeakMap<object, number>}
     */
    this._packetIdReportOrder = new WeakMap();
    this._packetIdReportSeq = 0;
    /**
     * Per endpoint (filter-chain key), the reconnect replay whose subscribe
     * response will record that endpoint's server filter, settled once it has
     * (or has given up). A filter change made meanwhile waits for it.
     * @type {Map<string, Promise<void>>}
     */
    this._packetIdReplays = new Map();
    /**
     * Per endpoint, the tail of its packet-ID filter changes, so set_packet_ids
     * writes for it reach the server in order. Keyed by endpoint, which
     * survives reconnect replay, rather than by server subscription id, which
     * replay can reassign between queuing a change and running it; and per
     * endpoint so a stuck request on one cannot hold back another's switch.
     * @type {Map<string, Promise<void>>}
     */
    this._packetIdFilterChains = new Map();
    /** @type {Set<Promise<string>>} Subscribe requests that have not installed their desired entry yet. */
    this._pendingSubscriptions = new Set();
    /**
     * Server unsubscribes not yet settled, keyed by `bcdsServerSubscriptionId`
     * so a subscribe can find the ones it would collide with before sending
     * anything. See `subscribe()` and `_trackServerTeardown()`.
     * @type {Map<string, Set<Promise<void>>>}
     */
    this._serverTeardowns = new Map();
    /**
     * Count of tracked server unsubscribes that have settled. A subscribe
     * records it when sent, so a teardown's replacement check can tell a join
     * ordered after that teardown from one that raced it.
     */
    this._serverTeardownsSettled = 0;
    /**
     * Joins held behind a same-id server teardown. They count as desired when
     * a lost session decides what to preserve; see `subscribe()`.
     */
    this._heldSubscriptions = 0;
    /** Advanced by every disconnect that drops all subscription state. */
    this._subscriptionEpoch = 0;
    this._pendingSubscriptionGeneration = 0;
    /** @type {Map<number, string>} Server-assigned WT stream index -> subscriptionId. */
    this._streamSubscriptions = new Map();
    /** @type {Set<string>} One diagnostic per stream index and metadata defect. */
    this._streamMetadataWarnings = new Set();
    /**
     * Last decoded receive-timestamp source per stream index. The source label
     * repeats on every metadata frame of a stream, so decoding it once per
     * change instead of once per packet keeps a TextDecoder call and a string
     * allocation off the per-packet path.
     * @type {Map<number, { bytes: Uint8Array, text: string }>}
     */
    this._streamMetadataSources = new Map();
    /**
     * Open packet dispatch batches (see _beginPacketBatch). While one is open,
     * decoded packets are queued per subscription callbacks object and handed
     * over together when the batch closes, which is the reader's own yield
     * point — never a timer.
     */
    this._packetBatchDepth = 0;
    /** @type {Map<object, object[]>} callbacks -> packet events of the open batch */
    this._packetBatch = new Map();
    /** @type {Map<number, { totalLength: number, chunkCount: number, chunks: Array<Uint8Array|undefined>, receivedCount: number, receivedBytes: number, expiresAt: number }>} */
    this._chunkMessages = new Map();
    /**
     * Server-assigned WT stream index -> pending-frame accumulator
     * ({ chunks: Uint8Array[], head: number, byteLength: number }; see
     * createDataStreamAccumulator). Registration writes a Uint8Array(0)
     * placeholder that the first append normalizes; byteLength always equals
     * buffered-but-unparsed bytes for the stats surface.
     * @type {Map<number, { chunks: Uint8Array[], head: number, byteLength: number, dispatchFrames: number } | Uint8Array>}
     */
    this._dataStreamBuffers = new Map();
    /** @type {Map<number, object>} Guards yielded drains against disconnect/replacement races. */
    this._dataStreamTokens = new Map();
    this._mediaProgressTimer = null;
    this._mediaProgressGeneration = 0;
    this._mediaFramesDelivered = 0;
    this._mediaFramesReported = 0;
    // Split from `_mediaFramesReported` on purpose. "Enqueued" gates the flush
    // (don't re-send what is already queued); "reported" is only advanced once
    // the write RESOLVES, so it means "the server actually has this". Gating on
    // the resolved counter would re-flush on every media frame while a write is
    // in flight; reporting on the enqueued one is what corrupted the baseline.
    this._mediaFramesEnqueued = 0;
    // Datagram receive ledger, reported to the bridge alongside media progress
    // so the bridge can reconcile "Quinn accepted" against "actually arrived".
    // Reset per connection (see _resetMediaProgress) because the bridge's
    // matching sent-counter is per QUIC connection; a counter surviving a
    // reconnect would exceed it and produce a nonsense negative loss.
    this._datagramFramesReceived = 0;
    this._datagramFramesReported = 0;
    this._datagramFramesEnqueued = 0;
    // Sequenced datagrams are the aligned diagnostic cohort. `rx` remains the
    // legacy all-datagram count for old service workers. The authoritative
    // accepted-send watermark arrives over the reliable control stream; after
    // a grace period, `sx` and `tx` report received and accepted frames through
    // that settled watermark respectively.
    this._datagramSequencedFramesReceived = 0;
    this._datagramSequenceEpoch = 0;
    this._datagramSendWatermark = 0;
    this._datagramSettledSendWatermark = 0;
    this._datagramSettledFramesReceived = 0;
    this._datagramPendingSequences = new Set();
    // Set once the pending set hits its cap. The aligned cohort is then frozen
    // rather than dropping sequences: discarding a pending sequence would
    // remove receive credit for a datagram that DID arrive, so a later
    // watermark jump would score it missing and fabricate loss. Freezing keeps
    // tx/sx at their last adjudicated values and leaves the excess as
    // service-worker-side `pendingFrames`, which is already excluded from the
    // rate — so the published rate stops advancing instead of going wrong.
    this._datagramPendingOverflowed = false;
    // Missing settled sequences are retained as compact inclusive ranges. A
    // datagram that arrives after the grace window removes itself from these
    // ranges and corrects the cumulative receive count while it remains inside
    // the bounded late-correction horizon. Older gaps become aggregate,
    // finalized loss and can no longer change the aligned sx counter.
    this._datagramMissingSequenceRanges = [];
    this._datagramFinalizedLossFrames = 0;
    this._datagramSettlementTarget = 0;
    this._datagramSettlementTimer = null;
    // Reader capability is announced once when a WT datagram reader opens.
    // Repeating telemetry is activated separately by an authoritative server
    // watermark so deployments with datagram media disabled do not heartbeat.
    this._datagramCapable = false;
    this._datagramAccountingActive = false;
    this._datagramHeartbeatTimer = null;
    this._datagramCapabilityTimer = null;
    // Bounded re-announcement attempts; see WT_DATAGRAM_CAPABILITY_MAX_RETRIES.
    this._datagramCapabilityRetries = 0;
    // Announcements confirmed on the wire. Distinguishes a server that heard
    // us and stayed silent from a control stream that died before the first
    // byte left, which the attempt counter alone cannot tell apart.
    this._datagramCapabilityAnnouncementsWritten = 0;
    this._debugStats = {
      wtUniStreams: 0,
      wtDataStreams: 0,
      wtDataStreamChunks: 0,
      wtDataStreamBytes: 0,
      wtDataStreamFrames: 0,
      wtDataStreamFrameBytes: 0,
      wtDataStreamYields: 0,
      wtDataStreamAbortedDrains: 0,
      wtDataStreamOversizedFrames: 0,
      wtDataStreamBufferResets: 0,
      wtDataStreamProtocolErrors: 0,
      wtMediaFramesDelivered: 0,
      wtMediaProgressMessagesSent: 0,
      wtLastMediaProgressAt: 0,
      wtDatagrams: 0,
      wtDatagramBytes: 0,
      wtDatagramSequencedFrames: 0,
      wtDatagramSequenceRollovers: 0,
      wtDatagramPendingOverflow: 0,
      wtDatagramCapabilityRetriesExhausted: 0,
      // Control frames whose write() actually resolved, and whether the writer
      // has since latched errored. wtControlMessagesSent counts frames handed
      // to the writer, which is not the same thing once it is dead.
      wtControlFramesWritten: 0,
      wtControlWriteDead: 0,
      // Rejections belonging to a superseded control-write generation or a
      // replaced writer. Non-zero means a reconnect raced a dying write.
      wtControlWriteStaleRejections: 0,
      wtDatagramMissingRangesPeak: 0,
      wtDatagramMissingLookupStepsMax: 0,
      // A BCDG prefix that failed envelope validation. Passed through as
      // legacy rather than dropped, so this is a collision/skew signal, not
      // loss.
      wtDatagramEnvelopeMismatches: 0,
      wtDatagramReadErrors: 0,
      wtTransportFrames: 0,
      wtTransportFrameBytes: 0,
      wtChunkFrames: 0,
      wtChunkedMessagesCompleted: 0,
      wtChunkDrops: 0,
      wtStreamMetadataDrops: 0,
      wtStreamIndexHits: 0,
      wtStreamIndexMisses: 0,
      wtPacketsDispatched: 0,
      wtPayloadBytes: 0,
      wtLastPacketAt: 0,
      wtControlMessagesSent: 0,
      wtControlMessagesCoalesced: 0,
      wtControlWriteErrors: 0,
      wtControlQueueDepthMax: 0,
      wtControlMessagesReceived: 0,
      wtLastControlSentAt: 0,
      wtLastControlAt: 0,
      wtLastFrameAt: 0,
      wtLastDatagramAt: 0,
      wtLastDataStreamFrameLen: 0,
      wtStaleSubscriptionReconnects: 0,
      wtSubscriptionWatchdogControlDeferrals: 0,
      wtLastSubscriptionWatchdogDeferralAt: 0,
      // Explicit/defaulted ATSC discriminator, recorded at tuner option
      // resolution. A caller that passes `standard` and a caller that relies on
      // the `?? 'atsc3'` backward-compatible default produce byte-identical
      // subscribe messages on the wire, so the distinction cannot be recovered
      // downstream and has to be captured here. Kept as a counter pair rather
      // than the single boolean named in the ROOT-01 census: a boolean is lossy
      // once a page makes more than one tuner call (one explicit call would mask
      // any number of defaulted ones, which is the exact direction of error that
      // would wrongly clear the gate).
      bridgeAtscStandardExplicit: 0,
      bridgeAtscStandardDefaulted: 0,
    };

    this._onDisconnect = null;
    this._unloadHandler = null;
    this._visibilityHandler = null;
    this._lastConnectArgs = null;
    this._reconnectTimer = null;
    this._reconnectPromise = null;
    this._reconnectAfterCurrent = false;
    this._reconnectAttempts = 0;
    this._manualDisconnect = false;
    this._lastTunerStatus = null;
    ensureBridgeThroughputState(this);
  }

  getStats() {
    return {
      ...this._debugStats,
      connected: this.connected,
      transport: this._transport,
      activeSubscriptions: [...this.activeSubscriptions],
      streamSubscriptions: [...this._streamSubscriptions].map(([streamIndex, subscriptionId]) => ({
        streamIndex,
        subscriptionId,
      })),
      pendingChunkMessages: this._chunkMessages.size,
      dataStreamBuffers: this._dataStreamBuffers.size,
      dataStreamBufferBytes: [...this._dataStreamBuffers.values()]
        .reduce((total, buffer) => total + buffer.byteLength, 0),
      pendingRequests: this.pendingRequests.size,
      lastTunerStatus: this._lastTunerStatus,
    };
  }

  getThroughputHistory(now = Date.now()) {
    return sampleBridgeThroughput(this, now);
  }

  /**
   * Connect to bridge over WebTransport (QUIC). Builds candidate hosts from
   * AutoTLS gateway / DNS host / fingerprint and tries each. Throws if none
   * connect — there is no WebSocket fallback (BLO-8314).
   */
  async connect(host, httpPort, { fingerprint, wtPort, gatewayDomain, localAddress, connectAttempts } = {}) {
    if (this.connected) return;
    // `fingerprint` accepts one hash or several (a persisted pairing carries
    // [current, next] so a rotation across page loads still authenticates).
    let hashes = [];
    if (fingerprint != null && fingerprint !== '') {
      hashes = normalizeHashes(fingerprint);
      if (hashes.length === 0) throw new Error('Invalid bridge SHA-256 fingerprint');
    }
    this._lastConnectArgs = {
      host,
      httpPort,
      options: { fingerprint: hashes.length ? hashes : fingerprint, wtPort, gatewayDomain, localAddress },
    };
    this._manualDisconnect = false;

    // Build WebTransport candidates in priority order:
    // 1. AutoTLS (IP-in-hostname + CA wildcard cert) — works on HTTPS pages, bypasses PNA
    // 2. DNS hostname (CA cert) — when host is already a routable DNS name
    // 3. Pinned cert — includes known .local hosts resolved by the platform
    const wtCandidates = [];
    if (gatewayDomain) {
      const gwHost = resolveBridgeWtHost(host, { gatewayDomain, localAddress });
      if (gwHost) {
        console.log(`${TAG} AutoTLS: ${host} → ${gwHost}`);
        wtCandidates.push({ host: gwHost, fp: '' });
      }
    }
    if (isDnsHostname(host) && hashes.length === 0) {
      wtCandidates.push({ host, fp: [] });
    }
    if (hashes.length > 0) {
      // IWA's localhost listener is IPv4-only (BLO-8548). Preserve explicit
      // IPv6 literals, including ::1, for native bridges that bind IPv6.
      const wtHost = host === 'localhost' ? '127.0.0.1' : host;
      wtCandidates.push({ host: wtHost, fp: hashes });
    }

    if (typeof WebTransport === 'undefined') {
      throw new Error('WebTransport unavailable in this browser — bridge requires WebTransport (no WebSocket fallback)');
    }
    if (wtCandidates.length === 0) {
      throw new Error('No WebTransport candidates (need a fingerprint, AutoTLS gateway, or DNS host)');
    }

    const effectiveWtPort = wtPort || DEFAULT_WT_PORT;
    // A dead pinned endpoint is QUIC to a closed UDP port, so every attempt
    // burns the full `WT_CONNECT_TIMEOUT` rather than failing fast. Callers
    // holding a cached guess (a persisted pairing) cap this at one attempt so
    // a stale record costs ~5s of cold-load dead time instead of ~16.5s
    // before rediscovery starts.
    const maxAttempts = Number.isInteger(connectAttempts) && connectAttempts > 0
      ? connectAttempts
      : WT_CANDIDATE_CONNECT_ATTEMPTS;
    let lastErr = null;
    for (const c of wtCandidates) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await this._connectWebTransport(c.host, effectiveWtPort, c.fp);
          this._setupLifecycleHandlers();
          return;
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          lastErr = err;
          console.warn(`${TAG} WebTransport to ${c.host} failed (attempt ${attempt}/${maxAttempts}):`, err.message);
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, WT_CANDIDATE_RETRY_DELAY_MS * attempt));
          }
        }
      }
    }

    // No WebSocket fallback — production is WebTransport-only. Fail hard so the
    // real WebTransport gap (BLO-9073) surfaces in CI instead of being masked
    // behind a non-prod WS transport. BLO-8314.
    throw new Error(`All WebTransport candidates failed${lastErr ? `: ${lastErr.message}` : ''}`);
  }

  // ── WebTransport connection ──

  async _connectWebTransport(host, port, fingerprint) {
    const url = hostUrl('https', host, port);
    if (!url) throw new Error('Invalid WebTransport bridge host or port');
    console.log(`${TAG} Connecting WebTransport to ${url}...`);

    // CA-signed cert (DNS hostname): standard TLS validation, no fingerprint needed.
    // Self-signed cert (localhost/IP): use serverCertificateHashes for pin-based auth.
    // The option is a list, so every known hash (current + next) is offered in a
    // single attempt rather than one connect per hash.
    const wtOptions = {};
    const hashes = normalizeHashes(fingerprint);
    if (hashes.length > 0) {
      wtOptions.serverCertificateHashes = hashes.map((fp) => ({
        algorithm: 'sha-256',
        value: hexToBytes(fp),
      }));
    }
    const wt = new WebTransport(url, wtOptions);
    this._wt = wt;

    // Race against timeout — a failing/incomplete WT handshake otherwise hangs
    // for Chrome's default QUIC timeout (~30s). Explicit timeout bounds the
    // attempt so connect() fails fast (there is no WS fallback to defer to).
    // NB: same-browser WT does reach the IWA QUIC server; the open wall is the
    // quinn-wasm WT-server HTTP/3 extended-CONNECT session (BLO-9073).
    try {
      await Promise.race([
        wt.ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('WebTransport connect timeout')), WT_CONNECT_TIMEOUT)
        ),
      ]);
    } catch (err) {
      if (this._wt === wt) this._wt = null;
      try { wt.close(); } catch (e) { console.warn(`${TAG} WT close error:`, e.message); }
      if (wt.closed) {
        await Promise.race([
          wt.closed.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, WT_FAILED_CLOSE_GRACE_MS)),
        ]);
      }
      throw err;
    }

    this._assertCurrentWebTransport(wt);

    this._transport = 'webtransport';
    this._resetMediaProgress();
    this.connected = true;
    console.log(`${TAG} WebTransport connected (QUIC)`);

    // Open bidi stream for the JSON control protocol
    await this._openBidiStream(wt);
    this._assertCurrentWebTransport(wt);

    // Handle connection close
    wt.closed
      .then(() => {
        if (this._wt === wt) this._handleDisconnect();
      })
      .catch(() => {
        if (this._wt === wt) this._handleDisconnect();
      });

    // The configured browser Origin authenticates this session at the native
    // bridge boundary. No per-use capability or handoff fragment is sent.
    // The native bridge requires hello to be the first control frame. Start
    // media readers only after the hello write is accepted: datagram reader
    // setup synchronously flushes capability/progress telemetry before its
    // first read, so starting it earlier could put media_progress ahead of
    // hello and make the server close an otherwise healthy session.
    try {
      await this._sendControlWithWriteAck({
        type: 'hello',
        client_type: 'bridge',
        page_url: location.href,
        page_title: document.title,
        user_agent: navigator.userAgent,
        subscriptions: [...this.activeSubscriptions],
      });
    } catch (error) {
      this._assertCurrentWebTransport(wt);
      throw error;
    }
    this._assertCurrentWebTransport(wt);

    // Read incoming unidirectional streams for binary data (packets)
    this._readIncomingStreams(wt);
    this._readIncomingDatagrams(wt);

    this._startKeepalive();
    this._markSubscriptionProgress();
    this._startSubscriptionWatchdog();
    await this._replayActiveSubscriptions(wt);
    this._assertCurrentWebTransport(wt);
    this._reconnectAttempts = 0;
  }

  _assertCurrentWebTransport(wt) {
    if (this._wt === wt) return;
    try { wt.close(); } catch (e) { console.warn(`${TAG} WT close error:`, e.message); }
    throw new DOMException('WebTransport connection superseded', 'AbortError');
  }

  /** Open a bidi stream for the control protocol (JSON messages with length-prefix framing) */
  async _openBidiStream(wt) {
    let bidi;
    try {
      bidi = await wt.createBidirectionalStream();
    } catch (error) {
      this._assertCurrentWebTransport(wt);
      throw error;
    }
    this._assertCurrentWebTransport(wt);
    this._resetControlWrites();
    this._bidiWriter = bidi.writable.getWriter();
    this._readBidiStream(bidi.readable.getReader(), wt);
    console.log(`${TAG} Bidi control stream opened`);
  }

  /** Read length-prefixed JSON control messages from the bidi stream */
  async _readBidiStream(reader, wt = null) {
    const ownsTransport = () => wt === null || this._wt === wt;
    const chunks = [];
    let totalLen = 0;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (!ownsTransport()) break;
        if (done) break;
        chunks.push(value);
        totalLen += value.byteLength;

        // Try to extract complete frames from accumulated chunks
        this._extractBidiFrames(chunks, totalLen);
        // Update totalLen after extraction may have consumed data
        totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
      }
    } catch (e) {
      if (this.connected) {
        console.warn(`${TAG} Bidi read error:`, e.message);
      }
    }
  }

  /** Extract complete [u32LE len][json] frames from chunk list, dispatch to handler */
  _extractBidiFrames(chunks) {
    while (true) {
      // Flatten enough to read the 4-byte header
      const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
      if (totalLen < 4) break;

      // Flatten all chunks into one buffer for frame parsing
      const flat = new Uint8Array(totalLen);
      let off = 0;
      for (const c of chunks) {
        flat.set(c, off);
        off += c.byteLength;
      }

      const frameLen = new DataView(flat.buffer).getUint32(0, true);
      if (frameLen > 1048576) {
        // Corrupt frame — clear and bail
        console.error(`${TAG} Corrupt bidi frame: claimed length ${frameLen} exceeds 1MB limit, dropping buffer`);
        chunks.length = 0;
        break;
      }
      if (totalLen < 4 + frameLen) break; // Incomplete frame

      // Extract JSON
      const json = new TextDecoder().decode(flat.subarray(4, 4 + frameLen));
      this._handleControlMessage(json);

      // Keep remainder
      chunks.length = 0;
      if (totalLen > 4 + frameLen) {
        chunks.push(flat.subarray(4 + frameLen));
      }
    }
  }

  /** Read incoming uni streams — quinn-wasm opens one per per-client send */
  async _readIncomingStreams(wt = this._wt) {
    if (!wt) return;
    this._assertCurrentWebTransport(wt);
    const reader = wt.incomingUnidirectionalStreams.getReader();
    this._wtStreamReader = reader;

    try {
      while (true) {
        const { value: stream, done } = await reader.read();
        if (this._wt !== wt) break;
        if (done) break;
        this._consumeUniStream(stream, wt);
      }
    } catch (e) {
      if (this.connected) {
        console.warn(`${TAG} Incoming streams error:`, e.message);
      }
    }
  }

  /** Read unreliable latest-media frames from the WT datagram channel. */
  async _readIncomingDatagrams(wt = this._wt) {
    if (!wt) return;
    this._assertCurrentWebTransport(wt);
    const readable = wt.datagrams?.readable;
    if (!readable) return;
    const reader = readable.getReader();
    const readerGeneration = this._mediaProgressGeneration;
    this._wtDatagramReader = reader;
    // Announce capability once when the reader becomes live. The server ignores
    // this announcement while datagram media is disabled; an authoritative
    // accepted-send watermark explicitly activates recurring telemetry.
    this._datagramCapable = true;
    if (this._datagramAccountingActive) {
      this._startDatagramProgressHeartbeat();
    } else {
      // The announcement below may be enqueued and then dropped by a control
      // write rejection; keep re-announcing until the server responds.
      this._startDatagramCapabilityRetry();
    }
    this._flushMediaProgress();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (this._wtDatagramReader !== reader ||
            this._mediaProgressGeneration !== readerGeneration) {
          break;
        }
        if (done) break;
        if (value === undefined || value === null) continue;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        this._debugStats.wtDatagrams++;
        this._debugStats.wtDatagramBytes += bytes.byteLength;
        this._debugStats.wtLastDatagramAt = Date.now();
        // The server can only be sequencing a connection whose capability it
        // learned from our announcement, so a confirmed-on-the-wire
        // announcement is the necessary precondition for an envelope to exist.
        // Before that, the payload space is entirely legacy and must not be
        // inspected for a magic prefix at all.
        //
        // The ordering this rests on is transport-level and worth stating: the
        // counter commits when `writer.write()` RESOLVES, while the server acts
        // on the bytes once they are TRANSMITTED. The gate is sound because of
        // WHICH WAY those differ — a chunk cannot reach the wire before the
        // sink accepts it, and acceptance is what settles the promise, so
        // resolution can only PRECEDE transmission, never follow it. That is
        // the direction the gate needs: this counter is set before the
        // announcement can reach the server, hence before any envelope the
        // server produces can arrive here. Leading costs only an early gate,
        // widening the legacy-collision window described above — and those do
        // surface, as `envelopeMismatch`. The unsound direction cannot happen:
        // a counter TRAILING transmission would let a real envelope land while
        // this still reads false, and the `!sequencingPossible` path returns
        // the whole buffer — BCDG header included — into the media path with no
        // mismatch flag, i.e. silent corruption.
        // (The stalled-sink note in `_drainControlWrites` is a different lag —
        // the counter trailing the write ATTEMPT, which is why it must never
        // gate a retry loop. Nothing is transmitted in that case either.)
        const deliveryFrame = unwrapDatagramDeliveryFrame(
          bytes, this._datagramCapabilityAnnouncementsWritten > 0,
        );
        if (deliveryFrame.envelopeMismatch) {
          this._debugStats.wtDatagramEnvelopeMismatches++;
        }
        // Counted before parsing: this is "arrived at the reader", which is the
        // quantity the bridge reconciles against "Quinn accepted it".
        this._noteDatagramFrameReceived(deliveryFrame.sequence);
        this._handleTransportFrame(deliveryFrame.payload);
      }
    } catch (e) {
      if (this.connected) {
        this._debugStats.wtDatagramReadErrors++;
        console.warn(`${TAG} Datagram read error:`, e.message);
      }
    } finally {
      if (this._wtDatagramReader === reader) {
        if (this._mediaProgressGeneration === readerGeneration &&
            (this._mediaFramesDelivered > this._mediaFramesEnqueued ||
             this._datagramFramesReceived > this._datagramFramesEnqueued)) {
          this._flushMediaProgress();
        }
        this._wtDatagramReader = null;
        this._datagramCapable = false;
        this._stopDatagramProgressHeartbeat();
        this._stopDatagramCapabilityRetry();
      }
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  /**
   * Consume one persistent BCDS WebTransport unidirectional stream.
   *
   * Every server media stream starts with the eight-byte BCDS header. A stream
   * that does not present that header is a protocol error and is discarded;
   * there is deliberately no raw/one-shot or subscription-ID interpretation.
   */
  async _consumeUniStream(stream, wt = null) {
    const ownsTransport = () => wt === null || this._wt === wt;
    this._debugStats.wtUniStreams++;
    const reader = stream.getReader();
    let prefix = new Uint8Array(0);
    let dataStreamIndex = null;
    let dataStreamToken = null;
    let mode = 'header';
    let protocolError = false;
    let truncatedDataStream = false;

    try {
      while (true) {
        let { value, done } = await reader.read();
        if (!ownsTransport()) break;
        if (done) break;
        value = normalizeDataStreamChunk(value);
        if (!value) {
          protocolError = true;
          mode = 'invalid-data-stream';
          this._noteDataStreamProtocolError(
            'invalid WebTransport data-stream chunk; expected a byte buffer',
          );
          try { await reader.cancel(); } catch { /* ignore reset races */ }
          break;
        }

        if (mode === 'data-stream') {
          if (!await this._appendDataStreamBytes(
              dataStreamIndex, value, dataStreamToken, wt)) {
            mode = 'invalid-data-stream';
          }
          continue;
        }
        if (mode === 'invalid-data-stream') continue;

        const nextPrefix = new Uint8Array(prefix.byteLength + value.byteLength);
        nextPrefix.set(prefix, 0);
        nextPrefix.set(value, prefix.byteLength);
        prefix = nextPrefix;
        if (prefix.byteLength < WT_DATA_STREAM_HEADER_BYTES) continue;

        const dataStreamHeader = this._parseDataStreamHeader(prefix);
        if (dataStreamHeader?.error || !dataStreamHeader) {
          protocolError = true;
          mode = 'invalid-data-stream';
          this._noteDataStreamProtocolError(
            dataStreamHeader?.error || 'invalid BCDS packet-stream header',
          );
          // Resetting the reader promptly bounds work for an untrusted stream;
          // the finally block still releases all local state.
          try { await reader.cancel(); } catch { /* ignore reset races */ }
          break;
        }

        mode = 'data-stream';
        dataStreamIndex = dataStreamHeader.streamIndex;
        dataStreamToken = {};
        this._debugStats.wtDataStreams++;
        this._debugStats.wtLastDataStreamIndex = dataStreamHeader.streamIndex;
        this._dataStreamBuffers.set(dataStreamIndex, new Uint8Array(0));
        this._dataStreamTokens.set(dataStreamIndex, dataStreamToken);
        const rest = prefix.subarray(WT_DATA_STREAM_HEADER_BYTES);
        prefix = new Uint8Array(0);
        if (rest.byteLength > 0 &&
            !await this._appendDataStreamBytes(
                dataStreamIndex, rest, dataStreamToken, wt)) {
          mode = 'invalid-data-stream';
          protocolError = true;
        }
      }
    } catch (e) {
      if (this.connected) console.warn(`${TAG} Uni stream read error:`, e.message);
    } finally {
      if (mode === 'data-stream' && dataStreamIndex !== null) {
        truncatedDataStream = (this._dataStreamBuffers.get(dataStreamIndex)?.byteLength || 0) > 0;
      }
      if (dataStreamIndex !== null &&
          this._dataStreamTokens.get(dataStreamIndex) === dataStreamToken) {
        this._dataStreamBuffers.delete(dataStreamIndex);
        this._dataStreamTokens.delete(dataStreamIndex);
      }
      try { reader.releaseLock(); } catch { /* ignore release races */ }
    }

    if (!ownsTransport()) return;
    if (mode === 'header' && !protocolError && this.connected) {
      this._noteDataStreamProtocolError(
        `truncated BCDS packet-stream header (${prefix.byteLength}/${WT_DATA_STREAM_HEADER_BYTES} bytes)`,
      );
      return;
    }
    if (mode === 'data-stream' && dataStreamIndex !== null &&
        !protocolError && truncatedDataStream) {
      this._noteDataStreamProtocolError(
        `truncated BCDS packet frame on stream ${dataStreamIndex}`,
      );
    }
  }

  _parseDataStreamHeader(bytes) {
    if (bytes.byteLength < WT_DATA_STREAM_HEADER_BYTES) return null;
    let current = true;
    for (let i = 0; i < 4; i++) {
      current &&= bytes[i] === WT_DATA_STREAM_MAGIC[i];
    }
    if (!current) return { error: 'invalid BCDS packet-stream magic' };
    if (bytes[4] !== WT_DATA_STREAM_VERSION) {
      return { error: `unsupported BCDS packet-stream version ${bytes[4]}` };
    }
    if (bytes[5] !== WT_DATA_STREAM_FLAGS) {
      return { error: `unsupported BCDS packet-stream flags ${bytes[5]}` };
    }
    return { streamIndex: bytes[6] | (bytes[7] << 8) };
  }

  async _appendDataStreamBytes(streamIndex, chunk, streamToken, wt = null) {
    if (!this.connected ||
        (wt !== null && this._wt !== wt) ||
        this._dataStreamTokens.get(streamIndex) !== streamToken) {
      this._debugStats.wtDataStreamAbortedDrains++;
      return false;
    }
    this._debugStats.wtDataStreamChunks++;
    this._debugStats.wtDataStreamBytes += chunk.byteLength;

    // Accumulate into a chunk list (see createDataStreamAccumulator). A fresh or
    // reset-to-empty entry (the Uint8Array(0) written at stream registration)
    // has no `.chunks`, so normalize it to a real accumulator on first append.
    let acc = this._dataStreamBuffers.get(streamIndex);
    if (!acc || acc.chunks === undefined) {
      acc = createDataStreamAccumulator();
    }
    acc.chunks.push(chunk);
    acc.byteLength += chunk.byteLength;

    // Every packet decoded in one synchronous run of this loop reaches its
    // subscription as one batch (BLO-36599). The batch closes wherever the
    // run ends: before the reader yields, and on every return. Delivery
    // credit is counted only after the batch is handed over, so media_progress
    // still reports frames the page has actually been given.
    let creditPending = 0;
    const closeBatch = () => {
      this._endPacketBatch();
      for (; creditPending > 0; creditPending--) this._noteMediaFrameDelivered();
    };
    this._beginPacketBatch();
    try {
      while (acc.byteLength >= 4) {
        const frameLen = readDataStreamFrameLen(acc);
        if (frameLen > WT_DATA_STREAM_MAX_FRAME_BYTES) {
          this._debugStats.wtDataStreamOversizedFrames++;
          this._debugStats.wtDataStreamBufferResets++;
          this._noteDataStreamProtocolError(
            `invalid BCDS packet length ${frameLen} on stream ${streamIndex}; expected u32LE length-prefixed packets`
          );
          this._dataStreamBuffers.set(streamIndex, new Uint8Array(0));
          return false;
        }
        if (acc.byteLength < 4 + frameLen) {
          this._dataStreamBuffers.set(streamIndex, acc);
          return true;
        }
        this._debugStats.wtDataStreamFrames++;
        this._debugStats.wtDataStreamFrameBytes += frameLen;
        this._debugStats.wtLastFrameAt = Date.now();
        this._debugStats.wtLastDataStreamFrameLen = frameLen;

        // Zero-copy when the frame body lies within the leading chunk; coalesce
        // exactly this frame's bytes once when it straddles a chunk boundary.
        const first = acc.chunks[0];
        const remainInFirst = first.byteLength - acc.head;
        const frameBytes = remainInFirst >= 4 + frameLen
          ? first.subarray(acc.head + 4, acc.head + 4 + frameLen)
          : coalesceDataStreamSpan(acc, 4, frameLen);
        this._handleTransportFrame(frameBytes);
        creditPending++;
        advanceDataStreamHead(acc, 4 + frameLen);
        acc.dispatchFrames++;
        if (acc.dispatchFrames >= WT_DATA_STREAM_DISPATCH_BATCH_FRAMES) {
          acc.dispatchFrames = 0;
          // A prioritized continuation lets rendering and FEC Worker tasks run
          // without allowing synchronous player work to monopolize the reader.
          // Keep this budget on the stream accumulator: WebTransport chunks are
          // arbitrary, and resetting it per append lets many small chunks run
          // indefinitely without yielding.
          this._debugStats.wtDataStreamYields++;
          // Hand the decoded packets over before yielding, so the tasks this
          // yield makes room for (rendering, the FEC worker's replies) run with
          // this batch already delivered.
          closeBatch();
          try {
            await yieldDataStreamDispatch();
          } finally {
            this._beginPacketBatch();
          }
          if (!this.connected ||
              (wt !== null && this._wt !== wt) ||
              this._dataStreamTokens.get(streamIndex) !== streamToken) {
            this._debugStats.wtDataStreamAbortedDrains++;
            return false;
          }
        }
      }
    } finally {
      closeBatch();
    }
    this._dataStreamBuffers.set(streamIndex, acc);
    return true;
  }

  /**
   * Open a packet dispatch batch. Packets decoded while a batch is open are
   * queued per subscription and delivered together by the matching
   * `_endPacketBatch`. Callers must pair the two synchronously around work
   * that contains no await, so a batch never spans a task boundary.
   */
  _beginPacketBatch() {
    this._packetBatchDepth++;
  }

  _endPacketBatch() {
    this._packetBatchDepth--;
    if (this._packetBatchDepth > 0 || this._packetBatch.size === 0) return;
    const batch = this._packetBatch;
    this._packetBatch = new Map();
    for (const [callbacks, events] of batch) this._dispatchPackets(callbacks, events);
  }

  /** Queue a decoded packet into the open batch, or deliver it now if none is open. */
  _deliverPacket(callbacks, event) {
    if (this._packetBatchDepth === 0) {
      this._dispatchPackets(callbacks, [event]);
      return;
    }
    const pending = this._packetBatch.get(callbacks);
    if (pending) pending.push(event);
    else this._packetBatch.set(callbacks, [event]);
  }

  /**
   * Deliver packets in arrival order: one `onpackets(events)` call when the
   * callbacks accept batches, otherwise one `onpacket(event)` per packet.
   */
  _dispatchPackets(callbacks, events) {
    if (typeof callbacks?.onpackets === 'function') {
      this._invokeSubscriptionCallback(callbacks, 'onpackets', events);
      return;
    }
    for (const event of events) {
      this._invokeSubscriptionCallback(callbacks, 'onpacket', event);
    }
  }

  _noteMediaFrameDelivered() {
    this._mediaFramesDelivered++;
    this._debugStats.wtMediaFramesDelivered++;
    if (this._mediaFramesDelivered - this._mediaFramesEnqueued >=
        WT_MEDIA_PROGRESS_BATCH_FRAMES) {
      this._flushMediaProgress();
      return;
    }

    this._armMediaProgressTimer();
  }

  /**
   * Count a datagram that reached the WebTransport datagram reader.
   *
   * Called before any parsing, so this is "arrived at the browser" and not
   * "parsed successfully" — the bridge reconciles it against the service
   * worker's authoritative accepted-send watermark. The difference is
   * end-to-end post-accept non-delivery, not necessarily one specific Quinn
   * buffer eviction mechanism.
   *
   * Unlike _noteMediaFrameDelivered this does not feed delivered_frames: the
   * bridge's stream credit window must not see datagram numbers.
   */
  _noteDatagramFrameReceived(sequence = null) {
    this._datagramFramesReceived++;
    if (Number.isSafeInteger(sequence) && sequence > 0 &&
        sequence <= WT_DATAGRAM_DELIVERY_MAX_LOGICAL_SEQUENCE) {
      const epoch = Math.floor((sequence - 1) / WT_DATAGRAM_DELIVERY_MAX_SEQUENCE);
      if (epoch > this._datagramSequenceEpoch) {
        this._debugStats.wtDatagramSequenceRollovers +=
          epoch - this._datagramSequenceEpoch;
        this._datagramSequenceEpoch = epoch;
      }
      let uniqueSequence = false;
      if (sequence <= this._datagramSettledSendWatermark) {
        // A late arrival corrects the already-published cohort. The missing
        // range ledger also makes duplicates harmless: only a sequence that
        // was previously classified missing can advance the aligned count.
        if (this._removeMissingDatagramSequence(sequence)) {
          this._datagramSettledFramesReceived++;
          uniqueSequence = true;
        }
      } else if (!this._datagramPendingSequences.has(sequence)) {
        if (this._datagramPendingSequences.size >= WT_DATAGRAM_MAX_PENDING_SEQUENCES) {
          // The watermark has stalled far enough that this sequence cannot be
          // adjudicated. Stop growing and stop advancing the aligned cohort;
          // see _datagramPendingOverflowed for why dropping it instead would
          // fabricate loss.
          if (!this._datagramPendingOverflowed) {
            this._datagramPendingOverflowed = true;
            console.warn(
              `${TAG} Datagram watermark stalled with ` +
              `${WT_DATAGRAM_MAX_PENDING_SEQUENCES} sequences unsettled; ` +
              `freezing aligned datagram accounting at ` +
              `tx=${this._datagramSettledSendWatermark}`,
            );
          }
          this._debugStats.wtDatagramPendingOverflow++;
        } else {
          this._datagramPendingSequences.add(sequence);
          uniqueSequence = true;
        }
      }
      if (uniqueSequence) {
        this._datagramSequencedFramesReceived++;
      }
      this._debugStats.wtDatagramSequencedFrames++;
    }
    if (this._datagramFramesReceived - this._datagramFramesEnqueued >=
        WT_MEDIA_PROGRESS_BATCH_FRAMES) {
      this._flushMediaProgress();
      return;
    }

    this._armMediaProgressTimer();
  }

  /**
   * Stage the service worker's authoritative cumulative accepted-send
   * watermark. The watermark travels on the reliable control stream, so it is
   * observable even when every corresponding datagram is lost.
   */
  _noteDatagramSendWatermark(watermark) {
    if (!Number.isSafeInteger(watermark) || watermark < 0 ||
        watermark > WT_DATAGRAM_DELIVERY_MAX_LOGICAL_SEQUENCE ||
        watermark <= this._datagramSendWatermark) {
      return;
    }
    this._datagramAccountingActive = true;
    this._stopDatagramCapabilityRetry();
    if (this._datagramCapable) {
      this._startDatagramProgressHeartbeat();
    }
    this._datagramSendWatermark = watermark;
    if (this._datagramSettlementTimer === null) {
      this._armDatagramSettlement();
    }
  }

  _armDatagramSettlement() {
    if (this._datagramSettlementTimer !== null ||
        this._datagramPendingOverflowed ||
        this._datagramSendWatermark <= this._datagramSettledSendWatermark) {
      return;
    }
    const generation = this._mediaProgressGeneration;
    // Snapshot the target now. Newer watermarks wait for the next grace period
    // instead of shortening their own settlement window under sustained load.
    this._datagramSettlementTarget = this._datagramSendWatermark;
    this._datagramSettlementTimer = setTimeout(() => {
      this._datagramSettlementTimer = null;
      if (generation !== this._mediaProgressGeneration) return;
      this._settleDatagramSendWatermark(this._datagramSettlementTarget);
      if (this._datagramSendWatermark > this._datagramSettledSendWatermark) {
        this._armDatagramSettlement();
      }
    }, WT_DATAGRAM_SETTLEMENT_GRACE_MS);
  }

  _settleDatagramSendWatermark(watermark) {
    if (!Number.isSafeInteger(watermark) ||
        this._datagramPendingOverflowed ||
        watermark <= this._datagramSettledSendWatermark ||
        watermark > this._datagramSendWatermark) {
      return;
    }
    const previousWatermark = this._datagramSettledSendWatermark;
    const receivedSequences = [];
    for (const sequence of this._datagramPendingSequences) {
      if (sequence > previousWatermark && sequence <= watermark) {
        receivedSequences.push(sequence);
        this._datagramPendingSequences.delete(sequence);
      }
    }
    receivedSequences.sort((a, b) => a - b);

    const retainedStart = Math.max(
      1,
      watermark - WT_DATAGRAM_LATE_CORRECTION_HORIZON + 1,
    );
    this._finalizeMissingDatagramRangesBefore(retainedStart);

    let missingStart = previousWatermark + 1;
    for (const sequence of receivedSequences) {
      if (sequence > missingStart) {
        this._recordMissingDatagramRange(missingStart, sequence - 1, retainedStart);
      }
      missingStart = sequence + 1;
    }
    if (missingStart <= watermark) {
      this._recordMissingDatagramRange(missingStart, watermark, retainedStart);
    }
    this._datagramSettledFramesReceived += receivedSequences.length;
    this._datagramSettledSendWatermark = watermark;
    this._flushMediaProgress();
  }

  _finalizeMissingDatagramRangesBefore(retainedStart) {
    const ranges = this._datagramMissingSequenceRanges;
    let removeCount = 0;
    let finalized = 0;
    while (removeCount < ranges.length) {
      const range = ranges[removeCount];
      if (range.end < retainedStart) {
        finalized += range.end - range.start + 1;
        removeCount++;
        continue;
      }
      if (range.start < retainedStart) {
        finalized += retainedStart - range.start;
        range.start = retainedStart;
      }
      break;
    }
    if (removeCount > 0) ranges.splice(0, removeCount);
    this._datagramFinalizedLossFrames += finalized;
  }

  _recordMissingDatagramRange(start, end, retainedStart) {
    if (start > end) return;
    if (start < retainedStart) {
      const finalizedEnd = Math.min(end, retainedStart - 1);
      this._datagramFinalizedLossFrames += finalizedEnd - start + 1;
      start = retainedStart;
    }
    if (start <= end) this._appendMissingDatagramRange(start, end);
  }

  _appendMissingDatagramRange(start, end) {
    if (start > end) return;
    const last = this._datagramMissingSequenceRanges.at(-1);
    if (last && last.end + 1 === start) {
      last.end = end;
      return;
    }
    this._datagramMissingSequenceRanges.push({ start, end });
    this._debugStats.wtDatagramMissingRangesPeak = Math.max(
      this._debugStats.wtDatagramMissingRangesPeak,
      this._datagramMissingSequenceRanges.length,
    );
  }

  _removeMissingDatagramSequence(sequence) {
    let low = 0;
    let high = this._datagramMissingSequenceRanges.length - 1;
    let lookupSteps = 0;
    while (low <= high) {
      lookupSteps++;
      const i = low + Math.floor((high - low) / 2);
      const range = this._datagramMissingSequenceRanges[i];
      if (sequence < range.start) {
        high = i - 1;
        continue;
      }
      if (sequence > range.end) {
        low = i + 1;
        continue;
      }

      if (range.start === range.end) {
        this._datagramMissingSequenceRanges.splice(i, 1);
      } else if (sequence === range.start) {
        range.start++;
      } else if (sequence === range.end) {
        range.end--;
      } else {
        const oldEnd = range.end;
        range.end = sequence - 1;
        this._datagramMissingSequenceRanges.splice(i + 1, 0, {
          start: sequence + 1,
          end: oldEnd,
        });
        this._debugStats.wtDatagramMissingRangesPeak = Math.max(
          this._debugStats.wtDatagramMissingRangesPeak,
          this._datagramMissingSequenceRanges.length,
        );
      }
      this._debugStats.wtDatagramMissingLookupStepsMax = Math.max(
        this._debugStats.wtDatagramMissingLookupStepsMax,
        lookupSteps,
      );
      return true;
    }
    this._debugStats.wtDatagramMissingLookupStepsMax = Math.max(
      this._debugStats.wtDatagramMissingLookupStepsMax,
      lookupSteps,
    );
    return false;
  }

  _armMediaProgressTimer() {
    if (this._mediaProgressTimer !== null) return;
    const generation = this._mediaProgressGeneration;
    this._mediaProgressTimer = setTimeout(() => {
      this._mediaProgressTimer = null;
      if (generation === this._mediaProgressGeneration) {
        this._flushMediaProgress();
      }
    }, WT_MEDIA_PROGRESS_MAX_WAIT_MS);
  }

  /**
   * Report datagram telemetry on a slow heartbeat while accounting is active
   * and the datagram reader is live, independently of whether anything arrives.
   *
   * Without this, total non-delivery is indistinguishable from no telemetry: if
   * every datagram is dropped, the receive counter never advances, no report is
   * ever sent, and the service worker cannot tell "this client lost everything"
   * from "this client does not report". The accepted-send watermark itself is
   * supplied independently over the reliable control stream.
   */
  _startDatagramProgressHeartbeat() {
    if (this._datagramHeartbeatTimer !== null ||
        !this._datagramAccountingActive || !this._datagramCapable) return;
    this._datagramHeartbeatTimer = setInterval(() => {
      if (!this._datagramCapable) return;
      this._flushMediaProgress();
    }, WT_DATAGRAM_PROGRESS_HEARTBEAT_MS);
  }

  _stopDatagramProgressHeartbeat() {
    if (this._datagramHeartbeatTimer === null) return;
    clearInterval(this._datagramHeartbeatTimer);
    this._datagramHeartbeatTimer = null;
  }

  /**
   * Keep re-announcing datagram capability until the server acknowledges it
   * with an accepted-send watermark.
   *
   * `_sendControl()` reports only that the frame was enqueued. A rejected
   * write clears the entire control queue, so treating the one-shot
   * announcement as delivered can strand negotiation permanently: the server
   * never marks the connection sequence-capable, never publishes a watermark,
   * and the recurring heartbeat that would re-announce never starts. Total
   * loss — the case this protocol exists to measure — then looks identical to
   * a client that never had a datagram reader.
   */
  _startDatagramCapabilityRetry() {
    if (this._datagramCapabilityTimer !== null ||
        !this._datagramCapable || this._datagramAccountingActive) return;
    this._datagramCapabilityRetries = 0;
    this._datagramCapabilityTimer = setInterval(() => {
      // A large timer advance (and some embedders' timer queues) can already
      // have queued callbacks when clearInterval() runs.  Do not let one of
      // those stale callbacks emit another capability frame or increment the
      // exhaustion counter after the retry loop has been stopped.
      if (this._datagramCapabilityTimer === null) return;
      if (!this._datagramCapable || this._datagramAccountingActive) {
        this._stopDatagramCapabilityRetry();
        return;
      }
      if (this._datagramCapabilityRetries >= WT_DATAGRAM_CAPABILITY_MAX_RETRIES) {
        // Bounded on ATTEMPTS, deliberately — never on confirmed writes. A
        // write that never settles (a stalled sink under backpressure) neither
        // resolves nor rejects, so a confirmed-write bound would never
        // terminate. The attempt count is the one quantity an unhealthy
        // transport cannot pin at zero.
        //
        // What the bound covers is a server that HEARD the announcement and
        // stayed silent, which is indistinguishable from one that has not
        // answered yet: datagram media disabled (the production default, which
        // returns before recording anything), a server too old to understand
        // `dg.v`, or one enabled but idle, where sentFrames ===
        // lastWatermarkSent === 0 means no watermark is ever published.
        // Retrying forever would put permanent control traffic on the path
        // whose whole invariant is to stay inert when the server has datagram
        // media disabled.
        //
        // It is NOT what covers a dropped write. A rejected control write is
        // terminal, not transient: it latches the writer errored, and
        // `_drainControlWrites` now drops the writer, so no later attempt
        // reaches the transport at all. Only a reconnect recovers that, and it
        // re-announces from a clean cohort. The two counters separate the
        // cases without either gating the loop: retries ===
        // announcements-written means the server heard us and chose silence;
        // announcements-written short of retries, alongside
        // `wtControlWriteDead`, means the rest never left the process.
        this._debugStats.wtDatagramCapabilityRetriesExhausted++;
        this._stopDatagramCapabilityRetry();
        return;
      }
      this._datagramCapabilityRetries++;
      this._flushMediaProgress();
    }, WT_DATAGRAM_CAPABILITY_RETRY_MS);
  }

  _stopDatagramCapabilityRetry() {
    if (this._datagramCapabilityTimer === null) return;
    clearInterval(this._datagramCapabilityTimer);
    this._datagramCapabilityTimer = null;
  }

  _flushMediaProgress() {
    if (this._mediaProgressTimer !== null) {
      clearTimeout(this._mediaProgressTimer);
      this._mediaProgressTimer = null;
    }
    // Either counter advancing is reason to report. Gating on the stream
    // counter alone would silence datagram telemetry in exactly the case it
    // exists to measure: datagram media flowing while stream traffic is idle.
    const streamAdvanced = this._mediaFramesDelivered > this._mediaFramesEnqueued;
    const datagramAdvanced = this._datagramFramesReceived > this._datagramFramesEnqueued;
    // The initial reader announcement is one-shot. Once the server publishes a
    // watermark, accounting remains reportable through final settlement even
    // if the reader closes before the grace timer fires.
    const datagramReportable = this._datagramCapable ||
      this._datagramAccountingActive;
    if (!streamAdvanced && !datagramAdvanced && !datagramReportable) return;

    const deliveredFrames = this._mediaFramesDelivered;
    const datagramFrames = this._datagramFramesReceived;
    // `dg` keys off reader capability or negotiated accounting, not off having
    // received something. Only a session with neither omits it and stays
    // byte-identical to the pre-existing message — in practice that is the
    // WebSocket path, because a WebTransport session always exposes a datagram
    // reader and so latches capable for its whole life.
    //
    // That the block then rides along on frames already being sent is
    // load-bearing, not incidental. The service worker sets `sequenceCapable`
    // ONLY from a `dg` block on a media_progress, and the re-announcement timer
    // above deliberately stops after a few seconds. A server that is enabled
    // but idle at connect time publishes no watermark until media starts, so if
    // `dg` fell off once those retries exhausted, that connection could never
    // negotiate up to the sequenced path afterwards. When the server has
    // datagram media disabled instead, the cost is these bytes on an existing
    // frame; the receiving side returns on the flag before allocating anything.
    if (!this._sendControl({
      type: 'media_progress',
      delivered_frames: deliveredFrames,
      ...(datagramReportable ? {
        dg: {
          v: WT_DATAGRAM_DELIVERY_VERSION,
          // Legacy total for a pre-sequence service worker.
          rx: datagramFrames,
          // Aligned cohort for a sequence-aware service worker.
          tx: this._datagramSettledSendWatermark,
          sx: this._datagramSettledFramesReceived,
          // Present only once the pending cap has frozen the aligned cohort.
          // tx/sx stop advancing from that point and cannot resume until the
          // connection is rebuilt, so without this flag the server keeps
          // scoring a stale pair as a live measurement and publishes a
          // confident rate over a cohort that stopped measuring. Optional, so
          // the wire shape of a healthy session is unchanged.
          ...(this._datagramPendingOverflowed ? { fz: 1 } : {}),
        },
      } : {}),
    }, {
      // Committed by `_drainControlWrites` once this entry's write RESOLVES.
      // Committing here instead would mark the frame reported the moment it is
      // enqueued, and the very first rejection then lands after the counters
      // already moved — permanently under-reporting one frame's worth of
      // stream credit and datagram settlement for a frame nobody received.
      reportMediaFrames: deliveredFrames,
      reportDatagramFrames: datagramFrames,
    })) return;

    // Queued, so stop re-flushing this span. Rolled back if the write rejects.
    this._mediaFramesEnqueued = deliveredFrames;
    this._datagramFramesEnqueued = datagramFrames;
  }

  _resetMediaProgress() {
    if (this._mediaProgressTimer !== null) {
      clearTimeout(this._mediaProgressTimer);
      this._mediaProgressTimer = null;
    }
    this._stopDatagramProgressHeartbeat();
    this._stopDatagramCapabilityRetry();
    this._mediaProgressGeneration++;
    this._mediaFramesDelivered = 0;
    this._mediaFramesReported = 0;
    this._mediaFramesEnqueued = 0;
    this._datagramFramesReceived = 0;
    this._datagramFramesReported = 0;
    this._datagramFramesEnqueued = 0;
    this._datagramSequencedFramesReceived = 0;
    this._datagramSequenceEpoch = 0;
    this._datagramSendWatermark = 0;
    this._datagramSettledSendWatermark = 0;
    this._datagramSettledFramesReceived = 0;
    this._datagramPendingSequences.clear();
    this._datagramPendingOverflowed = false;
    this._datagramCapabilityRetries = 0;
    this._datagramCapabilityAnnouncementsWritten = 0;
    this._datagramMissingSequenceRanges.length = 0;
    this._datagramFinalizedLossFrames = 0;
    this._debugStats.wtDatagramMissingRangesPeak = 0;
    this._debugStats.wtDatagramMissingLookupStepsMax = 0;
    this._datagramSettlementTarget = 0;
    if (this._datagramSettlementTimer !== null) {
      clearTimeout(this._datagramSettlementTimer);
      this._datagramSettlementTimer = null;
    }
    this._datagramCapable = false;
    this._datagramAccountingActive = false;
  }

  _noteDataStreamProtocolError(reason) {
    this._debugStats.wtDataStreamProtocolErrors++;
    this._debugStats.wtLastDataStreamProtocolError = reason;
    console.warn(`${TAG} WT data-stream protocol error: ${reason}`);
  }

  // ── Lifecycle ──

  _setupLifecycleHandlers() {
    this._unloadHandler = () => this._onPageUnload();
    window.addEventListener('beforeunload', this._unloadHandler);
    this._visibilityHandler = () => {
      if (document.visibilityState === 'hidden') this._onPageHidden();
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  disconnect({ preserveSubscriptions = false, notifySubscriptions = true, intentional = true } = {}) {
    if (intentional) {
      this._manualDisconnect = true;
      this._reconnectAfterCurrent = false;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopKeepalive();
    this._stopSubscriptionWatchdog();

    if (this._unloadHandler) {
      window.removeEventListener('beforeunload', this._unloadHandler);
      this._unloadHandler = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }

    // Close bidi writer
    if (this._bidiWriter) {
      const writer = this._bidiWriter;
      this._bidiWriter = null;
      this._resetControlWrites();
      try {
        void writer.close().catch(() => {});
      } catch { /* ignore */ }
    } else {
      this._resetControlWrites();
    }

    if (this._wtDatagramReader) {
      const reader = this._wtDatagramReader;
      this._wtDatagramReader = null;
      try {
        void reader.cancel().catch(() => {});
      } catch { /* ignore */ }
    }

    // Close WebTransport
    if (this._wt) {
      try { this._wt.close(); } catch { /* ignore */ }
      this._wt = null;
      this._wtStreamReader = null;
    }

    this._transport = null;
    this.connected = false;
    markBridgeThroughputDiscontinuity(this);

    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();

    if (!preserveSubscriptions) {
      this._subscriptionEpoch++;
      if (notifySubscriptions) {
        for (const [, cbs] of this.subscriptionCallbacks) {
          this._invokeSubscriptionCallback(cbs, 'onerror', new Error('Bridge disconnected'));
        }
      }
      this.subscriptionCallbacks.clear();
      this.activeSubscriptions.clear();
      this._desiredSubscriptions.clear();
      invalidateBridgeBytesSubscriptions(this);
    }
    this._streamSubscriptions.clear();
    this._serverPacketIdFilters.clear();
    this._streamMetadataWarnings.clear();
    this._streamMetadataSources.clear();
    this._chunkMessages.clear();
    this._dataStreamBuffers.clear();
    this._dataStreamTokens.clear();
    this._resetMediaProgress();
  }

  // ── Subscribe / Unsubscribe (unified for both transports) ──

  _buildSubscribeMessage(entry, requestId) {
    const msg = {
      type: 'subscribe',
      request_id: requestId,
      client_type: 'bridge',
      page_url: location.href,
    };
    if (entry.group) msg.group = entry.group;
    if (Number.isFinite(entry.port)) msg.port = entry.port;
    if (entry.source) msg.source = entry.source;
    if (entry.transportOpts.protocol) msg.protocol = entry.transportOpts.protocol;
    if (entry.transportOpts.origin) msg.origin = entry.transportOpts.origin;
    if (entry.transportOpts.standard) msg.standard = entry.transportOpts.standard;
    if (entry.transportOpts.fec !== undefined) msg.fec = entry.transportOpts.fec;
    if (entry.transportOpts.mode) msg.mode = entry.transportOpts.mode;
    if (entry.transportOpts.amtRelay) msg.amt_relay = entry.transportOpts.amtRelay;
    if (entry.transportOpts.amtRelayPort !== undefined) msg.amt_relay_port = entry.transportOpts.amtRelayPort;
    if (entry.transportOpts.reliableBacklog) msg.reliable_backlog = entry.transportOpts.reliableBacklog;
    if (entry.transportOpts.receiveTimestampSource) {
      msg.receive_timestamp_source = entry.transportOpts.receiveTimestampSource;
    }
    // `subscribePacketIds`, when present (even as undefined, meaning every
    // packet ID), is the union for every entry sharing the endpoint.
    const packetIds = 'subscribePacketIds' in entry
      ? entry.subscribePacketIds
      : entry.transportOpts.packetIds;
    if (Array.isArray(packetIds)) msg.packet_ids = [...packetIds];
    return msg;
  }

  _sendSubscribeRequest(
    entry,
    { transport = this._wt, generation = this._controlWriteGeneration } = {},
  ) {
    if (!this.connected ||
        (transport !== null && this._wt !== transport) ||
        this._controlWriteGeneration !== generation) {
      throw new Error('Not connected to bridge');
    }

    const requestId = generateRequestId();
    const promise = new Promise((resolve, reject) => {
      const pending = { resolve, reject };
      this.pendingRequests.set(requestId, pending);
      setTimeout(() => {
        if (this.pendingRequests.get(requestId) === pending) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Subscribe timeout'));
        }
      }, SUBSCRIBE_TIMEOUT);
    });

    if (!this._sendControl(this._buildSubscribeMessage(entry, requestId))) {
      // The frame never left the process, so no response can ever arrive.
      // Fail now rather than after SUBSCRIBE_TIMEOUT (BLO-35598).
      const pending = this.pendingRequests.get(requestId);
      this.pendingRequests.delete(requestId);
      pending?.reject(new Error('Bridge control channel unavailable'));
    }
    return promise;
  }

  _invokeSubscriptionCallback(callbacks, name, value) {
    const callback = callbacks?.[name];
    if (typeof callback !== 'function') return;
    try {
      const result = callback(value);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch((error) => {
          console.error(`${TAG} Subscription ${name} callback failed:`, error);
        });
      }
    } catch (error) {
      console.error(`${TAG} Subscription ${name} callback failed:`, error);
    }
  }

  _createSubscriptionFanout(entries) {
    const dispatch = (name, value) => {
      for (const entry of [...entries]) {
        this._invokeSubscriptionCallback(entry.callbacks, name, value);
      }
    };
    // Each entry gets only the packets its own list names, whatever the
    // server forwards (see _applyEntryPacketIdFilter).
    const deliver = (events) => {
      for (const entry of [...entries]) {
        const admitted = packetsAdmittedBy(entry.clientPacketIdFilter, events);
        if (admitted.length > 0) this._dispatchPackets(entry.callbacks, admitted);
      }
    };
    return {
      onpacket: (event) => deliver([event]),
      onpackets: (events) => deliver(events),
      onerror: (error) => dispatch('onerror', error),
      ontransportstate: (state) => dispatch('ontransportstate', state),
      ontransportchange: (transport) => dispatch('ontransportchange', transport),
    };
  }

  async _drainPendingSubscriptions() {
    let generation;
    do {
      generation = this._pendingSubscriptionGeneration;
      await Promise.allSettled([...this._pendingSubscriptions]);
    } while (
      this._pendingSubscriptions.size > 0 ||
      generation !== this._pendingSubscriptionGeneration
    );
  }

  /**
   * Registers `request`, an in-flight server unsubscribe, under the BCDS
   * server id of each of `entries`, so a same-id `subscribe()` waits for it.
   * Resolves to the teardown's settle ordinal (see `_serverTeardownsSettled`)
   * and rejects as `request` does.
   */
  _trackServerTeardown(entries, request) {
    const keys = new Set([...entries].map(bcdsServerSubscriptionId));
    // Bookkeeping runs before any waiter resumes: waiters await `tracked`.
    const settle = () => {
      for (const key of keys) {
        const pending = this._serverTeardowns.get(key);
        pending?.delete(tracked);
        if (pending?.size === 0) this._serverTeardowns.delete(key);
      }
      return ++this._serverTeardownsSettled;
    };
    const tracked = request.then(settle, (error) => {
      settle();
      throw error;
    });
    for (const key of keys) {
      let pending = this._serverTeardowns.get(key);
      if (!pending) this._serverTeardowns.set(key, pending = new Set());
      pending.add(tracked);
    }
    return tracked;
  }

  /**
   * After an unsubscribe of `subscriptionId`, retire the transport when a
   * desired entry for that id may have been removed server-side by it. An
   * entry whose subscribe was sent after the teardown settled (its
   * `teardownsSettledAtSend` reached `teardownOrdinal`) is ordered after it
   * and cannot be; without an ordinal every entry counts.
   */
  async _recoverSubscriptionReplacedDuringTeardown(
    subscriptionId,
    ownsTransport = null,
    teardownOrdinal = undefined,
  ) {
    // Drain until nothing is pending when this resumes: a subscribe sent in
    // the tick after the drain's last check would otherwise go out on the
    // session this reset retires, and be rejected rather than replayed.
    do await this._drainPendingSubscriptions(); while (this._pendingSubscriptions.size > 0);
    if (ownsTransport && !ownsTransport()) return false;
    const entries = this._desiredSubscriptions.get(subscriptionId);
    if (
      this.connected &&
      entries &&
      [...entries].some((entry) => !(entry.teardownsSettledAtSend >= teardownOrdinal))
    ) {
      this._handleDisconnect();
      return true;
    }
    return false;
  }

  async subscribe(group, port, source, transportOpts = {}) {
    // Refused before connecting: no bridge can deliver the signaling flow.
    if (Array.isArray(transportOpts?.packetIds) &&
        transportOpts.packetIds.includes(MMTP_SIGNALING_PACKET_ID)) {
      throw makeMulticastError('subscription-failed', SIGNALING_PACKET_ID_REFUSAL);
    }
    // Only a closed session, or a server id still being torn down (below),
    // pays an await: otherwise a connected client must keep issuing its
    // subscribe request synchronously (callers and the replay machinery
    // order themselves around that). A disconnect that drops every
    // subscription while this waits also invalidated the page registry that
    // will own the result, so the join is rejected rather than installed (see
    // the held join below).
    const epoch = this._subscriptionEpoch;
    if (!this.connected) {
      await this._ensureConnectedForSubscribe(epoch);
      if (this._subscriptionEpoch !== epoch) throw new Error('Disconnected');
    }

    const entry = {
      group,
      port: port === undefined ? undefined : Number(port),
      source,
      transportOpts: { ...(transportOpts || {}) },
      callbacks: {},
      /** Delivery filter: exactly this entry's own list (_applyEntryPacketIdFilter). */
      clientPacketIdFilter: null,
    };
    // Both BCDS servers hold one subscription per id and ignore packet_ids on
    // a duplicate (IWA `handleSubscribeRequest` reuses it) or replace it
    // (native `SubscriptionTable` subscribe control path); either way a pending unsubscribe of the old owner
    // then removes this join's membership. So a join for an id with a server
    // unsubscribe outstanding waits for it, then sends a fresh subscribe
    // carrying its own packet_ids. This orders a release followed by a
    // subscribe; a caller that subscribes the new filter before releasing the
    // old one still races, and only the replacement backstop recovers it.
    //
    // "Settled" is normally the server's `unsubscribe_response`, which means
    // the session's subscription entry is gone: IWA `handleUnsubscribeRequest`
    // is synchronous and deletes it before acknowledging
    // (`handleUnsubscribeRequest`); native `SubscriptionTable::stop` removes
    // it before the ack. Releasing the
    // membership underneath continues asynchronously, and a fresh subscribe
    // is safe against that because IWA anchor work queues FIFO per key
    // (`acquireBridgeAnchorLock`) and a native task forgets only its own
    // generation (`SubscriptionTable::release`). When the ack times out after
    // the frame was written,
    // ordering rests on the one ordered bidi control stream
    // (`_drainControlWrites` writes FIFO), which both servers read in order:
    // the native control loop handles one frame at a time, in arrival order
    // and IWA `processControlMessage` dispatches the unsubscribe synchronously.
    // A write that never settles retires the transport (`_sendUnsubscribeRequest`).
    //
    // A held join is the successor of a subscription this session held until
    // its release, so a lost session counts it as desired
    // (`_heldSubscriptions`): the disconnect preserves the page registry that
    // will own it and moves the join to the next session, never onto the one
    // the unsubscribe reached. That includes the session the client retires
    // itself when that unsubscribe's write stalls. Only a deliberate
    // `disconnect()` still drops every subscription; it rejects the join, as
    // it rejects `pendingRequests`, rather than letting it install an entry
    // whose owner was just invalidated.
    const serverSubscriptionId = bcdsServerSubscriptionId(entry);
    let teardowns = this._serverTeardowns.get(serverSubscriptionId);
    if (teardowns) {
      this._heldSubscriptions++;
      try {
        do {
          // The releasing owner handles its own failure. A failed unsubscribe
          // write either kills this session's control writer, so the send
          // below fails closed, or belonged to a session since replaced.
          await Promise.allSettled(teardowns);
          if (this._subscriptionEpoch !== epoch) throw new Error('Disconnected');
          if (!this.connected) {
            await this._ensureConnectedForSubscribe(epoch);
            if (this._subscriptionEpoch !== epoch) throw new Error('Disconnected');
          }
        } while ((teardowns = this._serverTeardowns.get(serverSubscriptionId)));
      } finally {
        this._heldSubscriptions--;
      }
    }
    entry.teardownsSettledAtSend = this._serverTeardownsSettled;
    // Filtered from its first packet: the subscribe below can widen what the
    // server forwards to entries already on this endpoint.
    this._applyEntryPacketIdFilter(entry);
    // A server holds one subscription per endpoint. One that replaces it on a
    // repeat subscribe (native-bcds-bridge) installs this request's list, so
    // ask for what every entry on the endpoint needs.
    const sharing = this._entriesForEndpoint(entry);
    const union = sharing.length > 0
      ? packetIdFilterUnion([...sharing, entry].map((e) => e.transportOpts.packetIds))
      : undefined;
    const pendingSubscription = this._sendSubscribeRequest(
      sharing.length > 0 ? { ...entry, subscribePacketIds: union ? [...union] : undefined } : entry,
    );
    this._pendingSubscriptionGeneration++;
    this._pendingSubscriptions.add(pendingSubscription);
    let subscribeResult;
    try {
      subscribeResult = await pendingSubscription;
    } finally {
      this._pendingSubscriptions.delete(pendingSubscription);
    }
    const subscriptionId = typeof subscribeResult === 'string'
      ? subscribeResult
      : subscribeResult?.subscriptionId;
    entry.subscriptionId = subscriptionId;
    entry.transport = normalizeResolvedMulticastTransport(subscribeResult?.transport) ??
      normalizeResolvedMulticastTransport(transportOpts.mode);
    // Fixed for the life of this subscription: a consumer reads it once, when
    // it joins, to choose how FEC blocks are settled.
    entry.delivery = normalizeMulticastDelivery(subscribeResult?.delivery);
    let entries = this._desiredSubscriptions.get(subscriptionId);
    if (!entries) {
      entries = new Set();
      this._desiredSubscriptions.set(subscriptionId, entries);
    }
    entries.add(entry);
    this._recordServerPacketIdFilter(subscriptionId, subscribeResult, entry.transportOpts.packetIds);
    this.subscriptionCallbacks.set(subscriptionId, this._createSubscriptionFanout(entries));
    this.activeSubscriptions.add(subscriptionId);
    if (entries.size > 1) {
      // A server shares one subscription per endpoint, so this request's list
      // did not replace the filter the first request installed. Widen it to
      // cover this entry before handing the subscription out.
      // A server that cannot replace its filter keeps the one it has, as it
      // always did; a replaceable filter that fails to widen fails the join.
      try {
        await this._reconcilePacketIdFilter(subscriptionId, { requireCoverage: false });
      } catch (error) {
        await this._unsubscribeEntries(subscriptionId, [entry]).catch(() => {});
        throw error;
      }
    }

    const client = this;
    return {
      get subscriptionId() { return entry.subscriptionId; },
      get transport() { return entry.transport; },
      get delivery() { return entry.delivery; },
      // Optional provider detail for consumers that need physical filtering,
      // rather than the page-side filtering that setPacketIds also supports.
      // An immutable receiver can resolve a narrowing without changing its
      // server filter, so a resolved call alone is not proof of reduction.
      get packetIdsMutable() {
        return client._serverPacketIdFilters.get(entry.subscriptionId)?.mutable;
      },
      get active() {
        return Boolean(entry.subscriptionId && client._desiredSubscriptions.get(entry.subscriptionId)?.has(entry));
      },
      setCallbacks: (cbs) => {
        entry.callbacks = cbs || {};
      },
      /**
       * Replace this entry's packet-ID filter without rejoining. Entries that
       * share the server subscription keep theirs; the server forwards their
       * union. Rejects with `capability-unsupported` when the server cannot
       * replace a filter and the new list needs a packet it does not forward.
       */
      setPacketIds: (packetIds) => this._setEntryPacketIds(entry, packetIds),
      unsubscribe: () => {
        if (!entry.subscriptionId || !this._desiredSubscriptions.get(entry.subscriptionId)?.has(entry)) {
          return Promise.resolve();
        }
        return this._unsubscribeEntries(entry.subscriptionId, [entry]);
      },
    };
  }

  /**
   * Record the filter a subscribe response reports in force. A server that
   * predates filter reporting applied the request's own list to a new
   * subscription, and nothing is known about the one a duplicate reused.
   * `packet_ids_mutable: false` without `packet_ids` declares that the
   * subscription has no packet-ID filter and cannot be given one: its payload
   * is not MMTP (the IWA's addressless ATSC 1.0 MPEG-TS stream).
   */
  _recordServerPacketIdFilter(subscriptionId, subscribeResult, requestedPacketIds) {
    let record;
    if (Array.isArray(subscribeResult?.packetIds)) {
      record = {
        known: true,
        mutable: subscribeResult.packetIdsMutable === true,
        packetIds: packetIdFilter(subscribeResult.packetIds),
      };
    } else if (subscribeResult?.packetIdsMutable === false) {
      record = {
        known: true,
        mutable: false,
        packetIds: null,
        packetIdsApply: false,
      };
    } else {
      // After a repeat subscribe an older server either kept its filter (IWA)
      // or installed the request's (native bridge); which one is unknowable.
      const fresh = (this._desiredSubscriptions.get(subscriptionId)?.size ?? 0) <= 1;
      record = {
        known: fresh,
        mutable: false,
        packetIds: fresh ? packetIdFilter(requestedPacketIds) : null,
      };
    }
    record.reportSeq = this._packetIdReportOrder.get(subscribeResult);
    // Updated in place: a set_packet_ids round trip in flight holds this
    // record, and treats a different record as a subscription torn down
    // underneath it. A sibling's subscribe response refreshing the record is
    // not a teardown; replacing it would drop that round trip's acknowledged
    // filter and leave the record reporting the one the subscribe saw.
    const existing = this._serverPacketIdFilters.get(subscriptionId);
    if (!existing) {
      this._serverPacketIdFilters.set(subscriptionId, record);
    } else if (!packetIdReportSupersedes(existing.reportSeq, record.reportSeq)) {
      for (const key of Object.keys(existing)) delete existing[key];
      Object.assign(existing, record);
    }
    // A server that declared a payload without packet IDs turns filters off.
    for (const entry of this._desiredSubscriptions.get(subscriptionId) ?? []) {
      this._applyEntryPacketIdFilter(entry);
    }
  }

  /** Desired entries on the same endpoint as `entry`, whatever their server id. */
  _entriesForEndpoint(entry) {
    const sharing = [];
    for (const entries of this._desiredSubscriptions.values()) {
      for (const other of entries) {
        if (other.group === entry.group && other.port === entry.port &&
            (other.source || undefined) === (entry.source || undefined)) {
          sharing.push(other);
        }
      }
    }
    return sharing;
  }

  /** Union of the packet-ID lists of every entry sharing a server subscription. */
  _desiredPacketIdFilter(entries) {
    return packetIdFilterUnion([...entries].map((entry) => entry.transportOpts.packetIds));
  }

  /**
   * Whether packet-ID lists apply to an entry's subscription at all: its
   * payload is MMTP by its own request, and the server did not declare
   * otherwise.
   */
  _packetIdsApply(entry) {
    if (!carriesMmtpPacketIds(entry.transportOpts)) return false;
    const server = entry.subscriptionId === undefined
      ? undefined
      : this._serverPacketIdFilters.get(entry.subscriptionId);
    return server?.packetIdsApply !== false;
  }

  /**
   * Set an entry's delivery filter to exactly its own list, whatever the
   * server forwards. The server's filter is the union of every entry on the
   * endpoint, and another entry can widen it at any moment (joining, its
   * setPacketIds, a replayed subscribe); both bridges apply a widening
   * before acknowledging it, so a filter relaxed to "the server already
   * filters for me" would deliver another entry's packets for that round
   * trip. Filtering as tightly as the entry asked never withholds a packet it
   * asked for. A payload without packet IDs is never filtered.
   */
  _applyEntryPacketIdFilter(entry) {
    entry.clientPacketIdFilter = this._packetIdsApply(entry)
      ? packetIdFilter(entry.transportOpts.packetIds)
      : null;
  }

  /**
   * Make the server forward the union of its entries' filters. Serialized, so
   * two changes cannot reach the server out of order. Without a connection
   * this does nothing: replay subscribes with the union.
   */
  _reconcilePacketIdFilter(subscriptionId, options) {
    const entry = this._desiredSubscriptions.get(subscriptionId)?.values().next().value;
    // No entries means nothing to reconcile (the reconcile would return at once).
    if (!entry) return Promise.resolve();
    return this._serializePacketIdFilterChange(
      this._packetIdFilterChainKey(entry),
      () => this._reconcilePacketIdFilterNow(subscriptionId, options),
    );
  }

  /** The endpoint an entry is on, as a filter-chain key; undefined without one. */
  _packetIdFilterChainKey(entry) {
    if (!entry) return undefined;
    return JSON.stringify([entry.group ?? null, entry.port ?? null, entry.source || null]);
  }

  /** Run `change` after every earlier filter change queued under `key`. */
  _serializePacketIdFilterChange(key, change) {
    const previous = this._packetIdFilterChains.get(key) ?? Promise.resolve();
    const result = previous.then(change, change);
    const tail = result.then(() => {}, () => {});
    this._packetIdFilterChains.set(key, tail);
    tail.then(() => {
      if (this._packetIdFilterChains.get(key) === tail) this._packetIdFilterChains.delete(key);
    });
    return result;
  }

  async _reconcilePacketIdFilterNow(subscriptionId, options = {}) {
    const { requireCoverage = true } = options;
    const entries = this._desiredSubscriptions.get(subscriptionId);
    if (!entries || entries.size === 0) return;
    if (!this._serverPacketIdFilters.has(subscriptionId) && this.connected) {
      // Reconnected, with the replayed subscribe that records this endpoint's
      // filter still in flight: judge the change against what it reports.
      const anchor = entries.values().next().value;
      const replay = this._packetIdReplays.get(this._packetIdFilterChainKey(anchor));
      if (replay) {
        await replay;
        return this._reconcilePacketIdFilterNow(anchor.subscriptionId, options);
      }
    }
    // Nothing to filter by: the server forwards the stream whole.
    if (!this._packetIdsApply(entries.values().next().value)) return;
    const wanted = this._desiredPacketIdFilter(entries);
    const server = this._serverPacketIdFilters.get(subscriptionId);
    // Nothing reaches the server: no record of its filter (a reconnect that
    // preserved the subscription clears it until the replayed subscribe
    // reports one) or no connection. The receiver keeps whatever filter it
    // had, so this is the one return a caller must not read as applied.
    if (!server || !this.connected) return false;
    if (server.known && samePacketIdFilter(server.packetIds, wanted)) return;
    if (!server.mutable) {
      // Entries filter on the page, so a server filter that covers the union
      // serves every one of them.
      if (server.known && packetIdFilterCovers(server.packetIds, wanted)) return;
      const message = `Bridge subscription ${subscriptionId} cannot change its packet-ID ` +
        'filter without rejoining, and the requested list needs packets it does not forward';
      if (requireCoverage) throw makeMulticastError('capability-unsupported', message);
      console.warn(`${TAG} ${message}`);
      return;
    }
    if (!wanted) warnIfPacketIdUnionOverCap([...entries].map((entry) => entry.transportOpts.packetIds));
    let applied;
    try {
      applied = await this._sendSetPacketIds(subscriptionId, wanted ? [...wanted] : []);
    } catch (error) {
      // Only a report about this subscription, and none newer, describes it.
      const current = this._serverPacketIdFilters.get(subscriptionId) === server &&
        !packetIdReportSupersedes(server.reportSeq, error?.packetIdReportSeq);
      if (error?.code !== 'capability-unsupported') {
        // No answer (a timeout): the server may have applied the list or not.
        // Its filter is unknown until a later change re-sends one.
        if (!error?.code && current) server.known = false;
        throw error;
      }
      // The server can advertise a replaceable filter and still be unable to
      // replace this one (the IWA after evicting the stream's consumer). It
      // keeps its filter; treat it like an older server from here on.
      if (current) server.mutable = false;
      if (requireCoverage || !(server.known && packetIdFilterCovers(server.packetIds, wanted))) {
        if (requireCoverage) throw error;
        console.warn(`${TAG} ${error.message}`);
      }
      return;
    }
    if (this._serverPacketIdFilters.get(subscriptionId) === server &&
        !packetIdReportSupersedes(server.reportSeq, applied.reportSeq)) {
      server.known = true;
      server.packetIds = packetIdFilter(applied.packetIds);
      server.reportSeq = applied.reportSeq;
    }
  }

  async _setEntryPacketIds(entry, packetIds) {
    const normalized = normalizeSetPacketIds(packetIds);
    // The entry's list changes inside the serialized step, so an overlapping
    // call cannot have its applied list rolled back by an earlier failure.
    return this._serializePacketIdFilterChange(this._packetIdFilterChainKey(entry), async () => {
      const subscriptionId = entry.subscriptionId;
      if (!subscriptionId || !this._desiredSubscriptions.get(subscriptionId)?.has(entry)) {
        throw makeMulticastError('subscription-failed', 'Bridge subscription is not active');
      }
      // Refused outright: a list cannot be satisfied by the server, which
      // forwards the stream whole, nor by the page, which has no packet IDs
      // to filter it by.
      if (!this._packetIdsApply(entry)) throw mpegTsPacketIdRefusal(`Bridge subscription ${subscriptionId}`);
      const previous = entry.transportOpts.packetIds;
      // A narrowing asks for no packet the entry was not already asking for,
      // so its page filter satisfies it even where the server cannot replace
      // its filter or reports none.
      const narrowing = packetIdFilterCovers(packetIdFilter(previous), packetIdFilter(normalized));
      if (normalized.length > 0) entry.transportOpts.packetIds = normalized;
      else delete entry.transportOpts.packetIds;
      // Delivery follows the new list before the server does: a widening must
      // not drop the first packets the server forwards for it.
      this._applyEntryPacketIdFilter(entry);
      try {
        const reached = await this._reconcilePacketIdFilterNow(subscriptionId, { requireCoverage: !narrowing });
        // null: the list never reached the bridge, so the receiver's filter is
        // unchanged and the consumer must not record it as applied. The
        // reconnect replay sends the entry's list once the subscription is
        // back. undefined stays reserved for a server that reports no filter.
        if (reached === false) return null;
        const applied = this._serverPacketIdFilters.get(subscriptionId);
        return applied?.known ? [...(applied.packetIds || [])] : undefined;
      } catch (error) {
        if (previous === undefined) delete entry.transportOpts.packetIds;
        else entry.transportOpts.packetIds = previous;
        this._applyEntryPacketIdFilter(entry);
        // Unanswered, the request may still have been applied: send the
        // restored lists once, so the server does not keep forwarding a list
        // the page has just withdrawn.
        if (!error?.code) {
          this._reconcilePacketIdFilter(subscriptionId, { requireCoverage: false }).catch((reconcileError) => {
            console.warn(
              `${TAG} Failed to restore the packet-ID filter of ${subscriptionId}:`,
              reconcileError?.message || reconcileError,
            );
          });
        }
        throw error?.code ? error : makeMulticastError(
          'subscription-failed',
          error?.message || 'Bridge packet-ID filter update failed',
          error,
        );
      }
    });
  }

  /**
   * Send `set_packet_ids` and resolve with the filter the server reports and
   * the response's arrival order; a refusal carries that order too.
   */
  async _sendSetPacketIds(subscriptionId, packetIds) {
    const response = await this._requestControl({
      type: 'set_packet_ids',
      subscription_id: subscriptionId,
      packet_ids: packetIds,
    });
    const reportSeq = this._packetIdReportOrder.get(response);
    if (!response?.success) {
      const error = makeMulticastError(
        response?.code === 'capability-unsupported' ? 'capability-unsupported' : 'subscription-failed',
        response?.error || `Bridge refused the packet-ID filter for ${subscriptionId}`,
      );
      error.packetIdReportSeq = reportSeq;
      throw error;
    }
    return {
      packetIds: Array.isArray(response.packet_ids) ? response.packet_ids : packetIds,
      reportSeq,
    };
  }

  async unsubscribe(subscriptionId) {
    const desired = this._desiredSubscriptions.get(subscriptionId);
    return this._unsubscribeEntries(subscriptionId, desired ? [...desired] : []);
  }

  async _sendUnsubscribeRequest(
    subscriptionId,
    {
      allowTimeout = false,
      transport = this._wt,
      generation = this._controlWriteGeneration,
    } = {},
  ) {
    const ownsRequest = () => this.connected &&
      (transport === null || this._wt === transport) &&
      this._controlWriteGeneration === generation;
    if (!this.connected ||
        (transport !== null && this._wt !== transport) ||
        this._controlWriteGeneration !== generation) {
      throw new DOMException('WebTransport connection superseded', 'AbortError');
    }
    const requestId = generateRequestId();
    let pending;
    const response = new Promise((resolve, reject) => {
      pending = {
        resolve,
        reject: allowTimeout ? resolve : reject,
      };
      this.pendingRequests.set(requestId, pending);
    });
    let timeoutId;
    const deadline = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        if (this.pendingRequests.get(requestId) !== pending) return;
        this.pendingRequests.delete(requestId);
        if (allowTimeout) {
          resolve();
        } else {
          reject(new Error(`Unsubscribe ${subscriptionId} timed out without acknowledgement`));
        }
      }, UNSUBSCRIBE_TIMEOUT);
    });

    try {
      let writeSettled = false;
      const write = this._sendControlWithWriteAck({
        type: 'unsubscribe',
        request_id: requestId,
        subscription_id: subscriptionId,
      }).finally(() => {
        writeSettled = true;
      });
      // Attach handlers to both operations before awaiting either one. A
      // backpressured writer can otherwise outlive the response timer and leave
      // its rejection unobserved while replay cleanup remains blocked forever.
      const acknowledged = await Promise.race([
        Promise.all([write, response]).then(() => true),
        deadline.then(() => false),
      ]);
      if (!ownsRequest()) return;
      // Ordinary teardown may ignore a missing server response once the write
      // is complete, but it cannot leave a queued unsubscribe able to reach
      // this transport after ownership recovery has finished. Retiring the
      // transport rejects that stale write and replays any replacement owner.
      if (!acknowledged && allowTimeout && !writeSettled && this.connected) {
        this._handleDisconnect({ forceReconnect: true });
      }
    } finally {
      clearTimeout(timeoutId);
      if (this.pendingRequests.get(requestId) === pending) {
        this.pendingRequests.delete(requestId);
      }
    }
  }

  async _unsubscribeEntries(subscriptionId, entriesToRemove) {
    const desired = this._desiredSubscriptions.get(subscriptionId);
    if (!desired) return;

    const removedEntries = entriesToRemove.filter((entry) => desired.delete(entry));
    if (removedEntries.length === 0) return;
    if (desired.size > 0) {
      // The remaining entries may need fewer packets: narrow to their union.
      this._reconcilePacketIdFilter(subscriptionId, { requireCoverage: false }).catch((error) => {
        console.warn(`${TAG} Failed to narrow packet-ID filter of ${subscriptionId}:`, error?.message || error);
      });
      return;
    }

    const controlWriteGeneration = this._controlWriteGeneration;
    const callbacks = this.subscriptionCallbacks.get(subscriptionId);
    const wasActive = this.activeSubscriptions.has(subscriptionId);
    const streamSubscriptions = [...this._streamSubscriptions]
      .filter(([, mappedSubId]) => mappedSubId === subscriptionId);

    this.subscriptionCallbacks.delete(subscriptionId);
    this.activeSubscriptions.delete(subscriptionId);
    this._desiredSubscriptions.delete(subscriptionId);
    const serverPacketIdFilter = this._serverPacketIdFilters.get(subscriptionId);
    this._serverPacketIdFilters.delete(subscriptionId);
    for (const [streamIndex, mappedSubId] of this._streamSubscriptions) {
      if (mappedSubId === subscriptionId) this._streamSubscriptions.delete(streamIndex);
    }

    if (!this.connected) return;

    // Ordinary local teardown is best-effort: the desired ownership has
    // already been removed, so an absent acknowledgement must not keep the
    // caller open indefinitely. Cancelled replay cleanup uses the strict
    // default because an unconfirmed orphan requires transport retirement.
    let teardownOrdinal;
    try {
      teardownOrdinal = await this._trackServerTeardown(
        removedEntries,
        this._sendUnsubscribeRequest(subscriptionId, { allowTimeout: true }),
      );
    } catch (error) {
      // Restore local ownership after an ordinary write failure so the caller
      // keeps its subscription and may retry. The rejected write latched this
      // session's control writer dead (`_drainControlWrites` drops
      // `_bidiWriter`), so a retry on this session fails closed until the
      // next reconnect replays the restored entry. A control reset advances the
      // generation before rejecting the write acknowledgement; disconnect
      // also clears the client maps and shared registry. Never resurrect that
      // stale connection state after either lifecycle transition.
      if (this.connected && this._controlWriteGeneration === controlWriteGeneration) {
        let restoredEntries = this._desiredSubscriptions.get(subscriptionId);
        if (!restoredEntries) {
          restoredEntries = desired;
          this._desiredSubscriptions.set(subscriptionId, restoredEntries);
        }
        for (const entry of removedEntries) restoredEntries.add(entry);
        if (serverPacketIdFilter && !this._serverPacketIdFilters.has(subscriptionId)) {
          this._serverPacketIdFilters.set(subscriptionId, serverPacketIdFilter);
        }
        this.subscriptionCallbacks.set(
          subscriptionId,
          restoredEntries === desired && callbacks
            ? callbacks
            : this._createSubscriptionFanout(restoredEntries),
        );
        if (wasActive) this.activeSubscriptions.add(subscriptionId);
        for (const [streamIndex, mappedSubId] of streamSubscriptions) {
          this._streamSubscriptions.set(streamIndex, mappedSubId);
        }
      }
      throw error;
    }
    // The release is complete once the server teardown settles. The
    // replacement backstop runs detached: it drains every in-flight
    // subscribe, and a caller that awaits this release before subscribing
    // again (the page registry, a subscription pool) must not wait on
    // unrelated joins. A join sent from here on is ordered after the teardown,
    // so the backstop ignores it.
    this._recoverSubscriptionReplacedDuringTeardown(subscriptionId, null, teardownOrdinal)
      .catch((error) => {
        console.error(`${TAG} Replacement check after unsubscribing ${subscriptionId} failed:`, error);
      });
  }

  /**
   * Publish one bounded per-track FEC snapshot to the IWA diagnostics UI.
   * This is control-plane telemetry only: a missing/disconnected bridge returns
   * false and never changes media delivery or subscription state.
   */
  reportFecDiagnostics(snapshot) {
    if (!this.connected || this.activeSubscriptions.size === 0) return false;
    if (!snapshot || typeof snapshot !== 'object') {
      console.warn(`${TAG} Ignoring malformed FEC diagnostics snapshot`);
      return false;
    }
    this._sendControl({
      type: 'subscription_diagnostics',
      subscription_ids: [...this.activeSubscriptions],
      fec_track: snapshot,
    });
    return true;
  }

  async _replayActiveSubscriptions(transport = this._wt) {
    if (this._desiredSubscriptions.size === 0) return;

    const replayTransport = transport;
    const replayGeneration = this._controlWriteGeneration;
    const ownsReplay = () => this.connected &&
      this._controlWriteGeneration === replayGeneration &&
      (replayTransport === null || this._wt === replayTransport);
    if (!ownsReplay()) return;

    const entries = [...this._desiredSubscriptions.entries()];
    const replayedEntrySets = new Set();
    this._streamSubscriptions.clear();
    this._streamMetadataWarnings.clear();
    this._streamMetadataSources.clear();
    console.log(`${TAG} Replaying ${entries.length} multicast subscription(s) after WT connect`);

    for (const [oldSubscriptionId, subscriptionEntries] of entries) {
      if (!ownsReplay()) return;
      if (
        replayedEntrySets.has(subscriptionEntries) ||
        this._desiredSubscriptions.get(oldSubscriptionId) !== subscriptionEntries ||
        subscriptionEntries.size === 0
      ) {
        continue;
      }
      const entry = subscriptionEntries.values().next().value;
      if (!entry) continue;
      const replayKey = this._packetIdFilterChainKey(entry);
      let settleReplay;
      const replayed = new Promise((resolve) => { settleReplay = resolve; });
      this._packetIdReplays.set(replayKey, replayed);
      try {
        // The replacement server subscription must forward what every entry
        // sharing it asked for, not just the first entry's list.
        const union = this._desiredPacketIdFilter(subscriptionEntries);
        const subscribeResult = await this._sendSubscribeRequest(
          { ...entry, subscribePacketIds: union ? [...union] : undefined },
          { transport: replayTransport, generation: replayGeneration },
        );
        if (!ownsReplay()) return;
        // Subscribe responses carry the resolved server id (and optional
        // transport metadata) as an object, just like the initial
        // subscribe() path. Keep replay ownership keyed by the id itself;
        // storing the whole response object here makes stream-index delivery
        // impossible after a reconnect.
        const subscriptionId = typeof subscribeResult === 'string'
          ? subscribeResult
          : subscribeResult?.subscriptionId;
        if (!subscriptionId) {
          throw new Error('Bridge subscription replay returned no subscription id');
        }
        // The old desired entry is the replay's cancellation token. A final
        // unsubscribe may remove it while the replacement subscribe is in
        // flight; never resurrect that entry when the late response arrives.
        if (
          this._desiredSubscriptions.get(oldSubscriptionId) !== subscriptionEntries ||
          subscriptionEntries.size === 0
        ) {
          // A replacement can already be joining without having a server ID to
          // publish in desired state. Let those joins install ownership before
          // deciding whether this stale replay response must be discarded.
          // Re-check on resuming: a held join released by its teardown can
          // send in the tick after the drain's last check, and an orphan
          // unsubscribe sent behind it would remove its membership.
          do await this._drainPendingSubscriptions();
          while (this._pendingSubscriptions.size > 0);
          if (!ownsReplay()) return;
          if (this._desiredSubscriptions.get(subscriptionId)?.size > 0) continue;

          for (const [streamIndex, mappedSubId] of this._streamSubscriptions) {
            if (mappedSubId === subscriptionId) this._streamSubscriptions.delete(streamIndex);
          }

          try {
            // This response has no logical owner. Teardown must only target the
            // server subscription: a replacement may publish the same stable ID
            // while the control response is in flight.
            if (!ownsReplay()) return;
            // Tracked like a final unsubscribe, so a same-id join waits for it
            // instead of racing it and forcing the reset below.
            const orphanOrdinal = await this._trackServerTeardown(
              [entry],
              this._sendUnsubscribeRequest(subscriptionId, {
                transport: replayTransport,
                generation: replayGeneration,
              }),
            );
            if (!ownsReplay()) return;
            // The server de-duplicates a stable subscription ID rather than
            // reference-counting subscribe requests. If replacement ownership
            // appeared before this unsubscribe settled, the server entry it
            // depended on may now be gone even though local ownership survived.
            // Drain responses that raced cleanup, then retire this transport so
            // reconnect replay creates a confirmed server subscription.
            await this._recoverSubscriptionReplacedDuringTeardown(
              subscriptionId,
              ownsReplay,
              orphanOrdinal,
            );
            if (!ownsReplay()) return;
          } catch (cleanupError) {
            if (!ownsReplay()) return;
            console.warn(
              `${TAG} Failed to unsubscribe cancelled replay ${subscriptionId}:`,
              cleanupError?.message || cleanupError,
            );
            // The replacement exists server-side but has no logical owner. If
            // its teardown cannot be confirmed, retire the transport so it
            // cannot survive as an untracked subscription. Other desired
            // subscriptions remain available for the next reconnect replay.
            if (ownsReplay() && this.connected) this._handleDisconnect();
          }
          continue;
        }

        let replayedEntries = subscriptionEntries;
        if (subscriptionId !== oldSubscriptionId) {
          if (this._desiredSubscriptions.get(oldSubscriptionId) === subscriptionEntries) {
            this._desiredSubscriptions.delete(oldSubscriptionId);
          }
          const existingEntries = this._desiredSubscriptions.get(subscriptionId);
          if (existingEntries && existingEntries !== subscriptionEntries) {
            for (const desiredEntry of subscriptionEntries) existingEntries.add(desiredEntry);
            replayedEntries = existingEntries;
          } else {
            this._desiredSubscriptions.set(subscriptionId, subscriptionEntries);
          }
          this.activeSubscriptions.delete(oldSubscriptionId);
          this.subscriptionCallbacks.delete(oldSubscriptionId);
        }
        replayedEntrySets.add(subscriptionEntries);
        replayedEntrySets.add(replayedEntries);
        const replayDelivery = normalizeMulticastDelivery(subscribeResult?.delivery);
        for (const desiredEntry of replayedEntries) {
          desiredEntry.subscriptionId = subscriptionId;
          // A consumer committed to the declaration it read at join time. A
          // replacement server that declares differently cannot retract it,
          // so make the mismatch visible rather than silently changing it.
          if (desiredEntry.delivery !== replayDelivery) {
            console.warn(
              `${TAG} Replayed subscription ${subscriptionId} declares delivery ` +
                `${String(replayDelivery)}, but it was joined as ${String(desiredEntry.delivery)}`,
            );
          }
        }
        this.activeSubscriptions.add(subscriptionId);
        this._recordServerPacketIdFilter(subscriptionId, subscribeResult, union ? [...union] : undefined);
        const fanout = this._createSubscriptionFanout(replayedEntries);
        this.subscriptionCallbacks.set(subscriptionId, fanout);
        fanout.ontransportstate('connected');
        // An entry that joined, or merged in, while this subscribe was in
        // flight is not in the union it carried: bring the server to it now.
        if (!samePacketIdFilter(this._desiredPacketIdFilter(replayedEntries), union)) {
          this._reconcilePacketIdFilter(subscriptionId, { requireCoverage: false }).catch((error) => {
            console.warn(
              `${TAG} Failed to reconcile the packet-ID filter of ${subscriptionId} after replay:`,
              error?.message || error,
            );
          });
        }
      } catch (error) {
        if (!ownsReplay()) return;
        const err = new Error(error?.message || 'Bridge subscription replay failed');
        err.code = error?.code || 'subscription-failed';
        console.warn(`${TAG} Failed to replay ${oldSubscriptionId}:`, err.message);
        if (
          this._desiredSubscriptions.get(oldSubscriptionId) === subscriptionEntries &&
          subscriptionEntries.size > 0
        ) {
          this._createSubscriptionFanout(subscriptionEntries).onerror(err);
        }
      } finally {
        if (this._packetIdReplays.get(replayKey) === replayed) this._packetIdReplays.delete(replayKey);
        settleReplay();
      }
    }
  }

  async _requestControl(msg, timeoutMs = SUBSCRIBE_TIMEOUT) {
    if (!this.connected) {
      throw new Error('Not connected to bridge');
    }

    const requestId = generateRequestId();
    const promise = new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error(`${msg.type || 'Control'} timeout`));
        }
      }, timeoutMs);
    });

    this._sendControl({ ...msg, request_id: requestId });
    return promise;
  }

  tunerStatus(options = {}) {
    return this._requestControl({
      type: 'tuner_status',
      include_signal: options?.includeSignal === true || options?.include_signal === true,
    }).then((response) => {
      this._lastTunerStatus = response;
      return response;
    });
  }

  tunerTune(options = {}) {
    if (typeof options === 'number') {
      options = { freqKHz: options };
    }
    if (!options || typeof options !== 'object') {
      options = {};
    }
    const freqKHz = Number(
      options.freqKHz ??
      options.frequencyKHz ??
      options.freq_khz ??
      options.frequency_khz
    );
    const mode = options.mode ?? 'atsc3';
    const plpId = options.plpId ?? options.plp_id;
    const msg = {
      type: 'tuner_tune',
      freq_khz: freqKHz,
      mode,
    };
    if (plpId !== undefined) msg.plp_id = Number(plpId);
    return this._requestControl(msg);
  }

  tunerSetPlp(options = {}) {
    const plpId = typeof options === 'number'
      ? options
      : Array.isArray(options)
        ? options[0]
        : options.plpId ?? options.plp_id;
    return this._requestControl({
      type: 'tuner_set_plp',
      plp_id: Number(plpId),
    });
  }

  // ── Private: Control ──

  /**
   * Send a JSON control message over the WebTransport bidi stream
   * (length-prefixed frame).
   *
   * Returns whether the frame was ENQUEUED, which is not the same as sent. For
   * `media_progress`, `meta.reportMediaFrames` / `meta.reportDatagramFrames`
   * carry the counter values the caller wants committed once the write
   * actually resolves; they never reach the wire.
   */
  _sendControl(msg, meta = null) {
    if (this._transport !== 'webtransport' || !this._bidiWriter) return false;

    if (msg?.type === 'media_progress') {
      const deliveredFrames = Number(msg.delivered_frames);
      // Cumulative-since-connect counters only, so coalescing by per-field
      // Math.max is lossless: for snapshots at t1 < t2, max(a, b) === b. A
      // delta or a rate here would silently undercount when coalesced.
      const hasDatagramProgress = Object.hasOwn(msg, 'dg');
      const datagramFrames = Number(msg.dg?.rx ?? 0);
      const datagramVersion = Number(msg.dg?.v ?? 0);
      const datagramSendWatermark = Number(msg.dg?.tx ?? 0);
      const datagramSequencedFrames = Number(msg.dg?.sx ?? 0);
      // The freeze latches on the client and can never clear without a
      // reconnect, so OR-ing it is the correct coalescing rule: a batch that
      // contains any frozen snapshot is frozen. This must be carried on the
      // entry, not just on `msg` — `_drainControlWrites` re-encodes the frame
      // from the entry, so any field missing here never reaches the wire.
      const datagramFrozen = msg.dg?.fz === 1;
      if (this._queuedMediaProgress) {
        this._queuedMediaProgress.mediaProgress = Math.max(
          this._queuedMediaProgress.mediaProgress,
          deliveredFrames,
        );
        this._queuedMediaProgress.hasDatagramProgress =
          this._queuedMediaProgress.hasDatagramProgress || hasDatagramProgress;
        this._queuedMediaProgress.datagramProgress = Math.max(
          this._queuedMediaProgress.datagramProgress,
          datagramFrames,
        );
        this._queuedMediaProgress.datagramVersion = Math.max(
          this._queuedMediaProgress.datagramVersion,
          datagramVersion,
        );
        this._queuedMediaProgress.datagramSendWatermark = Math.max(
          this._queuedMediaProgress.datagramSendWatermark,
          datagramSendWatermark,
        );
        this._queuedMediaProgress.datagramSequencedFrames = Math.max(
          this._queuedMediaProgress.datagramSequencedFrames,
          datagramSequencedFrames,
        );
        this._queuedMediaProgress.datagramFrozen =
          this._queuedMediaProgress.datagramFrozen || datagramFrozen;
        // Deferred report targets coalesce the same way. Whichever snapshot
        // this batch ends up carrying, committing the highest is correct
        // because every counter here is cumulative-since-connect.
        this._queuedMediaProgress.reportMediaFrames = Math.max(
          this._queuedMediaProgress.reportMediaFrames,
          Number(meta?.reportMediaFrames ?? 0),
        );
        this._queuedMediaProgress.reportDatagramFrames = Math.max(
          this._queuedMediaProgress.reportDatagramFrames,
          Number(meta?.reportDatagramFrames ?? 0),
        );
        this._debugStats.wtControlMessagesCoalesced++;
        return true;
      }
      const entry = {
        mediaProgress: deliveredFrames,
        hasDatagramProgress,
        datagramProgress: datagramFrames,
        datagramVersion,
        datagramSendWatermark,
        datagramSequencedFrames,
        datagramFrozen,
        reportMediaFrames: Number(meta?.reportMediaFrames ?? 0),
        reportDatagramFrames: Number(meta?.reportDatagramFrames ?? 0),
        telemetry: 'media_progress',
      };
      this._queuedMediaProgress = entry;
      this._controlWriteQueue.push(entry);
    } else {
      const telemetry = controlTelemetryKey(msg);
      if (telemetry) {
        // Periodic telemetry describes current state, so only the newest
        // snapshot per key is worth sending. Coalescing bounds the queue at
        // one entry per key: without it, a stalled writer let FEC diagnostics
        // and keepalives pile up without limit (58475 queued frames on-device,
        // BLO-35598) with every later subscribe/unsubscribe behind them.
        const queued = this._queuedTelemetry.get(telemetry);
        if (queued) {
          queued.frame = this._encodeControlFrame(msg);
          this._debugStats.wtControlMessagesCoalesced++;
          return true;
        }
        const entry = { frame: this._encodeControlFrame(msg), telemetry };
        this._queuedTelemetry.set(telemetry, entry);
        this._controlWriteQueue.push(entry);
      } else {
        // Requests (subscribe, unsubscribe, tuner, hello, visibility) go ahead
        // of every queued telemetry frame, so subscription control can never
        // wait behind media-progress or diagnostics traffic. Requests keep
        // their order relative to each other.
        const entry = {
          frame: this._encodeControlFrame(msg),
          ...(meta?.writeOutcome ? { writeOutcome: meta.writeOutcome } : {}),
        };
        const firstTelemetry = this._controlWriteQueue.findIndex(
          (queued) => queued.telemetry !== undefined,
        );
        if (firstTelemetry === -1) this._controlWriteQueue.push(entry);
        else this._controlWriteQueue.splice(firstTelemetry, 0, entry);
      }
    }

    this._debugStats.wtControlQueueDepthMax = Math.max(
      this._debugStats.wtControlQueueDepthMax,
      this._controlWriteQueue.length,
    );
    void this._drainControlWrites(this._controlWriteGeneration);
    return true;
  }

  _sendControlWithWriteAck(msg) {
    return new Promise((resolve, reject) => {
      const queued = this._sendControl(msg, {
        writeOutcome: { resolve, reject },
      });
      if (!queued) reject(new Error('Bridge control channel unavailable'));
    });
  }

  _encodeControlFrame(msg) {
    const encoded = new TextEncoder().encode(JSON.stringify(msg));
    const frame = new Uint8Array(4 + encoded.length);
    new DataView(frame.buffer).setUint32(0, encoded.length, true);
    frame.set(encoded, 4);
    return frame;
  }

  async _drainControlWrites(generation) {
    if (this._controlWritePumping || generation !== this._controlWriteGeneration) return;
    this._controlWritePumping = true;
    let inFlightEntry = null;
    // Captured so the catch can tell "the writer I was using died" from "a
    // late rejection arrived after a reconnect installed a replacement".
    let activeWriter = null;

    try {
      while (generation === this._controlWriteGeneration &&
             this._controlWriteQueue.length > 0) {
        const writer = this._bidiWriter;
        if (this._transport !== 'webtransport' || !writer) {
          const error = new Error('Bridge control channel unavailable');
          for (const queuedEntry of this._controlWriteQueue.splice(0)) {
            queuedEntry.writeOutcome?.reject(error);
          }
          this._queuedMediaProgress = null;
          this._queuedTelemetry.clear();
          return;
        }
        activeWriter = writer;

        const entry = this._controlWriteQueue.shift();
        inFlightEntry = entry;
        this._controlWriteInFlight = entry;
        if (entry === this._queuedMediaProgress) this._queuedMediaProgress = null;
        if (entry.telemetry !== undefined &&
            this._queuedTelemetry.get(entry.telemetry) === entry) {
          this._queuedTelemetry.delete(entry.telemetry);
        }
        const frame = entry.frame ?? this._encodeControlFrame({
          type: 'media_progress',
          delivered_frames: entry.mediaProgress,
          ...(entry.hasDatagramProgress ? {
            dg: {
              ...(entry.datagramVersion > 0 ? { v: entry.datagramVersion } : {}),
              rx: entry.datagramProgress,
              ...(entry.datagramVersion > 0 ? {
                tx: entry.datagramSendWatermark,
                sx: entry.datagramSequencedFrames,
              } : {}),
              // The frame is re-encoded HERE, from the entry — anything the
              // caller put on the original message and not on the entry is
              // silently dropped before it reaches the transport.
              ...(entry.datagramFrozen ? { fz: 1 } : {}),
            },
          } : {}),
        });
        this._debugStats.wtControlMessagesSent++;
        this._debugStats.wtLastControlSentAt = Date.now();
        if (entry.mediaProgress !== undefined) {
          this._debugStats.wtMediaProgressMessagesSent++;
          this._debugStats.wtLastMediaProgressAt = Date.now();
        }
        await writeControlFrameWithDeadline(writer, frame);
        // Confirmed ON THE WIRE, as distinct from the `wtControlMessagesSent`
        // above, which counts frames handed to a writer that may be errored.
        // Generation-guarded so a write resolving after a reconnect cannot
        // credit the new session. Telemetry only: this must never gate the
        // re-announcement bound, because a write that never settles (a stalled
        // sink under backpressure) leaves this counter pinned at zero, and a
        // loop keyed to it would then run forever.
        if (generation === this._controlWriteGeneration) {
          this._debugStats.wtControlFramesWritten++;
          if (entry.datagramVersion > 0) {
            this._datagramCapabilityAnnouncementsWritten++;
          }
          // Only now is the frame genuinely reported. Cumulative counters, so
          // Math.max is safe against any out-of-order commit.
          if (entry.reportMediaFrames) {
            this._mediaFramesReported = Math.max(
              this._mediaFramesReported, entry.reportMediaFrames,
            );
          }
          if (entry.reportDatagramFrames) {
            this._datagramFramesReported = Math.max(
              this._datagramFramesReported, entry.reportDatagramFrames,
            );
          }
        }
        entry.writeOutcome?.resolve();
        entry.writeOutcome = null;
        if (this._controlWriteInFlight === entry) this._controlWriteInFlight = null;
        inFlightEntry = null;
      }
    } catch (e) {
      this._debugStats.wtControlWriteErrors++;
      inFlightEntry?.writeOutcome?.reject(e);
      if (inFlightEntry) inFlightEntry.writeOutcome = null;
      if (this._controlWriteInFlight === inFlightEntry) this._controlWriteInFlight = null;
      // Everything below mutates per-session state, so none of it may run for a
      // rejection that arrives after a reconnect already replaced that state.
      // `_handleDisconnect` bumps the generation and `_openBidiStream` installs
      // a fresh writer, so an unguarded catch here would let writer A's late
      // rejection null writer B and wipe the queue B is draining. The `finally`
      // below has carried this guard all along; the catch had not.
      const superseded = generation !== this._controlWriteGeneration ||
        (activeWriter !== null && this._bidiWriter !== activeWriter);
      if (superseded) {
        this._debugStats.wtControlWriteStaleRejections++;
      } else {
        for (const queuedEntry of this._controlWriteQueue.splice(0)) {
          queuedEntry.writeOutcome?.reject(e);
        }
        this._queuedMediaProgress = null;
        this._queuedTelemetry.clear();
        // A rejected write latches this WritableStream errored, and
        // `_bidiWriter` is assigned exactly once per session
        // (`_openBidiStream` is its sole caller, and `_resetMediaProgress` runs
        // before it), so no replacement writer exists until a reconnect. Every
        // later `write()` therefore rejects from the stored error WITHOUT
        // reaching the transport.
        //
        // Leaving the writer installed makes `_sendControl` keep returning true
        // for frames that can never be sent, which is worse than losing them:
        // every retry aimed at this writer — the capability re-announcement and
        // the datagram heartbeat alike — is encoded, counted, and discarded
        // without a transport call. Drop it so the control path reports itself
        // dead instead; `_sendControl` returns false from here on, which is the
        // truth. Reported counters are committed on write resolution rather
        // than on enqueue, so this frame's progress was never claimed.
        if (this._bidiWriter) {
          this._bidiWriter = null;
          this._debugStats.wtControlWriteDead++;
        }
        // Nothing in the dropped queue reached the server, so the enqueued
        // span is not owed to it. Rewinding to the last RESOLVED report keeps
        // the two counters consistent and leaves a reconnect free to re-send
        // the unconfirmed span from an honest baseline.
        this._mediaFramesEnqueued = this._mediaFramesReported;
        this._datagramFramesEnqueued = this._datagramFramesReported;
        if (e?.code === 'control-write-timeout' && this.connected) {
          this._handleDisconnect({ forceReconnect: true });
        }
      }
      if (this.connected) console.warn(`${TAG} Bidi write error:`, e.message);
    } finally {
      if (generation === this._controlWriteGeneration) {
        this._controlWritePumping = false;
        if (this._controlWriteQueue.length > 0 && this._bidiWriter) {
          void this._drainControlWrites(generation);
        }
      }
    }
  }

  _resetControlWrites() {
    const error = new Error('Bridge control channel reset');
    this._controlWriteInFlight?.writeOutcome?.reject(error);
    if (this._controlWriteInFlight) this._controlWriteInFlight.writeOutcome = null;
    this._controlWriteInFlight = null;
    for (const queuedEntry of this._controlWriteQueue) {
      queuedEntry.writeOutcome?.reject(error);
    }
    this._controlWriteGeneration++;
    this._controlWriteQueue.length = 0;
    this._queuedMediaProgress = null;
    this._queuedTelemetry.clear();
    this._controlWritePumping = false;
  }

  _handleControlMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) {
      console.warn(`${TAG} Unparseable control message: ${text.substring(0, 100)}`, e.message);
      return;
    }
    this._markControlActivity();

    if (msg.type === 'subscribe_response') {
      const pending = this.pendingRequests.get(msg.request_id);
      if (!pending) return;
      this.pendingRequests.delete(msg.request_id);
      if (msg.success) {
        this._markSubscriptionProgress();
        if (msg.subscription_id && Number.isInteger(msg.stream_index)) {
          this._streamSubscriptions.set(msg.stream_index, msg.subscription_id);
        }
        const delivery = normalizeMulticastDelivery(msg.delivery);
        const result = {
          subscriptionId: msg.subscription_id,
          transport: normalizeResolvedMulticastTransport(msg.transport),
          ...(delivery === undefined ? {} : { delivery }),
          // The filter in force (the existing one on a duplicate subscribe)
          // and whether set_packet_ids can replace it. Absent from servers
          // that predate set_packet_ids. `packet_ids_mutable: false` alone
          // declares a subscription with no packet-ID filter to replace (a
          // payload that is not MMTP), which absence must not be read as.
          ...(Array.isArray(msg.packet_ids)
            ? { packetIds: [...msg.packet_ids], packetIdsMutable: msg.packet_ids_mutable === true }
            : msg.packet_ids_mutable === false ? { packetIdsMutable: false } : {}),
        };
        this._packetIdReportOrder.set(result, ++this._packetIdReportSeq);
        pending.resolve(result);
      } else {
        // BLO-35597: the native bridge types an open failure (for example
        // `amt_relay_refused` when an AMT relay answers the tunnel Request
        // with ICMP). Carry the code the same way the `subscribe_error` push
        // below does, so the page can tell a refusal from a generic failure.
        const err = new Error(msg.error || 'Subscribe failed');
        if (msg.code) err.code = msg.code;
        pending.reject(err);
      }
    } else if (msg.type === 'subscription_transport' && msg.subscription_id) {
      const transport = normalizeResolvedMulticastTransport(msg.transport);
      const entries = this._desiredSubscriptions.get(msg.subscription_id);
      if (!transport || !entries) return;
      for (const entry of entries) entry.transport = transport;
      this._invokeSubscriptionCallback(
        this.subscriptionCallbacks.get(msg.subscription_id),
        'ontransportchange',
        transport,
      );
    } else if (msg.type === 'unsubscribe_response') {
      const pending = this.pendingRequests.get(msg.request_id);
      if (pending) {
        this.pendingRequests.delete(msg.request_id);
        pending.resolve();
      }
    } else if (msg.type === 'set_packet_ids_response') {
      const pending = this.pendingRequests.get(msg.request_id);
      if (pending) {
        this.pendingRequests.delete(msg.request_id);
        this._packetIdReportOrder.set(msg, ++this._packetIdReportSeq);
        pending.resolve(msg);
      }
    } else if (msg.type === 'tuner_response') {
      const pending = this.pendingRequests.get(msg.request_id);
      if (pending) {
        this.pendingRequests.delete(msg.request_id);
        pending.resolve(msg);
      }
    } else if ((msg.type === 'error' || msg.type === 'subscribe_error') && msg.subscription_id) {
      // BLO-9769/BLO-9413: the IWA's failure push is `subscribe_error`
      // (sendSubscribeError — sent both when the initial subscribe pipeline
      // throws and, with code='transport-failed', when an established
      // transport like the AMT tunnel dies later). This handler previously
      // parsed only `error`, so those pushes were dropped as "Unknown message
      // type" and the player waited forever on a dead subscription instead of
      // failing back. Route both message types into the same onerror path.
      const cbs = this.subscriptionCallbacks.get(msg.subscription_id);
      const err = new Error(msg.error || 'Unknown error');
      if (msg.code) err.code = msg.code;
      console.warn(`${TAG} Bridge reported ${msg.type} for ${msg.subscription_id}${msg.code ? ` (${msg.code})` : ''}: ${msg.error}`);
      this._invokeSubscriptionCallback(cbs, 'onerror', err);
    } else if (msg.type === 'datagram_send_progress' &&
               Number(msg.dg?.v) === WT_DATAGRAM_DELIVERY_VERSION) {
      this._noteDatagramSendWatermark(Number(msg.dg?.tx));
    } else if (msg.type === 'certificate_rotation') {
      // The bridge announces its upcoming certificate so a persisted pairing
      // survives the swap. Shape-tolerant on purpose: the producing half is not
      // deployed everywhere yet, and an unusable announcement must leave the
      // existing pairing alone rather than replace it with nothing.
      const announced = normalizeHashes(msg.hashes ?? [msg.current, msg.next]);
      if (announced.length > 0) {
        // Union with the hashes this session *offered* in
        // `serverCertificateHashes`. WebTransport does not report which one
        // matched, so when connecting from a pairing this is the whole stored
        // set, and a retired hash stays until the cap evicts it. A producer
        // that sends only [next] would otherwise discard the still-valid
        // current hash and strand the pairing at the next load.
        // Capped because the union is otherwise monotonic across rotations,
        // and every stored hash is offered in the one connect attempt. The cap
        // deliberately wins over retention: announced hashes come first, so a
        // producer announcing ROTATION_MERGE_MAX_HASHES or more evicts the
        // offered set entirely. That is intended, not an oversight -- a
        // producer announcing that many is announcing hashes it will serve.
        // This is also the one path that *shrinks* a record: a pairing won
        // through rendezvous holds up to PAIRING_MAX_HASHES strangers' hashes,
        // and the first announcement from the bridge itself prunes them away.
        const offered = normalizeHashes(this._lastConnectArgs?.options?.fingerprint ?? []);
        const merged = normalizeHashes([...announced, ...offered]).slice(0, ROTATION_MERGE_MAX_HASHES);
        // Re-arm the *live* client too, not just the persisted record.
        // `connect()` writes `_lastConnectArgs.options` once and
        // `_scheduleReconnect` replays it by reference, so a reconnect after
        // the swap would otherwise re-offer the pre-rotation set forever —
        // and while the page holds desired subscriptions `_handleDisconnect`
        // takes the reconnect branch instead of `_onDisconnect`, so nothing
        // re-enters discovery to read the record just refreshed here.
        // Gated because a CA-validated session (AutoTLS/DNS rung,
        // `fingerprint: ''`) must not acquire a pin from an announcement:
        // `connect()` builds the DNS candidate only while `hashes` is empty,
        // so arming one would strip the rung this session is reconnecting on.
        // `offered` is non-empty exactly when the connect was pinned, which
        // also proves `_lastConnectArgs.options` exists to assign to.
        if (offered.length > 0) this._lastConnectArgs.options.fingerprint = merged;
        this._onCertificateRotation?.(merged);
      }
    } else if (msg.type === 'subscription_stream' && msg.subscription_id && Number.isInteger(msg.stream_index)) {
      this._streamSubscriptions.set(msg.stream_index, msg.subscription_id);
      this._markSubscriptionProgress();
    }
  }

  _handleTransportFrame(bytes) {
    this._debugStats.wtTransportFrames++;
    this._debugStats.wtTransportFrameBytes += bytes.byteLength;
    const message = this._acceptChunkFrame(bytes);
    if (message === null) return;
    this._handleStreamMessage(message);
  }

  _acceptChunkFrame(bytes) {
    if (bytes.byteLength < WT_CHUNK_HEADER_BYTES) {
      return bytes;
    }

    if (bytes[0] !== 0x42 || bytes[1] !== 0x43 ||
        bytes[2] !== 0x43 || bytes[3] !== 0x48) {
      return bytes;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== WT_CHUNK_MAGIC) return bytes;
    this._debugStats.wtChunkFrames++;
    if (bytes[4] !== WT_CHUNK_VERSION) {
      this._debugStats.wtChunkDrops++;
      console.warn(`${TAG} Unsupported WT chunk version: ${bytes[4]}`);
      return null;
    }

    const messageId = view.getUint32(6, true);
    const chunkIndex = view.getUint16(10, true);
    const chunkCount = view.getUint16(12, true);
    const totalLength = view.getUint32(14, true);
    const payload = bytes.subarray(WT_CHUNK_HEADER_BYTES);

    if (
      chunkCount === 0 ||
      chunkIndex >= chunkCount ||
      totalLength === 0 ||
      totalLength > WT_CHUNK_MAX_MESSAGE_BYTES
    ) {
      this._debugStats.wtChunkDrops++;
      console.warn(`${TAG} Dropping malformed WT chunk id=${messageId}`);
      this._chunkMessages.delete(messageId);
      return null;
    }

    this._pruneChunkMessages();
    let entry = this._chunkMessages.get(messageId);
    if (!entry) {
      if (this._chunkMessages.size >= WT_CHUNK_MAX_MESSAGES) {
        const oldest = this._chunkMessages.keys().next().value;
        if (oldest !== undefined) this._chunkMessages.delete(oldest);
      }
      entry = {
        totalLength,
        chunkCount,
        chunks: new Array(chunkCount),
        receivedCount: 0,
        receivedBytes: 0,
        expiresAt: Date.now() + WT_CHUNK_TTL_MS,
      };
      this._chunkMessages.set(messageId, entry);
    }

    if (entry.totalLength !== totalLength || entry.chunkCount !== chunkCount) {
      this._debugStats.wtChunkDrops++;
      console.warn(`${TAG} Dropping inconsistent WT chunk id=${messageId}`);
      this._chunkMessages.delete(messageId);
      return null;
    }

    if (!entry.chunks[chunkIndex]) {
      entry.chunks[chunkIndex] = new Uint8Array(payload);
      entry.receivedCount++;
      entry.receivedBytes += payload.byteLength;
    }

    if (entry.receivedCount !== entry.chunkCount) {
      return null;
    }

    this._chunkMessages.delete(messageId);
    if (entry.receivedBytes !== entry.totalLength) {
      this._debugStats.wtChunkDrops++;
      console.warn(`${TAG} Dropping incomplete WT chunked message id=${messageId}`);
      return null;
    }

    const out = new Uint8Array(entry.totalLength);
    let offset = 0;
    for (const chunk of entry.chunks) {
      if (!chunk) return null;
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this._debugStats.wtChunkedMessagesCompleted++;
    return out;
  }

  _pruneChunkMessages() {
    const now = Date.now();
    for (const [id, entry] of this._chunkMessages) {
      if (entry.expiresAt <= now) this._chunkMessages.delete(id);
    }
  }

  _handleStreamMessage(bytes) {
    if (bytes.byteLength < 2) {
      this._debugStats.wtStreamIndexMisses++;
      return;
    }

    const wireStreamIndex = bytes[0] | (bytes[1] << 8);
    const hasMetadata = (wireStreamIndex & WT_STREAM_METADATA_INDEX_FLAG) !== 0;
    const streamIndex = wireStreamIndex & WT_STREAM_METADATA_INDEX_MASK;
    const subId = this._streamSubscriptions.get(streamIndex);
    if (!subId) {
      if (this._streamSubscriptions.size > 0) this._debugStats.wtStreamIndexMisses++;
      return;
    }

    this._debugStats.wtStreamIndexHits++;
    let payloadOffset = 2;
    let receiveTime;
    let receiveTimeOrigin;
    let receiveTimestampSource;
    if (hasMetadata) {
      if (bytes.byteLength < WT_STREAM_METADATA_HEADER_BYTES) {
        this._debugStats.wtStreamMetadataDrops++;
        this._warnStreamMetadataOnce(streamIndex, 'too-short', 'dropping frame: metadata header is too short');
        return;
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const version = view.getUint8(2);
      if (version !== WT_STREAM_METADATA_VERSION) {
        this._debugStats.wtStreamMetadataDrops++;
        this._warnStreamMetadataOnce(
          streamIndex,
          `version-${version}`,
          `dropping frame: unsupported metadata version ${version}`,
        );
        return;
      }
      const flags = view.getUint8(3);
      receiveTime = view.getFloat64(4, true);
      const sourceLen = view.getUint8(12);
      payloadOffset = WT_STREAM_METADATA_HEADER_BYTES + sourceLen;
      if (payloadOffset > bytes.byteLength) {
        this._debugStats.wtStreamMetadataDrops++;
        this._warnStreamMetadataOnce(streamIndex, 'source-length', 'dropping frame: source length exceeds frame');
        return;
      }
      if (sourceLen > 0) {
        receiveTimestampSource = this._streamMetadataSource(
          streamIndex,
          bytes.subarray(WT_STREAM_METADATA_HEADER_BYTES, payloadOffset),
        );
      }
      if ((flags & WT_STREAM_METADATA_FLAG_RECEIVE_TIME_ORIGIN) === 0) {
        this._warnStreamMetadataOnce(
          streamIndex,
          'missing-origin',
          'delivering payload without timing metadata: receiveTimeOrigin is required',
        );
        receiveTime = undefined;
        receiveTimestampSource = undefined;
      } else if (payloadOffset + WT_STREAM_METADATA_RECEIVE_TIME_ORIGIN_BYTES > bytes.byteLength) {
        this._debugStats.wtStreamMetadataDrops++;
        this._warnStreamMetadataOnce(streamIndex, 'truncated-origin', 'dropping frame: receiveTimeOrigin is truncated');
        return;
      } else {
        receiveTimeOrigin = view.getFloat64(payloadOffset, true);
        payloadOffset += WT_STREAM_METADATA_RECEIVE_TIME_ORIGIN_BYTES;
      }
    }
    const payload = bytes.buffer.slice(
      bytes.byteOffset + payloadOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    const cbs = this.subscriptionCallbacks.get(subId);
    if (cbs?.['onpacket'] || cbs?.['onpackets']) {
      this._debugStats.wtPacketsDispatched++;
      this._debugStats.wtPayloadBytes += payload.byteLength;
      this._markSubscriptionProgress();
      const event = new PacketEvent(payload, mmtpPacketIdAt(bytes, payloadOffset));
      if (Number.isFinite(receiveTime)) {
        event.receiveTime = receiveTime;
        if (Number.isFinite(receiveTimeOrigin)) event.receiveTimeOrigin = receiveTimeOrigin;
        event.receiveTimestampSource = receiveTimestampSource || 'kernel-software';
      }
      this._deliverPacket(cbs, event);
    }
  }

  _streamMetadataSource(streamIndex, sourceBytes) {
    const cached = this._streamMetadataSources.get(streamIndex);
    if (cached && bytesEqual(cached.bytes, sourceBytes)) return cached.text;
    const text = STREAM_METADATA_SOURCE_DECODER.decode(sourceBytes);
    this._streamMetadataSources.set(streamIndex, { bytes: sourceBytes.slice(), text });
    return text;
  }

  _warnStreamMetadataOnce(streamIndex, reason, message) {
    const key = `${streamIndex}:${reason}`;
    if (this._streamMetadataWarnings.has(key)) return;
    this._streamMetadataWarnings.add(key);
    console.warn(`${TAG} Stream metadata issue on index ${streamIndex}; ${message}`);
  }

  // ── Private: Lifecycle ──

  _startKeepalive() {
    this._stopKeepalive();
    this._keepaliveTimer = setInterval(() => {
      if (!this.connected) return;
      this._sendControl({
        type: 'keepalive',
        page_url: location.href,
        subscriptions: [...this.activeSubscriptions],
        timestamp: Date.now(),
      });
    }, KEEPALIVE_INTERVAL);
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  _markSubscriptionProgress(now = Date.now()) {
    this._lastSubscriptionProgressAt = now;
    this._debugStats.wtLastPacketAt = now;
  }

  _markControlActivity(now = Date.now()) {
    this._lastControlActivityAt = now;
    this._debugStats.wtLastControlAt = now;
    this._debugStats.wtControlMessagesReceived++;
  }

  _startSubscriptionWatchdog() {
    this._stopSubscriptionWatchdog();
    this._subscriptionWatchdogTimer = setInterval(() => {
      this._checkSubscriptionWatchdog();
    }, WT_SUBSCRIPTION_WATCHDOG_MS);
  }

  _stopSubscriptionWatchdog() {
    if (this._subscriptionWatchdogTimer) {
      clearInterval(this._subscriptionWatchdogTimer);
      this._subscriptionWatchdogTimer = null;
    }
  }

  _checkSubscriptionWatchdog(now = Date.now()) {
    if (!this.connected || this.activeSubscriptions.size === 0) {
      this._markSubscriptionProgress(now);
      return false;
    }

    const lastProgress = this._debugStats.wtLastPacketAt || this._lastSubscriptionProgressAt || now;
    const staleMs = now - lastProgress;
    if (staleMs < WT_SUBSCRIPTION_STALE_MS) return false;

    const lastControl = this._debugStats.wtLastControlAt || this._lastControlActivityAt || 0;
    const controlStaleMs = lastControl > 0 ? now - lastControl : Infinity;
    if (controlStaleMs < WT_SUBSCRIPTION_STALE_MS) {
      this._debugStats.wtSubscriptionWatchdogControlDeferrals++;
      if (now - (this._debugStats.wtLastSubscriptionWatchdogDeferralAt || 0) > 10000) {
        this._debugStats.wtLastSubscriptionWatchdogDeferralAt = now;
        console.warn(`${TAG} No subscription packets for ${staleMs}ms, but control channel was active ${controlStaleMs}ms ago; keeping WebTransport`);
      }
      return false;
    }

    this._debugStats.wtStaleSubscriptionReconnects++;
    console.warn(`${TAG} No subscription packets for ${staleMs}ms; reconnecting WebTransport`);
    const tunerSummary = summarizeTunerStatusForLog(this._lastTunerStatus);
    if (tunerSummary) {
      console.warn(`${TAG} Last tuner status before reconnect: ${JSON.stringify(tunerSummary)}`);
    }
    this._handleDisconnect();
    return true;
  }

  _onPageUnload() {
    for (const subId of this.activeSubscriptions) {
      this._sendControl({
        type: 'unsubscribe',
        request_id: generateRequestId(),
        subscription_id: subId,
      });
    }
    this.disconnect();
  }

  _onPageHidden() {
    if (!this.connected) return;
    this._sendControl({
      type: 'page_visibility',
      visible: false,
      page_url: location.href,
      subscriptions: [...this.activeSubscriptions],
    });
  }

  _handleDisconnect({ forceReconnect = false } = {}) {
    if (this._manualDisconnect) return;
    const wasConnected = this.connected;
    const hasDesiredSubscriptions = this._desiredSubscriptions.size > 0 ||
      this._heldSubscriptions > 0;
    const shouldReconnect = hasDesiredSubscriptions || forceReconnect;
    this.disconnect({
      preserveSubscriptions: hasDesiredSubscriptions,
      notifySubscriptions: false,
      intentional: false,
    });
    if (wasConnected) {
      console.log(`${TAG} Bridge disconnected`);
      if (shouldReconnect && this._lastConnectArgs) {
        if (hasDesiredSubscriptions) {
          for (const [, cbs] of this.subscriptionCallbacks) {
            this._invokeSubscriptionCallback(cbs, 'ontransportstate', 'reconnecting');
          }
        }
        this._scheduleReconnect();
      } else {
        this._onDisconnect?.();
      }
    }
  }

  /**
   * A subscribe is a demand for the bridge, so it re-establishes the session
   * when the client knows how. Without this, a client whose WebTransport
   * session closed while it held no subscriptions (page backgrounded on iOS,
   * network blip) sits at connected=false with its connect arguments intact
   * and nothing scheduled -- a disconnect with no desired subscriptions
   * deliberately does not auto-reconnect -- and the next subscribe() failed
   * closed with "Not connected to bridge" even though the bridge was reachable
   * (measured 2026-09-16: Chrome iOS and desktop Chrome against a Beacon
   * bridge; MOQtail then abandoned the multicast join).
   *
   * Semantics: an in-flight reconnect is joined, a pending backoff timer is
   * superseded by the demand, and a connect failure propagates unchanged so
   * the caller still fails closed. Superseding that timer makes this path a
   * second writer to the reconnect state machine, so on failure it re-arms
   * the backoff it cleared -- and any reconnect a disconnect requested while
   * the attempt was in flight -- through the same epilogue the timer path
   * uses (`_settleReconnectAttempt`): a client that already holds
   * subscriptions keeps retrying in the background exactly as if subscribe()
   * had never been called. A client that holds none and superseded nothing
   * stays put: that disconnect never auto-reconnected, and a refused demand
   * does not change that. A client that was disconnected on purpose
   * (`disconnect()` with intentional=true, the default) stays disconnected:
   * that is teardown, not a lost session, and reviving it here would resurrect
   * a client its owner discarded. A client that never connected has no
   * arguments to reconnect with and is refused the same way.
   *
   * `epoch` is the caller's `_subscriptionEpoch`. A joined attempt whose
   * session dropped every subscription has already reported the loss
   * (`_onDisconnect`), and the page layer abandons the client on that report;
   * connecting it again would open a session nobody owns. So the join is
   * refused before any connect of its own.
   */
  async _ensureConnectedForSubscribe(epoch) {
    if (this.connected) return;
    if (this._reconnectPromise) {
      try { await this._reconnectPromise; } catch { /* the owner of that attempt handles it */ }
      if (this.connected) return;
      if (this._subscriptionEpoch !== epoch) throw new Error('Disconnected');
    }
    if (this._manualDisconnect || !this._lastConnectArgs) {
      throw new Error('Not connected to bridge');
    }
    // Clearing an armed backoff makes this attempt the owner of the retry
    // loop: if it fails, it must re-arm what it took over.
    const supersededBackoff = Boolean(this._reconnectTimer);
    if (supersededBackoff) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const args = this._lastConnectArgs;
    console.log(`${TAG} subscribe() on a closed session; reconnecting to ${args.host} first`);
    const attempt = this.connect(args.host, args.httpPort, args.options);
    this._reconnectPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (supersededBackoff || this._desiredSubscriptions.size > 0) {
        this._reconnectAttempts++;
        console.warn(`${TAG} On-demand bridge reconnect failed; backoff re-armed:`, error?.message || error);
        this._scheduleReconnect();
      }
      throw error;
    } finally {
      this._settleReconnectAttempt(attempt);
    }
    if (!this.connected) {
      throw new Error('Not connected to bridge');
    }
  }

  _scheduleReconnect() {
    if (
      this._manualDisconnect ||
      this._reconnectTimer ||
      !this._lastConnectArgs
    ) return;
    if (this._reconnectPromise) {
      this._reconnectAfterCurrent = true;
      return;
    }

    const delay = Math.min(
      WT_RECONNECT_MAX_DELAY_MS,
      WT_RECONNECT_BASE_DELAY_MS * (2 ** this._reconnectAttempts)
    );
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._manualDisconnect) return;
      const args = this._lastConnectArgs;
      const attempt = this.connect(args.host, args.httpPort, args.options);
      this._reconnectPromise = attempt;
      try {
        await attempt;
        console.log(`${TAG} Bridge reconnected`);
      } catch (error) {
        this._reconnectAttempts++;
        console.warn(`${TAG} Bridge reconnect failed:`, error?.message || error);
        this._scheduleReconnect();
      } finally {
        this._settleReconnectAttempt(attempt);
      }
    }, delay);
  }

  /**
   * Shared epilogue for the two reconnect writers: the backoff timer above and
   * the on-demand path in `_ensureConnectedForSubscribe`. Releases the
   * in-flight promise only if it is still this attempt's (a newer attempt owns
   * its own epilogue), then drains a reconnect that `_scheduleReconnect`
   * deferred while the attempt was in flight -- a disconnect during replay,
   * or the attempt's own failure. Every writer must run this, or a deferred
   * reconnect is dropped and a client with live desired subscriptions is
   * stranded with no timer and no promise.
   */
  _settleReconnectAttempt(attempt) {
    if (this._reconnectPromise !== attempt) return;
    this._reconnectPromise = null;
    if (this._reconnectAfterCurrent && !this._manualDisconnect) {
      this._reconnectAfterCurrent = false;
      this._scheduleReconnect();
    }
  }
}

/**
 * Initialize the multicast bridge polyfill.
 *
 * Polls mDNS/AutoTLS/loopback for the IWA bridge. When found, connects via
 * WebTransport and sets `window.multicast`. Skips if the extension already
 * provides it.
 *
 * @param {string} [options.rendezvousUrl] Base URL of the tenant's rendezvous
 *   edge, e.g. `https://<host>/`; `/v1/bridges` is appended. Supplied by the
 *   page's bridge configuration. Omit it and rung 3 is off — which is the
 *   right default for a site that has not provisioned one.
 */
export function initMulticastBridge(options = {}) {
  // Harvest (and so strip) the fragment pin before anything can return. The
  // strip is a side effect of the only reader, `bridgeUrlParams`, and all three
  // of the extension checks below — `tryConnectOnce`, `start`, and the
  // init-time one — sit above any other caller, so on a page that already
  // provides `window.multicast` the pin survived in the URL and rode along in a
  // copied or shared link, the one thing carrying it in the fragment prevents.
  // Harvesting here rather than at those checks because this entry dominates
  // every path to them; doing it at one of them leaves the other two open. The
  // read is memoized per window, so the later rungs still see the pin, and it
  // is harmless when absent: a miss is not memoized and `replaceState` runs
  // only inside the hit branch.
  const urlParams = bridgeUrlParams();
  const httpPort = options.bridgeHttpPort || DEFAULT_HTTP_PORT;
  const autoStart = options.autoStart !== false;
  const startDelayMs = Number.isFinite(options.startDelayMs) ? options.startDelayMs : 2000;
  // Scoped from the overlaid view, not `location.search`: a fragment-carried
  // `#gw=`/`#mc_bridge=` steers discovery, so it must isolate the cache key
  // exactly as its query twin does.
  const discoveryScope = bridgeDiscoveryScopeFromInputs({ params: urlParams });
  // A pairing outlives the pin that created it, so it is scoped by the stable
  // page identity only — see `bridgePairingScopeFromInputs`.
  const pairingScope = bridgePairingScopeFromInputs();
  // Rung 3's edge base, from the page's bridge configuration. Absent here the
  // rung is simply off — which is the correct default for a site that has not
  // provisioned a rendezvous, and the reason no host literal appears in this
  // file.
  const rendezvousUrl = options.rendezvousUrl || '';
  let pollTimer = null;
  let polling = false;
  let pollDelayMs = POLL_INTERVAL;
  let stableConnectionResetTimer = null;
  let connectAttempt = null;
  let client = null;
  let stopped = false;
  // The bridge owns exactly the object it installed. Do not infer ownership
  // from a marker property: a page can copy or spoof markers.
  let installedSurface = null;

  if (typeof WebTransport === 'undefined') {
    console.warn(`${TAG} WebTransport unavailable in this browser — bridge disabled`);
    // The whole ladder is gated on this capability and never on an OS version:
    // WebKit ships WebTransport from Safari/iOS 26.4, so every WKWebView
    // browser below that has none, and UA version sniffing would misread both
    // the shipping-soon and the already-shipped edges.
    //
    // Report it, or the page cannot tell "no WebTransport" from "no bridge
    // found" — they are the same silence — and the share of loads that can
    // never reach any rung is unmeasurable, which is exactly the population
    // this gate exists to size.
    //
    // Reported as a property and NOT as an event, because this is the one
    // detection outcome decided synchronously. Every consumer reaches init
    // through an `await` and attaches its listeners afterwards —
    // `blockcast-shaka-msf.js` calls `start()` at :2057 and only registers at
    // :2076 — so an event on this path is emitted before any listener exists
    // and reads as zero rather than as missing, whether it is dispatched at
    // init, deferred to a microtask, or latched to the first `start()`. The
    // returned controller has no such ordering: the consumer already holds it,
    // both directly and as `window.__multicastBridgeController`.
    // `multicast-bridge-ready` is unaffected — discovery plus handshake make it
    // genuinely asynchronous, so listen-after-init catches it every time.
    //
    // No UA is carried: the consumer runs in this same window, so the
    // iOS < 26.4 share stays a group-by on its own `navigator.userAgent`.
    return {
      start() {},
      stop() {
        stopped = true;
      },
      get connected() { return false; },
      unavailableReason: 'no-webtransport',
    };
  }

  // Bootstrap-layer observability: discovery/connect/disconnect/extension
  // transitions the page coordinator needs to bound retries and name the
  // layer that failed. See src/bridge-bootstrap.js (BLO-34021).
  function reportStatus(event) {
    try {
      options.onStatus?.(event);
    } catch (err) {
      console.warn(`${TAG} onStatus handler threw:`, err?.message);
    }
    // The same transitions for page code that did not build this controller,
    // such as the `./beacon-connect` offer. Phase, outcome and reason only: the
    // endpoint and its pin stay with `onStatus`.
    try {
      window.dispatchEvent?.(new CustomEvent('multicast-bridge-status', {
        detail: { phase: event.phase, ok: event.ok, reason: event.reason },
      }));
    } catch (err) {
      console.warn(`${TAG} multicast-bridge-status listener threw:`, err?.message);
    }
  }

  // `onReady`/`onDisconnect` run inside the bridge's own lifecycle
  // transitions, so a page callback that throws must not abort them. From
  // `installAPI` the throw lands in `tryConnectOnce`'s catch with the surface
  // already installed: the client is dropped while `window.multicast` stays,
  // and nothing ever removes it or rediscovers. From `_onDisconnect` it skips
  // the status report and the bounded rediscovery behind it. Same guard as
  // `reportStatus` gives `onStatus`.
  function notifyPage(name) {
    try {
      options[name]?.();
    } catch (err) {
      console.warn(`${TAG} ${name} handler threw:`, err?.message);
    }
  }

  function stopPolling({ resetDelay = false } = {}) {
    polling = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (resetDelay) {
      pollDelayMs = POLL_INTERVAL;
      if (stableConnectionResetTimer) {
        clearTimeout(stableConnectionResetTimer);
        stableConnectionResetTimer = null;
      }
    }
  }

  function armStableConnectionReset(bridgeClient) {
    if (stableConnectionResetTimer) {
      clearTimeout(stableConnectionResetTimer);
      stableConnectionResetTimer = null;
    }
    if (pollDelayMs <= POLL_INTERVAL) return;
    stableConnectionResetTimer = setTimeout(() => {
      stableConnectionResetTimer = null;
      if (!stopped && client === bridgeClient && bridgeClient.connected) {
        pollDelayMs = POLL_INTERVAL;
      }
    }, BRIDGE_STABLE_CONNECTION_MS);
    // Do not keep a page alive solely to reset an internal backoff timer.
    stableConnectionResetTimer.unref?.();
  }

  function schedulePoll(reason = 'miss') {
    if (!polling || pollTimer || stopped) return;

    let delayMs;
    if (reason === 'lock-busy') {
      delayMs = jitterDelay(POLL_LOCK_RETRY_MS);
    } else {
      pollDelayMs = nextBridgePollDelay(pollDelayMs, reason);
      delayMs = jitterDelay(pollDelayMs);
    }

    pollTimer = setTimeout(() => {
      pollTimer = null;
      tryConnect();
    }, delayMs);
  }

  function createMulticastAPI(bridgeClient, sharedApi) {
    return {
      [LOWERCASE_MARKER]: true,
      atscTunerEndpoint: ATSC_TUNER_ENDPOINT,
      atscLlsEndpoint: ATSC_LLS_ENDPOINT,
      tuner: sharedApi.tuner,
      tunerStatus: sharedApi.tuner.status,
      tunerTune: sharedApi.tuner.tune,
      tunerSetPlp: sharedApi.tuner.setPlp,
      get bridgeTransport() { return bridgeClient._transport; },
      get bridgeDiagnostics() { return bridgeClient.getStats(); },
      bridgeStats() { return bridgeClient.getStats(); },
      getThroughputHistory() { return bridgeClient.getThroughputHistory(); },
      reportFecDiagnostics(snapshot) {
        return bridgeClient.reportFecDiagnostics(snapshot);
      },
      async subscribe(configOrParams) {
        if (!configOrParams || typeof configOrParams !== 'object') {
          throw makeMulticastError(
            'subscription-failed',
            'subscribe() requires one config object.',
          );
        }
        // This is the guard the PAGE actually hits: `window.multicast.subscribe`
        // is this method, and it used to reject a bad consume mode here with
        // `subscription-failed` — shadowing the `capability-unsupported` that
        // subscribeMulticastBridgeBytes() raises a few frames later, which no
        // page-originated call could reach. See the RULING next to
        // MulticastErrorCode (BLO-33765).
        //
        // `!== undefined` is load-bearing: `consume` is REQUIRED, so omitting
        // it — or passing an array, which survives the typeof check above with
        // `.consume === undefined` — is malformed, not a capability gap.
        if (configOrParams.consume !== undefined && configOrParams.consume !== 'bytes') {
          throw makeMulticastError(
            'capability-unsupported',
            `Unsupported consume mode: ${String(configOrParams.consume)}`,
          );
        }
        if (configOrParams.consume === undefined) {
          throw makeMulticastError(
            'subscription-failed',
            "subscribe() requires consume: 'bytes'.",
          );
        }
        return subscribeMulticastBridgeBytes(bridgeClient, configOrParams);
      },
      capabilities() {
        return Promise.resolve(multicastBridgeCapabilities(bridgeClient, { networkHint: 'unknown' }));
      },
    };
  }

  function installAPI(bridgeClient, detection = null) {
    // A page/extension surface that appeared while discovery or the
    // handshake was in flight wins.  Never wrap it and never overwrite it.
    if (window.multicast !== undefined) return false;

    const tuner = createTunerAPI(bridgeClient);
    const surface = createMulticastAPI(bridgeClient, { tuner });
    window.multicast = surface;
    installedSurface = surface;

    console.log(`${TAG} window.multicast API installed (transport: ${bridgeClient._transport})`);
    // Detection telemetry rides the event the page already listens for: which
    // rung won, how long discovery took, and what platform it ran on.
    window.dispatchEvent(new CustomEvent('multicast-bridge-ready', {
      detail: {
        transport: bridgeClient._transport,
        platform: globalThis.navigator?.userAgent || '',
        ...detection,
      },
    }));
    notifyPage('onReady');
    return true;
  }

  function removeAPI() {
    const surface = installedSurface;
    installedSurface = null;
    if (surface && window.multicast === surface) {
      delete window.multicast;
    }
  }

  async function discoverBridgeCoordinated({ bypassCache = false } = {}) {
    const params = bridgeUrlParams();
    if (params.has('mc_bridge') && (params.has('fingerprint') || params.has('fp'))) {
      // No discovery is needed, including cross-tab caches/locks. A stale pin
      // must fail TLS, not be replaced by a cached endpoint or cached miss.
      return { bridge: await discoverBridge(httpPort, { pairingScope, rendezvousUrl }) };
    }
    if (!bypassCache) {
      const cached = readBridgeDiscoveryCache(httpPort, Date.now(), undefined, discoveryScope);
      if (cached?.status === 'found') {
        return { bridge: cached.bridge, fromCache: true };
      }
      if (cached?.status === 'miss') {
        return { bridge: null, cachedMiss: true };
      }
    }

    const lockOwner = tryAcquireBridgeDiscoveryLock(httpPort, { scope: discoveryScope });
    if (!lockOwner) {
      return { bridge: null, lockBusy: true };
    }

    try {
      const bridge = await attachBridgeEnrollment(await discoverBridge(httpPort, { pairingScope, rendezvousUrl }));
      if (bridge) {
        writeBridgeDiscoveryCache(httpPort, bridge, { scope: discoveryScope });
      } else {
        writeBridgeDiscoveryMiss(httpPort, { scope: discoveryScope });
      }
      return { bridge };
    } finally {
      releaseBridgeDiscoveryLock(lockOwner, { scope: discoveryScope });
    }
  }

  function hasWindowMulticastApi() {
    return !!window.multicast && typeof window.multicast.subscribe === 'function';
  }

  // The LAN sweep is deferred out of `discoverBridge` (see the rung it
  // replaced). It is armed only once per pass — `lanScanPending` covers both
  // "a load listener is waiting" and "a sweep is running", so neither a second
  // poll nor a second `load` can stack a second 508-probe sweep on the first.
  // A later poll re-arms it, which keeps the pre-BLO-43633 property that a
  // bridge appearing on the LAN after page load is still discovered.
  let lanScanPending = false;

  async function runDeferredLanScan() {
    try {
      if (stopped || hasWindowMulticastApi()) return;
      // Same cross-tab lock the discovery ladder holds: N tabs must not each
      // put 508 probes on the wire for one bridge.
      const lockOwner = tryAcquireBridgeDiscoveryLock(httpPort, { scope: discoveryScope });
      if (!lockOwner) return;
      let bridge = null;
      try {
        bridge = await attachBridgeEnrollment(await tryDesktopLanDiscovery(httpPort));
      } finally {
        releaseBridgeDiscoveryLock(lockOwner, { scope: discoveryScope });
      }
      if (!bridge || stopped || hasWindowMulticastApi()) return;
      // Cache first: `tryConnect` is a no-op while an attempt is in flight, so
      // the cache is what guarantees the next poll adopts this bridge.
      writeBridgeDiscoveryCache(httpPort, bridge, { scope: discoveryScope });
      await tryConnect({ seedBridge: bridge });
    } catch (err) {
      console.warn(`${TAG} Deferred LAN scan failed:`, err?.message);
    } finally {
      lanScanPending = false;
    }
  }

  function startDeferredLanScan() {
    // An explicit `?mc_bridge=` steers discovery; the ladder never swept for
    // one and neither does this.
    if (lanScanPending || stopped || bridgeUrlParams().has('mc_bridge')) return;
    lanScanPending = true;
    if (globalThis.document?.readyState === 'complete') void runDeferredLanScan();
    else window.addEventListener('load', () => void runDeferredLanScan(), { once: true });
  }

  function hasUsableReplacementSurface(surface = window.multicast) {
    if (!surface || surface === installedSurface) return false;
    try {
      return typeof surface.subscribe === 'function';
    } catch {
      return false;
    }
  }

  async function tryConnect(options = {}) {
    if (stopped) return;
    if (connectAttempt) return connectAttempt;

    connectAttempt = tryConnectOnce(options).finally(() => {
      connectAttempt = null;
    });
    return connectAttempt;
  }

  function retryFailedConnection() {
    if (stopped || window.multicast !== undefined) {
      stopPolling();
      return;
    }
    // The close callback and connect completion may observe the same failure.
    // Preserve an already scheduled retry so that failure advances backoff once.
    if (polling && pollTimer) return;
    stopPolling();
    startPolling('connect-failed');
  }

  // `startedAt` is threaded through the pairing-retry recursion below rather
  // than restamped per pass, so the reported latency covers the whole wait the
  // user sat through — a dead pinned candidate plus the rediscovery behind it.
  // Restamping reported the second pass alone, hiding the exact slow path
  // `connectAttempts: 1` exists to bound.
  // `seedFromCache` carries the same provenance across the rotation recursion:
  // a seeded pass never calls `discoverBridgeCoordinated`, so without it the
  // one path that always came from the cache — a re-pinned cached entry —
  // would report `servedFromCache: false`.
  async function tryConnectOnce({
    bypassCache = false, pairingRetried = false, startedAt = Date.now(),
    seedBridge = null, seedFromCache = false,
  } = {}) {
    if (hasWindowMulticastApi()) {
      console.log(`${TAG} window.multicast already set (extension?), skipping`);
      stopPolling({ resetDelay: true });
      return;
    }

    const { bridge, lockBusy, fromCache } = seedBridge
      ? { bridge: seedBridge, lockBusy: false, fromCache: seedFromCache }
      : await discoverBridgeCoordinated({ bypassCache });
    if (!bridge) {
      if (!lockBusy) startDeferredLanScan();
      reportStatus({ phase: 'discovery', ok: false, reason: lockBusy ? 'lock-busy' : 'miss' });
      schedulePoll(lockBusy ? 'lock-busy' : 'miss');
      return;
    }
    // `fromCache` travels with the event because a cache hit probed nothing:
    // a consumer that reads `ok: true` as "the endpoint answered" would tell a
    // viewer who has since stopped the bridge that it is installed and not
    // responding, and withhold the install step (BLO-42173).
    reportStatus({ phase: 'discovery', ok: true, bridge, fromCache: !!fromCache });

    stopPolling();
    const nextClient = new BridgeClient();
    client = nextClient;
    nextClient._onCertificateRotation = (hashes) => {
      // Keep [current, next] fresh while the page is open so the pairing is
      // still usable after the bridge swaps certificates.
      // Two things this must not do. Overwrite the live pairing from a
      // superseded client whose read loop has not unwound yet — hence the same
      // ownership test the pre-install recheck below uses. And remember a
      // CA-validated host: the injected `hashes` are non-empty by construction,
      // so they would satisfy `saveBridgePairing`'s empty-hash guard on behalf
      // of a DNS/AutoTLS endpoint (`fingerprint: ''`), and the next load would
      // connect to a CA-signed certificate with `serverCertificateHashes`.
      if (client !== nextClient || normalizeHashes(bridge.fingerprint).length === 0) return;
      saveBridgePairing({ ...bridge, hashes }, { scope: pairingScope });
    };
    nextClient._onDisconnect = () => {
      // A client the page already replaced can still report a disconnect
      // (a backoff re-armed on it, or an on-demand subscribe through a
      // surface kept from before). It owns neither the installed surface
      // nor discovery, so it must not remove or restart them.
      if (client !== nextClient) return;
      if (stableConnectionResetTimer) {
        clearTimeout(stableConnectionResetTimer);
        stableConnectionResetTimer = null;
      }
      removeAPI();
      if (client === nextClient) client = null;
      notifyPage('onDisconnect');
      reportStatus({ phase: 'disconnect', bridge });
      // A transport can complete the handshake and then fail before any
      // subscription exists.  Route this through the bounded poll backoff;
      // reset semantics would immediately create a reconnect storm.
      retryFailedConnection();
    };

    try {
      await nextClient.connect(bridge.host, bridge.httpPort, {
        fingerprint: bridge.fingerprint,
        wtPort: bridge.wtPort,
        gatewayDomain: bridge.gatewayDomain,
        localAddress: bridge.localAddress,
        // A pairing is a remembered guess, not discovered truth: bound its
        // failure cost so a stale record does not stall a cold load. The
        // live-discovery rungs below it keep the full retry budget.
        ...(bridge.fromPairing ? { connectAttempts: 1 } : {}),
      });
      // Discovery and the WebTransport handshake are asynchronous.  Recheck
      // ownership immediately before installation so a late bridge result
      // cannot overwrite an extension or page-owned surface.
      if (
        client !== nextClient ||
        !nextClient.connected ||
        stopped ||
        window.multicast !== undefined
      ) {
        if (client === nextClient) client = null;
        nextClient.disconnect();
        // `installAPI` refuses every defined surface, not just usable ones.
        // A foreign surface may be intentionally degraded; retrying while it
        // occupies the property can never converge and would re-handshake
        // forever.  Only retry when the slot is genuinely free.
        retryFailedConnection();
        console.warn(`${TAG} Bridge client disconnected before API install`);
        reportStatus({ phase: 'connect', ok: false, bridge, detail: 'disconnected before API install' });
        return;
      }
      if (!installAPI(nextClient, {
        rung: bridge.discoveryMethod || 'unknown',
        latencyMs: Date.now() - startedAt,
        // `rung` survives the discovery cache — a cached entry keeps whichever
        // rung first found it — so on its own a cache hit reads as that rung
        // being near-instant. Report how this load was served separately from
        // what originally found it, or the ranking rewards the cache.
        servedFromCache: fromCache === true,
      })) {
        if (client === nextClient) client = null;
        nextClient.disconnect();
        retryFailedConnection();
        reportStatus({ phase: 'connect', ok: false, bridge, detail: 'window.multicast already owned' });
        return;
      }
      // Only a hash-authenticated, directly-reachable endpoint is worth
      // remembering: a CA-validated DNS/AutoTLS host needs no pin and
      // re-resolves on its own next time. The filtering happens inside
      // `saveBridgePairing`, which no-ops both when the bridge carries no
      // hashes and when it carries a `gatewayDomain` — the latter because a
      // bridge advertising a pin *and* a domain is reached through the AutoTLS
      // candidate, so the pin describes a route this session never took.
      saveBridgePairing(bridge, { scope: pairingScope });
      armStableConnectionReset(nextClient);
      reportStatus({ phase: 'connect', ok: true, bridge, transport: nextClient._transport });
    } catch (err) {
      console.warn(`${TAG} Bridge connect failed:`, err.message);
      if (client === nextClient) client = null;
      // `AbortError` is raised only by `_assertCurrentWebTransport` when this
      // attempt was superseded — by `stop()` or by a newer connect. It never
      // means the endpoint is dead, so the pairing below must survive it.
      // The `stopped` half is load-bearing for a different reason: the retry
      // recursion below calls `tryConnectOnce` directly, bypassing the guard
      // on the `tryConnect` wrapper, so without this a teardown mid-handshake
      // restarts discovery — a 508-address LAN scan — after `stop()` returned.
      if (stopped || err.name === 'AbortError') return;
      // This client never connected, so `_handleDisconnect` would not have
      // fired its callback anyway — drop it explicitly so the recursion below
      // cannot be torn down by a stale handler if that gate ever changes.
      nextClient._onDisconnect = null;
      // The certificate rotates on a schedule, so a cached pin eventually fails
      // the handshake even though this is still the bridge we enrolled. Re-verify
      // the attestation it offers now against the PINNED public key and retry
      // on the rotated fingerprint, rather than spending the cache TTL on
      // handshakes that cannot succeed. Only a DISPROOF drops the entry: the
      // bridge answered and could not re-prove the pin, which means a bridge we
      // no longer recognise (a revocation mints a new id).
      if (fromCache && bridge.enrollment && !stopped) {
        const { rotated, disproved } = await rotateCachedBridgePin(bridge);
        if (rotated) {
          writeBridgeDiscoveryCache(httpPort, rotated, { scope: discoveryScope });
          return tryConnectOnce({ seedBridge: rotated, startedAt, seedFromCache: fromCache });
        }
        // Silence is not a disproof, and neither is a re-proof that needed no
        // rotation — this connect failure was something other than a stale pin.
        if (disproved) clearBridgeDiscoveryCache({ scope: discoveryScope });
      }
      // The remembered endpoint is gone or its certificate no longer matches
      // any stored hash. Either way the record is dead — drop it and rerun
      // discovery now instead of waiting out the poll backoff. `pairingRetried`
      // bounds this to one extra pass: if the drop does not take (storage full,
      // disabled, or throwing) the rediscovery would otherwise re-read the same
      // dead record and recurse forever.
      if (bridge.fromPairing && !pairingRetried) {
        console.warn(`${TAG} Persisted pairing rejected; dropping it and rediscovering`);
        clearBridgePairing({ scope: pairingScope });
        await tryConnectOnce({ bypassCache: true, pairingRetried: true, startedAt });
        return;
      }
      retryFailedConnection();
      reportStatus({ phase: 'connect', ok: false, bridge, detail: err.message });
    }
  }

  /**
   * Re-prove a cached pin against whatever certificate the bridge offers now.
   *
   * Three outcomes, kept distinct because two of them look alike from the
   * caller and only one may drop the pin:
   *   - `rotated` non-null — proved with the pinned key, on a NEW certificate.
   *   - `disproved` true — the bridge answered and could not re-prove the pin.
   *   - neither — unreachable, or re-proved on the SAME certificate. The pin
   *     stands; this connect failure was not a stale fingerprint. /enrollment
   *     is served on httpPort while the handshake runs against wtPort, and the
   *     catch above is broad, so a positive re-proof alongside a failed connect
   *     is ordinary (WT listener not yet bound during a restart).
   */
  async function rotateCachedBridgePin(bridge) {
    const { attestation, unreachable } = await fetchBridgeEnrollment(bridge);
    if (unreachable) return { rotated: null, disproved: false };
    const reproved = await rotateCachedBridgeFingerprint(bridge, attestation);
    if (!reproved) return { rotated: null, disproved: true };
    return {
      rotated: reproved.fingerprint !== bridge.fingerprint ? reproved : null,
      disproved: false,
    };
  }

  function startPolling(reason = 'reset') {
    if (polling || stopped) return;
    polling = true;
    console.log(`${TAG} Polling for IWA bridge via mDNS/AutoTLS/loopback:${httpPort}...`);
    if (reason === 'reset') {
      if (!connectAttempt) pollDelayMs = POLL_INTERVAL;
      tryConnect();
    } else {
      schedulePoll(reason);
    }
  }

  // Listen for extension ready — stop polling immediately if extension is active.
  // Named so `stop()` can detach it: a stopped controller must not keep
  // reacting to `extension_ready`, logging "keeping bridge" for a bridge it no
  // longer runs and reporting status for a lifecycle that is over.
  function onExtensionMessage(e) {
    if (e.data?.source === 'multicast-extension' && e.data?.message?.type === 'extension_ready') {
      // Readiness is only a takeover signal when the extension has installed a
      // usable replacement.  A content-script signal can arrive even when its
      // main-world injector failed; in that case keep the bridge alive.
      if (window.multicast === installedSurface || !hasUsableReplacementSurface()) {
        console.warn(`${TAG} Extension ready without a usable replacement surface; keeping bridge`);
        reportStatus({ phase: 'extension', takeover: false });
        return;
      }
      console.log(`${TAG} Extension detected via extension_ready, stopping bridge polling`);
      stopped = true;
      stopPolling();
      const bridgeClient = client;
      client = null;
      removeAPI();
      bridgeClient?.disconnect();
      reportStatus({ phase: 'extension', takeover: true });
    }
  }
  window.addEventListener('message', onExtensionMessage);

  function start() {
    if (hasWindowMulticastApi()) {
      console.log(`${TAG} window.multicast already set, skipping bridge polling`);
      return;
    }
    startPolling();
  }

  // Delay first probe to let extension inject.js set window.multicast first.
  // Optional consumers can pass autoStart:false and call start() only after a
  // user/query flow actually requests bridge transport.
  if (hasWindowMulticastApi()) {
    console.log(`${TAG} window.multicast already set, skipping bridge polling`);
  } else if (autoStart) {
    setTimeout(start, startDelayMs);
  } else {
    console.log(`${TAG} Bridge polling armed; waiting for explicit start()`);
  }

  // Both returns expose the same two readable properties. A consumer that
  // branches on `unavailableReason` or `connected` must not have to know which
  // shape it got — an `undefined` here would read as "available" on the branch
  // that cannot connect at all.
  return {
    start,
    stop() {
      stopped = true;
      window.removeEventListener('message', onExtensionMessage);
      stopPolling({ resetDelay: true });
      if (client) {
        client.disconnect();
        removeAPI();
        client = null;
      }
    },
    get connected() { return Boolean(client?.connected); },
    unavailableReason: null,
  };
}
