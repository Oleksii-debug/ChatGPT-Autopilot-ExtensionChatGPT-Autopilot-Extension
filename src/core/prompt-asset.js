import { normalizeSourceRevisionBindingV1 } from './project-context-artifact.js';

export const PROMPT_ASSET_VERSION = 1;
export const PromptAssetCadenceMode = Object.freeze({
  MANUAL: 'MANUAL',
  SCHEDULE: 'SCHEDULE',
  EVENT: 'EVENT',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VARIABLE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CADENCE_MODES = new Set(Object.values(PromptAssetCadenceMode));
const MAX_TEMPLATE_BYTES = 64 * 1024;
const MAX_RENDERED_BYTES = 128 * 1024;
const MAX_VARIABLES = 64;
const MAX_SOURCES = 32;
const MAX_HISTORY = 128;
const MAX_CHANGE_SUMMARY = 2000;
const ASSET_KEYS = new Set([
  'schemaVersion', 'assetId', 'projectId', 'version', 'parentVersion', 'title',
  'template', 'variables', 'sourceBindings', 'cadence', 'changeSummary', 'changedAt',
]);
const VARIABLE_KEYS = new Set(['name', 'required', 'maxChars', 'defaultValue', 'sensitive']);
const SOURCE_KEYS = new Set(['sourceId', 'revisionId', 'contentSha256']);
const CADENCE_KEYS = new Set(['mode', 'referenceId']);
const TRIGGER_KEYS = new Set(['mode', 'referenceId']);
const RENDER_KEYS = new Set(['values', 'currentSourceBindings', 'trigger']);
const SENSITIVE_REF_KEYS = new Set(['schemaVersion', 'brokerId', 'credentialId']);
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/gu;

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
  }
}

function id(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const out = value.trim();
  if (!ID.test(out)) throw new Error(`${label} is invalid`);
  return out;
}

function text(value, label, maxChars, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const out = value.trim();
  if ((!out && !allowEmpty) || out.length > maxChars) throw new Error(`${label} is invalid`);
  return out;
}

