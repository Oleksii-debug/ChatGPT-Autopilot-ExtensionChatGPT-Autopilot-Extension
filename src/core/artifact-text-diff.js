import {
  compareArtifactVersionsV1,
  getArtifactVersionV1,
  normalizeArtifactRegistryV1,
} from './artifact-registry.js';
import { createSha256FingerprintV1 } from './fingerprint.js';

export const ARTIFACT_TEXT_DIFF_VERSION = 1;
export const MAX_ARTIFACT_TEXT_DIFF_BYTES = 128 * 1024;
export const MAX_ARTIFACT_TEXT_DIFF_LINES = 1024;
export const MAX_ARTIFACT_TEXT_DIFF_LINE_CODE_UNITS = 16 * 1024;
export const MAX_ARTIFACT_TEXT_DIFF_PLAIN_TEXT_CHARS = 512 * 1024;

export const ArtifactTextDiffOperation = Object.freeze({
  EQUAL: 'EQUAL',
  REMOVE: 'REMOVE',
  ADD: 'ADD',
});

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'registry',
  'artifactId',
  'fromVersionId',
  'toVersionId',
  'fromText',
  'toText',
]);

const TEXT_APPLICATION_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/yaml',
  'application/x-yaml',
  'application/markdown',
  'application/sql',
  'application/graphql',
]);

function strictRecord(value, label, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} field ${String(key)} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) {
      throw new Error(`${label} is missing field: ${key}`);
    }
  }
  return out;
}

function exactVersion(value) {
  if (value !== ARTIFACT_TEXT_DIFF_VERSION) {
    throw new Error('Unsupported ArtifactTextDiffV1 schemaVersion');
  }
  return value;
}

function isTextMediaType(value) {
  if (typeof value !== 'string') return false;
  const canonical = value.split(';', 1)[0].trim().toLowerCase();
  return canonical.startsWith('text/') || TEXT_APPLICATION_TYPES.has(canonical);
}

function assertDiffableVersion(version, label) {
  if (version.artifactRef.sensitive === true) {
    throw new Error(`${label} sensitive artifact material is not admitted for text diff`);
  }
  if (!isTextMediaType(version.artifactRef.mediaType)) {
    throw new Error(`${label} artifact mediaType is not admitted for text diff`);
  }
}

function assertWellFormedUtf16(text, label) {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      if (index + 1 >= text.length) {
        throw new Error(`${label} must be well-formed UTF-16 before UTF-8 encoding`);
      }
      const nextCodeUnit = text.charCodeAt(index + 1);
      if (nextCodeUnit < 0xDC00 || nextCodeUnit > 0xDFFF) {
        throw new Error(`${label} must be well-formed UTF-16 before UTF-8 encoding`);
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      throw new Error(`${label} must be well-formed UTF-16 before UTF-8 encoding`);
    }
  }
}

async function verifyTextMaterial(text, version, label, { cryptoApi = globalThis.crypto } = {}) {
  if (typeof text !== 'string') throw new Error(`${label} must be UTF-8 text`);
  assertWellFormedUtf16(text, label);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_ARTIFACT_TEXT_DIFF_BYTES) {
    throw new Error(`${label} exceeds ${MAX_ARTIFACT_TEXT_DIFF_BYTES} UTF-8 bytes`);
  }
  if (bytes.byteLength !== version.artifactRef.sizeBytes) {
    throw new Error(`${label} byte length does not match immutable ArtifactRef`);
  }
  const digest = await createSha256FingerprintV1(text, { cryptoApi });
  const sha256 = digest.slice('sha256:'.length);
  if (sha256 !== version.artifactRef.sha256) {
    throw new Error(`${label} SHA-256 does not match immutable ArtifactRef`);
  }
  return Object.freeze({
    text,
    byteLength: bytes.byteLength,
    sha256,
  });
}

function splitExactLines(text, label) {
  const lines = text === '' ? [] : text.split('\n');
  if (lines.length > MAX_ARTIFACT_TEXT_DIFF_LINES) {
    throw new Error(`${label} exceeds ${MAX_ARTIFACT_TEXT_DIFF_LINES} lines`);
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].length > MAX_ARTIFACT_TEXT_DIFF_LINE_CODE_UNITS) {
      throw new Error(`${label} line ${index + 1} exceeds the diff line bound`);
    }
  }
  return lines;
}

function lcsMatrix(left, right) {
  const columns = right.length + 1;
  const rows = left.length + 1;
  const matrix = new Uint16Array(rows * columns);
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      const at = leftIndex * columns + rightIndex;
      if (left[leftIndex] === right[rightIndex]) {
        matrix[at] = matrix[(leftIndex + 1) * columns + rightIndex + 1] + 1;
      } else {
        const removeScore = matrix[(leftIndex + 1) * columns + rightIndex];
        const addScore = matrix[leftIndex * columns + rightIndex + 1];
        matrix[at] = removeScore >= addScore ? removeScore : addScore;
      }
    }
  }
  return { matrix, columns };
}

