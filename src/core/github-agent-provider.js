import { assertToolInvocationAuthorizedV1, normalizeToolDescriptorV1 } from './universal-agent-contracts.js';

export const GITHUB_PROVIDER_ID = 'remote/github';

export const GitHubToolId = Object.freeze({
  REPOSITORY_READ: 'remote/github/repository.read',
  FILE_READ: 'remote/github/file.read',
  TREE_READ: 'remote/github/tree.read',
  BRANCH_READ: 'remote/github/branch.read',
  PULL_REQUEST_FIND: 'remote/github/pullRequest.find',
  BRANCH_CREATE: 'remote/github/branch.create',
  FILE_PUT: 'remote/github/file.put',
  FILE_DELETE: 'remote/github/file.delete',
  PULL_REQUEST_CREATE: 'remote/github/pullRequest.create',
});

export const GitHubCapabilityId = Object.freeze({
  REPOSITORY_READ: 'github.repository.read',
  FILE_READ: 'github.file.read',
  TREE_READ: 'github.tree.read',
  BRANCH_READ: 'github.branch.read',
  PULL_REQUEST_READ: 'github.pullRequest.read',
  BRANCH_CREATE: 'github.branch.create',
  FILE_WRITE: 'github.file.write',
  FILE_DELETE: 'github.file.delete',
  PULL_REQUEST_CREATE: 'github.pullRequest.create',
});

const TOOLS = Object.freeze([
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.REPOSITORY_READ,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Read allowed GitHub repository metadata',
    description: 'Reads bounded metadata for one owner-allowlisted GitHub repository.',
    capabilityIds: [GitHubCapabilityId.REPOSITORY_READ],
    inputSchemaRef: 'github-schema/repository.read/input',
    outputSchemaRef: 'github-schema/repository.read/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.FILE_READ,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Read allowed GitHub UTF-8 file',
    description: 'Reads one bounded UTF-8 text file and its exact blob SHA from an owner-allowlisted GitHub repository.',
    capabilityIds: [GitHubCapabilityId.FILE_READ],
    inputSchemaRef: 'github-schema/file.read/input',
    outputSchemaRef: 'github-schema/file.read/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.TREE_READ,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Read allowed GitHub tree',
    description: 'Reads a bounded repository tree for codebase discovery without granting mutation authority.',
    capabilityIds: [GitHubCapabilityId.TREE_READ],
    inputSchemaRef: 'github-schema/tree.read/input',
    outputSchemaRef: 'github-schema/tree.read/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.BRANCH_READ,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Read exact GitHub branch commit',
    description: 'Reads the exact commit SHA currently referenced by one owner-allowlisted branch for reconciliation.',
    capabilityIds: [GitHubCapabilityId.BRANCH_READ],
    inputSchemaRef: 'github-schema/branch.read/input',
    outputSchemaRef: 'github-schema/branch.read/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.PULL_REQUEST_FIND,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Find GitHub pull request by refs',
    description: 'Reads bounded pull request matches for an exact same-repository head and base pair for reconciliation.',
    capabilityIds: [GitHubCapabilityId.PULL_REQUEST_READ],
    inputSchemaRef: 'github-schema/pullRequest.find/input',
    outputSchemaRef: 'github-schema/pullRequest.find/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.BRANCH_CREATE,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Create GitHub branch at exact commit',
    description: 'Creates one branch from an explicit commit SHA. Ambiguous transport outcomes require reconciliation before retry.',
    capabilityIds: [GitHubCapabilityId.BRANCH_CREATE],
    inputSchemaRef: 'github-schema/branch.create/input',
    outputSchemaRef: 'github-schema/branch.create/output',
    readOnly: false,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.FILE_PUT,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Create or update GitHub file with revision precondition',
    description: 'Creates a new file or updates an existing file only with an explicit expected blob SHA.',
    capabilityIds: [GitHubCapabilityId.FILE_WRITE],
    inputSchemaRef: 'github-schema/file.put/input',
    outputSchemaRef: 'github-schema/file.put/output',
    readOnly: false,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.FILE_DELETE,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Delete GitHub file with revision precondition',
    description: 'Deletes one file only when the caller supplies the exact expected blob SHA.',
    capabilityIds: [GitHubCapabilityId.FILE_DELETE],
    inputSchemaRef: 'github-schema/file.delete/input',
    outputSchemaRef: 'github-schema/file.delete/output',
    readOnly: false,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.PULL_REQUEST_CREATE,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Create GitHub pull request',
    description: 'Creates one pull request between explicit head and base refs. Ambiguous transport outcomes require reconciliation.',
    capabilityIds: [GitHubCapabilityId.PULL_REQUEST_CREATE],
    inputSchemaRef: 'github-schema/pullRequest.create/input',
    outputSchemaRef: 'github-schema/pullRequest.create/output',
    readOnly: false,
  }),
]);

