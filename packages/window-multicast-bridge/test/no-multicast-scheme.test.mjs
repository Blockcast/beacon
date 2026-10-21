// The IWA bridge registers a `multicast:` protocol handler, and navigating to
// such a URL launches or focuses that app outside the lifecycle its launcher
// controls. The page bridge must never emit one: a gateway starts only through
// its launcher's consumer-intent path. This scans src/ as text, which test:dist
// keeps doing, since it redirects module resolution only.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const SOURCE_FILE = /\.(?:[cm]?[jt]s|html)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]s$/;
// A string that starts a multicast: (or web+multicast:) URL, or a handler registration.
const MULTICAST_SCHEME_USE = /["'`](?:web\+)?multicast:|registerProtocolHandler\s*\(/;

test('the window.multicast bridge never opens or navigates to a multicast: URL', () => {
  const files = readdirSync(SRC_DIR, { recursive: true })
    .filter((entry) => SOURCE_FILE.test(entry) && !TEST_FILE.test(entry));
  assert.ok(files.length > 0, `no source files found under ${SRC_DIR}`);
  const offenders = files.flatMap((file) =>
    readFileSync(join(SRC_DIR, file), 'utf8')
      .split('\n')
      .flatMap((line, index) => (MULTICAST_SCHEME_USE.test(line) ? [`src/${file}:${index + 1}`] : [])),
  );
  assert.deepEqual(offenders, []);
});

test('the multicast: scan would flag a multicast: navigation', () => {
  assert.equal(MULTICAST_SCHEME_USE.test("location.href = 'multicast://232.1.1.1:5000';"), true);
  assert.equal(MULTICAST_SCHEME_USE.test('window.open(`web+multicast:${params}`);'), true);
  assert.equal(MULTICAST_SCHEME_USE.test("navigator.registerProtocolHandler('web+multicast', url);"), true);
  assert.equal(MULTICAST_SCHEME_USE.test("{ source: 'multicast-webpage' }"), false);
});
