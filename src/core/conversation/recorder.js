const path = require("path")

const { normalizeConversationRecord } = require("./normalize-record")
const { normalizeMediaList } = require("./normalize-media")
const { ConversationWriter } = require("./writer")
const { createClaudeCodeRealtimeParser } = require("./providers/claudecode-realtime")
const { createCodexRealtimeParser } = require("./providers/codex-realtime")

class ConversationArchive {
  constructor({ config, writer = null } = {}) {
    this.config = config || {}
    this.writer = writer || new ConversationWriter({
      conversationDir: this.config.conversationDir,
    })
    this.parsers = new Map()
    this.lastTimestamp = ""
    this.nextRealtimeSourceLine = 1
  }

  recordInboundMessage(prepared, context = {}) {
    if (!prepared || prepared.provider === "system") {
      return { writtenCount: 0, warnings: [] }
    }

    const quote = extractQuote(prepared.originalText || prepared.text || "")
    const attachments = normalizeMediaList(prepared.attachments)
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
        sourceLine: this.allocateSourceLine(),
        rawId: normalizeText(prepared.messageId) || buildInboundRawId(prepared),
      },
    })

    this.updateLastTimestamp([record])
    return this.writer.writeRecords([record])
  }

  recordRuntimeRaw({ runtimeId = "", raw = null, mappedEvent = null, workspaceRoot = "" } = {}) {
    const parser = this.getRealtimeParser(runtimeId)
    const records = parser.parseRaw({
      raw,
      mappedEvent,
      fallbackTimestamp: this.lastTimestamp,
      workspaceRoot,
      sourceLine: this.allocateSourceLine(),
    })
    this.updateLastTimestamp(records)
    return this.writer.writeRecords(records)
  }

  getRealtimeParser(runtimeId = "") {
    const normalized = normalizeText(runtimeId).toLowerCase() || "codex"
    if (!this.parsers.has(normalized)) {
      this.parsers.set(normalized, createRealtimeParser(normalized))
    }
    return this.parsers.get(normalized)
  }

  updateLastTimestamp(records = []) {
    for (const record of records) {
      const timestamp = normalizeText(record?.timestamp)
      if (timestamp) {
        this.lastTimestamp = timestamp
      }
    }
  }

  allocateSourceLine() {
    const next = this.nextRealtimeSourceLine
    this.nextRealtimeSourceLine += 1
    return next
  }
}

function createRealtimeParser(runtimeId) {
  if (runtimeId === "claudecode") {
    return createClaudeCodeRealtimeParser()
  }
  return createCodexRealtimeParser()
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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  ConversationArchive,
}
