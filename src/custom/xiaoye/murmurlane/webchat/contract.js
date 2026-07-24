const crypto = require("crypto")

function normalizeWebChatSendContract(input = {}, { createId = () => crypto.randomUUID(), now = () => new Date().toISOString() } = {}) {
  const rawMessages = Array.isArray(input.messages) ? input.messages.filter(isObject) : []
  const logicalInput = rawMessages.length === 1 ? rawMessages[0] : null
  const rawSegments = Array.isArray(logicalInput?.bubbleSegments) && logicalInput.bubbleSegments.length
    ? logicalInput.bubbleSegments
    : rawMessages
  const requestId = normalizeText(input.requestId || input.batchId) || `request-${createId()}`
  const messageId = normalizeText(input.messageId || logicalInput?.messageId) || `message-${createId()}`
  const bubbleSegments = rawSegments.map((segment) => ({
    segmentId: normalizeText(segment.segmentId || segment.messageId) || `segment-${createId()}`,
    text: normalizeText(segment.text),
    ...(segment.quote ? { quote: segment.quote } : {}),
    ...(Array.isArray(segment.attachments) && segment.attachments.length
      ? { attachments: segment.attachments }
      : {}),
  }))

  if (!bubbleSegments.length) {
    throw new Error("web chat send contract requires at least one bubble segment")
  }
  if (new Set(bubbleSegments.map((segment) => segment.segmentId)).size !== bubbleSegments.length) {
    throw new Error("web chat send contract requires unique segmentId values")
  }

  const receivedAt = normalizeText(logicalInput?.receivedAt)
    || rawSegments.map((segment) => normalizeText(segment.receivedAt)).find(Boolean)
    || now()
  const logicalMessage = {
    messageId,
    text: bubbleSegments.map((segment) => segment.text).filter(Boolean).join("\n\n"),
    ...(bubbleSegments.length === 1 && bubbleSegments[0].quote
      ? { quote: bubbleSegments[0].quote }
      : {}),
    attachments: bubbleSegments.flatMap((segment) => segment.attachments || []),
    receivedAt,
    bubbleSegments,
  }

  return {
    requestId,
    messageId,
    logicalTurnId: `web:${requestId}`,
    messages: [logicalMessage],
  }
}

function buildWebChatRequestFingerprint(contract = {}, context = {}) {
  const stablePayload = {
    requestId: normalizeText(contract.requestId),
    messageId: normalizeText(contract.messageId),
    threadId: normalizeText(context.threadId),
    newThread: Boolean(context.newThread),
    messages: Array.isArray(contract.messages) ? contract.messages : [],
  }
  return crypto.createHash("sha256").update(JSON.stringify(stablePayload)).digest("hex")
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  buildWebChatRequestFingerprint,
  normalizeWebChatSendContract,
}
