const path = require("path")

const { normalizeDisplayPath } = require("./normalize-display-path")
const { normalizeMediaItem } = require("./normalize-media")
const {
  buildOperationTextFromToolCall,
  extractCanonicalToolCall,
} = require("./normalize-tool-call")
const { truncateText } = require("./normalize-time")

function buildOperationDescriptor({
  runtimeId = "",
  mode = "",
  toolName = "",
  rawToolName = "",
  args = {},
  fallbackText = "",
  outputText = "",
  workspaceRoot = "",
  stateDir = "",
} = {}) {
  const toolCall = extractCanonicalToolCall({
    runtimeId,
    mode,
    payload: {
      name: rawToolName || toolName,
      input: args,
      output: outputText || fallbackText,
    },
  })
  const displayInfo = normalizeDisplayPath({
    path: toolCall.path || toolCall.filePath || toolCall.displayPath,
    workspaceRoot,
    stateDir,
  })
  const normalizedToolCall = {
    ...toolCall,
    displayPath: displayInfo.displayPath || toolCall.displayPath,
    relativePath: displayInfo.relativePath || toolCall.relativePath,
    path: displayInfo.path || toolCall.path,
    filePath: displayInfo.filePath || toolCall.filePath,
  }

  return {
    text: buildOperationTextFromToolCall(normalizedToolCall, { workspaceRoot, stateDir }),
    meta: removeEmptyFields({
      rawToolName: normalizedToolCall.rawToolName,
      toolName: normalizedToolCall.toolName || normalizeText(toolName),
      operationKind: normalizedToolCall.operationKind,
      displayPath: normalizedToolCall.displayPath,
      relativePath: normalizedToolCall.relativePath,
      path: normalizedToolCall.path,
      pattern: normalizedToolCall.pattern,
      command: normalizedToolCall.command,
    }),
  }
}

function buildToolResultMeta(outputText = "") {
  const normalized = String(outputText || "").replace(/\r\n/g, "\n").trim()
  if (!normalized) {
    return {}
  }
  return removeEmptyFields({
    resultSummary: extractResultSummary(normalized),
    toolResultPreview: truncateText(normalized, 280),
  })
}

function buildVisibleAssistantRecordFromToolCall({ toolName = "", args = {}, outputText = "", workspaceRoot = "", stateDir = "" } = {}) {
  const descriptor = extractCanonicalToolCall({
    payload: {
      name: toolName,
      input: args,
      output: outputText,
    },
  })
  const displayInfo = normalizeDisplayPath({
    path: descriptor.primaryFilePath || descriptor.filePath || descriptor.path,
    workspaceRoot,
    stateDir,
  })
  const filePath = displayInfo.filePath || descriptor.primaryFilePath

  if (descriptor.operationKind === "send_file" && filePath) {
    const fileName = path.basename(filePath)
    const mediaKind = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/iu.test(filePath) ? "image" : "file"
    const fileItem = normalizeMediaItem({
      kind: mediaKind,
      fileName,
      path: filePath,
      filePath,
      relativePath: displayInfo.relativePath,
      isImage: mediaKind === "image",
    })
    return {
      type: "assistant",
      variant: "visible",
      text: `Sent file ${fileName}`,
      meta: {
        attachments: mediaKind === "image" ? [fileItem] : [],
        files: mediaKind === "file" ? [fileItem] : [],
        stickers: [],
      },
    }
  }

  if (descriptor.operationKind === "send_sticker" && descriptor.stickerId) {
    const stickerFilePath = filePath || `${descriptor.stickerId}.gif`
    const stickerDisplay = normalizeDisplayPath({
      path: stickerFilePath,
      workspaceRoot,
      stateDir,
    })
    const stickerItem = normalizeMediaItem({
      kind: "sticker",
      stickerId: descriptor.stickerId,
      fileName: path.basename(stickerDisplay.filePath || stickerFilePath),
      path: stickerDisplay.filePath || stickerFilePath,
      filePath: stickerDisplay.filePath || stickerFilePath,
      relativePath: stickerDisplay.relativePath,
      isImage: true,
    })
    return {
      type: "assistant",
      variant: "visible",
      text: `Sent sticker ${descriptor.stickerId}`,
      meta: {
        attachments: [stickerItem],
        stickers: [stickerItem],
        files: [],
      },
    }
  }

  return null
}

function buildVisibleAssistantRecordFromResult({ toolName = "", args = {}, outputText = "", workspaceRoot = "", stateDir = "" } = {}) {
  return buildVisibleAssistantRecordFromToolCall({
    toolName,
    args,
    outputText,
    workspaceRoot,
    stateDir,
  })
}

function inferOperationKind({ toolName = "", shortToolName = "", command = "", displayPath = "" } = {}) {
  return extractCanonicalToolCall({
    payload: {
      name: toolName || shortToolName,
      input: {
        command,
        path: displayPath,
      },
    },
  }).operationKind
}

function parseStructuredToolResult(outputText = "") {
  const normalized = String(outputText || "").trim()
  if (!normalized) {
    return null
  }
  const candidates = [normalized]
  const firstJson = normalized.search(/[\[{]/u)
  if (firstJson > 0) {
    candidates.push(normalized.slice(firstJson))
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // continue
    }
  }
  return null
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

  const first = lines.find((line) => !/^[\[{]/u.test(line)) || lines[0] || String(text || "")
  return truncateText(first, 160)
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
  buildVisibleAssistantRecordFromToolCall,
  buildVisibleAssistantRecordFromResult,
  inferOperationKind,
  parseStructuredToolResult,
}
