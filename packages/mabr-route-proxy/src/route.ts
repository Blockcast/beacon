import { MabrRouteProxy, type ByteSubscription } from './proxy.ts';

export interface RouteWasmExports {
  memory: WebAssembly.Memory;
  route_get_buffer(): number | bigint;
  route_get_buffer_size(): number;
  route_process_ts?(length: number): void;
  route_process_udp?(dstIPLength: number, dstPort: number, payloadLength: number): void;
  route_process_udp_with_source?(dstIPLength: number, sourceIPLength: number, dstPort: number, payloadLength: number): void;
  route_get_completed_count(): number;
  route_pop_completed_tsi(): number | bigint;
  route_pop_completed_toi(): number | bigint;
  route_pop_completed_len(): number;
  route_pop_completed_data(): number | bigint;
  route_pop_completed_type?(): number | bigint;
  route_pop_completed_type_len?(): number;
  route_pop_completed_location?(): number | bigint;
  route_pop_completed_location_len?(): number;
  route_pop_completed_dstip?(): number | bigint;
  route_pop_completed_dstip_len?(): number;
  route_pop_completed_codepoint(): number;
  route_pop_completed_integrity?(): number;
  route_pop_completed_advance(): void;
  /** Current manifest assembled by the existing SLS/manifest parser. */
  route_get_mpd?(): number | bigint;
  route_get_mpd_len?(): number;
  route_get_mpd_location?(): number | bigint;
  route_get_mpd_location_len?(): number;
  route_get_sls_count?(): number | bigint;
  /** All DASH/HLS manifests signalled by the most recent SLS bundle. */
  route_sls_manifest_count?(): number;
  route_sls_manifest?(index: number): number | bigint;
  route_sls_manifest_len?(): number;
  route_sls_manifest_location?(index: number): number | bigint;
  route_sls_manifest_location_len?(): number;
  /** Parsed S-TSID sessions signaled by the service SLS. */
  route_stsid_session_count?(): number;
  route_stsid_session?(index: number): number | bigint;
  route_stsid_session_len?(): number;
  /** Optional RFC 6330 symbol queue exposed by newer route.wasm builds. */
  route_get_raptorq_count?(): number;
  route_pop_raptorq_tsi?(): number | bigint;
  route_pop_raptorq_toi?(): number | bigint;
  route_pop_raptorq_sbn?(): number;
  route_pop_raptorq_esi?(): number;
  route_pop_raptorq_symbol?(): number | bigint;
  route_pop_raptorq_symbol_len?(): number;
  route_pop_raptorq_transfer_len?(): number | bigint;
  route_pop_raptorq_symbol_size?(): number;
  route_pop_raptorq_max_sb_len?(): number;
  route_pop_raptorq_max_num_es?(): number;
  route_pop_raptorq_num_src_blks?(): number;
  route_pop_raptorq_num_sub_blks?(): number;
  route_pop_raptorq_sym_align_param?(): number;
  route_pop_raptorq_codepoint?(): number;
  route_pop_raptorq_dstip?(): number | bigint;
  route_pop_raptorq_dstip_len?(): number;
  route_pop_raptorq_srcip?(): number | bigint;
  route_pop_raptorq_srcip_len?(): number;
  route_pop_raptorq_type?(): number | bigint;
  route_pop_raptorq_type_len?(): number;
  route_pop_raptorq_location?(): number | bigint;
  route_pop_raptorq_location_len?(): number;
  route_pop_raptorq_advance?(): void;
}

export interface RouteWasmHandle {
  exports: RouteWasmExports;
}

export interface RouteObject {
  tsi: bigint;
  toi: bigint;
  codepoint: number;
  integrity: number;
  contentType: string;
  contentLocation: string;
  data: Uint8Array;
  dstIP?: string;
  sourceIP?: string;
  /** True when the object was reconstructed from RFC 6330 symbols. */
  fecRecovered?: boolean;
}

export interface RouteRaptorQDecoderHandle {
  add_packet(packet: Uint8Array): boolean;
  is_complete(): boolean;
  get_result(): Uint8Array;
  free(): void;
}

export interface RouteRaptorQDecoderFactory {
  new (oti: Uint8Array): RouteRaptorQDecoderHandle;
  with_params(
    transferLength: bigint,
    symbolSize: number,
    sourceBlocks: number,
    subBlocks: number,
    symbolAlignment: number,
  ): RouteRaptorQDecoderHandle;
}

export interface RouteRaptorQWasmModule {
  RaptorQDecoder: RouteRaptorQDecoderFactory;
}

export interface RouteRaptorQPacket {
  tsi: bigint;
  toi: bigint;
  sbn: number;
  esi: number;
  /** Exact ROUTE encoding-6 wire ID: [SBN:8][ESI:24]. */
  payloadId: Uint8Array;
  symbol: Uint8Array;
  transferLength: number;
  symbolSize: number;
  maxSbLen: number;
  maxNumEs: number;
  numSrcBlks: number;
  numSubBlks: number;
  symAlignParam: number;
  codepoint: number;
  dstIP: string;
  sourceIP: string;
  contentType: string;
  contentLocation: string;
}

