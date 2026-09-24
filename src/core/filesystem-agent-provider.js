import { assertToolInvocationAuthorizedV1, normalizeToolDescriptorV1 } from './universal-agent-contracts.js';

export const FILESYSTEM_PROVIDER_ID = 'native/filesystem';
export const FilesystemToolId = Object.freeze({
  READ_TEXT: 'native/filesystem/readText',
  SEARCH: 'native/filesystem/search',
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
]);

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
    toolId: FilesystemToolId.WRITE_EXISTING_TEXT,
    providerId: FILESYSTEM_PROVIDER_ID,
    label: 'Replace existing owner-scoped text file',
    description: 'Replaces an existing UTF-8 file under an explicitly writable owner root with optimistic SHA-256 concurrency fencing.',
    capabilityIds: ['filesystem.writeExistingText'],
    inputSchemaRef: 'filesystem-schema/writeExistingText/input',
    outputSchemaRef: 'filesystem-schema/writeExistingText/output',
    readOnly: false,
  }),
]);

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
  constructor({ nativeClient, grantedCapabilityIds = [], now = () => Date.now() } = {}) {
    if (!nativeClient?.readText || !nativeClient?.searchFiles || !nativeClient?.writeExistingText) {
      throw new Error('Filesystem Native Companion client is required');
    }
    this.nativeClient = nativeClient;
    this.grantedCapabilityIds = Object.freeze([...grantedCapabilityIds]);
    this.now = now;
  }

  tools() { return TOOLS; }

  authorize({ invocation, policyDecision } = {}) {
    const tool = TOOLS.find(item => item.toolId === invocation?.toolId);
    if (!tool) throw new Error('Filesystem tool is not registered');
    return assertToolInvocationAuthorizedV1({
      invocation,
      policyDecision,
      toolDescriptor: tool,
      grantedCapabilityIds: this.grantedCapabilityIds,
    });
  }

  async invoke({ invocation, policyDecision } = {}) {
    const authorized = this.authorize({ invocation, policyDecision });
    const tool = TOOLS.find(item => item.toolId === authorized.invocation.toolId);
    try {
      let result;
      if (tool.toolId === FilesystemToolId.READ_TEXT) {
        result = await this.nativeClient.readText(authorized.invocation.arguments);
      } else if (tool.toolId === FilesystemToolId.SEARCH) {
        result = await this.nativeClient.searchFiles(authorized.invocation.arguments);
      } else {
        result = await this.nativeClient.writeExistingText(authorized.invocation.arguments);
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
