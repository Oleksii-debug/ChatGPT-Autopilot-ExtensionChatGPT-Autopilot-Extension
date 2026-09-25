import { assertToolInvocationAuthorizedV1, normalizeToolDescriptorV1 } from './universal-agent-contracts.js';

export const GITHUB_PROVIDER_ID = 'remote/github';

export const GitHubToolId = Object.freeze({
  REPOSITORY_READ: 'remote/github/repository.read',
  FILE_READ: 'remote/github/file.read',
  TREE_READ: 'remote/github/tree.read',
  BRANCH_READ: 'remote/github/branch.read',
  PULL_REQUEST_FIND: 'remote/github/pullRequest.find',
  PULL_REQUEST_READ: 'remote/github/pullRequest.read',
  PULL_REQUEST_COMMENT_READ: 'remote/github/pullRequest.comment.read',
  ISSUE_READ: 'remote/github/issue.read',
  ISSUE_COMMENT_READ: 'remote/github/issueComment.read',
  BRANCH_CREATE: 'remote/github/branch.create',
  FILE_PUT: 'remote/github/file.put',
  FILE_DELETE: 'remote/github/file.delete',
  PULL_REQUEST_CREATE: 'remote/github/pullRequest.create',
  PULL_REQUEST_MERGE: 'remote/github/pullRequest.merge',
  PULL_REQUEST_COMMENT_CREATE: 'remote/github/pullRequest.comment.create',
  ISSUE_CREATE: 'remote/github/issue.create',
  ISSUE_COMMENT_CREATE: 'remote/github/issueComment.create',
});

