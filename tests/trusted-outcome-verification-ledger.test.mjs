import test from 'node:test';
import assert from 'node:assert/strict';

import { StorageRepository } from '../src/core/storage.js';
import { createEmptyState, validateState, STORAGE_KEY } from '../src/core/schema.js';
import { createOutcomeContractV1 } from '../src/core/outcome-contract.js';
import {
  OutcomeVerificationVerdict,
  adjudicateOutcomeVerificationV1,
} from '../src/core/outcome-verification-bridge.js';
import {
  appendTrustedOutcomeVerificationRecordV1,
  createTrustedOutcomeVerificationLedgerV1,
  normalizeTrustedOutcomeVerificationLedgerV1,
  resolveTrustedOutcomeVerificationRecordV1,
} from '../src/core/trusted-outcome-verification-ledger.js';

const CREATED_AT='2026-09-29T07:00:00.000Z';
const VERIFIED_AT='2026-09-29T07:05:00.000Z';
const RECORDED_AT='2026-09-29T07:06:00.000Z';
const EVALUATED_AT='2026-09-29T07:10:00.000Z';
const VALID_THROUGH='2026-09-29T08:00:00.000Z';

function fakeChrome(initial={}){
  const data=structuredClone(initial);
  return {
    data,
    storage:{local:{
      async get(key){
        return {[key]:data[key]===undefined?undefined:structuredClone(data[key])};
      },
      async set(value){
        for(const [key,entry] of Object.entries(value)) data[key]=structuredClone(entry);
      },
    }},
  };
}

function contract(){
  return createOutcomeContractV1({
    contractId:'outcome-1',
    projectId:'project-1',
    desiredResult:'Ship verified product evidence.',
    completionCriteria:[
      {
        criterionId:'criterion-artifact',
        description:'Artifact exists.',
        observable:'Canonical artifact evidence exists.',
        requiredEvidenceKinds:['ARTIFACT'],
      },
      {
        criterionId:'criterion-tests',
        description:'Tests pass.',
        observable:'Canonical test evidence passes.',
        requiredEvidenceKinds:['TEST'],
      },
    ],
    constraints:[],
    sourceTruth:[{
      sourceId:'source-project-spec',
      location:'project://project-1/spec',
      revisionId:'spec-r1',
      purpose:'Canonical project requirements used by the Outcome contract.',
    }],
    allowedAuthority:[],
    budgetBoundaries:{
      maxModelCalls:4,
      maxRuntimeSeconds:300,
      maxCostUsdMicros:0,
      maxConcurrency:1,
      enforcementAuthority:'NONE',
    },
    deliverables:[{
      deliverableId:'deliverable-1',
      kind:'CODE',
      description:'Verified artifact.',
      criterionIds:['criterion-artifact','criterion-tests'],
    }],
    verifierPlan:{
      planId:'verifier-plan-1',
      actorId:'actor-1',
      verifierId:'verifier-1',
      criterionIds:['criterion-artifact','criterion-tests'],
      requiredEvidenceArtifactCount:1,
      independent:true,
      verificationAuthority:'EXTERNAL_REQUIRED',
    },
    triggerRefs:[],
    createdAt:CREATED_AT,
  });
}

function criterionFor(value,id){
  const criterion=value.completionCriteria.find(item=>item.criterionId===id);
  return {
    criterionId:criterion.criterionId,
    description:criterion.description,
    observable:criterion.observable,
    requiredEvidenceKinds:[...criterion.requiredEvidenceKinds],
  };
}

function artifact(id,kind){
  return {
    schemaVersion:1,
    artifactId:id,
    kind,
    uri:'artifact://'+id,
    mediaType:'application/json',
    sha256:(kind==='TEST'?'b':'a').repeat(64),
    sizeBytes:32,
    createdAt:'2026-09-29T07:04:00.000Z',
    producerInvocationId:'verifier-invocation',
    sensitive:false,
  };
}

