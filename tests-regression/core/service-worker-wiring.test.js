import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../../src/background/service-worker.js'), 'utf8');

test('service worker owns a real runtime-cycle wiring behind the release gate', () => {
  assert.match(source, /import \{ AutomaticSessionExecutor \} from '\.\.\/core\/automatic-executor\.js';/);
  assert.match(source, /import \{ ChromeInteractionTransport \} from '\.\.\/core\/interaction-transport\.js';/);
  assert.match(source, /import \{ reconcileRuntimeColdStart, runRuntimeCycle \} from '\.\.\/core\/runtime-execution\.js';/);
  assert.match(source, /const executor = new AutomaticSessionExecutor\(repo, chrome, transport\);/);
  assert.match(source, /executionAvailable: EXECUTION_AVAILABLE/);
});

test('cold worker load applies authorized bootstrap before recovery without executing a Session', () => {
  assert.match(source, /import \{ applyBundledBootstrapProfile \} from '\.\.\/core\/bootstrap\.js';/);
  assert.match(source, /import \{ BUNDLED_BOOTSTRAP_PROFILE \} from '\.\.\/config\/bootstrap-profile\.js';/);
  assert.match(source, /let coldStartReconciled = false;/);
  assert.match(source, /let coldStartBarrier = null;/);
  assert.match(source, /function beginColdStartReconciliation\(\) \{/);
  assert.match(source, /await ensureBundledBootstrapApplied\(\);[\s\S]*?await reconcileRuntimeColdStart\(\{/s);
  assert.match(source, /void beginColdStartReconciliation\(\)\.catch\(\(\) => undefined\);/);
  assert.match(source, /await ensureColdStartReconciled\(\);/);
  assert.doesNotMatch(
    source,
    /\nrunSafely\(runExecutionCycle\(\)\);\s*$/,
    'module evaluation must not launch an executor cycle',
  );
});

test('failed cold-start reconciliation releases its single-flight barrier for a later retry', () => {
  assert.match(source, /catch\(error => \{\s*coldStartBarrier = null;\s*console\.error\('ChatGPT Autopilot cold-start reconciliation failed safely\.'\);\s*throw error;/s);
  assert.match(source, /if \(coldStartBarrier\) return coldStartBarrier;/);
  assert.match(source, /if \(coldStartReconciled\) return;/);
});

test('startup and canonical alarm invoke the event-driven execution cycle', () => {
  assert.match(source, /onInstalled\.addListener\(\(\) => \{ runSafely\(runStartupCycle\(\)\); \}\);/);
  assert.match(source, /onStartup\.addListener\(\(\) => \{ runSafely\(runStartupCycle\(\)\); \}\);/);
  assert.match(source, /alarm\.name === 'autopilot-core-wake'\) runSafely\(runExecutionCycle\(\)\)/);
  assert.match(source, /import \{ RemoteDispatchController, REMOTE_DISPATCH_ALARM \} from '\.\.\/core\/remote-dispatch-controller\.js';/);
  assert.match(source, /const remoteDispatch = new RemoteDispatchController\(/);
  assert.match(source, /alarm\.name === REMOTE_DISPATCH_ALARM\) runSafely\(runRemoteDispatchCycle\(\)\)/);
  assert.match(source, /import \{ OrchestrationV2Manager \} from '\.\.\/core\/orchestration-v2-manager\.js';/);
  assert.match(source, /const orchestrationV2 = new OrchestrationV2Manager\(/);
  assert.match(source, /if \(orchestrationV2\.isAlarm\(alarm\.name\)\)/);
  assert.match(source, /import \{ ScenarioWorkManager \} from '\.\.\/core\/scenario-work-manager\.js';/);
  assert.match(source, /const scenarioWork = new ScenarioWorkManager\(/);
  assert.match(source, /if \(scenarioWork\.isAlarm\(alarm\.name\)\)/);
  assert.match(source, /orchestrationV2\.cycleAlarm\(alarm\.name\)/);
});

test('orchestration V2 uses read-only assistant reports and startup reconciles before Core sends', () => {
  assert.match(source, /async function probeAssistantConversation\(job\)/);
  assert.match(source, /collectAssistantReport: probeAssistantConversation/);
  assert.match(source, /mode: 'READ_ASSISTANT_REPORT'/);
  assert.match(source, /sameChatConversationUrl\(tab\.url, conversationUrl\)/, 'completion probe should reuse an existing conversation tab when possible');
  assert.match(source, /if \(temporaryTab && tabId != null\)/, 'only a temporary probe tab may be auto-closed');
  assert.match(source, /await orchestrationV2\.reconcileAlarm\(\);/);
  assert.match(source, /await browserAgent\.reconcileAlarm\(\);/, 'cold start must restore Browser Agent wake alarms from durable jobs');
  assert.doesNotMatch(source, /await orchestrationV2\.enqueueRecoveryEvent\(\);/, 'ordinary MV3 worker restart must not manufacture a reasoning tick');
  assert.match(source, /const orchestrationSync = await orchestrationV2\.syncAfterCoreCycle\(\);/);
  assert.match(source, /export function runOrchestrationV2Cycle/);
  assert.match(source, /const orchestration = await orchestrationV2\.cycleAll\(\);\s*const scenario = await scenarioWork\.cycleAll\(\);\s*const agent = await browserAgent\.cycleAll\(\);\s*const execution = await runExecutionCycle\(\);/, 'startup must reconcile orchestration, scenario work and Browser Agent before resuming Core sends');
});

test('overlapping wake events share one in-flight execution cycle', () => {
  assert.match(source, /let executionCycleInFlight = null;/);
  assert.match(source, /if \(executionCycleInFlight\) return executionCycleInFlight;/);
  assert.match(source, /executionCycleInFlight = cycle\.then\(/);
});

test('production automatic execution is explicitly enabled while UI reconciliation remains execution-free', () => {
  assert.match(source, /const EXECUTION_AVAILABLE = true;/);
  assert.doesNotMatch(source, /const EXECUTION_AVAILABLE = false;/);
  assert.match(
    source,
    /export async function reconcileRuntime\(\) \{[\s\S]*?runRuntimeCycle\(\{[\s\S]*?executionAvailable: false,[\s\S]*?\}\);/,
    'UI-triggered reconciliation must remain unable to launch automatic execution',
  );
});


test('Orchestration V2 read-only control test is wired without requiring a runtime cycle', () => {
  assert.match(source, /message\.command === 'TEST_ORCHESTRATION_V2_CONTROL'/);
  assert.match(source, /orchestrationV2\.testControl\(message\.payload\?\.settings \|\| null\)/);
  assert.match(source, /'TEST_ORCHESTRATION_V2_CONTROL'/);
});


test('service worker uses manager-level multi-orchestra cycle and per-orchestra alarm routing', () => {
  assert.match(source, /const orchestration = await orchestrationV2\.cycleAll\(\)/);
  assert.match(source, /orchestrationV2\.isAlarm\(alarm\.name\)/);
  assert.match(source, /orchestrationV2\.cycleAlarm\(alarm\.name\)/);
  assert.doesNotMatch(source, /new OrchestrationV2Controller\(/);
});

test('owner hierarchy template command routes only through Orchestration V2 manager', () => {
  assert.match(source, /message\.command === 'CONFIGURE_ORCHESTRATION_V2_HIERARCHY_TEMPLATE'/);
  assert.match(source, /orchestrationV2\.configureHierarchyTemplate\(message\.payload \|\| \{\}\)/);
});

test('manager owns multi-orchestra UI command routing', () => {
  for (const command of [
    'LIST_ORCHESTRATION_V2_ORCHESTRAS',
    'CREATE_ORCHESTRATION_V2_ORCHESTRA',
    'SELECT_ORCHESTRATION_V2_ORCHESTRA',
    'RENAME_ORCHESTRATION_V2_ORCHESTRA',
    'PAUSE_ORCHESTRATION_V2_ORCHESTRA',
    'RESUME_ORCHESTRATION_V2_ORCHESTRA',
    'DELETE_ORCHESTRATION_V2_ORCHESTRA',
  ]) assert.match(source, new RegExp(`message\\.command === '${command}'`));
});

test('legacy Remote Dispatch cannot enable while any orchestra is enabled', () => {
  assert.match(source, /const v2 = await orchestrationV2\.list\(\)/);
  assert.match(source, /v2\.orchestras\.some\(item => item\.config\?\.enabled\)/);
});


test('Browser Agent uses a dedicated durable manager with fast-burst and owner-instruction commands', () => {
  assert.match(source, /import \{ BrowserAgentManager \} from '\.\.\/core\/browser-agent-manager\.js';/);
  assert.match(source, /const browserAgent = new BrowserAgentManager\(/);
  assert.match(source, /message\.command === 'ADD_BROWSER_AGENT_INSTRUCTION'/);
  assert.match(source, /browserAgent\.addInstruction\(/);
  assert.match(source, /message\.command === 'RUN_BROWSER_AGENT_BURST'/);
  assert.match(source, /browserAgent\.runBurst\(/);
  assert.match(source, /message\.command === 'APPROVE_BROWSER_AGENT_ACTION'/);
  assert.match(source, /browserAgent\.approvePendingAction\(/);
  assert.match(source, /message\.command === 'REJECT_BROWSER_AGENT_ACTION'/);
  assert.match(source, /browserAgent\.rejectPendingAction\(/);
  assert.match(source, /alarm\.name === BROWSER_AGENT_ALARM\) runSafely\(browserAgent\.cycleAll\(\)\)/);
});


test('Drive scalar hierarchy provider uses the existing orchestra cycle and explicit OAuth boundary', () => {
  assert.match(source, /import \{[\s\S]*DRIVE_SCALAR_PROVIDER_V1[\s\S]*DriveScalarProviderV1[\s\S]*createGoogleDriveScalarReader[\s\S]*getChromeDriveAccessToken[\s\S]*inspectChromeDriveOAuth[\s\S]*\} from '\.\.\/core\/orchestration-drive-scalar-provider\.js';/);
  assert.match(source, /resolveHierarchyProvider: resolveOrchestrationHierarchyProvider/);
  assert.match(source, /async function resolveOrchestrationHierarchyProvider\(/);
  assert.match(source, /getChromeDriveAccessToken\(chrome, \{ interactive: false \}\)/, 'automatic provider polling must never open interactive OAuth');
  assert.match(source, /message\.command === 'AUTHORIZE_ORCHESTRATION_V2_DRIVE'/);
  assert.match(source, /getChromeDriveAccessToken\(chrome, \{ interactive: true \}\)/, 'interactive OAuth requires an explicit owner command');
  assert.match(source, /driveOAuth: inspectChromeDriveOAuth\(chrome\.runtime\?\.getManifest\?\.\(\)\)/);
  assert.doesNotMatch(source, /DRIVE_SCALAR_ALARM|drive-scalar-wake/, 'Drive scalar must not create a second scheduler/alarm');
  assert.doesNotMatch(source, /authorized:\s*true[\s\S]{0,120}token\s*:/i, 'access token must never be returned to the UI');
});
