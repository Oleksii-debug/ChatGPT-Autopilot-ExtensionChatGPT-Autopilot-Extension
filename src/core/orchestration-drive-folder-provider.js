export const DRIVE_FOLDER_DISPATCH_PROVIDER_V1 = 'drive-folder-dispatch-v1';
export const DRIVE_FOLDER_DISPATCH_SCHEMA_VERSION = 1;
export const DRIVE_FOLDER_DEFAULT_POLL_INTERVAL_MS = 3 * 60 * 1000;
export const DRIVE_FOLDER_MIN_POLL_INTERVAL_MS = 60 * 1000;
export const DRIVE_FOLDER_MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

const MAX_GENERATIONS = 1000;
const MAX_ENTRIES = 1000;
const MAX_PROMPT_CHARS = 200000;
const GENERATION_PATTERN = /^generation-(\d{6,})$/u;

export class DriveFolderDispatchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DriveFolderDispatchError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requireId(value, label) {
  const normalized = clean(String(value ?? ''));
  if (!normalized || normalized.length > 180 || !/^[A-Za-z0-9._:@/+-]+$/u.test(normalized)) {
    throw new DriveFolderDispatchError('INVALID_ENVELOPE', `Invalid ${label}`);
  }
  return normalized;
}

function requireInteger(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || !Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new DriveFolderDispatchError('INVALID_ENVELOPE', `Invalid ${label}`);
  }
  return parsed;
}

function normalizeRevision(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/u.test(raw) || raw.length > 128) {
    throw new DriveFolderDispatchError('INVALID_GENERATION', 'Dispatch generation must be a bounded decimal integer.');
  }
  return raw.replace(/^0+(?=\d)/u, '') || '0';
}

function compareRevision(left, right) {
  const a = normalizeRevision(left);
  const b = normalizeRevision(right);
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function parseGenerationName(name) {
  const match = clean(name).match(GENERATION_PATTERN);
  if (!match) return null;
  return normalizeRevision(match[1]);
}

function normalizeGeneration(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DriveFolderDispatchError('INVALID_GENERATION', `Invalid generation[${index}]`);
  }
  const folderId = requireId(raw.folderId ?? raw.id, `generation[${index}].folderId`);
  const name = clean(raw.name);
  const revision = parseGenerationName(name);
  if (revision === null) return null;
  return { folderId, name, revision };
}

function normalizeEntry(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DriveFolderDispatchError('INVALID_ENTRY', `Invalid entry[${index}]`);
  }
  const id = requireId(raw.id, `entry[${index}].id`);
  const name = clean(raw.name);
  if (!name || name.length > 250) {
    throw new DriveFolderDispatchError('INVALID_ENTRY', `Invalid entry[${index}].name`);
  }
  const version = normalizeRevision(raw.version ?? 0);
  return {
    id,
    name,
    version,
    mimeType: clean(raw.mimeType),
    size: raw.size == null ? '' : String(raw.size),
  };
}

function entriesSignature(entries) {
  return entries
    .map(entry => [entry.id, entry.name, entry.version, entry.mimeType, entry.size].join('\u0000'))
    .sort((a, b) => a.localeCompare(b))
    .join('\u0001');
}

