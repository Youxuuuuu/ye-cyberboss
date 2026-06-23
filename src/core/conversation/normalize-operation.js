const path = require("path")

const { normalizeMediaItem } = require("./normalize-media")
const { truncateText } = require("./normalize-time")

function buildOperationDescriptor({ toolName = "", args = {}, fallbackText = "" } = {}) {
  const normalizedToolName = normalizeText(toolName)
  const shortToolName = normalizeToolLabel(normalizedToolName)
  const patchPath = extractPatchPath(args.input || args.patch || "")
  const displayPath = normalizeText(
    args.displayPath
    || args.display_path
    || args.filePath
    || args.file_path
    || args.path
    || patchPath
    || extractCommandPath(args.command || "")
  )
  const pattern = normalizeText(args.pattern || args.query || args.q)
  const command = normalizeText(args.command)
  const operationKind = inferOperationKind({
    toolName: normalizedToolName,
    shortToolName,
    command,
    displayPath,
  })
  const text = buildOperationText({
    operationKind,
    shortToolName,
    displayPath,
    pattern,
    command,
    fallbackText,
  })

  return {
    text,
    meta: removeEmptyFields({
      toolName: normalizedToolName || shortToolName,
      operationKind,
      displayPath,
      relativePath: toRelativeLikePath(displayPath),
      path: displayPath,
      pattern,
      command,
    }),
  }
}

function buildToolResultMeta(outputText = "") {
  const normalized = String(outputText || "").replace(/\r\n/g, "\n").trim()
  if (!normalized) {
    return {}
  }
  const summary = extractResultSummary(normalized)
  return removeEmptyFields({
    resultSummary: summary,
    toolResultPreview: truncateText(normalized, 280),
  })
}

function buildVisibleAssistantRecordFromResult({ toolName = "", outputText = "" } = {}) {
  const kind = inferOperationKind({
    toolName,
    shortToolName: normalizeToolLabel(toolName),
    command: "",
    displayPath: "",
  })
  const parsed = parseStructuredToolResult(outputText)
  const fallbackText = extractResultSummary(outputText)

  if (kind === "send_file") {
    const filePath = normalizeText(parsed?.filePath || parsed?.path || extractPathFromResultText(outputText))
    if (!filePath) {
      return null
    }
    const fileItem = normalizeMediaItem({
      kind: "file",
      path: filePath,
      filePath,
    })
    return {
      type: "assistant",
      text: `Sent file ${path.basename(filePath)}`,
      meta: {
        files: [fileItem],
        attachments: [fileItem],
      },
    }
  }

  if (kind === "send_sticker") {
    const stickerId = normalizeText(parsed?.stickerId || extractStickerIdFromResultText(outputText))
    if (!stickerId) {
      return null
    }
    const filePath = normalizeText(parsed?.filePath || parsed?.path)
    const stickerItem = normalizeMediaItem({
      kind: "sticker",
      stickerId,
      path: filePath,
      filePath,
    })
    return {
      type: "assistant",
      text: fallbackText || `Sent sticker ${stickerId}`,
      meta: {
        attachments: [stickerItem],
        stickers: [stickerItem],
      },
    }
  }

  return null
}

function inferOperationKind({ toolName = "", shortToolName = "", command = "", displayPath = "" } = {}) {
  const tool = `${normalizeText(toolName)} ${normalizeText(shortToolName)}`.toLowerCase()
  if (tool.includes("cyberboss_channel_send_file")) {
    return "send_file"
  }
  if (tool.includes("cyberboss_sticker_send")) {
    return "send_sticker"
  }
  if (tool.includes("apply_patch") || tool.includes("edit") || tool.includes("patch")) {
    return "edit"
  }
  if (tool.includes("write")) {
    return "write"
  }
  if (tool.includes("read")) {
    return "read"
  }
  if (tool.includes("search") || tool.includes("find") || tool.includes("grep") || tool.includes("rg")) {
    return "search"
  }
  if (normalizeText(command)) {
    return "shell"
  }
  if (normalizeText(toolName).startsWith("mcp__")) {
    return "mcp"
  }
  if (tool.includes("web")) {
    return "web"
  }
  if (displayPath) {
    return "other"
  }
  return "other"
}