export interface RouteRaptorQOptions {
  /** Initialized wasm-bindgen module built from the matching fec-raptorq source. */
  wasm: RouteRaptorQWasmModule;
  maxObjects?: number;
  maxObjectBytes?: number;
  maxBlocksPerObject?: number;
  maxSymbolsPerObject?: number;
  onRecovered?: (object: RouteObject) => void;
}

export interface RouteEndpoint {
  group: string;
  port: number;
  source?: string;
}

export interface RouteGateway {
  /** Structural subset of the page-facing window.multicast.subscribe surface. */
  subscribe(config: object): Promise<ByteSubscription & { unsubscribe(): Promise<void> | void }>;
}

/** How ROUTE bytes reach the page-facing multicast gateway. */
export type RouteIngress = 'native' | 'amt' | 'tuner';

export interface RouteMabrOptions {
  gateway: RouteGateway;
  wasm: RouteWasmHandle;
  /** Native DIMT, AMT relay, or the existing USB/OTA tuner source. */
  ingress?: RouteIngress;
  /** ATSC 3 ROUTE destination carried as multicast UDP bytes. */
  group?: string;
  port?: number;
  source?: string;
  /** Multiple ROUTE legs, one per mABR rendition. `group`/`port` remain the single-leg shorthand. */
  endpoints?: RouteEndpoint[];
  /** The one TO-selected service SLS leg. Media legs are learned from S-TSID. */
  slsEndpoint?: RouteEndpoint;
  /** HTTP LLS/SLT endpoint used to discover the service SLS leg. */
  sltUrl?: string;
  /** Optional LLS group id when `sltUrl` exposes more than one SLT. */
  sltGroup?: number;
  /** Optional numeric A/331 service id or global service id to select from SLT. */
  serviceId?: string | number;
  /** Subscribe to media legs announced by the service SLS/S-TSID. */
  discoverEndpoints?: boolean;
  /** Required when ingress is AMT. */
  relay?: string;
  relayPort?: number;
  /** ATSC 1 is retained as an explicit unsupported mode; it needs a raw-TS host feed. */
  standard?: 'atsc1' | 'atsc3';
  baseUrl?: string;
  maxEntries?: number;
  onObject?: (object: RouteObject) => void;
  /** Optional browser-side RFC 6330 recovery for the parser's symbol queue. */
  raptorq?: RouteRaptorQOptions;
}

const decoder = new TextDecoder();
const MAX_RESULT_BUFFER_BYTES = 1 << 20;

function xmlAttribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match?.[2] ?? '';
}

