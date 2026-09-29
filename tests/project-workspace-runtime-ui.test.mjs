import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../src/ui/options.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');

test('Project Workspace panel is semantic, keyboard reachable and non-live', () => {
  const section = html.match(/<section id="project-workspace-panel"[\s\S]*?<\/section>/u)?.[0] || '';
  assert.match(section, /aria-labelledby="project-workspace-heading"/u);
  assert.match(section, /id="project-workspace-heading"/u);
  assert.match(section, /id="project-workspace-summary" tabindex="0"/u);
  assert.match(section, /<button id="project-workspace-refresh-button" type="button">Оновити проєкти<\/button>/u);
  assert.match(section, /<ul id="project-workspace-list" aria-label="Збережені проєкти">/u);
  assert.doesNotMatch(section, /aria-live=/iu);
});

test('Project Workspace service-worker bridge is explicitly read-only and reuses the canonical durable repository', () => {
  const readOnlyBlock = worker.match(/const READ_ONLY_UI_COMMANDS = new Set\(\[[\s\S]*?\]\);/u)?.[0] || '';
  assert.match(readOnlyBlock, /'GET_PROJECT_WORKSPACE_SUMMARY'/u);
  assert.match(worker, /ProjectWorkspaceRepository/u);
  assert.match(worker, /ProjectWorkspaceRuntimeReader/u);
  assert.match(worker, /new ProjectWorkspaceRuntimeReader\(new ProjectWorkspaceRepository\(chrome\)\)/u);
  assert.match(worker, /message\.command === 'GET_PROJECT_WORKSPACE_SUMMARY'/u);
  assert.match(worker, /projectWorkspaceRuntime\.readSummary\(\)/u);
  assert.doesNotMatch(worker, /(?:CREATE|ADD|REPLACE|DELETE)_PROJECT_WORKSPACE/u);
});

test('Project Workspace UI loads once initially and refreshes only on explicit native-button action', () => {
  assert.match(ui, /function renderProjectWorkspaceSummary\(data\)/u);
  assert.match(ui, /core\('GET_PROJECT_WORKSPACE_SUMMARY'\)/u);
  assert.match(ui, /project-workspace-refresh-button/u);
  assert.match(ui, /loadProjectWorkspace\(\{ focusSummary: true \}\)/u);
  assert.match(ui, /await loadProjectWorkspace\(\);/u);

  const pollingStart = ui.indexOf('window.setInterval(() => { void recordDashboardDiagnosticSnapshot()');
  const exportStart = ui.indexOf('export { MAX_TASKS');
  const polling = pollingStart >= 0 && exportStart > pollingStart ? ui.slice(pollingStart, exportStart) : '';
  assert.doesNotMatch(polling, /loadProjectWorkspace/u);
});

test('Project Workspace list renders identity/revision/count metadata without source or artifact locations', () => {
  const start = ui.indexOf('function renderProjectWorkspaceSummary');
  const end = ui.indexOf('async function loadProjectWorkspace', start);
  const renderer = start >= 0 && end > start ? ui.slice(start, end) : '';
  assert.match(renderer, /project\.projectId/u);
  assert.match(renderer, /project\.projectRevisionId/u);
  assert.match(renderer, /project\.sourceCount/u);
  assert.match(renderer, /project\.artifactCount/u);
  assert.match(renderer, /project\.capsuleCount/u);
  assert.doesNotMatch(renderer, /project\.(?:uri|title|summary)\b|credential/iu);
});
