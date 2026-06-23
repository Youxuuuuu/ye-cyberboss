const crypto = require("crypto")

const { ALLOWED_SOURCE_KEYS } = require("./schema")

function normalizeSource(source = {}, extra = {}) {
  const next = pickAllowedKeys({
    provider: normalizeText(source.provider) || normalizeText(extra.provider) || "import",
    sourceType: normalizeText(source.sourceType) || normalizeText(extra.sourceType) || "unknown",
    sourceFile: normalizeText(source.sourceFile),
    sourceLine: normalizePositiveInt(source.sourceLine),
    sourceKey: normalizeText(source.sourceKey),
    rawId: normalizeText(source.rawId) || normalizeText(extra.rawId),
    callId: normalizeText(source.callId) || normalizeText(extra.callId),
    uuid: normalizeText(source.uuid) || normalizeText(extra.uuid),
    parentUuid: normalizeText(source.parentUuid) || normalizeText(extra.parentUuid),
  }, ALLOWED_SOURCE_KEYS)

  if (!next.sourceKey) {
    next.sourceKey = buildSourceKey(next, extra)
  }

  return next
}

function buildSourceKey(source = {}, extra = {}) {
  const payload = [
    normalizeText(source.provider),
    normalizeText(source.sourceType),
    normalizeText(source.sourceFile),
    normalizePositiveInt(source.sourceLine),
    normalizeText(source.rawId),
    normalizeText(source.callId),
    normalizeText(source.uuid),
    normalizeText(source.parentUuid),
    normalizeText(extra.runtimeId),
    normalizeText(extra.threadId),
    normalizeText(extra.turnId),
    normalizeText(extra.type),
    normalizeText(extra.variant),
    normalizeText(extra.text),
  ].join("|")

  return `${normalizeText(source.provider) || "source"}:${crypto.createHash("sha1").update(payload).digest("hex")}`
}

function pickAllowedKeys(input, allowedKeys) {
  const output = {}
  for (const key of Object.keys(input || {})) {
    if (!allowedKeys.has(key)) {
      continue
    }
    const value = input[key]
    if (value === "" || value == null) {
      continue
    }
    output[key] = value
  }
  return output
}

function normalizePositiveInt(value) {
  const parsed = Number.parseInt(String(value || ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  buildSourceKey,
  normalizeSource,
}
