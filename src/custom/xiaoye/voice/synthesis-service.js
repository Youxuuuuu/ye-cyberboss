const crypto = require("node:crypto")
const { createAssistantVoiceMessage, normalizeVoiceMessage } = require("./contract")
const { createSpeechRendition, normalizeSpeechRendition } = require("./speech-rendition-contract")
const { getVoiceProfileBinding, normalizeSpeechDeliveryPlan, normalizeVoiceProfile, createSynthesisMetadata } = require("./synthesis-contract")
const { VoiceSynthesisError } = require("./synthesis-errors")

const MAX_DURATION_MS = 60_000

function createAssistantVoiceSynthesis({
  provider,
  profileStore,
  generationStore,
  assetStore,
  stateSink = null,
  publishAssistantVoice = null,
  now = () => new Date(),
  createId = () => crypto.randomUUID(),
  estimatedCharactersPerSecond = 4,
} = {}) {
  if (!provider || typeof provider.synthesize !== "function") throw new TypeError("assistant synthesis requires provider")
  if (!profileStore || typeof profileStore.load !== "function") throw new TypeError("assistant synthesis requires profileStore")
  if (!generationStore || typeof generationStore.save !== "function") throw new TypeError("assistant synthesis requires generationStore")
  if (!assetStore || typeof assetStore.persistGeneratedVoice !== "function") throw new TypeError("assistant synthesis requires assetStore")

  async function synthesizeAssistantVoice({
    threadId,
    messageId = "",
    itemId = "",
    turnId = "",
    spokenText,
    voiceProfile = null,
    speechDeliveryPlan = null,
    signal = null,
    generationId = "",
    kind = "assistant-voice-message",
  } = {}) {
    const text = normalizeSpokenText(spokenText)
    const estimatedDurationMs = estimateSpeechDurationMs(text, estimatedCharactersPerSecond)
    if (estimatedDurationMs > MAX_DURATION_MS) {
      return { kind: "text-fallback", reason: "too-long", spokenText: text, estimatedDurationMs }
    }
    const loadedProfile = voiceProfile || await profileStore.load()
    if (!loadedProfile) throw new VoiceSynthesisError("provider-unconfigured", "Assistant voice profile is not configured", { statusCode: 503 })
    const profile = normalizeVoiceProfile(loadedProfile)
    const plan = normalizeSpeechDeliveryPlan(speechDeliveryPlan || defaultPlan())
    const providerId = provider.id || profile.defaultProvider
    const providerBinding = getVoiceProfileBinding(profile, providerId)
    const stableGenerationId = generationId || createId()
    const metadata = createSynthesisMetadata({
      provider: providerId,
      model: providerBinding.model,
      generationId: stableGenerationId,
      spokenText: text,
      voiceProfile: profile,
      speechDeliveryPlan: plan,
    })
    await generationStore.save({
      schemaVersion: 1,
      generationId: stableGenerationId,
      kind,
      threadId: normalizeRequired(threadId, "threadId"),
      messageId: normalizeOptional(messageId),
      itemId: normalizeOptional(itemId),
      turnId: normalizeOptional(turnId),
      spokenText: text,
      sourceTextHash: metadata.sourceTextHash,
      voiceProfile: profile,
      speechDeliveryPlan: plan,
      createdAt: now().toISOString(),
    })
    await emitState({
      kind,
      threadId,
      messageId,
      itemId,
      turnId,
      voiceMessage: createAssistantVoiceMessage({ spokenText: text, synthesis: metadata, state: "synthesizing" }),
    })

    let generated
    try {
      generated = await provider.synthesize({ spokenText: text, voiceProfile: profile, speechDeliveryPlan: plan, signal })
    } catch (error) {
      const reason = normalizeReason(error)
      const failed = updateProcessing(createAssistantVoiceMessage({ spokenText: text, synthesis: metadata, state: "synthesis-failed" }), "synthesis-failed", reason)
      await emitState({ kind, threadId, messageId, itemId, turnId, voiceMessage: failed })
      return { kind: "failed", reason, voiceMessage: failed }
    }

    let asset
    try {
      asset = await assetStore.persistGeneratedVoice({
        threadId: normalizeRequired(threadId, "threadId"),
        bytes: generated.bytes,
        contentType: generated.mimeType,
        signal,
      })
    } catch (error) {
      const reason = normalizeReason(error)
      const failed = updateProcessing(
        createAssistantVoiceMessage({ spokenText: text, synthesis: metadata, state: "synthesis-failed" }),
        "synthesis-failed",
        reason,
      )
      await emitState({ kind, threadId, messageId, itemId, turnId, voiceMessage: failed })
      return { kind: "failed", reason, voiceMessage: failed }
    }
    if (asset.durationMs > MAX_DURATION_MS || Number(generated.durationMs) > MAX_DURATION_MS) {
      const failed = updateProcessing(createAssistantVoiceMessage({ asset, spokenText: text, synthesis: metadata, state: "synthesis-failed" }), "synthesis-failed", "too-long")
      await emitState({ kind, threadId, messageId, itemId, turnId, voiceMessage: failed })
      return { kind: "text-fallback", reason: "too-long", spokenText: text, asset, voiceMessage: failed }
    }

    const delivered = createAssistantVoiceMessage({ asset, spokenText: text, synthesis: metadata, state: "delivered" })
    await emitState({ kind, threadId, messageId, itemId, turnId, voiceMessage: delivered })
    if (typeof publishAssistantVoice === "function") {
      await publishAssistantVoice({ threadId, messageId, itemId, turnId, voiceMessage: delivered })
    }
    return { kind: "delivered", voiceMessage: delivered, asset }
  }

  async function retryAssistantVoice({ voiceMessage, signal = null, useCurrentProfile = false } = {}) {
    const synthesis = voiceMessage?.synthesis
    const generation = synthesis?.generationId ? await generationStore.get(synthesis.generationId) : null
    if (!generation) throw new VoiceSynthesisError("unknown", "assistant voice generation is unavailable", { statusCode: 404 })
    const profile = useCurrentProfile ? await profileStore.load() : generation.voiceProfile
    const plan = generation.speechDeliveryPlan
    return synthesizeAssistantVoice({
      threadId: generation.threadId,
      messageId: generation.messageId,
      itemId: generation.itemId,
      turnId: generation.turnId,
      spokenText: generation.spokenText,
      voiceProfile: profile,
      speechDeliveryPlan: plan,
      signal,
      kind: generation.kind,
    })
  }

  async function synthesizeSpeechRendition({ threadId, sourceText, existingRendition = null, speechDeliveryPlan = null, signal = null } = {}) {
    const result = await synthesizeAssistantVoice({
      threadId,
      spokenText: sourceText,
      speechDeliveryPlan,
      signal,
      kind: "speech-rendition",
    })
    if (result.kind !== "delivered") {
      return normalizeSpeechRendition({
        ...(existingRendition || { schemaVersion: 1 }),
        schemaVersion: 1,
        status: "failed",
      })
    }
    return createSpeechRendition({
      status: "ready",
      activeGenerationId: result.voiceMessage.synthesis.generationId,
      asset: result.asset,
      synthesis: result.voiceMessage.synthesis,
    })
  }

  return { generationStore, retryAssistantVoice, synthesizeAssistantVoice, synthesizeSpeechRendition }

  async function emitState(entry) {
    if (entry.kind === "assistant-voice-message" && typeof stateSink === "function") await stateSink(entry)
  }
}

