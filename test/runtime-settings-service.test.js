const assert = require("node:assert/strict");
const test = require("node:test");

const { RuntimeSettingsService } = require("../src/core/runtime-settings-service");

function createHarness({
  runtimeId = "codex",
  params = { model: "model-a", modelProvider: "provider-a", effort: "high" },
  models = [],
  effortCapabilities = null,
} = {}) {
  let currentParams = { ...params };
  const updates = [];
  const events = [];
  const sessionStore = {
    getRuntimeParamsForWorkspace() {
      return { ...currentParams };
    },
    setRuntimeParamsForWorkspace(_bindingKey, _workspaceRoot, next) {
      currentParams = { ...currentParams, ...next };
      updates.push({ ...next });
      return currentParams;
    },
    getAvailableModelCatalog() {
      return { models, updatedAt: "2026-07-31T00:00:00.000Z", missingSuccessCounts: {} };
    },
  };
  const runtimeAdapter = {
    describe() {
      return { id: runtimeId, model: "", modelProvider: "" };
    },
    getSessionStore() {
      return sessionStore;
    },
    async listAvailableModels() {
      return {
        models,
        updatedAt: "2026-07-31T00:00:00.000Z",
        missingSuccessCounts: {},
        refreshing: false,
        stale: false,
        error: "",
        canRetry: false,
      };
    },
    async getEffortCapabilities({ model = "" } = {}) {
      if (effortCapabilities) {
        return effortCapabilities;
      }
      const selectedModel = models.find((item) => item.model === model);
      const options = Array.isArray(selectedModel?.supportedReasoningEfforts)
        ? selectedModel.supportedReasoningEfforts
        : [];
      return {
        supported: options.length > 0,
        options,
        defaultEffort: selectedModel?.defaultReasoningEffort || options[0] || "",
      };
    },
  };
  const service = new RuntimeSettingsService({
    runtimeAdapter,
    onUpdated(event) {
      events.push(event);
    },
  });
  return {
    service,
    updates,
    events,
    getParams: () => currentParams,
  };
}

test("switching models resets an incompatible Codex effort to the new model default", async () => {
  const harness = createHarness({
    models: [
      {
        model: "model-a",
        provider: "provider-a",
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
      },
      {
        model: "model-b",
        provider: "provider-b",
        supportedReasoningEfforts: ["low", "medium"],
        defaultReasoningEffort: "medium",
      },
    ],
  });

  const result = await harness.service.updateWorkspaceSettings({
    bindingKey: "binding-1",
    workspaceRoot: "D:/study/cyberboss",
    model: "model-b",
  });

  assert.deepEqual(harness.getParams(), {
    model: "model-b",
    modelProvider: "provider-b",
    effort: "medium",
  });
  assert.equal(result.effortReset, true);
  assert.equal(result.currentEffort, "medium");
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].kind, "runtime.settings.updated");
  assert.equal(harness.events[0].settings.currentModel, "model-b");
  assert.deepEqual(harness.events[0].settings.effort.options, ["low", "medium"]);
});

test("Codex effort options come from the selected model and an explicit supported effort persists", async () => {
  const harness = createHarness({
    models: [{
      model: "model-a",
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    }],
  });

  const result = await harness.service.updateWorkspaceSettings({
    bindingKey: "binding-1",
    workspaceRoot: "D:/study/cyberboss",
    effort: "low",
  });

  assert.equal(result.currentEffort, "low");
  assert.deepEqual(result.effort.options, ["low", "high"]);
});

test("Claude effort is hidden when the installed CLI does not support it", async () => {
  const harness = createHarness({
    runtimeId: "claudecode",
    params: { model: "claude-opus", modelProvider: "", effort: "" },
    models: [{ model: "claude-opus" }],
    effortCapabilities: {
      supported: false,
      options: [],
      defaultEffort: "",
    },
  });

  const result = await harness.service.getWorkspaceSettings({
    bindingKey: "binding-1",
    workspaceRoot: "D:/study/cyberboss",
  });

  assert.deepEqual(result.effort, {
    supported: false,
    options: [],
    defaultEffort: "",
  });
});

test("a current model missing from the catalog remains usable but a new unverified model is rejected", async () => {
  const harness = createHarness({
    params: { model: "missing-current", modelProvider: "", effort: "" },
    models: [{ model: "model-a" }],
  });
  const current = await harness.service.updateWorkspaceSettings({
    bindingKey: "binding-1",
    workspaceRoot: "D:/study/cyberboss",
    model: "missing-current",
  });
  assert.equal(current.currentModelStatus, "catalog-missing");

  await assert.rejects(
    () => harness.service.updateWorkspaceSettings({
      bindingKey: "binding-1",
      workspaceRoot: "D:/study/cyberboss",
      model: "invented-model",
    }),
    (error) => error?.code === "MODEL_NOT_FOUND" && error?.statusCode === 400,
  );
});
