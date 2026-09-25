import { assertToolInvocationAuthorizedV1, normalizeToolDescriptorV1 } from './universal-agent-contracts.js';

export const WINDOWS_PROVIDER_ID = 'native/windows';
export const WindowsToolId = Object.freeze({
  EXEC_PINNED: 'native/windows/process.execPinned',
  UIA_QUERY: 'native/windows/uia.query',
  UIA_INVOKE: 'native/windows/uia.invoke',
});

const PRE_EFFECT_CODES = new Set([
  'WINDOWS_PROVIDER_UNAVAILABLE', 'WINDOWS_UNAVAILABLE', 'WINDOWS_INVALID_REQUEST',
  'WINDOWS_EXECUTABLE_NOT_ALLOWED', 'WINDOWS_CONFIG_INVALID', 'WINDOWS_UIA_UNAVAILABLE',
]);

const TOOLS = Object.freeze([
  normalizeToolDescriptorV1({ schemaVersion: 1, toolId: WindowsToolId.EXEC_PINNED, providerId: WINDOWS_PROVIDER_ID, label: 'Run owner-pinned Windows executable', description: 'Runs one executable identity from the owner-controlled Native Companion registry.', capabilityIds: ['windows.process.execPinned'], inputSchemaRef: 'windows-schema/process.execPinned/input', outputSchemaRef: 'windows-schema/process.execPinned/output', readOnly: false }),
  normalizeToolDescriptorV1({ schemaVersion: 1, toolId: WindowsToolId.UIA_QUERY, providerId: WINDOWS_PROVIDER_ID, label: 'Query Windows UI Automation', description: 'Reads a bounded semantic UI Automation result set.', capabilityIds: ['windows.uia.query'], inputSchemaRef: 'windows-schema/uia.query/input', outputSchemaRef: 'windows-schema/uia.query/output', readOnly: true }),
  normalizeToolDescriptorV1({ schemaVersion: 1, toolId: WindowsToolId.UIA_INVOKE, providerId: WINDOWS_PROVIDER_ID, label: 'Invoke Windows UI Automation control', description: 'Invokes exactly one freshly resolved semantic UI Automation control through InvokePattern.', capabilityIds: ['windows.uia.invoke'], inputSchemaRef: 'windows-schema/uia.invoke/input', outputSchemaRef: 'windows-schema/uia.invoke/output', readOnly: false }),
]);

function wrapFailure(error, { readOnly, invocationId }) {
  const code = String(error?.code || 'WINDOWS_PROVIDER_FAILED').slice(0, 120);
  const preEffect = PRE_EFFECT_CODES.has(code);
  const wrapped = new Error(String(error?.message || error).slice(0, 4000));
  wrapped.code = code;
  wrapped.invocationId = invocationId;
  wrapped.effectMayHaveOccurred = readOnly ? false : !preEffect;
  wrapped.safeToRetry = readOnly || preEffect;
  wrapped.cause = error;
  return wrapped;
}

export class WindowsAgentProviderV1 {
  constructor({ nativeClient, grantedCapabilityIds = [], now = () => Date.now() } = {}) {
    if (!nativeClient?.windowsExecPinned || !nativeClient?.windowsQueryUia || !nativeClient?.windowsInvokeUia) throw new Error('Windows Native Companion client is required');
    this.nativeClient = nativeClient;
    this.grantedCapabilityIds = Object.freeze([...grantedCapabilityIds]);
    this.now = now;
  }

  tools() { return TOOLS; }

  authorize({ invocation, policyDecision } = {}) {
    const tool = TOOLS.find(item => item.toolId === invocation?.toolId);
    if (!tool) throw new Error('Windows tool is not registered');
    return assertToolInvocationAuthorizedV1({ invocation, policyDecision, toolDescriptor: tool, grantedCapabilityIds: this.grantedCapabilityIds });
  }

  async invoke({ invocation, policyDecision } = {}) {
    const authorized = this.authorize({ invocation, policyDecision });
    const tool = TOOLS.find(item => item.toolId === authorized.invocation.toolId);
    try {
      let result;
      if (tool.toolId === WindowsToolId.EXEC_PINNED) {
        result = await this.nativeClient.windowsExecPinned(authorized.invocation.arguments);
      } else if (tool.toolId === WindowsToolId.UIA_QUERY) {
        result = await this.nativeClient.windowsQueryUia(authorized.invocation.arguments);
      } else {
        result = await this.nativeClient.windowsInvokeUia(authorized.invocation.arguments);
      }
      return Object.freeze({ providerId: WINDOWS_PROVIDER_ID, invocationId: authorized.invocation.invocationId, observedAt: new Date(this.now()).toISOString(), result: structuredClone(result) });
    } catch (error) {
      throw wrapFailure(error, { readOnly: tool.readOnly, invocationId: authorized.invocation.invocationId });
    }
  }
}