function updateProcessing(message, state, reason) {
  return normalizeVoiceMessage({
    ...message,
    processing: { ...message.processing, state, reason, updatedAt: new Date().toISOString() },
  })
}

function defaultPlan() {
  return { schemaVersion: 1, version: "speech-delivery-plan-v1", emotion: "", pauses: [], soundTags: [] }
}

function estimateSpeechDurationMs(text, charactersPerSecond) {
  const cps = Number(charactersPerSecond)
  if (!Number.isFinite(cps) || cps <= 0) throw new TypeError("estimatedCharactersPerSecond must be positive")
  return Math.ceil(Array.from(text).length / cps * 1000)
}

function normalizeSpokenText(value) {
  if (typeof value !== "string" || !value.trim() || value.length >= 10_000) throw new TypeError("spokenText is invalid")
  return value.trim()
}

function normalizeRequired(value, label) {
  const text = normalizeOptional(value)
  if (!text) throw new TypeError(`${label} is required`)
  return text
}

function normalizeOptional(value) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeReason(error) {
  const reason = normalizeOptional(error?.reason)
  return ["invalid-media", "unsupported-media", "provider-unconfigured", "provider-rejected", "provider-timeout", "provider-unavailable", "malformed-provider-output", "cancelled", "too-large", "too-long"].includes(reason)
    ? reason
    : "unknown"
}

module.exports = { createAssistantVoiceSynthesis, estimateSpeechDurationMs }
