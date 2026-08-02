const { normalizeModelCatalog } = require("./model-catalog");

const DEFAULT_MISSING_SUCCESS_LIMIT = 3;

function reconcileModelCatalog(previousCatalog = {}, incomingModels = [], options = {}) {
  const previousModels = normalizeModelCatalog(previousCatalog.models);
  const normalizedIncoming = normalizeModelCatalog(incomingModels);
  const missingLimit = positiveInteger(options.missingSuccessLimit) || DEFAULT_MISSING_SUCCESS_LIMIT;
  const previousCounts = normalizeMissingCounts(previousCatalog.missingSuccessCounts);
  const incomingKeys = new Set(normalizedIncoming.map(modelKey));
  const nextCounts = {};
  const retainedMissing = [];

  for (const model of previousModels) {
    const key = modelKey(model);
    if (!key || incomingKeys.has(key)) {
      continue;
    }
    const nextCount = (previousCounts[key] || 0) + 1;
    if (nextCount < missingLimit) {
      nextCounts[key] = nextCount;
      retainedMissing.push(model);
    }
  }

  return {
    models: normalizeModelCatalog([...normalizedIncoming, ...retainedMissing]),
    updatedAt: normalizeText(options.refreshedAt) || new Date().toISOString(),
    missingSuccessCounts: nextCounts,
  };
}

function normalizeMissingCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result = {};
  for (const [rawKey, rawCount] of Object.entries(value)) {
    const key = normalizeText(rawKey).toLowerCase();
    const count = positiveInteger(rawCount);
    if (key && count) {
      result[key] = count;
    }
  }
  return result;
}

function modelKey(model) {
  return normalizeText(model?.model || model?.id).toLowerCase();
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DEFAULT_MISSING_SUCCESS_LIMIT,
  reconcileModelCatalog,
};
