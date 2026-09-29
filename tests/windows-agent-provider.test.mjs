import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsAgentProviderV1, WindowsToolId } from '../src/core/windows-agent-provider.js';

const at = '2026-09-23T22:00:00.000Z';
function invocation(toolId, capabilityId, args = {}) { return { schemaVersion:1, invocationId:'win-inv-1', toolId, providerId:'native/windows', requestedCapabilityIds:[capabilityId], policyDecisionId:'decision-1', arguments:args, createdAt:at, parentInvocationId:null }; }
const allow = { schemaVersion:1, decisionId:'decision-1', invocationId:'win-inv-1', decision:'ALLOW', reasonCode:'OWNER_POLICY', reason:'', approvalId:null, decidedAt:at };

test('Windows execution requires an invocation-bound ALLOW and granted capability', async () => {
  const calls=[];
  const provider=new WindowsAgentProviderV1({nativeClient:{windowsExecPinned:async payload=>{calls.push(payload);return {exitCode:0};},windowsQueryUia:async()=>[]},grantedCapabilityIds:['windows.process.execPinned'],now:()=>Date.parse(at)});
  const inv=invocation(WindowsToolId.EXEC_PINNED,'windows.process.execPinned',{executableId:'git',args:['status']});
  await assert.rejects(()=>provider.invoke({invocation:inv,policyDecision:{...allow,decision:'DENY'}}),/not authorized/);
  await assert.rejects(()=>provider.invoke({invocation:{...inv,requestedCapabilityIds:['windows.uia.query']},policyDecision:allow}),/exceeds granted|capabilities/);
  const result=await provider.invoke({invocation:inv,policyDecision:allow});
  assert.equal(result.invocationId,'win-inv-1');
  assert.deepEqual(calls,[{executableId:'git',args:['status']}]);
});

test('effectful transport failure is ambiguous while read-only UIA failure is retry-safe', async () => {
  const error=Object.assign(new Error('transport ended'),{code:'NATIVE_TRANSPORT_ERROR'});
  const provider=new WindowsAgentProviderV1({nativeClient:{windowsExecPinned:async()=>{throw error;},windowsQueryUia:async()=>{throw error;}},grantedCapabilityIds:['windows.process.execPinned','windows.uia.query']});
  await assert.rejects(()=>provider.invoke({invocation:invocation(WindowsToolId.EXEC_PINNED,'windows.process.execPinned',{executableId:'git'}),policyDecision:allow}),e=>e.effectMayHaveOccurred===true&&e.safeToRetry===false&&e.invocationId==='win-inv-1');
  await assert.rejects(()=>provider.invoke({invocation:invocation(WindowsToolId.UIA_QUERY,'windows.uia.query',{windowId:'main'}),policyDecision:allow}),e=>e.effectMayHaveOccurred===false&&e.safeToRetry===true);
});

test('host-side pre-effect rejection remains safely retryable and identity-bound', async () => {
  const rejected=Object.assign(new Error('not configured'),{code:'WINDOWS_EXECUTABLE_NOT_ALLOWED'});
  const provider=new WindowsAgentProviderV1({nativeClient:{windowsExecPinned:async()=>{throw rejected;},windowsQueryUia:async()=>[]},grantedCapabilityIds:['windows.process.execPinned']});
  await assert.rejects(()=>provider.invoke({invocation:invocation(WindowsToolId.EXEC_PINNED,'windows.process.execPinned',{executableId:'other'}),policyDecision:allow}),e=>e.effectMayHaveOccurred===false&&e.safeToRetry===true&&e.code==='WINDOWS_EXECUTABLE_NOT_ALLOWED');
});
