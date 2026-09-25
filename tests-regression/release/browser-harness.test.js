import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('release development tree keeps practical Chromium qualification harnesses wired', () => {
  assert.equal(packageJson.scripts['test:native-browser'], 'node scripts/native-browser-smoke.cjs');
  assert.equal(packageJson.scripts['test:chrome-ui'], 'node scripts/chrome-ui-accessibility-smoke.mjs');
  assert.equal(packageJson.scripts['test:browser'], 'npm run test:native-browser && npm run test:chrome-ui');
  assert.equal(packageJson.scripts['test:qualification'], 'npm test && npm run test:browser');
  for (const path of [
    'scripts/browser-smoke-lib.cjs',
    'scripts/native-browser-smoke.cjs',
    'scripts/chrome-ui-accessibility-smoke.mjs',
  ]) assert.equal(fs.existsSync(new URL(`../../${path}`, import.meta.url)), true, `${path} missing`);
});
