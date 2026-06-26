const {
  buildOperationDescriptor,
  buildToolResultMeta,
  buildVisibleAssistantRecordFromToolCall,
} = require("../normalize-operation")
const { buildConversationUserRecord, isApprovalReply } = require("../normalize-prompt")
const { normalizeConversationRecord } = require("../normalize-record")
const { normalizeToolName, parseStructuredValue } = require("../normalize-tool-call")
const { normalizeTimestamp } = require("../normalize-time")

class CodexImportParser {
  constructor({ mode = "import", stateDir = "" } = {}) {
    this.mode = mode
    this.stateDir = stateDir
    this.currentThreadId = ""
    this.currentTurnId = ""
    this.currentWorkspaceRoot = ""
    this.pendingOperations = new Map()
    this.seenFallbackMessages = new Set()
  }

  parseRaw({ raw, workspaceRoot = "", sourceFile = "", sourceLine = 0, fallbackTimestamp = "" }) {
    if (!raw || typeof raw !== "object") {
      return []
    }

    if (raw.type === "session_meta") {
      this.currentThreadId = normalizeText(raw?.payload?.id) || this.currentThreadId
      this.currentWorkspaceRoot = normalizeText(raw?.payload?.cwd || workspaceRoot) || this.currentWorkspaceRoot
      return []
    }

    if (raw.type === "turn_context") {
      this.currentTurnId = normalizeText(raw?.payload?.turn_id) || this.currentTurnId
      this.currentWorkspaceRoot = normalizeText(
        raw?.payload?.workspace_roots?.[0]
        || raw?.payload?.cwd
        || workspaceRoot
      ) || this.currentWorkspaceRoot
      return []
    }

    if (raw.type === "event_msg") {
      return this.parseEventMessage({ raw, sourceFile, sourceLine, fallbackTimestamp })
    }

    if (raw.type === "response_item") {
      return this.parseResponseItem({ raw, sourceFile, sourceLine, fallbackTimestamp })
    }

    return []
  }

  parseEventMessage({ raw, sourceFile, sourceLine, fallbackTimestamp = "" }) {
    const payloadType = normalizeText(raw?.payload?.type)
    if (payloadType === "task_started") {
      this.currentTurnId = normalizeText(raw?.payload?.turn_id) || this.currentTurnId
      return []
    }
    if (payloadType === "task_complete") {
      return []
    }
    if (payloadType === "user_message" || payloadType === "agent_message") {
      const role = payloadType === "user_message" ? "user" : "assistant"
      const text = normalizeText(raw?.payload?.message)
      if (!text) {
        return []
      }
      const messageKey = buildFallbackMessageKey(role, this.currentTurnId, text)
      if (this.seenFallbackMessages.has(messageKey)) {
        return []
      }
      this.seenFallbackMessages.add(messageKey)
      if (role === "user") {
        const record = buildConversationUserRecord({
          text,
          timestamp: normalizeTimestamp(raw.timestamp, fallbackTimestamp),
          runtimeId: "codex",
          threadId: this.currentThreadId,
          turnId: this.currentTurnId,
          workspaceRoot: this.currentWorkspaceRoot,
          source: {
            provider: "codex",
            sourceFile,
            sourceLine,
            rawId: `${payloadType}:${sourceLine}`,
          },
          defaultSourceType: `codex.${this.mode}.event_msg.${payloadType}`,
          systemCompactSourceType: "codex.system_action_mode",
        })
        return record ? [record] : []
      }
      return [normalizeConversationRecord({
        type: role,
        timestamp: normalizeTimestamp(raw.timestamp, fallbackTimestamp),
        runtimeId: "codex",
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
        workspaceRoot: this.currentWorkspaceRoot,
        text,
        source: {
          provider: "codex",
          sourceType: `codex.${payloadType}`,
          sourceFile,
          sourceLine,
          rawId: `${payloadType}:${sourceLine}`,
        },
      })]
    }
    return []
  }