function trustedRecord(outcomeContract,criterionId,{recordId,verificationId}={}){
  const short=criterionId==='criterion-tests'?'tests':'artifact';
  const evidenceId='evidence-'+short;
  const verification={
    schemaVersion:1,
    verificationId:verificationId||'verification-'+short,
    invocationId:'verification-invocation-'+short,
    observationId:'observation-'+short,
    status:'VERIFIED',
    reasonCode:'PASS',
    summary:'Independent verification passed.',
    evidenceArtifactIds:[evidenceId],
    verifiedAt:VERIFIED_AT,
    verifierId:'verifier-1',
    verificationAuthorityId:'verification-authority-1',
  };
  return {
    schemaVersion:1,
    recordId:recordId||'trusted-record-'+short,
    contractId:outcomeContract.contractId,
    contractRevision:outcomeContract.revision,
    verifierPlanId:outcomeContract.verifierPlan.planId,
    criterion:criterionFor(outcomeContract,criterionId),
    verifierId:'verifier-1',
    verificationAuthorityId:'verification-authority-1',
    verification,
    evidenceArtifacts:[artifact(
      evidenceId,
      criterionId==='criterion-tests'?'TEST':'ARTIFACT',
    )],
    recordedAt:RECORDED_AT,
    validThrough:VALID_THROUGH,
  };
}

function lookupFor(record){
  return {
    contractId:record.contractId,
    contractRevision:record.contractRevision,
    verifierPlanId:record.verifierPlanId,
    criterionId:record.criterion.criterionId,
    verificationId:record.verification.verificationId,
  };
}

test('new canonical state initializes an empty trusted Outcome verification ledger',()=>{
  const state=createEmptyState(1);
  assert.deepEqual(state.trustedOutcomeVerificationLedger,{
    schemaVersion:1,
    revision:0,
    records:[],
  });
  assert.equal(validateState(state),state);
});

test('legacy schema-v2 state without trusted Outcome ledger remains valid',()=>{
  const state=createEmptyState(1);
  delete state.trustedOutcomeVerificationLedger;
  assert.equal(validateState(state),state);
  assert.equal(
    resolveTrustedOutcomeVerificationRecordV1(state,{
      contractId:'outcome-1',
      contractRevision:1,
      verifierPlanId:'verifier-plan-1',
      criterionId:'criterion-artifact',
      verificationId:'verification-missing',
    }),
    null,
  );
});

test('append and exact resolver round-trip canonical trusted Outcome records',()=>{
  const state=createEmptyState(1);
  const outcomeContract=contract();
  const first=trustedRecord(outcomeContract,'criterion-artifact');
  const appended=appendTrustedOutcomeVerificationRecordV1(state,first);

  assert.equal(appended.recordId,'trusted-record-artifact');
  assert.equal(state.trustedOutcomeVerificationLedger.revision,1);
  assert.equal(state.trustedOutcomeVerificationLedger.records.length,1);

  const resolved=resolveTrustedOutcomeVerificationRecordV1(state,lookupFor(first));
  assert.deepEqual(resolved,appended);
  assert.equal(Object.isFrozen(resolved),true);
  assert.equal(Object.isFrozen(resolved.verification),true);
  assert.equal(Object.isFrozen(resolved.evidenceArtifacts),true);
});

test('exact duplicate append is idempotent without advancing durable revision',()=>{
  const state=createEmptyState(1);
  const outcomeContract=contract();
  const record=trustedRecord(outcomeContract,'criterion-artifact');

  const first=appendTrustedOutcomeVerificationRecordV1(state,record);
  const before=structuredClone(state.trustedOutcomeVerificationLedger);
  const replay=appendTrustedOutcomeVerificationRecordV1(state,structuredClone(record));

  assert.deepEqual(replay,first);
  assert.deepEqual(state.trustedOutcomeVerificationLedger,before);
  assert.equal(state.trustedOutcomeVerificationLedger.revision,1);
});

test('recordId and verificationId cannot be rebound to different semantics',()=>{
  const state=createEmptyState(1);
  const outcomeContract=contract();
  const first=trustedRecord(outcomeContract,'criterion-artifact');
  appendTrustedOutcomeVerificationRecordV1(state,first);

  const recordRebound=trustedRecord(outcomeContract,'criterion-tests',{
    recordId:first.recordId,
    verificationId:'verification-other',
  });
  assert.throws(
    ()=>appendTrustedOutcomeVerificationRecordV1(state,recordRebound),
    /recordId cannot be rebound/u,
  );

  const verificationRebound=trustedRecord(outcomeContract,'criterion-tests',{
    recordId:'trusted-record-other',
    verificationId:first.verification.verificationId,
  });
  assert.throws(
    ()=>appendTrustedOutcomeVerificationRecordV1(state,verificationRebound),
    /verificationId cannot be rebound/u,
  );
  assert.equal(state.trustedOutcomeVerificationLedger.revision,1);
});

