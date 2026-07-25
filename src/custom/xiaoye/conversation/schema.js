const ALLOWED_RECORD_TYPES = new Set(["user", "assistant", "thinking", "operation"])

const ALLOWED_META_KEYS = new Set([
  "attachments",
  "command",
  "displayPath",
  "displayText",
  "files",
  "operationKind",
  "path",
  "pattern",
  "quote",
  "rawToolName",
  "relativePath",
  "resultSummary",
  "runtimeEvent",
  "runtimeId",
  "sourceKey",
  "stickers",
  "systemKind",
  "toolName",
  "toolResultPreview",
  "visibleAs",
  "messageId",
  "itemId",
  "requestId",
  "logicalTurnId",
  "displayTurnId",
  "transportTurnId",
  "canonicalTurnId",
  "bubbleSegments",
])

const ALLOWED_SOURCE_KEYS = new Set([
  "callId",
  "parentUuid",
  "provider",
  "rawId",
  "sourceFile",
  "sourceKey",
  "sourceLine",
  "sourceOrder",
  "sourceType",
  "uuid",
])

function validateConversationRecord(record) {
  const errors = []
  if (!record || typeof record !== "object") {
    return ["record must be an object"]
  }

  if (!ALLOWED_RECORD_TYPES.has(String(record.type || "").trim())) {
    errors.push("record.type must be user, assistant, thinking, or operation")
  }

  for (const key of [
    "id",
    "timestamp",
    "date",
    "runtimeId",
    "threadId",
    "turnId",
    "workspaceRoot",
    "text",
    "messageId",
    "itemId",
    "sourceKey",
  ]) {
    if (typeof record[key] !== "string") {
      errors.push(`record.${key} must be a string`)
    }
  }

  if (!isIsoTimestamp(record.timestamp)) {
    errors.push("record.timestamp must be a valid ISO timestamp")
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(record.date || ""))) {
    errors.push("record.date must use YYYY-MM-DD")
  }

  if (!record.meta || typeof record.meta !== "object" || Array.isArray(record.meta)) {
    errors.push("record.meta must be an object")
  }
  if (!record.source || typeof record.source !== "object" || Array.isArray(record.source)) {
    errors.push("record.source must be an object")
  }

  const sourceKey = normalizeText(record?.source?.sourceKey)
  if (!sourceKey) {
    errors.push("record.source.sourceKey is required")
  }
  if (normalizeText(record?.meta?.sourceKey) !== sourceKey) {
    errors.push("record.meta.sourceKey must match record.source.sourceKey")
  }

  return errors
}

function isIsoTimestamp(value) {
  const normalized = normalizeText(value)
  if (!normalized) {
    return false
  }
  return !Number.isNaN(new Date(normalized).getTime())
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  ALLOWED_META_KEYS,
  ALLOWED_RECORD_TYPES,
  ALLOWED_SOURCE_KEYS,
  validateConversationRecord,
}