function buildOperationText({ operationKind, shortToolName, displayPath, pattern, command, fallbackText }) {
  if (operationKind === "read") {
    return `Read ${displayPath || pattern || shortToolName}`.trim()
  }
  if (operationKind === "write") {
    return `Write ${displayPath || shortToolName}`.trim()
  }
  if (operationKind === "edit") {
    return `Edit ${displayPath || shortToolName}`.trim()
  }
  if (operationKind === "search") {
    return `Search ${pattern || displayPath || truncateText(command, 120) || shortToolName}`.trim()
  }
  if (operationKind === "shell") {
    return `Run ${truncateText(command || fallbackText || shortToolName, 120)}`.trim()
  }
  if (operationKind === "send_file") {
    return `Send file ${displayPath ? path.basename(displayPath) : shortToolName}`.trim()
  }
  if (operationKind === "send_sticker") {
    return `Send sticker ${shortToolName}`.trim()
  }
  if (operationKind === "mcp") {
    return shortToolName || displayPath || truncateText(fallbackText, 120)
  }
  return `Use ${displayPath || truncateText(fallbackText || shortToolName, 120)}`.trim()
}

function parseStructuredToolResult(outputText = "") {
  const normalized = String(outputText || "")
  const jsonStart = normalized.indexOf("\n{")
  if (jsonStart < 0) {
    return null
  }
  try {
    return JSON.parse(normalized.slice(jsonStart + 1).trim())
  } catch {
    return null
  }
}

function extractPatchPath(patchText = "") {
  const normalized = String(patchText || "")
  const match = normalized.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/u)
  if (match?.[1]) {
    return match[1].trim()
  }
  return ""
}

function extractCommandPath(command = "") {
  const normalized = normalizeText(command)
  if (!normalized) {
    return ""
  }
  const match = normalized.match(/(?:Get-Content|type|cat|rg(?:\.exe)?\s+--files|rg(?:\.exe)?\s+-n)\s+("?[^"\n]+"?)/iu)
  if (match?.[1]) {
    return stripQuotes(match[1])
  }
  return ""
}

function extractPathFromResultText(outputText = "") {
  const match = String(outputText || "").match(/File sent:\s+([^\n]+)/u)
  return match?.[1] ? match[1].trim() : ""
}

function extractStickerIdFromResultText(outputText = "") {
  const match = String(outputText || "").match(/Sticker sent:\s+([^\n]+)/u)
  return match?.[1] ? match[1].trim() : ""
}

function extractResultSummary(text = "") {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Exit code:/iu.test(line))
    .filter((line) => !/^Wall time:/iu.test(line))
    .filter((line) => !/^Output:$/iu.test(line))

  return truncateText(lines[0] || String(text || ""), 160)
}

function normalizeToolLabel(toolName = "") {
  const normalized = normalizeText(toolName)
  if (!normalized.startsWith("mcp__")) {
    return normalized
  }
  const parts = normalized.split("__").filter(Boolean)
  return parts[parts.length - 1] || normalized
}

function toRelativeLikePath(value = "") {
  const normalized = normalizeText(value)
  if (!normalized) {
    return ""
  }
  return normalized.replace(/^[A-Za-z]:[\\/]/u, "").replace(/\\/g, "/")
}

function stripQuotes(value = "") {
  return String(value || "").replace(/^"+|"+$/g, "")
}

function removeEmptyFields(value) {
  const output = {}
  for (const [key, entry] of Object.entries(value || {})) {
    if (entry === "" || entry == null) {
      continue
    }
    output[key] = entry
  }
  return output
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  buildOperationDescriptor,
  buildToolResultMeta,
  buildVisibleAssistantRecordFromResult,
  inferOperationKind,
  parseStructuredToolResult,
}
