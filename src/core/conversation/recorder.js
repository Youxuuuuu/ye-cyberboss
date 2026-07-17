const fs = require("fs")
const path = require("path")

const { normalizeConversationRecord } = require("./normalize-record")
const { normalizeMediaList } = require("./normalize-media")
const { ConversationWriter } = require("./writer")
const { RealtimeTailer } = require("./realtime-tailer")
const { ConversationSourceLineResolver } = require("./source-line-resolver")
const { createClaudeCodeImportParser } = require("./providers/claudecode-import")
const { createCodexImportParser } = require("./providers/codex-import")

class ConversationArchive {
  constructor({ config, writer = null, logger = console } = {}) {
    this.config = config || {}
    this.logger = logger
    const conversationStateRoot = path.resolve(
      normalizeText(this.config.stateDir) || normalizeText(this.config.conversationDir) || "."
    )
    this.writer = writer || new ConversationWriter({
      conversationDir: this.config.conversationDir,
      deletionStateFile: this.config.conversationDeletionStateFile
        || path.join(path.resolve(normalizeText(this.config.conversationDir) || "."), ".conversation-deletion-state.json"),
      logger,
    })
    this.parsers = new Map()
    this.lastTimestampByParser = new Map()
    const checkpointFile = normalizeText(this.config.conversationRealtimeCheckpointFile)
      ? path.resolve(this.config.conversationRealtimeCheckpointFile)
      : path.join(
        conversationStateRoot,
        "conversation-realtime-checkpoints.json"
      )
    this.tailer = new RealtimeTailer({
      checkpointFile,
      bootstrapToEnd: this.writer.hasExistingConversationFiles?.() || false,
      logger,
    })
    this.hydratedRealtimeSources = new Set()
    this.newlyBootstrappedRealtimeSources = new Set()
    this.sourceResolver = new ConversationSourceLineResolver({
      codexHome: this.config.codexHome,
      claudeConfigDir: this.config.claudeConfigDir,
      maxEntries: this.config.maxSourceResolverEntries,
    })
    this.pendingInboundUserRecords = []
    this.trackedRealtimeSources = new Map()
    this.pendingInboundTtlMs = Number(this.config.pendingInboundTtlMs) > 0
      ? Number(this.config.pendingInboundTtlMs)
      : 10 * 60 * 1000
    this.pendingInboundQuarantinedCount = 0
    const quarantineRoot = normalizeText(this.writer?.conversationDir)
      || normalizeText(this.config.conversationDir)
      || normalizeText(this.config.stateDir)
      || "."
    this.pendingInboundQuarantineFile = normalizeText(this.config.pendingInboundQuarantineFile)
      ? path.resolve(this.config.pendingInboundQuarantineFile)
      : path.join(path.resolve(quarantineRoot), "_unmatched-inbound.jsonl")
    this.maxTrackedRealtimeSources = Number(this.config.maxTrackedRealtimeSources) > 0
      ? Math.floor(Number(this.config.maxTrackedRealtimeSources))
      : 256
    this.realtimePollIntervalMs = Number(this.config.realtimePollIntervalMs) > 0
      ? Number(this.config.realtimePollIntervalMs)
      : 1500
    this.lastPollAtMs = 0
    this.closed = false
    this.realtimePollTimer = null
  }

  startRealtimePolling() {
    if (this.closed || this.realtimePollTimer || !this.trackedRealtimeSources.size) {
      return
    }
    this.realtimePollTimer = setInterval(() => {
      if (this.closed) {
        return
      }
      try {
        const result = this.pollRealtimeSources({ force: false })
        this.logWarnings(result?.warnings)
      } catch (error) {
        this.logger?.warn?.(`[conversation] realtime polling failed: ${formatErrorMessage(error)}`)
      }
    }, this.realtimePollIntervalMs)
    this.realtimePollTimer.unref?.()
  }

  stopRealtimePolling() {
    if (!this.realtimePollTimer) {
      return
    }
    clearInterval(this.realtimePollTimer)
    this.realtimePollTimer = null
  }

  close() {
    if (this.closed) {
      return
    }
    this.quarantinePendingInboundRecords("archive_closed")
    this.closed = true
    this.stopRealtimePolling()
    this.parsers.clear()
    this.lastTimestampByParser.clear()
    this.trackedRealtimeSources.clear()
    this.sourceResolver.clear?.()
    this.pendingInboundUserRecords = []
    this.hydratedRealtimeSources.clear()
    this.newlyBootstrappedRealtimeSources.clear()
    this.tailer.clear?.()
  }

