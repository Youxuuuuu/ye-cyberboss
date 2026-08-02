const {
  findModelByQuery,
  normalizeModelCatalog,
  normalizeText,
  resolveEffectiveModelForEffort,
} = require("../shared/model-catalog");

function extractModelCatalogFromListResponse(response) {
  const candidates = Array.isArray(response?.result?.data)
    ? response.result.data
    : Array.isArray(response?.data)
      ? response.data
      : [];
  return normalizeModelCatalog(candidates);
}

module.exports = {
  extractModelCatalogFromListResponse,
  findModelByQuery,
  normalizeModelCatalog,
  normalizeText,
  resolveEffectiveModelForEffort,
};
