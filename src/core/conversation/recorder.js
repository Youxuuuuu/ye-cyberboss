const { normalizeConversationRecord } = require("./normalize-record")
const { normalizeMediaList } = require("./normalize-media")
const { ConversationWriter } = require("./writer")
const { RealtimeTailer } = require("./realtime-tailer")
const { ConversationSourceLineResolver } = require("./source-line-resolver")
const { createClaudeCodeImportParser } = require("./providers/claudecode-import")
const { createCodexImportParser } = require("./providers/codex-import")

class ConversationArchive {
  constructor({ config, writer = null } = {}) {
    this.config = config || {}
    this.writer = writer || new ConversationWriter({
      conversationDir: this.config.conversationDir,
    })
    this.parsers = new Map()
    this.lastTimestamp = ""
    this.tailer = new RealtimeTailer()
    this.sourceResolver = new ConversationSourceLineResolver({
      codexHome: this.config.codexHome,
      claudeConfigDir: this.config.claudeConfigDir,
    })
    this.recentInboundUserRecords = []
  }

  recordInboundMessage(prepared, context = {}) {
    if (!prepared || prepared.provider === "system") {
      return { writtenCount: 0, warnings: [] }
    }

    const quote = extractQuote(prepared.originalText || prepared.text || "")
    const attachments = normalizeMediaList(prepared.attachments, {
      workspaceRoot: context.workspaceRoot,
      stateDir: this.config.stateDir,
    })
    const record = normalizeConversationRecord({
      type: "user",
      timestamp: prepared.receivedAt || new Date().toISOString(),
      runtimeId: normalizeText(context.runtimeId),
      threadId: normalizeText(context.threadId),
      turnId: normalizeText(context.turnId),
      workspaceRoot: normalizeText(context.workspaceRoot),
      text: quote.text,
      meta: {
        ...(quote.quote ? { quote: quote.quote } : {}),
        attachments,
        files: attachments.filter((item) => item.kind === "file"),
        stickers: attachments.filter((item) => item.kind === "sticker"),
        runtimeId: normalizeText(context.runtimeId),
      },
      source: {
        provider: prepared.provider === "weixin" ? "weixin" : "import",
        sourceType: "weixin.inbound",
        rawId: normalizeText(prepared.messageId) || buildInboundRawId(prepared),
      },
    })

    this.rememberInboundEquivalent(record)
    this.updateLastTimestamp([record])
    return this.writer.writeRecords([record])
  }

  registerRealtimeSource({ runtimeId = "", threadId = "", workspaceRoot = "", sourceFile = "" } = {}) {
    return this.sourceResolver.rememberSourceFile({
      runtimeId,
      threadId,
      workspaceRoot,
      sourceFile,
    })
  }

  ingestRealtimeSessionLine({ runtimeId = "", raw = null, sourceFile = "", sourceLine = 0, workspaceRoot = "" } = {}) {
    return this.ingestSessionLine({
      runtimeId,
      raw,
      sourceFile,
      sourceLine,
      workspaceRoot,
      mode: "realtime",
    })
  }

