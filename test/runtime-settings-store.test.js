const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SessionStore } = require("../src/adapters/runtime/codex/session-store");

function createStore(runtimeId, filePath = "") {
  const root = filePath
    ? path.dirname(filePath)
    : fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-runtime-settings-"));
  return new SessionStore({
    filePath: filePath || path.join(root, "sessions.json"),
    runtimeId,
  });
}

test("workspace runtime params persist effort and remain isolated by runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-runtime-effort-"));
  const filePath = path.join(root, "sessions.json");
  const codex = createStore("codex", filePath);
  codex.setRuntimeParamsForWorkspace("binding-1", "D:\\study\\cyberboss", {
    model: "gpt-5.6-codex",
    modelProvider: "openai",
    effort: "high",
  });
  const claude = createStore("claudecode", filePath);
  claude.setRuntimeParamsForWorkspace("binding-1", "D:\\study\\cyberboss", {
    model: "claude-opus-4-6",
    effort: "max",
  });

  assert.deepEqual(createStore("codex", filePath).getRuntimeParamsForWorkspace(
    "binding-1",
    "D:\\study\\cyberboss",
  ), {
    model: "gpt-5.6-codex",
    modelProvider: "openai",
    effort: "high",
  });
  assert.deepEqual(createStore("claudecode", filePath).getRuntimeParamsForWorkspace(
    "binding-1",
    "D:\\study\\cyberboss",
  ), {
    model: "claude-opus-4-6",
    modelProvider: "",
    effort: "max",
  });
});

test("model catalogs are runtime-scoped and preserve reconciliation metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-runtime-catalog-"));
  const filePath = path.join(root, "sessions.json");
  const codex = createStore("codex", filePath);
  codex.setAvailableModelCatalog([{
    model: "gpt-5.6-codex",
    provider: "openai",
    supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
  }], {
    missingSuccessCounts: { "old-model": 2 },
    updatedAt: "2026-07-31T01:00:00.000Z",
  });
  const claude = createStore("claudecode", filePath);
  claude.setAvailableModelCatalog([{
    model: "claude-opus-4-6",
    provider: "anthropic",
  }], {
    updatedAt: "2026-07-31T02:00:00.000Z",
  });

  assert.deepEqual(createStore("codex", filePath).getAvailableModelCatalog(), {
    models: [{
      id: "",
      model: "gpt-5.6-codex",
      displayName: "",
      provider: "openai",
      supportedReasoningEfforts: ["low", "high"],
      inputModalities: [],
      outputModalities: [],
      contextWindow: undefined,
      defaultReasoningEffort: "high",
      isDefault: false,
    }],
    updatedAt: "2026-07-31T01:00:00.000Z",
    missingSuccessCounts: { "old-model": 2 },
  });
  assert.deepEqual(
    createStore("claudecode", filePath).getAvailableModelCatalog().models.map((item) => item.model),
    ["claude-opus-4-6"],
  );
});
