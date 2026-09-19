import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NativeMessageDecoder,
  encodeNativeMessage,
  handleNativeCompanionRequest,
  normalizeNativeCompanionConfig,
} from './host-core.mjs';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.AUTOPILOT_NATIVE_CONFIG || path.join(baseDir, 'config', 'native-companion.json');
const callerOrigin = String(process.argv[2] || '').trim();

let config;
try {
  const configText = fs.readFileSync(configPath, 'utf8').replace(/^\\uFEFF/u, '');
  config = normalizeNativeCompanionConfig(JSON.parse(configText));
} catch (error) {
  process.stderr.write(`Native Companion configuration failed: ${error.message}\n`);
  process.exit(2);
}

const decoder = new NativeMessageDecoder();
let chain = Promise.resolve();

function writeResponse(response) {
  process.stdout.write(encodeNativeMessage(response));
}

process.stdin.on('data', chunk => {
  let messages;
  try {
    messages = decoder.push(chunk);
  } catch (error) {
    process.stderr.write(`Native Companion framing failed: ${error.message}\n`);
    process.exitCode = 3;
    process.stdin.pause();
    return;
  }
  for (const message of messages) {
    chain = chain.then(async () => {
      const response = await handleNativeCompanionRequest(message, { config, callerOrigin });
      writeResponse(response);
    }).catch(error => {
      process.stderr.write(`Native Companion request failed unexpectedly: ${error.message}\n`);
      process.exitCode = 4;
    });
  }
});

process.stdin.on('error', error => {
  process.stderr.write(`Native Companion stdin failed: ${error.message}\n`);
  process.exitCode = 5;
});

process.stdout.on('error', () => {
  process.exitCode = 0;
});
