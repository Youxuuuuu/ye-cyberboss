const { findModelByQuery, normalizeModelCatalog } = require("../adapters/runtime/shared/model-catalog");

class RuntimeSettingsService {
  constructor({ runtimeAdapter, onUpdated = null } = {}) {
    if (!runtimeAdapter || typeof runtimeAdapter.getSessionStore !== "function") {
      throw new Error("RuntimeSettingsService requires runtimeAdapter");
    }
    this.runtimeAdapter = runtimeAdapter;
    this.onUpdated = typeof onUpdated === "function" ? onUpdated : null;
  }

  async getWorkspaceSettings({
    bindingKey,
    workspaceRoot,
    refreshCatalog = false,
    waitForCatalogRefresh = false,
  } = {}) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const catalog = typeof this.runtimeAdapter.listAvailableModels === "function"
      ? await this.runtimeAdapter.listAvailableModels({
          refresh: refreshCatalog,
          waitForRefresh: waitForCatalogRefresh,
        })
      : sessionStore.getAvailableModelCatalog() || emptyCatalog();
    const runtime = this.runtimeAdapter.describe?.() || {};
    const stored = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    const currentModel = normalizeText(stored.model) || normalizeText(runtime.model);
    const currentModelProvider = normalizeText(stored.modelProvider) || normalizeText(runtime.modelProvider);
    const models = normalizeModelCatalog(catalog?.models);
    const selectedModel = findModelByQuery(models, currentModel);
    const effort = await this.resolveEffortCapabilities({
      selectedModel,
    });
    const missingSuccessCounts = normalizeMissingCounts(catalog?.missingSuccessCounts);

    return {
      runtime: normalizeText(runtime.id),
      currentModel,
      currentModelProvider,
      currentModelStatus: resolveCurrentModelStatus({
        currentModel,
        selectedModel,
        catalog,
      }),
      currentEffort: normalizeText(stored.effort),
      models: models.map((model) => ({
        ...model,
        catalogStatus: missingSuccessCounts[modelKey(model)] ? "stale" : "available",
      })),
      effort,
      updatedAt: normalizeText(catalog?.updatedAt),
      refreshing: Boolean(catalog?.refreshing),
      stale: Boolean(catalog?.stale),
      error: normalizeText(catalog?.error),
      canRetry: Boolean(catalog?.canRetry),
    };
  }

  async updateWorkspaceSettings({
    bindingKey,
    workspaceRoot,
    model,
    modelProvider,
    effort,
    senderId = "",
    threadId = "",
  } = {}) {
    const before = await this.getWorkspaceSettings({
      bindingKey,
      workspaceRoot,
      refreshCatalog: true,
      waitForCatalogRefresh: true,
    });
    const hasModel = model !== undefined;
    const hasEffort = effort !== undefined;
    const requestedModel = normalizeText(model);
    let selectedModel = findModelByQuery(before.models, requestedModel || before.currentModel);

    if (hasModel && requestedModel) {
      if (!selectedModel && requestedModel.toLowerCase() !== before.currentModel.toLowerCase()) {
        throw settingsError(`model not found: ${requestedModel}`, "MODEL_NOT_FOUND");
      }
    } else {
      selectedModel = findModelByQuery(before.models, before.currentModel);
    }

    const nextModel = hasModel && requestedModel ? selectedModel?.model || before.currentModel : before.currentModel;
    const nextProvider = selectedModel?.provider
      || normalizeText(modelProvider)
      || before.currentModelProvider;
    const nextCapabilities = await this.resolveEffortCapabilities({
      selectedModel,
    });
    const requestedEffort = normalizeEffort(effort);
    let nextEffort = before.currentEffort;
    let effortReset = false;

    if (hasEffort) {
      if (!isSupportedEffort(requestedEffort, nextCapabilities)) {
        throw settingsError(`effort not supported: ${requestedEffort || "default"}`, "EFFORT_NOT_SUPPORTED");
      }
      nextEffort = requestedEffort;
    } else if (!isSupportedEffort(nextEffort, nextCapabilities)) {
      nextEffort = normalizeText(nextCapabilities.defaultEffort);
      effortReset = nextEffort !== before.currentEffort;
    }

    const sessionStore = this.runtimeAdapter.getSessionStore();
    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      model: nextModel,
      modelProvider: nextProvider,
      effort: nextEffort,
    });

    const after = await this.getWorkspaceSettings({
      bindingKey,
      workspaceRoot,
      refreshCatalog: false,
    });
    const event = {
      kind: "runtime.settings.updated",
      senderId: normalizeText(senderId),
      threadId: normalizeText(threadId),
      runtime: after.runtime,
      model: after.currentModel,
      modelProvider: after.currentModelProvider,
      effort: after.currentEffort,
      effortReset,
      settings: after,
    };
    if (this.onUpdated) {
      await this.onUpdated(event);
    }
    return {
      ...after,
      effortReset,
    };
  }

  async resolveEffortCapabilities({ selectedModel } = {}) {
    if (typeof this.runtimeAdapter.getEffortCapabilities !== "function") {
      return {
        supported: false,
        options: [],
        defaultEffort: "",
      };
    }
    const capabilities = await this.runtimeAdapter.getEffortCapabilities({
      model: normalizeText(selectedModel?.model || selectedModel?.id),
    });
    const options = normalizeEffortOptions(capabilities?.options);
    return {
      supported: Boolean(capabilities?.supported) && options.length > 0,
      options,
      defaultEffort: normalizeText(capabilities?.defaultEffort).toLowerCase(),
    };
  }
}

function isSupportedEffort(effort, capabilities) {
  if (!capabilities?.supported) {
    return !effort;
  }
  if (!effort) {
    return true;
  }
  return capabilities.options.includes(effort);
}

function normalizeEffort(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === "default" ? "" : normalized;
}

function normalizeEffortOptions(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(new Set(values.map(normalizeEffort).filter(Boolean)));
}

function resolveCurrentModelStatus({ currentModel, selectedModel, catalog }) {
  if (!currentModel) {
    return "unknown";
  }
  if (selectedModel) {
    return "available";
  }
  if (!normalizeText(catalog?.updatedAt) && (!Array.isArray(catalog?.models) || catalog.models.length === 0)) {
    return "catalog-unloaded";
  }
  return "catalog-missing";
}

function normalizeMissingCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result = {};
  for (const [key, count] of Object.entries(value)) {
    const normalizedKey = normalizeText(key).toLowerCase();
    if (normalizedKey && Number(count) > 0) {
      result[normalizedKey] = Number(count);
    }
  }
  return result;
}

function modelKey(model) {
  return normalizeText(model?.model || model?.id).toLowerCase();
}

function emptyCatalog() {
  return {
    models: [],
    updatedAt: "",
    missingSuccessCounts: {},
    refreshing: false,
    stale: true,
    error: "",
    canRetry: false,
  };
}

function settingsError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { RuntimeSettingsService };
