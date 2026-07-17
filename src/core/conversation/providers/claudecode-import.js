const {
  buildOperationDescriptor,
  buildToolResultMeta,
  buildVisibleAssistantRecordFromToolCall,
} = require("../normalize-operation")
const { extractSavedAttachmentsFromText } = require("../extract-saved-attachments")
const { buildConversationUserRecord } = require("../normalize-prompt")
const { normalizeConversationRecord } = require("../normalize-record")
const { normalizeMediaList } = require("../normalize-media")
const { normalizeToolName } = require("../normalize-tool-call")
const { normalizeTimestamp } = require("../normalize-time")

class ClaudeCodeParser {
  constructor({ mode = "import", stateDir = "", maxStateEntries = 5000 } = {}) {
    this.mode = mode
    this.stateDir = stateDir
    this.currentThreadId = ""
    this.currentTurnId = ""
    this.currentWorkspaceRoot = ""
    this.maxStateEntries = Number(maxStateEntries) > 0 ? Math.floor(Number(maxStateEntries)) : 5000
    this.pendingOperations = new Map()
    this.lastCanonicalUserByTurn = new Map()
  }

  parseRaw({ raw, workspaceRoot = "", sourceFile = "", sourceLine = 0, fallbackTimestamp = "" }) {
    if (!raw || typeof raw !== "object") {
      return []
    }

    this.currentThreadId = normalizeText(raw.sessionId || raw.session_id) || this.currentThreadId
    this.currentWorkspaceRoot = normalizeText(raw.cwd || workspaceRoot) || this.currentWorkspaceRoot

    if (isFilteredClaudeType(raw.type)) {
      return []
    }

    if (raw.type === "user") {
      return this.parseUserEntry({ raw, sourceFile, sourceLine, fallbackTimestamp })
    }
    if (raw.type === "assistant") {
      return this.parseAssistantEntry({ raw, sourceFile, sourceLine, fallbackTimestamp })
    }

    return []
  }

  parseUserEntry({ raw, sourceFile, sourceLine, fallbackTimestamp = "" }) {
    const content = raw?.message?.content ?? raw?.content ?? raw?.text ?? ""
    if (Array.isArray(content) && content.some((item) => item?.type === "tool_result")) {
      return this.parseToolResults({ raw, content, sourceFile, sourceLine, fallbackTimestamp })
    }

    const text = extractClaudeUserText(content)
    const turnId = normalizeText(raw.promptId || raw.uuid || this.currentTurnId)
    this.currentTurnId = turnId || this.currentTurnId

    const extracted = extractSavedAttachmentsFromText(text, {
      workspaceRoot: this.currentWorkspaceRoot,
      stateDir: this.stateDir,
    })
    const attachments = [
      ...extractClaudeAttachments(raw),
      ...extracted.attachments,
    ]
    const record = buildConversationUserRecord({
      text: extracted.text,
      timestamp: normalizeTimestamp(raw.timestamp, fallbackTimestamp),
      runtimeId: "claudecode",
      threadId: normalizeText(raw.sessionId) || this.currentThreadId,
      turnId,
      workspaceRoot: this.currentWorkspaceRoot,
      meta: buildUserMeta({
        attachments,
        visibleAttachments: attachments.filter((item) => item.kind !== "file"),
        workspaceRoot: this.currentWorkspaceRoot,
        stateDir: this.stateDir,
      }),
      source: {
        provider: "claudecode",
        sourceFile,
        sourceLine,
        rawId: normalizeText(raw.promptId || raw.uuid || `line-${sourceLine}`),
        uuid: normalizeText(raw.uuid),
        parentUuid: normalizeText(raw.parentUuid),
      },
      defaultSourceType: `claudecode.${this.mode}.user`,
      systemCompactSourceType: "claudecode.system_action_mode",
    })
    return record ? [this.rememberCanonicalUserRecord(record)] : []
  }

  parseAssistantEntry({ raw, sourceFile, sourceLine, fallbackTimestamp = "" }) {
    const items = Array.isArray(raw?.message?.content) ? raw.message.content : []
    const records = []
    const threadId = normalizeText(raw.sessionId) || this.currentThreadId
    const turnId = normalizeText(this.currentTurnId || raw.parentUuid || raw.uuid)
    const timestamp = normalizeTimestamp(raw.timestamp, fallbackTimestamp)

    items.forEach((item, index) => {
      if (!item || typeof item !== "object") {
        return
      }
      if (item.type === "thinking" && normalizeText(item.thinking)) {
        records.push(normalizeConversationRecord({
          type: "thinking",
          timestamp,
          runtimeId: "claudecode",
          threadId,
          turnId,
          workspaceRoot: this.currentWorkspaceRoot,
          text: item.thinking.trim(),
          source: {
            provider: "claudecode",
            sourceType: `claudecode.${this.mode}.thinking`,
            rawId: `${normalizeText(raw.uuid) || sourceLine}:${index}`,
            sourceFile,
            sourceLine,
            uuid: normalizeText(raw.uuid),
            parentUuid: normalizeText(raw.parentUuid),
          },
        }))
        return
      }
      if (item.type === "text" && normalizeText(item.text) && !isSilentActionText(item.text)) {
        records.push(normalizeConversationRecord({
          type: "assistant",
          itemId: `item-${turnId}`,
          timestamp,
          runtimeId: "claudecode",
          threadId,
          turnId,
          workspaceRoot: this.currentWorkspaceRoot,
          text: item.text.trim(),
          meta: {
            itemId: `item-${turnId}`,
          },
          source: {
            provider: "claudecode",
            sourceType: `claudecode.${this.mode}.assistant`,
            rawId: `${normalizeText(raw.uuid) || sourceLine}:${index}`,
            sourceFile,
            sourceLine,
            uuid: normalizeText(raw.uuid),
            parentUuid: normalizeText(raw.parentUuid),
          },
        }))
        return
      }
      if (item.type === "tool_use") {
        const callId = normalizeText(item.id || `${normalizeText(raw.uuid) || sourceLine}:tool:${index}`)
        const descriptor = buildOperationDescriptor({
          runtimeId: "claudecode",
          mode: this.mode,
          toolName: normalizeToolName(item.name),
          rawToolName: normalizeText(item.name),
          args: item.input && typeof item.input === "object" ? item.input : {},
          workspaceRoot: this.currentWorkspaceRoot,
          stateDir: this.stateDir,
        })
        const operationRecord = normalizeConversationRecord({
          type: "operation",
          timestamp,
          runtimeId: "claudecode",
          threadId,
          turnId,
          workspaceRoot: this.currentWorkspaceRoot,
          text: descriptor.text,
          meta: descriptor.meta,
          source: {
            provider: "claudecode",
            sourceType: "claudecode.operation",
            sourceFile,
            sourceLine,
            rawId: `${normalizeText(raw.uuid) || sourceLine}:${index}`,
            callId,
            uuid: normalizeText(raw.uuid),
            parentUuid: normalizeText(raw.parentUuid),
          },
          _operationArgs: item.input && typeof item.input === "object" ? item.input : {},
        })
        setBoundedMap(this.pendingOperations, callId, {
          record: operationRecord,
          args: item.input && typeof item.input === "object" ? item.input : {},
        }, this.maxStateEntries)
        records.push(operationRecord)
      }
    })

    return records
  }

