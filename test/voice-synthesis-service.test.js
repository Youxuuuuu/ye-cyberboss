const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")

const { createVoiceAssetStore } = require("../src/custom/xiaoye/voice/asset-store")
const { createVoiceGenerationStore } = require("../src/custom/xiaoye/voice/generation-store")
const { createVoiceProfileStore } = require("../src/custom/xiaoye/voice/profile-store")
const { createAssistantVoiceSynthesis } = require("../src/custom/xiaoye/voice/synthesis-service")
const { normalizeVoiceProfile, normalizeSpeechDeliveryPlan } = require("../src/custom/xiaoye/voice/synthesis-contract")

test("assistant voice synthesis preserves identity, snapshots and state order", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-voice-service-"))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const states = []
  let providerCalls = 0
  const service = createService({
    stateDir,
    provider: {
      async synthesize() {
        providerCalls += 1
        return { provider: "minimax", model: "speech-2.8-hd", bytes: mp3Bytes(), mimeType: "audio/mpeg", durationMs: 8_123 }
      },
    },
    stateSink: (entry) => states.push(entry),
  })

  const result = await service.synthesizeAssistantVoice({
    threadId: "thread-1",
    messageId: "message-1",
    itemId: "item-1",
    spokenText: "今天也要好好的。",
    speechDeliveryPlan: plan(),
  })

  assert.equal(result.kind, "delivered")
  assert.equal(providerCalls, 1)
  assert.equal(result.voiceMessage.origin, "assistant")
  assert.equal(result.voiceMessage.processing.state, "delivered")
  assert.equal(result.voiceMessage.synthesis.voiceProfileVersion, "voice-profile-v1")
  assert.equal(states.length, 2)
  assert.deepEqual(states.map((entry) => entry.voiceMessage.processing.state), ["synthesizing", "delivered"])
  assert.equal(states[0].messageId, "message-1")
  assert.equal((await service.generationStore.get(result.voiceMessage.synthesis.generationId)).spokenText, "今天也要好好的。")
})

test("predicted over-limit text falls back before calling the provider", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-voice-service-long-"))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  let called = false
  const service = createService({
    stateDir,
    provider: { async synthesize() { called = true; throw new Error("must not call") } },
  })
  const result = await service.synthesizeAssistantVoice({
    threadId: "thread-1",
    spokenText: "字".repeat(241),
    speechDeliveryPlan: plan(),
  })
  assert.equal(result.kind, "text-fallback")
  assert.equal(result.reason, "too-long")
  assert.equal(called, false)
})

test("provider failure keeps an unplayable voice bubble and no fake asset", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-voice-service-failed-"))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const states = []
  const service = createService({
    stateDir,
    provider: {
      async synthesize() {
        const error = new Error("provider unavailable")
        error.reason = "provider-unavailable"
        throw error
      },
    },
    stateSink: (entry) => states.push(entry),
  })
  const result = await service.synthesizeAssistantVoice({ threadId: "thread-1", messageId: "message-1", spokenText: "你好", speechDeliveryPlan: emptyPlan() })
  assert.equal(result.kind, "failed")
  assert.equal(result.voiceMessage.processing.state, "synthesis-failed")
  assert.equal(result.voiceMessage.processing.reason, "provider-unavailable")
  assert.equal(result.voiceMessage.asset, undefined)
  assert.equal(states.at(-1).voiceMessage.processing.state, "synthesis-failed")
})

test("asset persistence failure becomes a failed unplayable voice bubble", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-voice-service-asset-failed-"))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const states = []
  const service = createService({
    stateDir,
    stateSink: (entry) => states.push(entry),
    assetStore: {
      async persistGeneratedVoice() {
        const error = new Error("disk full")
        error.reason = "too-large"
        throw error
      },
    },
    provider: {
      async synthesize() {
        return { provider: "minimax", model: "speech-2.8-hd", bytes: mp3Bytes(), mimeType: "audio/mpeg", durationMs: 1000 }
      },
    },
  })
  const result = await service.synthesizeAssistantVoice({ threadId: "thread-1", spokenText: "你好", speechDeliveryPlan: emptyPlan() })
  assert.equal(result.kind, "failed")
  assert.equal(result.reason, "too-large")
  assert.equal(result.voiceMessage.processing.state, "synthesis-failed")
  assert.equal(result.voiceMessage.asset, undefined)
  assert.equal(states.at(-1).voiceMessage.processing.reason, "too-large")
})