test('known verificationId must match exact contract, plan and criterion lookup identity',()=>{
  const state=createEmptyState(1);
  const outcomeContract=contract();
  const record=trustedRecord(outcomeContract,'criterion-artifact');
  appendTrustedOutcomeVerificationRecordV1(state,record);

  for(const changed of [
    {contractId:'outcome-other'},
    {contractRevision:2},
    {verifierPlanId:'verifier-plan-other'},
    {criterionId:'criterion-tests'},
  ]){
    assert.throws(
      ()=>resolveTrustedOutcomeVerificationRecordV1(state,{
        ...lookupFor(record),
        ...changed,
      }),
      /lookup binding mismatch/u,
    );
  }
});

test('ledger restart normalization rejects revision drift and duplicate identities',()=>{
  const state=createEmptyState(1);
  const outcomeContract=contract();
  const record=trustedRecord(outcomeContract,'criterion-artifact');
  appendTrustedOutcomeVerificationRecordV1(state,record);

  const revisionDrift=structuredClone(state.trustedOutcomeVerificationLedger);
  revisionDrift.revision=0;
  assert.throws(
    ()=>normalizeTrustedOutcomeVerificationLedgerV1(revisionDrift),
    /revision must equal append-only record count/u,
  );

  const duplicateRecord=structuredClone(state.trustedOutcomeVerificationLedger);
  duplicateRecord.records.push(structuredClone(record));
  duplicateRecord.revision=2;
  assert.throws(
    ()=>normalizeTrustedOutcomeVerificationLedgerV1(duplicateRecord),
    /duplicate recordId/u,
  );

  const duplicateVerification=structuredClone(state.trustedOutcomeVerificationLedger);
  const second=trustedRecord(outcomeContract,'criterion-tests',{
    recordId:'trusted-record-tests-other',
    verificationId:record.verification.verificationId,
  });
  duplicateVerification.records.push(second);
  duplicateVerification.revision=2;
  assert.throws(
    ()=>normalizeTrustedOutcomeVerificationLedgerV1(duplicateVerification),
    /rebound verificationId/u,
  );
});

test('present undefined ledger and exotic state prototypes fail closed',()=>{
  const undefinedLedger=createEmptyState(1);
  undefinedLedger.trustedOutcomeVerificationLedger=undefined;
  assert.throws(
    ()=>validateState(undefinedLedger),
    /cannot be undefined when present/u,
  );

  const exotic=Object.create({trustedOutcomeVerificationLedger:createTrustedOutcomeVerificationLedgerV1()});
  assert.throws(
    ()=>resolveTrustedOutcomeVerificationRecordV1(exotic,{
      contractId:'outcome-1',
      contractRevision:1,
      verifierPlanId:'verifier-plan-1',
      criterionId:'criterion-artifact',
      verificationId:'verification-artifact',
    }),
    /state must be a plain object/u,
  );
});

test('hostile state ledger accessor is rejected without executing getters',()=>{
  let hits=0;
  const state={};
  Object.defineProperty(state,'trustedOutcomeVerificationLedger',{
    enumerable:true,
    get(){
      hits+=1;
      return createTrustedOutcomeVerificationLedgerV1();
    },
  });
  assert.throws(
    ()=>resolveTrustedOutcomeVerificationRecordV1(state,{
      contractId:'outcome-1',
      contractRevision:1,
      verifierPlanId:'verifier-plan-1',
      criterionId:'criterion-artifact',
      verificationId:'verification-artifact',
    }),
    /enumerable own data property/u,
  );
  assert.equal(hits,0);
});

