export const L3_DRIVE_FOLDER_FIXTURES = Object.freeze({
  validDirectorToManagers: {
    sourceId: 'folder_director_dispatch',
    groupNodeId: 'director',
    maxWorkers: 2,
    childNodeIds: ['manager:runtime', 'manager:science'],
    childPromptProfileIds: {
      'manager:runtime': ['manager:runtime:prompt-v1'],
      'manager:science': ['manager:science:prompt-v1'],
    },
    generations: [{ id: 'g101', name: 'generation-000101' }],
    entries: [
      { id: 'ready101', name: 'READY', version: '1', mimeType: 'text/plain', size: '0' },
      { id: 'runtime101', name: 'runtime.json', version: '4', mimeType: 'application/json', size: '160' },
      { id: 'science101', name: 'science.json', version: '5', mimeType: 'application/json', size: '180' },
    ],
    contents: {
      runtime101: JSON.stringify({
        schema_version: 1,
        parent_node_id: 'director',
        generation: 101,
        target_child_id: 'manager:runtime',
        prompt: 'Reconcile live runtime truth and execute the next bounded runtime domain slice.',
        order: 1,
      }),
      science101: JSON.stringify({
        schema_version: 1,
        parent_node_id: 'director',
        generation: 101,
        target_child_id: 'manager:science',
        prompt_profile_id: 'manager:science:prompt-v1',
        order: 2,
      }),
    },
    expectedTargets: ['manager:runtime', 'manager:science'],
  },

  validManagerToWorkers: {
    sourceId: 'folder_runtime_dispatch',
    groupNodeId: 'manager:runtime',
    maxWorkers: 3,
    childNodeIds: ['worker:runtime:01', 'worker:runtime:02', 'worker:runtime:03'],
    childPromptProfileIds: {
      'worker:runtime:01': ['worker:runtime:01:prompt-v1'],
      'worker:runtime:02': ['worker:runtime:02:prompt-v1'],
      'worker:runtime:03': ['worker:runtime:03:prompt-v1'],
    },
    generations: [{ id: 'g41', name: 'generation-000041' }],
    entries: [
      { id: 'ready41', name: 'READY', version: '3', mimeType: 'text/plain', size: '0' },
      { id: 'w1', name: 'worker-01.json', version: '8', mimeType: 'application/json', size: '140' },
      { id: 'w2', name: 'worker-02.json', version: '9', mimeType: 'application/json', size: '140' },
    ],
    contents: {
      w1: JSON.stringify({
        schema_version: 1,
        parent_node_id: 'manager:runtime',
        generation: 41,
        target_child_id: 'worker:runtime:01',
        prompt: 'Implement bounded runtime slice A.',
        order: 20,
      }),
      w2: JSON.stringify({
        schema_version: 1,
        parent_node_id: 'manager:runtime',
        generation: 41,
        target_child_id: 'worker:runtime:02',
        prompt_profile_id: 'worker:runtime:02:prompt-v1',
        order: 10,
      }),
    },
    expectedTargets: ['worker:runtime:02', 'worker:runtime:01'],
  },

  malformedEnvelope: {
    base: 'validManagerToWorkers',
    contentsPatch: {
      w1: '{"schema_version":1,"parent_node_id":"manager:runtime"',
    },
    expectedError: 'INVALID_DISPATCH_FILE',
  },

  duplicateSlot: {
    base: 'validManagerToWorkers',
    contentsPatch: {
      w2: JSON.stringify({
        schema_version: 1,
        parent_node_id: 'manager:runtime',
        generation: 41,
        target_child_id: 'worker:runtime:01',
        prompt: 'Conflicting duplicate slot payload.',
        order: 10,
      }),
    },
    expectedError: 'DUPLICATE_TARGET',
  },

  wrongParent: {
    base: 'validManagerToWorkers',
    contentsPatch: {
      w1: JSON.stringify({
        schema_version: 1,
        parent_node_id: 'manager:science',
        generation: 41,
        target_child_id: 'worker:runtime:01',
        prompt: 'Wrong parent.',
      }),
    },
    expectedError: 'WRONG_PARENT',
  },

  partialUnready: {
    base: 'validManagerToWorkers',
    entriesFilter: ['w1', 'w2'],
    expectedKind: 'NOT_READY',
  },

  samePromptGeneration41: {
    sourceId: 'folder_same_prompt',
    groupNodeId: 'manager:runtime',
    maxWorkers: 1,
    childNodeIds: ['worker:runtime:01'],
    childPromptProfileIds: { 'worker:runtime:01': ['worker:runtime:01:prompt-v1'] },
    generations: [{ id: 'g41same', name: 'generation-000041' }],
    entries: [
      { id: 'readySame41', name: 'READY', version: '1', mimeType: 'text/plain', size: '0' },
      { id: 'same41', name: 'worker.json', version: '2', mimeType: 'application/json', size: '120' },
    ],
    contents: {
      same41: JSON.stringify({
        schema_version: 1,
        parent_node_id: 'manager:runtime',
        generation: 41,
        target_child_id: 'worker:runtime:01',
        prompt: 'Identical prompt payload across generations.',
      }),
    },
  },

  samePromptGeneration45: {
    sourceId: 'folder_same_prompt',
    groupNodeId: 'manager:runtime',
    maxWorkers: 1,
    childNodeIds: ['worker:runtime:01'],
    childPromptProfileIds: { 'worker:runtime:01': ['worker:runtime:01:prompt-v1'] },
    generations: [{ id: 'g45same', name: 'generation-000045' }],
    entries: [
      { id: 'readySame45', name: 'READY', version: '1', mimeType: 'text/plain', size: '0' },
      { id: 'same45', name: 'worker.json', version: '2', mimeType: 'application/json', size: '120' },
    ],
    contents: {
      same45: JSON.stringify({
        schema_version: 1,
        parent_node_id: 'manager:runtime',
        generation: 45,
        target_child_id: 'worker:runtime:01',
        prompt: 'Identical prompt payload across generations.',
      }),
    },
  },
});