async function sha256Text(value) {
  if (!globalThis.crypto?.subtle) {
    throw new DriveFolderDispatchError('HASH_UNAVAILABLE', 'Web Crypto is unavailable for dispatch snapshot identity.');
  }
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function extractGoogleDriveFolderSourceId(value) {
  const raw = clean(String(value ?? ''));
  if (/^[A-Za-z0-9_-]{6,256}$/u.test(raw)) return raw;
  let url;
  try { url = new URL(raw); } catch {
    throw new DriveFolderDispatchError('INVALID_SOURCE', 'Invalid Google Drive folder reference.');
  }
  if (url.hostname.toLowerCase() !== 'drive.google.com') {
    throw new DriveFolderDispatchError('INVALID_SOURCE', 'Invalid Google Drive folder reference.');
  }
  let id = url.pathname.match(/^\/drive\/folders\/([^/]+)/u)?.[1] || '';
  try { id = decodeURIComponent(id); } catch { id = ''; }
  if (!/^[A-Za-z0-9_-]{6,256}$/u.test(id)) {
    throw new DriveFolderDispatchError('INVALID_SOURCE', 'Invalid Google Drive folder reference.');
  }
  return id;
}

function parseDispatchEnvelope(rawText, {
  groupNodeId,
  generationRevision,
  allowedChildIds,
  localPromptProfilesByChild,
  fileId,
} = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new DriveFolderDispatchError('INVALID_DISPATCH_FILE', `Empty dispatch file ${fileId || ''}`);
  }
  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new DriveFolderDispatchError('INVALID_DISPATCH_FILE', `Invalid JSON in dispatch file ${fileId || ''}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DriveFolderDispatchError('INVALID_DISPATCH_FILE', 'Dispatch envelope must be an object.');
  }
  if (Number(raw.schema_version) !== DRIVE_FOLDER_DISPATCH_SCHEMA_VERSION) {
    throw new DriveFolderDispatchError('INVALID_DISPATCH_FILE', 'Unsupported dispatch schema_version.');
  }

  const parentNodeId = requireId(raw.parent_node_id, 'parent_node_id');
  if (parentNodeId !== groupNodeId) {
    throw new DriveFolderDispatchError('WRONG_PARENT', `Dispatch parent ${parentNodeId} does not match ${groupNodeId}.`);
  }
  const generation = normalizeRevision(raw.generation);
  if (generation !== generationRevision) {
    throw new DriveFolderDispatchError('WRONG_GENERATION', `Dispatch generation ${generation} does not match folder generation ${generationRevision}.`);
  }
  const targetChildId = requireId(raw.target_child_id, 'target_child_id');
  if (!allowedChildIds.has(targetChildId)) {
    throw new DriveFolderDispatchError('UNKNOWN_TARGET', `Dispatch target ${targetChildId} is not an immediate child of ${groupNodeId}.`);
  }

  const hasPrompt = typeof raw.prompt === 'string' && raw.prompt.trim().length > 0;
  const hasProfile = raw.prompt_profile_id !== undefined && raw.prompt_profile_id !== null && String(raw.prompt_profile_id).trim() !== '';
  if (hasPrompt === hasProfile) {
    throw new DriveFolderDispatchError('INVALID_DISPATCH_FILE', 'Dispatch must provide exactly one of prompt or prompt_profile_id.');
  }

  let promptPayload = '';
  let promptProfileId = '';
  if (hasPrompt) {
    promptPayload = raw.prompt.trim();
    if (promptPayload.length > MAX_PROMPT_CHARS) {
      throw new DriveFolderDispatchError('PROMPT_TOO_LARGE', `Dispatch prompt exceeds ${MAX_PROMPT_CHARS} characters.`);
    }
  } else {
    promptProfileId = requireId(raw.prompt_profile_id, 'prompt_profile_id');
    const allowed = localPromptProfilesByChild.get(targetChildId);
    if (!allowed || !allowed.has(promptProfileId)) {
      throw new DriveFolderDispatchError('PROMPT_PROFILE_NOT_ALLOWED', `Prompt profile ${promptProfileId} is not locally allowed for ${targetChildId}.`);
    }
  }

  const order = raw.order == null
    ? 0
    : requireInteger(raw.order, 'order', -1000000, 1000000);

  return {
    schemaVersion: DRIVE_FOLDER_DISPATCH_SCHEMA_VERSION,
    fileId: requireId(fileId, 'fileId'),
    parentNodeId,
    generation,
    targetChildId,
    promptPayload,
    promptProfileId,
    order,
  };
}

export class DriveFolderDispatchProviderV1 {
  constructor({
    listGenerations,
    listGenerationEntries,
    readEntryContent,
  } = {}) {
    if (typeof listGenerations !== 'function'
        || typeof listGenerationEntries !== 'function'
        || typeof readEntryContent !== 'function') {
      throw new DriveFolderDispatchError('INVALID_READER', 'Drive folder dispatch readers are required.');
    }
    this.listGenerations = listGenerations;
    this.listGenerationEntries = listGenerationEntries;
    this.readEntryContent = readEntryContent;
  }

  async read({
    groupNodeId,
    maxWorkers,
    sourceId,
    childNodeIds,
    childPromptProfileIds = {},
  } = {}) {
    const group = requireId(groupNodeId, 'groupNodeId');
    const source = requireId(sourceId, 'sourceId');
    const maximum = requireInteger(maxWorkers, 'maxWorkers', 0, MAX_ENTRIES);
    const children = Array.isArray(childNodeIds)
      ? childNodeIds.map((value, index) => requireId(value, `childNodeIds[${index}]`))
      : (() => { throw new DriveFolderDispatchError('INVALID_CONFIG', 'childNodeIds are required.'); })();
    if (new Set(children).size !== children.length) {
      throw new DriveFolderDispatchError('INVALID_CONFIG', 'Duplicate childNodeIds.');
    }
    if (maximum > children.length) {
      throw new DriveFolderDispatchError('INVALID_CONFIG', 'maxWorkers exceeds local child capacity.');
    }
    const allowedChildIds = new Set(children);
    const localPromptProfilesByChild = new Map(children.map(childId => {
      const raw = childPromptProfileIds?.[childId];
      const ids = Array.isArray(raw) ? raw.map((value, index) => requireId(value, `childPromptProfileIds.${childId}[${index}]`)) : [];
      return [childId, new Set(ids)];
    }));

    const rawGenerations = await this.listGenerations({ sourceId: source });
    if (!Array.isArray(rawGenerations) || rawGenerations.length > MAX_GENERATIONS) {
      throw new DriveFolderDispatchError('INVALID_GENERATION_LIST', 'Invalid Drive generation list.');
    }
    const generations = rawGenerations
      .map(normalizeGeneration)
      .filter(Boolean)
      .sort((a, b) => compareRevision(b.revision, a.revision));
    if (!generations.length) return { kind: 'NO_GENERATION', providerId: DRIVE_FOLDER_DISPATCH_PROVIDER_V1, groupNodeId: group, sourceId: source };

    const generation = generations[0];
    const beforeRaw = await this.listGenerationEntries({ sourceId: source, generation });
    if (!Array.isArray(beforeRaw) || beforeRaw.length > MAX_ENTRIES + 1) {
      throw new DriveFolderDispatchError('INVALID_ENTRY_LIST', 'Invalid Drive generation entry list.');
    }
    const before = beforeRaw.map(normalizeEntry);
    if (new Set(before.map(entry => entry.id)).size !== before.length) {
      throw new DriveFolderDispatchError('DUPLICATE_ENTRY', 'Duplicate Drive entry id in generation.');
    }
    const readyEntries = before.filter(entry => entry.name === 'READY');
    if (readyEntries.length !== 1) {
      return {
        kind: 'NOT_READY',
        providerId: DRIVE_FOLDER_DISPATCH_PROVIDER_V1,
        groupNodeId: group,
        sourceId: source,
        providerRevision: generation.revision,
      };
    }
    const dispatchEntries = before.filter(entry => entry.name !== 'READY');
    if (dispatchEntries.length > maximum) {
      throw new DriveFolderDispatchError('OVER_CAPACITY', `Dispatch generation has ${dispatchEntries.length} files but local max is ${maximum}.`);
    }

    const parsed = [];
    for (const entry of dispatchEntries) {
      const content = await this.readEntryContent({ sourceId: source, generation, entry });
      parsed.push({
        ...parseDispatchEnvelope(content, {
          groupNodeId: group,
          generationRevision: generation.revision,
          allowedChildIds,
          localPromptProfilesByChild,
          fileId: entry.id,
        }),
        fileVersion: entry.version,
      });
    }

    const targets = parsed.map(item => item.targetChildId);
    if (new Set(targets).size !== targets.length) {
      throw new DriveFolderDispatchError('DUPLICATE_TARGET', 'Dispatch generation contains duplicate target_child_id.');
    }

    const afterRaw = await this.listGenerationEntries({ sourceId: source, generation });
    if (!Array.isArray(afterRaw) || afterRaw.length > MAX_ENTRIES + 1) {
      throw new DriveFolderDispatchError('INVALID_ENTRY_LIST', 'Invalid Drive generation entry list after read.');
    }
    const after = afterRaw.map(normalizeEntry);
    const beforeSignature = entriesSignature(before);
    if (beforeSignature !== entriesSignature(after)) {
      throw new DriveFolderDispatchError('UNSTABLE_GENERATION', 'Drive dispatch generation changed while being read.');
    }
    const snapshotHash = await sha256Text(beforeSignature);

    parsed.sort((a, b) => a.order - b.order || a.targetChildId.localeCompare(b.targetChildId) || a.fileId.localeCompare(b.fileId));
    return {
      kind: 'READY',
      providerId: DRIVE_FOLDER_DISPATCH_PROVIDER_V1,
      groupNodeId: group,
      sourceId: source,
      providerRevision: generation.revision,
      generationFolderId: generation.folderId,
      snapshotHash,
      dispatches: parsed,
    };
  }
}
