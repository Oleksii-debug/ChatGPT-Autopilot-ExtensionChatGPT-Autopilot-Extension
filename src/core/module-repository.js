import { createModuleSessionView, ensureSessionModuleState } from './module-workspaces.js';

function projectState(state, moduleId) {
  const projected = state;
  for (const [sessionId, root] of Object.entries(projected.sessionsById || {})) {
    ensureSessionModuleState(root);
    const view = createModuleSessionView(root, moduleId);
    if (view) projected.sessionsById[sessionId] = view;
  }
  return projected;
}

export class ModuleWorkspaceRepository {
  constructor(baseRepository, moduleId) {
    if (!baseRepository) throw new Error('Base repository required');
    this.base = baseRepository;
    this.moduleId = moduleId;
  }

  async load() {
    return projectState(await this.base.load(), this.moduleId);
  }

  async save(state) {
    throw new Error('ModuleWorkspaceRepository.save is intentionally unsupported; use update().');
  }

  async update(mutator) {
    const saved = await this.base.update(async draft => {
      const roots = { ...draft.sessionsById };
      const projected = {};
      for (const [sessionId, root] of Object.entries(roots)) {
        ensureSessionModuleState(root);
        projected[sessionId] = createModuleSessionView(root, this.moduleId) || root;
      }
      draft.sessionsById = projected;
      try {
        await mutator(draft);
      } finally {
        draft.sessionsById = roots;
      }
      return draft;
    });
    return projectState(saved, this.moduleId);
  }
}
