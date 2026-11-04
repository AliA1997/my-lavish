import { sessionKey } from "./session-store.js";
import { projectName } from "./project.js";

/** At most this many projects are remembered; the least recently seen goes first. */
export const MAX_PROJECTS = 50;

export const PROJECT_KEY = /^[0-9a-f]{16}$/;
export const isProjectKey = (k) => typeof k === "string" && PROJECT_KEY.test(k);

const now = () => new Date().toISOString();

function projectsOf(state) {
  if (!state.projects || typeof state.projects !== "object" || Array.isArray(state.projects)) state.projects = {};
  return state.projects;
}

const view = (p) => ({ key: p.key, root: p.root, name: p.name, registered_at: p.registered_at, last_seen_at: p.last_seen_at });

/** Adds a project root (already checked with findProjectRoot) or marks it seen again. Returns the record. */
export function registerProject(store, root) {
  const key = sessionKey(root);
  return store.transact(async (state) => {
    const projects = projectsOf(state);
    const at = now();
    const existing = Object.hasOwn(projects, key) ? projects[key] : null;
    const record = existing ?? { key, root, name: projectName(root), registered_at: at };
    record.root = root;
    record.name = projectName(root);
    record.last_seen_at = at;
    projects[key] = record;
    const keys = Object.keys(projects);
    if (keys.length > MAX_PROJECTS) {
      keys
        .sort((a, b) => String(projects[a].last_seen_at ?? "").localeCompare(String(projects[b].last_seen_at ?? "")))
        .slice(0, keys.length - MAX_PROJECTS)
        .forEach((k) => {
          if (k !== key) delete projects[k];
        });
    }
    return [view(record), true];
  });
}

/** One registered project by key, or null. Keys are pattern-checked, so "__proto__" is never looked up. */
export function getProject(store, key) {
  if (!isProjectKey(key)) return Promise.resolve(null);
  return store.transact(async (state) => {
    const projects = state.projects && typeof state.projects === "object" ? state.projects : {};
    return [Object.hasOwn(projects, key) ? view(projects[key]) : null, false];
  });
}

/** Registered projects, most recently seen first. */
export function listProjects(store, { limit = MAX_PROJECTS } = {}) {
  return store.transact(async (state) => {
    const projects = state.projects && typeof state.projects === "object" ? Object.values(state.projects) : [];
    const list = projects
      .filter((p) => p && isProjectKey(p.key) && typeof p.root === "string")
      .sort((a, b) => String(b.last_seen_at ?? "").localeCompare(String(a.last_seen_at ?? "")))
      .slice(0, limit)
      .map(view);
    return [list, false];
  });
}
