import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_NAME = 'ChatGPT-Autopilot-Extension-v0.1';
const FIXED_DOS_DATE = 0x0021; // 1980-01-01
const FIXED_DOS_TIME = 0x0000;
const UTF8_FLAG = 0x0800;
const ZIP_STORE = 0;
const NORMALIZED_TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.txt']);

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(Cookies?|Login Data|Local State|Web Data)(\/|$)/i,
  /\.(?:sqlite|sqlite3|db|pem|key)$/i,
];
const FORBIDDEN_TEXT_PATTERNS = [
  { name: 'private ChatGPT conversation URL', pattern: /https:\/\/chatgpt\.com\/(?:c|share)\/[A-Za-z0-9_-]{8,}/i },
  { name: 'OpenAI-style secret', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub-style token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i },
  { name: 'Google API-style key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
];

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

async function readPackagedBytes(root, relativePath) {
  const data = await fs.readFile(path.join(root, relativePath));
  if (!NORMALIZED_TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) return data;
  return Buffer.from(data.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
}

async function walkFiles(root, relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release source must not contain symlinks: ${toPosix(relativePath)}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, relativePath));
    else if (entry.isFile()) files.push(toPosix(relativePath));
    else throw new Error(`Unsupported release source entry: ${toPosix(relativePath)}`);
  }

  return files;
}

function manifestResourcePaths(manifest) {
  const paths = new Set();
  const add = value => {
    if (typeof value === 'string' && value && !value.includes('*')) paths.add(value);
  };

  add(manifest.background?.service_worker);
  add(manifest.options_ui?.page);
  add(manifest.action?.default_popup);
  for (const value of Object.values(manifest.icons || {})) add(value);
  for (const value of Object.values(manifest.action?.default_icon || {})) add(value);
  for (const script of manifest.content_scripts || []) {
    for (const value of script.js || []) add(value);
    for (const value of script.css || []) add(value);
  }
  for (const block of manifest.web_accessible_resources || []) {
    for (const value of block.resources || []) add(value);
  }
  return [...paths].sort();
}

export async function collectProductFiles(root = REPOSITORY_ROOT) {
  const manifestPath = path.join(root, 'manifest.json');
  const readmePath = path.join(root, 'README.txt');
  const srcPath = path.join(root, 'src');
  const [manifestText, readmeStat, srcStat] = await Promise.all([
    fs.readFile(manifestPath, 'utf8'),
    fs.stat(readmePath),
    fs.stat(srcPath),
  ]);
  if (!readmeStat.isFile()) throw new Error('README.txt must be a file');
  if (!srcStat.isDirectory()) throw new Error('src must be a directory');

  const manifest = JSON.parse(manifestText);
  if (manifest.manifest_version !== 3) throw new Error('manifest.json must use Manifest V3');
  if (manifest.version !== '0.1.0') throw new Error(`v0.1 package requires manifest version 0.1.0, found ${manifest.version || 'missing'}`);

  const files = ['README.txt', 'manifest.json', ...await walkFiles(root, 'src')].sort();
  const fileSet = new Set(files);
  for (const resource of manifestResourcePaths(manifest)) {
    if (!fileSet.has(resource)) {
      throw new Error(`Manifest resource is outside the release allowlist or missing: ${resource}`);
    }
  }

  for (const relativePath of files) {
    if (FORBIDDEN_PATH_PATTERNS.some(pattern => pattern.test(relativePath))) {
      throw new Error(`Forbidden private/sensitive path in release package: ${relativePath}`);
    }
    const absolutePath = path.join(root, relativePath);
    const data = await fs.readFile(absolutePath);
    if (data.includes(0)) continue;
    const text = data.toString('utf8');
    for (const { name, pattern } of FORBIDDEN_TEXT_PATTERNS) {
      if (pattern.test(text)) throw new Error(`Potential ${name} found in packaged source: ${relativePath}`);
    }
  }

  return { manifest, files };
}

let crcTable;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    return c >>> 0;
  });
  return crcTable;
}

function crc32(buffer) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name, data) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(ZIP_STORE, 8);
  header.writeUInt16LE(FIXED_DOS_TIME, 10);
  header.writeUInt16LE(FIXED_DOS_DATE, 12);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuffer, data]);
}

function centralHeader(name, data, offset) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(ZIP_STORE, 10);
  header.writeUInt16LE(FIXED_DOS_TIME, 12);
  header.writeUInt16LE(FIXED_DOS_DATE, 14);
  header.writeUInt32LE(crc32(data), 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBuffer]);
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

export async function createDeterministicZip(root, files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const relativePath of [...files].sort()) {
    const data = await readPackagedBytes(root, relativePath);
    const zipPath = `${RELEASE_NAME}/${toPosix(relativePath)}`;
    const local = localHeader(zipPath, data);
    localParts.push(local);
    centralParts.push(centralHeader(zipPath, data, offset));
    offset += local.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    centralDirectory,
    endOfCentralDirectory(files.length, centralDirectory.length, offset),
  ]);
}

export async function buildReleasePackage({
  root = REPOSITORY_ROOT,
  outDir = path.join(root, 'dist'),
} = {}) {
  const { files } = await collectProductFiles(root);
  const unpackedDir = path.join(outDir, RELEASE_NAME);
  const zipPath = path.join(outDir, `${RELEASE_NAME}.zip`);

  await fs.rm(unpackedDir, { recursive: true, force: true });
  await fs.rm(zipPath, { force: true });
  await fs.mkdir(unpackedDir, { recursive: true });

  for (const relativePath of files) {
    const destination = path.join(unpackedDir, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, await readPackagedBytes(root, relativePath));
  }

  const zip = await createDeterministicZip(root, files);
  await fs.writeFile(zipPath, zip);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  return { files, unpackedDir, zipPath, sha256 };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await buildReleasePackage();
  console.log(`Built ${RELEASE_NAME}`);
  console.log(`Files: ${result.files.length}`);
  console.log(`ZIP: ${path.relative(REPOSITORY_ROOT, result.zipPath)}`);
  console.log(`SHA256: ${result.sha256}`);
  console.log('Candidate package only: V01_READY remains governed by integrated production and human acceptance gates.');
}
