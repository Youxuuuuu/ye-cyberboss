const fs = require("fs");
const path = require("path");
const { normalizeWorkspaceRoot } = require("../core/workspace-root");

class RuntimeContextStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { contextsByWorkspaceRoot: {} };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.contextsByWorkspaceRoot) {
        const nextState = normalizeRuntimeContextState(parsed);
        this.state = nextState;
        if (JSON.stringify(parsed) !== JSON.stringify(nextState)) {
          this.save();
        }
      }
    } catch {
      this.state = { contextsByWorkspaceRoot: {} };
    }
  }

  save() {
    this.state = normalizeRuntimeContextState(this.state);
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  setActiveContext({
    workspaceRoot = "",
    runtimeId = "",
    threadId = "",
    bindingKey = "",
    accountId = "",
    senderId = "",
    provider = "",
  } = {}) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }
    const next = {
      workspaceRoot: normalizedWorkspaceRoot,
      runtimeId: normalizeText(runtimeId),
      threadId: normalizeText(threadId),
      bindingKey: normalizeText(bindingKey),
      accountId: normalizeText(accountId),
      senderId: normalizeText(senderId),
      provider: normalizeText(provider),
      updatedAt: new Date().toISOString(),
    };
    this.state.contextsByWorkspaceRoot = {
      ...(this.state.contextsByWorkspaceRoot || {}),
      [normalizedWorkspaceRoot]: next,
    };
    this.save();
    return next;
  }

  resolveActiveContext({ workspaceRoot = "", runtimeId = "" } = {}) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (normalizedWorkspaceRoot) {
      const exact = this.state.contextsByWorkspaceRoot?.[normalizedWorkspaceRoot];
      if (exact) {
        return exact;
      }
    }

    const entries = Object.values(this.state.contextsByWorkspaceRoot || {})
      .filter((entry) => entry && typeof entry === "object");
    const normalizedRuntimeId = normalizeText(runtimeId);
    const scoped = normalizedRuntimeId
      ? entries.filter((entry) => normalizeText(entry.runtimeId) === normalizedRuntimeId)
      : entries;
    const sorted = scoped.sort((left, right) => {
      const leftMs = Date.parse(left.updatedAt || "") || 0;
      const rightMs = Date.parse(right.updatedAt || "") || 0;
      return rightMs - leftMs;
    });
    return sorted[0] || null;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRuntimeContextState(state) {
  const contextsByWorkspaceRoot = {};
  const source = state?.contextsByWorkspaceRoot && typeof state.contextsByWorkspaceRoot === "object"
    ? state.contextsByWorkspaceRoot
    : {};

  for (const [workspaceRoot, entry] of Object.entries(source)) {
    const normalizedEntry = normalizeRuntimeContextEntry({
      ...(entry && typeof entry === "object" ? entry : {}),
      workspaceRoot: entry?.workspaceRoot || workspaceRoot,
    });
    if (!normalizedEntry) {
      continue;
    }
    const current = contextsByWorkspaceRoot[normalizedEntry.workspaceRoot];
    if (!current || parseUpdatedAt(normalizedEntry.updatedAt) >= parseUpdatedAt(current.updatedAt)) {
      contextsByWorkspaceRoot[normalizedEntry.workspaceRoot] = normalizedEntry;
    }
  }

  return { contextsByWorkspaceRoot };
}

function normalizeRuntimeContextEntry(entry) {
  const workspaceRoot = normalizeWorkspaceRoot(entry?.workspaceRoot);
  if (!workspaceRoot) {
    return null;
  }
  return {
    workspaceRoot,
    runtimeId: normalizeText(entry?.runtimeId),
    threadId: normalizeText(entry?.threadId),
    bindingKey: normalizeText(entry?.bindingKey),
    accountId: normalizeText(entry?.accountId),
    senderId: normalizeText(entry?.senderId),
    provider: normalizeText(entry?.provider),
    updatedAt: normalizeText(entry?.updatedAt) || new Date(0).toISOString(),
  };
}

function parseUpdatedAt(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = { RuntimeContextStore };
