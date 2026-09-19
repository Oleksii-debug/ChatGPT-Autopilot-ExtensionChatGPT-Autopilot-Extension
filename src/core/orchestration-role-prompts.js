import {
  OrchestrationBarrierMode,
  OrchestrationChatMode,
  validateOrchestrationGraphV1,
} from './orchestration-hierarchy.js';

export const OrchestrationRoleTemplate = Object.freeze({
  GLOBAL_DIRECTOR: 'GLOBAL_DIRECTOR',
  DOMAIN_MANAGER: 'DOMAIN_MANAGER',
  WORKER: 'WORKER',
  INTEGRATION_MANAGER: 'INTEGRATION_MANAGER',
  QA_RED_TEAM: 'QA_RED_TEAM',
  RECOVERY: 'RECOVERY',
});

const ROLE_VALUES = new Set(Object.values(OrchestrationRoleTemplate));
const MAX_DOMAINS = 40;
const MAX_WORKERS_PER_MANAGER = 40;
const MAX_SCOPE_LENGTH = 4000;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function required(value, label, max = 4000) {
  const normalized = clean(value);
  if (!normalized || normalized.length > max) throw new Error(\`Invalid \${label}\`);
  return normalized;
}

function integer(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(\`Invalid \${label}\`);
  return parsed;
}

function stableId(value, label) {
  const normalized = required(value, label, 180).toLowerCase();
  if (!/^[a-z0-9._:+/-]+$/u.test(normalized)) throw new Error(\`Invalid \${label}\`);
  return normalized;
}

function repository(value) {
  const normalized = required(value, 'targetRepository', 250);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized)) throw new Error('Invalid targetRepository');
  return normalized;
}

function roleInstructions(role) {
  switch (role) {
    case OrchestrationRoleTemplate.GLOBAL_DIRECTOR:
      return [
        'Own project-wide prioritization and cross-domain reconciliation.',
        'Do not micromanage implementation that belongs to child Managers or Workers.',
        'Read the newest Manager evidence before changing priorities or cross-domain contracts.',
        'When a Manager barrier returns, reconcile conflicts and publish the next bounded direction in canonical project truth.',
      ];
    case OrchestrationRoleTemplate.DOMAIN_MANAGER:
      return [
        'Own only this domain boundary. Do not take sibling-domain implementation merely because it is available.',
        'Translate current project truth into explicit, non-overlapping child-ready work.',
        'Review and integrate child evidence after the configured barrier; resolve conflicts inside this domain.',
        'If fewer useful tasks exist than configured worker slots, allow the unused slots to finish NO_ACTION.',
      ];
    case OrchestrationRoleTemplate.WORKER:
      return [
        'Take one useful, bounded, currently unowned slice inside this exact scope.',
        'Before mutation, re-check live ownership/claims so you do not duplicate another worker.',
        'Implement the largest safe causally connected slice you can actually finish or materially advance, including tests and integration evidence.',
        'Do not create managerial work, sibling work, fake issues, fake claims, or activity merely to look busy.',
      ];
    case OrchestrationRoleTemplate.INTEGRATION_MANAGER:
      return [
        'Own cross-domain integration contracts, convergence and release-path compatibility.',
        'Do not silently become the feature owner of a domain; route domain-specific defects back to the responsible Manager unless a bounded integration fix is necessary.',
        'Verify that independently completed slices compose into one product and that no second scheduler, recovery path or Send authority has appeared.',
      ];
    case OrchestrationRoleTemplate.QA_RED_TEAM:
      return [
        'Act as independent QA / red team against the integrated product and its evidence.',
        'Prefer reproducible failures, missing acceptance evidence, race conditions, restart failures and authority violations over stylistic criticism.',
        'Do not manufacture defects. If the acceptance surface is clean, report verified evidence and NO_ACTION rather than inventing work.',
      ];
    case OrchestrationRoleTemplate.RECOVERY:
      return [
        'ROLE != CHAT. A lost conversation does not erase the logical role.',
        'Treat the previous transcript as unavailable and non-authoritative.',
        'Reconstruct current responsibility from canonical external project truth and durable Autopilot state.',
        'Never revive stale-generation ownership, old claims or already-consumed activation authority.',
      ];
    default:
      throw new Error('Unsupported orchestration role');
  }
}

export function buildOrchestrationRolePrompt({
  role,
  nodeId,
  parentNodeId = '',
  projectId,
  targetRepository,
  controlIssueNumber = 0,
  scope,
  childNodeIds = [],
} = {}) {
  const normalizedRole = required(role, 'role', 80).toUpperCase();
  if (!ROLE_VALUES.has(normalizedRole)) throw new Error('Unsupported orchestration role');
  const node = stableId(nodeId, 'nodeId');
  const parent = parentNodeId ? stableId(parentNodeId, 'parentNodeId') : 'NONE';
  const project = required(projectId, 'projectId', 180);
  const target = repository(targetRepository);
  const issue = integer(controlIssueNumber || 0, 'controlIssueNumber', 0, Number.MAX_SAFE_INTEGER);
  const responsibility = required(scope, 'scope', MAX_SCOPE_LENGTH);
  const children = Array.isArray(childNodeIds)
    ? childNodeIds.map((id, index) => stableId(id, \`childNodeIds[\${index}]\`))
    : (() => { throw new Error('Invalid childNodeIds'); })();

  return [
    'AUTOPILOT LEVEL-1 ROLE CONTRACT',
    \`ROLE=\${normalizedRole}\`,
    \`LOGICAL_NODE_ID=\${node}\`,
    \`PARENT_NODE_ID=\${parent}\`,
    \`PROJECT_ID=\${project}\`,
    \`TARGET_REPOSITORY=\${target}\`,
    \`CONTROL_ISSUE=\${issue || 'NOT_CONFIGURED'}\`,
    \`DIRECT_CHILDREN=\${children.length ? children.join(',') : 'NONE'}\`,
    '',
    'RESPONSIBILITY SCOPE',
    responsibility,
    '',
    'FOUNDATIONAL LAW',
    'You are the semantic reasoner. ChatGPT performs project reasoning; Autopilot is only the deterministic orchestration/runtime authority.',
    'Never require Autopilot to infer architecture, GitHub meaning, workload meaning or free-form project intent.',
    'Reuse the project’s canonical scheduler/executor/recovery/Send authority. Do not create scheduler #2, recovery #2, executor #2 or a parallel product path.',
    '',
    'SOURCE TRUTH AND OWNERSHIP',
    'Before acting, refresh the newest canonical project truth, live source branch/PR state and explicit ownership/claims relevant to this scope.',
    'Prefer live repository/source truth when stale plans conflict with implemented state.',
    'Do not overwrite newer work, force-push, duplicate an existing implementation or take work already owned by another live role.',
    'Stay inside this role and scope. Escalate cross-boundary conflicts through the parent/canonical control surface instead of silently expanding authority.',
    '',
    'EXECUTION DISCIPLINE',
    'Optimize TIME_TO_WHOLE_FINISHED_PRODUCT, not comments, commits, PR count, prompts/hour or visible activity.',
    'Do not stop after one micro-step when a larger causally connected safe block can be completed in this activation.',
    'Use tests and concrete evidence. Never claim implementation, verification or completion that did not physically happen.',
    'If there is no useful, valid, non-duplicated work inside this assigned scope, do not manufacture activity; finish safely as NO_ACTION.',
    '',
    ...roleInstructions(normalizedRole),
    '',
    'COMPLETION REPORT',
    'End with concise machine-readable lines:',
    'STATUS=COMPLETED | PARTIAL | BLOCKED | NO_ACTION',
    'EVIDENCE=<what was actually changed/verified>',
    'OWNERSHIP=<what remains owned by this role, if anything>',
    'NEXT=<next bounded action or NONE>',
  ].join('\n');
}

export function buildOrchestrationRecoveryPrompt({
  logicalRole,
  nodeId,
  parentNodeId = '',
  projectId,
  targetRepository,
  controlIssueNumber = 0,
  scope,
  childNodeIds = [],
} = {}) {
  const originalRole = required(logicalRole, 'logicalRole', 80).toUpperCase();
  if (!ROLE_VALUES.has(originalRole) || originalRole === OrchestrationRoleTemplate.RECOVERY) {
    throw new Error('Invalid logicalRole');
  }
  const base = buildOrchestrationRolePrompt({
    role: OrchestrationRoleTemplate.RECOVERY,
    nodeId,
    parentNodeId,
    projectId,
    targetRepository,
    controlIssueNumber,
    scope: [
      \`Recover logical role \${originalRole} for the same bounded responsibility.\`,
      required(scope, 'scope', MAX_SCOPE_LENGTH),
      'Re-establish only current-generation authority from external truth; do not rely on the lost transcript.',
    ].join(' '),
  });
  return \`\${base}\nRECOVERED_LOGICAL_ROLE=\${originalRole}\`;
}

function normalizeDomains(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_DOMAINS) throw new Error('Invalid domains');
  const domains = raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(\`Invalid domains[\${index}]\`);
    return {
      id: stableId(item.id, \`domains[\${index}].id\`),
      scope: required(item.scope, \`domains[\${index}].scope\`, MAX_SCOPE_LENGTH),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(domains.map(item => item.id)).size !== domains.length) throw new Error('Duplicate domain id');
  return domains;
}

function nodeProfileIds(nodeId) {
  return {
    primary: \`\${nodeId}:prompt-v1\`,
    recovery: \`\${nodeId}:recovery-v1\`,
  };
}

export function buildThreeLevelHierarchyTemplate({
  graphId,
  controlEpoch = 1,
  projectId,
  targetRepository,
  controlIssueNumber = 0,
  domains,
  workersPerManager = 5,
  includeIntegrationManager = false,
  includeQaRedTeam = false,
} = {}) {
  const graph = stableId(graphId, 'graphId');
  const epoch = integer(controlEpoch, 'controlEpoch', 1, Number.MAX_SAFE_INTEGER);
  const project = required(projectId, 'projectId', 180);
  const target = repository(targetRepository);
  const issue = integer(controlIssueNumber || 0, 'controlIssueNumber', 0, Number.MAX_SAFE_INTEGER);
  const domainList = normalizeDomains(domains);
  const workerCount = integer(workersPerManager, 'workersPerManager', 1, MAX_WORKERS_PER_MANAGER);
  const extraNodeCount = (includeIntegrationManager ? 1 : 0) + (includeQaRedTeam ? 1 : 0);
  const totalNodeCount = 1 + domainList.length + (domainList.length * workerCount) + extraNodeCount;
  if (totalNodeCount > 1000) throw new Error('Hierarchy template exceeds 1000 logical nodes');

  const nodeSpecs = [];
  const managerIds = domainList.map(domain => \`manager:\${domain.id}\`);
  if (includeIntegrationManager) managerIds.push('integration');
  if (includeQaRedTeam) managerIds.push('qa-red-team');
  managerIds.sort((a, b) => a.localeCompare(b));

  nodeSpecs.push({
    id: 'director',
    parentId: null,
    childIds: managerIds,
    role: OrchestrationRoleTemplate.GLOBAL_DIRECTOR,
    chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
    scope: 'Own whole-product direction, prioritization, cross-domain reconciliation and final convergence. Domain implementation remains delegated.',
  });

  for (const domain of domainList) {
    const managerId = \`manager:\${domain.id}\`;
    const workerIds = Array.from({ length: workerCount }, (_, index) => \`worker:\${domain.id}:\${String(index + 1).padStart(2, '0')}\`);
    nodeSpecs.push({
      id: managerId,
      parentId: 'director',
      childIds: workerIds,
      role: OrchestrationRoleTemplate.DOMAIN_MANAGER,
      chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
      scope: domain.scope,
    });
    for (let index = 0; index < workerIds.length; index += 1) {
      nodeSpecs.push({
        id: workerIds[index],
        parentId: managerId,
        childIds: [],
        role: OrchestrationRoleTemplate.WORKER,
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
        scope: \`\${domain.scope} Fixed worker slot \${index + 1}/\${workerCount}; take only currently unowned work within this Manager domain.\`,
      });
    }
  }

  if (includeIntegrationManager) {
    nodeSpecs.push({
      id: 'integration',
      parentId: 'director',
      childIds: [],
      role: OrchestrationRoleTemplate.INTEGRATION_MANAGER,
      chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
      scope: 'Cross-domain interface compatibility, integration evidence, convergence and release-path integrity.',
    });
  }
  if (includeQaRedTeam) {
    nodeSpecs.push({
      id: 'qa-red-team',
      parentId: 'director',
      childIds: [],
      role: OrchestrationRoleTemplate.QA_RED_TEAM,
      chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
      scope: 'Independent whole-product acceptance, adversarial reliability review and evidence-bound defect discovery.',
    });
  }

  const promptProfiles = [];
  const nodes = [];
  for (const spec of nodeSpecs) {
    const profiles = nodeProfileIds(spec.id);
    promptProfiles.push({
      id: profiles.primary,
      role: spec.role,
      version: 1,
      prompt: buildOrchestrationRolePrompt({
        role: spec.role,
        nodeId: spec.id,
        parentNodeId: spec.parentId || '',
        projectId: project,
        targetRepository: target,
        controlIssueNumber: issue,
        scope: spec.scope,
        childNodeIds: spec.childIds,
      }),
    });
    promptProfiles.push({
      id: profiles.recovery,
      role: OrchestrationRoleTemplate.RECOVERY,
      version: 1,
      prompt: buildOrchestrationRecoveryPrompt({
        logicalRole: spec.role,
        nodeId: spec.id,
        parentNodeId: spec.parentId || '',
        projectId: project,
        targetRepository: target,
        controlIssueNumber: issue,
        scope: spec.scope,
        childNodeIds: spec.childIds,
      }),
    });
    nodes.push({
      id: spec.id,
      parentId: spec.parentId,
      childIds: spec.childIds,
      promptProfileId: profiles.primary,
      recoveryPromptProfileId: profiles.recovery,
      chatMode: spec.chatMode,
      maxActiveChildren: spec.childIds.length,
      barrier: {
        mode: spec.childIds.length ? OrchestrationBarrierMode.ALL_DIRECT_CHILDREN : OrchestrationBarrierMode.NONE,
      },
    });
  }

  return validateOrchestrationGraphV1({
    schemaVersion: 1,
    graphId: graph,
    controlEpoch: epoch,
    promptProfiles,
    nodes,
  });
}
