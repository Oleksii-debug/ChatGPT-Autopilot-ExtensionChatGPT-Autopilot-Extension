import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

test('Native Companion upgrade publishes only by final registry pointer flip', async () => {
  const installer = await fs.readFile(
    path.join(repoRoot, 'companion', 'native-host', 'ВСТАНОВИТИ NATIVE COMPANION.ps1'),
    'utf8',
  );

  assert.ok(installer.includes("$versionsRoot = Join-Path $installRoot 'versions'"));
  assert.ok(installer.includes("$installationId = [guid]::NewGuid().ToString('N')"));
  assert.ok(installer.includes('$target = Join-Path $versionsRoot $installationId'));

  const pointerFlip = 'Set-Item -Path $regKey -Value $manifestPath';
  const pointerIndex = installer.indexOf(pointerFlip);
  assert.ok(pointerIndex >= 0, 'installer must have one explicit Native Messaging pointer flip');
  assert.equal(
    installer.indexOf(pointerFlip, pointerIndex + pointerFlip.length),
    -1,
    'installer must not have multiple activation pointer writes',
  );

  const beforeFlip = installer.slice(0, pointerIndex);
  const afterFlip = installer.slice(pointerIndex + pointerFlip.length);

  assert.ok(
    beforeFlip.includes("Copy-Item -LiteralPath $src -Destination (Join-Path $target $name) -Force"),
    'payload must be copied only into the new versioned target before activation',
  );
  assert.ok(
    beforeFlip.includes("Copy-Item -LiteralPath $nodeExe -Destination $installedNode -Force"),
    'Node runtime must be staged before activation',
  );
  assert.ok(
    beforeFlip.includes("Set-Content -LiteralPath $manifestPath -Encoding UTF8"),
    'new manifest must exist before activation',
  );
  assert.ok(
    beforeFlip.includes("Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json"),
    'new manifest must be re-read before activation',
  );

  assert.equal(
    /Copy-Item[^\n]*-Destination[^\n]*(?:\$registeredBase|\$currentManifestPath)/u.test(beforeFlip),
    false,
    'pre-flip publication must not overwrite the previously registered installation',
  );
  assert.equal(
    /Remove-Item[^\n]*(?:\$registeredBase|\$currentManifestPath)/u.test(beforeFlip),
    false,
    'pre-flip failure handling must not delete the previously registered installation',
  );
  assert.equal(
    beforeFlip.includes('Set-Item -Path $registryPath'),
    false,
    'pre-flip work must not mutate the current registration value',
  );

  // Failure-injection proof over every pre-flip publication write:
  // each write must target the new versioned tree, so aborting after any one
  // leaves the modeled prior pointer and prior bytes unchanged.
  const publicationWrites = beforeFlip
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => /^(?:Copy-Item|Set-Content|Move-Item|Add-Type)\b/u.test(line));

  assert.ok(publicationWrites.length >= 6, 'regression must cover a non-trivial staged publication');
  for (let faultAfter = 0; faultAfter < publicationWrites.length; faultAfter += 1) {
    const executed = publicationWrites.slice(0, faultAfter + 1);
    const mutatesPrior = executed.some(line =>
      /\$registeredBase|\$currentManifestPath/u.test(line)
      || /Set-Item\s+-Path\s+\$reg(?:istryPath|Key)/u.test(line)
    );
    assert.equal(
      mutatesPrior,
      false,
      `injected failure after staged write ${faultAfter + 1} must leave prior installation untouched`,
    );
  }

  assert.match(
    afterFlip,
    /\$published\s*=\s*\$true/u,
    'successful pointer flip must be the publication commit point',
  );
  assert.match(
    installer,
    /if \(-not \$published -and \(Test-Path -LiteralPath \$target\)\)[\s\S]*Remove-Item -LiteralPath \$target/u,
    'failed pre-flip publication must clean only the unpublished versioned target',
  );
});