function exactInteger(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer in ${min}..${max}`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be an ISO timestamp`);
  const canonical = new Date(ms).toISOString();
  if (canonical !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
  return canonical;
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeVariable(raw, index) {
  plain(raw, `variables[${index}]`);
  exactKeys(raw, VARIABLE_KEYS, `variables[${index}]`);
  if (typeof raw.name !== 'string' || !VARIABLE.test(raw.name)) {
    throw new Error(`variables[${index}].name is invalid`);
  }
  if (typeof raw.required !== 'boolean') throw new Error(`variables[${index}].required must be boolean`);
  if (typeof raw.sensitive !== 'boolean') throw new Error(`variables[${index}].sensitive must be boolean`);
  const maxChars = exactInteger(raw.maxChars, `variables[${index}].maxChars`, 1, 32768);
  let defaultValue = null;
  if (raw.defaultValue != null) {
    if (raw.sensitive) throw new Error(`variables[${index}] sensitive variables cannot persist defaults`);
    if (typeof raw.defaultValue !== 'string' || raw.defaultValue.length > maxChars) {
      throw new Error(`variables[${index}].defaultValue exceeds maxChars`);
    }
    defaultValue = raw.defaultValue;
  }
  return deepFreeze({
    name: raw.name,
    required: raw.required,
    maxChars,
    defaultValue,
    sensitive: raw.sensitive,
  });
}

function normalizeSourceBinding(raw, index) {
  plain(raw, `sourceBindings[${index}]`);
  exactKeys(raw, SOURCE_KEYS, `sourceBindings[${index}]`);
  if (typeof raw.sourceId !== 'string' || typeof raw.revisionId !== 'string' || typeof raw.contentSha256 !== 'string') {
    throw new Error(`sourceBindings[${index}] identity fields must be strings`);
  }
  const normalized = normalizeSourceRevisionBindingV1(raw);
  if (normalized.contentSha256 && !SHA256.test(normalized.contentSha256)) {
    throw new Error(`sourceBindings[${index}].contentSha256 is invalid`);
  }
  return deepFreeze({
    sourceId: normalized.sourceId,
    revisionId: normalized.revisionId,
    contentSha256: normalized.contentSha256,
  });
}

function normalizeCadence(raw) {
  plain(raw, 'cadence');
  exactKeys(raw, CADENCE_KEYS, 'cadence');
  if (typeof raw.mode !== 'string' || !CADENCE_MODES.has(raw.mode)) {
    throw new Error('cadence.mode is invalid');
  }
  if (raw.mode === PromptAssetCadenceMode.MANUAL) {
    if (raw.referenceId != null) throw new Error('MANUAL cadence cannot have referenceId');
    return deepFreeze({ mode: raw.mode, referenceId: null });
  }
  return deepFreeze({ mode: raw.mode, referenceId: id(raw.referenceId, 'cadence.referenceId') });
}

function templatePlaceholders(template) {
  const names = [];
  const replaced = template.replace(PLACEHOLDER, (_match, name) => {
    names.push(name);
    return '';
  });
  if (replaced.includes('{{') || replaced.includes('}}')) {
    throw new Error('template contains malformed placeholder syntax');
  }
  return names;
}

function normalizeTemplate(rawTemplate, variables) {
  if (typeof rawTemplate !== 'string' || !rawTemplate.trim()) throw new Error('template is required');
  if (utf8Bytes(rawTemplate) > MAX_TEMPLATE_BYTES) throw new Error('template exceeds byte limit');
  const placeholders = templatePlaceholders(rawTemplate);
  const declared = new Set(variables.map(item => item.name));
  const used = new Set(placeholders);
  for (const name of used) {
    if (!declared.has(name)) throw new Error(`template references undeclared variable: ${name}`);
  }
  for (const name of declared) {
    if (!used.has(name)) throw new Error(`declared variable is not referenced by template: ${name}`);
  }
  return rawTemplate;
}

function compareSourceBinding(a, b) {
  return a.sourceId.localeCompare(b.sourceId)
    || a.revisionId.localeCompare(b.revisionId)
    || a.contentSha256.localeCompare(b.contentSha256);
}

export function normalizePromptAssetV1(input) {
  const raw = plain(input, 'PromptAssetV1');
  exactKeys(raw, ASSET_KEYS, 'PromptAssetV1');
  if (raw.schemaVersion !== PROMPT_ASSET_VERSION) {
    throw new Error(`PromptAssetV1 schemaVersion must be ${PROMPT_ASSET_VERSION}`);
  }
  const assetId = id(raw.assetId, 'assetId');
  const projectId = id(raw.projectId, 'projectId');
  const version = exactInteger(raw.version, 'version', 1, Number.MAX_SAFE_INTEGER);
  let parentVersion = null;
  if (raw.parentVersion != null) {
    parentVersion = exactInteger(raw.parentVersion, 'parentVersion', 1, Number.MAX_SAFE_INTEGER);
    if (parentVersion >= version) throw new Error('parentVersion must be earlier than version');
  }
  const title = text(raw.title, 'title', 500);
  if (!Array.isArray(raw.variables) || raw.variables.length > MAX_VARIABLES) {
    throw new Error(`variables must be an array with at most ${MAX_VARIABLES} entries`);
  }
  const variables = raw.variables.map(normalizeVariable);
  if (new Set(variables.map(item => item.name)).size !== variables.length) {
    throw new Error('variables contains duplicate names');
  }
  const template = normalizeTemplate(raw.template, variables);
  if (!Array.isArray(raw.sourceBindings) || raw.sourceBindings.length > MAX_SOURCES) {
    throw new Error(`sourceBindings must be an array with at most ${MAX_SOURCES} entries`);
  }
  const sourceBindings = raw.sourceBindings.map(normalizeSourceBinding).sort(compareSourceBinding);
  if (new Set(sourceBindings.map(item => item.sourceId)).size !== sourceBindings.length) {
    throw new Error('sourceBindings contains duplicate sourceId');
  }
  const cadence = normalizeCadence(raw.cadence);
  const changeSummary = text(raw.changeSummary, 'changeSummary', MAX_CHANGE_SUMMARY);
  const changedAt = timestamp(raw.changedAt, 'changedAt');
  return deepFreeze({
    schemaVersion: PROMPT_ASSET_VERSION,
    assetId,
    projectId,
    version,
    parentVersion,
    title,
    template,
    variables,
    sourceBindings,
    cadence,
    changeSummary,
    changedAt,
  });
}

function assertLineage(previous, next) {
  if (next.assetId !== previous.assetId || next.projectId !== previous.projectId) {
    throw new Error('Prompt asset identity cannot change across versions');
  }
  if (next.version !== previous.version + 1 || next.parentVersion !== previous.version) {
    throw new Error('Prompt asset version lineage must advance exactly by one version');
  }
  if (Date.parse(next.changedAt) < Date.parse(previous.changedAt)) {
    throw new Error('Prompt asset changedAt cannot move backwards');
  }
}

export function evolvePromptAssetV1(previousInput, nextInput) {
  const previous = normalizePromptAssetV1(previousInput);
  const next = normalizePromptAssetV1(nextInput);
  assertLineage(previous, next);
  return next;
}

export function normalizePromptAssetHistoryV1(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_HISTORY) {
    throw new Error(`Prompt asset history must contain 1..${MAX_HISTORY} versions`);
  }
  const history = input.map(normalizePromptAssetV1);
  const first = history[0];
  if (first.version !== 1 || first.parentVersion !== null) {
    throw new Error('Prompt asset history must start at version 1 with no parent');
  }
  for (let index = 1; index < history.length; index += 1) {
    assertLineage(history[index - 1], history[index]);
  }
  return deepFreeze(history);
}

