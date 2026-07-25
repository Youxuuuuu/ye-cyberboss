const fs = require("fs")
const path = require("path")

const { normalizeConversationRecord } = require("./normalize-record")

class ConversationWriter {
  constructor({
    conversationDir = "",
    lockTtlMs = 5 * 60 * 1000,
    deletionStateFile = "",
    logger = console,
  } = {}) {
    const normalizedDir = typeof conversationDir === "string" ? conversationDir.trim() : ""
    if (!normalizedDir) {
      throw new Error("conversation writer requires conversationDir")
    }
    this.conversationDir = path.resolve(normalizedDir)
    this.lockTtlMs = Number(lockTtlMs) > 0 ? Number(lockTtlMs) : 5 * 60 * 1000
    const normalizedDeletionStateFile = typeof deletionStateFile === "string" ? deletionStateFile.trim() : ""
    this.deletionStateFile = path.resolve(
      normalizedDeletionStateFile || path.join(this.conversationDir, ".conversation-deletion-state.json")
    )
    this.logger = logger
    this.deletionState = null
    this.ensureDeletionState()
  }

  writeRecords(records = []) {
    this.ensureDeletionState()
    const normalizedRecords = []
    const warnings = []

    for (const record of Array.isArray(records) ? records : []) {
      try {
        normalizedRecords.push(normalizeConversationRecord(record))
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error || "invalid record"))
      }
    }

    const byDate = new Map()
    for (const record of normalizedRecords) {
      const bucket = byDate.get(record.date) || []
      bucket.push(record)
      byDate.set(record.date, bucket)
    }

    let writtenCount = 0
    let insertedCount = 0
    let updatedCount = 0
    let ignoredCount = 0
    let deletionStateChanged = false
    for (const [date, dayRecords] of byDate.entries()) {
      const filePath = this.resolveDayFilePath(date)
      fs.mkdirSync(this.conversationDir, { recursive: true })
      const result = this.withFileLock(filePath, () => {
        const invalidLines = []
        const existingRecords = this.readExistingDayRecords(filePath, warnings, invalidLines)
        const syncResult = this.syncDeletionState(date, existingRecords)
        deletionStateChanged = deletionStateChanged || syncResult.changed
        const activeExistingRecords = existingRecords.filter((record) => !this.isIgnoredSourceKey(record.source.sourceKey))
        const ignoredExistingCount = existingRecords.length - activeExistingRecords.length
        const bySourceKey = new Map(activeExistingRecords.map((record) => [record.source.sourceKey, record]))
        let dayInsertedCount = 0
        let dayUpdatedCount = 0

        for (const record of dayRecords) {
          if (this.isIgnoredSourceKey(record.source.sourceKey)) {
            ignoredCount += 1
            continue
          }
          const existing = bySourceKey.get(record.source.sourceKey)
          const merged = existing ? mergeConversationRecords(existing, record) : record
          if (!existing) {
            dayInsertedCount += 1
          } else if (!recordsEqual(existing, merged)) {
            dayUpdatedCount += 1
          }
          bySourceKey.set(record.source.sourceKey, merged)
        }

        if (invalidLines.length > 0) {
          this.backupInvalidLines(filePath, invalidLines, warnings)
        }

        const sorted = [...bySourceKey.values()].sort(compareConversationRecords)
        const body = sorted.map((record) => JSON.stringify(record)).join("\n")
        if (invalidLines.length > 0 || ignoredExistingCount > 0 || dayInsertedCount > 0 || dayUpdatedCount > 0) {
          writeFileAtomically(filePath, body ? `${body}\n` : "")
        }

        const nextKnownKeys = [...bySourceKey.keys()].sort()
        if (!arraysEqual(this.deletionState.sourceKeysByDate[date], nextKnownKeys)) {
          this.deletionState.sourceKeysByDate[date] = nextKnownKeys
          deletionStateChanged = true
        }

        return {
          insertedCount: dayInsertedCount,
          updatedCount: dayUpdatedCount,
        }
      })
      insertedCount += result.insertedCount
      updatedCount += result.updatedCount
      writtenCount += result.insertedCount + result.updatedCount
    }

    if (deletionStateChanged) {
      this.persistDeletionState()
    }

    return {
      processedCount: normalizedRecords.length,
      writtenCount,
      insertedCount,
      updatedCount,
      ignoredCount,
      warnings,
    }
  }

  hasExistingConversationFiles() {
    if (!fs.existsSync(this.conversationDir)) {
      return false
    }
    try {
      return fs.readdirSync(this.conversationDir, { withFileTypes: true })
        .some((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(entry.name))
    } catch {
      return false
    }
  }

  isIgnoredSourceKey(sourceKey = "") {
    const normalized = normalizeText(sourceKey)
    return Boolean(normalized && this.deletionState?.deletedSourceKeys?.includes(normalized))
  }

  ignoreSourceKeys(sourceKeys = []) {
    this.ensureDeletionState()
    const keys = Array.from(new Set(
      (Array.isArray(sourceKeys) ? sourceKeys : [sourceKeys])
        .map((sourceKey) => normalizeText(sourceKey))
        .filter(Boolean)
    ))
    if (!keys.length) {
      return 0
    }
    const deleted = new Set(this.deletionState.deletedSourceKeys)
    let changed = false
    for (const sourceKey of keys) {
      if (!deleted.has(sourceKey)) {
        deleted.add(sourceKey)
        changed = true
      }
    }
    if (changed) {
      this.deletionState.deletedSourceKeys = [...deleted].sort()
      for (const date of Object.keys(this.deletionState.sourceKeysByDate)) {
        this.deletionState.sourceKeysByDate[date] = this.deletionState.sourceKeysByDate[date]
          .filter((sourceKey) => !deleted.has(sourceKey))
      }
      this.persistDeletionState()
    }
    return keys.length
  }

  ensureDeletionState() {
    if (this.deletionState) {
      return
    }

    let state = null
    if (fs.existsSync(this.deletionStateFile)) {
      try {
        state = normalizeDeletionState(JSON.parse(fs.readFileSync(this.deletionStateFile, "utf8")))
      } catch (error) {
        this.logger?.warn?.(`[conversation] could not load deletion state: ${formatErrorMessage(error)}`)
      }
    }

    if (!state) {
      state = {
        version: 1,
        updatedAt: new Date().toISOString(),
        sourceKeysByDate: this.scanExistingSourceKeys(),
        deletedSourceKeys: [],
      }
      this.deletionState = state
      this.persistDeletionState()
      return
    }

    this.deletionState = state
  }

  syncDeletionState(date, existingRecords) {
    const known = new Set(this.deletionState.sourceKeysByDate[date] || [])
    const current = new Set(existingRecords.map((record) => record.source.sourceKey))
    const deleted = new Set(this.deletionState.deletedSourceKeys)
    let changed = false

    for (const sourceKey of known) {
      if (!current.has(sourceKey) && !deleted.has(sourceKey)) {
        deleted.add(sourceKey)
        changed = true
      }
    }

    for (const sourceKey of current) {
      if (!deleted.has(sourceKey)) {
        known.add(sourceKey)
      }
    }

    const nextKnown = [...known].filter((sourceKey) => !deleted.has(sourceKey)).sort()
    if (!arraysEqual(this.deletionState.sourceKeysByDate[date], nextKnown)) {
      this.deletionState.sourceKeysByDate[date] = nextKnown
      changed = true
    }
    if (!arraysEqual(this.deletionState.deletedSourceKeys, [...deleted].sort())) {
      this.deletionState.deletedSourceKeys = [...deleted].sort()
      changed = true
    }

    return { changed }
  }

  scanExistingSourceKeys() {
    const sourceKeysByDate = {}
    if (!fs.existsSync(this.conversationDir)) {
      return sourceKeysByDate
    }

    let entries = []
    try {
      entries = fs.readdirSync(this.conversationDir, { withFileTypes: true })
    } catch {
      return sourceKeysByDate
    }

    for (const entry of entries) {
      if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(entry.name)) {
        continue
      }
      const date = entry.name.slice(0, -5)
      const filePath = path.join(this.conversationDir, entry.name)
      const records = this.readExistingDayRecords(filePath, [], [])
      sourceKeysByDate[date] = [...new Set(records.map((record) => record.source.sourceKey))].sort()
    }
    return sourceKeysByDate
  }

  persistDeletionState() {
    if (!this.deletionState) {
      return
    }
    this.deletionState.updatedAt = new Date().toISOString()
    fs.mkdirSync(path.dirname(this.deletionStateFile), { recursive: true })
    writeFileAtomically(this.deletionStateFile, JSON.stringify(this.deletionState, null, 2) + "\n")
  }

  resolveDayFilePath(date) {
    const filePath = path.join(this.conversationDir, `${date}.jsonl`)
    const relative = path.relative(this.conversationDir, filePath)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("conversation writer can only write inside conversationDir")
    }
    return filePath
  }

  readExistingDayRecords(filePath, warnings = [], invalidLines = []) {
    if (!fs.existsSync(filePath)) {
      return []
    }
    const raw = fs.readFileSync(filePath, "utf8")
    const records = []
    const lines = raw.split(/\r?\n/u)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim()
      if (!line) {
        continue
      }
      try {
        records.push(normalizeConversationRecord(JSON.parse(line)))
      } catch (error) {
        const message = `Invalid existing conversation line ${index + 1} in ${filePath}: ${error.message}`
        warnings.push(message)
        invalidLines.push({ lineNumber: index + 1, line })
      }
    }
    return records
  }

  backupInvalidLines(filePath, invalidLines, warnings) {
    const backupPath = `${filePath}.invalid.jsonl`
    try {
      const body = invalidLines
        .map((entry) => `# original line ${entry.lineNumber}\n${entry.line}`)
        .join("\n")
      fs.appendFileSync(backupPath, `${body}\n`, "utf8")
      warnings.push(`Preserved invalid existing conversation lines in ${backupPath}`)
    } catch (error) {
      warnings.push(`Could not preserve invalid existing conversation lines in ${backupPath}: ${error.message}`)
    }
  }

  withFileLock(filePath, callback) {
    const lockPath = `${filePath}.lock`
    let handle = null
    for (let attempt = 0; attempt < 2 && !handle; attempt += 1) {
      try {
        handle = fs.openSync(lockPath, "wx")
        fs.writeFileSync(handle, `${process.pid}\n`, "utf8")
      } catch (error) {
        if (handle) {
          fs.closeSync(handle)
          handle = null
        }
        if (error?.code !== "EEXIST" || attempt > 0 || !isStaleLock(lockPath, this.lockTtlMs)) {
          throw new Error(`conversation file is locked: ${lockPath}`)
        }
        fs.rmSync(lockPath, { force: true })
      }
    }

    try {
      return callback()
    } finally {
      if (handle) {
        fs.closeSync(handle)
      }
      fs.rmSync(lockPath, { force: true })
    }
  }
}

