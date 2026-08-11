const crypto = require("node:crypto")

/**
 * Narrow project-tool seam for an explicit Assistant WebChat Voice Message.
 * This deliberately rejects WeChat: the official WeChat renderer does not
 * consume the Voice Message contract, so the existing upstream channel path
 * must not receive a synthetic audio payload.
 */
class ChannelVoiceService {
  constructor({ channelAdapter } = {}) {
    if (!channelAdapter || typeof channelAdapter !== "object") throw new TypeError("channel voice service requires channelAdapter")
    this.channelAdapter = channelAdapter
  }

  async sendToCurrentChat({ text = "", messageId = "", itemId = "", turnId = "", speechDeliveryPlan = null } = {}, context = {}) {
    const spokenText = normalizeText(text)
    if (!spokenText) throw new Error("Voice message text is required.")
    if (typeof this.channelAdapter.sendVoice !== "function") {
      throw new Error("Assistant Voice Message delivery is not available in this channel adapter.")
    }
    const provider = normalizeProvider(context.provider)
    if (provider === "weixin") {
      throw new Error("Assistant Voice Message is only available in WebChat; WeChat voice rendering is not enabled.")
    }
    if (provider && provider !== "web") {
      throw new Error(`Unsupported voice delivery provider: ${provider}`)
    }
    const senderId = normalizeText(context.senderId)
      || normalizeText(this.channelAdapter.getWebReplyTarget?.("")?.userId)
    if (!senderId) throw new Error("Cannot determine the current WebChat sender.")
    const stableMessageId = normalizeText(messageId) || crypto.randomUUID()
    const result = await this.channelAdapter.sendVoice({
      provider: "web",
      userId: senderId,
      threadId: normalizeText(context.threadId),
      messageId: stableMessageId,
      itemId: normalizeText(itemId) || stableMessageId,
      turnId: normalizeText(turnId),
      requestId: `voice:${stableMessageId}`,
      spokenText,
      speechDeliveryPlan: speechDeliveryPlan && typeof speechDeliveryPlan === "object" && !Array.isArray(speechDeliveryPlan)
        ? speechDeliveryPlan
        : null,
    })
    const delivered = result?.kind === "delivered"
      || (result?.accepted === true && result?.status === "accepted")
    return {
      text: delivered
        ? "Assistant Voice Message delivered to WebChat."
        : `Assistant Voice Message was not delivered${result?.reason ? `: ${result.reason}` : "."}`,
      data: { ...result, accepted: delivered, messageId: stableMessageId },
    }
  }
}

function normalizeProvider(value) {
  const normalized = normalizeText(value).toLowerCase()
  return normalized === "web" || normalized === "weixin" ? normalized : ""
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = { ChannelVoiceService }