function bindingKey(binding) {
  return `${binding.sourceId}\u0000${binding.revisionId}\u0000${binding.contentSha256}`;
}

function assertSourceFreshness(asset, currentBindingsRaw) {
  if (!Array.isArray(currentBindingsRaw) || currentBindingsRaw.length > MAX_SOURCES) {
    throw new Error('currentSourceBindings must be a bounded array');
  }
  const current = currentBindingsRaw.map(normalizeSourceBinding).sort(compareSourceBinding);
  if (current.length !== asset.sourceBindings.length) {
    throw new Error('Prompt asset source binding set is stale or incomplete');
  }
  for (let index = 0; index < asset.sourceBindings.length; index += 1) {
    if (bindingKey(asset.sourceBindings[index]) !== bindingKey(current[index])) {
      throw new Error(`Prompt asset source binding is stale: ${asset.sourceBindings[index].sourceId}`);
    }
  }
}

function assertCadenceTrigger(asset, triggerRaw) {
  if (asset.cadence.mode === PromptAssetCadenceMode.MANUAL) {
    if (triggerRaw != null) throw new Error('MANUAL prompt asset cannot accept a scheduler/event trigger');
    return;
  }
  const raw = plain(triggerRaw, 'trigger');
  exactKeys(raw, TRIGGER_KEYS, 'trigger');
  if (typeof raw.mode !== 'string' || raw.mode !== asset.cadence.mode) {
    throw new Error('trigger mode does not match prompt asset cadence');
  }
  if (id(raw.referenceId, 'trigger.referenceId') !== asset.cadence.referenceId) {
    throw new Error('trigger referenceId does not match prompt asset cadence');
  }
}

function normalizeSensitiveReference(raw, label) {
  plain(raw, label);
  exactKeys(raw, SENSITIVE_REF_KEYS, label);
  if (raw.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`);
  return deepFreeze({
    schemaVersion: 1,
    brokerId: id(raw.brokerId, `${label}.brokerId`),
    credentialId: id(raw.credentialId, `${label}.credentialId`),
  });
}

function normalizeValues(asset, rawValues) {
  const raw = rawValues == null ? Object.create(null) : rawValues;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('values must be a plain object');
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('values must be a plain object');
  const definitions = new Map(asset.variables.map(item => [item.name, item]));
  const values = new Map();
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !definitions.has(key)) {
      throw new Error(`values contains unknown variable: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(`values.${key} must be an enumerable own data property`);
    }
    const definition = definitions.get(key);
    const value = descriptor.value;
    if (definition.sensitive) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`values.${key} sensitive input must be an opaque credential reference`);
      }
      values.set(key, normalizeSensitiveReference(value, `values.${key}`));
      continue;
    }
    if (typeof value !== 'string' || value.length > definition.maxChars) {
      throw new Error(`values.${key} is invalid or exceeds maxChars`);
    }
    values.set(key, value);
  }
  for (const definition of asset.variables) {
    if (!values.has(definition.name)) {
      if (definition.defaultValue != null) values.set(definition.name, definition.defaultValue);
      else if (definition.required) throw new Error(`required variable is missing: ${definition.name}`);
      else values.set(definition.name, definition.sensitive ? null : '');
    }
  }
  return values;
}

