const { CodexImportParser } = require("./codex-import")
const {
  buildOperationDescriptor,
  buildToolResultMeta,
  buildVisibleAssistantRecordFromResult,
} = require("../normalize-operation")
const { buildConversationUserRecord } = require("../normalize-prompt")
const { normalizeConversationRecord } = require("../normalize-record")
const { normalizeTimestamp } = require("../normalize-time")

class CodexRealtimeParser extends CodexImportParser {
  constructor() {
    super({ mode: "realtime" })
  }

  parseRaw({ raw, mappedEvent = null, workspaceRoot = "", sourceFile = "", sourceLine = 0, fallbackTimestamp = "" }) {
    if (raw?.method) {
      return this.parseRealtimeMethod({
        raw,
        mappedEvent,
        workspaceRoot,
        sourceFile,
        sourceLine,
        fallbackTimestamp,
      })
    }
    return super.parseRaw({ raw, workspaceRoot, sourceFile, sourceLine, fallbackTimestamp })
  }

  parseRealtimeMethod({ raw, mappedEvent, workspaceRoot, sourceFile, sourceLine, fallbackTimestamp = "" }) {
    const method = normalizeText(raw.method)
    const params = raw.params && typeof raw.params === "object" ? raw.params : {}
    const timestamp = normalizeTimestamp(
      raw.timestamp
      || mappedEvent?.timestamp
      || mappedEvent?.payload?.timestamp,
      fallbackTimestamp
    )
    this.currentThreadId = normalizeText(params.threadId) || this.currentThreadId
    this.currentTurnId = normalizeText(params.turnId || params?.turn?.id) || this.currentTurnId
    this.currentWorkspaceRoot = normalizeText(workspaceRoot) || this.currentWorkspaceRoot

    if (method === "turn/started" || method === "turn/start" || method === "turn/completed" || method === "turn/failed") {
      return []
    }
    if (method === "item/agentMessage/delta") {
      return []
    }
    if (method.endsWith("requestApproval") || method === "mcpServer/elicitation/request") {
      return []
    }
    if (method !== "item/completed") {
      return []
    }

    const item = params.item && typeof params.item === "object" ? params.item : {}
    const itemType = normalizeText(item.type).toLowerCase()
    if (itemType === "usermessage" || (itemType === "message" && normalizeText(item.role).toLowerCase() === "user")) {
      const text = normalizeText(item.text || extractCodexMessageText(item.content))
      if (!text) {
        return []
      }
      const record = buildConversationUserRecord({
        text,
        timestamp,
        runtimeId: "codex",
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
        workspaceRoot: this.currentWorkspaceRoot,
        source: {
          provider: "codex",
          sourceFile,
          sourceLine,
          rawId: normalizeText(item.id || `item-${sourceLine}`),
        },
        defaultSourceType: "codex.realtime.item.completed.userMessage",
        systemCompactSourceType: "codex.system_action_mode",
      })
      return record ? [record] : []
    }
    if (itemType === "agentmessage") {
      const text = normalizeText(item.text || extractCodexMessageText(item.content))
      if (!text) {
        return []
      }
      return [normalizeConversationRecord({
        type: "assistant",
        timestamp,
        runtimeId: "codex",
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
        workspaceRoot: this.currentWorkspaceRoot,
        text,
        source: {
          provider: "codex",
          sourceType: "codex.realtime.item.completed.agentMessage",
          sourceFile,
          sourceLine,
          rawId: normalizeText(item.id || `item-${sourceLine}`),
        },
      })]
    }

    if (itemType === "reasoning") {
      return []
    }

    const descriptor = buildOperationDescriptor({
      toolName: normalizeText(item.name || item.toolName || item.type),
      args: item.input || parseMaybeJson(item.arguments) || {},
      fallbackText: normalizeText(item.command),
    })
    if (!descriptor.text) {
      return []
    }

    const callId = normalizeText(item.callId || item.call_id || item.id)
    const operationRecord = normalizeConversationRecord({
      type: "operation",
      timestamp,
      runtimeId: "codex",
      threadId: this.currentThreadId,
      turnId: this.currentTurnId,
      workspaceRoot: this.currentWorkspaceRoot,
      text: descriptor.text,
      meta: {
        ...descriptor.meta,
        ...buildToolResultMeta(normalizeText(item.output || item.result)),
      },
      source: {
        provider: "codex",
        sourceType: `codex.realtime.item.completed.${normalizeText(item.type) || "operation"}`,
        sourceFile,
        sourceLine,
        rawId: normalizeText(item.id || `item-${sourceLine}`),
        callId,
      },
    })

    const records = [operationRecord]
    if (callId) {
      this.pendingOperations.set(callId, operationRecord)
    }
    const visibleAssistant = buildVisibleAssistantRecordFromResult({
      toolName: descriptor.meta.toolName,
      outputText: normalizeText(item.output || item.result),
    })
    if (visibleAssistant) {
      records.push(normalizeConversationRecord({
        ...visibleAssistant,
        timestamp,
        runtimeId: "codex",
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
        workspaceRoot: this.currentWorkspaceRoot,
        meta: {
          ...visibleAssistant.meta,
        },
        source: {
          provider: "codex",
          sourceType: `codex.realtime.item.completed.visible`,
          sourceFile,
          sourceLine,
          rawId: `${normalizeText(item.id || `item-${sourceLine}`)}:visible`,
          callId,
        },
      }))
    }
    return records
  }
}

function createCodexRealtimeParser() {
  return new CodexRealtimeParser()
}

function extractCodexMessageText(content) {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return ""
  }
  return content
    .map((item) => normalizeText(item?.text || item?.value))
    .filter(Boolean)
    .join("\n")
}

function parseMaybeJson(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value
  }
  if (typeof value !== "string") {
    return {}
  }
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  CodexRealtimeParser,
  createCodexRealtimeParser,
}
