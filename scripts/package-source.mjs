import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_VERSION } from './package-release.mjs';

export const SOURCE_VERSION = RELEASE_VERSION;
export const SOURCE_NAME = `ChatGPT-Autopilot-${SOURCE_VERSION}-SOURCE`;
const FIXED_DOS_DATE = 0x0021;
const FIXED_DOS_TIME = 0x0000;
const UTF8_FLAG = 0x0800;
const ZIP_STORE = 0;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED_TOP_LEVEL = new Set(['.git', 'node_modules', 'dist']);

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

async function walkSourceFiles(root, relativeDirectory = '') {
  const absoluteDirectory = path.join(root, relativeDirectory);
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!relativeDirectory && EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source package must not contain symlinks: ${toPosix(relativePath)}`);
    if (entry.isDirectory()) files.push(...await walkSourceFiles(root, relativePath));
    else if (entry.isFile()) files.push(toPosix(relativePath));
    else throw new Error(`Unsupported source entry: ${toPosix(relativePath)}`);
  }
  return files;
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

export async function collectSourceFiles(root = REPOSITORY_ROOT) {
  return (await walkSourceFiles(root)).sort();
}

export async function createDeterministicSourceZip(root, files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const relativePath of [...files].sort()) {
    const data = await fs.readFile(path.join(root, relativePath));
    const zipPath = `${SOURCE_NAME}/${toPosix(relativePath)}`;
    const local = localHeader(zipPath, data);
    localParts.push(local);
    centralParts.push(centralHeader(zipPath, data, offset));
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory(files.length, centralDirectory.length, offset)]);
}

export async function buildSourcePackage({ root = REPOSITORY_ROOT, outDir = path.join(root, 'dist') } = {}) {
  const files = await collectSourceFiles(root);
  await fs.mkdir(outDir, { recursive: true });
  const zip = await createDeterministicSourceZip(root, files);
  const zipPath = path.join(outDir, `${SOURCE_NAME}.zip`);
  await fs.writeFile(zipPath, zip);
  return { files, zipPath, sha256: createHash('sha256').update(zip).digest('hex') };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await buildSourcePackage();
  console.log(`Built ${SOURCE_NAME}`);
  console.log(`Files: ${result.files.length}`);
  console.log(`ZIP: ${path.relative(REPOSITORY_ROOT, result.zipPath)}`);
  console.log(`SHA256: ${result.sha256}`);
}
