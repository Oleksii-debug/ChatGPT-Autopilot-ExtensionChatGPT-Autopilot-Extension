import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessA2ADelegationV1,
  assessA2ARemoteCardDriftV1,
  normalizeA2ADelegationRequestV1,
  normalizeA2ARemoteAdmissionRefV1,
  normalizeA2ARemoteAgentCardRefV1,
} from '../src/core/a2a-interop-contract.js';

const T0 = '2026-09-25T00:00:00.000Z';
const T1 = '2026-09-25T00:10:00.000Z';
const T2 = '2026-09-25T00:20:00.000Z';
const sha = char => char.repeat(64);

function iface(overrides = {}) {
  return {
    url: 'https://agent.example.com/a2a/v1',
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0',
    tenant: null,
    ...overrides,
  };
}

function securityRequirement(scopeIds = ['agent.connect'], schemeId = 'oauth.main') {
  return {
    schemes: [{ schemeId, scopeIds }],
  };
}

function card(overrides = {}) {
  return {
    schemaVersion: 1,
    remoteAgentId: 'remote.research',
    cardUrl: 'https://agent.example.com/.well-known/agent-card.json',
    cardSha256: sha('a'),
    name: 'Research Agent',
    supportedInterfaces: [iface()],
    skillIds: ['research.deep', 'research.quick'],
    securitySchemeIds: ['oauth.main'],
    securityRequirements: [securityRequirement(['agent.connect'])],
    skillSecurityRequirements: [{
      skillId: 'research.deep',
      securityRequirements: [securityRequirement(['research.deep'])],
    }],
    signatureEvidenceArtifactIds: ['artifact.card-signature'],
    discoveredAt: T0,
    ...overrides,
  };
}

function admission(overrides = {}) {
  return {
    schemaVersion: 1,
    admissionRefId: 'admission.remote.research',
    remoteAgentId: 'remote.research',
    cardSha256: sha('a'),
    interfaceUrl: 'https://agent.example.com/a2a/v1',
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0',
    tenant: null,
    allowedSkillIds: ['research.deep'],
    allowedCapabilityIds: ['artifact.read', 'research.query'],
    allowedSecuritySchemeIds: ['oauth.main'],
    decidedAt: T0,
    expiresAt: null,
    ...overrides,
  };
}

function delegation(overrides = {}) {
  return {
    schemaVersion: 1,
    delegationId: 'delegation-1',
    localAgentId: 'agent.local.research',
    localTaskId: 'task.local-1',
    effectId: 'effect.a2a-send-1',
    remoteAgentId: 'remote.research',
    requestedSkillId: 'research.deep',
    requestedCapabilityIds: ['artifact.read', 'research.query'],
    declaredSecurityRequirement: securityRequirement(['agent.connect', 'research.deep']),
    taskEnvelopeArtifactId: 'artifact.task-envelope',
    inputArtifactIds: ['artifact.source-1'],
    policyDecisionId: 'policy-decision-1',
    createdAt: T1,
    ...overrides,
  };
}

test('A2A card reference preserves ordered interfaces but never grants authority', () => {
  const input = card({
    supportedInterfaces: [
      iface({ protocolBinding: 'JSONRPC' }),
      iface({ protocolBinding: 'HTTP+JSON' }),
    ],
  });
  const normalized = normalizeA2ARemoteAgentCardRefV1(input);
  assert.deepEqual(
    normalized.supportedInterfaces.map(item => item.protocolBinding),
    ['JSONRPC', 'HTTP+JSON'],
  );
  assert.equal(normalized.advisoryOnly, true);
  assert.equal(normalized.executionAuthorized, false);
  assert.equal(normalized.credentialMaterialPresent, false);
  assert(Object.isFrozen(normalized));
});

test('same A2A URL may expose multiple bindings but exact duplicate tuples fail closed', () => {
  assert.doesNotThrow(() => normalizeA2ARemoteAgentCardRefV1(card({
    supportedInterfaces: [
      iface({ protocolBinding: 'JSONRPC' }),
      iface({ protocolBinding: 'HTTP+JSON' }),
    ],
  })));

  const duplicate = card({ supportedInterfaces: [iface(), iface()] });
  assert.throws(
    () => normalizeA2ARemoteAgentCardRefV1(duplicate),
    /duplicate interface binding/,
  );
});