function writeFileAtomically(filePath, body) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    fs.writeFileSync(tempPath, body, "utf8")
    try {
      fs.renameSync(tempPath, filePath)
    } catch (error) {
      if (!fs.existsSync(filePath) || !["EEXIST", "EPERM", "ENOTEMPTY"].includes(error?.code)) {
        throw error
      }
      fs.rmSync(filePath, { force: true })
      fs.renameSync(tempPath, filePath)
    }
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true })
    }
  }
}

function isStaleLock(lockPath, ttlMs) {
  try {
    const stat = fs.statSync(lockPath)
    return (Date.now() - stat.mtimeMs) >= ttlMs
  } catch {
    return false
  }
}

function normalizeDeletionState(value) {
  if (!value || typeof value !== "object") {
    return null
  }
  const sourceKeysByDate = {}
  if (value.sourceKeysByDate && typeof value.sourceKeysByDate === "object") {
    for (const [date, sourceKeys] of Object.entries(value.sourceKeysByDate)) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Array.isArray(sourceKeys)) {
        continue
      }
      sourceKeysByDate[date] = [...new Set(sourceKeys.map((sourceKey) => normalizeText(sourceKey)).filter(Boolean))].sort()
    }
  }
  const deletedSourceKeys = Array.isArray(value.deletedSourceKeys)
    ? [...new Set(value.deletedSourceKeys.map((sourceKey) => normalizeText(sourceKey)).filter(Boolean))].sort()
    : []
  return {
    version: 1,
    updatedAt: normalizeText(value.updatedAt) || new Date().toISOString(),
    sourceKeysByDate,
    deletedSourceKeys,
  }
}

