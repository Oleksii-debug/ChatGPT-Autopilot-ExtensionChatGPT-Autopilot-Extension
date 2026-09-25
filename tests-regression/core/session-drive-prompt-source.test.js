import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SessionDrivePromptError,
  defaultSessionDrivePromptSources,
  normalizeSessionDrivePromptSources,
  readStableSessionDrivePrompt,
  syncDueSessionDrivePrompts,
} from '../../src/core/session-drive-prompt-source.js';
import { createEmptyState, createSession, createTask, PromptMode } from '../../src/core/schema.js';
import { computeNextWake } from '../../src/core/recovery.js';

function memoryRepository(initial) {
  let stored = structuredClone(initial);
  let chain = Promise.resolve();
  return {
    async load() { return structuredClone(stored); },
    update(mutator) {
      const op = chain.then(async () => {
        const draft = structuredClone(stored);
        stored = structuredClone(await mutator(draft) || draft);
        return structuredClone(stored);
      });
      chain = op.catch(() => undefined);
      return op;
    },
    snapshot() { return structuredClone(stored); },
  };
}

function makeState({ target = 'PRIMARY', minChars = 1, promptMode = PromptMode.SHARED } = {}) {
  const state = createEmptyState(1000);
  const task = createTask({ id:'t1', url:'https://chatgpt.com/', promptOverride:'unique-primary' });
  const session = createSession({
    id:'s1',
    name:'Session',
    tasks:[task],
    promptMode,
    sharedPrompt:'local-primary',
    now:1000,
  });
  session.promptCadence.prompt2 = { enabled:true, prompt:'local-p2', everyN:3 };
  session.promptCadence.prompt3 = { enabled:true, prompt:'local-p3', everyN:5 };
  session.drivePromptSources = {
    schemaVersion:1,
    bindings:[{
      target,
      enabled:true,
      fileId:'file_abcdef',
      pollIntervalMs:60000,
      minChars,
      lastAcceptedVersion:'',
      lastAcceptedHash:'',
      lastCheckedAt:0,
      nextCheckAt:0,
      lastErrorCode:'',
    }],
  };
  state.sessionsById.s1=session;
  state.sessionOrder=['s1'];
  state.logs.s1=[];
  return state;
}

test('Drive prompt source defaults to no bindings and validates one binding per target', () => {
  assert.deepEqual(defaultSessionDrivePromptSources(), { schemaVersion:1, bindings:[] });
  assert.throws(() => normalizeSessionDrivePromptSources({
    schemaVersion:1,
    bindings:[
      { target:'PROMPT_2', enabled:false, fileId:'' },
      { target:'PROMPT_2', enabled:false, fileId:'' },
    ],
  }), /Invalid or duplicate Drive prompt target/u);
});

test('stable read accepts only equal before/after version', async () => {
  let metadataCalls=0;
  const result=await readStableSessionDrivePrompt({
    fileId:'file_abcdef',
    minChars:3,
    readMetadata:async()=>({id:'file_abcdef',version:'41',mimeType:'text/plain', call:++metadataCalls}),
    readContent:async()=> 'abc',
    hashContent:async()=> 'a'.repeat(64),
  });
  assert.equal(result.version,'41');
  assert.equal(result.content,'abc');
  assert.equal(result.hash,'a'.repeat(64));
  assert.equal(metadataCalls,2);
});

test('version race retries and never accepts mixed snapshot', async () => {
  const versions=['41','42','42','42'];
  let i=0;
  let contentReads=0;
  const result=await readStableSessionDrivePrompt({
    fileId:'file_abcdef',
    minChars:1,
    readMetadata:async()=>({id:'file_abcdef',version:versions[i++],mimeType:'text/plain'}),
    readContent:async()=>{contentReads+=1;return 'stable';},
    hashContent:async()=> 'b'.repeat(64),
    maxAttempts:3,
  });
  assert.equal(result.version,'42');
  assert.equal(result.attempts,2);
  assert.equal(contentReads,2);
});

test('short Drive prompt fails closed before state mutation', async () => {
  await assert.rejects(
    ()=>readStableSessionDrivePrompt({
      fileId:'file_abcdef',
      minChars:1000,
      readMetadata:async()=>({id:'file_abcdef',version:'1',mimeType:'text/plain'}),
      readContent:async()=> 'short',
    }),
    error=>error instanceof SessionDrivePromptError && error.code==='CONTENT_LENGTH',
  );
});

