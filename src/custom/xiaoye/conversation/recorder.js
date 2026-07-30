const fs = require("fs")
const path = require("path")

const { normalizeConversationRecord } = require("./normalize-record")
const { mergeMediaLists, normalizeMediaList } = require("./normalize-media")
const { ConversationWriter } = require("./writer")
const { RealtimeTailer } = require("./realtime-tailer")
const { ConversationSourceLineResolver } = require("./source-line-resolver")
const { createClaudeCodeImportParser } = require("./providers/claudecode-import")
const { createCodexImportParser } = require("./providers/codex-import")
const { parseQuotedEnvelope } = require("../shared/quoted-envelope")

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
    this.webTurnByMessageId = new Map()
    this.webTurnByCanonicalKey = new Map()
    this.maxWebTurnCorrelations = Number(this.config.maxWebTurnCorrelations) > 0
      ? Math.floor(Number(this.config.maxWebTurnCorrelations))
      : 512
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
    this.webTurnByMessageId.clear()
    this.webTurnByCanonicalKey.clear()
    this.hydratedRealtimeSources.clear()
    this.newlyBootstrappedRealtimeSources.clear()
    this.tailer.clear?.()
  }

  dispose() {
    this.close()
  }

  deleteThreadRecords({ threadId = "" } = {}) {
    return this.writer.deleteThreadRecords({ threadId })
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

  recordMergedWebInbound(prepared = {}, context = {}) {
    const correlation = this.rememberWebInboundTurn(prepared, context)
    const record = this.buildMergedWebInboundRecord(prepared, context, correlation)
    return this.writer.writeRecords([record])
  }

  buildMergedWebInboundRecord(prepared = {}, context = {}, correlation = null) {
    const messageId = normalizeText(prepared.messageId)
    if (!messageId) {
      throw new Error("merged web inbound requires messageId")
    }
    const requestId = normalizeText(prepared.requestId)
    const logicalTurnId = normalizeText(prepared.logicalTurnId)
      || (requestId ? `web:${requestId}` : "")
    const resolvedCorrelation = correlation || this.webTurnByMessageId.get(messageId) || null
    const bubbleSegments = normalizeWebBubbleSegments(prepared.bubbleSegments)
    const quote = extractQuote(prepared.originalText || prepared.text || "")
    const displayText = bubbleSegments
      .map((segment) => normalizeText(segment.text))
      .filter(Boolean)
      .join("\n\n") || quote.text
    const attachments = normalizeMediaList(prepared.attachments, {
      workspaceRoot: context.workspaceRoot,
      stateDir: this.config.stateDir,
    })
    return normalizeConversationRecord({
      id: `web-user-${messageId}`,
      messageId,
      type: "user",
      timestamp: prepared.receivedAt || new Date().toISOString(),
      runtimeId: normalizeText(context.runtimeId),
      threadId: normalizeText(resolvedCorrelation?.threadId || context.threadId),
      turnId: normalizeText(resolvedCorrelation?.canonicalTurnId || context.turnId),
      workspaceRoot: normalizeText(context.workspaceRoot),
      text: displayText,
      meta: {
        messageId,
        ...(requestId ? { requestId } : {}),
        ...(logicalTurnId ? { logicalTurnId, displayTurnId: logicalTurnId } : {}),
        ...(normalizeText(resolvedCorrelation?.transportTurnId)
          ? { transportTurnId: normalizeText(resolvedCorrelation.transportTurnId) }
          : {}),
        ...(normalizeText(resolvedCorrelation?.canonicalTurnId)
          ? { canonicalTurnId: normalizeText(resolvedCorrelation.canonicalTurnId) }
          : {}),
        ...(bubbleSegments.length ? { bubbleSegments } : {}),
        ...(quote.quote && bubbleSegments.length <= 1 ? { quote: quote.quote } : {}),
        attachments: attachments.filter((item) => item.kind !== "file"),
        files: attachments.filter((item) => item.kind === "file"),
        stickers: attachments.filter((item) => item.kind === "sticker"),
      },
      source: {
        provider: "web",
        sourceType: "web.message.user",
        rawId: messageId,
        sourceKey: `web|message|${messageId}`,
      },
    })
  }

  recordWebInboundBatch(messages = [], context = {}) {
    const sourceMessages = (Array.isArray(messages) ? messages : []).filter(Boolean)
    const latest = sourceMessages[sourceMessages.length - 1] || {}
    return this.recordMergedWebInbound({
      ...latest,
      messageId: normalizeText(context.messageId || latest.messageId),
      originalText: sourceMessages
        .map((message) => normalizeText(message.originalText || message.text))
        .filter(Boolean)
        .join("\n\n"),
      bubbleSegments: sourceMessages.map((message) => ({
        segmentId: normalizeText(message.segmentId || message.messageId),
        text: normalizeText(message.originalText || message.text),
      })),
    }, context)
  }

  rememberWebInboundTurn(prepared = {}, context = {}) {
    const messageId = normalizeText(prepared.messageId)
    if (!messageId) return null
    const existing = this.webTurnByMessageId.get(messageId) || null
    const requestId = normalizeText(prepared.requestId || existing?.requestId)
    const logicalTurnId = normalizeText(prepared.logicalTurnId || existing?.logicalTurnId)
      || (requestId ? `web:${requestId}` : "")
    const contextTurnId = normalizeText(context.turnId)
    const canonicalTurnId = normalizeText(existing?.canonicalTurnId)
    const transportTurnId = contextTurnId
      && contextTurnId !== logicalTurnId
      && contextTurnId !== canonicalTurnId
      ? contextTurnId
      : normalizeText(existing?.transportTurnId)
    const bubbleSegments = normalizeWebBubbleSegments(prepared.bubbleSegments)
    const next = {
      ...existing,
      requestId,
      messageId,
      logicalTurnId,
      displayTurnId: logicalTurnId,
      transportTurnId,
      canonicalTurnId,
      runtimeId: normalizeText(context.runtimeId || existing?.runtimeId),
      threadId: normalizeText(context.threadId || existing?.threadId),
      workspaceRoot: normalizeText(context.workspaceRoot || existing?.workspaceRoot),
      text: bubbleSegments.map((segment) => segment.text).filter(Boolean).join("\n\n")
        || normalizeText(prepared.originalText || prepared.text || existing?.text),
      prepared: {
        ...(existing?.prepared || {}),
        ...prepared,
        messageId,
        requestId,
        logicalTurnId,
        ...(bubbleSegments.length ? { bubbleSegments } : {}),
      },
      createdAtMs: existing?.createdAtMs || Date.now(),
      updatedAtMs: Date.now(),
    }
    this.webTurnByMessageId.set(messageId, next)
    if (canonicalTurnId && next.threadId) {
      this.webTurnByCanonicalKey.set(buildWebCanonicalTurnKey(next.threadId, canonicalTurnId), next)
    }
    this.pruneWebTurnCorrelations()
    return next
  }

  recordWebTurnCorrelation(payload = {}) {
    const entry = this.findWebTurnForCorrelation(payload)
    if (!entry) return { writtenCount: 0, warnings: [] }
    const correlated = this.correlateWebTurn(entry, {
      threadId: payload.threadId,
      canonicalTurnId: payload.canonicalTurnId,
      transportTurnId: payload.transportTurnId,
    })
    const record = this.buildMergedWebInboundRecord(correlated.prepared, {
      runtimeId: correlated.runtimeId,
      threadId: correlated.threadId,
      turnId: correlated.canonicalTurnId,
      workspaceRoot: correlated.workspaceRoot,
    }, correlated)
    return this.writer.writeRecords([record])
  }

  findWebTurnForCorrelation(payload = {}) {
    const messageId = normalizeText(payload.messageId)
    if (messageId && this.webTurnByMessageId.has(messageId)) {
      return this.webTurnByMessageId.get(messageId)
    }
    const requestId = normalizeText(payload.requestId)
    const transportTurnId = normalizeText(payload.transportTurnId)
    return [...this.webTurnByMessageId.values()].find((entry) => (
      (requestId && entry.requestId === requestId)
      || (transportTurnId && entry.transportTurnId === transportTurnId)
    )) || null
  }

  correlateWebTurn(entry, { threadId = "", canonicalTurnId = "", transportTurnId = "" } = {}) {
    const next = {
      ...entry,
      threadId: normalizeText(threadId || entry.threadId),
      canonicalTurnId: normalizeText(canonicalTurnId || entry.canonicalTurnId),
      transportTurnId: normalizeText(transportTurnId || entry.transportTurnId),
      updatedAtMs: Date.now(),
    }
    this.webTurnByMessageId.set(next.messageId, next)
    if (next.threadId && next.canonicalTurnId) {
      this.webTurnByCanonicalKey.set(
        buildWebCanonicalTurnKey(next.threadId, next.canonicalTurnId),
        next,
      )
    }
    return next
  }

  decorateWebTurnRecord(record) {
    const threadId = normalizeText(record?.threadId)
    const canonicalTurnId = normalizeText(record?.turnId)
    if (!threadId || !canonicalTurnId) return record
    const entry = this.webTurnByCanonicalKey.get(
      buildWebCanonicalTurnKey(threadId, canonicalTurnId),
    )
    if (!entry) return record
    return {
      ...record,
      meta: {
        ...(record.meta || {}),
        ...(entry.requestId ? { requestId: entry.requestId } : {}),
        ...(entry.messageId ? { requestMessageId: entry.messageId } : {}),
        ...(entry.logicalTurnId ? {
          logicalTurnId: entry.logicalTurnId,
          displayTurnId: entry.displayTurnId || entry.logicalTurnId,
        } : {}),
        ...(entry.transportTurnId ? { transportTurnId: entry.transportTurnId } : {}),
        ...(entry.canonicalTurnId ? { canonicalTurnId: entry.canonicalTurnId } : {}),
      },
    }
  }

  reconcileRawWebUser(record) {
    const threadId = normalizeText(record?.threadId)
    const canonicalTurnId = normalizeText(record?.turnId)
    if (!threadId || !canonicalTurnId) return { matched: false, record }
    const canonicalKey = buildWebCanonicalTurnKey(threadId, canonicalTurnId)
    if (this.webTurnByCanonicalKey.has(canonicalKey)) {
      return { matched: true, record: null }
    }

    const candidates = [...this.webTurnByMessageId.values()]
      .filter((entry) => !entry.canonicalTurnId)
      .filter((entry) => !entry.runtimeId || entry.runtimeId === normalizeText(record.runtimeId))
      .filter((entry) => !entry.threadId || entry.threadId === threadId)
      .filter((entry) => !entry.workspaceRoot || !record.workspaceRoot || sameScopePath(entry.workspaceRoot, record.workspaceRoot))
      .sort((left, right) => {
        const rawText = normalizeText(record.text)
        const leftMatches = rawText && normalizeText(left.text) === rawText ? 1 : 0
        const rightMatches = rawText && normalizeText(right.text) === rawText ? 1 : 0
        return rightMatches - leftMatches || left.createdAtMs - right.createdAtMs
      })
    const entry = candidates[0]
    if (!entry) return { matched: false, record }
    const correlated = this.correlateWebTurn(entry, {
      threadId,
      canonicalTurnId,
      transportTurnId: entry.transportTurnId,
    })
    return {
      matched: true,
      record: this.buildMergedWebInboundRecord(correlated.prepared, {
        runtimeId: correlated.runtimeId || record.runtimeId,
        threadId,
        turnId: canonicalTurnId,
        workspaceRoot: correlated.workspaceRoot || record.workspaceRoot,
      }, correlated),
    }
  }

  pruneWebTurnCorrelations() {
    if (this.webTurnByMessageId.size <= this.maxWebTurnCorrelations) return
    const oldest = [...this.webTurnByMessageId.values()]
      .sort((left, right) => left.updatedAtMs - right.updatedAtMs)
      .slice(0, this.webTurnByMessageId.size - this.maxWebTurnCorrelations)
    for (const entry of oldest) {
      this.webTurnByMessageId.delete(entry.messageId)
      if (entry.threadId && entry.canonicalTurnId) {
        this.webTurnByCanonicalKey.delete(buildWebCanonicalTurnKey(entry.threadId, entry.canonicalTurnId))
      }
    }
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
    const correlationResult = mappedEvent?.type === "runtime.turn.correlated"
      ? this.recordWebTurnCorrelation(mappedEvent.payload)
      : { writtenCount: 0, warnings: [] }
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
      writtenCount: correlationResult.writtenCount + directResult.writtenCount + pollResult.writtenCount,
      warnings: [...correlationResult.warnings, ...directResult.warnings, ...pollResult.warnings],
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
      .map((record) => this.decorateWebTurnRecord(record))
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
    if (this.hasCanonicalWebUserForTurn(record)) {
      return true
    }
    return false
  }

  mergePendingInboundRecord(record, mode = "") {
    if (mode !== "realtime" || record?.type !== "user") {
      return record
    }
    const webReconciliation = this.reconcileRawWebUser(record)
    if (webReconciliation.matched) {
      return webReconciliation.record
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

  hasCanonicalWebUserForTurn(record) {
    const threadId = normalizeText(record?.threadId)
    const turnId = normalizeText(record?.turnId)
    if (!threadId || !turnId) {
      return false
    }
    const existing = this.writer.readExistingDayRecords(
      this.writer.resolveDayFilePath(record.date),
      []
    )
    return existing.some((candidate) => (
      candidate.type === "user"
      && normalizeText(candidate.threadId) === threadId
      && normalizeText(candidate.turnId) === turnId
      && normalizeText(candidate?.source?.provider) === "web"
      && normalizeText(candidate.messageId || candidate?.meta?.messageId)
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
  return parseQuotedEnvelope(text)
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
  return mergeMediaLists(left, right)
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

function normalizeWebBubbleSegments(segments = []) {
  return (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment && typeof segment === "object")
    .map((segment) => ({
      segmentId: normalizeText(segment.segmentId),
      text: normalizeText(segment.text),
      ...(segment.quote ? { quote: segment.quote } : {}),
      ...(Array.isArray(segment.attachments) && segment.attachments.length
        ? { attachments: segment.attachments }
        : {}),
    }))
    .filter((segment) => segment.segmentId)
}

function buildWebCanonicalTurnKey(threadId, canonicalTurnId) {
  return `${normalizeText(threadId)}\u0000${normalizeText(canonicalTurnId)}`
}

function sameScopePath(left, right) {
  const normalize = (value) => normalizeText(value).replace(/\\/g, "/").toLowerCase()
  return normalize(left) === normalize(right)
}