  dispose() {
    this.close()
  }

  resetParserStateForSource(sourceFile) {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    this.hydratedRealtimeSources.delete(normalizedSourceFile)
    this.newlyBootstrappedRealtimeSources.delete(normalizedSourceFile)
    for (const key of this.parsers.keys()) {
      if (key.endsWith(`\u0000${normalizedSourceFile}`)) {
        this.parsers.delete(key)
        this.lastTimestampByParser.delete(key)
      }
    }
  }

  pruneTrackedRealtimeSources() {
    if (this.trackedRealtimeSources.size <= this.maxTrackedRealtimeSources) {
      return
    }
    const oldest = [...this.trackedRealtimeSources.entries()]
      .sort(([, left], [, right]) => (left.lastSeenAt || 0) - (right.lastSeenAt || 0))
      .slice(0, this.trackedRealtimeSources.size - this.maxTrackedRealtimeSources)
    for (const [sourceFile] of oldest) {
      this.unregisterRealtimeSource({ sourceFile })
    }
  }

  logWarnings(warnings = []) {
    for (const warning of Array.isArray(warnings) ? warnings : []) {
      this.logger?.warn?.(`[conversation] ${warning}`)
    }
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
    assertRuntimeId(runtimeId)
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    const remembered = this.sourceResolver.rememberSourceFile({
      runtimeId,
      threadId,
      workspaceRoot,
      sourceFile: normalizedSourceFile,
    })
    if (remembered) {
      this.initializeRealtimeSource(remembered)
      this.trackedRealtimeSources.set(remembered, {
        runtimeId: normalizeText(runtimeId),
        threadId: normalizeText(threadId),
        workspaceRoot: normalizeText(workspaceRoot),
        lastSeenAt: Date.now(),
      })
      this.pruneTrackedRealtimeSources()
      this.startRealtimePolling()
    }
    return remembered
  }

  initializeRealtimeSource(sourceFile) {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    if (!normalizedSourceFile || !this.tailer.shouldBootstrap?.(normalizedSourceFile)) {
      return false
    }
    const bootstrapped = this.tailer.bootstrapSource?.(normalizedSourceFile) || false
    if (bootstrapped) {
      this.newlyBootstrappedRealtimeSources.add(normalizedSourceFile)
    }
    return bootstrapped
  }

  unregisterRealtimeSource({ sourceFile = "" } = {}) {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    if (!normalizedSourceFile || !this.trackedRealtimeSources.delete(normalizedSourceFile)) {
      return false
    }
    this.resetParserStateForSource(normalizedSourceFile)
    this.newlyBootstrappedRealtimeSources.delete(normalizedSourceFile)
    this.tailer.forget?.(normalizedSourceFile)
    if (!this.trackedRealtimeSources.size) {
      this.stopRealtimePolling()
    }
    return true
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
    assertRuntimeId(runtimeId)
    const threadId = extractThreadId(runtimeId, raw, mappedEvent)
    const sourceFile = this.sourceResolver.resolveSourceFile({
      runtimeId,
      threadId,
      workspaceRoot,
    })
    let directResult = { writtenCount: 0, warnings: [] }
    if (sourceFile) {
      this.registerRealtimeSource({
        runtimeId,
        threadId,
        workspaceRoot,
        sourceFile,
      })
      if (
        this.newlyBootstrappedRealtimeSources.has(sourceFile)
        && isReplayableSourceRaw(runtimeId, raw)
      ) {
        const sourcePosition = this.tailer.findSourceLineForRaw?.(sourceFile, raw)
          || { found: false, sourceLine: this.tailer.getSourceLine?.(sourceFile) + 1 || 1 }
        if (!sourcePosition.found) {
          directResult = this.ingestSessionLine({
            runtimeId,
            raw,
            sourceFile,
            sourceLine: sourcePosition.sourceLine,
            workspaceRoot,
            mode: "realtime",
          })
          this.hydratedRealtimeSources.add(sourceFile)
        }
      }
      this.newlyBootstrappedRealtimeSources.delete(sourceFile)
    }
    const pollResult = this.pollRealtimeSources({ force: true })
    return {
      writtenCount: directResult.writtenCount + pollResult.writtenCount,
      warnings: [...directResult.warnings, ...pollResult.warnings],
    }
  }

