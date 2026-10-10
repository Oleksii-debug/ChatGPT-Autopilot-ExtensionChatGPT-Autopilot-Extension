#!/usr/bin/env node
/**
 * Keyboard/terminal-native Autopilot CLI.
 * Usage: set AUTOPILOT_LOCAL_API_TOKEN and AUTOPILOT_LOCAL_API_PORT in the
 * trusted Companion environment; pipe a versioned JSON request on stdin.
 * NEVER place a token on the command line or in a checked-in file.
 */
import { createAutopilotLocalClientV1 } from './client.mjs';
import { parseStrictControlJsonV1 } from './control-json.mjs';

const help = `ChatGPT Автопілот — локальний CLI, API v1
  node companion/local-api/cli.mjs < request.json
  AUTOPILOT_LOCAL_API_TOKEN: секрет у середовищі Companion, не в команді
  AUTOPILOT_LOCAL_API_PORT: TCP порт локального Companion
  Дані запиту: JSON із schemaVersion, requestId, principalId, projectId,
  operation, targetId, payloadArtifactRef, requestedAt.
  Операції проходять звичайні перевірки політик і дозволів Core.
  UNKNOWN_NETWORK_RESULT: перевірте стан за requestId, не повторюйте ефект сліпо.
`;
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(help);
  process.exit(0);
}
async function main() {
  const port = Number(process.env.AUTOPILOT_LOCAL_API_PORT);
  const client = createAutopilotLocalClientV1({
    token: process.env.AUTOPILOT_LOCAL_API_TOKEN,
    port,
  });
  let chunks = [], length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 65_536) throw new Error('Вхідний JSON завеликий.');
    chunks.push(chunk);
  }
  // Same strict UTF-8 / duplicate-identity fence as the authenticated HTTP endpoint.
  // A CLI must not silently choose the last duplicate requestId or projectId.
  const raw = parseStrictControlJsonV1(Buffer.concat(chunks));
  const result = await client.control(raw);
  // Output is structured text, accessible to NVDA and shell scripts.
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.status !== 'RECEIVED') process.exitCode = 2;
}
main().catch(() => {
  // No stack traces or secrets in diagnostics.
  process.stderr.write('Помилка CLI: перевірте конфігурацію Companion, JSON або локальне API.\n');
  process.exitCode = 1;
});
