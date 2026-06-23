const fs = require("fs")
const path = require("path")

const { normalizeConversationRecord } = require("./normalize-record")

class ConversationWriter {
  constructor({ conversationDir = "" } = {}) {
    this.conversationDir = path.resolve(String(conversationDir || ""))
  }

  writeRecords(records = []) {
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
    for (const [date, dayRecords] of byDate.entries()) {
      const filePath = this.resolveDayFilePath(date)
      const existingRecords = this.readExistingDayRecords(filePath, warnings)
      const bySourceKey = new Map(existingRecords.map((record) => [record.source.sourceKey, record]))
      for (const record of dayRecords) {
        const existing = bySourceKey.get(record.source.sourceKey)
        bySourceKey.set(record.source.sourceKey, existing ? mergeConversationRecords(existing, record) : record)
      }
      const sorted = [...bySourceKey.values()].sort(compareConversationRecords)
      const body = sorted.map((record) => JSON.stringify(record)).join("\n")
      fs.mkdirSync(this.conversationDir, { recursive: true })
      fs.writeFileSync(filePath, body ? `${body}\n` : "", "utf8")
      writtenCount += dayRecords.length
    }

    return {
      writtenCount,
      warnings,
    }
  }

  resolveDayFilePath(date) {
    const filePath = path.join(this.conversationDir, `${date}.jsonl`)
    const relative = path.relative(this.conversationDir, filePath)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("conversation writer can only write inside conversationDir")
    }
    return filePath
  }

  readExistingDayRecords(filePath, warnings = []) {
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
        warnings.push(`Invalid existing conversation line ${index + 1} in ${filePath}: ${error.message}`)
      }
    }
    return records
  }
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
