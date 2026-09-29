import test from 'node:test'; import assert from 'node:assert/strict';
import { DEFAULT_REMOTE_DISPATCH_CONFIG, normalizeRemoteDispatchConfig, validateRemoteDispatchConfig } from '../src/core/remote-dispatch-config.js';
test('Remote Dispatch defaults disabled and five-minute local poll floor',()=>{assert.equal(DEFAULT_REMOTE_DISPATCH_CONFIG.enabled,false); assert.equal(DEFAULT_REMOTE_DISPATCH_CONFIG.minimumPollIntervalSeconds,300);});
test('config clamps invalid timing back to safe defaults',()=>{const c=normalizeRemoteDispatchConfig({minimumPollIntervalSeconds:1,fallbackAfterSeconds:1});assert.equal(c.minimumPollIntervalSeconds,300);assert.equal(c.fallbackAfterSeconds,900);});
test('enabled config requires project/repository/issue',()=>{assert.throws(()=>validateRemoteDispatchConfig({enabled:true}),/project_id/); const c=validateRemoteDispatchConfig({enabled:true,projectId:'p',repository:'o/r',issueNumber:121});assert.equal(c.enabled,true);});
