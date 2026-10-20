// Runs the suite against the minified build: `node --import ./test/use-dist.mjs --test ...`.
// Only module resolution is redirected, so tests that read src/ as text keep reading src/.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return { ...resolved, url: resolved.url.replace(/\/src\/(multicast-bridge|bridge-bootstrap)\.js$/, '/dist/$1.js') };
  },
});
