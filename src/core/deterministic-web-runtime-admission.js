export const DETERMINISTIC_WEB_RUNTIME_CHANNEL = 'autopilot-deterministic-web';

function requireProvider(provider) {
  if (!provider || typeof provider.invoke !== 'function' || typeof provider.reconcile !== 'function' || typeof provider.recoverInterrupted !== 'function') {
    throw new Error('deterministic web runtime admission requires canonical provider');
  }
  return provider;
}

export function createDeterministicWebRuntimeAdmissionV1({ provider, extensionId = '' } = {}) {
  const canonical = requireProvider(provider);
  let recovered = false;
  let recoveryBarrier = null;

  async function ensureRecovered() {
    if (recovered) return [];
    if (recoveryBarrier) return recoveryBarrier;
    recoveryBarrier = Promise.resolve()
      .then(() => canonical.recoverInterrupted())
      .then(result => {
        recovered = true;
        recoveryBarrier = null;
        return result;
      })
      .catch(error => {
        recoveryBarrier = null;
        throw error;
      });
    return recoveryBarrier;
  }

  async function dispatch(message, sender = {}) {
    if (message?.channel !== DETERMINISTIC_WEB_RUNTIME_CHANNEL) return null;
    if (extensionId && sender?.id !== extensionId) throw new Error('deterministic web runtime sender is not authorized');
    await ensureRecovered();
    if (message.command === 'INVOKE') return canonical.invoke(message.payload || {});
    if (message.command === 'RECONCILE_VERIFIED') {
      return canonical.reconcile({
        invocationId: message.payload?.invocationId,
        outcome: 'VERIFIED',
        reasonCode: message.payload?.reasonCode || 'CHROME_READBACK_VERIFIED',
      });
    }
    throw new Error('deterministic web runtime command is not allowed');
  }

  return Object.freeze({
    ensureRecovered,
    dispatch,
  });
}
