const WEB_CHAT_METHODS = [
  "getWebChatIdentity",
  "getWebChatStatus",
  "getWebChatModels",
  "setWebChatModel",
  "selectWebChatThread",
  "handleWebChatMessages",
]

function createMurmurLaneChatService({ cyberbossPort } = {}) {
  if (!cyberbossPort || typeof cyberbossPort !== "object") {
    throw new Error("murmurlane chat service requires cyberbossPort")
  }

  return Object.fromEntries(WEB_CHAT_METHODS.map((methodName) => [
    methodName,
    (...args) => {
      const method = cyberbossPort[methodName]
      if (typeof method !== "function") {
        throw new Error(`cyberbossPort.${methodName} is required`)
      }
      return method(...args)
    },
  ]))
}

module.exports = { createMurmurLaneChatService }