  pollRealtimeSources({ force = true } = {}) {
    if (this.closed) {
      return { writtenCount: 0, warnings: [] }
    }
    const now = Date.now()
    const throttleMs = Math.max(250, Math.floor(this.realtimePollIntervalMs / 2))
    if (!force && this.lastPollAtMs && (now - this.lastPollAtMs) < throttleMs) {
      return { writtenCount: 0, warnings: [] }
    }
    this.lastPollAtMs = now
    const records = []
    const warnings = []
    const trackedEntries = [...this.trackedRealtimeSources.entries()]
    const readSources = new Set()
    this.cleanupExpiredPendingInboundRecords()

    for (const [sourceFile, context] of trackedEntries) {
      this.initializeRealtimeSource(sourceFile)
      if (
        this.tailer.isRestored?.(sourceFile)
        && !this.hydratedRealtimeSources.has(sourceFile)
        && !this.tailer.isTruncated?.(sourceFile)
      ) {
        warnings.push(...this.hydrateRealtimeSource({
          runtimeId: context.runtimeId,
          sourceFile,
          workspaceRoot: context.workspaceRoot,
        }))
      }
      const lines = this.tailer.readAvailableLines(sourceFile)
      readSources.add(sourceFile)
      context.lastSeenAt = Date.now()
      const sourceChangeReason = this.tailer.consumeSourceChange?.(sourceFile)
      if (sourceChangeReason) {
        this.resetParserStateForSource(sourceFile)
        warnings.push(
          `Ignored non-append realtime source change (${sourceChangeReason}) in ${sourceFile}; resumed at the current file end`
        )
      } else if (this.tailer.consumeReset?.(sourceFile)) {
        this.resetParserStateForSource(sourceFile)
      }
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

    try {
      const writeResult = records.length
        ? this.writer.writeRecords(records)
        : { writtenCount: 0, warnings: [] }
      this.tailer.commit?.()
      return {
        writtenCount: writeResult.writtenCount,
        warnings: [...warnings, ...writeResult.warnings],
      }
    } catch (error) {
      this.tailer.rollback?.()
      for (const sourceFile of readSources) {
        this.resetParserStateForSource(sourceFile)
      }
      throw error
    }
  }

  hydrateRealtimeSource({ runtimeId = "", sourceFile = "", workspaceRoot = "" } = {}) {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    if (!normalizedSourceFile || !this.tailer.isRestored?.(normalizedSourceFile)) {
      return []
    }
    const parserScope = normalizedSourceFile
    const parserKey = buildParserCacheKey(runtimeId, "realtime", parserScope)
    const parser = this.getLineParser(runtimeId, "realtime", parserScope)
    const warnings = []
    for (const line of this.tailer.readHistoricalLines(normalizedSourceFile)) {
      try {
        const parsed = JSON.parse(line.rawLine)
        const records = parser.parseRaw({
          raw: parsed,
          workspaceRoot,
          sourceFile: normalizedSourceFile,
          sourceLine: line.sourceLine,
          fallbackTimestamp: this.lastTimestampByParser.get(parserKey) || "",
        })
        this.updateLastTimestamp(parserKey, records)
      } catch (error) {
        warnings.push(`Invalid realtime history JSONL line ${line.sourceLine} in ${normalizedSourceFile}: ${error.message}`)
      }
    }
    this.hydratedRealtimeSources.add(normalizedSourceFile)
    return warnings
  }

  ingestSessionLine({ runtimeId = "", raw = null, sourceFile = "", sourceLine = 0, workspaceRoot = "", mode = "import", deferWrite = false } = {}) {
    assertRuntimeId(runtimeId)
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    const parserScope = normalizedSourceFile || `thread:${extractThreadId(runtimeId, raw, null) || "inline"}`
    const parserKey = buildParserCacheKey(runtimeId, mode, parserScope)
    const parser = this.getLineParser(runtimeId, mode, parserScope)
    const parsedRecords = parser.parseRaw({
      raw,
      workspaceRoot,
      sourceFile: normalizedSourceFile,
      sourceLine,
      fallbackTimestamp: this.lastTimestampByParser.get(parserKey) || "",
    })
    const mergedRecords = parsedRecords
      .map((record) => this.mergePendingInboundRecord(record, mode))
      .filter(Boolean)
    const records = mergedRecords.filter((record) => !this.shouldDropRealtimeRecord(record, mode))
    this.updateLastTimestamp(parserKey, records)
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

  getLineParser(runtimeId = "", mode = "realtime", sourceScope = "") {
    const normalized = assertRuntimeId(runtimeId)
    const cacheKey = buildParserCacheKey(normalized, mode, sourceScope)
    if (!this.parsers.has(cacheKey)) {
      this.parsers.set(cacheKey, createLineParser(normalized, mode, this.config.stateDir))
    }
    return this.parsers.get(cacheKey)
  }

  updateLastTimestamp(parserKey, records = []) {
    for (const record of records) {
      const timestamp = normalizeText(record?.timestamp)
      if (timestamp) {
        this.lastTimestampByParser.set(parserKey, timestamp)
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
      timestamp: pending.receivedAt || record.timestamp,
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
    const active = []
    const expired = []
    for (const entry of this.pendingInboundUserRecords) {
      const receivedAtMs = Date.parse(entry?.receivedAt || "")
      if (Number.isFinite(receivedAtMs) && (now - receivedAtMs) < this.pendingInboundTtlMs) {
        active.push(entry)
      } else {
        expired.push(entry)
      }
    }
    if (expired.length > 0 && this.persistPendingInboundQuarantine(expired, "ttl_expired")) {
      this.pendingInboundUserRecords = active
      this.pendingInboundQuarantinedCount += expired.length
      this.logger?.warn?.(
        `[conversation] quarantined ${expired.length} unmatched inbound message(s) after ${this.pendingInboundTtlMs}ms; see ${this.pendingInboundQuarantineFile}`
      )
    }
  }

  quarantinePendingInboundRecords(reason = "archive_closed") {
    if (!this.pendingInboundUserRecords.length) {
      return 0
    }
    const pending = [...this.pendingInboundUserRecords]
    if (!this.persistPendingInboundQuarantine(pending, reason)) {
      return 0
    }
    this.pendingInboundUserRecords = []
    this.pendingInboundQuarantinedCount += pending.length
    this.logger?.warn?.(
      `[conversation] quarantined ${pending.length} unmatched inbound message(s) during ${reason}; see ${this.pendingInboundQuarantineFile}`
    )
    return pending.length
  }

  persistPendingInboundQuarantine(entries, reason) {
    try {
      fs.mkdirSync(path.dirname(this.pendingInboundQuarantineFile), { recursive: true })
      const body = entries
        .map((entry) => JSON.stringify({
          version: 1,
          type: "unmatched_inbound",
          reason,
          quarantinedAt: new Date().toISOString(),
          inbound: entry,
        }))
        .join("\n")
      if (body) {
        fs.appendFileSync(this.pendingInboundQuarantineFile, `${body}\n`, "utf8")
      }
      return true
    } catch (error) {
      this.logger?.error?.(
        `[conversation] could not quarantine unmatched inbound message(s): ${formatErrorMessage(error)}`
      )
      return false
    }
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
  if (runtimeId === "codex") {
    return createCodexImportParser({ mode, stateDir })
  }
  throw new Error(`unsupported conversation runtime: ${runtimeId}`)
}

function buildParserCacheKey(runtimeId, mode, sourceScope) {
  return [
    assertRuntimeId(runtimeId),
    normalizeText(mode) || "realtime",
    normalizeText(sourceScope) || "inline",
  ].join("\u0000")
}

function assertRuntimeId(runtimeId) {
  const normalized = normalizeText(runtimeId).toLowerCase()
  if (normalized !== "codex" && normalized !== "claudecode") {
    throw new Error(`unsupported conversation runtime: ${normalized || "(empty)"}`)
  }
  return normalized
}

function normalizeSourceFile(sourceFile) {
  const normalized = normalizeText(sourceFile)
  return normalized ? path.resolve(normalized) : ""
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "unknown error")
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

function isReplayableSourceRaw(runtimeId, raw) {
  if (!raw || typeof raw !== "object") {
    return false
  }
  const normalizedRuntimeId = normalizeText(runtimeId).toLowerCase()
  if (normalizedRuntimeId === "claudecode") {
    return raw.type === "user" || raw.type === "assistant"
  }
  if (normalizedRuntimeId === "codex") {
    return ["session_meta", "turn_context", "event_msg", "response_item"].includes(raw.type)
  }
  return false
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
