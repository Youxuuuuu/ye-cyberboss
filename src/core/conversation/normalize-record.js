const {
  ALLOWED_META_KEYS,
  validateConversationRecord,
} = require("./schema")
const { normalizeMediaList } = require("./normalize-media")
const { normalizeSource } = require("./normalize-source")
const { normalizeTimestamp, toShanghaiDate } = require("./normalize-time")

function normalizeConversationRecord(input = {}) {
  const timestamp = normalizeTimestamp(input.timestamp)
  const source = normalizeSource(input.source, {
    provider: input?.source?.provider,
    sourceType: input?.source?.sourceType,
    rawId: input?.source?.rawId,
    callId: input?.source?.callId,
    uuid: input?.source?.uuid,
    parentUuid: input?.source?.parentUuid,
    runtimeId: input.runtimeId,
    threadId: input.threadId,
    turnId: input.turnId,
    type: input.type,
    variant: input.variant,
    text: input.text,
  })
  const meta = normalizeMeta(input.meta, source.sourceKey)
  const record = {
    id: normalizeText(input.id) || source.sourceKey,
    type: normalizeText(input.type),
    timestamp,
    date: toShanghaiDate(timestamp),
    runtimeId: normalizeText(input.runtimeId),
    threadId: normalizeText(input.threadId),
    turnId: normalizeText(input.turnId),
    workspaceRoot: normalizeText(input.workspaceRoot),
    text: typeof input.text === "string" ? input.text.trim() : "",
    meta,
    source,
  }

  const errors = validateConversationRecord(record)
  if (errors.length) {
    throw new Error(errors.join("; "))
  }
  return record
}

function normalizeMeta(meta = {}, sourceKey = "") {
  const next = {}
  for (const key of Object.keys(meta || {})) {
    if (!ALLOWED_META_KEYS.has(key)) {
      continue
    }
    const value = meta[key]
    if (value == null) {
      continue
    }
    if (key === "attachments" || key === "files" || key === "stickers") {
      next[key] = normalizeMediaList(value)
      continue
    }
    if (key === "quote") {
      const normalizedQuote = normalizeQuote(value)
      if (normalizedQuote != null) {
        next.quote = normalizedQuote
      }
      continue
    }
    if (typeof value === "string") {
      const normalized = value.trim()
      if (normalized) {
        next[key] = normalized
      }
      continue
    }
    next[key] = value
  }

  if (!Array.isArray(next.attachments)) {
    next.attachments = []
  }
  if (!Array.isArray(next.files)) {
    next.files = []
  }
  if (!Array.isArray(next.stickers)) {
    next.stickers = []
  }
  next.sourceKey = sourceKey

  return next
}

function normalizeQuote(value) {
  if (typeof value === "string") {
    const normalized = value.trim()
    return normalized || null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const text = normalizeText(value.text)
  const title = normalizeText(value.title)
  if (!text && !title) {
    return null
  }
  return {
    ...(text ? { text } : {}),
    ...(title ? { title } : {}),
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  normalizeConversationRecord,
}
