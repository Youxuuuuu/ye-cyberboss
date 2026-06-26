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
    this.pendingInboundUserRecords = []
    this.trackedRealtimeSources = new Map()
    this.pendingInboundTtlMs = Number(this.config.pendingInboundTtlMs) > 0
      ? Number(this.config.pendingInboundTtlMs)
      : 10 * 60 * 1000
    this.realtimePollIntervalMs = Number(this.config.realtimePollIntervalMs) > 0
      ? Number(this.config.realtimePollIntervalMs)
      : 1500
    this.realtimePollTimer = setInterval(() => {
      try {
        this.pollRealtimeSources()
      } catch {
        // ignore polling failures and wait for the next tick
      }
    }, this.realtimePollIntervalMs)
    this.realtimePollTimer.unref?.()
  }

  recordInboundMessage(prepared, context = {}) {
    if (!prepared || prepared.provider === "system") {
      return { writtenCount: 0, warnings: [] }
    }

    this.cleanupExpiredPendingInboundRecords()
    const quote = extractQuote(prepared.originalText || prepared.text || "")
    const attachments = normalizeMediaList(prepared.attachments, {
      workspaceRoot: context.workspaceRoot,
      stateDir: this.config.stateDir,
    })
    const entry = {
      id: `${normalizeText(prepared.messageId) || buildInboundRawId(prepared)}|${Date.now()}`,
      runtimeId: normalizeText(context.runtimeId),
      threadId: normalizeText(context.threadId),
      turnId: normalizeText(context.turnId),
      workspaceRoot: normalizeText(context.workspaceRoot),
      text: quote.text,
      quote: quote.quote,
      attachments: attachments.filter((item) => item.kind !== "file"),
      files: attachments.filter((item) => item.kind === "file"),
      stickers: attachments.filter((item) => item.kind === "sticker"),
      messageId: normalizeText(prepared.messageId),
      receivedAt: prepared.receivedAt || new Date().toISOString(),
    }
    this.pendingInboundUserRecords.push(entry)
    return { writtenCount: 0, warnings: [] }
  }

  registerRealtimeSource({ runtimeId = "", threadId = "", workspaceRoot = "", sourceFile = "" } = {}) {
    const remembered = this.sourceResolver.rememberSourceFile({
      runtimeId,
      threadId,
      workspaceRoot,
      sourceFile,
    })
    if (remembered) {
      this.trackedRealtimeSources.set(remembered, {
        runtimeId: normalizeText(runtimeId),
        threadId: normalizeText(threadId),
        workspaceRoot: normalizeText(workspaceRoot),
      })
    }
    return remembered
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
    if (sourceFile) {
      this.registerRealtimeSource({
        runtimeId,
        threadId,
        workspaceRoot,
        sourceFile,
      })
    }
    return this.pollRealtimeSources()
  }

  pollRealtimeSources() {
    const records = []
    const warnings = []
    const trackedEntries = [...this.trackedRealtimeSources.entries()]
    this.cleanupExpiredPendingInboundRecords()

    for (const [sourceFile, context] of trackedEntries) {
      const lines = this.tailer.readAvailableLines(sourceFile)
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line.rawLine)
          const result = this.ingestSessionLine({
            runtimeId: context.runtimeId,
            raw: parsed,
            sourceFile: line.sourceFile,
            sourceLine: line.sourceLine,
            workspaceRoot: context.workspaceRoot,
            mode: "realtime",
            deferWrite: true,
          })
          records.push(...result.records)
          warnings.push(...result.warnings)
        } catch (error) {
          warnings.push(`Invalid realtime JSONL line ${line.sourceLine} in ${sourceFile}: ${error.message}`)
        }
      }
    }

    this.updateLastTimestamp(records)
    if (!records.length) {
      return { writtenCount: 0, warnings }
    }
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
    const mergedRecords = parsedRecords
      .map((record) => this.mergePendingInboundRecord(record, mode))
      .filter(Boolean)
    const records = mergedRecords.filter((record) => !this.shouldDropRealtimeRecord(record, mode))
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

  shouldDropRealtimeRecord(record, mode = "") {
    if (mode !== "realtime") {
      return false
    }
    if (record?.type !== "user") {
      return false
    }
    if (normalizeText(record?.meta?.visibleAs) === "system_compact") {
      return false
    }
    if (!normalizeText(record.text) && hasMedia(record.meta) && this.hasRecentCanonicalRealtimeUser(record)) {
      return true
    }
    return false
  }

  mergePendingInboundRecord(record, mode = "") {
    if (mode !== "realtime" || record?.type !== "user") {
      return record
    }
    const pending = this.findMatchingPendingInbound(record)
    if (!pending) {
      return record
    }
    this.consumePendingInbound(pending.id)
    return normalizeConversationRecord({
      ...record,
      text: normalizeText(record.text) || pending.text,
      meta: {
        ...record.meta,
        ...(record.meta?.quote == null && pending.quote ? { quote: pending.quote } : {}),
        ...(pending.messageId ? { messageId: pending.messageId } : {}),
        attachments: mergeMediaArrays(record.meta?.attachments, pending.attachments),
        files: mergeMediaArrays(record.meta?.files, pending.files),
        stickers: mergeMediaArrays(record.meta?.stickers, pending.stickers),
      },
    })
  }

  findMatchingPendingInbound(record) {
    this.cleanupExpiredPendingInboundRecords()
    const candidates = this.pendingInboundUserRecords.filter((entry) => (
      entry.runtimeId === normalizeText(record.runtimeId)
      && (!entry.threadId || !record.threadId || entry.threadId === record.threadId)
      && (!entry.workspaceRoot || !record.workspaceRoot || entry.workspaceRoot === record.workspaceRoot)
    ))
    if (!candidates.length) {
      return null
    }

    const text = normalizeText(record.text)
    const exact = text
      ? candidates.find((entry) => normalizeText(entry.text) === text)
      : null
    if (exact) {
      return exact
    }

    if (!text && hasMedia(record.meta)) {
      const mediaCandidates = candidates.filter((entry) => hasMedia(entry))
      if (!mediaCandidates.length) {
        return null
      }
      const recordMediaSignature = buildMediaSignature(record.meta)
      if (recordMediaSignature) {
        const exactMedia = mediaCandidates.find((entry) => buildMediaSignature(entry) === recordMediaSignature)
        if (exactMedia) {
          return exactMedia
        }
      }
      if (mediaCandidates.length === 1) {
        return mediaCandidates[0]
      }
    }

    return null
  }

  cleanupExpiredPendingInboundRecords(now = Date.now()) {
    if (!Number.isFinite(this.pendingInboundTtlMs) || this.pendingInboundTtlMs <= 0) {
      return
    }
    this.pendingInboundUserRecords = this.pendingInboundUserRecords.filter((entry) => {
      const receivedAtMs = Date.parse(entry?.receivedAt || "")
      return Number.isFinite(receivedAtMs) && (now - receivedAtMs) < this.pendingInboundTtlMs
    })
  }

  consumePendingInbound(id) {
    const index = this.pendingInboundUserRecords.findIndex((entry) => entry.id === id)
    if (index < 0) {
      return null
    }
    const [entry] = this.pendingInboundUserRecords.splice(index, 1)
    return entry
  }

  hasRecentCanonicalRealtimeUser(record) {
    const text = normalizeText(record.text)
    if (text) {
      return false
    }
    const comparisonTime = Date.parse(record.timestamp || "")
    if (!Number.isFinite(comparisonTime)) {
      return false
    }
    const existing = this.writer.readExistingDayRecords(
      this.writer.resolveDayFilePath(record.date),
      []
    )
    return existing.some((candidate) => (
      candidate.type === "user"
      && candidate.runtimeId === record.runtimeId
      && candidate.threadId === record.threadId
      && normalizeText(candidate.text)
      && Math.abs(Date.parse(candidate.timestamp) - comparisonTime) < 60_000
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

function hasMedia(subject = {}) {
  return (
    (Array.isArray(subject?.attachments) && subject.attachments.length > 0)
    || (Array.isArray(subject?.files) && subject.files.length > 0)
    || (Array.isArray(subject?.stickers) && subject.stickers.length > 0)
    || (Array.isArray(subject?.meta?.attachments) && subject.meta.attachments.length > 0)
    || (Array.isArray(subject?.meta?.files) && subject.meta.files.length > 0)
    || (Array.isArray(subject?.meta?.stickers) && subject.meta.stickers.length > 0)
  )
}

function mergeMediaArrays(left = [], right = []) {
  const result = []
  const seen = new Set()
  for (const item of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
    const signature = JSON.stringify(item)
    if (seen.has(signature)) {
      continue
    }
    seen.add(signature)
    result.push(item)
  }
  return result
}

function buildMediaSignature(subject = {}) {
  const items = [
    ...(Array.isArray(subject?.attachments) ? subject.attachments : []),
    ...(Array.isArray(subject?.files) ? subject.files : []),
    ...(Array.isArray(subject?.stickers) ? subject.stickers : []),
    ...(Array.isArray(subject?.meta?.attachments) ? subject.meta.attachments : []),
    ...(Array.isArray(subject?.meta?.files) ? subject.meta.files : []),
    ...(Array.isArray(subject?.meta?.stickers) ? subject.meta.stickers : []),
  ]
  const normalized = items
    .map((item) => normalizeText(item?.filePath || item?.path || item?.relativePath || item?.stickerId || item?.fileName))
    .filter(Boolean)
    .sort()
  return normalized.length ? normalized.join("|") : ""
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  ConversationArchive,
}
