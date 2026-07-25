const path = require("path")

const { normalizeDisplayPath, normalizeSlashPath } = require("./normalize-display-path")

function extractCanonicalToolCall({
  runtimeId = "",
  mode = "",
  raw = null,
  item = null,
  payload = null,
  mappedEvent = null,
} = {}) {
  const subject = firstObject(item, payload, raw, mappedEvent)
  const rawToolName = normalizeText(
    subject?.name
    || subject?.toolName
    || subject?.tool_name
    || subject?.type
  )
  const toolName = normalizeToolName(rawToolName)
  const args = parseStructuredValue(subject?.arguments ?? subject?.input ?? subject?.payload ?? {})
  const outputText = extractTextPayload(subject?.output ?? subject?.result ?? subject?.content ?? "")
  const command = normalizeText(args.command || subject?.command)
  const patchText = normalizeText(args.input || args.patch || subject?.input || subject?.output)
  const shellCommandInfo = extractShellCommandInfo(command)
  const displayInfo = normalizeDisplayPath({
    path: firstText(
      args.displayPath,
      args.display_path,
      args.filePath,
      args.file_path,
      args.path,
      extractPatchPath(patchText),
      shellCommandInfo.path,
      extractCommandTailPath(command)
    ),
    workspaceRoot: subject?.workspaceRoot || mappedEvent?.payload?.workspaceRoot || raw?.cwd || "",
    stateDir: subject?.stateDir || "",
  })
  const pattern = normalizeText(args.pattern || args.query || args.q || args.search || shellCommandInfo.pattern)
  const operationKind = inferOperationKind({
    rawToolName,
    toolName,
    command,
    patchText,
  })

  return {
    runtimeId: normalizeText(runtimeId),
    mode: normalizeText(mode),
    rawToolName,
    toolName,
    callId: normalizeText(subject?.call_id || subject?.callId || subject?.id || subject?.tool_use_id || subject?.toolUseId),
    args,
    outputText,
    command,
    pattern,
    operationKind,
    displayPath: displayInfo.displayPath,
    relativePath: displayInfo.relativePath,
    path: displayInfo.path,
    filePath: displayInfo.filePath,
    shellCommandKind: shellCommandInfo.kind,
    reminderText: extractReminderText(args, outputText),
    stickerId: extractStickerId(args, outputText),
    primaryFilePath: extractFilePath(args, outputText),
  }
}

function normalizeToolName(rawToolName = "") {
  const normalized = normalizeText(rawToolName)
  if (!normalized.startsWith("mcp__")) {
    return normalized
  }
  const parts = normalized.split("__").filter(Boolean)
  return parts[parts.length - 1] || normalized
}

function buildOperationTextFromToolCall(toolCall = {}, { workspaceRoot = "", stateDir = "" } = {}) {
  const displayInfo = normalizeDisplayPath({
    path: toolCall.path || toolCall.filePath || toolCall.displayPath,
    workspaceRoot,
    stateDir,
  })
  const displayPath = displayInfo.displayPath || toolCall.displayPath
  const pattern = normalizeText(toolCall.pattern)
  const command = normalizeText(toolCall.command)
  const toolName = normalizeText(toolCall.toolName)
  const operationKind = normalizeText(toolCall.operationKind)

  if (operationKind === "read") {
    return `Read ${displayPath || toolName}`.trim()
  }
  if (operationKind === "write") {
    return `Write ${displayPath || toolName}`.trim()
  }
  if (operationKind === "edit") {
    return `Edit ${displayPath || toolName}`.trim()
  }
  if (operationKind === "grep") {
    const target = [pattern, displayPath].filter(Boolean).join(" ")
    return `Grep ${target || toolName}`.trim()
  }
  if (operationKind === "glob") {
    return `Glob ${displayPath || toolName}`.trim()
  }
  if (operationKind === "shell") {
    return `Bash ${truncateText(command || toolName, 180)}`.trim()
  }
  if (operationKind === "send_file") {
    return `[${toolName}] ${path.basename(toolCall.primaryFilePath || displayPath || toolName)}`.trim()
  }
  if (operationKind === "send_sticker") {
    return `[${toolName}] ${toolCall.stickerId || toolName}`.trim()
  }
  if (operationKind === "reminder") {
    return `[${toolName}] ${toolCall.reminderText || toolName}`.trim()
  }
  if (operationKind === "mcp") {
    const primary = toolCall.reminderText
      || path.basename(toolCall.primaryFilePath || "")
      || toolCall.stickerId
      || displayPath
      || pattern
    return `[${toolName}] ${primary}`.trim()
  }
  if (operationKind === "web") {
    return `Use ${toolName || displayPath}`.trim()
  }
  if (toolName) {
    return `[${toolName}]`.trim()
  }
  return `Use ${displayPath || toolName || "tool"}`.trim()
}

