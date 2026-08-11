const { createVoiceAssetStore } = require("./asset-store")
const { probeAudioFile } = require("./audio-probe")
const { createVoiceInputService } = require("./input-service")
const { createSiliconFlowVoiceUnderstandingProvider } = require("./siliconflow-provider")

function createUserVoiceInput({
  config = {},
  env = process.env,
  stateSink,
  submitRuntime,
  dependencies = {},
  logger = console,
} = {}) {
  const enabled = resolveEnabled(config.userVoiceInputEnabled, env.CYBERBOSS_USER_VOICE_INPUT_ENABLED)
  const provider = dependencies.provider || createSiliconFlowVoiceUnderstandingProvider({
    env,
    fetchImpl: dependencies.fetchImpl || globalThis.fetch,
    timeoutMs: numberSetting(config.userVoiceProviderTimeoutMs, env.CYBERBOSS_USER_VOICE_PROVIDER_TIMEOUT_MS, 120_000),
  })
  if (!enabled) {
    const disabled = async () => {
      const error = new Error("user voice input is disabled")
      error.code = "VOICE_INPUT_DISABLED"
      error.statusCode = 404
      throw error
    }
    return {
      enabled: false,
      getStatus: () => publicProviderStatus(provider, false),
      submitUserVoice: disabled,
      retryUserVoice: disabled,
      confirmTranscript: disabled,
    }
  }
  const assetStore = dependencies.assetStore || createVoiceAssetStore({
    stateDir: config.stateDir,
    maxBytes: numberSetting(config.userVoiceMaxBytes, env.CYBERBOSS_USER_VOICE_MAX_BYTES, config.webChatMaxUploadBytes || 25 * 1024 * 1024),
    maxDurationMs: 60_000,
    probeAudio: dependencies.probeAudio || ((input) => probeAudioFile({
      ...input,
      timeoutMs: numberSetting(config.userVoiceProbeTimeoutMs, env.CYBERBOSS_USER_VOICE_PROBE_TIMEOUT_MS, 5_000),
    })),
  })
  const service = createVoiceInputService({
    assetStore,
    provider,
    stateSink,
    submitRuntime,
    logger,
    transcriptConfidenceThreshold: decimalSetting(
      config.userVoiceTranscriptConfidenceThreshold,
      env.CYBERBOSS_USER_VOICE_TRANSCRIPT_CONFIDENCE_THRESHOLD,
      0.6,
    ),
    workflowTimeoutMs: numberSetting(
      config.userVoiceWorkflowTimeoutMs,
      env.CYBERBOSS_USER_VOICE_WORKFLOW_TIMEOUT_MS,
      130_000,
    ),
    affectWaitMs: numberSetting(
      config.userVoiceAffectWaitMs,
      env.CYBERBOSS_USER_VOICE_AFFECT_WAIT_MS,
      5_000,
    ),
  })

  return {
    enabled,
    getStatus() {
      return publicProviderStatus(provider, enabled)
    },
    async submitUserVoice(command) {
      if (!enabled) {
        const error = new Error("user voice input is disabled")
        error.code = "VOICE_INPUT_DISABLED"
        error.statusCode = 404
        throw error
      }
      return service.submitUserVoice(command)
    },
    async retryUserVoice(command) {
      const reopened = await assetStore.readUserVoiceAsset(command.voiceMessage?.asset, { signal: command.signal })
      return service.retryUserVoice({ ...command, bytes: reopened.bytes, contentType: reopened.mimeType })
    },
    async confirmTranscript(command) {
      return service.confirmTranscript(command)
    },
  }
}

function publicProviderStatus(provider, enabled) {
  const status = provider.getStatus?.() || { provider: provider.id, model: provider.model, configured: true, available: true }
  return {
    enabled,
    provider: status.provider || provider.id || "",
    model: status.model || provider.model || "",
    configured: Boolean(status.configured),
    available: Boolean(status.available),
  }
}

function resolveEnabled(configValue, envValue) {
  if (typeof configValue === "boolean") return configValue
  return ["1", "true", "yes", "on"].includes(String(envValue || "").trim().toLowerCase())
}

function numberSetting(configValue, envValue, fallback) {
  for (const value of [configValue, envValue]) {
    const number = Number(value)
    if (Number.isFinite(number) && number > 0) return Math.floor(number)
  }
  return fallback
}

function decimalSetting(configValue, envValue, fallback) {
  for (const value of [configValue, envValue]) {
    const number = Number(value)
    if (Number.isFinite(number) && number >= 0 && number <= 1) return number
  }
  return fallback
}

module.exports = { createUserVoiceInput }