  recordRuntimeRaw({ runtimeId = "", raw = null, mappedEvent = null, workspaceRoot = "" } = {}) {
    const threadId = extractThreadId(runtimeId, raw, mappedEvent)
    const sourceFile = this.sourceResolver.resolveSourceFile({
      runtimeId,
      threadId,
      workspaceRoot,
    })
    if (!sourceFile) {
      return { writtenCount: 0, warnings: [] }
    }

    const lines = this.tailer.readAvailableLines(sourceFile)
    if (!lines.length) {
      return { writtenCount: 0, warnings: [] }
    }

    const records = []
    const warnings = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.rawLine)
        const result = this.ingestSessionLine({
          runtimeId,
          raw: parsed,
          sourceFile: line.sourceFile,
          sourceLine: line.sourceLine,
          workspaceRoot,
          mode: "realtime",
          deferWrite: true,
        })
        records.push(...result.records)
        warnings.push(...result.warnings)
      } catch (error) {
        warnings.push(`Invalid realtime JSONL line ${line.sourceLine} in ${sourceFile}: ${error.message}`)
      }
    }

    this.updateLastTimestamp(records)
    const writeResult = this.writer.writeRecords(records)
    return {
      writtenCount: writeResult.writtenCount,
      warnings: [...warnings, ...writeResult.warnings],
    }
  }

  ingestSessionLine({ runtimeId = "", raw = null, sourceFile = "", sourceLine = 0, workspaceRoot = "", mode = "import", deferWrite = false } = {}) {
    const parser = this.getLineParser(runtimeId, mode)
    const parsedRecords = parser.parseRaw({
      raw,
      workspaceRoot,
      sourceFile,
      sourceLine,
      fallbackTimestamp: this.lastTimestamp,
    })
    const records = parsedRecords.filter((record) => !this.shouldDropRealtimeRecord(record, mode))
    this.updateLastTimestamp(records)
    if (deferWrite) {
      return {
        records,
        warnings: [],
      }
    }
    const writeResult = this.writer.writeRecords(records)
    return {
      records,
      warnings: writeResult.warnings,
      writtenCount: writeResult.writtenCount,
    }
  }

  getLineParser(runtimeId = "", mode = "realtime") {
    const normalized = normalizeText(runtimeId).toLowerCase() || "codex"
    const cacheKey = `${normalized}:${mode}`
    if (!this.parsers.has(cacheKey)) {
      this.parsers.set(cacheKey, createLineParser(normalized, mode, this.config.stateDir))
    }
    return this.parsers.get(cacheKey)
  }

  updateLastTimestamp(records = []) {
    for (const record of records) {
      const timestamp = normalizeText(record?.timestamp)
      if (timestamp) {
        this.lastTimestamp = timestamp
      }
    }
  }

  rememberInboundEquivalent(record) {
    if (record?.type !== "user") {
      return
    }
    this.recentInboundUserRecords.push({
      text: normalizeText(record.text),
      threadId: normalizeText(record.threadId),
      workspaceRoot: normalizeText(record.workspaceRoot),
      timestamp: normalizeText(record.timestamp),
    })
    if (this.recentInboundUserRecords.length > 20) {
      this.recentInboundUserRecords.shift()
    }
  }

  shouldDropRealtimeRecord(record, mode = "") {
    if (mode !== "realtime") {
      return false
    }
    if (record?.type !== "user" || normalizeText(record?.runtimeId) !== "codex") {
      return false
    }
    if (normalizeText(record?.source?.provider) !== "codex") {
      return false
    }
    const text = normalizeText(record.text)
    if (!text) {
      return false
    }
    return this.recentInboundUserRecords.some((entry) => (
      entry.text === text
      && (!entry.threadId || !record.threadId || entry.threadId === record.threadId)
      && (!entry.workspaceRoot || !record.workspaceRoot || entry.workspaceRoot === record.workspaceRoot)
    ))
  }
}

function createLineParser(runtimeId, mode, stateDir) {
  if (runtimeId === "claudecode") {
    return createClaudeCodeImportParser({ mode, stateDir })
  }
  return createCodexImportParser({ mode, stateDir })
}

function extractQuote(text) {
  const normalized = String(text || "")
  const match = normalized.match(/^\[Quoted:\s*([^\]]+)\]\s*\r?\n([\s\S]*)$/u)
  if (!match) {
    return {
      text: normalized.trim(),
      quote: undefined,
    }
  }
  return {
    text: String(match[2] || "").trim(),
    quote: match[1].trim(),
  }
}

function buildInboundRawId(prepared = {}) {
  const parts = [
    normalizeText(prepared.senderId),
    normalizeText(prepared.receivedAt),
    normalizeText(prepared.originalText || prepared.text),
    ...normalizeMediaList(prepared.attachments).map((item) => normalizeText(item.path || item.fileName || item.stickerId)),
  ]
  return parts.filter(Boolean).join("|")
}

function extractThreadId(runtimeId, raw, mappedEvent) {
  if (normalizeText(runtimeId).toLowerCase() === "claudecode") {
    return normalizeText(mappedEvent?.payload?.threadId || raw?.sessionId || raw?.session_id)
  }
  return normalizeText(
    mappedEvent?.payload?.threadId
    || raw?.params?.threadId
    || raw?.params?.turn?.threadId
    || raw?.payload?.id
  )
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  ConversationArchive,
}
