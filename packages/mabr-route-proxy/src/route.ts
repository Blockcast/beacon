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
  /** Exact encoding-6 wire ID: eight bytes on current multicast main; four-byte IDs are accepted from older route.wasm builds. */
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
  const maxSbLen = packet.maxSbLen;
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
  // fec-raptorq's decoder ABI uses RFC 6330's four-byte decoder packet ID,
  // while current ROUTE puts the exact wire ID in eight bytes. Normalize from
  // the parsed scalar fields so both route.wasm generations remain usable.
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
  // Current multicast main uses [SBN:32][reserved:8][ESI:24] for encoding 6.
  // Keep the exact wire ID here; makeEncodingPacket() normalizes it for the
  // four-byte fec-raptorq decoder ABI.
  const payloadId = new Uint8Array(8);
  const view = new DataView(payloadId.buffer);
  view.setUint32(0, sbn >>> 0, false);
  payloadId[4] = 0;
  payloadId[5] = (esi >>> 16) & 0xff;
  payloadId[6] = (esi >>> 8) & 0xff;
  payloadId[7] = esi & 0xff;
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
      if (collector) collector.ingest(popRaptorQ(exports));
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
      if (packet.symbol.length === 0 || packet.symbol.length !== packet.symbolSize || !Number.isSafeInteger(packet.sbn) || packet.sbn < 0 ||
          packet.esi < 0 || packet.esi > MAX_RFC6330_ESI) return;
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
  #subscription: (ByteSubscription & { unsubscribe(): Promise<void> | void }) | undefined;
  #listener: ((event: CustomEvent<ArrayBuffer>) => void) | undefined;
  #raptorq: RouteRaptorQCollector | undefined;

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
    const port = options.port;
    if ((options.standard ?? 'atsc3') === 'atsc3' &&
        (!options.group || !Number.isInteger(port) || port! < 1 || port! > 65535)) {
      throw new RangeError('group and port are required for ATSC 3');
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
    if (this.#subscription) return;
    const standard = this.#options.standard ?? 'atsc3';
    if (standard === 'atsc1') {
      throw new Error('ATSC1 raw MPEG-TS requires a host-provided route_process_ts feed; window.multicast exposes UDP bytes only');
    }
    const ingress = this.#options.ingress ?? 'tuner';
    const common = {
      group: this.#options.group!,
      port: this.#options.port!,
      consume: 'bytes' as const,
      ...(this.#options.source ? { source: this.#options.source } : {}),
    };
    const config: object = ingress === 'native'
      ? { ...common, origin: 'ip-multicast' }
      : ingress === 'amt'
        ? { ...common, origin: 'amt', relay: this.#options.relay!, relayPort: this.#options.relayPort! }
        : { ...common, origin: 'tuner', standard: 'atsc3', protocol: 'route' };
    const subscription = await this.#options.gateway.subscribe(config);
    const exports = this.#options.wasm.exports;
    this.#subscription = subscription;
    this.#listener = (event) => {
      const payload = new Uint8Array(event.detail);
      const pointer = exports.route_get_buffer();
      const size = exports.route_get_buffer_size();
      const inputPointer = numberValue(pointer);
      if (size <= 0) throw new RangeError('route.wasm input buffer is unavailable');
      if (!exports.route_process_udp) throw new Error('route.wasm has no UDP entrypoint');
      const group = this.#options.group!;
      const port = this.#options.port!;
      const groupBytes = new TextEncoder().encode(group);
      const sourceBytes = this.#options.source && exports.route_process_udp_with_source
        ? new TextEncoder().encode(this.#options.source) : new Uint8Array();
      if (groupBytes.length + sourceBytes.length + payload.length > size) throw new RangeError('route packet exceeds route.wasm input buffer');
      const input = new Uint8Array(exports.memory.buffer, inputPointer, size);
      input.set(groupBytes, 0); input.set(sourceBytes, groupBytes.length); input.set(payload, groupBytes.length + sourceBytes.length);
      if (sourceBytes.length && exports.route_process_udp_with_source) {
        exports.route_process_udp_with_source(groupBytes.length, sourceBytes.length, port, payload.length);
      } else {
        exports.route_process_udp(groupBytes.length, port, payload.length);
      }
      drainRaptorQ(exports, this.#raptorq);
      drain(exports, (object) => this.#ingest(object));
      this.#ingestManifest(exports);
    };
    subscription.addEventListener('bytes', this.#listener);
  }

  async stop(): Promise<void> {
    const subscription = this.#subscription;
    if (!subscription) {
      this.#raptorq?.dispose();
      return;
    }
    if (this.#listener) subscription.removeEventListener?.('bytes', this.#listener);
    this.#listener = undefined;
    this.#subscription = undefined;
    this.#raptorq?.dispose();
    await subscription.unsubscribe();
  }

  #ingest(object: RouteObject): void {
    if (object.integrity >= 100 && object.contentLocation) {
      this.#proxy.put({ url: object.contentLocation, data: object.data, contentType: object.contentType || undefined });
    }
    this.#options.onObject?.(object);
  }

  #ingestManifest(exports: RouteWasmExports): void {
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
