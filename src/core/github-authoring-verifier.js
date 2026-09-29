import { VerificationStatus } from './universal-agent-contracts.js';
import { ReconciliationOutcome } from './universal-agent-exact-effect.js';
import { GITHUB_PROVIDER_ID, GitHubToolId } from './github-agent-provider.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA = /^[a-f0-9]{40,64}$/iu;
const REF = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\.lock(?:\/|$))[A-Za-z0-9._\/-]{1,240}$/u;

function requireId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function snapshotRecord(value, label, allowed = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${label} must be a plain object`);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (allowed && !allowed.has(key))) throw new Error(`${label} contains unknown field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${String(key)} must be an enumerable data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function snapshotArray(value, label, max = 32) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} entries must be enumerable data properties`);
    }
    out.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
      throw new Error(`${label} contains a non-index field`);
    }
  }
  return out;
}

function bindDataMethod(target, method, label) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) throw new Error(`${label} is required`);
  let current = target;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, method);
    if (descriptor) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new Error(`${label}.${method} must be a data method`);
      }
      return descriptor.value.bind(target);
    }
    current = Object.getPrototypeOf(current);
  }
  throw new Error(`${label}.${method} is required`);
}

function repository(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 300 || !REPOSITORY.test(value) || value.includes('..')) {
    throw new Error('repositoryFullName is invalid');
  }
  return value;
}

function exactSha(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !SHA.test(value)) throw new Error(`${label} is invalid`);
  return value.toLowerCase();
}

function exactRef(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !REF.test(value)
      || value.endsWith('/') || value.startsWith('.') || value.includes('//')) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactTitle(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 1000) throw new Error('title is invalid');
  return value;
}

function exactBody(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 100_000) throw new Error('body is invalid');
  return value;
}

function exactUrl(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 4096) throw new Error(`${label} is invalid`);
  return value;
}

function positiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
  return value;
}

function attemptFromExecutionId(value) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error('executionId does not contain a valid attempt');
  const match = /:attempt:(\d+)$/u.exec(value);
  const attempt = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 64) throw new Error('executionId does not contain a valid attempt');
  return attempt;
}

function expectedMutation(invocation) {
  const admitted = snapshotRecord(invocation, 'GitHub authoring invocation');
  if (admitted.providerId !== GITHUB_PROVIDER_ID
      || ![GitHubToolId.BRANCH_CREATE, GitHubToolId.PULL_REQUEST_CREATE].includes(admitted.toolId)) {
    throw new Error('GitHub authoring verifier accepts only canonical branch-create/pull-request-create invocations');
  }
  const invocationId = requireId(admitted.invocationId, 'invocationId');
  const policyDecisionId = requireId(admitted.policyDecisionId, 'policyDecisionId');

  if (admitted.toolId === GitHubToolId.BRANCH_CREATE) {
    const args = snapshotRecord(
      admitted.arguments,
      'GitHub branch-create arguments',
      new Set(['repositoryFullName', 'branch', 'fromSha']),
    );
    return Object.freeze({
      toolId: admitted.toolId,
      invocationId,
      policyDecisionId,
      repositoryFullName: repository(args.repositoryFullName),
      branch: exactRef(args.branch, 'branch'),
      fromSha: exactSha(args.fromSha, 'fromSha'),
    });
  }

  const args = snapshotRecord(
    admitted.arguments,
    'GitHub pull-request-create arguments',
    new Set(['repositoryFullName', 'title', 'body', 'head', 'base']),
  );
  return Object.freeze({
    toolId: admitted.toolId,
    invocationId,
    policyDecisionId,
    repositoryFullName: repository(args.repositoryFullName),
    title: exactTitle(args.title),
    body: exactBody(args.body),
    head: exactRef(args.head, 'head'),
    base: exactRef(args.base, 'base'),
  });
}

function observedMutation(expected, observation) {
  const observed = snapshotRecord(observation, 'GitHub authoring observation');
  if (requireId(observed.invocationId, 'observation.invocationId') !== expected.invocationId) {
    throw new Error('GitHub authoring observation invocation identity mismatch');
  }
  const observationId = requireId(observed.observationId, 'observationId');

  if (expected.toolId === GitHubToolId.BRANCH_CREATE) {
    const data = snapshotRecord(
      observed.data,
      'GitHub branch-create observation data',
      new Set(['repositoryFullName', 'branch', 'ref', 'sha']),
    );
    const expectedRef = `refs/heads/${expected.branch}`;
    if (data.repositoryFullName !== expected.repositoryFullName
        || data.branch !== expected.branch
        || data.ref !== expectedRef
        || exactSha(data.sha, 'observed branch sha') !== expected.fromSha) {
      throw new Error('GitHub branch-create observation identity mismatch');
    }
    return Object.freeze({ ...expected, observationId, ref: expectedRef });
  }

  const data = snapshotRecord(
    observed.data,
    'GitHub pull-request-create observation data',
    new Set(['repositoryFullName', 'number', 'head', 'base', 'url']),
  );
  if (data.repositoryFullName !== expected.repositoryFullName
      || data.head !== expected.head
      || data.base !== expected.base) {
    throw new Error('GitHub pull-request-create observation parent identity mismatch');
  }
  return Object.freeze({
    ...expected,
    observationId,
    pullRequestNumber: positiveInteger(data.number, 'observed pull request number'),
    url: exactUrl(data.url, 'observed pull request URL'),
  });
}

export class GitHubAuthoringVerifierV1 {
  constructor({ githubClient, verifierId = 'github-authoring-readback-verifier', now = () => Date.now() } = {}) {
    this.readBranch = bindDataMethod(githubClient, 'readBranch', 'GitHub readback client');
    this.findPullRequests = bindDataMethod(githubClient, 'findPullRequests', 'GitHub readback client');
    this.readPullRequest = bindDataMethod(githubClient, 'readPullRequest', 'GitHub readback client');
    this.verifierId = requireId(verifierId, 'verifierId');
    if (this.verifierId === GITHUB_PROVIDER_ID) throw new Error('GitHub authoring verifier identity must differ from provider identity');
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.now = now;
  }

  async #readback(identity) {
    if (identity.toolId === GitHubToolId.BRANCH_CREATE) {
      const branch = snapshotRecord(
        await this.readBranch({
          repositoryFullName: identity.repositoryFullName,
          branch: identity.branch,
        }),
        'GitHub branch-create readback',
        new Set(['repositoryFullName', 'branch', 'ref', 'commitSha']),
      );
      const matches = branch.repositoryFullName === identity.repositoryFullName
        && branch.branch === identity.branch
        && branch.ref === identity.ref
        && exactSha(branch.commitSha, 'readback branch commitSha') === identity.fromSha;
      return Object.freeze({ identity, matches });
    }

    const found = snapshotRecord(
      await this.findPullRequests({
        repositoryFullName: identity.repositoryFullName,
        head: identity.head,
        base: identity.base,
      }),
      'GitHub pull-request-create find readback',
      new Set(['repositoryFullName', 'head', 'base', 'matches']),
    );
    const matches = snapshotArray(found.matches, 'GitHub pull-request-create matches', 10);
    const parentMatch = found.repositoryFullName === identity.repositoryFullName
      && found.head === identity.head
      && found.base === identity.base
      && matches.some(item => {
        const candidate = snapshotRecord(
          item,
          'GitHub pull-request-create match',
          new Set(['number', 'state', 'title', 'url', 'headSha', 'baseSha']),
        );
        return candidate.number === identity.pullRequestNumber;
      });

    const pull = snapshotRecord(
      await this.readPullRequest({
        repositoryFullName: identity.repositoryFullName,
        pullRequestNumber: identity.pullRequestNumber,
      }),
      'GitHub pull-request-create exact readback',
      new Set(['repositoryFullName', 'number', 'title', 'body', 'state', 'merged', 'headSha', 'baseSha', 'mergeCommitSha', 'url']),
    );
    const matchesExact = parentMatch
      && pull.repositoryFullName === identity.repositoryFullName
      && pull.number === identity.pullRequestNumber
      && pull.title === identity.title
      && pull.body === identity.body
      && pull.url === identity.url;
    return Object.freeze({ identity, matches: matchesExact });
  }

  #verification(readback, executionId, attempt, observationId, suffix = '') {
    const verified = readback.matches;
    const branchCreate = readback.identity.toolId === GitHubToolId.BRANCH_CREATE;
    return {
      schemaVersion: 1,
      verificationId: `${readback.identity.invocationId}:github-authoring-verification${suffix}:${attempt}`,
      invocationId: readback.identity.invocationId,
      observationId,
      status: verified ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: verified
        ? (branchCreate ? 'GITHUB_BRANCH_CREATE_CONFIRMED' : 'GITHUB_PULL_REQUEST_CREATE_CONFIRMED')
        : 'GITHUB_AUTHORING_NOT_CONFIRMED',
      summary: verified
        ? `Fresh independent GitHub readback confirmed the exact ${branchCreate ? 'branch' : 'pull request'} created by the provider.`
        : 'Fresh independent GitHub readback did not confirm the exact authored GitHub object.',
      evidenceArtifactIds: [],
      verifiedAt: new Date(this.now()).toISOString(),
      verifierId: this.verifierId,
      verificationAuthorityId: readback.identity.policyDecisionId,
      effectId: readback.identity.invocationId,
      executionId,
      attempt,
    };
  }

  async verify({ invocation, executionId, observation } = {}) {
    const attempt = attemptFromExecutionId(executionId);
    const expected = expectedMutation(invocation);
    const identity = observedMutation(expected, observation);
    const readback = await this.#readback(identity);
    return this.#verification(readback, executionId, attempt, identity.observationId);
  }

  async reconcileVerify({
    invocation,
    effectId,
    executionId,
    attempt,
    policyDecisionId,
    expectedOutcome,
    priorObservation,
  } = {}) {
    if (expectedOutcome === ReconciliationOutcome.SAFE_RETRY) {
      throw new Error('GitHub authoring mutation cannot prove SAFE_RETRY after dispatch');
    }
    if (expectedOutcome !== ReconciliationOutcome.VERIFIED) {
      throw new Error('GitHub authoring reconciliation supports only VERIFIED or manual review');
    }

    const expected = expectedMutation(invocation);
    if (requireId(effectId, 'effectId') !== expected.invocationId) throw new Error('effectId is invalid');
    if (requireId(policyDecisionId, 'policyDecisionId') !== expected.policyDecisionId) throw new Error('policyDecisionId is invalid');
    const exactAttempt = attemptFromExecutionId(executionId);
    if (attempt !== exactAttempt) throw new Error('attempt does not match executionId');
    if (!priorObservation) {
      throw new Error('GitHub authoring mutation requires the immutable provider-created identity for automatic reconciliation; otherwise manual review is required');
    }
    const identity = observedMutation(expected, priorObservation);
    const readback = await this.#readback(identity);
    const observedAt = new Date(this.now()).toISOString();
    const observation = {
      schemaVersion: 1,
      observationId: `${expected.invocationId}:github-authoring-readback:reconcile-${attempt}`,
      invocationId: expected.invocationId,
      status: 'OK',
      summary: 'Fresh GitHub readback classified whether the exact authored object is present.',
      data: {
        committed: readback.matches,
        repositoryFullName: expected.repositoryFullName,
        toolId: expected.toolId,
        ...(expected.toolId === GitHubToolId.BRANCH_CREATE
          ? { branch: expected.branch, fromSha: expected.fromSha }
          : { pullRequestNumber: identity.pullRequestNumber, head: expected.head, base: expected.base }),
      },
      artifactRefs: [],
      observedAt,
    };
    const verification = this.#verification(readback, executionId, attempt, observation.observationId, ':reconcile');
    return {
      verifierId: this.verifierId,
      verificationAuthorityId: policyDecisionId,
      effectId,
      executionId,
      attempt,
      observation,
      verification,
    };
  }
}
