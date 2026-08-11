const test = require("node:test")
const assert = require("node:assert/strict")

const { createMosslandSynthesisProvider } = require("../src/custom/xiaoye/voice/mossland-synthesis-provider")
const { VoiceSynthesisError } = require("../src/custom/xiaoye/voice/synthesis-errors")

test("Mossland adapter sends exact spoken text and returns bounded binary audio", async () => {
  let request
  const provider = createMosslandSynthesisProvider({
    env: { MOSS_API_KEY: "secret-test-key" },
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) }
      return new Response(mp3Bytes(), { status: 200, headers: { "Content-Type": "audio/mpeg" } })
    },
  })
  const result = await provider.synthesize({
    spokenText: "宝宝，我在呢。",
    voiceProfile: profile(),
    speechDeliveryPlan: planWithUnsupportedControls(),
  })

  assert.equal(request.url, "https://api.mosi.cn/v1/audio/speech")
  assert.equal(request.options.headers.Authorization, "Bearer secret-test-key")
  assert.deepEqual(request.body, {
    model: "moss-tts",
    version: "moss-tts-v1.5-flash",
    input: "宝宝，我在呢。",
    voice_id: "mossland-approved-voice",
    response_format: "mp3",
    delivery_method: "audio",
  })
  assert.deepEqual(result.bytes, mp3Bytes())
  assert.equal(result.provider, "mossland")
  assert.equal(result.model, "moss-tts")
  assert.equal(result.mimeType, "audio/mpeg")
  assert.equal(result.durationMs, null)
})

test("Mossland adapter reports unconfigured without making a request", async () => {
  let called = false
  const provider = createMosslandSynthesisProvider({ env: {}, fetchImpl: async () => { called = true } })
  await assert.rejects(
    provider.synthesize({ spokenText: "你好", voiceProfile: profile(), speechDeliveryPlan: planWithUnsupportedControls() }),
    (error) => error instanceof VoiceSynthesisError && error.reason === "provider-unconfigured",
  )
  assert.equal(called, false)
})

test("Mossland public status requires both the server key and approved voice id", () => {
  assert.equal(createMosslandSynthesisProvider({ env: {}, fetchImpl: async () => new Response() }).getStatus().configured, false)
  assert.equal(createMosslandSynthesisProvider({ env: { MOSS_API_KEY: "key" }, fetchImpl: async () => new Response() }).getStatus().configured, false)
  assert.equal(createMosslandSynthesisProvider({
    env: { MOSS_API_KEY: "key", MOSS_VOICE_ID: "voice" },
    fetchImpl: async () => new Response(),
  }).getStatus().configured, true)
})

test("Mossland adapter maps rejection and non-audio success responses", async () => {
  const rejected = createMosslandSynthesisProvider({
    env: { MOSS_API_KEY: "secret-test-key" },
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "secret provider detail" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }),
  })
  await assert.rejects(
    rejected.synthesize({ spokenText: "你好", voiceProfile: profile(), speechDeliveryPlan: planWithUnsupportedControls() }),
    (error) => error instanceof VoiceSynthesisError
      && error.reason === "provider-rejected"
      && !error.message.includes("secret provider detail"),
  )

  const malformed = createMosslandSynthesisProvider({
    env: { MOSS_API_KEY: "secret-test-key" },
    fetchImpl: async () => new Response("not audio", { status: 200, headers: { "Content-Type": "text/plain" } }),
  })
  await assert.rejects(
    malformed.synthesize({ spokenText: "你好", voiceProfile: profile(), speechDeliveryPlan: planWithUnsupportedControls() }),
    (error) => error instanceof VoiceSynthesisError && error.reason === "malformed-provider-output",
  )
})

test("Mossland adapter distinguishes timeout from caller cancellation", async () => {
  const timedOut = createMosslandSynthesisProvider({
    env: { MOSS_API_KEY: "secret-test-key" },
    timeoutMs: 10,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
    }),
  })
  await assert.rejects(
    timedOut.synthesize({ spokenText: "你好", voiceProfile: profile(), speechDeliveryPlan: planWithUnsupportedControls() }),
    (error) => error instanceof VoiceSynthesisError && error.reason === "provider-timeout",
  )

  const controller = new AbortController()
  const cancelled = createMosslandSynthesisProvider({
    env: { MOSS_API_KEY: "secret-test-key" },
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
      controller.abort(new Error("client left"))
    }),
  })
  await assert.rejects(
    cancelled.synthesize({ spokenText: "你好", voiceProfile: profile(), speechDeliveryPlan: planWithUnsupportedControls(), signal: controller.signal }),
    (error) => error instanceof VoiceSynthesisError && error.reason === "cancelled",
  )
})

function profile() {
  return {
    schemaVersion: 1,
    version: "voice-profile-mossland-v1",
    defaultProvider: "mossland",
    defaultExpression: "warm",
    bindings: {
      mossland: {
        model: "moss-tts",
        version: "moss-tts-v1.5-flash",
        voiceId: "mossland-approved-voice",
        audio: { format: "mp3" },
      },
    },
  }
}

function planWithUnsupportedControls() {
  return {
    schemaVersion: 1,
    version: "bedtime-soft-v1",
    emotion: "gentle",
    speedOffset: -0.1,
    volumeOffset: -0.15,
    pitchOffset: -1,
    pauses: [{ afterCharacter: 3, durationSeconds: 0.35 }],
    soundTags: [{ afterCharacter: 3, tag: "breath" }],
  }
}

function mp3Bytes() {
  return Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00])
}
