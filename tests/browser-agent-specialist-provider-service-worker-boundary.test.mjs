import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/background/service-worker.js', import.meta.url),
  'utf8',
);

test('provider config read and probe commands are read-only while put/clear remain mutation-only', () => {
  const start = source.indexOf('const READ_ONLY_UI_COMMANDS = new Set([');
  const end = source.indexOf(']);', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);

  assert.match(block, /'LIST_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIGS'/);
  assert.match(block, /'GET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.match(block, /'PROBE_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.doesNotMatch(block, /'PUT_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.doesNotMatch(block, /'CLEAR_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.doesNotMatch(block, /'EXECUTE_BROWSER_AGENT_SPECIALIST_PROVIDER'/);
});

test('provider probe is harmless, owner-config-bound, and cannot dispatch Specialist work', () => {
  assert.match(source, /OpenHandsCodingSpecialistClient/);
  assert.match(source, /probeOpenHandsSpecialistProviderConfigV1/);
  const probeBranch = source.match(
    /} else if \(message\.command === 'PROBE_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'\) \{([\s\S]*?)\n  } else if \(message\.command === 'PUT_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'\) \{/,
  );
  assert.ok(probeBranch, 'probe command branch must remain structurally identifiable');
  assert.match(probeBranch[1], /browserAgent\.getSpecialistProviderConfig\(providerId\)/);
  assert.match(probeBranch[1], /probeOpenHandsSpecialistProviderConfigV1/);
  assert.match(probeBranch[1], /config changed during readiness probe/);
  assert.doesNotMatch(
    probeBranch[1],
    /claimSpecialistHandoffs|executeClaimedSpecialistProvider|openHandsSpecialistClient\.execute|completeSpecialistHandoff/,
  );
});

test('provider execution command uses the injected trusted OpenHands client and secure service-worker identity', () => {
  assert.match(
    source,
    /specialistProviderClients:\s*new Map\(\[\[OPENHANDS_CODING_PROVIDER_ID, openHandsSpecialistClient\]\]\)/,
  );
  const branch = source.match(
    /} else if \(message\.command === 'EXECUTE_BROWSER_AGENT_SPECIALIST_PROVIDER'\) \{([\s\S]*?)\n  } else if \(message\.command === 'CREATE_BROWSER_AGENT_JOB_FROM_DEFINITION'\) \{/,
  );
  assert.ok(branch, 'Specialist provider execution command must remain structurally identifiable');
  assert.match(branch[1], /globalThis\.crypto\?\.randomUUID/);
  assert.match(branch[1], /delete execution\.conversationId/);
  assert.match(branch[1], /browserAgent\.executeClaimedSpecialistProvider/);
  assert.doesNotMatch(branch[1], /completeSpecialistHandoff/);
});

test('Specialist mutation commands strip caller time authority before BrowserAgent delegation', () => {
  assert.match(
    source,
    /PREPARE_BROWSER_AGENT_DEFINITION_SPECIALIST_DELEGATION'[\s\S]*?const delegation = structuredClone[\s\S]*?delete delegation\.at[\s\S]*?prepareDefinitionSpecialistDelegation/,
  );
  assert.match(
    source,
    /PREPARE_BROWSER_AGENT_SPECIALIST_HANDOFF'[\s\S]*?const handoff = structuredClone[\s\S]*?delete handoff\.at[\s\S]*?prepareSpecialistHandoff/,
  );
  assert.match(
    source,
    /CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS'[\s\S]*?const claim = structuredClone[\s\S]*?delete claim\.at[\s\S]*?claimSpecialistHandoffs/,
  );
});

test('Specialist CLAIM and EXECUTE consume the injected trusted readiness resolver', () => {
  const claimBranch = source.match(
    /} else if \(message\.command === 'CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS'\) \{([\s\S]*?)\n  } else if \(message\.command === 'AUTHORIZE_BROWSER_AGENT_SPECIALIST_SAFE_RETRY'\) \{/,
  );
  assert.ok(claimBranch, 'Specialist claim branch must remain structurally identifiable');
  assert.match(claimBranch[1], /specialistProviderReadinessResolver/);
  assert.doesNotMatch(claimBranch[1], /message\.payload\?\.readiness|message\.payload\.readiness/);

  const executeBranch = source.match(
    /} else if \(message\.command === 'EXECUTE_BROWSER_AGENT_SPECIALIST_PROVIDER'\) \{([\s\S]*?)\n  } else if \(message\.command === 'CREATE_BROWSER_AGENT_JOB_FROM_DEFINITION'\) \{/,
  );
  assert.ok(executeBranch, 'Specialist provider execution branch must remain structurally identifiable');
  assert.match(executeBranch[1], /specialistProviderReadinessResolver/);
  assert.doesNotMatch(executeBranch[1], /message\.payload\?\.readiness|message\.payload\.readiness/);
});
