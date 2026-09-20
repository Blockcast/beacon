#!/usr/bin/env node
// Generates docs/reference-api.md from the EMITTED d.ts files in dist/.
// Run `--check` in CI to fail when the doc has drifted from the type.
//
// Why this exists, and why it is deliberately this small:
//
// BLO-32870's docs-plan ratified one property -- "the API reference cannot
// silently diverge from the type" -- and the CTO ruling on 2026-09-13 added one
// constraint: no new doc toolchain. This package declares "zero runtime
// dependencies by design" (BLO-32860 contract freeze section 3.3) and carries
// exactly one devDependency (typescript). Pulling typedoc or
// api-extractor + api-documenter into a deliberately-minimal leaf, to emit one
// markdown file, is the wrong trade -- so the reference IS the emitted d.ts,
// embedded verbatim, and the anti-drift gate is regenerate-and-compare.
//
// Three properties do the actual work:
//
//   1. The output is byte-deterministic. No timestamp, no build id, no
//      generated-on date. A generate-and-diff gate whose output embeds the
//      clock fails on every unrelated PR, gets marked non-blocking within a
//      week, and then guards nothing.
//   2. The file list is a GLOB over dist/*.d.ts, never a hand-maintained
//      array. A new public module added to src/ shows up in the reference by
//      itself; a hand-listed set would silently omit it, which is the same
//      divergence this gate exists to catch, arriving through the gate.
//   3. The entry-point table is read from package.json "exports". The export
//      map is frozen, but the cost of deriving it is two lines and the cost of
//      hand-copying it is a table that is wrong at some later date.
//
// --check does the comparison in-process rather than shelling out to
// `git diff --exit-code`, so it also works on an unstaged tree, in a tarball,
// and in the beacon repo before any history exists.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(PKG_ROOT, 'dist');
const OUT = join(PKG_ROOT, 'docs', 'reference-api.md');

const BANNER = `<!-- GENERATED FILE -- DO NOT EDIT.
     Source of truth: the emitted dist/*.d.ts in @blockcast/multicast-contract.
     Regenerate: npm run docs:reference
     CI gate: node scripts/gen-reference-api.mjs --check -->`;

/** dist/index.d.ts first (it is the front door), then the rest alphabetically. */
function declarationFiles() {
  if (!existsSync(DIST)) return [];
  const all = readdirSync(DIST).filter((f) => f.endsWith('.d.ts')).sort();
  const index = all.filter((f) => f === 'index.d.ts');
  return [...index, ...all.filter((f) => f !== 'index.d.ts')];
}

/** Rows of [subpath, types file] from package.json "exports". */
function entryPoints(pkg) {
  return Object.entries(pkg.exports ?? {})
    .map(([subpath, conditions]) => [subpath, conditions?.types])
    .filter(([, types]) => typeof types === 'string');
}

function render() {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  const files = declarationFiles();
  if (files.length === 0) {
    throw new Error(`no dist/*.d.ts found in ${DIST} -- run \`npm run build\` first`);
  }

  const out = [];
  out.push(BANNER, '');
  out.push(`# \`${pkg.name}\` v${pkg.version} -- API reference`, '');
  out.push(
    'This reference is the package\'s **emitted type declarations, verbatim**.',
    'It is generated from `dist/`, so it cannot describe an API the package does',
    'not actually ship. Prose, rationale, and worked examples live in the',
    'package README; this file is the exhaustive surface.',
    '',
  );

  out.push('## Entry points', '');
  out.push('| Import specifier | Declarations |', '| --- | --- |');
  for (const [subpath, types] of entryPoints(pkg)) {
    const specifier = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, '')}`;
    out.push(`| \`${specifier}\` | \`${types.replace(/^\.\//, '')}\` |`);
  }
  out.push('');

  for (const file of files) {
    out.push(`## \`dist/${file}\``, '');
    out.push('```ts');
    out.push(readFileSync(join(DIST, file), 'utf8').trimEnd());
    out.push('```', '');
  }

  return `${out.join('\n').trimEnd()}\n`;
}

function main(argv) {
  const check = argv.includes('--check');
  const generated = render();

  if (!check) {
    writeFileSync(OUT, generated);
    console.log(`wrote ${OUT} (${generated.length} bytes)`);
    return 0;
  }

  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  if (current === generated) {
    console.log('reference-api.md is up to date with dist/*.d.ts');
    return 0;
  }

  console.error(
    current === null
      ? `MISSING: ${OUT} does not exist.`
      : `DRIFT: ${OUT} does not match the emitted dist/*.d.ts.`,
  );
  console.error('The public type surface changed without the reference being regenerated.');
  console.error('Fix: npm run docs:reference  (then commit the result)');
  return 1;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));

export { render, declarationFiles, entryPoints, main };
