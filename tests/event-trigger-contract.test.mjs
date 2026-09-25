import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EventTriggerAdmissionStatus,
  EventTriggerKind,
  createEventTriggerAdmissionV1,
  normalizeEventTriggerDefinitionV1,
  normalizeEventTriggerObservationV1,
} from '../src/core/event-trigger-contract.js';

const T0='2026-09-25T03:00:00.000Z';
const T1='2026-09-25T03:01:00.000Z';
const T2='2026-09-25T03:02:00.000Z';
const SHA='a'.repeat(64);
function trigger(overrides={}){return {schemaVersion:1,triggerId:'trigger-1',triggerRevision:3,agentId:'agent-1',jobId:'job-1',kind:EventTriggerKind.WEBHOOK,providerId:'webhook-provider',sourceBindingId:'binding-1',requiredCapabilityIds:['webhook.read'],enabled:true,createdAt:T0,...overrides};}
function observation(overrides={}){return {schemaVersion:1,observationId:'observation-1',triggerId:'trigger-1',triggerRevision:3,providerId:'webhook-provider',sourceBindingId:'binding-1',sourceEventId:'provider-event-42',payloadArtifactRef:{schemaVersion:1,artifactId:'artifact-event-42',kind:'event-payload',uri:'artifact://events/42',mediaType:'application/json',sha256:SHA,sizeBytes:120,createdAt:T1,producerInvocationId:null,sensitive:false},observedAt:T1,...overrides};}

function request(overrides={}){return {trigger:trigger(),observation:observation(),admittedAt:T2,...overrides};}

test('external event creates deterministic non-authorizing scheduler admission', async()=>{
 const a=await createEventTriggerAdmissionV1(request());
 const b=await createEventTriggerAdmissionV1(request());
 assert.equal(a.status,EventTriggerAdmissionStatus.READY_FOR_SCHEDULER);
 assert.equal(a.occurrenceId,b.occurrenceId);
 assert.equal(a.sourceIdentityFingerprint,b.sourceIdentityFingerprint);
 assert.equal(a.materialFingerprint,b.materialFingerprint);
 assert.equal(a.executionAuthorized,false);
 assert.equal(a.policyDecisionGranted,false);
 assert.equal(a.requiresCanonicalSchedulerAdmission,true);
 assert.equal(a.requiresCanonicalExactEffect,true);
 assert.equal(a.requiresCanonicalVerification,true);
 assert.equal(Object.isFrozen(a),true);
});

test('same provider event identity with changed material exposes a stable dedup key and divergent material', async()=>{
 const first=await createEventTriggerAdmissionV1(request());
 const second=await createEventTriggerAdmissionV1(request({observation:observation({observationId:'observation-2',payloadArtifactRef:{...observation().payloadArtifactRef,artifactId:'artifact-event-42b',sha256:'b'.repeat(64)}})}));
 assert.equal(first.sourceIdentityFingerprint,second.sourceIdentityFingerprint);
 assert.notEqual(first.materialFingerprint,second.materialFingerprint);
 assert.equal(first.occurrenceId,second.occurrenceId);
});

test('duplicate observation of identical upstream event and payload preserves occurrence/material identity', async()=>{
 const first=await createEventTriggerAdmissionV1(request());
 const second=await createEventTriggerAdmissionV1(request({observation:observation({
  observationId:'observation-duplicate',
  observedAt:T2,
  payloadArtifactRef:{...observation().payloadArtifactRef,artifactId:'artifact-duplicate',uri:'artifact://events/42-copy',createdAt:T2},
 })}));
 assert.equal(first.sourceIdentityFingerprint,second.sourceIdentityFingerprint);
 assert.equal(first.materialFingerprint,second.materialFingerprint);
 assert.equal(first.occurrenceId,second.occurrenceId);
});

test('disabled trigger never becomes executable work', async()=>{
 const out=await createEventTriggerAdmissionV1(request({trigger:trigger({enabled:false})}));
 assert.equal(out.status,EventTriggerAdmissionStatus.DISABLED);
 assert.equal(out.executionAuthorized,false);
 assert.equal('occurrenceId' in out,false);
});