test('PRIMARY Drive update changes shared prompt only after stable accepted snapshot', async () => {
  const repo=memoryRepository(makeState({target:'PRIMARY'}));
  const sync=await syncDueSessionDrivePrompts(repo,{
    nowMs:2000,
    resolveReader:async()=>({
      readMetadata:async()=>({id:'file_abcdef',version:'7',mimeType:'text/plain'}),
      readContent:async()=> 'drive-primary',
    }),
  });
  assert.equal(sync.accepted,1);
  const session=repo.snapshot().sessionsById.s1;
  assert.equal(session.sharedPrompt,'drive-primary');
  assert.equal(session.drivePromptSources.bindings[0].lastAcceptedVersion,'7');
  assert.equal(session.drivePromptSources.bindings[0].lastErrorCode,'');
  assert.equal(session.drivePromptSources.bindings[0].nextCheckAt,62000);
});

test('PROMPT_2 Drive update writes the modern cadence slot actually used by verified-send projection', async () => {
  const repo=memoryRepository(makeState({target:'PROMPT_2'}));
  await syncDueSessionDrivePrompts(repo,{
    nowMs:2000,
    resolveReader:async()=>({
      readMetadata:async()=>({id:'file_abcdef',version:'8',mimeType:'text/plain'}),
      readContent:async()=> 'drive-prompt-two',
    }),
  });
  const session=repo.snapshot().sessionsById.s1;
  assert.equal(session.promptCadence.prompt2.prompt,'drive-prompt-two');
  assert.equal(session.promptCadence.prompt2.enabled,true);
  assert.equal(session.promptCadence.prompt2.everyN,3);
});

test('Drive failure preserves last-known-good prompt and schedules retry on same binding', async () => {
  const state=makeState({target:'PROMPT_3'});
  state.sessionsById.s1.promptCadence.prompt3.prompt='known-good';
  const repo=memoryRepository(state);
  const sync=await syncDueSessionDrivePrompts(repo,{
    nowMs:5000,
    resolveReader:async()=>{throw new SessionDrivePromptError('AUTH_REQUIRED','no auth');},
  });
  assert.equal(sync.failed,1);
  const session=repo.snapshot().sessionsById.s1;
  assert.equal(session.promptCadence.prompt3.prompt,'known-good');
  assert.equal(session.drivePromptSources.bindings[0].lastErrorCode,'AUTH_REQUIRED');
  assert.equal(session.drivePromptSources.bindings[0].nextCheckAt,65000);
});

test('same accepted Drive version with divergent content fails closed and keeps last-known-good', async () => {
  const state=makeState({target:'PRIMARY'});
  const binding=state.sessionsById.s1.drivePromptSources.bindings[0];
  binding.lastAcceptedVersion='9';
  binding.lastAcceptedHash='a'.repeat(64);
  state.sessionsById.s1.sharedPrompt='known-good';
  const repo=memoryRepository(state);

  const originalCrypto=globalThis.crypto;
  // Inject divergence indirectly by monkey-free reader plus accepted content:
  // first sync computes a different SHA for the same version and must reject.
  const sync=await syncDueSessionDrivePrompts(repo,{
    nowMs:8000,
    resolveReader:async()=>({
      readMetadata:async()=>({id:'file_abcdef',version:'9',mimeType:'text/plain'}),
      readContent:async()=> 'different-content',
    }),
  });
  assert.equal(sync.failed,1);
  const session=repo.snapshot().sessionsById.s1;
  assert.equal(session.sharedPrompt,'known-good');
  assert.equal(session.drivePromptSources.bindings[0].lastErrorCode,'VERSION_CONFLICT');
  void originalCrypto;
});

test('PRIMARY Drive source in UNIQUE prompt mode fails closed without overwriting task prompt', async () => {
  const repo=memoryRepository(makeState({target:'PRIMARY',promptMode:PromptMode.UNIQUE}));
  const sync=await syncDueSessionDrivePrompts(repo,{
    nowMs:9000,
    resolveReader:async()=>({
      readMetadata:async()=>({id:'file_abcdef',version:'10',mimeType:'text/plain'}),
      readContent:async()=> 'drive-primary',
    }),
  });
  assert.equal(sync.failed,1);
  const session=repo.snapshot().sessionsById.s1;
  assert.equal(session.tasksById.t1.promptOverride,'unique-primary');
  assert.equal(session.drivePromptSources.bindings[0].lastErrorCode,'PRIMARY_REQUIRES_SHARED_MODE');
});

test('canonical core wake includes Drive deadline even when Session is stopped', () => {
  const state=makeState({target:'PROMPT_2'});
  const session=state.sessionsById.s1;
  session.runState='STOPPED';
  session.drivePromptSources.bindings[0].nextCheckAt=50000;
  assert.equal(computeNextWake(state,10000),50000);
});

test('due stopped Session Drive binding requests immediate canonical wake', () => {
  const state=makeState({target:'PROMPT_2'});
  state.sessionsById.s1.runState='STOPPED';
  state.sessionsById.s1.drivePromptSources.bindings[0].nextCheckAt=0;
  assert.equal(computeNextWake(state,10000),10000);
});
