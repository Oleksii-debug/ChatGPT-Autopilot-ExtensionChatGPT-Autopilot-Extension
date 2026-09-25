export const SiteAdapterId = Object.freeze({
  CHATGPT_WEB: 'chatgpt-web',
});

const DESCRIPTORS = Object.freeze({
  [SiteAdapterId.CHATGPT_WEB]: Object.freeze({
    id: SiteAdapterId.CHATGPT_WEB,
    version: 1,
    hosts: Object.freeze(['chatgpt.com']),
    recoveryScriptFiles: Object.freeze([
      'src/interaction/chatgpt-adapter.js',
      'src/interaction/content-script.js',
    ]),
  }),
});

function requireExactSiteAdapterId(adapterId) {
  if (typeof adapterId !== 'string'
      || adapterId.length === 0
      || adapterId !== adapterId.trim()) {
    throw new Error('Site adapter ID must use exact canonical text representation');
  }
  return adapterId;
}

function cloneDescriptor(descriptor) {
  return {
    ...descriptor,
    hosts: [...descriptor.hosts],
    recoveryScriptFiles: [...descriptor.recoveryScriptFiles],
  };
}

export function listSiteAdapters() {
  return Object.values(DESCRIPTORS).map(cloneDescriptor);
}

export function getSiteAdapter(adapterId) {
  const id = requireExactSiteAdapterId(adapterId);
  const descriptor = DESCRIPTORS[id];
  if (!descriptor) throw new Error(`Unsupported site adapter: ${id}`);
  return cloneDescriptor(descriptor);
}

export function siteAdapterAcceptsUrl(adapterId, value) {
  const descriptor = getSiteAdapter(adapterId);
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && descriptor.hosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function requireSiteAdapterUrl(adapterId, value) {
  const descriptor = getSiteAdapter(adapterId);
  if (!siteAdapterAcceptsUrl(adapterId, value)) {
    throw new Error(`Site adapter ${descriptor.id} does not accept URL: ${String(value || '(empty)')}`);
  }
  return descriptor;
}
