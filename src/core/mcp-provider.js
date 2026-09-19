import {
  normalizeToolDescriptorV1,
  normalizeToolInvocationV1,
  normalizePolicyDecisionV1,
  PolicyDecisionKind,
} from './universal-agent-contracts.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_SERVERS = 32;
const MAX_TOOLS = 256;
const MAX_JSON_BYTES = 256_000;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exactObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('MCP_SCHEMA_INVALID', `${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('MCP_SCHEMA_INVALID', `${label} contains unknown field: ${key}`);
  return value;
}

function cleanId(value, label) {
  const out = String(value ?? '').trim();
  if (!ID.test(out)) fail('MCP_SCHEMA_INVALID', `${label} is invalid`);
  return out;
}

function boundedJson(value, label) {
  const cloned = structuredClone(value ?? {});
  if (new TextEncoder().encode(JSON.stringify(cloned)).byteLength > MAX_JSON_BYTES) fail('MCP_SCHEMA_INVALID', `${label} is too large`);
  return cloned;
}

function normalizeServer(raw, index) {
  exactObject(raw, new Set(['serverId', 'enabled', 'transport', 'commandId', 'args', 'envKeys', 'timeoutMs']), `servers[${index}]`);
  const serverId = cleanId(raw.serverId, `servers[${index}].serverId`);
  if (raw.transport !== 'local-stdio') fail('MCP_TRANSPORT_NOT_ALLOWED', 'MCP V1 permits only local-stdio transport');
  const commandId = cleanId(raw.commandId, `servers[${index}].commandId`);
  if (!Array.isArray(raw.args) || raw.args.length > 64 || raw.args.some(v => typeof v !== 'string' || v.length > 4096)) fail('MCP_SCHEMA_INVALID', 'MCP args must be a bounded text array');
  if (!Array.isArray(raw.envKeys) || raw.envKeys.length > 32 || raw.envKeys.some(v => typeof v !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(v))) fail('MCP_SCHEMA_INVALID', 'MCP envKeys are invalid');
  const timeoutMs = Number(raw.timeoutMs ?? 30_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) fail('MCP_SCHEMA_INVALID', 'MCP timeoutMs must be 100..120000');
  return Object.freeze({ serverId, enabled: raw.enabled === true, transport: 'local-stdio', commandId, args: Object.freeze([...raw.args]), envKeys: Object.freeze([...raw.envKeys]), timeoutMs });
}

export function normalizeMcpProviderConfig(input) {
  exactObject(input, new Set(['schemaVersion', 'servers']), 'MCP config');
  if (Number(input.schemaVersion) !== 1) fail('MCP_SCHEMA_INVALID', 'Unsupported MCP config schemaVersion');
  if (!Array.isArray(input.servers) || input.servers.length > MAX_SERVERS) fail('MCP_SCHEMA_INVALID', 'servers must be a bounded array');
  const servers = input.servers.map(normalizeServer);
  if (new Set(servers.map(v => v.serverId)).size !== servers.length) fail('MCP_SCHEMA_INVALID', 'serverId values must be unique');
  return Object.freeze({ schemaVersion: 1, servers: Object.freeze(servers) });
}

function normalizeDiscoveredTool(raw, serverId, index) {
  exactObject(raw, new Set(['name', 'description', 'inputSchema', 'annotations']), `tools[${index}]`);
  const name = cleanId(raw.name, `tools[${index}].name`);
  const annotations = raw.annotations == null ? {} : boundedJson(raw.annotations, 'annotations');
  const readOnly = annotations.readOnlyHint === true;
  return normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: `mcp/${serverId}/${name}`,
    providerId: `mcp/${serverId}`,
    label: name,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 4000) : '',
    capabilityIds: [`mcp/${serverId}/${name}`],
    inputSchemaRef: `mcp-schema/${serverId}/${name}/input`,
    outputSchemaRef: '',
    readOnly,
  });
}

export class McpProviderV1 {
  constructor({ config, transportFactory, now = () => Date.now() } = {}) {
    this.config = normalizeMcpProviderConfig(config);
    if (typeof transportFactory !== 'function') fail('MCP_TRANSPORT_UNAVAILABLE', 'transportFactory is required');
    this.transportFactory = transportFactory;
    this.now = now;
    this.connections = new Map();
  }

  server(serverId) {
    const id = cleanId(serverId, 'serverId');
    const server = this.config.servers.find(v => v.serverId === id && v.enabled);
    if (!server) fail('MCP_SERVER_NOT_ALLOWED', `MCP server is not enabled/allowlisted: ${id}`);
    return server;
  }

  async connection(serverId) {
    const server = this.server(serverId);
    let transport = this.connections.get(server.serverId);
    if (!transport) {
      transport = await this.transportFactory(server);
      if (!transport || typeof transport.request !== 'function' || typeof transport.close !== 'function') fail('MCP_TRANSPORT_INVALID', 'MCP transport contract is invalid');
      this.connections.set(server.serverId, transport);
    }
    return { server, transport };
  }

  async disconnect(serverId) {
    const id = cleanId(serverId, 'serverId');
    const transport = this.connections.get(id);
    this.connections.delete(id);
    if (transport) await transport.close();
  }

  async discoverTools(serverId) {
    const { server, transport } = await this.connection(serverId);
    let reply;
    try { reply = await transport.request('tools/list', {}, { timeoutMs: server.timeoutMs }); }
    catch (error) { this.connections.delete(server.serverId); fail('MCP_DISCOVERY_FAILED', String(error?.message || error).slice(0, 4000)); }
    exactObject(reply, new Set(['tools', 'nextCursor']), 'tools/list result');
    if (!Array.isArray(reply.tools) || reply.tools.length > MAX_TOOLS) fail('MCP_SCHEMA_INVALID', 'tools/list tools must be a bounded array');
    // Discovery returns descriptors only. It never creates a PolicyDecision or grants execution authority.
    return Object.freeze(reply.tools.map((tool, index) => normalizeDiscoveredTool(tool, server.serverId, index)));
  }

  async invoke({ serverId, invocation, policyDecision } = {}) {
    const normalizedInvocation = normalizeToolInvocationV1(invocation);
    const normalizedDecision = normalizePolicyDecisionV1(policyDecision);
    const expectedProvider = `mcp/${cleanId(serverId, 'serverId')}`;
    if (normalizedInvocation.providerId !== expectedProvider) fail('MCP_INVOCATION_MISMATCH', 'Invocation providerId does not match MCP server');
    if (normalizedDecision.invocationId !== normalizedInvocation.invocationId || normalizedDecision.decisionId !== normalizedInvocation.policyDecisionId) fail('MCP_POLICY_MISMATCH', 'Policy decision is not bound to this invocation');
    if (normalizedDecision.decision !== PolicyDecisionKind.ALLOW) fail('MCP_POLICY_DENIED', 'MCP execution requires an explicit ALLOW decision');
    const prefix = `${expectedProvider}/`;
    if (!normalizedInvocation.toolId.startsWith(prefix)) fail('MCP_INVOCATION_MISMATCH', 'Invocation toolId does not belong to MCP server');
    const toolName = normalizedInvocation.toolId.slice(prefix.length);
    cleanId(toolName, 'toolName');
    const { server, transport } = await this.connection(serverId);
    try {
      const result = await transport.request('tools/call', { name: toolName, arguments: boundedJson(normalizedInvocation.arguments, 'arguments') }, { timeoutMs: server.timeoutMs, invocationId: normalizedInvocation.invocationId });
      return Object.freeze({ serverId: server.serverId, invocationId: normalizedInvocation.invocationId, observedAt: new Date(this.now()).toISOString(), result: boundedJson(result, 'MCP result') });
    } catch (error) {
      this.connections.delete(server.serverId);
      const code = String(error?.code || 'MCP_CALL_FAILED').slice(0, 120);
      const uncertain = error?.effectMayHaveOccurred === true;
      const wrapped = new Error(String(error?.message || error).slice(0, 4000));
      wrapped.code = uncertain ? 'MCP_EFFECT_AMBIGUOUS' : code;
      wrapped.effectMayHaveOccurred = uncertain;
      wrapped.safeToRetry = !uncertain && error?.safeToRetry === true;
      throw wrapped;
    }
  }
}