test("actual over-limit audio is persisted but not delivered as a voice bubble", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-voice-service-actual-long-"))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  let published = false
  const service = createService({
    stateDir,
    provider: {
      async synthesize() {
        return { provider: "minimax", model: "speech-2.8-hd", bytes: mp3Bytes(), mimeType: "audio/mpeg", durationMs: 60_001 }
      },
    },
    publishAssistantVoice: () => { published = true },
  })
  const result = await service.synthesizeAssistantVoice({ threadId: "thread-1", spokenText: "你好", speechDeliveryPlan: emptyPlan() })
  assert.equal(result.kind, "text-fallback")
  assert.equal(result.reason, "too-long")
  assert.equal(result.asset.relativePath.startsWith("threads/thread-1/"), true)
  assert.equal(published, false)
})

test("speech rendition failure preserves the active generation, success atomically replaces it", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-voice-service-rendition-"))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const existing = {
    schemaVersion: 1,
    status: "ready",
    activeGenerationId: "generation-old",
    asset: { assetId: "asset-old", relativePath: "threads/thread-1/2026/08/old.mp3", mimeType: "audio/mpeg", sizeBytes: 8, durationMs: 1000 },
    synthesis: {
      provider: "minimax", model: "speech-2.8-hd", generationId: "generation-old", sourceTextHash: "sha256:old",
      voiceProfileVersion: "voice-profile-v1", speechDeliveryPlanVersion: "speech-delivery-plan-v1",
    },
  }
  const service = createService({
    stateDir,
    provider: {
      async synthesize() {
        return { provider: "minimax", model: "speech-2.8-hd", bytes: mp3Bytes(), mimeType: "audio/mpeg", durationMs: 1000 }
      },
    },
  })
  const next = await service.synthesizeSpeechRendition({ threadId: "thread-1", sourceText: "原文", existingRendition: existing, speechDeliveryPlan: emptyPlan() })
  assert.equal(next.status, "ready")
  assert.notEqual(next.activeGenerationId, "generation-old")
  assert.equal(next.asset.relativePath.startsWith("threads/thread-1/"), true)
})

function createService({ stateDir, provider, stateSink, publishAssistantVoice, assetStore: suppliedAssetStore }) {
  const profile = normalizeVoiceProfile({
    schemaVersion: 1, version: "voice-profile-v1", defaultProvider: "minimax", defaultExpression: "warm",
    bindings: { minimax: { model: "speech-2.8-hd", voiceId: "voice-1", languageBoost: "Chinese", speed: 1, volume: 1, pitch: 0, audio: { format: "mp3", sampleRate: 32000, bitrate: 128000, channel: 1 }, pronunciationDictionary: [] } },
  })
  const profileStore = createVoiceProfileStore({ stateDir })
  const generationStore = createVoiceGenerationStore({ stateDir })
  const assetStore = suppliedAssetStore || createVoiceAssetStore({ stateDir, createId: (() => { let index = 0; return () => `asset-${++index}` })(), probeAudio: async ({ absolutePath }) => ({ durationMs: absolutePath ? 8_123 : 0 }) })
  return createAssistantVoiceSynthesis({
    provider,
    profileStore: { async load() { return profile }, async loadVersion() { return profile } },
    generationStore,
    assetStore,
    stateSink,
    publishAssistantVoice,
    now: () => new Date("2026-08-09T01:02:03.004Z"),
    createId: (() => { let index = 0; return () => `generation-${++index}` })(),
  })
}

function emptyPlan() {
  return normalizeSpeechDeliveryPlan({ schemaVersion: 1, version: "speech-delivery-plan-v1", emotion: "", pauses: [], soundTags: [] })
}

function plan() {
  return normalizeSpeechDeliveryPlan({ schemaVersion: 1, version: "speech-delivery-plan-v1", emotion: "warm", speedOffset: 0, volumeOffset: 0, pitchOffset: 0, pauses: [], soundTags: [] })
}

function mp3Bytes() {
  return Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00])
}