function inferOperationKind({ rawToolName = "", toolName = "", command = "", patchText = "" } = {}) {
  const combined = `${normalizeText(rawToolName)} ${normalizeText(toolName)}`.toLowerCase()
  const shellKind = inferShellCommandKind(command, patchText)
  if (combined.includes("cyberboss_channel_send_file")) {
    return "send_file"
  }
  if (combined.includes("cyberboss_sticker_send")) {
    return "send_sticker"
  }
  if (combined.includes("cyberboss_reminder_create")) {
    return "reminder"
  }
  if (combined.includes("apply_patch") || combined.includes("patch_apply_end") || extractPatchPath(patchText)) {
    return "edit"
  }
  if (/^(?:read|get-content|cat|type)$/iu.test(toolName)) {
    return "read"
  }
  if (/^(?:write|set-content|out-file|add-content)$/iu.test(toolName)) {
    return "write"
  }
  if (/^(?:edit|multiedit)$/iu.test(toolName)) {
    return "edit"
  }
  if (/^(?:grep)$/iu.test(toolName)) {
    return "grep"
  }
  if (/^(?:glob)$/iu.test(toolName)) {
    return "glob"
  }
  if (combined.includes("shell_command") || combined === "bash") {
    return shellKind
  }
  if (combined.includes("grep")) {
    return "grep"
  }
  if (normalizeText(rawToolName).startsWith("mcp__") || /^cyberboss_/iu.test(toolName)) {
    return "mcp"
  }
  if (command) {
    return shellKind
  }
  if (combined.includes("web")) {
    return "web"
  }
  return "other"
}

function inferShellCommandKind(command = "", patchText = "") {
  const normalized = normalizeText(command).toLowerCase()
  if (!normalized && patchText) {
    return "edit"
  }
  if (!normalized) {
    return "shell"
  }
  if (normalized.includes("apply_patch") || normalized.includes("patch_apply")) {
    return "edit"
  }
  if (/\b(?:rg|grep|select-string)\b/u.test(normalized)) {
    return "grep"
  }
  if (/\b(?:get-childitem|ls|dir|glob)\b/u.test(normalized)) {
    return "glob"
  }
  if (/\b(?:get-content|cat|type)\b/u.test(normalized)) {
    return "read"
  }
  if (/\b(?:set-content|out-file|add-content)\b/u.test(normalized)) {
    return "write"
  }
  return "shell"
}

function parseStructuredValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => parseStructuredValue(entry))
  }
  if (value && typeof value === "object") {
    return value
  }
  if (typeof value !== "string") {
    return {}
  }
  const normalized = value.trim()
  if (!normalized) {
    return {}
  }
  for (const candidate of extractJsonCandidates(normalized)) {
    try {
      return JSON.parse(candidate)
    } catch {
      // continue
    }
  }
  return {
    text: normalized,
  }
}

function extractTextPayload(value) {
  if (typeof value === "string") {
    return value.trim()
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => extractTextPayload(entry))
      .filter(Boolean)
      .join("\n")
      .trim()
  }
  if (value && typeof value === "object") {
    const preferred = [
      value.text,
      value.content,
      value.message,
      value.output,
      value.result,
      value.body,
      value.title,
    ]
      .map((entry) => extractTextPayload(entry))
      .filter(Boolean)
    if (preferred.length) {
      return preferred.join("\n").trim()
    }
    return Object.values(value)
      .map((entry) => extractTextPayload(entry))
      .filter(Boolean)
      .join("\n")
      .trim()
  }
  return ""
}

function extractReminderText(...values) {
  for (const value of values) {
    const found = extractNamedValue(value, ["message", "text", "content", "reminderText", "title", "body"])
    if (found) {
      return found
    }
  }
  return ""
}

function extractFilePath(...values) {
  for (const value of values) {
    const found = extractNamedValue(value, ["filePath", "path", "savedPath", "absolutePath", "createdPath"])
    if (found) {
      return normalizeSlashPath(found)
    }
    const text = extractTextPayload(value)
    const fromText = extractFilePathFromText(text)
    if (fromText) {
      return fromText
    }
  }
  return ""
}

function extractStickerId(...values) {
  for (const value of values) {
    const found = extractNamedValue(value, ["stickerId", "sticker_id", "id"])
    if (found) {
      return found
    }
    const text = extractTextPayload(value)
    const match = text.match(/Sticker sent:\s*([^\n]+)/iu)
    if (match?.[1]) {
      return match[1].trim()
    }
  }
  return ""
}

