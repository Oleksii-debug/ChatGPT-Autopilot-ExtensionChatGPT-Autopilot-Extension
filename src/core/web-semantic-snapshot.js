export const WebSemanticSnapshotVersion = 1;

const MAX_ELEMENTS = 256;
const MAX_RESULTS = 32;
const MAX_QUERY = 512;
const MAX_ID = 180;
const MAX_ROLE = 80;
const MAX_NAME = 2_000;
const MAX_DESCRIPTION = 4_000;
const MAX_TITLE = 2_000;
const MAX_URL = 4_096;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function id(value, label) {
  const out = String(value ?? '').trim();
  if (!ID.test(out) || out.length > MAX_ID) throw new Error(`${label} is invalid`);
  return out;
}

function text(value, label, max, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const out = value.trim();
  if ((!out && !optional) || out.length > max) throw new Error(`${label} is invalid`);
  return out;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return new Date(ms).toISOString();
}

function httpUrl(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  const raw = text(value, label, MAX_URL);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`${label} is invalid`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label} protocol is not allowed`);
  if (parsed.username || parsed.password) throw new Error(`${label} credentials are not allowed`);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function optionalBoolean(value, label) {
  if (value == null) return null;
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function checkedState(value) {
  if (value == null) return null;
  if (value === true || value === false || value === 'mixed') return value;
  throw new Error('checked must be boolean or mixed');
}

function headingLevel(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 6) throw new Error('headingLevel is invalid');
  return value;
}

const ELEMENT_KEYS = new Set([
  'semanticId', 'role', 'name', 'description', 'href',
  'disabled', 'selected', 'checked', 'expanded', 'focused', 'headingLevel',
]);

export function normalizeWebSemanticElementV1(input) {
  const raw = plain(input, 'WebSemanticElementV1');
  exactKeys(raw, ELEMENT_KEYS, 'WebSemanticElementV1');
  const role = text(raw.role, 'role', MAX_ROLE).toLocaleLowerCase('en-US');
  return frozen({
    semanticId: id(raw.semanticId, 'semanticId'),
    role,
    name: text(raw.name, 'name', MAX_NAME, { optional: true }),
    description: text(raw.description, 'description', MAX_DESCRIPTION, { optional: true }),
    href: httpUrl(raw.href, 'href', { optional: true }),
    disabled: optionalBoolean(raw.disabled, 'disabled'),
    selected: optionalBoolean(raw.selected, 'selected'),
    checked: checkedState(raw.checked),
    expanded: optionalBoolean(raw.expanded, 'expanded'),
    focused: optionalBoolean(raw.focused, 'focused'),
    headingLevel: headingLevel(raw.headingLevel),
  });
}

const SNAPSHOT_KEYS = new Set([
  'schemaVersion', 'snapshotId', 'targetId', 'url', 'title', 'elements', 'observedAt',
  'contentTrust', 'actionAuthority', 'advisoryOnly',
]);

export function normalizeWebSemanticSnapshotV1(input) {
  const raw = plain(input, 'WebSemanticSnapshotV1');
  exactKeys(raw, SNAPSHOT_KEYS, 'WebSemanticSnapshotV1');
  if (Number(raw.schemaVersion) !== WebSemanticSnapshotVersion) {
    throw new Error('Unsupported WebSemanticSnapshotV1 schemaVersion');
  }
  if (Object.hasOwn(raw, 'contentTrust') && raw.contentTrust !== 'UNTRUSTED_DATA') {
    throw new Error('contentTrust must remain UNTRUSTED_DATA');
  }
  if (Object.hasOwn(raw, 'actionAuthority') && raw.actionAuthority !== 'NONE') {
    throw new Error('actionAuthority must remain NONE');
  }
  if (Object.hasOwn(raw, 'advisoryOnly') && raw.advisoryOnly !== true) {
    throw new Error('advisoryOnly must remain true');
  }
  if (!Array.isArray(raw.elements) || raw.elements.length > MAX_ELEMENTS) {
    throw new Error('elements must be a bounded array');
  }

  const elements = raw.elements.map((item, index) => {
    try { return normalizeWebSemanticElementV1(item); }
    catch (error) { throw new Error(`elements[${index}]: ${error.message}`); }
  });
  const seen = new Set();
  for (const element of elements) {
    if (seen.has(element.semanticId)) throw new Error(`elements contains duplicate semanticId: ${element.semanticId}`);
    seen.add(element.semanticId);
  }

  return frozen({
    schemaVersion: WebSemanticSnapshotVersion,
    snapshotId: id(raw.snapshotId, 'snapshotId'),
    targetId: id(raw.targetId, 'targetId'),
    url: httpUrl(raw.url, 'url'),
    title: text(raw.title, 'title', MAX_TITLE, { optional: true }),
    observedAt: timestamp(raw.observedAt, 'observedAt'),
    contentTrust: 'UNTRUSTED_DATA',
    actionAuthority: 'NONE',
    advisoryOnly: true,
    elements,
  });
}

function queryTokens(query) {
  if (typeof query !== 'string') throw new Error('query must be text');
  const normalized = query.trim().toLocaleLowerCase('en-US');
  if (!normalized || normalized.length > MAX_QUERY) throw new Error('query is invalid');
  const tokens = [...new Set(normalized.split(/[^\p{L}\p{N}._:@/+~-]+/u).filter(Boolean))];
  if (!tokens.length || tokens.length > 32) throw new Error('query has no bounded searchable tokens');
  return tokens;
}

function searchableText(element) {
  return [
    element.role,
    element.name,
    element.description,
    element.href,
  ].join(' ').toLocaleLowerCase('en-US');
}

function score(textValue, tokens) {
  let total = 0;
  for (const token of tokens) {
    if (!textValue.includes(token)) return 0;
    total += textValue.split(token).length - 1;
  }
  return total;
}

function resultView(element, matchScore) {
  return frozen({
    semanticId: element.semanticId,
    role: element.role,
    name: element.name,
    description: element.description,
    href: element.href,
    disabled: element.disabled,
    selected: element.selected,
    checked: element.checked,
    expanded: element.expanded,
    focused: element.focused,
    headingLevel: element.headingLevel,
    score: matchScore,
    contentTrust: 'UNTRUSTED_DATA',
    actionAuthority: 'NONE',
  });
}

export function inspectWebSemanticSnapshotV1({ snapshot, query, limit = 8 } = {}) {
  const normalized = normalizeWebSemanticSnapshotV1(snapshot);
  const tokens = queryTokens(query);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new Error('limit is invalid');

  const matches = [];
  for (let index = 0; index < normalized.elements.length; index += 1) {
    const element = normalized.elements[index];
    const matchScore = score(searchableText(element), tokens);
    if (!matchScore) continue;
    matches.push({ index, result: resultView(element, matchScore) });
  }
  matches.sort((a, b) => b.result.score - a.result.score || a.index - b.index);

  return frozen({
    schemaVersion: WebSemanticSnapshotVersion,
    snapshotId: normalized.snapshotId,
    targetId: normalized.targetId,
    observedAt: normalized.observedAt,
    contentTrust: 'UNTRUSTED_DATA',
    actionAuthority: 'NONE',
    advisoryOnly: true,
    resultCount: Math.min(matches.length, limit),
    truncated: matches.length > limit,
    results: matches.slice(0, limit).map(match => match.result),
  });
}
