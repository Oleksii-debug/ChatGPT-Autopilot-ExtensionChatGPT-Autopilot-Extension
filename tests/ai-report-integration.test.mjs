import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyInteractionResult } from '../src/core/execution.js';
import { createSession, createTask, PromptMode, RunMode, TabStrategy } from '../src/core/schema.js';
import { InteractionResult } from '../src/shared/protocol.js';

const adapter = fs.readFileSync(new URL('../src/interaction/chatgpt-adapter.js', import.meta.url), 'utf8');
const transport = fs.readFileSync(new URL('../src/core/interaction-transport.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');

test('verified send persists concrete conversation URL for later report collection', () => {
  const task = createTask({ id: 't', url: 'https://chatgpt.com/' });
  const session = createSession({ id: 's', name: 's', tasks: [task], promptMode: PromptMode.SHARED, sharedPrompt: 'p', runMode: RunMode.ONE_PASS, tabStrategy: TabStrategy.OPEN_CLOSE_PER_TASK, now: 1 });
  session.operation = { operationId: 'op', sessionId: 's', taskId: 't', promptFingerprint: 'fp', phase: 'SUBMITTING', targetUrl: 'https://chatgpt.com/', createdAt: 1, updatedAt: 1, preSendDeadline: 0, submitStartedAt: 1, verificationDeadline: 0 };
  applyInteractionResult(session, 0, { status: InteractionResult.SENT_VERIFIED, normalizedObservedUrl: 'https://chatgpt.com/c/conversation123', assistantBaselineCount: 3 }, { now: 10, promptFingerprint: 'fp' });
  assert.equal(task.lastConversationUrl, 'https://chatgpt.com/c/conversation123');
  assert.equal(task.lastAssistantBaselineKnown, true);
  assert.equal(task.lastAssistantBaselineCount, 3);
});

test('assistant report reader is a read-only recoverable interaction mode', () => {
  assert.match(adapter, /READ_ASSISTANT_REPORT/);
  assert.match(adapter, /ASSISTANT_RESPONSE_READY/);
  assert.match(adapter, /semanticAssistantMessages/);
  assert.match(transport, /'READ_ASSISTANT_REPORT'/);
  assert.match(worker, /collectWebReportFromConversation/);
  assert.match(worker, /autopilot-ai-report-wake/);
});
