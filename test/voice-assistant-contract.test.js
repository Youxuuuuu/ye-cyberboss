const test = require("node:test")
const assert = require("node:assert/strict")

const { createAssistantVoiceMessage, normalizeVoiceMessage } = require("../src/custom/xiaoye/voice/contract")
const { createSpeechRendition, normalizeSpeechRendition } = require("../src/custom/xiaoye/voice/speech-rendition-contract")

const synthesis = {
  provider: "minimax",
  model: "speech-2.8-hd",
  generationId: "generation-1",
  sourceTextHash: "sha256:abc",
  voiceProfileVersion: "voice-profile-v1",
  speechDeliveryPlanVersion: "speech-delivery-plan-v1",
}

test("assistant voice message keeps spoken transcript and synthesis metadata in one stable bubble", () => {
  const message = createAssistantVoiceMessage({
    asset: {
      assetId: "asset-1",
      relativePath: "threads/thread-1/2026/08/2026-08-09-09-02-03-004.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 8,
      durationMs: 8_123,
    },
    spokenText: "今天也要好好的。",
    synthesis,
    state: "delivered",
  })

  assert.equal(message.origin, "assistant")
  assert.equal(message.transcript.normalizedText, "今天也要好好的。")
  assert.equal(message.synthesis.generationId, "generation-1")
  assert.equal(message.processing.state, "delivered")
  assert.equal(normalizeVoiceMessage(message).asset.relativePath.startsWith("threads/"), true)
})

test("speech rendition remains attached metadata and failed regeneration keeps active generation", () => {
  const ready = createSpeechRendition({
    status: "ready",
    activeGenerationId: "generation-1",
    asset: {
      assetId: "asset-1",
      relativePath: "threads/thread-1/2026/08/2026-08-09-09-02-03-004.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 8,
      durationMs: 8_123,
    },
    synthesis,
  })
  const failed = normalizeSpeechRendition({
    ...ready,
    status: "failed",
  })
  assert.equal(ready.activeGenerationId, "generation-1")
  assert.equal(failed.activeGenerationId, "generation-1")
  assert.equal(failed.asset.assetId, "asset-1")
})

test("speech rendition rejects self assets and a ready state without an active generation", () => {
  assert.throws(() => normalizeSpeechRendition({
    schemaVersion: 1,
    status: "ready",
    activeGenerationId: "generation-1",
    asset: {
      assetId: "asset-1",
      relativePath: "self/2026/08/audio.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 8,
      durationMs: 100,
    },
    synthesis,
  }), /thread voice path/u)
  assert.throws(() => normalizeSpeechRendition({ schemaVersion: 1, status: "ready" }), /active asset/u)
})
