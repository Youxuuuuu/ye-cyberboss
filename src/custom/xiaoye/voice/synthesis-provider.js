const { createMiniMaxSynthesisProvider } = require("./minimax-synthesis-provider")
const { createMosslandSynthesisProvider } = require("./mossland-synthesis-provider")

function resolveSynthesisProviderId(config = {}, env = process.env) {
  const providerId = text(config.assistantVoiceProvider || env.CYBERBOSS_ASSISTANT_VOICE_PROVIDER || "minimax").toLowerCase()
  if (!["minimax", "mossland"].includes(providerId)) {
    throw new TypeError(`Assistant voice provider is not supported: ${providerId}`)
  }
  return providerId
}

function createConfiguredSynthesisProvider({ providerId, env = process.env, fetchImpl = globalThis.fetch, timeoutMs } = {}) {
  if (providerId === "mossland") return createMosslandSynthesisProvider({ env, fetchImpl, timeoutMs })
  if (providerId === "minimax") return createMiniMaxSynthesisProvider({ env, fetchImpl, timeoutMs })
  throw new TypeError(`Assistant voice provider is not supported: ${providerId}`)
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = { createConfiguredSynthesisProvider, resolveSynthesisProviderId }
