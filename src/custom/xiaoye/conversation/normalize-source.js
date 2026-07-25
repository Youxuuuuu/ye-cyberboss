const crypto = require("crypto")

const { ALLOWED_SOURCE_KEYS } = require("./schema")

function normalizeSource(source = {}, extra = {}) {
  const next = pickAllowedKeys({
    provider: normalizeText(source.provider) || normalizeText(extra.provider) || "import",
    sourceType: normalizeText(source.sourceType) || normalizeText(extra.sourceType) || "unknown",
    sourceFile: normalizeText(source.sourceFile),
    sourceLine: normalizePositiveInt(source.sourceLine),
    sourceOrder: normalizePositiveInt(source.sourceOrder),
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
  const provider = normalizeText(source.provider) || "source"
  const recordType = normalizeText(extra.type)
  const variant = normalizeText(extra.variant)
  const mediaKind = firstMediaKind(extra.meta)

  if (recordType === "operation" && normalizeText(source.callId)) {
    return [provider, normalizeText(extra.threadId), normalizeText(extra.turnId), normalizeText(source.callId), "operation"]
      .filter(Boolean)
      .join("|")
  }

  if (variant === "visible" && normalizeText(source.callId)) {
    return [provider, normalizeText(extra.threadId), normalizeText(extra.turnId), normalizeText(source.callId), "visible", mediaKind || "assistant"]
      .filter(Boolean)
      .join("|")
  }

  if (recordType === "user") {
    return [provider, normalizeText(source.sourceFile), normalizePositiveInt(source.sourceLine), normalizeText(source.rawId), "user"]
      .filter(Boolean)
      .join("|")
  }

  if (recordType === "assistant" || recordType === "thinking") {
    return [provider, normalizeText(source.sourceFile), normalizePositiveInt(source.sourceLine), normalizeText(source.rawId), recordType]
      .filter(Boolean)
      .join("|")
  }

  const payload = [
    provider,
    normalizeText(source.sourceFile),
    normalizePositiveInt(source.sourceLine),
    normalizeText(source.rawId),
    normalizeText(source.callId),
    normalizeText(source.uuid),
    normalizeText(source.parentUuid),
    normalizeText(extra.threadId),
    normalizeText(extra.turnId),
    recordType,
    variant,
    normalizeText(extra.text),
  ].join("|")

  return `${provider}:${crypto.createHash("sha1").update(payload).digest("hex")}`
}

function firstMediaKind(meta = {}) {
  const attachments = Array.isArray(meta?.attachments) ? meta.attachments : []
  const files = Array.isArray(meta?.files) ? meta.files : []
  const stickers = Array.isArray(meta?.stickers) ? meta.stickers : []
  const first = attachments[0] || stickers[0] || files[0] || null
  return normalizeText(first?.kind || first?.type)
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
