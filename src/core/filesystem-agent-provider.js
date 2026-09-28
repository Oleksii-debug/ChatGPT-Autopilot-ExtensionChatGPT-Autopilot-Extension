import {
  assertToolInvocationAuthorizedV1,
  normalizeArtifactRefV1,
  normalizeToolDescriptorV1,
} from './universal-agent-contracts.js';

export const FILESYSTEM_PROVIDER_ID = 'native/filesystem';
export const FilesystemToolId = Object.freeze({
  READ_TEXT: 'native/filesystem/readText',
  READ_BINARY: 'native/filesystem/readBinary',
  SEARCH: 'native/filesystem/search',
  LIST: 'native/filesystem/list',
  STAT: 'native/filesystem/stat',
  WRITE_EXISTING_TEXT: 'native/filesystem/writeExistingText',
});

const PRE_EFFECT_CODES = new Set([
  'INVALID_REQUEST',
  'ROOT_NOT_ALLOWED',
  'ROOT_NOT_WRITABLE',
  'PATH_OUTSIDE_SCOPE',
  'FILE_NOT_FOUND',
  'NOT_A_FILE',
  'FILE_TOO_LARGE',
  'PRECONDITION_FAILED',
  'UNSUPPORTED_ENCODING',
  'ARTIFACT_RESOLVER_UNAVAILABLE',
  'ARTIFACT_CONTENT_INVALID',
  'ARTIFACT_DIGEST_MISMATCH',
  'ATOMIC_WRITE_UNAVAILABLE',
]);

const WRITE_RECOVERY_TOOL = normalizeToolDescriptorV1({
  schemaVersion: 1,
  toolId: FilesystemToolId.WRITE_EXISTING_TEXT,
  providerId: FILESYSTEM_PROVIDER_ID,
  label: 'Replace existing owner-scoped text file',
  description: 'Recovery-only contract for a previously admitted filesystem write; new write discovery remains disabled until parent-bound atomic publication exists.',
  capabilityIds: ['filesystem.writeExistingText'],
  inputSchemaRef: 'filesystem-schema/writeExistingText/input',
  outputSchemaRef: 'filesystem-schema/writeExistingText/output',
  readOnly: false,
});

const TOOLS = Object.freeze([
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: FilesystemToolId.READ_TEXT,
    providerId: FILESYSTEM_PROVIDER_ID,
    label: 'Read owner-scoped text file',
    description: 'Reads one bounded UTF-8 file from an owner-configured Native Companion root.',
    capabilityIds: ['filesystem.readText'],
    inputSchemaRef: 'filesystem-schema/readText/input',
    outputSchemaRef: 'filesystem-schema/readText/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: FilesystemToolId.READ_BINARY,
    providerId: FILESYSTEM_PROVIDER_ID,
    label: 'Read owner-scoped binary file',
    description: 'Reads one digest-bound binary chunk from a bounded owner-configured Native Companion file snapshot.',
    capabilityIds: ['filesystem.readBinary'],
    inputSchemaRef: 'filesystem-schema/readBinary/input',
    outputSchemaRef: 'filesystem-schema/readBinary/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: FilesystemToolId.SEARCH,
    providerId: FILESYSTEM_PROVIDER_ID,
    label: 'Search owner-scoped filesystem root',
    description: 'Performs bounded metadata search without following links/reparse targets outside the admitted root.',
    capabilityIds: ['filesystem.search'],
    inputSchemaRef: 'filesystem-schema/search/input',
    outputSchemaRef: 'filesystem-schema/search/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: FilesystemToolId.LIST,
    providerId: FILESYSTEM_PROVIDER_ID,
    label: 'List owner-scoped filesystem directory',
    description: 'Enumerates one owner-scoped directory through a bounded streamed Native Companion read.',
    capabilityIds: ['filesystem.list'],
    inputSchemaRef: 'filesystem-schema/list/input',
    outputSchemaRef: 'filesystem-schema/list/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: FilesystemToolId.STAT,
    providerId: FILESYSTEM_PROVIDER_ID,
    label: 'Inspect owner-scoped filesystem metadata',
    description: 'Reads metadata and, when explicitly requested, a bounded SHA-256 from an admitted regular file.',
    capabilityIds: ['filesystem.stat'],
    inputSchemaRef: 'filesystem-schema/stat/input',
    outputSchemaRef: 'filesystem-schema/stat/output',
    readOnly: true,
  }),
]);
const KNOWN_TOOLS = Object.freeze([...TOOLS, WRITE_RECOVERY_TOOL]);
const LEGACY_NATIVE_CAPABILITY_IDS = Object.freeze([
  'filesystem.readText',
  'filesystem.search',
]);

