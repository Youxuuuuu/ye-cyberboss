const fs = require("fs")
const path = require("path")

const { normalizeConversationRecord } = require("./normalize-record")

const DAY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/u

function planLegacyWebChatRecords(records = [], { maxGapMs = 90_000 } = {}) {
  const input = Array.isArray(records) ? records.filter(Boolean) : []
  const indexed = input.map((record, index) => ({ record, index }))
  const groups = new Map()

  for (const entry of indexed) {
    if (!isLegacyWebUser(entry.record)) continue
    const key = buildLegacyGroupKey(entry.record)
    if (!key) continue
    const group = groups.get(key) || []
    group.push(entry)
    groups.set(key, group)
  }

  const replacements = new Map()
  const removedIndices = new Set()
  const changes = []

  for (const group of groups.values()) {
    const segments = group
      .filter((entry) => !removedIndices.has(entry.index))
      .sort((left, right) => left.index - right.index)
    if (!segments.length) continue

    const mergedText = segments
      .map((entry) => normalizeComparableText(entry.record.text))
      .filter(Boolean)
      .join("\n\n")
    if (!mergedText) continue

    const rawCandidates = indexed.filter((entry) => (
      !removedIndices.has(entry.index)
      && isLegacyRuntimeUser(entry.record)
      && sameConversationScope(segments[0].record, entry.record)
      && normalizeComparableText(entry.record.text) === mergedText
      && timestampsWithinGap(segments, entry.record, maxGapMs)
    ))
    if (rawCandidates.length !== 1) continue

    const raw = rawCandidates[0]
    const canonical = buildCanonicalWebUser(segments, raw.record, mergedText)
    const retainedIndex = segments[0].index
    replacements.set(retainedIndex, canonical)
    for (const entry of segments.slice(1)) removedIndices.add(entry.index)
    removedIndices.add(raw.index)
    changes.push({
      logicalMessageId: canonical.messageId,
      retainedSourceKey: canonical.sourceKey,
      removedSourceKeys: [
        ...segments.slice(1).map((entry) => getSourceKey(entry.record)),
        getSourceKey(raw.record),
      ].filter(Boolean),
      segmentCount: segments.length,
      canonicalTurnId: canonical.turnId,
    })
  }

  const migratedRecords = []
  for (let index = 0; index < input.length; index += 1) {
    if (removedIndices.has(index)) continue
    migratedRecords.push(replacements.get(index) || input[index])
  }

  return {
    records: migratedRecords,
    changes,
    logicalMessageCount: changes.length,
    removedRecordCount: removedIndices.size,
  }
}

function migrateLegacyWebChatConversationDirectory({
  conversationDir = "",
  write = false,
  maxGapMs = 90_000,
  now = new Date(),
} = {}) {
  const root = path.resolve(requiredText(conversationDir, "conversationDir"))
  const fileNames = fs.existsSync(root)
    ? fs.readdirSync(root).filter((name) => DAY_FILE_PATTERN.test(name)).sort()
    : []
  const filePlans = []
  const warnings = []

  for (const fileName of fileNames) {
    const filePath = resolveInside(root, fileName)
    const raw = fs.readFileSync(filePath, "utf8")
    let records
    try {
      records = parseJsonl(raw, filePath)
    } catch (error) {
      warnings.push(formatError(error))
      continue
    }
    const plan = planLegacyWebChatRecords(records, { maxGapMs })
    if (!plan.logicalMessageCount) continue
    filePlans.push({ fileName, filePath, raw, ...plan })
  }

  let backupDir = ""
  if (write && filePlans.length) {
    backupDir = resolveInside(
      root,
      path.join(".legacy-webchat-backups", formatBackupStamp(now)),
    )
    fs.mkdirSync(backupDir, { recursive: true })
    for (const plan of filePlans) {
      withConversationFileLock(plan.filePath, () => {
        const currentRaw = fs.readFileSync(plan.filePath, "utf8")
        if (currentRaw !== plan.raw) {
          throw new Error(`conversation file changed after planning: ${plan.filePath}`)
        }
        const backupPath = resolveInside(backupDir, plan.fileName)
        fs.copyFileSync(plan.filePath, backupPath, fs.constants.COPYFILE_EXCL)
        writeFileAtomically(plan.filePath, serializeJsonl(plan.records))
      })
    }
  }

  return {
    mode: write ? "write" : "dry-run",
    conversationDir: root,
    scannedFileCount: fileNames.length,
    changedFileCount: filePlans.length,
    logicalMessageCount: filePlans.reduce(
      (total, plan) => total + plan.logicalMessageCount,
      0,
    ),
    removedRecordCount: filePlans.reduce(
      (total, plan) => total + plan.removedRecordCount,
      0,
    ),
    files: filePlans.map((plan) => ({
      fileName: plan.fileName,
      logicalMessageCount: plan.logicalMessageCount,
      removedRecordCount: plan.removedRecordCount,
      changes: plan.changes,
    })),
    backupDir,
    warnings,
  }
}