function extractNamedValue(value, preferredKeys = []) {
  if (typeof value === "string") {
    for (const candidate of extractJsonCandidates(value.trim())) {
      try {
        const parsed = JSON.parse(candidate)
        const found = extractNamedValue(parsed, preferredKeys)
        if (found) {
          return found
        }
      } catch {
        // continue
      }
    }
    return ""
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = extractNamedValue(entry, preferredKeys)
      if (found) {
        return found
      }
    }
    return ""
  }
  if (!value || typeof value !== "object") {
    return ""
  }
  for (const key of preferredKeys) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key].trim()
    }
  }
  for (const key of preferredKeys) {
    const nested = extractNamedValue(value[key], preferredKeys)
    if (nested) {
      return nested
    }
  }
  const fragments = [
    value.text,
    value.content,
    value.message,
    value.output,
    value.result,
  ]
  for (const fragment of fragments) {
    const found = extractNamedValue(fragment, preferredKeys)
    if (found) {
      return found
    }
  }
  return ""
}

function extractJsonCandidates(text = "") {
  const normalized = String(text || "").trim()
  if (!normalized) {
    return []
  }
  const candidates = [normalized]
  const firstBrace = normalized.search(/[\[{]/u)
  if (firstBrace > 0) {
    candidates.push(normalized.slice(firstBrace))
  }
  const lineCandidates = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[\[{]/u.test(line))
  candidates.push(...lineCandidates)
  return Array.from(new Set(candidates.filter(Boolean)))
}

function extractPatchPath(patchText = "") {
  const normalized = String(patchText || "")
  const match = normalized.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/u)
  return match?.[1] ? normalizeSlashPath(match[1].trim()) : ""
}

function extractShellCommandInfo(command = "") {
  const normalized = normalizeText(command)
  return {
    kind: inferShellCommandKind(normalized),
    path: extractCommandTailPath(normalized),
    pattern: extractCommandPattern(normalized),
  }
}

function extractCommandTailPath(command = "") {
  const normalized = normalizeText(command)
  if (!normalized) {
    return ""
  }
  const tokens = [
    ...extractQuotedTokens(normalized),
    ...(normalized.match(/[A-Za-z]:[\\/][^\s"'|;]+/gu) || []),
    ...(normalized.match(/(?:diary|inbox|src|stickers)[\\/][^\s"'|;]+/gu) || []),
  ]
    .map((entry) => normalizeSlashPath(entry))
    .filter(Boolean)
    .filter((entry) => !/\b(?:pwsh\.exe|powershell\.exe|cmd\.exe|node\.exe|npm\.cmd)\b/iu.test(entry))

  return tokens.length ? tokens[tokens.length - 1] : ""
}

function extractCommandPattern(command = "") {
  const normalized = normalizeText(command)
  if (!normalized) {
    return ""
  }

  const selectStringMatch = normalized.match(/-Pattern\s+(['"])(.*?)\1/iu)
  if (selectStringMatch?.[2]) {
    return normalizeText(selectStringMatch[2])
  }

  const quoted = extractQuotedTokens(normalized).filter((token) => !looksLikePathToken(token))
  return quoted[0] ? normalizeText(quoted[0]) : ""
}

function extractFilePathFromText(text = "") {
  const normalized = String(text || "")
  const fileSent = normalized.match(/File sent:\s*([^\n]+)/iu)
  if (fileSent?.[1]) {
    return normalizeSlashPath(fileSent[1].trim())
  }
  const anyPath = normalized.match(/[A-Za-z]:[\\/][^\r\n"]+/u)
  return anyPath?.[0] ? normalizeSlashPath(anyPath[0].trim()) : ""
}

function extractQuotedTokens(command = "") {
  const tokens = []
  for (const match of String(command || "").matchAll(/(['"])(.*?)\1/gu)) {
    if (match[2]) {
      tokens.push(match[2])
    }
  }
  return tokens
}

function looksLikePathToken(value = "") {
  const normalized = normalizeSlashPath(value)
  return /^[A-Za-z]:\//u.test(normalized) || /^(?:diary|inbox|src|stickers)\//u.test(normalized)
}

function firstObject(...values) {
  for (const value of values) {
    if (value && typeof value === "object") {
      return value
    }
  }
  return {}
}

function firstText(...values) {
  for (const value of values) {
    const normalized = normalizeText(value)
    if (normalized) {
      return normalized
    }
  }
  return ""
}

function truncateText(value = "", maxLength = 160) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  buildOperationTextFromToolCall,
  extractCanonicalToolCall,
  extractFilePath,
  extractReminderText,
  extractStickerId,
  extractTextPayload,
  inferOperationKind,
  inferShellCommandKind,
  normalizeToolName,
  parseStructuredValue,
}
