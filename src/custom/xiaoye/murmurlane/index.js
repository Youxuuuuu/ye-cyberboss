const { createMurmurLaneChatService } = require("./chat-service")
const { createWebChatChannelAdapter } = require("./webchat")
const { createWebChatServer } = require("./webchat/server")

function createMurmurLaneModule({
  config,
  cyberbossPort,
  conversationCommands = null,
} = {}) {
  const adapter = createWebChatChannelAdapter({ config })
  const chatService = createMurmurLaneChatService({
    config,
    adapter,
    cyberbossPort,
    conversationCommands,
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
