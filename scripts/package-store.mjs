import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_VERSION, collectProductFiles, createDeterministicZip } from './package-release.mjs';

export const STORE_NAME = `ChatGPT-Autopilot-${RELEASE_VERSION}-CWS`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildStorePackage({ root = ROOT, outDir = path.join(root, 'dist') } = {}) {
  const { manifest, files } = await collectProductFiles(root);
  if (manifest.manifest_version !== 3) throw new Error('Chrome Web Store package requires Manifest V3');
  if (!manifest.icons?.['128']) throw new Error('Chrome Web Store package requires a 128x128 manifest icon');
  if (!manifest.action?.default_icon?.['16']) throw new Error('Chrome Web Store package requires a toolbar action icon');
  if (String(manifest.description || '').length > 132) throw new Error('Manifest description exceeds Chrome Web Store 132-character limit');

  // Store ZIP intentionally excludes QA/readme/change notes and places manifest.json at ZIP root.
  const storeFiles = files.filter(file => file === 'manifest.json' || file.startsWith('src/') || file.startsWith('icons/'));
  const zip = await createDeterministicZip(root, storeFiles, { prefix: '' });
  await fs.mkdir(outDir, { recursive: true });
  const zipPath = path.join(outDir, `${STORE_NAME}.zip`);
  await fs.writeFile(zipPath, zip);
  return { files: storeFiles, zipPath, sha256: createHash('sha256').update(zip).digest('hex') };
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const result = await buildStorePackage();
  console.log(`Built ${STORE_NAME}`);
  console.log(`Files: ${result.files.length}`);
  console.log(`ZIP: ${path.relative(ROOT, result.zipPath)}`);
  console.log(`SHA256: ${result.sha256}`);
}