const PRE_EFFECT_CODES = new Set([
  'GITHUB_INVALID_REQUEST',
  'GITHUB_REPOSITORY_NOT_ALLOWED',
  'GITHUB_CREDENTIAL_UNAVAILABLE',
  'GITHUB_CREDENTIAL_INVALID',
  'CREDENTIAL_NOT_AVAILABLE',
  'CREDENTIAL_SCOPE_DENIED',
  'CREDENTIAL_CONFIG_INVALID',
]);

function wrapFailure(error, { readOnly, invocationId }) {
  const code = String(error?.code || 'GITHUB_PROVIDER_FAILED').slice(0, 120);
  const hasEffectFlag = typeof error?.effectMayHaveOccurred === 'boolean';
  const hasRetryFlag = typeof error?.safeToRetry === 'boolean';
  const preEffect = PRE_EFFECT_CODES.has(code);
  const wrapped = new Error(String(error?.message || error).slice(0, 4000));
  wrapped.name = 'GitHubAgentProviderError';
  wrapped.code = code;
  wrapped.invocationId = invocationId;
  wrapped.effectMayHaveOccurred = readOnly ? false : (hasEffectFlag ? error.effectMayHaveOccurred : !preEffect);
  wrapped.safeToRetry = readOnly ? true : (hasRetryFlag ? error.safeToRetry : preEffect);
  if (Number.isInteger(error?.status)) wrapped.status = error.status;
  wrapped.cause = error;
  return wrapped;
}

function methodFor(toolId) {
  if (toolId === GitHubToolId.REPOSITORY_READ) return 'readRepository';
  if (toolId === GitHubToolId.FILE_READ) return 'readFile';
  if (toolId === GitHubToolId.TREE_READ) return 'readTree';
  if (toolId === GitHubToolId.BRANCH_READ) return 'readBranch';
  if (toolId === GitHubToolId.PULL_REQUEST_FIND) return 'findPullRequests';
  if (toolId === GitHubToolId.BRANCH_CREATE) return 'createBranch';
  if (toolId === GitHubToolId.FILE_PUT) return 'putFile';
  if (toolId === GitHubToolId.FILE_DELETE) return 'deleteFile';
  if (toolId === GitHubToolId.PULL_REQUEST_CREATE) return 'createPullRequest';
  return '';
}

export class GitHubAgentProviderV1 {
  constructor({ githubClient, grantedCapabilityIds = [], now = () => Date.now() } = {}) {
    const methods = Object.values(GitHubToolId).map(methodFor);
    if (!githubClient || methods.some(method => typeof githubClient[method] !== 'function')) {
      throw new Error('GitHub REST client with the complete V1 operation set is required');
    }
    if (!Array.isArray(grantedCapabilityIds)) throw new Error('grantedCapabilityIds must be an array');
    this.githubClient = githubClient;
    this.grantedCapabilityIds = Object.freeze([...grantedCapabilityIds]);
    this.now = now;
  }

  tools() {
    return TOOLS;
  }

  authorize({ invocation, policyDecision } = {}) {
    const tool = TOOLS.find(item => item.toolId === invocation?.toolId);
    if (!tool) throw new Error('GitHub tool is not registered');
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
    const method = methodFor(tool.toolId);
    try {
      const result = await this.githubClient[method](authorized.invocation.arguments);
      return Object.freeze({
        providerId: GITHUB_PROVIDER_ID,
        invocationId: authorized.invocation.invocationId,
        observedAt: new Date(this.now()).toISOString(),
        result: structuredClone(result),
      });
    } catch (error) {
      throw wrapFailure(error, { readOnly: tool.readOnly, invocationId: authorized.invocation.invocationId });
    }
  }
}