const NATIVE_METHOD_BY_TOOL_ID = Object.freeze({
  [FilesystemToolId.READ_TEXT]: 'readText',
  [FilesystemToolId.READ_BINARY]: 'readBinary',
  [FilesystemToolId.SEARCH]: 'searchFiles',
  [FilesystemToolId.LIST]: 'listFiles',
  [FilesystemToolId.STAT]: 'statPath',
});

function nativeCapabilityIdsFromSnapshot(snapshot) {
  if (snapshot == null) return new Set(LEGACY_NATIVE_CAPABILITY_IDS);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || !Array.isArray(snapshot.capabilities)) {
    throw new Error('Native Companion capability snapshot is invalid');
  }
  const out = new Set();
  for (const [index, capability] of snapshot.capabilities.entries()) {
    if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
      throw new Error(`Native Companion capabilities[${index}] is invalid`);
    }
    const capabilityId = capability.capabilityId;
    if (typeof capabilityId !== 'string' || capabilityId !== capabilityId.trim() || !capabilityId) {
      throw new Error(`Native Companion capabilities[${index}].capabilityId is invalid`);
    }
    if (out.has(capabilityId)) {
      throw new Error(`Native Companion capability snapshot contains duplicate capabilityId: ${capabilityId}`);
    }
    out.add(capabilityId);
  }
  return out;
}


function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function sha256Text(value) {
  if (typeof value !== 'string') throw providerError('ARTIFACT_CONTENT_INVALID', 'Resolved filesystem write artifact must be UTF-8 text');
  if (!globalThis.crypto?.subtle) throw providerError('ARTIFACT_CONTENT_INVALID', 'Web Crypto SHA-256 is unavailable');
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeWriteArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw providerError('INVALID_REQUEST', 'Filesystem write arguments are invalid');
  const allowed = new Set(['rootId', 'relativePath', 'contentArtifactRef', 'expectedSha256']);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw providerError('INVALID_REQUEST', `Filesystem write arguments contain unknown field: ${key}`);
  const artifactRef = normalizeArtifactRefV1(args.contentArtifactRef);
  if (!artifactRef.sha256) throw providerError('ARTIFACT_CONTENT_INVALID', 'Filesystem write ArtifactRef requires sha256');
  return Object.freeze({
    rootId: args.rootId,
    relativePath: args.relativePath,
    expectedSha256: args.expectedSha256,
    contentArtifactRef: artifactRef,
  });
}

function wrapFailure(error, { readOnly, invocationId }) {
  const code = String(error?.code || 'FILESYSTEM_PROVIDER_FAILED').slice(0, 120);
  const preEffect = PRE_EFFECT_CODES.has(code);
  const wrapped = new Error(String(error?.message || error).slice(0, 4000));
  wrapped.code = code;
  wrapped.invocationId = invocationId;
  wrapped.effectMayHaveOccurred = readOnly ? false : !preEffect;
  wrapped.safeToRetry = readOnly || preEffect;
  wrapped.cause = error;
  return wrapped;
}