test('A2A transport endpoints follow binding-specific secure production forms', () => {
  assert.throws(
    () => normalizeA2ARemoteAgentCardRefV1(card({ cardUrl: 'http://agent.example.com/card.json' })),
    /HTTPS URL/,
  );
  assert.throws(
    () => normalizeA2ARemoteAgentCardRefV1(card({
      supportedInterfaces: [iface({ url: 'http://agent.example.com/a2a' })],
    })),
    /HTTPS URL/,
  );
  assert.throws(
    () => normalizeA2ARemoteAgentCardRefV1(card({
      supportedInterfaces: [iface({ protocolBinding: 'CUSTOM' })],
    })),
    /protocolBinding is invalid/,
  );

  const grpcCard = card({
    supportedInterfaces: [iface({
      url: 'grpc.example.com:443',
      protocolBinding: 'GRPC',
    })],
  });
  const normalizedGrpc = normalizeA2ARemoteAgentCardRefV1(grpcCard);
  assert.equal(normalizedGrpc.supportedInterfaces[0].url, 'grpc.example.com:443');
  const grpcAssessment = assessA2ADelegationV1({
    card: grpcCard,
    admission: admission({
      interfaceUrl: 'grpc.example.com:443',
      protocolBinding: 'GRPC',
    }),
    delegation: delegation(),
  });
  assert.equal(grpcAssessment.status, 'READY_FOR_POLICY');
  assert.throws(
    () => normalizeA2ARemoteAgentCardRefV1(card({
      supportedInterfaces: [iface({ url: 'grpc.example.com', protocolBinding: 'GRPC' })],
    })),
    /gRPC host:port/,
  );

  assert.doesNotThrow(() => normalizeA2ARemoteAgentCardRefV1(card({
    supportedInterfaces: [iface({
      url: 'wss://agent.example.com/a2a',
      protocolBinding: 'https://example.com/bindings/websocket/v1',
    })],
  })));
});

test('descriptor boundaries reject getters, hidden fields, symbols and sparse arrays without reads', () => {
  let reads = 0;
  const getter = card();
  Object.defineProperty(getter, 'remoteAgentId', {
    enumerable: true,
    get() { reads += 1; return 'remote.evil'; },
  });
  assert.throws(() => normalizeA2ARemoteAgentCardRefV1(getter), /enumerable own data property/);
  assert.equal(reads, 0);

  const hidden = card();
  Object.defineProperty(hidden, 'credentialMaterialPresent', {
    enumerable: false,
    value: true,
  });
  assert.throws(() => normalizeA2ARemoteAgentCardRefV1(hidden), /enumerable own data property/);

  const symbol = card();
  symbol[Symbol('token')] = 'secret';
  assert.throws(() => normalizeA2ARemoteAgentCardRefV1(symbol), /symbol fields/);

  let arrayReads = 0;
  const proxiedArray = card();
  proxiedArray.skillIds = new Proxy(['research.deep', 'research.quick'], {
    get(target, property, receiver) {
      arrayReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const normalizedProxyArray = normalizeA2ARemoteAgentCardRefV1(proxiedArray);
  assert.equal(arrayReads, 0);
  assert.deepEqual(normalizedProxyArray.skillIds, ['research.deep', 'research.quick']);

  const sparse = card();
  sparse.skillIds = new Array(1);
  assert.throws(() => normalizeA2ARemoteAgentCardRefV1(sparse), /enumerable own data item/);
});

test('caller cannot inject credential material or execution authority', () => {
  assert.throws(
    () => normalizeA2ARemoteAgentCardRefV1(card({ credentialMaterialPresent: true })),
    /cannot contain credential material/,
  );
  assert.throws(
    () => normalizeA2ARemoteAdmissionRefV1(admission({ executionAuthorized: true })),
    /cannot authorize execution/,
  );
  assert.throws(
    () => normalizeA2ARemoteAdmissionRefV1(admission({ credentialUseAuthorized: true })),
    /cannot authorize credential use/,
  );
  assert.throws(
    () => normalizeA2ADelegationRequestV1(delegation({ credentialMaterialPresent: true })),
    /cannot contain credential material/,
  );

  const tokenLeak = delegation();
  tokenLeak.bearerToken = 'secret';
  assert.throws(() => normalizeA2ADelegationRequestV1(tokenLeak), /unknown field/);
});

test('exact admitted card, interface, skill, security and capability set reaches policy gate only', () => {
  const result = assessA2ADelegationV1({
    card: card(),
    admission: admission(),
    delegation: delegation(),
  });
  assert.equal(result.status, 'READY_FOR_POLICY');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.selectedInterface.protocolBinding, 'HTTP+JSON');
  assert.equal(result.localTaskId, 'task.local-1');
  assert.equal(result.effectId, 'effect.a2a-send-1');
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.credentialUseAuthorized, false);
  assert.equal(result.requiresPolicyDecision, true);
  assert.equal(result.credentialsOutOfBand, true);
  assert.equal(result.remoteTaskCreated, false);
  assert.deepEqual(result.declaredSecuritySchemeIds, ['oauth.main']);
  assert.deepEqual(result.declaredSecurityRequirement.schemes, [{
    schemeId: 'oauth.main',
    scopeIds: ['agent.connect', 'research.deep'],
  }]);
});

test('card digest or selected interface drift blocks delegation before policy evaluation', () => {
  let result = assessA2ADelegationV1({
    card: card({ cardSha256: sha('b') }),
    admission: admission(),
    delegation: delegation(),
  });
  assert.equal(result.status, 'BLOCKED');
  assert(result.reasons.includes('CARD_DIGEST_DRIFT'));

  result = assessA2ADelegationV1({
    card: card(),
    admission: admission({ protocolBinding: 'JSONRPC' }),
    delegation: delegation(),
  });
  assert.equal(result.status, 'BLOCKED');
  assert(result.reasons.includes('INTERFACE_NOT_IN_CARD'));
});

test('stale admission sets outside the exact card fail closed even when the request itself is valid', () => {
  const result = assessA2ADelegationV1({
    card: card(),
    admission: admission({
      allowedSkillIds: ['research.deep', 'research.removed'],
      allowedSecuritySchemeIds: ['oauth.main', 'mtls.removed'],
    }),
    delegation: delegation(),
  });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.reasons, [
    'ADMISSION_SECURITY_SET_NOT_IN_CARD',
    'ADMISSION_SKILL_SET_NOT_IN_CARD',
  ]);
});

