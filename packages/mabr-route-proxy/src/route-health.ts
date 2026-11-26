/**
 * Browser-side adapter for the shared ROUTE rendition-health policy.
 *
 * This module deliberately contains no health thresholds.  The receiver/WASM
 * policy provider owns the state machine and hysteresis; this file only
 * normalizes its decision, relates a decision to a Shaka rendition, and
 * applies an explicit cap to Shaka.  In particular, receive bytes and receive
 * bitrate are never used as Shaka's HTTP bandwidth estimate.
 */

export const DEFAULT_ROUTE_POLICY_VERSION = 'gw-rendition-health/2';

export type RouteTransport = 'native' | 'amt' | 'tuner' | 'http' | 'unknown';
export type RoutePlaybackFormat = 'hls' | 'dash' | 'unknown';
export type RouteHealthState = 'UNKNOWN' | 'JOINING' | 'HEALTHY' | 'DEGRADED' | 'STALE' | string;

export interface RouteRenditionHealth {
  tsi?: number | string;
  template?: string;
  /** Optional media path reported by the receiver. Never inferred by this adapter. */
  path?: string;
  last_path?: string;
  demanded?: boolean;
  joined?: boolean;
  receive_bitrate_bps?: number;
  received_bytes?: number;
  received_packets?: number;
  complete?: boolean;
  assembled_bytes?: number;
  expected_bytes?: number;
  last_toi?: number | string;
  last_complete_toi?: number | string;
  transport?: RouteTransport;
  state?: RouteHealthState;
  last_packet_at?: string;
  [key: string]: unknown;
}

export interface RoutePolicyDecision {
  version?: string;
  rendition?: string;
  tsi?: number | string;
  state?: RouteHealthState;
  transport?: RouteTransport;
  /** True means the policy explicitly asks the player adapter to cap/filter. */
  cap?: boolean;
  max_bandwidth?: number;
  allowed?: boolean;
  reason?: string;
  last_toi?: number | string;
  path?: string;
  [key: string]: unknown;
}

export interface RoutePolicySnapshot {
  version?: string;
  generated_at?: string;
  error?: string;
  decisions: RoutePolicyDecision[];
  renditions: RouteRenditionHealth[];
}

/**
 * The minimal part of a Shaka player needed by this adapter.  The real Shaka
 * object is intentionally not a dependency of this small package.
 */
export interface ShakaRoutePlayer {
  configure(config: unknown): void;
  getVariantTracks?(): readonly unknown[];
  getManifest?(): unknown;
  addEventListener?(type: string, listener: (event: Event) => void): void;
  removeEventListener?(type: string, listener: (event: Event) => void): void;
}

export interface ShakaRenditionBinding {
  /** Stable local id, normally Shaka's variant/representation id. */
  id: string;
  format?: RoutePlaybackFormat;
  bandwidth?: number;
  /** URLs, representation ids, or other exact aliases from the player manifest. */
  aliases?: readonly string[];
  uris?: readonly string[];
  template?: string;
  tsi?: number | string;
}

export interface RoutePolicyContext {
  format: RoutePlaybackFormat;
  renditions: readonly ShakaRenditionBinding[];
}

/**
 * A provider is supplied by the existing route.wasm receiver/policy engine.
 * It may return the future schema as an object, JSON text, or a list of
 * decisions.  A subscription is optional; callers can poll with refresh().
 */
export interface RouteHealthProvider {
  getSnapshot?: (context: RoutePolicyContext) => unknown | Promise<unknown>;
  subscribe?: (listener: (snapshot?: unknown) => void) => (() => void) | void;
}

export interface RouteHealthDiagnostic {
  timestamp: string;
  format: RoutePlaybackFormat;
  rendition: string;
  tsi?: number | string;
  toi?: number | string;
  transport: RouteTransport;
  /** Receiver-reported path, or the honest placeholder when unavailable. */
  path: string;
  state: RouteHealthState;
  complete?: boolean;
  reason: string;
  action: 'allow' | 'cap' | 'restore' | 'error';
  max_bandwidth?: number;
}

export interface RouteHealthApplyResult {
  format: RoutePlaybackFormat;
  snapshot: RoutePolicySnapshot;
  mappings: readonly RouteRenditionMapping[];
  /** The exact cap supplied/derived from policy; undefined means no cap. */
  maxBandwidth?: number;
  capped: boolean;
  diagnostics: readonly RouteHealthDiagnostic[];
}