  parseResponseItem({ raw, sourceFile, sourceLine, fallbackTimestamp = "" }) {
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : {}
    const payloadType = normalizeText(payload.type)
    const timestamp = normalizeTimestamp(raw.timestamp, fallbackTimestamp)

    if (payloadType === "reasoning") {
      return []
    }

    if (payloadType === "message") {
      const role = normalizeText(payload.role)
      if (role !== "user" && role !== "assistant") {
        return []
      }
      const text = extractCodexMessageText(payload.content)
      if (!text || isApprovalReply(text)) {
        return []
      }
      const messageKey = buildFallbackMessageKey(role, this.currentTurnId, text)
      if (this.seenFallbackMessages.has(messageKey)) {
        return []
      }
      this.seenFallbackMessages.add(messageKey)
      if (role === "user") {
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
            rawId: `${role}:${sourceLine}`,
          },
          defaultSourceType: `codex.${this.mode}.response_item.message.${role}`,
          systemCompactSourceType: "codex.system_action_mode",
        })
        return record ? [record] : []
      }
      return [normalizeConversationRecord({
        type: role,
        timestamp,
        runtimeId: "codex",
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
        workspaceRoot: this.currentWorkspaceRoot,
        text,
        source: {
          provider: "codex",
          sourceType: `codex.${role}`,
          sourceFile,
          sourceLine,
          rawId: `${role}:${sourceLine}`,
        },
      })]
    }

    if (payloadType === "function_call" || payloadType === "custom_tool_call" || payloadType === "patch_apply_end") {
      const operationRecord = this.buildOperationRecord({
        timestamp,
        payload,
        sourceFile,
        sourceLine,
      })
      if (!operationRecord) {
        return []
      }
      if (operationRecord.source.callId) {
        this.pendingOperations.set(operationRecord.source.callId, {
          record: operationRecord,
          args: operationRecord._operationArgs || {},
        })
      }
      return [operationRecord]
    }

    if (payloadType === "function_call_output") {
      const callId = normalizeText(payload.call_id)
      if (!callId || !this.pendingOperations.has(callId)) {
        return []
      }
      const pending = this.pendingOperations.get(callId)
      const existing = pending.record
      const outputText = normalizeText(payload.output)
      const updatedOperation = normalizeConversationRecord({
        ...existing,
        timestamp,
        meta: {
          ...existing.meta,
          ...buildToolResultMeta(outputText),
        },
      })
      this.pendingOperations.set(callId, {
        ...pending,
        record: updatedOperation,
      })

      const records = [updatedOperation]
      const visibleAssistant = buildVisibleAssistantRecordFromToolCall({
        toolName: updatedOperation?.meta?.toolName,
        args: pending.args || {},
        outputText,
        workspaceRoot: this.currentWorkspaceRoot,
        stateDir: this.stateDir,
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
            sourceType: `codex.visible`,
            sourceFile,
            sourceLine,
            rawId: `visible:${sourceLine}`,
            callId,
          },
        }))
      }
      return records
    }

    return []
  }

  buildOperationRecord({ timestamp, payload, sourceFile, sourceLine }) {
    const callId = normalizeText(payload.call_id)
    const toolName = normalizeToolName(payload.name || payload.type)
    const args = parseStructuredValue(payload.arguments || payload.input || payload.output)
    const descriptor = buildOperationDescriptor({
      runtimeId: "codex",
      mode: this.mode,
      toolName,
      args,
      fallbackText: typeof payload.input === "string" ? payload.input : "",
      workspaceRoot: this.currentWorkspaceRoot,
      stateDir: this.stateDir,
    })
    if (!descriptor.text) {
      return null
    }
    return normalizeConversationRecord({
      type: "operation",
      timestamp,
      runtimeId: "codex",
      threadId: this.currentThreadId,
      turnId: this.currentTurnId,
      workspaceRoot: this.currentWorkspaceRoot,
      text: descriptor.text,
      meta: descriptor.meta,
      source: {
        provider: "codex",
        sourceType: "codex.operation",
        sourceFile,
        sourceLine,
        rawId: `${normalizeText(payload.type)}:${sourceLine}`,
        callId,
      },
      _operationArgs: args,
    })
  }
}

function createCodexImportParser(options = {}) {
  return new CodexImportParser(options)
}

function buildFallbackMessageKey(role, turnId, text) {
  return `${role}|${normalizeText(turnId)}|${normalizeText(text)}`
}

function extractCodexMessageText(content) {
  const entries = Array.isArray(content) ? content : []
  return entries
    .map((item) => {
      if (!item || typeof item !== "object") {
        return ""
      }
      return normalizeText(item.text)
    })
    .filter(Boolean)
    .join("\n")
    .trim()
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  CodexImportParser,
  createCodexImportParser,
}