export const GitHubCapabilityId = Object.freeze({
  REPOSITORY_READ: 'github.repository.read',
  FILE_READ: 'github.file.read',
  TREE_READ: 'github.tree.read',
  BRANCH_READ: 'github.branch.read',
  PULL_REQUEST_READ: 'github.pullRequest.read',
  PULL_REQUEST_COMMENT_READ: 'github.pullRequest.comment.read',
  ISSUE_READ: 'github.issue.read',
  ISSUE_COMMENT_READ: 'github.issueComment.read',
  BRANCH_CREATE: 'github.branch.create',
  FILE_WRITE: 'github.file.write',
  FILE_DELETE: 'github.file.delete',
  PULL_REQUEST_CREATE: 'github.pullRequest.create',
  PULL_REQUEST_MERGE: 'github.pullRequest.merge',
  PULL_REQUEST_COMMENT_CREATE: 'github.pullRequest.comment.create',
  ISSUE_CREATE: 'github.issue.create',
  ISSUE_COMMENT_CREATE: 'github.issueComment.create',
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
    toolId: GitHubToolId.PULL_REQUEST_READ,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Read exact GitHub pull request',
    description: 'Reads one exact pull request for bounded agent context and independent verification.',
    capabilityIds: [GitHubCapabilityId.PULL_REQUEST_READ],
    inputSchemaRef: 'github-schema/pullRequest.read/input',
    outputSchemaRef: 'github-schema/pullRequest.read/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.PULL_REQUEST_COMMENT_READ,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Read exact GitHub pull request timeline comment',
    description: 'Reads one exact pull request timeline comment and binds it to its repository and parent pull request.',
    capabilityIds: [GitHubCapabilityId.PULL_REQUEST_COMMENT_READ],
    inputSchemaRef: 'github-schema/pullRequest.comment.read/input',
    outputSchemaRef: 'github-schema/pullRequest.comment.read/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.ISSUE_READ,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Read exact GitHub issue',
    description: 'Reads one exact non-pull-request issue for independent verification and agent context.',
    capabilityIds: [GitHubCapabilityId.ISSUE_READ],
    inputSchemaRef: 'github-schema/issue.read/input',
    outputSchemaRef: 'github-schema/issue.read/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.ISSUE_COMMENT_READ,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Read exact GitHub issue comment',
    description: 'Reads one exact issue comment and binds it to its repository and parent issue.',
    capabilityIds: [GitHubCapabilityId.ISSUE_COMMENT_READ],
    inputSchemaRef: 'github-schema/issueComment.read/input',
    outputSchemaRef: 'github-schema/issueComment.read/output',
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
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.PULL_REQUEST_MERGE,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Merge GitHub pull request at exact head',
    description: 'Merges one exact open pull request only when its current head SHA matches the owner-authorized expected head. Ambiguous outcomes require reconciliation.',
    capabilityIds: [GitHubCapabilityId.PULL_REQUEST_MERGE],
    inputSchemaRef: 'github-schema/pullRequest.merge/input',
    outputSchemaRef: 'github-schema/pullRequest.merge/output',
    readOnly: false,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.PULL_REQUEST_COMMENT_CREATE,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Create GitHub pull request timeline comment',
    description: 'Adds one bounded ordinary timeline comment to an exact pull request. Diff-line review comments are not admitted.',
    capabilityIds: [GitHubCapabilityId.PULL_REQUEST_COMMENT_CREATE],
    inputSchemaRef: 'github-schema/pullRequest.comment.create/input',
    outputSchemaRef: 'github-schema/pullRequest.comment.create/output',
    readOnly: false,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.ISSUE_CREATE,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Create GitHub issue',
    description: 'Creates one bounded issue in an owner-allowlisted repository. Ambiguous outcomes require reconciliation.',
    capabilityIds: [GitHubCapabilityId.ISSUE_CREATE],
    inputSchemaRef: 'github-schema/issue.create/input',
    outputSchemaRef: 'github-schema/issue.create/output',
    readOnly: false,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GitHubToolId.ISSUE_COMMENT_CREATE,
    providerId: GITHUB_PROVIDER_ID,
    label: 'Create GitHub issue comment',
    description: 'Adds one bounded comment to an exact issue. Ambiguous outcomes require reconciliation.',
    capabilityIds: [GitHubCapabilityId.ISSUE_COMMENT_CREATE],
    inputSchemaRef: 'github-schema/issueComment.create/input',
    outputSchemaRef: 'github-schema/issueComment.create/output',
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
  if (toolId === GitHubToolId.PULL_REQUEST_READ) return 'readPullRequest';
  if (toolId === GitHubToolId.PULL_REQUEST_COMMENT_READ) return 'readPullRequestComment';
  if (toolId === GitHubToolId.ISSUE_READ) return 'readIssue';
  if (toolId === GitHubToolId.ISSUE_COMMENT_READ) return 'readIssueComment';
  if (toolId === GitHubToolId.BRANCH_CREATE) return 'createBranch';
  if (toolId === GitHubToolId.FILE_PUT) return 'putFile';
  if (toolId === GitHubToolId.FILE_DELETE) return 'deleteFile';
  if (toolId === GitHubToolId.PULL_REQUEST_CREATE) return 'createPullRequest';
  if (toolId === GitHubToolId.PULL_REQUEST_MERGE) return 'mergePullRequest';
  if (toolId === GitHubToolId.PULL_REQUEST_COMMENT_CREATE) return 'createPullRequestComment';
  if (toolId === GitHubToolId.ISSUE_CREATE) return 'createIssue';
  if (toolId === GitHubToolId.ISSUE_COMMENT_CREATE) return 'createIssueComment';
  return '';
}

export class GitHubAgentProviderV1 {
  constructor({ githubClient, grantedCapabilityIds = [], now = () => Date.now() } = {}) {
    if (!Array.isArray(grantedCapabilityIds)) throw new Error('grantedCapabilityIds must be an array');
    const methods = Object.values(GitHubToolId)
      .filter(toolId => toolId !== GitHubToolId.PULL_REQUEST_MERGE)
      .map(methodFor);
    if (!githubClient || methods.some(method => typeof githubClient[method] !== 'function')) {
      throw new Error('GitHub REST client with the complete V1 operation set is required');
    }
    if (grantedCapabilityIds.includes(GitHubCapabilityId.PULL_REQUEST_MERGE)
        && typeof githubClient.mergePullRequest !== 'function') {
      throw new Error('GitHub REST client with pull-request merge support is required for the granted merge capability');
    }
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