test('provider, revision, binding and trigger identities are exact-bound', async()=>{
 for(const [field,value] of [['triggerId','trigger-2'],['triggerRevision',4],['providerId','other-provider'],['sourceBindingId','binding-2']]){
  await assert.rejects(()=>createEventTriggerAdmissionV1(request({observation:observation({[field]:value})})),new RegExp(`${field} does not match`));
 }
});

test('chronology and canonical timestamps fail closed', async()=>{
 assert.throws(()=>normalizeEventTriggerDefinitionV1(trigger({createdAt:'2026-09-25T03:00:00Z'})),/canonical ISO-8601 UTC/);
 assert.throws(()=>normalizeEventTriggerObservationV1(observation({observedAt:'2026-09-25T03:01:00Z'})),/canonical ISO-8601 UTC/);
 await assert.rejects(()=>createEventTriggerAdmissionV1(request({trigger:trigger({createdAt:T2})})),/predates trigger definition/);
 await assert.rejects(()=>createEventTriggerAdmissionV1(request({admittedAt:T0})),/predates observation/);
});

test('event material requires exact non-empty sha-bound ArtifactRef',()=>{
 assert.throws(()=>normalizeEventTriggerObservationV1(observation({payloadArtifactRef:{...observation().payloadArtifactRef,sha256:''}})),/canonical lowercase SHA-256/);
 assert.throws(()=>normalizeEventTriggerObservationV1(observation({payloadArtifactRef:{...observation().payloadArtifactRef,sizeBytes:0}})),/requires non-empty material/);
 assert.throws(()=>normalizeEventTriggerObservationV1(observation({payloadArtifactRef:{...observation().payloadArtifactRef,createdAt:T2}})),/cannot postdate observation/);
});

test('ArtifactRef aliases and coercions fail before canonical normalization',()=>{
 const variants=[
  [{schemaVersion:'1'},/schemaVersion must be numeric 1/],
  [{artifactId:' artifact-event-42'},/artifactId is invalid/],
  [{sha256:'A'.repeat(64)},/canonical lowercase SHA-256/],
  [{sizeBytes:'120'},/integer sizeBytes/],
  [{createdAt:'2026-09-25T03:01:00Z'},/canonical ISO-8601 UTC/],
  [{sensitive:'false'},/explicit boolean/],
 ];
 for(const [patch,pattern] of variants){
  assert.throws(()=>normalizeEventTriggerObservationV1(observation({payloadArtifactRef:{...observation().payloadArtifactRef,...patch}})),pattern);
 }
});

test('outer records and capability arrays are descriptor-snapshotted without ordinary getter execution', async()=>{
 let reads=0;
 const caps=new Proxy(['webhook.read'],{get(target,property,receiver){reads+=1;return Reflect.get(target,property,receiver);}});
 const t=new Proxy(trigger({requiredCapabilityIds:caps}),{get(target,property,receiver){reads+=1;return Reflect.get(target,property,receiver);}});
 const o=new Proxy(observation(),{get(target,property,receiver){reads+=1;return Reflect.get(target,property,receiver);}});
 const req=new Proxy({trigger:t,observation:o,admittedAt:T2},{get(target,property,receiver){reads+=1;return Reflect.get(target,property,receiver);}});
 const out=await createEventTriggerAdmissionV1(req);
 assert.equal(out.status,EventTriggerAdmissionStatus.READY_FOR_SCHEDULER);
 assert.equal(reads,0);
});

test('hidden/accessor/symbol authority aliases are rejected without invoking accessors', async()=>{
 let reads=0;
 const hostile=trigger();
 Object.defineProperty(hostile,'enabled',{enumerable:true,get(){reads+=1;return true;}});
 await assert.rejects(()=>createEventTriggerAdmissionV1(request({trigger:hostile})),/enumerable own data property/);
 assert.equal(reads,0);
 const hidden=observation(); Object.defineProperty(hidden,'trusted',{enumerable:false,value:true});
 assert.throws(()=>normalizeEventTriggerObservationV1(hidden),/unknown field: trusted/);
 const symbol=trigger(); symbol[Symbol('allow')]=true;
 assert.throws(()=>normalizeEventTriggerDefinitionV1(symbol),/unknown field: Symbol\(allow\)/);
});