  parseToolResults({ raw, content, sourceFile, sourceLine, fallbackTimestamp = "" }) {
    const records = []
    const threadId = normalizeText(raw.sessionId) || this.currentThreadId
    const turnId = normalizeText(this.currentTurnId || raw.parentUuid || raw.uuid)
    const timestamp = normalizeTimestamp(raw.timestamp, fallbackTimestamp)

    for (let index = 0; index < content.length; index += 1) {
      const item = content[index]
      if (!item || item.type !== "tool_result") {
        continue
      }
      const callId = normalizeText(item.tool_use_id || item.toolUseId)
      if (!callId || !this.pendingOperations.has(callId)) {
        continue
      }
      const pending = this.pendingOperations.get(callId)
      const existing = pending.record
      const outputText = extractToolResultContent(item.content)
      const updatedOperation = normalizeConversationRecord({
        ...existing,
        timestamp,
        threadId,
        turnId,
        workspaceRoot: this.currentWorkspaceRoot,
        meta: {
          ...existing.meta,
          ...buildToolResultMeta(outputText),
        },
      })
      this.pendingOperations.delete(callId)
      records.push(updatedOperation)

      const normalizedVisible = buildVisibleAssistantRecordFromToolCall({
        toolName: updatedOperation?.meta?.toolName,
        args: pending.args || {},
        outputText,
        workspaceRoot: this.currentWorkspaceRoot,
        stateDir: this.stateDir,
      })
      if (normalizedVisible) {
        records.push(normalizeConversationRecord({
          ...normalizedVisible,
          timestamp,
          runtimeId: "claudecode",
          threadId,
          turnId,
          workspaceRoot: this.currentWorkspaceRoot,
          meta: {
            ...normalizedVisible.meta,
          },
          source: {
            provider: "claudecode",
            sourceType: "claudecode.visible",
            sourceFile,
            sourceLine,
            rawId: `${normalizeText(raw.uuid) || sourceLine}:visible:${index}`,
            callId,
            uuid: normalizeText(raw.uuid),
            parentUuid: normalizeText(raw.parentUuid),
          },
        }))
      }
    }

    return records
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

function createClaudeCodeImportParser() {
  const [options = {}] = arguments
  return new ClaudeCodeParser(options)
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

function buildUserMeta({ attachments = [], workspaceRoot = "", stateDir = "" } = {}) {
  const normalizedAttachments = normalizeMediaList(attachments, { workspaceRoot, stateDir })
  return {
    attachments: normalizedAttachments.filter((item) => item.kind !== "file"),
    files: normalizedAttachments.filter((item) => item.kind === "file"),
    stickers: normalizedAttachments.filter((item) => item.kind === "sticker"),
  }
}

function extractClaudeAttachments(raw) {
  const candidates = []
  for (const key of ["attachments", "files", "images", "stickers"]) {
    if (Array.isArray(raw?.[key])) {
      candidates.push(...raw[key])
    }
    if (Array.isArray(raw?.message?.[key])) {
      candidates.push(...raw.message[key])
    }
  }
  return candidates
}

function extractClaudeUserText(content) {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return ""
  }
  return content
    .map((item) => {
      if (typeof item === "string") {
        return item
      }
      if (item?.type === "text" && typeof item.text === "string") {
        return item.text
      }
      if (typeof item?.content === "string") {
        return item.content
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function extractToolResultContent(content) {
  if (typeof content === "string") {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item
        }
        if (item?.type === "text" && typeof item.text === "string") {
          return item.text
        }
        if (typeof item?.content === "string") {
          return item.content
        }
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

function isFilteredClaudeType(type) {
  const normalized = normalizeText(type)
  return normalized === "queue-operation"
    || normalized === "ai-title"
    || normalized === "last-prompt"
    || normalized === "mode"
    || normalized === "system"
    || normalized === "result"
    || normalized === "file-history-snapshot"
    || normalized === "control_request"
    || normalized === "control_cancel_request"
}

function isSilentActionText(text) {
  try {
    const parsed = JSON.parse(String(text || "").trim())
    return parsed && parsed.action === "silent"
  } catch {
    return false
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
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

module.exports = {
  ClaudeCodeParser,
  createClaudeCodeImportParser,
}
