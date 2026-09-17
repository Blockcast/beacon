#!/usr/bin/env node
// Checks on the reference generator itself. The gate it implements is only
// worth having if it actually fires, so the load-bearing assertion here is the
// drift one: corrupt the committed doc, confirm --check returns non-zero.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, declarationFiles, main } from './gen-reference-api.mjs';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(PKG_ROOT, 'docs', 'reference-api.md');

test('output is byte-deterministic across runs', () => {
  // A generate-and-diff gate that embeds a clock fails on every unrelated PR
  // and gets switched off within a week. This is the assertion that stops that.
  assert.equal(render(), render());
});

test('every emitted d.ts appears in the reference', () => {
  const doc = render();
  const files = declarationFiles();
  assert.ok(files.length > 0, 'expected dist/*.d.ts -- run `npm run build` first');
  for (const file of files) {
    assert.ok(doc.includes(`## \`dist/${file}\``), `reference omits dist/${file}`);
  }
});

test('--check passes when committed, and FAILS on drift', () => {
  assert.ok(existsSync(OUT), `${OUT} missing -- run \`npm run docs:reference\``);
  const committed = readFileSync(OUT, 'utf8');
  try {
    assert.equal(main(['--check']), 0, 'committed doc is stale');
    writeFileSync(OUT, `${committed}\ndrifted\n`);
    assert.equal(main(['--check']), 1, 'gate did not fire on a drifted doc');
  } finally {
    writeFileSync(OUT, committed);
  }
});
