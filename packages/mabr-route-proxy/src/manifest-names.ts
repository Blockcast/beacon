/**
 * The URLs a trusted manifest names (threat model R10, R24). A segment is
 * answered from ROUTE only if the manifest the player loaded over unicast
 * names it, so objects an on-path injector adds inside the cache scope are
 * never served.
 *
 * shortcut: DASH is read with regexes, not a DOM, and every BaseURL is crossed
 * with every media/initialization value instead of following the Period /
 * AdaptationSet nesting. That can name a URL the manifest does not strictly
 * produce, but never one outside the manifest's own bases. Upgrade to a real
 * MPD parse if a deployment needs exact matching.
 */

export interface ManifestNames {
  exact: Set<string>;
  patterns: RegExp[];
}

const KEY_TAGS = /^#EXT-X-(?:SESSION-)?KEY\b/;

function unescapeXml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Turn a DASH template URL into an anchored matcher; `$Number%05d$` etc. match one path segment. */
function templatePattern(href: string): RegExp | undefined {
  if (!href.includes('$')) return undefined;
  const source = href.split(/(\$(?:RepresentationID|Number|Bandwidth|Time|SubNumber)(?:%0\d+d)?\$|\$\$)/)
    .map((part) => part === '$$' ? '\\$' : /^\$.+\$$/.test(part) ? '[^/?#]+' : escapeRegExp(part)).join('');
  return new RegExp(`^${source}$`);
}

function resolve(value: string, base: string): string | undefined {
  try { return new URL(value, base).href; } catch { return undefined; }
}

export function manifestNames(url: string, body: string, scope: string): ManifestNames {
  const names: ManifestNames = { exact: new Set(), patterns: [] };
  const add = (value: string, base: string) => {
    const href = resolve(value, base);
    // R24: nothing outside the cache scope is ever named, so a manifest that
    // points segments at another origin cannot make ROUTE answer for it.
    if (!href || !href.startsWith(scope)) return;
    const pattern = templatePattern(href);
    if (pattern) names.patterns.push(pattern);
    else names.exact.add(href);
  };
  if (/^\s*#EXTM3U/.test(body) || /\.m3u8(?:[?#]|$)/i.test(url)) {
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (!line.startsWith('#')) { add(line, url); continue; }
      if (KEY_TAGS.test(line)) continue; // key URIs are control-plane, never ROUTE
      for (const match of line.matchAll(/URI="([^"]*)"/g)) add(match[1]!, url);
    }
    return names;
  }
  const bases = [url];
  for (const match of body.matchAll(/<BaseURL[^>]*>([^<]*)<\/BaseURL>/g)) {
    const base = resolve(unescapeXml(match[1]!.trim()), url);
    if (base) bases.push(base);
  }
  for (const match of body.matchAll(/\b(?:media|initialization|sourceURL|index)\s*=\s*"([^"]*)"/g)) {
    for (const base of bases) add(unescapeXml(match[1]!), base);
  }
  // A BaseURL that is itself a single file (SegmentBase on-demand profile).
  for (const base of bases.slice(1)) add(base, url);
  return names;
}

export function isNamed(url: string, set: ManifestNames): boolean {
  return set.exact.has(url) || set.patterns.some((pattern) => pattern.test(url));
}
