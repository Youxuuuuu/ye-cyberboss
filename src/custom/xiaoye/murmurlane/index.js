const { createMurmurLaneChatService } = require("./chat-service")
const { createWebChatChannelAdapter } = require("./webchat")
const { createWebChatServer } = require("./webchat/server")

function createMurmurLaneModule({ config, cyberbossPort } = {}) {
  const adapter = createWebChatChannelAdapter({ config })
  const chatService = createMurmurLaneChatService({ cyberbossPort })
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
  }
}

module.exports = { createMurmurLaneModule }
