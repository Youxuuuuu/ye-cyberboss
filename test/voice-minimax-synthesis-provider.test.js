const test = require("node:test")
const assert = require("node:assert/strict")

const {
  createMiniMaxSynthesisProvider,
} = require("../src/custom/xiaoye/voice/minimax-synthesis-provider")
const {
  normalizeSpeechDeliveryPlan,
  normalizeVoiceProfile,
} = require("../src/custom/xiaoye/voice/synthesis-contract")
const { VoiceSynthesisError } = require("../src/custom/xiaoye/voice/synthesis-errors")

test("MiniMax adapter maps a stable profile and safe plan without changing display transcript", async () => {
  let request
  const provider = createMiniMaxSynthesisProvider({
    env: { MINIMAX_API_KEY: "secret-test-key" },
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) }
      return jsonResponse(200, {
        data: { audio: mp3Bytes().toString("hex"), status: 2 },
        extra_info: { audio_length: 8123, audio_size: mp3Bytes().length, audio_format: "mp3" },
        base_resp: { status_code: 0, status_msg: "success" },
      })
    },
  })
  const result = await provider.synthesize({
    spokenText: "今天也要好好的。",
    voiceProfile: profile(),
    speechDeliveryPlan: plan(),
  })

  assert.equal(request.url, "https://api.minimax.io/v1/t2a_v2")
  assert.equal(request.options.headers.Authorization, "Bearer secret-test-key")
  assert.equal(request.body.model, "speech-2.8-hd")
  assert.equal(request.body.stream, false)
  assert.equal(request.body.output_format, "hex")
  assert.deepEqual(request.body.voice_setting, {
    voice_id: "xiaoye-approved-voice",
    speed: 0.95,
    vol: 1,
    pitch: 1,
    emotion: "calm",
  })
  assert.equal(request.body.text, "(sighs)今天也要<#0.35#>好好的。")
  assert.equal(result.spokenText, "今天也要好好的。")
  assert.deepEqual(result.bytes, mp3Bytes())
  assert.equal(result.mimeType, "audio/mpeg")
  assert.equal(result.durationMs, 8123)
})

test("MiniMax adapter reports unconfigured without making a request", async () => {
  let called = false
  const provider = createMiniMaxSynthesisProvider({ env: {}, fetchImpl: async () => { called = true } })
  await assert.rejects(
    provider.synthesize({ spokenText: "你好", voiceProfile: profile(), speechDeliveryPlan: plan() }),
    (error) => error instanceof VoiceSynthesisError && error.reason === "provider-unconfigured",
  )
  assert.equal(called, false)
})

test("MiniMax adapter maps provider rejection and malformed audio without exposing provider text", async () => {
  const rejected = createMiniMaxSynthesisProvider({
    env: { MINIMAX_API_KEY: "secret-test-key" },
    fetchImpl: async () => jsonResponse(200, {
      base_resp: { status_code: 1008, status_msg: "sensitive moderation detail" },
    }),
  })
  await assert.rejects(
    rejected.synthesize({ spokenText: "今天也要好好的。", voiceProfile: profile(), speechDeliveryPlan: plan() }),
    (error) => error instanceof VoiceSynthesisError
      && error.reason === "provider-rejected"
      && !error.message.includes("sensitive moderation detail"),
  )

  const malformed = createMiniMaxSynthesisProvider({
    env: { MINIMAX_API_KEY: "secret-test-key" },
    fetchImpl: async () => jsonResponse(200, {
      data: { audio: "not-hex", status: 2 },
      extra_info: { audio_length: 1000, audio_format: "mp3" },
      base_resp: { status_code: 0, status_msg: "success" },
    }),
  })
  await assert.rejects(
    malformed.synthesize({ spokenText: "今天也要好好的。", voiceProfile: profile(), speechDeliveryPlan: plan() }),
    (error) => error instanceof VoiceSynthesisError && error.reason === "malformed-provider-output",
  )
})

test("MiniMax adapter distinguishes its timeout from caller cancellation", async () => {
  const timedOut = createMiniMaxSynthesisProvider({
    env: { MINIMAX_API_KEY: "secret-test-key" },
    timeoutMs: 10,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
    }),
  })
  await assert.rejects(
    timedOut.synthesize({ spokenText: "今天也要好好的。", voiceProfile: profile(), speechDeliveryPlan: plan() }),
    (error) => error instanceof VoiceSynthesisError && error.reason === "provider-timeout",
  )

  const controller = new AbortController()
  const cancelled = createMiniMaxSynthesisProvider({
    env: { MINIMAX_API_KEY: "secret-test-key" },
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
      controller.abort(new Error("client left"))
    }),
  })
  await assert.rejects(
    cancelled.synthesize({ spokenText: "今天也要好好的。", voiceProfile: profile(), speechDeliveryPlan: plan(), signal: controller.signal }),
    (error) => error instanceof VoiceSynthesisError && error.reason === "cancelled",
  )
})

function profile() {
  return normalizeVoiceProfile({
    schemaVersion: 1,
    version: "voice-profile-v1",
    defaultProvider: "minimax",
    defaultExpression: "warm",
    bindings: {
      minimax: {
        model: "speech-2.8-hd",
        voiceId: "xiaoye-approved-voice",
        languageBoost: "Chinese",
        speed: 1,
        volume: 1,
        pitch: 0,
        audio: { format: "mp3", sampleRate: 32000, bitrate: 128000, channel: 1 },
        pronunciationDictionary: ["小机/小季"],
      },
    },
  })
}

function plan() {
  return normalizeSpeechDeliveryPlan({
    schemaVersion: 1,
    version: "speech-delivery-plan-v1",
    emotion: "gentle",
    speedOffset: -0.05,
    volumeOffset: 0,
    pitchOffset: 1,
    pauses: [{ afterCharacter: 4, durationSeconds: 0.35 }],
    soundTags: [{ afterCharacter: 0, tag: "sighs" }],
  })
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function mp3Bytes() {
  return Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00])
}
