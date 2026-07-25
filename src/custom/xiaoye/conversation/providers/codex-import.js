const path = require("path")

const {
  buildOperationDescriptor,
  buildToolResultMeta,
  buildVisibleAssistantRecordFromToolCall,
} = require("../normalize-operation")
const { extractSavedAttachmentsFromText } = require("../extract-saved-attachments")
const { mergeMediaLists, normalizeMediaList } = require("../normalize-media")
const { buildConversationUserRecord, isApprovalReply } = require("../normalize-prompt")
const { normalizeConversationRecord } = require("../normalize-record")
const {
  extractTextPayload,
  normalizeToolName,
  parseStructuredValue,
} = require("../normalize-tool-call")
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
    this.pendingMcpOperations = []
    this.seenFallbackMessages = new Set()
    this.pendingAgentMessagesByTurn = new Map()
    this.seenCanonicalAssistantMessages = new Set()
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
      const records = this.flushPendingAgentMessages(this.currentTurnId)
      this.pendingMcpOperations = this.pendingMcpOperations
        .filter((entry) => entry.turnId !== this.currentTurnId)
      return records
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
    if (payloadType === "mcp_tool_call_end") {
      return this.parseMcpToolCallEnd({ raw, sourceFile, sourceLine, fallbackTimestamp })
    }
    if (payloadType === "user_message" || payloadType === "agent_message") {
      const role = payloadType === "user_message" ? "user" : "assistant"
      const text = normalizeText(raw?.payload?.message)
      if (!text) {
        return []
      }
      if (role === "assistant") {
        const canonicalKey = buildFallbackMessageKey(role, this.currentTurnId, text)
        if (this.seenCanonicalAssistantMessages.has(canonicalKey)) {
          return []
        }
        this.rememberPendingAgentMessage(normalizeConversationRecord({
          type: role,
          itemId: normalizeText(raw?.payload?.itemId || raw?.payload?.id)
            || buildFallbackAssistantItemId(this.currentTurnId, sourceLine),
          timestamp: normalizeTimestamp(raw.timestamp, fallbackTimestamp),
          runtimeId: "codex",
          threadId: this.currentThreadId,
          turnId: this.currentTurnId,
          workspaceRoot: this.currentWorkspaceRoot,
          text,
          meta: {
            itemId: normalizeText(raw?.payload?.itemId || raw?.payload?.id)
              || buildFallbackAssistantItemId(this.currentTurnId, sourceLine),
          },
          source: {
            provider: "codex",
            sourceType: `codex.${payloadType}`,
            sourceFile,
            sourceLine,
            rawId: `${payloadType}:${sourceLine}`,
          },
        }))
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
      if (role === "user") {
        const messageKey = buildFallbackMessageKey(role, this.currentTurnId, text)
        if (this.seenFallbackMessages.has(messageKey)) {
          return []
        }
        rememberBoundedSet(this.seenFallbackMessages, messageKey, this.maxStateEntries)
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
      this.consumePendingAgentMessage(this.currentTurnId, text)
      rememberBoundedSet(
        this.seenCanonicalAssistantMessages,
        buildFallbackMessageKey(role, this.currentTurnId, text),
        this.maxStateEntries,
      )
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
      if (payloadType === "custom_tool_call" && normalizeText(payload.name) === "exec") {
        return this.parseExecWrapper({
          payload,
          timestamp,
          sourceFile,
          sourceLine,
        })
      }
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

  parseMcpToolCallEnd({ raw, sourceFile, sourceLine, fallbackTimestamp = "" }) {
    const payload = raw?.payload && typeof raw.payload === "object" ? raw.payload : {}
    const invocation = payload.invocation && typeof payload.invocation === "object"
      ? payload.invocation
      : {}
    const toolName = normalizeText(invocation.tool)
    if (!toolName) {
      return []
    }
    const args = invocation.arguments && typeof invocation.arguments === "object"
      ? invocation.arguments
      : parseStructuredValue(invocation.arguments)
    const outputText = extractTextPayload(payload.result)
    const timestamp = normalizeTimestamp(raw.timestamp, fallbackTimestamp)
    const callId = normalizeText(payload.call_id)
    const pending = this.consumePendingMcpOperation({
      callId,
      server: normalizeText(invocation.server),
      toolName,
      args,
    })
    const completedOperation = this.buildOperationRecord({
      timestamp,
      payload: {
        type: "mcp_tool_call_end",
        name: toolName,
        call_id: callId,
        arguments: args,
      },
      sourceFile,
      sourceLine,
      sourceOrder: 1,
    })
    if (!completedOperation) {
      return []
    }

    const operationRecord = pending
      ? normalizeConversationRecord({
        ...completedOperation,
        timestamp: pending.record.timestamp,
        source: {
          ...pending.record.source,
          sourceOrder: pending.record.source.sourceOrder || 1,
        },
      })
      : completedOperation
    const records = [normalizeConversationRecord({
      ...operationRecord,
      meta: {
        ...operationRecord.meta,
        ...buildToolResultMeta(outputText),
      },
    })]
    const visibleAssistant = buildVisibleAssistantRecordFromToolCall({
      toolName,
      args,
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
        source: {
          provider: "codex",
          sourceType: "codex.visible",
          sourceFile,
          sourceLine,
          rawId: `visible:${sourceLine}`,
          callId,
          sourceOrder: 2,
        },
      }))
    }
    return records
  }

  parseExecWrapper({ payload, timestamp, sourceFile, sourceLine }) {
    const outerCallId = normalizeText(payload.call_id)
    const nestedCalls = scanExecWrapperToolCalls(payload.input)
    const calls = nestedCalls.length
      ? nestedCalls
      : [{
        rawToolName: "command",
        toolName: "command",
        args: {},
        isMcp: false,
      }]
    const records = []

    calls.forEach((call, index) => {
      const operationCallId = [
        outerCallId || `line-${sourceLine}`,
        index + 1,
        call.toolName,
      ].join(":")
      const record = this.buildOperationRecord({
        timestamp,
        payload: {
          type: "custom_tool_call",
          name: call.toolName,
          call_id: operationCallId,
          arguments: call.args,
        },
        sourceFile,
        sourceLine,
        sourceOrder: index + 1,
      })
      if (!record) {
        return
      }
      records.push(record)
      if (call.isMcp) {
        this.pendingMcpOperations.push({
          outerCallId,
          server: call.server,
          toolName: call.toolName,
          argsSignature: buildStaticArgumentsSignature(call.args),
          turnId: this.currentTurnId,
          record,
        })
        while (this.pendingMcpOperations.length > this.maxStateEntries) {
          this.pendingMcpOperations.shift()
        }
      }
    })
    return records
  }

  consumePendingMcpOperation({
    callId = "",
    server = "",
    toolName = "",
    args = {},
  } = {}) {
    const normalizedCallId = normalizeText(callId)
    const normalizedServer = normalizeText(server)
    const normalizedToolName = normalizeText(toolName)
    let index = this.pendingMcpOperations.findIndex((entry) => (
      entry.turnId === this.currentTurnId
      && entry.toolName === normalizedToolName
      && (
        entry.outerCallId === normalizedCallId
        || entry.record?.source?.callId === normalizedCallId
      )
    ))
    const argsSignature = buildStaticArgumentsSignature(args)
    if (index < 0 && argsSignature) {
      index = this.pendingMcpOperations.findIndex((entry) => (
        entry.turnId === this.currentTurnId
        && entry.server === normalizedServer
        && entry.toolName === normalizedToolName
        && entry.argsSignature === argsSignature
      ))
    }
    if (index < 0) {
      index = this.pendingMcpOperations.findIndex((entry) => (
        entry.turnId === this.currentTurnId
        && (!normalizedServer || !entry.server || entry.server === normalizedServer)
        && entry.toolName === normalizedToolName
      ))
    }
    if (index < 0) {
      return null
    }
    return this.pendingMcpOperations.splice(index, 1)[0] || null
  }

  buildOperationRecord({ timestamp, payload, sourceFile, sourceLine, sourceOrder = 0 }) {
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
        sourceOrder,
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

  rememberPendingAgentMessage(record) {
    const turnId = normalizeText(record?.turnId)
    const pending = this.pendingAgentMessagesByTurn.get(turnId) || []
    pending.push(record)
    setBoundedMap(this.pendingAgentMessagesByTurn, turnId, pending, this.maxStateEntries)
  }

  consumePendingAgentMessage(turnId, text) {
    const key = normalizeText(turnId)
    const pending = this.pendingAgentMessagesByTurn.get(key) || []
    const index = pending.findIndex((record) => normalizeText(record.text) === normalizeText(text))
    if (index < 0) {
      return null
    }
    const [record] = pending.splice(index, 1)
    if (pending.length) {
      this.pendingAgentMessagesByTurn.set(key, pending)
    } else {
      this.pendingAgentMessagesByTurn.delete(key)
    }
    return record
  }

  flushPendingAgentMessages(turnId) {
    const key = normalizeText(turnId)
    const pending = this.pendingAgentMessagesByTurn.get(key) || []
    this.pendingAgentMessagesByTurn.delete(key)
    return pending
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
  return mergeMediaLists(left, right)
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

function scanExecWrapperToolCalls(input = "") {
  const source = String(input || "")
  const calls = []
  const pattern = /tools\.([A-Za-z_$][\w$]*)\s*\(/gu
  for (const match of source.matchAll(pattern)) {
    const rawToolName = normalizeText(match[1])
    if (!rawToolName) {
      continue
    }
    const argumentStart = Number(match.index) + match[0].length
    const argumentText = readBalancedCallArguments(source, argumentStart)
    calls.push({
      rawToolName,
      ...parseStaticToolIdentity(rawToolName),
      args: parseStaticToolArguments(argumentText),
      isMcp: rawToolName.startsWith("mcp__"),
    })
  }
  return calls
}

function readBalancedCallArguments(source, startIndex) {
  let depth = 1
  let quote = ""
  let escaped = false
  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === quote) {
        quote = ""
      }
      continue
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character
      continue
    }
    if (character === "(") {
      depth += 1
      continue
    }
    if (character === ")") {
      depth -= 1
      if (depth === 0) {
        return source.slice(startIndex, index).trim()
      }
    }
  }
  return source.slice(startIndex).trim()
}

function parseStaticToolArguments(argumentText = "") {
  const args = {}
  const pattern = /\b(command|input|patch|filePath|stickerId|id|type|path)\s*:\s*(["'`])((?:\\[\s\S]|(?!\2)[\s\S])*?)\2/gu
  for (const match of String(argumentText || "").matchAll(pattern)) {
    const key = normalizeText(match[1])
    if (!key || Object.hasOwn(args, key)) {
      continue
    }
    args[key] = decodeStaticString(match[3])
  }
  return args
}

function decodeStaticString(value = "") {
  return String(value || "")
    .replace(/\\r/gu, "\r")
    .replace(/\\n/gu, "\n")
    .replace(/\\t/gu, "\t")
    .replace(/\\(["'`\\])/gu, "$1")
}

function parseStaticToolIdentity(rawToolName = "") {
  const normalized = normalizeText(rawToolName)
  if (!normalized.startsWith("mcp__")) {
    return {
      server: "",
      toolName: normalized,
    }
  }
  const parts = normalized.split("__").filter(Boolean)
  return {
    server: parts.length > 2 ? parts.slice(1, -1).join("__") : "",
    toolName: normalizeToolName(normalized),
  }
}

function buildStaticArgumentsSignature(args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args) || !Object.keys(args).length) {
    return ""
  }
  return JSON.stringify(sortObjectKeys(args))
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys)
  }
  if (!value || typeof value !== "object") {
    return value
  }
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]),
  )
}

module.exports = {
  CodexImportParser,
  createCodexImportParser,
  extractCodexThreadIdFromSourceFile,
}

function buildFallbackAssistantItemId(turnId, sourceLine) {
  const normalizedTurnId = normalizeText(turnId)
  return normalizedTurnId ? `item-${normalizedTurnId}-${sourceLine}` : `item-line-${sourceLine}`
}