export class FilesystemAgentProviderV1 {
  constructor({
    nativeClient,
    nativeCapabilities = null,
    resolveArtifactText = null,
    grantedCapabilityIds = [],
    now = () => Date.now(),
  } = {}) {
    if (!nativeClient?.readText || !nativeClient?.searchFiles) {
      throw new Error('Filesystem Native Companion read/search client is required');
    }
    this.nativeClient = nativeClient;
    const nativeCapabilityIds = nativeCapabilityIdsFromSnapshot(nativeCapabilities);
    this.availableTools = Object.freeze(TOOLS.filter(tool => {
      const methodName = NATIVE_METHOD_BY_TOOL_ID[tool.toolId];
      const capabilityId = tool.capabilityIds[0];
      return nativeCapabilityIds.has(capabilityId)
        && typeof nativeClient[methodName] === 'function';
    }));
    this.resolveArtifactText = typeof resolveArtifactText === 'function' ? resolveArtifactText : null;
    this.grantedCapabilityIds = Object.freeze([...grantedCapabilityIds]);
    this.now = now;
  }

  tools() { return this.availableTools; }

  authorize({ invocation, policyDecision } = {}) {
    const tool = KNOWN_TOOLS.find(item => item.toolId === invocation?.toolId);
    if (!tool) throw new Error('Filesystem tool is not registered');
    if (tool !== WRITE_RECOVERY_TOOL && !this.availableTools.some(item => item.toolId === tool.toolId)) {
      throw providerError('TOOL_UNAVAILABLE', 'Filesystem tool is unavailable in the connected Native Companion');
    }
    const authorized = assertToolInvocationAuthorizedV1({
      invocation,
      policyDecision,
      toolDescriptor: tool,
      grantedCapabilityIds: this.grantedCapabilityIds,
    });
    if (tool.toolId === FilesystemToolId.WRITE_EXISTING_TEXT) normalizeWriteArguments(authorized.invocation.arguments);
    return authorized;
  }

  async invoke({ invocation, policyDecision } = {}) {
    const authorized = this.authorize({ invocation, policyDecision });
    const tool = KNOWN_TOOLS.find(item => item.toolId === authorized.invocation.toolId);
    try {
      let result;
      if (tool.toolId === FilesystemToolId.READ_TEXT) {
        result = await this.nativeClient.readText(authorized.invocation.arguments);
      } else if (tool.toolId === FilesystemToolId.READ_BINARY) {
        result = await this.nativeClient.readBinary(authorized.invocation.arguments);
      } else if (tool.toolId === FilesystemToolId.SEARCH) {
        result = await this.nativeClient.searchFiles(authorized.invocation.arguments);
      } else if (tool.toolId === FilesystemToolId.LIST) {
        result = await this.nativeClient.listFiles(authorized.invocation.arguments);
      } else if (tool.toolId === FilesystemToolId.STAT) {
        result = await this.nativeClient.statPath(authorized.invocation.arguments);
      } else {
        if (!this.resolveArtifactText) throw providerError('ARTIFACT_RESOLVER_UNAVAILABLE', 'Canonical ArtifactRef text resolver is required for filesystem write');
        const args = normalizeWriteArguments(authorized.invocation.arguments);
        const resolved = await this.resolveArtifactText(args.contentArtifactRef);
        const text = typeof resolved === 'string' ? resolved : resolved?.text;
        const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : null;
        if (!bytes || bytes.byteLength !== args.contentArtifactRef.sizeBytes) {
          throw providerError('ARTIFACT_CONTENT_INVALID', 'Resolved filesystem write artifact size did not match ArtifactRef identity');
        }
        const actualSha256 = await sha256Text(text);
        if (actualSha256 !== args.contentArtifactRef.sha256) {
          throw providerError('ARTIFACT_DIGEST_MISMATCH', 'Resolved filesystem write artifact did not match its SHA-256 identity');
        }
        result = await this.nativeClient.writeExistingText({
          rootId: args.rootId,
          relativePath: args.relativePath,
          text,
          expectedSha256: args.expectedSha256,
        });
      }
      return Object.freeze({
        providerId: FILESYSTEM_PROVIDER_ID,
        invocationId: authorized.invocation.invocationId,
        observedAt: new Date(this.now()).toISOString(),
        result: structuredClone(result),
      });
    } catch (error) {
      throw wrapFailure(error, { readOnly: tool.readOnly, invocationId: authorized.invocation.invocationId });
    }
  }
}