function arraysEqual(left, right) {
  const leftValues = Array.isArray(left) ? left : []
  const rightValues = Array.isArray(right) ? right : []
  return leftValues.length === rightValues.length
    && leftValues.every((value, index) => value === rightValues[index])
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "unknown error")
}

function recordsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function mergeConversationRecords(existing, incoming) {
  return normalizeConversationRecord({
    ...existing,
    ...incoming,
    text: choosePreferredString(incoming.text, existing.text),
    meta: mergeMeta(existing.meta, incoming.meta),
    source: {
      ...existing.source,
      ...incoming.source,
    },
  })
}

function mergeMeta(existing = {}, incoming = {}) {
  return {
    ...existing,
    ...incoming,
    quote: incoming.quote ?? existing.quote,
    attachments: mergeMediaArrays(existing.attachments, incoming.attachments),
    files: mergeMediaArrays(existing.files, incoming.files),
    stickers: mergeMediaArrays(existing.stickers, incoming.stickers),
    sourceKey: incoming.sourceKey || existing.sourceKey || "",
  }
}

function mergeMediaArrays(existing = [], incoming = []) {
  const result = []
  const seen = new Set()
  for (const item of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const signature = JSON.stringify(item)
    if (seen.has(signature)) {
      continue
    }
    seen.add(signature)
    result.push(item)
  }
  return result
}

function compareConversationRecords(left, right) {
  const leftTime = Date.parse(left.timestamp)
  const rightTime = Date.parse(right.timestamp)
  if (leftTime !== rightTime) {
    return leftTime - rightTime
  }
  const leftLine = Number(left?.source?.sourceLine || 0)
  const rightLine = Number(right?.source?.sourceLine || 0)
  if (leftLine !== rightLine) {
    return leftLine - rightLine
  }
  const leftOrder = Number(left?.source?.sourceOrder || 0)
  const rightOrder = Number(right?.source?.sourceOrder || 0)
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder
  }
  return String(left.id).localeCompare(String(right.id))
}

function choosePreferredString(primary, fallback) {
  const normalizedPrimary = typeof primary === "string" ? primary.trim() : ""
  return normalizedPrimary || (typeof fallback === "string" ? fallback.trim() : "")
}

module.exports = {
  ConversationWriter,
  compareConversationRecords,
}