test('unknown or non-admitted skills, capabilities and security schemes fail closed', () => {
  const result = assessA2ADelegationV1({
    card: card(),
    admission: admission(),
    delegation: delegation({
      requestedSkillId: 'research.unlisted',
      requestedCapabilityIds: ['filesystem.write'],
      declaredSecurityRequirement: securityRequirement([], 'mtls.private'),
    }),
  });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.reasons, [
    'AGENT_SECURITY_REQUIREMENT_UNSATISFIED',
    'CAPABILITY_NOT_ADMITTED',
    'SECURITY_SCHEME_NOT_ADMITTED',
    'SECURITY_SCHEME_NOT_IN_CARD',
    'SKILL_NOT_ADMITTED',
    'SKILL_NOT_IN_CARD',
  ]);
});

test('agent and skill security requirements are enforced as OR-of-AND scheme/scope sets', () => {
  const empty = assessA2ADelegationV1({
    card: card(),
    admission: admission(),
    delegation: delegation({
      declaredSecurityRequirement: { schemes: [] },
    }),
  });
  assert.deepEqual(empty.reasons, [
    'AGENT_SECURITY_REQUIREMENT_UNSATISFIED',
    'SKILL_SECURITY_REQUIREMENT_UNSATISFIED',
  ]);

  const missingSkillScope = assessA2ADelegationV1({
    card: card(),
    admission: admission(),
    delegation: delegation({
      declaredSecurityRequirement: securityRequirement(['agent.connect']),
    }),
  });
  assert.deepEqual(missingSkillScope.reasons, ['SKILL_SECURITY_REQUIREMENT_UNSATISFIED']);

  const alternatives = card({
    securitySchemeIds: ['mtls.main', 'oauth.main'],
    securityRequirements: [
      securityRequirement([], 'mtls.main'),
      securityRequirement(['agent.connect'], 'oauth.main'),
    ],
  });
  const viaOauth = assessA2ADelegationV1({
    card: alternatives,
    admission: admission({ allowedSecuritySchemeIds: ['mtls.main', 'oauth.main'] }),
    delegation: delegation(),
  });
  assert.equal(viaOauth.status, 'READY_FOR_POLICY');

  const unknownScheme = card({
    securityRequirements: [securityRequirement(['agent.connect'], 'scheme.missing')],
  });
  assert.throws(
    () => normalizeA2ARemoteAgentCardRefV1(unknownScheme),
    /unknown security scheme/,
  );

  const unknownSkill = card({
    skillSecurityRequirements: [{
      skillId: 'research.missing',
      securityRequirements: [securityRequirement(['research.deep'])],
    }],
  });
  assert.throws(
    () => normalizeA2ARemoteAgentCardRefV1(unknownSkill),
    /unknown skill/,
  );
});

