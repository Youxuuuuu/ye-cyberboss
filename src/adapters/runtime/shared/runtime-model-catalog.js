const { normalizeModelCatalog } = require("./model-catalog");
const { reconcileModelCatalog } = require("./model-catalog-reconciler");

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_DELAYS_MS = [250, 1_000];
const SAFE_REFRESH_ERROR = "模型目录暂时无法刷新";

class RuntimeModelCatalog {
  constructor({
    sessionStore,
    fetchModels,
    ttlMs = DEFAULT_TTL_MS,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    now = () => Date.now(),
  } = {}) {
    if (!sessionStore || typeof sessionStore.getAvailableModelCatalog !== "function") {
      throw new Error("RuntimeModelCatalog requires sessionStore");
    }
    if (typeof fetchModels !== "function") {
      throw new Error("RuntimeModelCatalog requires fetchModels");
    }
    this.sessionStore = sessionStore;
    this.fetchModels = fetchModels;
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.retryDelaysMs = Array.isArray(retryDelaysMs)
      ? retryDelaysMs.map((value) => Math.max(0, Number(value) || 0))
      : DEFAULT_RETRY_DELAYS_MS;
    this.now = now;
    this.inFlight = null;
    this.lastError = "";
  }

  async list({ refresh = false, waitForRefresh = false } = {}) {
    const stored = this.sessionStore.getAvailableModelCatalog();
    if (!refresh && stored && this.isFresh(stored.updatedAt)) {
      return this.buildSnapshot(stored);
    }
    this.startRefresh();
    if (stored && !waitForRefresh) {
      return this.buildSnapshot(stored, { refreshing: true });
    }
    await this.waitForRefresh();
    return this.buildSnapshot(this.sessionStore.getAvailableModelCatalog());
  }

  waitForRefresh() {
    return this.inFlight || Promise.resolve();
  }

  startRefresh() {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.refreshWithRetry()
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  async refreshWithRetry() {
    const delays = [0, ...this.retryDelaysMs];
    let error = null;
    let partialCandidate = null;
    for (let index = 0; index < delays.length; index += 1) {
      if (index > 0) {
        await wait(delays[index]);
      }
      try {
        const fetched = normalizeModelCatalog(await this.fetchModels());
        if (fetched.length === 0) {
          throw new Error("runtime model catalog refresh returned no models");
        }
        const previous = this.sessionStore.getAvailableModelCatalog() || {};
        if (hasMissingPreviousModel(previous.models, fetched) && index < delays.length - 1) {
          partialCandidate = fetched;
          error = null;
          continue;
        }
        this.persistSuccessfulRefresh(previous, fetched);
        this.lastError = "";
        return;
      } catch (candidate) {
        error = candidate;
      }
    }
    if (partialCandidate) {
      const previous = this.sessionStore.getAvailableModelCatalog() || {};
      this.persistSuccessfulRefresh(previous, partialCandidate);
      this.lastError = "";
      return;
    }
    this.lastError = error ? SAFE_REFRESH_ERROR : "";
  }

  persistSuccessfulRefresh(previous, fetched) {
    const updatedAt = new Date(this.now()).toISOString();
    const reconciled = reconcileModelCatalog(previous, fetched, { refreshedAt: updatedAt });
    this.sessionStore.setAvailableModelCatalog(reconciled.models, {
      updatedAt: reconciled.updatedAt,
      missingSuccessCounts: reconciled.missingSuccessCounts,
      allowEmpty: true,
    });
  }

  buildSnapshot(stored, { refreshing = Boolean(this.inFlight) } = {}) {
    const models = normalizeModelCatalog(stored?.models);
    const updatedAt = normalizeText(stored?.updatedAt);
    return {
      models,
      updatedAt,
      missingSuccessCounts: normalizeMissingCounts(stored?.missingSuccessCounts),
      refreshing,
      stale: !updatedAt || !this.isFresh(updatedAt) || Boolean(this.lastError),
      error: this.lastError,
      canRetry: Boolean(this.lastError),
    };
  }

  isFresh(updatedAt) {
    const timestamp = Date.parse(normalizeText(updatedAt));
    return Number.isFinite(timestamp) && this.now() - timestamp < this.ttlMs;
  }
}

function normalizeMissingCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result = {};
  for (const [key, count] of Object.entries(value)) {
    const normalizedKey = normalizeText(key).toLowerCase();
    const normalizedCount = Number(count);
    if (normalizedKey && Number.isSafeInteger(normalizedCount) && normalizedCount > 0) {
      result[normalizedKey] = normalizedCount;
    }
  }
  return result;
}

function hasMissingPreviousModel(previousModels, incomingModels) {
  const incomingKeys = new Set(
    normalizeModelCatalog(incomingModels)
      .map((model) => normalizeText(model.model || model.id).toLowerCase())
      .filter(Boolean),
  );
  return normalizeModelCatalog(previousModels).some((model) => {
    const key = normalizeText(model.model || model.id).toLowerCase();
    return key && !incomingKeys.has(key);
  });
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { RuntimeModelCatalog, SAFE_REFRESH_ERROR };