export interface RouteRenditionMapping {
  binding: ShakaRenditionBinding;
  health?: RouteRenditionHealth;
  decision?: RoutePolicyDecision;
}

export interface ShakaRouteHealthAdapterOptions {
  player: ShakaRoutePlayer;
  provider: RouteHealthProvider;
  format?: RoutePlaybackFormat;
  /** Use this when the player manifest URL is available before tracks are built. */
  manifestUrl?: string;
  /** Caller may provide exact representation/template bindings. */
  getRenditions?: () => readonly ShakaRenditionBinding[] | Promise<readonly ShakaRenditionBinding[]>;
  /** Accepted policy version. Unknown versions fail open and never cap. */
  policyVersion?: string;
  onDiagnostic?: (diagnostic: RouteHealthDiagnostic) => void;
}

interface AnyRecord { [key: string]: unknown }

function record(value: unknown): AnyRecord | undefined {
  return value !== null && typeof value === 'object' ? value as AnyRecord : undefined;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function idValue(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function firstString(source: AnyRecord | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(source?.[key]);
    if (value) return value;
  }
  return undefined;
}

function firstNumber(source: AnyRecord | undefined, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberValue(source?.[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstId(source: AnyRecord | undefined, ...keys: string[]): number | string | undefined {
  for (const key of keys) {
    const value = idValue(source?.[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Normalize provider spelling without guessing a source that was not reported. */
export function normalizeRouteTransport(value: unknown): RouteTransport {
  const normalized = stringValue(value)?.toLowerCase().replace(/[ _-]+/g, '_');
  switch (normalized) {
    case 'native':
    case 'direct':
    case 'direct_iwa':
    case 'iwa':
    case 'socket':
    case 'direct_socket':
      return 'native';
    case 'amt':
    case 'mobile_beacon':
    case 'mobilebeacon':
      return 'amt';
    case 'tuner':
      return 'tuner';
    case 'http':
    case 'unicast':
    case 'origin':
      return 'http';
    default:
      return 'unknown';
  }
}

/** Human-readable labels are only aliases for a transport explicitly reported by the provider. */
export function routeTransportLabel(transport: RouteTransport): string {
  switch (transport) {
    case 'native': return 'direct IWA socket';
    case 'amt': return 'Mobile Beacon';
    case 'tuner': return 'tuner';
    case 'http': return 'HTTP';
    default: return 'path not reported';
  }
}

function normalizeFormat(value: unknown): RoutePlaybackFormat {
  const normalized = stringValue(value)?.toLowerCase();
  return normalized === 'hls' || normalized === 'dash' ? normalized : 'unknown';
}

export function inferRoutePlaybackFormat(value: string | undefined): RoutePlaybackFormat {
  if (!value) return 'unknown';
  try {
    const pathname = new URL(value, 'http://route.invalid/').pathname.toLowerCase();
    if (pathname.endsWith('.m3u8')) return 'hls';
    if (pathname.endsWith('.mpd')) return 'dash';
  } catch {
    // A non-URL manifest label is still allowed; do not guess its format.
  }
  return 'unknown';
}

function normalizeHealth(value: unknown): RouteRenditionHealth | undefined {
  const source = record(value);
  if (!source) return undefined;
  const health: RouteRenditionHealth = { ...source };
  const latestObject = record(source.latest_object ?? source.latestObject ?? source.latest);
  const tsi = firstId(source, 'tsi', 'TSI');
  if (tsi !== undefined) health.tsi = tsi;
  const template = firstString(source, 'template', 'file_template', 'fileTemplate');
  if (template) health.template = template;
  const path = firstString(source, 'path', 'last_path', 'lastPath', 'content_location', 'contentLocation') ??
    firstString(latestObject, 'path', 'content_location', 'contentLocation');
  if (path) health.path = path;
  const lastPath = firstString(source, 'last_path', 'lastPath');
  if (lastPath) health.last_path = lastPath;
  const transport = firstString(source, 'transport', 'serving_transport', 'servingTransport');
  if (transport !== undefined) health.transport = normalizeRouteTransport(transport);
  const state = firstString(source, 'state');
  if (state) health.state = state;
  const toi = firstId(source, 'last_toi', 'lastToi', 'toi', 'latest_toi', 'latestToi') ??
    firstId(latestObject, 'last_toi', 'lastToi', 'toi', 'latest_toi', 'latestToi');
  if (toi !== undefined) health.last_toi = toi;
  const completeToi = firstId(source, 'last_complete_toi', 'lastCompleteToi');
  if (completeToi !== undefined) health.last_complete_toi = completeToi;
  const numericFields: Array<[keyof RouteRenditionHealth, string[]]> = [
    ['receive_bitrate_bps', ['receive_bitrate_bps', 'receiveBitrateBps', 'bitrate_bps', 'bitrateBps']],
    ['received_bytes', ['received_bytes', 'receivedBytes']],
    ['received_packets', ['received_packets', 'receivedPackets']],
    ['assembled_bytes', ['assembled_bytes', 'assembledBytes']],
    ['expected_bytes', ['expected_bytes', 'expectedBytes']],
  ];
  for (const [key, keys] of numericFields) {
    const number = firstNumber(source, ...keys) ?? firstNumber(latestObject, ...keys);
    if (number !== undefined && number >= 0) health[key] = number;
  }
  const complete = booleanValue(source.complete) ?? booleanValue(latestObject?.complete);
  if (complete !== undefined) health.complete = complete;
  const demanded = booleanValue(source.demanded);
  if (demanded !== undefined) health.demanded = demanded;
  const joined = booleanValue(source.joined);
  if (joined !== undefined) health.joined = joined;
  const packetAt = firstString(source, 'last_packet_at', 'lastPacketAt');
  if (packetAt) health.last_packet_at = packetAt;
  return health;
}

function normalizeDecision(value: unknown): RoutePolicyDecision | undefined {
  const source = record(value);
  if (!source) return undefined;
  const decision: RoutePolicyDecision = { ...source };
  const version = firstString(source, 'version', 'policy_version', 'policyVersion');
  if (version) decision.version = version;
  const rendition = firstString(source, 'rendition', 'rendition_id', 'renditionId', 'representation_id', 'representationId');
  if (rendition) decision.rendition = rendition;
  const tsi = firstId(source, 'tsi', 'TSI');
  if (tsi !== undefined) decision.tsi = tsi;
  const transport = firstString(source, 'transport', 'serving_transport', 'servingTransport');
  if (transport) decision.transport = normalizeRouteTransport(transport);
  const state = firstString(source, 'state');
  if (state) decision.state = state;
  const cap = booleanValue(source.cap ?? source.restrict ?? source.restricted);
  if (cap !== undefined) decision.cap = cap;
  const allowed = booleanValue(source.allowed);
  if (allowed !== undefined) decision.allowed = allowed;
  const maxBandwidth = firstNumber(source, 'max_bandwidth', 'maxBandwidth', 'max_bitrate_bps', 'maxBitrateBps');
  if (maxBandwidth !== undefined && maxBandwidth >= 0) decision.max_bandwidth = maxBandwidth;
  const reason = firstString(source, 'reason', 'demotion_reason', 'demotionReason');
  if (reason) decision.reason = reason;
  const toi = firstId(source, 'last_toi', 'lastToi', 'toi', 'latest_toi', 'latestToi');
  if (toi !== undefined) decision.last_toi = toi;
  const path = firstString(source, 'path', 'last_path', 'lastPath');
  if (path) decision.path = path;
  return decision;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return { error: 'invalid_policy_json' }; }
}

/** Accept the rollout's snake_case JSON while remaining tolerant of a future provider wrapper. */
export function normalizeRoutePolicySnapshot(value: unknown): RoutePolicySnapshot {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) {
    return {
      decisions: parsed.map(normalizeDecision).filter((item): item is RoutePolicyDecision => item !== undefined),
      renditions: [],
    };
  }
  const source = record(parsed);
  if (!source) return { decisions: [], renditions: [], error: 'invalid_policy_snapshot' };
  const version = firstString(source, 'version', 'policy_version', 'policyVersion');
  const generatedAt = firstString(source, 'generated_at', 'generatedAt');
  const error = firstString(source, 'error');
  const rawDecisions = source.decisions ?? source.policies ?? source.policy_decisions ?? source.policyDecisions;
  const decisions: RoutePolicyDecision[] = [];
  for (const item of array(rawDecisions)) {
    const decision = normalizeDecision(item);
    if (decision) decisions.push(decision);
  }
  const singular = normalizeDecision(source.decision);
  if (singular) decisions.push(singular);
  // A bare decision object is useful for a single rendition provider.
  if (decisions.length === 0 && (source.cap !== undefined || source.allowed !== undefined ||
      source.max_bandwidth !== undefined || source.maxBandwidth !== undefined || source.rendition !== undefined || source.tsi !== undefined)) {
    const decision = normalizeDecision(source);
    if (decision) decisions.push(decision);
  }
  const rawHealth = source.renditions ?? source.health ?? source.subscriptions;
  const renditions: RouteRenditionHealth[] = [];
  for (const item of array(rawHealth)) {
    const health = normalizeHealth(item);
    if (health) renditions.push(health);
  }
  const decisionVersion = decisions.find((item) => item.version)?.version;
  return { ...((version ?? decisionVersion) ? { version: version ?? decisionVersion } : {}), ...(generatedAt ? { generated_at: generatedAt } : {}), ...(error ? { error } : {}), decisions, renditions };
}

function pathPart(value: string): string {
  try {
    const parsed = new URL(value, 'http://route.invalid/');
    return parsed.pathname.replace(/^\/+/, '');
  } catch {
    return value.split(/[?#]/, 1)[0]!.replace(/^\/+/, '');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/** Build a matcher for ATSC FileTemplate `$TOI%05d$`/`%05d` paths. */
export function routeTemplateRegExp(template: string): RegExp {
  const source = pathPart(template);
  const token = /(\$TOI(?:%0?\d+d)?\$|\$TOI|%0?\d+d|%d|\{TOI\})/gi;
  let expression = '^';
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(source))) {
    expression += escapeRegExp(source.slice(offset, match.index));
    expression += '(\\d+)';
    offset = match.index + match[0].length;
  }
  expression += escapeRegExp(source.slice(offset)) + '$';
  return new RegExp(expression, 'i');
}

export function matchRouteTemplate(template: string, path: string): { toi: string } | undefined {
  const match = routeTemplateRegExp(template).exec(pathPart(path));
  return match?.[1] ? { toi: match[1] } : undefined;
}

function sameId(left: number | string | undefined, right: number | string | undefined): boolean {
  return left !== undefined && right !== undefined && String(left) === String(right);
}

function normalizedAlias(value: string): string {
  return pathPart(value).toLowerCase();
}

function healthMatchesBinding(health: RouteRenditionHealth, binding: ShakaRenditionBinding): boolean {
  if (sameId(health.tsi, binding.tsi)) return true;
  const aliases = [binding.id, ...(binding.aliases ?? []), ...(binding.uris ?? [])].filter(Boolean).map(normalizedAlias);
  if (health.template && aliases.some((alias) => {
    try { return routeTemplateRegExp(health.template!).test(alias); } catch { return false; }
  })) return true;
  if (health.template && binding.template) {
    return normalizedAlias(health.template) === normalizedAlias(binding.template);
  }
  return false;
}

function decisionMatchesBinding(decision: RoutePolicyDecision, binding: ShakaRenditionBinding): boolean {
  if (decision.tsi !== undefined && sameId(decision.tsi, binding.tsi)) return true;
  if (decision.rendition === undefined) return false;
  const wanted = normalizedAlias(decision.rendition);
  return [binding.id, ...(binding.aliases ?? []), ...(binding.uris ?? []), binding.template]
    .filter((item): item is string => Boolean(item))
    .some((item) => normalizedAlias(item) === wanted || item === decision.rendition);
}

function decisionMatchesHealth(decision: RoutePolicyDecision, health: RouteRenditionHealth): boolean {
  if (decision.tsi !== undefined && sameId(decision.tsi, health.tsi)) return true;
  if (decision.rendition === undefined) return false;
  const wanted = normalizedAlias(decision.rendition);
  return [health.template, health.path, health.last_path]
    .filter((item): item is string => Boolean(item))
    .some((item) => normalizedAlias(item) === wanted || item === decision.rendition);
}

export function mapRouteHealthToShakaRenditions(
  renditions: readonly ShakaRenditionBinding[],
  snapshot: RoutePolicySnapshot,
): RouteRenditionMapping[] {
  const decisions = snapshot.decisions;
  const health = snapshot.renditions;
  return renditions.map((binding) => {
    const matchedHealth = health.find((item) => healthMatchesBinding(item, binding));
    return {
      binding,
      health: matchedHealth,
      decision: decisions.find((item) => decisionMatchesBinding(item, binding) ||
        (matchedHealth !== undefined && decisionMatchesHealth(item, matchedHealth))) ??
        decisions.find((item) => item.rendition === undefined && item.tsi === undefined),
    };
  });
}

function decisionCaps(decision: RoutePolicyDecision | undefined): boolean {
  if (!decision) return false;
  return decision.cap === true || decision.allowed === false ||
    (decision.max_bandwidth !== undefined && decision.cap !== false);
}

function validBandwidth(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function policyMaxBandwidth(mappings: readonly RouteRenditionMapping[]): number | undefined {
  if (!mappings.some((mapping) => decisionCaps(mapping.decision))) return undefined;
  const explicitGlobal = mappings
    .filter((mapping) => decisionCaps(mapping.decision) &&
      mapping.decision?.rendition === undefined && mapping.decision?.tsi === undefined)
    .map((mapping) => mapping.decision?.max_bandwidth)
    .filter(validBandwidth);
  const blocked = mappings.filter((mapping) => decisionCaps(mapping.decision) &&
    !validBandwidth(mapping.decision?.max_bandwidth));
  const candidateBandwidths = mappings.flatMap((mapping) => {
    if (blocked.includes(mapping)) return [];
    const bindingBandwidth = mapping.binding.bandwidth;
    const targetedCap = decisionCaps(mapping.decision) &&
      (mapping.decision?.rendition !== undefined || mapping.decision?.tsi !== undefined) &&
      validBandwidth(mapping.decision?.max_bandwidth) ? mapping.decision!.max_bandwidth : undefined;
    const effective = targetedCap !== undefined && validBandwidth(bindingBandwidth)
      ? Math.min(bindingBandwidth, targetedCap)
      : targetedCap ?? bindingBandwidth;
    return validBandwidth(effective) ? [effective] : [];
  });
  const candidates = candidateBandwidths;
  if (candidates.length === 0) return undefined;
  const candidateMax = Math.max(...candidates);
  return explicitGlobal.length > 0 ? Math.min(candidateMax, ...explicitGlobal) : candidateMax;
}

function supportedVersion(snapshot: RoutePolicySnapshot, expected: string): boolean {
  return snapshot.version === expected;
}

function reportedPath(mapping: RouteRenditionMapping): string {
  return mapping.decision?.path ?? mapping.health?.last_path ?? mapping.health?.path ?? 'path not reported';
}

function reportedTransport(mapping: RouteRenditionMapping): RouteTransport {
  return mapping.decision?.transport ?? mapping.health?.transport ?? 'unknown';
}

function reportedToi(mapping: RouteRenditionMapping): number | string | undefined {
  return mapping.decision?.last_toi ?? mapping.health?.last_complete_toi ?? mapping.health?.last_toi;
}

function diagnosticFor(
  mapping: RouteRenditionMapping,
  format: RoutePlaybackFormat,
  action: RouteHealthDiagnostic['action'],
  maxBandwidth?: number,
): RouteHealthDiagnostic {
  const decision = mapping.decision;
  const health = mapping.health;
  return {
    timestamp: new Date().toISOString(),
    format,
    rendition: mapping.binding.id,
    ...(decision?.tsi ?? health?.tsi ?? mapping.binding.tsi) !== undefined ? { tsi: decision?.tsi ?? health?.tsi ?? mapping.binding.tsi } : {},
    ...(reportedToi(mapping) !== undefined ? { toi: reportedToi(mapping) } : {}),
    transport: reportedTransport(mapping),
    path: reportedPath(mapping),
    state: decision?.state ?? health?.state ?? 'UNKNOWN',
    ...(health?.complete !== undefined ? { complete: health.complete } : {}),
    reason: decision?.reason ?? (action === 'cap' ? 'policy_cap' : action === 'restore' ? 'policy_restore' : 'policy_allow'),
    action,
    ...(maxBandwidth !== undefined ? { max_bandwidth: maxBandwidth } : {}),
  };
}

export function formatRouteHealthDiagnostic(diagnostic: RouteHealthDiagnostic): string {
  const tsi = diagnostic.tsi === undefined ? '?' : String(diagnostic.tsi);
  const toi = diagnostic.toi === undefined ? '?' : String(diagnostic.toi);
  const cap = diagnostic.max_bandwidth === undefined ? '' : ` maxBandwidth=${diagnostic.max_bandwidth}`;
  return `route-health format=${diagnostic.format} rendition=${diagnostic.rendition} tsi=${tsi} toi=${toi} transport=${diagnostic.transport}(${routeTransportLabel(diagnostic.transport)}) path=${diagnostic.path} state=${diagnostic.state} complete=${diagnostic.complete === undefined ? '?' : diagnostic.complete} action=${diagnostic.action} reason=${diagnostic.reason}${cap}`;
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string' && value.trim()) output.push(value.trim());
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output);
}

/**
 * Convert the public-ish track/manifest fields exposed by Shaka into stable
 * aliases. Callers with a custom manifest parser can pass bindings directly.
 */
export function extractShakaRenditionBindings(
  player: ShakaRoutePlayer,
  options: { format?: RoutePlaybackFormat; manifestUrl?: string } = {},
): ShakaRenditionBinding[] {
  const tracks = player.getVariantTracks?.() ?? [];
  const manifest = record(player.getManifest?.());
  const variants = array(manifest?.variants).map(record).filter((item): item is AnyRecord => item !== undefined);
  const format = options.format ?? inferRoutePlaybackFormat(options.manifestUrl);
  return tracks.map((rawTrack, index) => {
    const track = record(rawTrack) ?? {};
    const id = String(track.id ?? track.originalId ?? index);
    const variant = variants.find((item) => String(item.id ?? '') === id);
    const aliases: string[] = [];
    const uris: string[] = [];
    collectStrings(track.originalId, aliases);
    collectStrings(track.videoId, aliases);
    collectStrings(track.audioId, aliases);
    collectStrings(track.uri, aliases);
    collectStrings(track.uris, uris);
    if (variant) {
      collectStrings(variant.id, aliases);
      collectStrings(variant.originalId, aliases);
      for (const stream of [variant.video, variant.audio]) {
        const streamRecord = record(stream);
        if (!streamRecord) continue;
        collectStrings(streamRecord.id, aliases);
        collectStrings(streamRecord.originalId, aliases);
        collectStrings(streamRecord.uri, uris);
        collectStrings(streamRecord.uris, uris);
      }
    }
    const stream = record(variant?.video) ?? record(variant?.audio);
    const template = firstString(stream, 'template', 'segmentTemplate', 'media', 'mediaTemplate');
    const bandwidth = firstNumber(track, 'bandwidth') ?? firstNumber(variant, 'bandwidth') ?? firstNumber(stream, 'bandwidth');
    return {
      id,
      ...(format !== 'unknown' ? { format } : {}),
      ...(bandwidth !== undefined && bandwidth > 0 ? { bandwidth } : {}),
      ...(aliases.length > 0 ? { aliases: [...new Set(aliases)] } : {}),
      ...(uris.length > 0 ? { uris: [...new Set(uris)] } : {}),
      ...(template ? { template } : {}),
    };
  });
}

export class ShakaRouteHealthAdapter {
  readonly #options: Required<Pick<ShakaRouteHealthAdapterOptions, 'player' | 'provider'>> & ShakaRouteHealthAdapterOptions;
  #unsubscribe: (() => void) | undefined;
  #lastSnapshot: RoutePolicySnapshot = { decisions: [], renditions: [] };
  #lastRenditions: readonly ShakaRenditionBinding[] = [];
  #lastResult: RouteHealthApplyResult | undefined;

  constructor(options: ShakaRouteHealthAdapterOptions) {
    this.#options = options as Required<Pick<ShakaRouteHealthAdapterOptions, 'player' | 'provider'>> & ShakaRouteHealthAdapterOptions;
  }

  get lastResult(): RouteHealthApplyResult | undefined { return this.#lastResult; }

  async refresh(renditions?: readonly ShakaRenditionBinding[]): Promise<RouteHealthApplyResult> {
    const bindings = renditions ?? await this.#readRenditions();
    const context: RoutePolicyContext = {
      format: this.#options.format ?? inferRoutePlaybackFormat(this.#options.manifestUrl),
      renditions: bindings,
    };
    let raw: unknown = this.#lastSnapshot;
    if (this.#options.provider.getSnapshot) raw = await this.#options.provider.getSnapshot(context);
    return this.apply(raw, bindings, context.format);
  }

  /** Apply a provider decision immediately; no timers or health thresholds run here. */
  apply(raw: unknown, renditions?: readonly ShakaRenditionBinding[], format?: RoutePlaybackFormat): RouteHealthApplyResult {
    const snapshot = normalizeRoutePolicySnapshot(raw);
    const playbackFormat = format ?? this.#options.format ?? inferRoutePlaybackFormat(this.#options.manifestUrl);
    const bindings = renditions ?? this.#lastRenditions;
    this.#lastSnapshot = snapshot;
    this.#lastRenditions = bindings;
    const mappings = mapRouteHealthToShakaRenditions(bindings, snapshot);
    const versionOk = !snapshot.error && supportedVersion(snapshot, this.#options.policyVersion ?? DEFAULT_ROUTE_POLICY_VERSION);
    const maxBandwidth = versionOk ? policyMaxBandwidth(mappings) : undefined;
    const capped = versionOk && maxBandwidth !== undefined;
    this.#options.player.configure({ abr: { restrictions: { maxBandwidth: capped ? maxBandwidth : Infinity } } });
    const diagnostics = mappings.map((mapping) => {
      const action: RouteHealthDiagnostic['action'] = snapshot.error || !versionOk
        ? 'error'
        : capped && decisionCaps(mapping.decision) ? 'cap' : capped ? 'allow' : 'restore';
      return diagnosticFor(mapping, playbackFormat, action, capped ? maxBandwidth : undefined);
    });
    for (const diagnostic of diagnostics) {
      try { this.#options.onDiagnostic?.(diagnostic); } catch { /* diagnostics cannot break playback */ }
    }
    if (!versionOk && !snapshot.error) {
      const diagnostic: RouteHealthDiagnostic = {
        timestamp: new Date().toISOString(), format: playbackFormat, rendition: 'policy',
        transport: 'unknown', path: 'path not reported', state: 'UNKNOWN', reason: 'policy_version_unknown', action: 'error',
      };
      try { this.#options.onDiagnostic?.(diagnostic); } catch { /* diagnostics cannot break playback */ }
    }
    const result: RouteHealthApplyResult = { format: playbackFormat, snapshot, mappings, ...(capped ? { maxBandwidth } : {}), capped, diagnostics };
    this.#lastResult = result;
    return result;
  }

  start(): () => void {
    if (this.#unsubscribe) return this.#unsubscribe;
    const listener = (snapshot?: unknown) => {
      void (snapshot === undefined ? this.refresh() : this.apply(snapshot));
    };
    const unsubscribe = this.#options.provider.subscribe?.(listener);
    const restoreProvider = typeof unsubscribe === 'function' ? unsubscribe : undefined;
    const restorePlayer = this.#options.player.addEventListener && this.#options.player.removeEventListener
      ? (() => {
          const onTracks = () => { void this.refresh(); };
          this.#options.player.addEventListener!('trackschanged', onTracks);
          return () => this.#options.player.removeEventListener!('trackschanged', onTracks);
        })()
      : undefined;
    this.#unsubscribe = () => {
      restoreProvider?.();
      restorePlayer?.();
      this.#unsubscribe = undefined;
    };
    return this.#unsubscribe;
  }

  stop(): void { this.#unsubscribe?.(); }

  async #readRenditions(): Promise<readonly ShakaRenditionBinding[]> {
    if (this.#options.getRenditions) return this.#options.getRenditions();
    return extractShakaRenditionBindings(this.#options.player, {
      format: this.#options.format,
      manifestUrl: this.#options.manifestUrl,
    });
  }
}

export function createShakaRouteHealthAdapter(options: ShakaRouteHealthAdapterOptions): ShakaRouteHealthAdapter {
  return new ShakaRouteHealthAdapter(options);
}