function buildCanonicalWebUser(segments, rawRecord, mergedText) {
  const first = segments[0].record
  const messageId = getMessageId(first)
  const transportTurnId = normalizeText(first?.meta?.transportTurnId) || normalizeText(first.turnId)
  const canonicalTurnId = normalizeText(rawRecord?.meta?.canonicalTurnId) || normalizeText(rawRecord.turnId)
  const displayTurnId = normalizeText(first?.meta?.displayTurnId)
    || normalizeText(first?.meta?.logicalTurnId)
    || transportTurnId
    || canonicalTurnId
  const bubbleSegments = segments.map(({ record }) => {
    const attachments = [
      ...(Array.isArray(record?.meta?.attachments) ? record.meta.attachments : []),
      ...(Array.isArray(record?.meta?.files) ? record.meta.files : []),
      ...(Array.isArray(record?.meta?.stickers) ? record.meta.stickers : []),
    ]
    return {
      segmentId: getMessageId(record),
      text: normalizeText(record.text),
      ...(record?.meta?.quote ? { quote: record.meta.quote } : {}),
      ...(attachments.length ? { attachments } : {}),
    }
  })

  return normalizeConversationRecord({
    ...first,
    turnId: canonicalTurnId || normalizeText(first.turnId),
    text: mergedText,
    messageId,
    meta: {
      ...(first.meta || {}),
      messageId,
      bubbleSegments,
      attachments: mergeRecordMedia(segments, "attachments"),
      files: mergeRecordMedia(segments, "files"),
      stickers: mergeRecordMedia(segments, "stickers"),
      ...(transportTurnId ? { transportTurnId } : {}),
      ...(canonicalTurnId ? { canonicalTurnId } : {}),
      ...(displayTurnId ? { displayTurnId } : {}),
    },
    source: {
      ...(first.source || {}),
      provider: "web",
      sourceType: "web.message.user",
      rawId: messageId,
      sourceKey: getSourceKey(first),
    },
  })
}

function mergeRecordMedia(segments, key) {
  const result = []
  const seen = new Set()
  for (const { record } of segments) {
    const items = Array.isArray(record?.meta?.[key]) ? record.meta[key] : []
    for (const item of items) {
      const identity = getMediaIdentity(item)
      if (identity && seen.has(identity)) continue
      if (identity) seen.add(identity)
      result.push(item)
    }
  }
  return result
}

function getMediaIdentity(item = {}) {
  return [
    item.mediaKey,
    item.relativePath,
    item.path,
    item.url,
    item.fileName,
    item.stickerId,
  ].map((value) => normalizeText(value)).find(Boolean) || ""
}

function isLegacyWebUser(record) {
  return record?.type === "user"
    && normalizeText(record?.source?.provider) === "web"
    && Boolean(getMessageId(record))
    && normalizeText(record.turnId)
    && !Array.isArray(record?.meta?.bubbleSegments)
}

function isLegacyRuntimeUser(record) {
  return record?.type === "user"
    && normalizeText(record?.source?.provider) !== "web"
    && !getMessageId(record)
}

function buildLegacyGroupKey(record) {
  const parts = [
    normalizeText(record.threadId),
    normalizeText(record.turnId),
    normalizeText(record.runtimeId),
    normalizeScopePath(record.workspaceRoot),
  ]
  return parts[0] && parts[1] ? parts.join("\u0000") : ""
}

function sameConversationScope(left, right) {
  return normalizeText(left.threadId) === normalizeText(right.threadId)
    && normalizeText(left.runtimeId) === normalizeText(right.runtimeId)
    && normalizeScopePath(left.workspaceRoot) === normalizeScopePath(right.workspaceRoot)
}

function timestampsWithinGap(segments, rawRecord, maxGapMs) {
  const rawTime = Date.parse(rawRecord?.timestamp || "")
  if (!Number.isFinite(rawTime)) return false
  const segmentTimes = segments
    .map((entry) => Date.parse(entry.record?.timestamp || ""))
    .filter(Number.isFinite)
  if (!segmentTimes.length) return false
  const nearestGap = Math.min(...segmentTimes.map((time) => Math.abs(rawTime - time)))
  return nearestGap <= Math.max(0, Number(maxGapMs) || 0)
}

function getMessageId(record) {
  return normalizeText(record?.messageId || record?.meta?.messageId)
}

function getSourceKey(record) {
  return normalizeText(record?.sourceKey || record?.source?.sourceKey || record?.meta?.sourceKey)
}

function normalizeComparableText(value) {
  return normalizeText(value).replace(/\r\n/gu, "\n")
}

function normalizeScopePath(value) {
  return normalizeText(value).replace(/\\/gu, "/").toLowerCase()
}

function parseJsonl(raw, filePath) {
  const records = []
  const lines = String(raw || "").split(/\r?\n/gu)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      records.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`invalid JSONL line ${index + 1} in ${filePath}: ${formatError(error)}`)
    }
  }
  return records
}

function serializeJsonl(records) {
  const body = records.map((record) => JSON.stringify(record)).join("\n")
  return body ? `${body}\n` : ""
}

function withConversationFileLock(filePath, callback) {
  const lockPath = `${filePath}.lock`
  let handle
  try {
    handle = fs.openSync(lockPath, "wx")
    fs.writeFileSync(handle, `${process.pid}\n`, "utf8")
    return callback()
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`conversation file is locked: ${lockPath}`)
    }
    throw error
  } finally {
    if (handle) fs.closeSync(handle)
    if (handle && fs.existsSync(lockPath)) fs.rmSync(lockPath, { force: true })
  }
}

function writeFileAtomically(filePath, body) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.migration.tmp`
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
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
  }
}

function resolveInside(root, relativePath) {
  const target = path.resolve(root, relativePath)
  const relative = path.relative(root, target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`conversation migration path escaped its root: ${target}`)
  }
  return target
}

function formatBackupStamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error("conversation migration requires a valid backup timestamp")
  return date.toISOString().replace(/[:.]/gu, "-")
}

function requiredText(value, label) {
  const normalized = normalizeText(value)
  if (!normalized) throw new Error(`conversation migration requires ${label}`)
  return normalized
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error")
}

module.exports = {
  migrateLegacyWebChatConversationDirectory,
  planLegacyWebChatRecords,
}
