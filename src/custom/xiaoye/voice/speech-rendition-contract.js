const { normalizeVoiceMessage } = require("./contract")

const RENDITION_STATES = new Set(["synthesizing", "ready", "failed"])

function normalizeSpeechRendition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("speechRendition must be an object")
  }
  if (value.schemaVersion !== 1) throw new TypeError("speechRendition.schemaVersion must be 1")
  const status = String(value.status || "")
  if (!RENDITION_STATES.has(status)) throw new TypeError("speechRendition.status is not supported")
  const normalized = {
    schemaVersion: 1,
    status,
    activeGenerationId: value.activeGenerationId == null ? null : requiredToken(value.activeGenerationId, "speechRendition.activeGenerationId"),
  }
  if (value.asset != null) normalized.asset = normalizeAsset(value.asset)
  if (value.synthesis != null) normalized.synthesis = normalizeSynthesis(value.synthesis)
  if (status === "ready" && (!normalized.asset || !normalized.synthesis || !normalized.activeGenerationId)) {
    throw new TypeError("ready speechRendition requires active asset and synthesis")
  }
  if (status !== "ready") {
    if (normalized.asset && normalized.activeGenerationId) {
      // A failed regeneration may keep the previous active generation and asset.
      normalized.asset = normalizeAsset(normalized.asset)
    }
  }
  return normalized
}

function createSpeechRendition({ status = "synthesizing", asset = null, synthesis = null, activeGenerationId = null } = {}) {
  return normalizeSpeechRendition({
    schemaVersion: 1,
    status,
    ...(activeGenerationId ? { activeGenerationId } : {}),
    ...(asset ? { asset } : {}),
    ...(synthesis ? { synthesis } : {}),
  })
}

function normalizeAsset(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("speechRendition.asset must be an object")
  const relativePath = requiredText(value.relativePath, "speechRendition.asset.relativePath").replace(/\\/gu, "/")
  if (!relativePath.startsWith("threads/") || relativePath.includes("..") || relativePath.startsWith("/")) {
    throw new TypeError("speechRendition.asset.relativePath must be a thread voice path")
  }
  const sizeBytes = finitePositive(value.sizeBytes, "speechRendition.asset.sizeBytes")
  const durationMs = finitePositive(value.durationMs, "speechRendition.asset.durationMs")
  return {
    assetId: requiredToken(value.assetId, "speechRendition.asset.assetId"),
    relativePath,
    mimeType: requiredText(value.mimeType, "speechRendition.asset.mimeType"),
    sizeBytes: Math.round(sizeBytes),
    durationMs: Math.round(durationMs),
  }
}

function normalizeSynthesis(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("speechRendition.synthesis must be an object")
  return {
    provider: requiredText(value.provider, "speechRendition.synthesis.provider"),
    model: requiredText(value.model, "speechRendition.synthesis.model"),
    generationId: requiredToken(value.generationId, "speechRendition.synthesis.generationId"),
    sourceTextHash: requiredText(value.sourceTextHash, "speechRendition.synthesis.sourceTextHash"),
    voiceProfileVersion: requiredToken(value.voiceProfileVersion, "speechRendition.synthesis.voiceProfileVersion"),
    speechDeliveryPlanVersion: requiredToken(value.speechDeliveryPlanVersion, "speechRendition.synthesis.speechDeliveryPlanVersion"),
  }
}

function requiredToken(value, label) {
  const text = requiredText(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text)) throw new TypeError(`${label} must be a safe token`)
  return text
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value.trim()
}

function finitePositive(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be positive`)
  return value
}

module.exports = { RENDITION_STATES, createSpeechRendition, normalizeSpeechRendition }
