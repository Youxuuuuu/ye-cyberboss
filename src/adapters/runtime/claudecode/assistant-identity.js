function buildClaudeAssistantItemId(raw, contentIndex) {
  const messageId = normalizeText(raw?.message?.id) || normalizeText(raw?.uuid)
  const index = Number(contentIndex)
  if (!messageId || !Number.isInteger(index) || index < 0) {
    return ""
  }
  return `claude:${messageId}:${index}`
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = { buildClaudeAssistantItemId }