export function renderPromptAssetV1(assetInput, options = {}) {
  const rawOptions = plain(options, 'render options');
  exactKeys(rawOptions, RENDER_KEYS, 'render options');
  const values = Object.hasOwn(rawOptions, 'values') ? rawOptions.values : null;
  const currentSourceBindings = Object.hasOwn(rawOptions, 'currentSourceBindings') ? rawOptions.currentSourceBindings : [];
  const trigger = Object.hasOwn(rawOptions, 'trigger') ? rawOptions.trigger : null;
  const asset = normalizePromptAssetV1(assetInput);
  assertSourceFreshness(asset, currentSourceBindings);
  assertCadenceTrigger(asset, trigger);
  const normalizedValues = normalizeValues(asset, values);
  const definitions = new Map(asset.variables.map(item => [item.name, item]));
  const sensitiveBindingsByName = new Map();
  const rendered = asset.template.replace(PLACEHOLDER, (_match, name) => {
    const definition = definitions.get(name);
    const value = normalizedValues.get(name);
    if (!definition.sensitive) return value;
    if (!value) return '';
    sensitiveBindingsByName.set(name, value);
    // Generic prompt rendering must be non-secret by construction. The native
    // CredentialBroker remains the sole authority that may resolve this opaque
    // reference after destination/policy/scope checks.
    return `{{SENSITIVE_REF:${name}}}`;
  });
  if (utf8Bytes(rendered) > MAX_RENDERED_BYTES) throw new Error('Rendered prompt exceeds byte limit');
  const sensitiveBindings = [...sensitiveBindingsByName.entries()].map(([variableName, credentialRef]) => ({
    variableName,
    credentialRef,
  }));
  return deepFreeze({
    schemaVersion: 1,
    assetId: asset.assetId,
    projectId: asset.projectId,
    version: asset.version,
    rendered,
    sourceBindings: asset.sourceBindings.map(item => ({ ...item })),
    cadence: { ...asset.cadence },
    sensitiveVariableNames: asset.variables.filter(item => item.sensitive).map(item => item.name),
    sensitiveBindings,
  });
}

function arrayIdentity(items, toKey) {
  return new Map(items.map(item => [toKey(item), item]));
}

function templateChangeWindow(before, after) {
  const left = before.split('\n');
  const right = after.split('\n');
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix += 1;
  return deepFreeze({
    startLine: prefix + 1,
    beforeLineCount: left.length - prefix - suffix,
    afterLineCount: right.length - prefix - suffix,
    before: left.slice(prefix, left.length - suffix),
    after: right.slice(prefix, right.length - suffix),
  });
}

function variablePublicShape(item) {
  return {
    name: item.name,
    required: item.required,
    maxChars: item.maxChars,
    sensitive: item.sensitive,
    hasDefault: item.defaultValue != null,
  };
}

export function diffPromptAssetVersionsV1(previousInput, nextInput) {
  const previous = normalizePromptAssetV1(previousInput);
  const next = normalizePromptAssetV1(nextInput);
  assertLineage(previous, next);

  const beforeVariables = arrayIdentity(previous.variables, item => item.name);
  const afterVariables = arrayIdentity(next.variables, item => item.name);
  const variableNames = [...new Set([...beforeVariables.keys(), ...afterVariables.keys()])].sort();
  const variableChanges = [];
  for (const name of variableNames) {
    const before = beforeVariables.get(name);
    const after = afterVariables.get(name);
    if (!before) variableChanges.push({ name, change: 'ADDED', after: variablePublicShape(after) });
    else if (!after) variableChanges.push({ name, change: 'REMOVED', before: variablePublicShape(before) });
    else {
      const beforeShape = variablePublicShape(before);
      const afterShape = variablePublicShape(after);
      const defaultChanged = before.defaultValue !== after.defaultValue;
      if (JSON.stringify(beforeShape) !== JSON.stringify(afterShape) || defaultChanged) {
        variableChanges.push({
          name,
          change: 'CHANGED',
          before: beforeShape,
          after: afterShape,
          defaultChanged,
        });
      }
    }
  }

  const beforeSources = arrayIdentity(previous.sourceBindings, item => item.sourceId);
  const afterSources = arrayIdentity(next.sourceBindings, item => item.sourceId);
  const sourceIds = [...new Set([...beforeSources.keys(), ...afterSources.keys()])].sort();
  const sourceChanges = sourceIds.flatMap(sourceId => {
    const before = beforeSources.get(sourceId);
    const after = afterSources.get(sourceId);
    if (!before) return [{ sourceId, change: 'ADDED', after }];
    if (!after) return [{ sourceId, change: 'REMOVED', before }];
    if (bindingKey(before) !== bindingKey(after)) return [{ sourceId, change: 'CHANGED', before, after }];
    return [];
  });

  return deepFreeze({
    schemaVersion: 1,
    assetId: previous.assetId,
    fromVersion: previous.version,
    toVersion: next.version,
    titleChanged: previous.title !== next.title,
    templateChanged: previous.template !== next.template,
    templateDiff: previous.template === next.template ? null : templateChangeWindow(previous.template, next.template),
    variableChanges,
    sourceChanges,
    cadenceChanged: JSON.stringify(previous.cadence) !== JSON.stringify(next.cadence),
    cadenceBefore: previous.cadence,
    cadenceAfter: next.cadence,
    changeSummary: next.changeSummary,
    changedAt: next.changedAt,
  });
}
