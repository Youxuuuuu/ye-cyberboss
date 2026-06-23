const {
  buildOperationDescriptor,
  buildToolResultMeta,
  buildVisibleAssistantRecordFromResult,
} = require("../normalize-operation")
const { buildConversationUserRecord } = require("../normalize-prompt")
const { normalizeConversationRecord } = require("../normalize-record")
const { normalizeMediaList } = require("../normalize-media")
const { normalizeTimestamp } = require("../normalize-time")

class ClaudeCodeParser {
  constructor({ mode = "import" } = {}) {
    this.mode = mode
    this.currentThreadId = ""
    this.currentTurnId = ""
    this.currentWorkspaceRoot = ""
    this.pendingOperations = new Map()
  }

  parseRaw({ raw, workspaceRoot = "", sourceFile = "", sourceLine = 0 }) {
    if (!raw || typeof raw !== "object") {
      return []
    }

    this.currentThreadId = normalizeText(raw.sessionId || raw.session_id) || this.currentThreadId
    this.currentWorkspaceRoot = normalizeText(raw.cwd || workspaceRoot) || this.currentWorkspaceRoot

    if (isFilteredClaudeType(raw.type)) {
      return []
    }

    if (raw.type === "user") {
      return this.parseUserEntry({ raw, sourceFile, sourceLine })
    }
    if (raw.type === "assistant") {
      return this.parseAssistantEntry({ raw, sourceFile, sourceLine })
    }

    return []
  }

  parseUserEntry({ raw, sourceFile, sourceLine }) {
    const content = raw?.message?.content ?? raw?.content ?? raw?.text ?? ""
    if (Array.isArray(content) && content.some((item) => item?.type === "tool_result")) {
      return this.parseToolResults({ raw, content, sourceFile, sourceLine })
    }

    const text = extractClaudeUserText(content)
    const turnId = normalizeText(raw.promptId || raw.uuid || this.currentTurnId)
    this.currentTurnId = turnId || this.currentTurnId

    const attachments = extractClaudeAttachments(raw)
    const record = buildConversationUserRecord({
      text,
      timestamp: normalizeTimestamp(raw.timestamp),
      runtimeId: "claudecode",
      threadId: normalizeText(raw.sessionId) || this.currentThreadId,
      turnId,
      workspaceRoot: this.currentWorkspaceRoot,
      meta: buildUserMeta({
        attachments,
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
    return record ? [record] : []
  }

  parseAssistantEntry({ raw, sourceFile, sourceLine }) {
    const items = Array.isArray(raw?.message?.content) ? raw.message.content : []
    const records = []
    const threadId = normalizeText(raw.sessionId) || this.currentThreadId
    const turnId = normalizeText(this.currentTurnId || raw.parentUuid || raw.uuid)
    const timestamp = normalizeTimestamp(raw.timestamp)

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
            sourceFile,
            sourceLine,
            rawId: `${normalizeText(raw.uuid) || sourceLine}:thinking:${index}`,
            uuid: normalizeText(raw.uuid),
            parentUuid: normalizeText(raw.parentUuid),
          },
        }))
        return
      }
      if (item.type === "text" && normalizeText(item.text) && !isSilentActionText(item.text)) {
        records.push(normalizeConversationRecord({
          type: "assistant",
          timestamp,
          runtimeId: "claudecode",
          threadId,
          turnId,
          workspaceRoot: this.currentWorkspaceRoot,
          text: item.text.trim(),
          source: {
            provider: "claudecode",
            sourceType: `claudecode.${this.mode}.assistant`,
            sourceFile,
            sourceLine,
            rawId: `${normalizeText(raw.uuid) || sourceLine}:assistant:${index}`,
            uuid: normalizeText(raw.uuid),
            parentUuid: normalizeText(raw.parentUuid),
          },
        }))
        return
      }
      if (item.type === "tool_use") {
        const callId = normalizeText(item.id || `${normalizeText(raw.uuid) || sourceLine}:tool:${index}`)
        const descriptor = buildOperationDescriptor({
          toolName: item.name,
          args: item.input && typeof item.input === "object" ? item.input : {},
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
            sourceType: `claudecode.${this.mode}.tool_use`,
            sourceFile,
            sourceLine,
            rawId: `${normalizeText(raw.uuid) || sourceLine}:tool_use:${index}`,
            callId,
            uuid: normalizeText(raw.uuid),
            parentUuid: normalizeText(raw.parentUuid),
          },
        })
        this.pendingOperations.set(callId, operationRecord)
        records.push(operationRecord)
      }
    })

    return records
  }

  parseToolResults({ raw, content, sourceFile, sourceLine }) {
    const records = []
    const threadId = normalizeText(raw.sessionId) || this.currentThreadId
    const turnId = normalizeText(this.currentTurnId || raw.parentUuid || raw.uuid)
    const timestamp = normalizeTimestamp(raw.timestamp)

    for (let index = 0; index < content.length; index += 1) {
      const item = content[index]
      if (!item || item.type !== "tool_result") {
        continue
      }
      const callId = normalizeText(item.tool_use_id || item.toolUseId)
      if (!callId || !this.pendingOperations.has(callId)) {
        continue
      }
      const existing = this.pendingOperations.get(callId)
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
      this.pendingOperations.set(callId, updatedOperation)
      records.push(updatedOperation)

      const assistantVisible = buildVisibleAssistantRecordFromResult({
        toolName: updatedOperation?.meta?.toolName,
        outputText,
      })
      if (assistantVisible) {
        records.push(normalizeConversationRecord({
          ...assistantVisible,
          timestamp,
          runtimeId: "claudecode",
          threadId,
          turnId,
          workspaceRoot: this.currentWorkspaceRoot,
          meta: {
            ...assistantVisible.meta,
          },
          source: {
            provider: "claudecode",
            sourceType: `claudecode.${this.mode}.tool_result.visible`,
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
}

function createClaudeCodeImportParser() {
  return new ClaudeCodeParser({ mode: "import" })
}

function buildUserMeta({ attachments = [] } = {}) {
  const normalizedAttachments = normalizeMediaList(attachments)
  return {
    attachments: normalizedAttachments,
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

module.exports = {
  ClaudeCodeParser,
  createClaudeCodeImportParser,
}