function buildOperations(left, right) {
  const { matrix, columns } = lcsMatrix(left, right);
  const operations = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    if (leftIndex < left.length
        && rightIndex < right.length
        && left[leftIndex] === right[rightIndex]) {
      operations.push({
        type: ArtifactTextDiffOperation.EQUAL,
        leftLine: leftIndex + 1,
        rightLine: rightIndex + 1,
        text: left[leftIndex],
      });
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    const removeScore = leftIndex < left.length
      ? matrix[(leftIndex + 1) * columns + rightIndex]
      : -1;
    const addScore = rightIndex < right.length
      ? matrix[leftIndex * columns + rightIndex + 1]
      : -1;

    if (leftIndex < left.length && (rightIndex >= right.length || removeScore >= addScore)) {
      operations.push({
        type: ArtifactTextDiffOperation.REMOVE,
        leftLine: leftIndex + 1,
        rightLine: null,
        text: left[leftIndex],
      });
      leftIndex += 1;
    } else {
      operations.push({
        type: ArtifactTextDiffOperation.ADD,
        leftLine: null,
        rightLine: rightIndex + 1,
        text: right[rightIndex],
      });
      rightIndex += 1;
    }
  }
  return operations;
}

function summarizeOperations(operations) {
  let addedLines = 0;
  let removedLines = 0;
  let unchangedLines = 0;
  let changeBlocks = 0;
  let inChange = false;

  for (const operation of operations) {
    if (operation.type === ArtifactTextDiffOperation.EQUAL) {
      unchangedLines += 1;
      inChange = false;
    } else {
      if (!inChange) changeBlocks += 1;
      inChange = true;
      if (operation.type === ArtifactTextDiffOperation.ADD) addedLines += 1;
      else removedLines += 1;
    }
  }

  return Object.freeze({
    addedLines,
    removedLines,
    unchangedLines,
    changeBlocks,
    changed: addedLines > 0 || removedLines > 0,
  });
}

function buildPlainText({
  projectId,
  artifactId,
  fromVersionId,
  toVersionId,
  fromSha256,
  toSha256,
  stats,
  operations,
}) {
  const lines = [
    'Artifact material diff',
    `Project: ${projectId}`,
    `Artifact: ${artifactId}`,
    `From version: ${fromVersionId} sha256:${fromSha256}`,
    `To version: ${toVersionId} sha256:${toSha256}`,
    `Changes: +${stats.addedLines} -${stats.removedLines}; unchanged ${stats.unchangedLines}; blocks ${stats.changeBlocks}`,
  ];

  if (!stats.changed) {
    lines.push('No material line changes.');
  } else {
    lines.push('Changed lines:');
    for (const operation of operations) {
      if (operation.type === ArtifactTextDiffOperation.EQUAL) continue;
      const prefix = operation.type === ArtifactTextDiffOperation.REMOVE ? '-' : '+';
      const location = operation.type === ArtifactTextDiffOperation.REMOVE
        ? `L${operation.leftLine}`
        : `R${operation.rightLine}`;
      lines.push(`${prefix} ${location}: ${JSON.stringify(operation.text)}`);
    }
  }

  const output = lines.join('\n');
  if (output.length > MAX_ARTIFACT_TEXT_DIFF_PLAIN_TEXT_CHARS) {
    throw new Error('Artifact text diff plain-text review surface exceeds bound');
  }
  return output;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Builds a complete bounded line diff from actual material bytes that are
 * independently rebound to immutable ArtifactRegistry version refs.
 *
 * The result is an advisory/read-only review projection. It grants no artifact
 * mutation, approval, distribution, verification, policy, or execution authority.
 */
export async function buildArtifactTextDiffV1(raw, options = {}) {
  const input = strictRecord(raw, 'ArtifactTextDiffV1 request', REQUEST_KEYS);
  exactVersion(input.schemaVersion);

  const registry = normalizeArtifactRegistryV1(input.registry);
  const fromVersion = getArtifactVersionV1(
    registry,
    input.artifactId,
    input.fromVersionId,
  );
  const toVersion = getArtifactVersionV1(
    registry,
    input.artifactId,
    input.toVersionId,
  );
  const metadataDiff = compareArtifactVersionsV1(fromVersion, toVersion);

  assertDiffableVersion(fromVersion, 'From');
  assertDiffableVersion(toVersion, 'To');

  const [fromMaterial, toMaterial] = await Promise.all([
    verifyTextMaterial(input.fromText, fromVersion, 'fromText', options),
    verifyTextMaterial(input.toText, toVersion, 'toText', options),
  ]);

  const fromLines = splitExactLines(fromMaterial.text, 'fromText');
  const toLines = splitExactLines(toMaterial.text, 'toText');
  const operations = buildOperations(fromLines, toLines);
  const stats = summarizeOperations(operations);
  const plainText = buildPlainText({
    projectId: registry.projectId,
    artifactId: metadataDiff.artifactId,
    fromVersionId: metadataDiff.fromVersionId,
    toVersionId: metadataDiff.toVersionId,
    fromSha256: fromMaterial.sha256,
    toSha256: toMaterial.sha256,
    stats,
    operations,
  });

  return deepFreeze({
    schemaVersion: ARTIFACT_TEXT_DIFF_VERSION,
    projectId: registry.projectId,
    artifactId: metadataDiff.artifactId,
    fromVersionId: metadataDiff.fromVersionId,
    toVersionId: metadataDiff.toVersionId,
    fromSha256: fromMaterial.sha256,
    toSha256: toMaterial.sha256,
    fromSizeBytes: fromMaterial.byteLength,
    toSizeBytes: toMaterial.byteLength,
    fromMediaType: fromVersion.artifactRef.mediaType,
    toMediaType: toVersion.artifactRef.mediaType,
    metadataDiff,
    stats,
    operations,
    plainText,
    materialIdentitiesVerified: true,
    readOnly: true,
    advisoryOnly: true,
    approvalAuthorized: false,
    distributionAuthorized: false,
    executionAuthorized: false,
  });
}