test('hostile lookup and persisted arrays are rejected without executing getters',()=>{
  const state=createEmptyState(1);
  const outcomeContract=contract();
  const record=trustedRecord(outcomeContract,'criterion-artifact');
  appendTrustedOutcomeVerificationRecordV1(state,record);

  let hits=0;
  const lookup={
    contractId:record.contractId,
    contractRevision:record.contractRevision,
    verifierPlanId:record.verifierPlanId,
    criterionId:record.criterion.criterionId,
  };
  Object.defineProperty(lookup,'verificationId',{
    enumerable:true,
    get(){
      hits+=1;
      return record.verification.verificationId;
    },
  });
  assert.throws(
    ()=>resolveTrustedOutcomeVerificationRecordV1(state,lookup),
    /enumerable own data properties/u,
  );
  assert.equal(hits,0);

  const hostile=structuredClone(state.trustedOutcomeVerificationLedger);
  Object.defineProperty(hostile.records,'0',{
    enumerable:true,
    configurable:true,
    get(){
      hits+=1;
      return record;
    },
  });
  assert.throws(
    ()=>normalizeTrustedOutcomeVerificationLedgerV1(hostile),
    /dense data array/u,
  );
  assert.equal(hits,0);
});

test('StorageRepository restart accepts canonical ledger and rejects corrupted persisted ledger',async()=>{
  const chrome=fakeChrome();
  const repo=new StorageRepository(chrome);
  await repo.update(state=>{
    const outcomeContract=contract();
    appendTrustedOutcomeVerificationRecordV1(
      state,
      trustedRecord(outcomeContract,'criterion-artifact'),
    );
    return state;
  });

  const restarted=new StorageRepository(chrome);
  const loaded=await restarted.load();
  assert.equal(loaded.trustedOutcomeVerificationLedger.revision,1);

  const corrupt=structuredClone(chrome.data[STORAGE_KEY]);
  corrupt.trustedOutcomeVerificationLedger.revision=9;
  const corruptedRepo=new StorageRepository(fakeChrome({[STORAGE_KEY]:corrupt}));
  await assert.rejects(
    corruptedRepo.load(),
    /revision must equal append-only record count/u,
  );
});

test('OutcomeVerificationBridge consumes ledger resolver without widening authority',async()=>{
  const state=createEmptyState(1);
  const outcomeContract=contract();
  const artifactRecord=trustedRecord(outcomeContract,'criterion-artifact');
  const testRecord=trustedRecord(outcomeContract,'criterion-tests');
  appendTrustedOutcomeVerificationRecordV1(state,artifactRecord);
  appendTrustedOutcomeVerificationRecordV1(state,testRecord);

  const result=await adjudicateOutcomeVerificationV1({
    contract:outcomeContract,
    criterionVerifications:[
      {criterionId:'criterion-tests',verificationId:'verification-tests'},
      {criterionId:'criterion-artifact',verificationId:'verification-artifact'},
    ],
    evaluatedAt:EVALUATED_AT,
  },{
    resolveTrustedOutcomeContract:async lookup=>(
      lookup.contractId===outcomeContract.contractId
      && lookup.contractRevision===outcomeContract.revision
        ? outcomeContract
        : null
    ),
    resolveTrustedVerificationRecord:async lookup=>(
      resolveTrustedOutcomeVerificationRecordV1(state,lookup)
    ),
  });

  assert.equal(result.verdict,OutcomeVerificationVerdict.VERIFIED);
  assert.equal(result.completionEvidenceReady,true);
  assert.equal(result.completionAuthorized,false);
  assert.equal(result.executionAuthorized,false);
  assert.equal(result.verificationAuthorityMinted,false);
  assert.equal(result.requiresCanonicalCompletionCommit,true);
});

test('ledger factory and normalization return deeply immutable canonical records',()=>{
  const empty=createTrustedOutcomeVerificationLedgerV1();
  assert.equal(Object.isFrozen(empty),true);
  assert.equal(Object.isFrozen(empty.records),true);

  const state=createEmptyState(1);
  const outcomeContract=contract();
  appendTrustedOutcomeVerificationRecordV1(
    state,
    trustedRecord(outcomeContract,'criterion-artifact'),
  );
  const canonical=normalizeTrustedOutcomeVerificationLedgerV1(
    state.trustedOutcomeVerificationLedger,
  );
  assert.equal(Object.isFrozen(canonical),true);
  assert.equal(Object.isFrozen(canonical.records),true);
  assert.equal(Object.isFrozen(canonical.records[0]),true);
  assert.equal(Object.isFrozen(canonical.records[0].criterion),true);
});