test('delegation causality and admission expiry are deterministic fail-closed gates', () => {
  let result = assessA2ADelegationV1({
    card: card({ discoveredAt: T1 }),
    admission: admission({ decidedAt: T1 }),
    delegation: delegation({ createdAt: T0 }),
  });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.reasons, [
    'DELEGATION_PREDATES_ADMISSION',
    'DELEGATION_PREDATES_DISCOVERY',
  ]);

  result = assessA2ADelegationV1({
    card: card(),
    admission: admission({ expiresAt: T1 }),
    delegation: delegation({ createdAt: T1 }),
  });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.reasons, ['ADMISSION_EXPIRED']);
});

test('card drift reports exact material changes and observation regression', () => {
  const unchanged = assessA2ARemoteCardDriftV1(card(), structuredClone(card()));
  assert.equal(unchanged.status, 'UNCHANGED');
  assert.deepEqual(unchanged.signals, []);

  const current = card({
    cardSha256: sha('b'),
    skillIds: ['research.deep'],
    securityRequirements: [securityRequirement(['agent.changed'])],
    skillSecurityRequirements: [],
    discoveredAt: '2026-09-24T23:59:59.000Z',
  });
  const drift = assessA2ARemoteCardDriftV1(card(), current);
  assert.equal(drift.status, 'DRIFTED');
  assert.deepEqual(drift.signals, [
    'CARD_DIGEST_CHANGED',
    'SKILLS_CHANGED',
    'SECURITY_REQUIREMENTS_CHANGED',
    'SKILL_SECURITY_REQUIREMENTS_CHANGED',
    'OBSERVATION_REGRESSED',
  ]);
  assert.equal(drift.executionAuthorized, false);
});

test('normalizers are safely composable and output safety flags cannot be upgraded', () => {
  const normalizedCard = normalizeA2ARemoteAgentCardRefV1(card());
  const normalizedAdmission = normalizeA2ARemoteAdmissionRefV1(admission());
  const normalizedDelegation = normalizeA2ADelegationRequestV1(delegation());
  assert.doesNotThrow(() => assessA2ADelegationV1({
    card: normalizedCard,
    admission: normalizedAdmission,
    delegation: normalizedDelegation,
  }));

  const forged = structuredClone(normalizedCard);
  forged.executionAuthorized = true;
  assert.throws(() => normalizeA2ARemoteAgentCardRefV1(forged), /cannot authorize execution/);
});

test('delegation must carry canonical local task and exact-effect identity', () => {
  const missingTask = delegation();
  delete missingTask.localTaskId;
  assert.throws(() => normalizeA2ADelegationRequestV1(missingTask), /localTaskId is invalid/);

  const missingEffect = delegation();
  delete missingEffect.effectId;
  assert.throws(() => normalizeA2ADelegationRequestV1(missingEffect), /effectId is invalid/);
});

test('remote Agent identity mismatch and malformed canonical fields fail closed', () => {
  const result = assessA2ADelegationV1({
    card: card(),
    admission: admission({ remoteAgentId: 'remote.other' }),
    delegation: delegation({ remoteAgentId: 'remote.third' }),
  });
  assert.deepEqual(result.reasons, [
    'ADMISSION_AGENT_MISMATCH',
    'DELEGATION_AGENT_MISMATCH',
  ]);

  const badVersion = card();
  badVersion.schemaVersion = '1';
  assert.throws(() => normalizeA2ARemoteAgentCardRefV1(badVersion), /schemaVersion must be 1/);

  const upperDigest = card({ cardSha256: sha('A') });
  assert.throws(() => normalizeA2ARemoteAgentCardRefV1(upperDigest), /cardSha256 is invalid/);

  const nullProto = Object.assign(Object.create(null), card());
  assert.doesNotThrow(() => normalizeA2ARemoteAgentCardRefV1(nullProto));
});
