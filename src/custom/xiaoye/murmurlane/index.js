const { createMurmurLaneChatService } = require("./chat-service")
const { createWebChatChannelAdapter } = require("./webchat")
const { createWebChatServer } = require("./webchat/server")

function createMurmurLaneModule({
  config,
  cyberbossPort,
  conversationCommands = null,
  voiceDependencies = null,
  env = process.env,
} = {}) {
  const adapter = createWebChatChannelAdapter({ config })
  const chatService = createMurmurLaneChatService({
    config,
    adapter,
    cyberbossPort,
    conversationCommands,
    voiceDependencies,
    env,
  })
  // The project-tool channel router can call this seam when the runtime
  // explicitly invokes cyberboss_webchat_send_voice. It remains a WebChat-only
  // adapter capability and does not alter Cyberboss Core channel behavior.
  adapter.sendVoice = (payload = {}) => chatService.handleWebChatAssistantVoice({
    senderId: payload.userId,
    threadId: payload.threadId,
    messageId: payload.messageId,
    itemId: payload.itemId,
    turnId: payload.turnId,
    spokenText: payload.spokenText,
    speechDeliveryPlan: payload.speechDeliveryPlan,
  })
  const server = createWebChatServer({
    config,
    adapter,
    chatService,
  })

  return {
    adapter,
    server,
    chatService,
    async start() {
      return server.start()
    },
    async close() {
      return server.close()
    },
    publishRuntimeEvent(event) {
      return adapter.publishRuntimeEvent(event)
    },
    handleIncomingProvider(normalized) {
      adapter.clearActiveTarget(normalized?.senderId)
    },
    handleRuntimeTurnStarted({ prepared, turn, previousThreadId = "" } = {}) {
      if (prepared?.provider !== "web") {
        return false
      }
      adapter.setActiveTarget({
        userId: prepared.senderId,
        contextToken: prepared.contextToken,
        clientId: prepared.clientId,
        threadId: turn.threadId,
      })
      adapter.publish({
        kind: "thread.created",
        senderId: prepared.senderId,
        threadId: turn.threadId,
        turnId: turn.turnId || "",
        previousThreadId,
        clientId: prepared.clientId || "",
      })
      return true
    },
  }
}

module.exports = { createMurmurLaneModule }
