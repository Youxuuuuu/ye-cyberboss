const SHANGHAI_OFFSET_HOURS = 8
const BRACKET_TIMESTAMP_RE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\]\s*\r?\n*/u

function normalizeTimestamp(value, fallback = new Date().toISOString()) {
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value.trim())
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString()
    }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString()
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString()
    }
  }
  return normalizeTimestamp(fallback, new Date().toISOString())
}

function toShanghaiDate(timestamp) {
  const normalized = normalizeTimestamp(timestamp)
  const date = new Date(normalized)
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_HOURS * 60 * 60 * 1000)
  return shifted.toISOString().slice(0, 10)
}

function stripBracketTimestampPrefix(text) {
  const normalized = String(text || "")
  const match = normalized.match(BRACKET_TIMESTAMP_RE)
  if (!match) {
    return {
      text: normalized.trim(),
      timestamp: "",
    }
  }

  const [, year, month, day, hour, minute] = match
  const utcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour) - SHANGHAI_OFFSET_HOURS,
    Number(minute),
    0,
    0
  )
  return {
    text: normalized.slice(match[0].length).trim(),
    timestamp: new Date(utcMs).toISOString(),
  }
}

function truncateText(value, maxLength = 280) {
  const normalized = String(value || "").replace(/\r\n/g, "\n").trim()
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

module.exports = {
  normalizeTimestamp,
  stripBracketTimestampPrefix,
  toShanghaiDate,
  truncateText,
}
