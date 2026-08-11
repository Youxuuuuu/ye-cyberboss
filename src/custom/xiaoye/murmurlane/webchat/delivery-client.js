function createWebChatDeliveryClient({ config }) {
  return {
    describe() {
      return {
        id: "webchat-delivery-client",
        kind: "channel-client",
      }
    },
    getReplyTarget() {
      return null
    },
    sendText() {
      return Promise.reject(new Error("The WebChat tool delivery client only supports files."))
    },
    sendTyping() {
      return Promise.resolve()
    },
    async sendFile(payload = {}) {
      const response = await fetch(buildDeliveryUrl(config), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(normalizeText(config.webChatToken)
            ? { Authorization: `Bearer ${normalizeText(config.webChatToken)}` }
            : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      })
      const result = await readJsonResponse(response)
      if (!response.ok) {
        throw new Error(normalizeText(result?.error) || `WebChat delivery failed with HTTP ${response.status}`)
      }
      return result
    },
    async sendVoice(payload = {}) {
      const response = await fetch(buildVoiceUrl(config), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(normalizeText(config.webChatToken)
            ? { Authorization: `Bearer ${normalizeText(config.webChatToken)}` }
            : {}),
        },
        body: JSON.stringify({
          requestId: normalizeText(payload.requestId) || `voice:${cryptoRandomId()}`,
          messageId: normalizeText(payload.messageId),
          itemId: normalizeText(payload.itemId),
          turnId: normalizeText(payload.turnId),
          threadId: normalizeText(payload.threadId),
          spokenText: normalizeText(payload.spokenText),
          speechDeliveryPlan: payload.speechDeliveryPlan || null,
        }),
        signal: AbortSignal.timeout(Number(config.assistantVoiceWorkflowTimeoutMs) || 130_000),
      })
      const result = await readJsonResponse(response)
      if (!response.ok) {
        throw new Error(normalizeText(result?.error) || `WebChat voice delivery failed with HTTP ${response.status}`)
      }
      return result
    },
  }
}

function buildDeliveryUrl(config = {}) {
  const host = normalizeClientHost(config.webChatHost)
  const port = Number(config.webChatPort) || 8791
  return `http://${host}:${port}/api/chat/internal/file-deliveries`
}

function buildVoiceUrl(config = {}) {
  const host = normalizeClientHost(config.webChatHost)
  const port = Number(config.webChatPort) || 8791
  return `http://${host}:${port}/api/chat/assistant-voice`
}

function cryptoRandomId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function normalizeClientHost(value) {
  const normalized = normalizeText(value).replace(/^\[|\]$/g, "")
  if (!normalized || normalized === "0.0.0.0" || normalized === "::") {
    return "127.0.0.1"
  }
  return normalized.includes(":") ? `[${normalized}]` : normalized
}

async function readJsonResponse(response) {
  const text = await response.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = { createWebChatDeliveryClient }
