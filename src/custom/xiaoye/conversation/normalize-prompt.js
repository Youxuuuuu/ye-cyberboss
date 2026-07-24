const { normalizeConversationRecord } = require("./normalize-record")
const { normalizeTimestamp, stripBracketTimestampPrefix } = require("./normalize-time")

const SYSTEM_COMPACT_DISPLAY_TEXT = "宝宝大王系统巡游"

function classifyConversationPromptVisibility(text, context = {}) {
  const normalized = normalizeText(text)
  const candidate = stripBracketTimestampPrefix(normalized).text

  if (!candidate) {
    return {
      action: "keep",
      systemKind: "",
      displayText: "",
    }
  }

  if (candidate.startsWith("WECHAT SESSION INSTRUCTIONS")) {
    return {
      action: "drop",
      systemKind: "",
      displayText: "",
    }
  }

  if (candidate.startsWith("SYSTEM ACTION MODE")) {
    return {
      action: "system_compact",
      systemKind: "action_mode",
      displayText: SYSTEM_COMPACT_DISPLAY_TEXT,
      sourceType: `${normalizeText(context.runtimeId) || normalizeText(context.provider) || "conversation"}.system_action_mode`,
    }
  }

  if (looksSyntheticCodexContext(candidate)) {
    return {
      action: "drop",
      systemKind: "",
      displayText: "",
    }
  }

  return {
    action: "keep",
    systemKind: "",
    displayText: "",
  }
}

function buildConversationUserRecord({
  text = "",
  timestamp = "",
  runtimeId = "",
  threadId = "",
  turnId = "",
  workspaceRoot = "",
  meta = {},
  source = {},
  defaultSourceType = "",
  systemCompactSourceType = "",
  context = {},
} = {}) {
  const stamped = stripBracketTimestampPrefix(text)
  const extractedQuote = extractConversationQuote(stamped.text)
  const candidateText = normalizeText(extractedQuote.text)
  const visibility = classifyConversationPromptVisibility(candidateText, {
    runtimeId,
    provider: source?.provider,
    ...context,
  })

  if (visibility.action === "drop" || isApprovalReply(candidateText)) {
    return null
  }

  const normalizedMeta = normalizeMeta(meta)
  const hasVisiblePayload = Boolean(candidateText)
    || hasMediaItems(normalizedMeta.attachments)
    || hasMediaItems(normalizedMeta.files)
    || hasMediaItems(normalizedMeta.stickers)

  if (visibility.action === "keep" && !hasVisiblePayload) {
    return null
  }

  const recordText = visibility.action === "system_compact" ? "" : candidateText
  const nextSourceType = visibility.action === "system_compact"
    ? normalizeText(systemCompactSourceType || visibility.sourceType)
    : normalizeText(source?.sourceType || defaultSourceType)

  return normalizeConversationRecord({
    type: "user",
    timestamp: stamped.timestamp || normalizeTimestamp(timestamp),
    runtimeId,
    threadId,
    turnId,
    workspaceRoot,
    text: recordText,
    meta: {
      ...(extractedQuote.quote && normalizedMeta.quote == null ? { quote: extractedQuote.quote } : {}),
      ...normalizedMeta,
      ...(visibility.action === "system_compact" ? {
        visibleAs: "system_compact",
        displayText: visibility.displayText || SYSTEM_COMPACT_DISPLAY_TEXT,
        systemKind: visibility.systemKind || "action_mode",
      } : {}),
    },
    source: {
      ...source,
      sourceType: nextSourceType,
    },
  })
}

function hasMediaItems(items) {
  return Array.isArray(items) && items.length > 0
}

function normalizeMeta(meta) {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {}
}

function extractConversationQuote(text) {
  const normalized = String(text || "").trim()
  const match = normalized.match(/^\[Quoted:\s*([\s\S]*?)\]\s*(?:\r?\n+)?([\s\S]*)$/u)
  if (!match) {
    return {
      text: normalized,
      quote: undefined,
    }
  }
  return {
    text: normalizeText(match[2]),
    quote: normalizeText(match[1]) || undefined,
  }
}

function isApprovalReply(text) {
  return /^\/(?:yes|always|no)\b/iu.test(normalizeText(text))
}

function looksSyntheticCodexContext(text = "") {
  const normalized = normalizeText(text)
  return normalized.startsWith("<environment_context>")
    || normalized.startsWith("<permissions instructions>")
    || normalized.startsWith("The following is the Codex agent history")
    || normalized.startsWith("Saved attachments:")
    || normalized.startsWith("Visual context:")
    || normalized.startsWith("Visual context from attachments:")
    || normalized.includes(">>> TRANSCRIPT START")
    || normalized.includes(">>> TRANSCRIPT DELTA START")
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  buildConversationUserRecord,
  classifyConversationPromptVisibility,
  extractConversationQuote,
  isApprovalReply,
  SYSTEM_COMPACT_DISPLAY_TEXT,
}
