const path = require("path")

const {
  buildOperationDescriptor,
  buildToolResultMeta,
  buildVisibleAssistantRecordFromToolCall,
} = require("../normalize-operation")
const { extractSavedAttachmentsFromText } = require("../extract-saved-attachments")
const { normalizeMediaList } = require("../normalize-media")
const { buildConversationUserRecord, isApprovalReply } = require("../normalize-prompt")
const { normalizeConversationRecord } = require("../normalize-record")
const { normalizeToolName, parseStructuredValue } = require("../normalize-tool-call")
const { normalizeTimestamp } = require("../normalize-time")

class CodexImportParser {
  constructor({ mode = "import", stateDir = "", maxStateEntries = 5000 } = {}) {
    this.mode = mode
    this.stateDir = stateDir
    this.currentThreadId = ""
    this.currentTurnId = ""
    this.currentWorkspaceRoot = ""
    this.maxStateEntries = Number(maxStateEntries) > 0 ? Math.floor(Number(maxStateEntries)) : 5000
    this.pendingOperations = new Map()
    this.seenFallbackMessages = new Set()
    this.lastCanonicalUserByTurn = new Map()
  }

  parseRaw({ raw, workspaceRoot = "", sourceFile = "", sourceLine = 0, fallbackTimestamp = "" }) {
    if (!raw || typeof raw !== "object") {
      return []
    }

    const filenameThreadId = extractCodexThreadIdFromSourceFile(sourceFile)
    if (filenameThreadId) {
      this.currentThreadId = filenameThreadId
    }

    if (raw.type === "session_meta") {
      this.currentThreadId = filenameThreadId
        || normalizeText(raw?.payload?.id)
        || this.currentThreadId
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
    if (payloadType === "patch_apply_end") {
      const operationRecord = this.buildOperationRecord({
        timestamp: normalizeTimestamp(raw.timestamp, fallbackTimestamp),
        payload: {
          ...raw.payload,
          type: "patch_apply_end",
          input: JSON.stringify({
            path: Object.keys(raw?.payload?.changes || {})[0] || "",
          }),
        },
        sourceFile,
        sourceLine,
      })
      return operationRecord ? [operationRecord] : []
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
      rememberBoundedSet(this.seenFallbackMessages, messageKey, this.maxStateEntries)
      if (role === "user") {
        const record = this.buildUserRecord({
          text,
          timestamp: normalizeTimestamp(raw.timestamp, fallbackTimestamp),
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
        itemId: normalizeText(raw?.payload?.itemId || raw?.payload?.id) || (this.currentTurnId ? `item-${this.currentTurnId}` : ""),
        timestamp: normalizeTimestamp(raw.timestamp, fallbackTimestamp),
        runtimeId: "codex",
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
        workspaceRoot: this.currentWorkspaceRoot,
        text,
        meta: {
          itemId: normalizeText(raw?.payload?.itemId || raw?.payload?.id) || (this.currentTurnId ? `item-${this.currentTurnId}` : ""),
        },
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
       rememberBoundedSet(this.seenFallbackMessages, messageKey, this.maxStateEntries)
      if (role === "user") {
        const record = this.buildUserRecord({
          text,
          timestamp,
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
        itemId: normalizeText(payload.itemId || payload.id) || (this.currentTurnId ? `item-${this.currentTurnId}` : ""),
        timestamp,
        runtimeId: "codex",
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
        workspaceRoot: this.currentWorkspaceRoot,
        text,
        meta: {
          itemId: normalizeText(payload.itemId || payload.id) || (this.currentTurnId ? `item-${this.currentTurnId}` : ""),
        },
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
        setBoundedMap(this.pendingOperations, operationRecord.source.callId, {
          record: operationRecord,
          args: operationRecord._operationArgs || {},
        }, this.maxStateEntries)
      }
      // 审批内容由提示过滤器单独处理；正常工具调用必须保留为可见 operation。
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
      this.pendingOperations.delete(callId)

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
    const rawToolName = normalizeText(payload.name || payload.type)
    const toolName = normalizeToolName(rawToolName)
    const args = parseStructuredValue(payload.arguments || payload.input || payload.output)
    const descriptor = buildOperationDescriptor({
      runtimeId: "codex",
      mode: this.mode,
      toolName,
      rawToolName,
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

  buildUserRecord({
    text = "",
    timestamp = "",
    source = {},
    defaultSourceType = "",
    systemCompactSourceType = "",
  } = {}) {
    const extracted = extractSavedAttachmentsFromText(text, {
      workspaceRoot: this.currentWorkspaceRoot,
      stateDir: this.stateDir,
    })
    const record = buildConversationUserRecord({
      text: extracted.text,
      timestamp,
      runtimeId: "codex",
      threadId: this.currentThreadId,
      turnId: this.currentTurnId,
      workspaceRoot: this.currentWorkspaceRoot,
      meta: buildUserMeta(extracted),
      source,
      defaultSourceType,
      systemCompactSourceType,
    })
    return this.rememberCanonicalUserRecord(record)
  }

  rememberCanonicalUserRecord(record) {
    if (!record || record.type !== "user") {
      return record
    }
    const key = buildTurnKey(record.threadId, record.turnId)
    if (key && !record.text && hasMedia(record.meta)) {
      const existing = this.lastCanonicalUserByTurn.get(key)
      if (existing) {
        return normalizeConversationRecord({
          type: "user",
          timestamp: record.timestamp,
          runtimeId: existing.runtimeId,
          threadId: existing.threadId,
          turnId: existing.turnId,
          workspaceRoot: existing.workspaceRoot,
          text: "",
          meta: {
            attachments: mergeMedia(existing.meta.attachments, record.meta.attachments),
            files: mergeMedia(existing.meta.files, record.meta.files),
            stickers: mergeMedia(existing.meta.stickers, record.meta.stickers),
          },
          source: existing.source,
        })
      }
    }
    if (key && !isSystemCompact(record)) {
      setBoundedMap(this.lastCanonicalUserByTurn, key, snapshotUserRecord(record), this.maxStateEntries)
    }
    return record
  }
}

function createCodexImportParser(options = {}) {
  return new CodexImportParser(options)
}

function extractCodexThreadIdFromSourceFile(sourceFile = "") {
  const baseName = path.basename(normalizeText(sourceFile))
  const match = baseName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/iu)
  return match ? match[1] : ""
}

function rememberBoundedSet(set, value, maxEntries) {
  if (set.has(value)) {
    return
  }
  while (set.size >= maxEntries) {
    const oldest = set.values().next().value
    if (oldest === undefined) {
      break
    }
    set.delete(oldest)
  }
  set.add(value)
}

function setBoundedMap(map, key, value, maxEntries) {
  map.delete(key)
  while (map.size >= maxEntries) {
    const oldest = map.keys().next().value
    if (oldest === undefined) {
      break
    }
    map.delete(oldest)
  }
  map.set(key, value)
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

function buildUserMeta(extracted = {}) {
  const normalizedAttachments = normalizeMediaList(extracted.visibleAttachments || extracted.attachments)
  const normalizedFiles = normalizeMediaList(extracted.files)
  const normalizedStickers = normalizeMediaList(extracted.stickers)
  return {
    attachments: normalizedAttachments,
    files: normalizedFiles,
    stickers: normalizedStickers,
  }
}

function buildTurnKey(threadId, turnId) {
  const normalizedThreadId = normalizeText(threadId)
  const normalizedTurnId = normalizeText(turnId)
  return normalizedThreadId && normalizedTurnId ? `${normalizedThreadId}|${normalizedTurnId}` : ""
}

function hasMedia(meta = {}) {
  return Array.isArray(meta?.attachments) && meta.attachments.length > 0
}

function isSystemCompact(record) {
  return normalizeText(record?.meta?.visibleAs) === "system_compact"
}

function snapshotUserRecord(record) {
  return {
    runtimeId: record.runtimeId,
    threadId: record.threadId,
    turnId: record.turnId,
    workspaceRoot: record.workspaceRoot,
    meta: {
      attachments: record.meta.attachments,
      files: record.meta.files,
      stickers: record.meta.stickers,
    },
    source: {
      ...record.source,
    },
  }
}

function mergeMedia(left = [], right = []) {
  const items = [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]
  const result = []
  const seen = new Set()
  for (const item of items) {
    const signature = JSON.stringify(item)
    if (seen.has(signature)) {
      continue
    }
    seen.add(signature)
    result.push(item)
  }
  return result
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  CodexImportParser,
  createCodexImportParser,
  extractCodexThreadIdFromSourceFile,
}