function xmlUnescape(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function normalizeRouteSource(value?: string): string | undefined {
  const source = value?.trim();
  if (!source || source === '0.0.0.0' || source === '::' || source === '0:0:0:0:0:0:0:0') return undefined;
  return source;
}

function parseSltEndpoints(xml: string, serviceId?: string | number): RouteEndpoint[] {
  const endpoints: RouteEndpoint[] = [];
  const servicePattern = /<((?:[A-Za-z_][\w.-]*:)?(?:Service|Server))\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let serviceMatch: RegExpExecArray | null;
  while ((serviceMatch = servicePattern.exec(xml))) {
    const serviceTag = serviceMatch[2]!;
    const body = serviceMatch[3]!;
    const numericId = xmlUnescape(xmlAttribute(serviceTag, 'serviceId'));
    const globalId = xmlUnescape(xmlAttribute(serviceTag, 'globalServiceID'));
    if (serviceId !== undefined && String(serviceId) !== numericId && String(serviceId) !== globalId) continue;
    const signal = [...body.matchAll(/<((?:[A-Za-z_][\w.-]*:)?BroadcastSvcSignaling)\b([^>]*?)(?:\/?>)/gi)]
      .find((match) => xmlAttribute(match[2]!, 'slsProtocol') === '1');
    if (!signal) continue;
    const group = xmlUnescape(xmlAttribute(signal[2]!, 'slsDestinationIpAddress')).trim();
    const source = normalizeRouteSource(xmlUnescape(xmlAttribute(signal[2]!, 'slsSourceIpAddress')));
    const port = Number(xmlAttribute(signal[2]!, 'slsDestinationUdpPort'));
    if (group && Number.isInteger(port) && port > 0 && port <= 65535) {
      endpoints.push({ group, port, ...(source ? { source } : {}) });
    }
  }
  return endpoints;
}

async function discoverSlsEndpoint(options: RouteMabrOptions): Promise<RouteEndpoint> {
  const raw = options.sltUrl?.trim();
  if (!raw) throw new RangeError('sltUrl is required for HTTP LLS discovery');
  const base = new URL(raw, globalThis.location?.href ?? 'http://localhost/');
  const basePath = base.pathname.replace(/\/+$/, '');
  const get = async (url: string): Promise<string> => {
    const response = await globalThis.fetch(url);
    if (!response.ok) throw new Error(`HTTP LLS fetch ${url} failed with ${response.status}`);
    return response.text();
  };
  if (/\/slt\/\d+$/i.test(basePath) || /\.xml$/i.test(basePath)) {
    const endpoints = parseSltEndpoints(await get(base.href), options.serviceId);
    if (endpoints.length !== 1) throw new Error(`HTTP LLS advertised ${endpoints.length} ROUTE SLS endpoints`);
    return endpoints[0]!;
  }
  const sltDirectory = basePath.endsWith('/slt')
    ? new URL(`${basePath}/`, base.origin).href
    : new URL('slt/', base).href;

  const index = await get(sltDirectory);
  const groups = options.sltGroup === undefined
    ? [...index.matchAll(/href\s*=\s*["'](\d+)["']/gi)].map((match) => Number(match[1]))
    : [options.sltGroup];
  const documents = groups.length > 0
    ? await Promise.all([...new Set(groups)].map((group) => get(new URL(String(group), sltDirectory).href)))
    : [index];
  const endpoints = documents.flatMap((document) => parseSltEndpoints(document, options.serviceId));
  const unique = [...new Map(endpoints.map((endpoint) => [`${endpoint.source ?? ''}\0${endpoint.group}\0${endpoint.port}`, endpoint])).values()];
  if (unique.length !== 1) {
    const selector = options.serviceId === undefined ? 'serviceId' : `serviceId ${String(options.serviceId)}`;
    throw new Error(`HTTP LLS advertised ${unique.length} ROUTE SLS endpoints for ${selector}; select exactly one`);
  }
  return unique[0]!;
}

function uint64(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function numberValue(value: number | bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RangeError(`invalid route.wasm pointer ${String(value)}`);
  return number;
}

function readString(exports: RouteWasmExports, pointer?: number | bigint, length?: number): string {
  if (pointer === undefined || length === undefined || length <= 0) return '';
  const bytes = new Uint8Array(exports.memory.buffer, numberValue(pointer), length);
  return decoder.decode(bytes);
}

function copyBytes(exports: RouteWasmExports, pointer: number | bigint, length: number): Uint8Array {
  if (length <= 0) return new Uint8Array();
  const start = numberValue(pointer);
  if (length > exports.memory.buffer.byteLength - start) {
    throw new RangeError(`route.wasm object range ${start}+${length} exceeds memory`);
  }
  return new Uint8Array(exports.memory.buffer.slice(start, start + length));
}

function safeValue(value: number | bigint, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RangeError(`invalid RaptorQ ${name}`);
  return number;
}

function positiveOption(value: number | undefined, name: string, fallback: number): number {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return number;
}

function objectKey(packet: Pick<RouteRaptorQPacket, 'dstIP' | 'tsi' | 'toi'>): string {
  return `${packet.dstIP}\u0000${packet.tsi}\u0000${packet.toi}`;
}

interface RouteRaptorQGeometry {
  transferLength: number;
  symbolSize: number;
  maxSbLen: number;
  maxNumEs: number;
  numSrcBlks: number;
  numSubBlks: number;
  symAlignParam: number;
  blockLength: number;
  expectedBlocks: number;
}

interface RouteRaptorQBlock {
  decoder: RouteRaptorQDecoderHandle | undefined;
  data: Uint8Array | undefined;
}

interface RouteRaptorQObject extends RouteRaptorQGeometry {
  key: string;
  tsi: bigint;
  toi: bigint;
  dstIP: string;
  sourceIP: string;
  codepoint: number;
  contentType: string;
  contentLocation: string;
  blocks: Map<number, RouteRaptorQBlock>;
  seen: Set<string>;
}

const MAX_RFC6330_TRANSFER_LENGTH = 0xffffffffff;
const MAX_RFC6330_ESI = 0xffffff;
const DEFAULT_MAX_RAPTORQ_OBJECTS = 32;
const DEFAULT_MAX_RAPTORQ_OBJECT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RAPTORQ_BLOCKS = 255;
const DEFAULT_MAX_RAPTORQ_SYMBOLS = 262144;

function raptorqGeometry(packet: RouteRaptorQPacket, options: {
  maxObjectBytes: number;
  maxBlocksPerObject: number;
  maxSymbolsPerObject: number;
}): RouteRaptorQGeometry {
  const transferLength = packet.transferLength;
  const symbolSize = packet.symbolSize;
  // RaptorQ FTI Z is mandatory for this queue. A zero value means malformed
  // parser metadata; silently changing it to one can decode a multi-block
  // object with the wrong source-block partition.
  const numSrcBlks = packet.numSrcBlks;
  const numSubBlks = packet.numSubBlks || 1;
  const symAlignParam = packet.symAlignParam || 8;
  const totalSourceSymbols = Math.ceil(transferLength / symbolSize);
  // The parser may carry the source-plane K while a repair symbol carries a
  // single-block RaptorQ object. Clamp that stale K to this object's source
  // symbol count before constructing the browser decoder.
  const maxSbLen = packet.maxSbLen > totalSourceSymbols ? totalSourceSymbols : packet.maxSbLen;
  const maxNumEs = packet.maxNumEs;
  if (!Number.isSafeInteger(transferLength) || transferLength < 1 || transferLength > MAX_RFC6330_TRANSFER_LENGTH) {
    throw new RangeError('invalid RaptorQ transfer length');
  }
  if (!Number.isSafeInteger(symbolSize) || symbolSize < 1 || symbolSize > 0xffff) {
    throw new RangeError('invalid RaptorQ symbol size');
  }
  if (!Number.isSafeInteger(numSrcBlks) || numSrcBlks < 1 || numSrcBlks > 0xff || numSrcBlks > options.maxBlocksPerObject) {
    throw new RangeError('invalid RaptorQ source block count');
  }
  if (!Number.isSafeInteger(numSubBlks) || numSubBlks < 1 || numSubBlks > 0xffff) {
    throw new RangeError('invalid RaptorQ sub-block count');
  }
  if (!Number.isSafeInteger(symAlignParam) || symAlignParam < 1 || symAlignParam > 0xff || symbolSize % symAlignParam !== 0) {
    throw new RangeError('invalid RaptorQ symbol alignment');
  }
  if (!Number.isSafeInteger(maxSbLen) || maxSbLen < 1 || maxSbLen > 0xffff) {
    throw new RangeError('invalid RaptorQ source block length');
  }
  if (!Number.isSafeInteger(maxNumEs) || maxNumEs < 0 || maxNumEs > MAX_RFC6330_ESI + 1) {
    throw new RangeError('invalid RaptorQ encoding symbol count');
  }
  if (transferLength > options.maxObjectBytes) throw new RangeError('RaptorQ object exceeds byte limit');
  if (totalSourceSymbols < 1 || totalSourceSymbols > options.maxSymbolsPerObject) {
    throw new RangeError('RaptorQ object exceeds symbol limit');
  }
  const blockLength = maxSbLen * symbolSize;
  if (!Number.isSafeInteger(blockLength) || blockLength < 1 || blockLength > options.maxObjectBytes) {
    throw new RangeError('invalid RaptorQ source block byte length');
  }
  const expectedBlocks = Math.ceil(transferLength / blockLength);
  if (!Number.isSafeInteger(expectedBlocks) || expectedBlocks < 1 || expectedBlocks > options.maxBlocksPerObject) {
    throw new RangeError('RaptorQ object has too many source blocks');
  }
  if (numSrcBlks * maxSbLen > options.maxSymbolsPerObject) {
    throw new RangeError('RaptorQ source blocks exceed symbol limit');
  }
  return {
    transferLength,
    symbolSize,
    maxSbLen,
    maxNumEs,
    numSrcBlks,
    numSubBlks,
    symAlignParam,
    blockLength,
    expectedBlocks,
  };
}

function sameGeometry(left: RouteRaptorQGeometry, right: RouteRaptorQGeometry): boolean {
  return left.transferLength === right.transferLength &&
    left.symbolSize === right.symbolSize &&
    left.maxSbLen === right.maxSbLen &&
    left.maxNumEs === right.maxNumEs &&
    left.numSrcBlks === right.numSrcBlks &&
    left.numSubBlks === right.numSubBlks &&
    left.symAlignParam === right.symAlignParam &&
    left.blockLength === right.blockLength &&
    left.expectedBlocks === right.expectedBlocks;
}

function makeBlockDecoder(module: RouteRaptorQWasmModule, object: RouteRaptorQObject): RouteRaptorQDecoderHandle {
  // Blockcast's sender uses fixed-K interleaved blocks. Decode one SBN at a
  // time with K'=MaxSbLen and normalize that block's SBN to zero below.
  return module.RaptorQDecoder.with_params(
    BigInt(object.blockLength),
    object.symbolSize,
    1,
    object.numSubBlks,
    object.symAlignParam,
  );
}

function makeEncodingPacket(packet: RouteRaptorQPacket): Uint8Array {
  // fec-raptorq's decoder ABI uses the same four-byte RFC 6330 ID as ROUTE,
  // and each block decoder is normalized to SBN zero below.
  const payloadId = Uint8Array.of(
    0,
    (packet.esi >>> 16) & 0xff,
    (packet.esi >>> 8) & 0xff,
    packet.esi & 0xff,
  );
  const encodingPacket = new Uint8Array(4 + packet.symbol.length);
  encodingPacket.set(payloadId, 0);
  encodingPacket.set(packet.symbol, 4);
  return encodingPacket;
}

function optionalNumber(
  exports: RouteWasmExports,
  getter: (() => number | bigint) | undefined,
  fallback: number,
  name: string,
): number {
  return getter ? safeValue(getter(), name) : fallback;
}

function readOptionalString(
  exports: RouteWasmExports,
  pointer: (() => number | bigint) | undefined,
  length: (() => number) | undefined,
): string {
  if (!pointer || !length) return '';
  return readString(exports, pointer(), length());
}

function popRaptorQ(exports: RouteWasmExports): RouteRaptorQPacket {
  const sbn = optionalNumber(exports, exports.route_pop_raptorq_sbn, 0, 'SBN');
  const esi = optionalNumber(exports, exports.route_pop_raptorq_esi, 0, 'ESI');
  const symbolLength = optionalNumber(exports, exports.route_pop_raptorq_symbol_len, 0, 'symbol length');
  const symbolPointer = optionalNumber(exports, exports.route_pop_raptorq_symbol, 0, 'symbol pointer');
  const symbol = symbolLength > 0 ? copyBytes(exports, symbolPointer, symbolLength) : new Uint8Array();
  const payloadId = Uint8Array.of(
    sbn & 0xff,
    (esi >>> 16) & 0xff,
    (esi >>> 8) & 0xff,
    esi & 0xff,
  );
  return {
    tsi: uint64(exports.route_pop_raptorq_tsi?.() ?? 0),
    toi: uint64(exports.route_pop_raptorq_toi?.() ?? 0),
    sbn,
    esi,
    payloadId,
    symbol,
    transferLength: optionalNumber(exports, exports.route_pop_raptorq_transfer_len, 0, 'transfer length'),
    symbolSize: optionalNumber(exports, exports.route_pop_raptorq_symbol_size, symbolLength, 'symbol size'),
    maxSbLen: optionalNumber(exports, exports.route_pop_raptorq_max_sb_len, 0, 'source block length'),
    maxNumEs: optionalNumber(exports, exports.route_pop_raptorq_max_num_es, 0, 'encoding symbol count'),
    numSrcBlks: optionalNumber(exports, exports.route_pop_raptorq_num_src_blks, 0, 'source block count'),
    numSubBlks: optionalNumber(exports, exports.route_pop_raptorq_num_sub_blks, 1, 'sub-block count'),
    symAlignParam: optionalNumber(exports, exports.route_pop_raptorq_sym_align_param, 8, 'symbol alignment'),
    codepoint: optionalNumber(exports, exports.route_pop_raptorq_codepoint, 0, 'codepoint'),
    dstIP: readOptionalString(exports, exports.route_pop_raptorq_dstip, exports.route_pop_raptorq_dstip_len),
    sourceIP: readOptionalString(exports, exports.route_pop_raptorq_srcip, exports.route_pop_raptorq_srcip_len),
    contentType: readOptionalString(exports, exports.route_pop_raptorq_type, exports.route_pop_raptorq_type_len),
    contentLocation: readOptionalString(exports, exports.route_pop_raptorq_location, exports.route_pop_raptorq_location_len),
  };
}

function drainRaptorQ(exports: RouteWasmExports, collector: RouteRaptorQCollector | undefined): void {
  const count = exports.route_get_raptorq_count;
  const advance = exports.route_pop_raptorq_advance;
  if (!count || !advance) return;
  let remaining = safeValue(count(), 'queue count');
  while (remaining > 0) {
    try {
      if (collector) {
        const packet = popRaptorQ(exports);
        collector.ingest(packet);
      }
    } finally {
      advance();
      remaining--;
    }
  }
}

class RouteRaptorQCollector {
  readonly #module: RouteRaptorQWasmModule;
  readonly #maxObjects: number;
  readonly #maxObjectBytes: number;
  readonly #maxBlocksPerObject: number;
  readonly #maxSymbolsPerObject: number;
  readonly #onRecovered: ((object: RouteObject) => void) | undefined;
  readonly #objects = new Map<string, RouteRaptorQObject>();

  constructor(options: RouteRaptorQOptions) {
    this.#module = options.wasm;
    this.#maxObjects = positiveOption(options.maxObjects, 'raptorq.maxObjects', DEFAULT_MAX_RAPTORQ_OBJECTS);
    this.#maxObjectBytes = positiveOption(options.maxObjectBytes, 'raptorq.maxObjectBytes', DEFAULT_MAX_RAPTORQ_OBJECT_BYTES);
    this.#maxBlocksPerObject = positiveOption(options.maxBlocksPerObject, 'raptorq.maxBlocksPerObject', DEFAULT_MAX_RAPTORQ_BLOCKS);
    this.#maxSymbolsPerObject = positiveOption(options.maxSymbolsPerObject, 'raptorq.maxSymbolsPerObject', DEFAULT_MAX_RAPTORQ_SYMBOLS);
    this.#onRecovered = options.onRecovered;
  }

  ingest(packet: RouteRaptorQPacket): void {
    let key: string | undefined;
    try {
      if (packet.symbol.length === 0 || !Number.isSafeInteger(packet.sbn) || packet.sbn < 0 || packet.sbn > 0xff ||
          packet.esi < 0 || packet.esi > MAX_RFC6330_ESI) return;
      // The symbol bytes are the authoritative wire size. Older route.wasm
      // objects can retain the source FDT's ESLen while exposing a repair
      // symbol with its RaptorQ FTI size.
      if (packet.symbolSize !== packet.symbol.length) {
        packet = { ...packet, symbolSize: packet.symbol.length };
      }
      key = objectKey(packet);
      let object = this.#objects.get(key);
      const geometry = raptorqGeometry(packet, {
        maxObjectBytes: this.#maxObjectBytes,
        maxBlocksPerObject: this.#maxBlocksPerObject,
        maxSymbolsPerObject: this.#maxSymbolsPerObject,
      });
      if (packet.sbn >= geometry.expectedBlocks || (geometry.maxNumEs > 0 && packet.esi >= geometry.maxNumEs)) return;
      if (object) {
        if (!sameGeometry(object, geometry)) return;
      } else {
        while (this.#objects.size >= this.#maxObjects) this.evictOldest();
        object = {
          ...geometry,
          key,
          tsi: packet.tsi,
          toi: packet.toi,
          dstIP: packet.dstIP,
          sourceIP: packet.sourceIP,
          codepoint: packet.codepoint,
          contentType: packet.contentType,
          contentLocation: packet.contentLocation,
          blocks: new Map(),
          seen: new Set(),
        };
        this.#objects.set(key, object);
      }
      if (!object.contentLocation && packet.contentLocation) object.contentLocation = packet.contentLocation;
      if (!object.contentType && packet.contentType) object.contentType = packet.contentType;
      if (!object.sourceIP && packet.sourceIP) object.sourceIP = packet.sourceIP;
      object.codepoint = packet.codepoint;
      const packetKey = `${packet.sbn}:${packet.esi}`;
      if (object.seen.has(packetKey)) return;
      if (object.seen.size >= this.#maxSymbolsPerObject) {
        this.reset(key);
        return;
      }
      object.seen.add(packetKey);
      let block = object.blocks.get(packet.sbn);
      if (!block) {
        if (packet.sbn >= object.expectedBlocks || object.blocks.size >= this.#maxBlocksPerObject) return;
        block = { decoder: makeBlockDecoder(this.#module, object), data: undefined };
        object.blocks.set(packet.sbn, block);
      }
      if (block.data) return;
      let complete = block.decoder?.add_packet(makeEncodingPacket(packet)) ?? false;
      if (!complete) complete = block.decoder?.is_complete() ?? false;
      if (complete) {
        block.data = new Uint8Array(block.decoder!.get_result()).subarray(0, object.blockLength).slice();
        block.decoder!.free();
        block.decoder = undefined;
      }
      if (object.blocks.size < object.expectedBlocks) return;
      for (let sbn = 0; sbn < object.expectedBlocks; sbn++) {
        if (!object.blocks.get(sbn)?.data) return;
      }
      const data = new Uint8Array(object.transferLength);
      for (let sbn = 0; sbn < object.expectedBlocks; sbn++) {
        const blockData = object.blocks.get(sbn)!.data!;
        data.set(blockData.subarray(0, Math.min(blockData.length, data.length - sbn * object.blockLength)), sbn * object.blockLength);
      }
      this.reset(key);
      if (!object.contentLocation) return;
      const recovered: RouteObject = {
        tsi: object.tsi,
        toi: object.toi,
        codepoint: object.codepoint,
        integrity: 100,
        contentType: object.contentType,
        contentLocation: object.contentLocation,
        dstIP: object.dstIP,
        sourceIP: object.sourceIP,
        fecRecovered: true,
        data,
      };
      this.#onRecovered?.(recovered);
    } catch {
      // A malformed FTI/symbol must not take down the multicast byte listener.
      if (key) this.reset(key);
    }
  }

  reset(key: string): void {
    const object = this.#objects.get(key);
    if (!object) return;
    this.#objects.delete(key);
    for (const block of object.blocks.values()) {
      try { block.decoder?.free(); } catch { /* a failed decoder is already unusable */ }
    }
  }

  evictOldest(): void {
    const key = this.#objects.keys().next().value;
    if (key !== undefined) this.reset(key);
  }

  dispose(): void {
    for (const key of [...this.#objects.keys()]) this.reset(key);
  }
}

function drain(exports: RouteWasmExports, onObject: (object: RouteObject) => void): void {
  for (let remaining = exports.route_get_completed_count(); remaining > 0; remaining--) {
    try {
      const length = exports.route_pop_completed_len();
      const object: RouteObject = {
        tsi: uint64(exports.route_pop_completed_tsi()),
        toi: uint64(exports.route_pop_completed_toi()),
        codepoint: exports.route_pop_completed_codepoint(),
        integrity: exports.route_pop_completed_integrity?.() ?? 100,
        contentType: readString(
          exports,
          exports.route_pop_completed_type?.(),
          exports.route_pop_completed_type_len?.(),
        ),
        contentLocation: readString(
          exports,
          exports.route_pop_completed_location?.(),
          exports.route_pop_completed_location_len?.(),
        ),
        data: copyBytes(exports, exports.route_pop_completed_data(), length),
        dstIP: readString(
          exports,
          exports.route_pop_completed_dstip?.(),
          exports.route_pop_completed_dstip_len?.(),
        ),
      };
      onObject(object);
    } finally {
      exports.route_pop_completed_advance();
    }
  }
}

/**
 * Bridges a `window.multicast` bytes subscription and route.wasm
 * into the fetch proxy. route.wasm's FDT `contentLocation` is the URL key, so
 * Shaka can consume DASH/HLS manifests and CMAF objects with its normal requests.
 */
export class RouteMabrSession {
  readonly #options: RouteMabrOptions;
  readonly #proxy: MabrRouteProxy;
  #subscriptions: Array<ByteSubscription & { unsubscribe(): Promise<void> | void }> = [];
  #listeners: Array<{ subscription: ByteSubscription; listener: (event: CustomEvent<ArrayBuffer>) => void }> = [];
  #raptorq: RouteRaptorQCollector | undefined;
  #endpointKeys = new Set<string>();
  #discovering = Promise.resolve();
  #discoveryPending = false;
  #lastSlsCount: number | undefined;
  #sessionGeneration = 0;
  #active = false;

  constructor(options: RouteMabrOptions) {
    this.#proxy = new MabrRouteProxy(options);
    this.#options = options;
    if (options.raptorq) {
      this.#raptorq = new RouteRaptorQCollector({
        ...options.raptorq,
        onRecovered: (object) => {
          this.#ingest(object);
          options.raptorq?.onRecovered?.(object);
        },
      });
    }
    const ingress = options.ingress ?? 'tuner';
    const endpoints = options.slsEndpoint ? [options.slsEndpoint] : options.endpoints ?? (options.group && options.port != null ?
      [{group: options.group, port: options.port, ...(options.source ? {source: options.source} : {})}] : []);
    if ((options.standard ?? 'atsc3') === 'atsc3' && endpoints.length === 0 && !options.sltUrl) {
      throw new RangeError('group and port (or endpoints or sltUrl) are required for ATSC 3');
    }
    if (endpoints.some((endpoint) => typeof endpoint.group !== 'string' || endpoint.group.trim() === '' ||
        !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535)) {
      throw new RangeError('ROUTE endpoints require a group and valid port');
    }
    if (endpoints.some((endpoint) => endpoint.source !== undefined &&
        (typeof endpoint.source !== 'string' || endpoint.source.trim() === ''))) {
      throw new RangeError('ROUTE endpoint source must be a nonempty string');
    }
    const endpointKeys = new Set<string>();
    for (const endpoint of endpoints) {
      const key = `${normalizeRouteSource(endpoint.source) ?? ''}\u0000${endpoint.group.trim()}\u0000${endpoint.port}`;
      if (endpointKeys.has(key)) throw new RangeError('ROUTE endpoints must be unique');
      endpointKeys.add(key);
    }
    if ((options.standard ?? 'atsc3') === 'atsc1' && ingress !== 'tuner') {
      throw new RangeError('ATSC1 is only valid with tuner ingress');
    }
    if (ingress === 'amt' && (!options.relay || !Number.isInteger(options.relayPort) || options.relayPort! < 1 || options.relayPort! > 65535)) {
      throw new RangeError('relay and relayPort are required for AMT ingress');
    }
  }

  get size(): number { return this.#proxy.size; }
  installFetch(): () => void { return this.#proxy.installFetch(); }
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> { return this.#proxy.fetch(input, init); }

  async start(): Promise<void> {
    if (this.#subscriptions.length) return;
    const standard = this.#options.standard ?? 'atsc3';
    if (standard === 'atsc1') {
      throw new Error('ATSC1 raw MPEG-TS requires a host-provided route_process_ts feed; window.multicast exposes UDP bytes only');
    }
    const ingress = this.#options.ingress ?? 'tuner';
    let endpoints = this.#options.slsEndpoint ? [this.#options.slsEndpoint] : this.#options.endpoints ?? (this.#options.group && this.#options.port != null ?
      [{group: this.#options.group, port: this.#options.port, ...(this.#options.source ? {source: this.#options.source} : {})}] : []);
    if (endpoints.length === 0 && this.#options.sltUrl) {
      endpoints = [await discoverSlsEndpoint(this.#options)];
    }
    if (endpoints.length === 0) throw new RangeError('group and port (or endpoints or sltUrl) are required for ATSC 3');
    const exports = this.#options.wasm.exports;
    const discoverEndpoints = this.#options.discoverEndpoints ?? Boolean(this.#options.slsEndpoint || this.#options.sltUrl);
    const slsGroup = (this.#options.slsEndpoint?.group ?? endpoints[0]!.group).trim();
    const generation = ++this.#sessionGeneration;
    this.#lastSlsCount = undefined;
    const subscribeEndpoint = async (endpoint: RouteEndpoint): Promise<void> => {
      if (!this.#active || generation !== this.#sessionGeneration) return;
      const group = endpoint.group.trim();
      const source = normalizeRouteSource(endpoint.source);
      const endpointKey = `${source ?? ''}\u0000${group}\u0000${endpoint.port}`;
      if (this.#endpointKeys.has(endpointKey)) return;
      this.#endpointKeys.add(endpointKey);
      const common = {
        group,
        port: endpoint.port,
        consume: 'bytes' as const,
        ...(source ? { source } : {}),
      };
      const config: object = ingress === 'native'
        ? { ...common, origin: 'ip-multicast' }
        : ingress === 'amt'
          ? { ...common, origin: 'amt', relay: this.#options.relay!, relayPort: this.#options.relayPort! }
          : { ...common, origin: 'tuner', standard: 'atsc3', protocol: 'route' };
      try {
        const subscription = await this.#options.gateway.subscribe(config);
        if (!this.#active || generation !== this.#sessionGeneration) {
          await subscription.unsubscribe();
          return;
        }
        const listener = (event: CustomEvent<ArrayBuffer>) => {
          const payload = new Uint8Array(event.detail);
          const pointer = exports.route_get_buffer();
          const size = exports.route_get_buffer_size();
          const inputPointer = numberValue(pointer);
          if (size <= 0) throw new RangeError('route.wasm input buffer is unavailable');
          if (!exports.route_process_udp) throw new Error('route.wasm has no UDP entrypoint');
          const groupBytes = new TextEncoder().encode(group);
          const sourceBytes = source && exports.route_process_udp_with_source
            ? new TextEncoder().encode(source) : new Uint8Array();
          if (groupBytes.length + sourceBytes.length + payload.length > size) throw new RangeError('route packet exceeds route.wasm input buffer');
          const input = new Uint8Array(exports.memory.buffer, inputPointer, size);
          input.set(groupBytes, 0); input.set(sourceBytes, groupBytes.length); input.set(payload, groupBytes.length + sourceBytes.length);
          if (sourceBytes.length && exports.route_process_udp_with_source) {
            exports.route_process_udp_with_source(groupBytes.length, sourceBytes.length, endpoint.port, payload.length);
          } else {
            exports.route_process_udp(groupBytes.length, endpoint.port, payload.length);
          }
          drainRaptorQ(exports, this.#raptorq);
          drain(exports, (object) => this.#ingest(object));
          this.#ingestManifest(exports);
          if (discoverEndpoints && group === slsGroup) {
            this.#queueSlsDiscovery(slsGroup, generation, exports, subscribeEndpoint);
          }
        };
        subscription.addEventListener('bytes', listener);
        this.#subscriptions.push(subscription);
        this.#listeners.push({subscription, listener});
      } catch (error) {
        this.#endpointKeys.delete(endpointKey);
        throw error;
      }
    };
    try {
      this.#active = true;
      for (const endpoint of endpoints) {
        await subscribeEndpoint(endpoint);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#active = false;
    this.#sessionGeneration++;
    this.#lastSlsCount = undefined;
    this.#discoveryPending = false;
    if (!this.#subscriptions.length) {
      this.#endpointKeys.clear();
      this.#raptorq?.dispose();
      return;
    }
    const listeners = this.#listeners.splice(0);
    const subscriptions = this.#subscriptions.splice(0);
    this.#endpointKeys.clear();
    for (const {subscription, listener} of listeners) subscription.removeEventListener?.('bytes', listener);
    this.#raptorq?.dispose();
    await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
  }

  #queueSlsDiscovery(slsGroup: string, generation: number, exports: RouteWasmExports,
    subscribeEndpoint: (endpoint: RouteEndpoint) => Promise<void>): void {
    if (this.#discoveryPending) return;
    let slsCount: number | undefined;
    if (exports.route_get_sls_count) {
      try {
        slsCount = safeValue(exports.route_get_sls_count(), 'SLS count');
      } catch {
        return;
      }
      if (this.#lastSlsCount === slsCount) return;
    }
    this.#discoveryPending = true;
    this.#discovering = this.#discovering.then(async () => {
      if (!this.#active || generation !== this.#sessionGeneration) return;
      const count = exports.route_stsid_session_count?.() ?? 0;
      const read = exports.route_stsid_session;
      const readLen = exports.route_stsid_session_len;
      if (slsCount !== undefined) this.#lastSlsCount = slsCount;
      if (!read || !readLen || !Number.isSafeInteger(count) || count < 1) return;
      for (let index = 0; index < count; index++) {
        const raw = read(index);
        const value = readString(exports, raw, readLen());
        const [, group, portText, source, advertisedSls] = value.split('|');
        if (!group || advertisedSls !== slsGroup) continue;
        const port = Number(portText);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        const normalizedSource = normalizeRouteSource(source);
        await subscribeEndpoint({group, port, ...(normalizedSource ? {source: normalizedSource} : {})});
      }
    }).catch(() => { /* malformed or withdrawn SLS must not stop the SLS leg */ }).finally(() => {
      if (generation === this.#sessionGeneration) this.#discoveryPending = false;
    });
  }

  #ingest(object: RouteObject): void {
    if (object.integrity >= 100 && object.contentLocation) {
      this.#proxy.put({ url: object.contentLocation, data: object.data, contentType: object.contentType || undefined });
    }
    this.#options.onObject?.(object);
  }

  #ingestManifest(exports: RouteWasmExports): void {
    // New route.wasm builds retain every valid DASH/HLS SLS part. This is
    // needed when a service bundle carries an origin MPD before the player
    // presentation MPD (and its HLS playlists).
    const count = exports.route_sls_manifest_count?.() ?? 0;
    if (exports.route_sls_manifest && exports.route_sls_manifest_len &&
        exports.route_sls_manifest_location && exports.route_sls_manifest_location_len &&
        Number.isSafeInteger(count) && count > 0) {
      for (let index = 0; index < count; index++) {
        const bodyPointer = exports.route_sls_manifest(index);
        const bodyLength = Math.min(exports.route_sls_manifest_len(), MAX_RESULT_BUFFER_BYTES);
        if (bodyPointer === undefined || bodyLength <= 0) continue;
        const data = copyBytes(exports, bodyPointer, bodyLength);
        const location = readString(
          exports,
          exports.route_sls_manifest_location(index),
          exports.route_sls_manifest_location_len(),
        );
        if (location) this.#proxy.put({ url: location, data });
      }
      return;
    }
    if (!exports.route_get_mpd || !exports.route_get_mpd_len ||
        !exports.route_get_mpd_location || !exports.route_get_mpd_location_len) return;
    const location = readString(exports, exports.route_get_mpd_location(), exports.route_get_mpd_location_len());
    // route_get_mpd() copies into route.wasm's fixed 1 MiB result buffer while
    // route_get_mpd_len() reports the uncapped source length.
    const length = Math.min(exports.route_get_mpd_len(), MAX_RESULT_BUFFER_BYTES);
    if (!location || length <= 0) return;
    const data = copyBytes(exports, exports.route_get_mpd(), length);
    this.#proxy.put({ url: location, data });
  }
}

export function createRouteMabrSession(options: RouteMabrOptions): RouteMabrSession {
  return new RouteMabrSession(options);
}
