const test = require("node:test")
const assert = require("node:assert/strict")

const {
  createSiliconFlowVoiceUnderstandingProvider,
  normalizeProviderOutput,
} = require("../src/custom/xiaoye/voice/siliconflow-provider")
const { VoiceInputError } = require("../src/custom/xiaoye/voice/errors")

test("SiliconFlow provider sends the actual audio MIME and returns validated transcript and affect", async () => {
  let request
  const provider = testProvider({
    env: { SILICONFLOW_API_KEY: "secret-test-key" },
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) }
      return jsonResponse(200, {
        choices: [{ message: { content: JSON.stringify({
          transcript: " 喜欢你呀。 ",
          transcriptConfidence: 0.95,
          language: "zh",
          emotion: { label: "happy", confidence: 0.9, rationale: "声音轻柔，音高略高。" },
          audioEvents: [],
        }) } }],
      })
    },
  })

  const result = await provider.understand({ bytes: webmBytes(), mimeType: "audio/webm" })

  assert.equal(request.url, "https://api.siliconflow.cn/v1/chat/completions")
  assert.equal(request.options.headers.Authorization, "Bearer secret-test-key")
  assert.match(request.body.messages[1].content[0].audio_url.url, /^data:audio\/webm;base64,/)
  assert.equal(result.transcript.originalText, "喜欢你呀。")
  assert.deepEqual(result.transcript.confidence, { kind: "model-self-report", value: 0.95 })
  assert.equal(result.affect.label, "happy")
  assert.deepEqual(result.affect.confidence, { kind: "model-self-report", value: 0.9 })
})

test("SiliconFlow provider reports unconfigured without making a cloud request", async () => {
  let called = false
  const provider = testProvider({
    env: {},
    fetchImpl: async () => { called = true },
  })

  await assert.rejects(
    provider.understand({ bytes: webmBytes(), mimeType: "audio/webm" }),
    (error) => error instanceof VoiceInputError && error.reason === "provider-unconfigured",
  )
  assert.equal(called, false)
})

test("SiliconFlow provider degrades malformed affect without discarding a valid transcript", async () => {
  const provider = testProvider({
    env: { SILICONFLOW_API_KEY: "secret-test-key" },
    fetchImpl: async () => jsonResponse(200, {
      choices: [{ message: { content: JSON.stringify({
        transcript: "hello",
        emotion: { label: "happy", confidence: 9, rationale: "bright" },
      }) } }],
    }),
  })

  const result = await provider.understand({ bytes: webmBytes(), mimeType: "audio/webm" })
  assert.equal(result.transcript.originalText, "hello")
  assert.equal(result.affect, null)
  assert.deepEqual(result.affectFailure, { status: "failed", reason: "malformed-provider-output" })
})

test("SiliconFlow provider maps moderation rejection without exposing the response body", async () => {
  const provider = testProvider({
    env: { SILICONFLOW_API_KEY: "secret-test-key" },
    fetchImpl: async () => jsonResponse(400, { error: { message: "sensitive raw provider detail" } }),
  })

  await assert.rejects(
    provider.understand({ bytes: webmBytes(), mimeType: "audio/webm" }),
    (error) => error instanceof VoiceInputError
      && error.reason === "provider-rejected"
      && !error.message.includes("sensitive raw provider detail"),
  )
})

test("SiliconFlow provider cancels a half-open request at its local deadline", async () => {
  const provider = testProvider({
    env: { SILICONFLOW_API_KEY: "secret-test-key" },
    timeoutMs: 10,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
    }),
  })

  await assert.rejects(
    provider.understand({ bytes: webmBytes(), mimeType: "audio/webm" }),
    (error) => error instanceof VoiceInputError && error.reason === "provider-timeout",
  )
})

test("SiliconFlow provider distinguishes caller cancellation from timeout", async () => {
  const controller = new AbortController()
  const provider = testProvider({
    env: { SILICONFLOW_API_KEY: "secret-test-key" },
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
      controller.abort(new Error("client left"))
    }),
  })

  await assert.rejects(
    provider.understand({ bytes: webmBytes(), mimeType: "audio/webm", signal: controller.signal }),
    (error) => error instanceof VoiceInputError && error.reason === "cancelled",
  )
})

test("SiliconFlow provider rejects an oversized streamed response before buffering it all", async () => {
  let cancelled = false
  const chunk = Buffer.alloc(64 * 1024, 0x61)
  const provider = testProvider({
    env: { SILICONFLOW_API_KEY: "secret-test-key" },
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    }), { status: 200 }),
  })

  await assert.rejects(
    provider.understand({ bytes: webmBytes(), mimeType: "audio/webm" }),
    (error) => error instanceof VoiceInputError && error.reason === "malformed-provider-output",
  )
  assert.equal(cancelled, true)
})

test("SiliconFlow provider normalizes Qwen audio event objects without discarding a valid transcript", () => {
  const result = normalizeProviderOutput({
    provider: "siliconflow",
    model: "Qwen/Qwen3-Omni-30B-A3B-Instruct",
    bodyText: JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        transcript: "你好",
        transcriptConfidence: 0.9,
        language: "zh",
        emotion: { label: "happy", confidence: 0.8, rationale: "语气轻快" },
        audioEvents: [{ label: "Sneeze", start: 0, end: 0.21 }],
      }) } }],
    }),
  })

  assert.equal(result.transcript.originalText, "你好")
  assert.deepEqual(result.audioEvents, ["Sneeze"])
})

test("SiliconFlow provider sends the normalized provider input instead of raw browser WebM", async () => {
  let request
  const provider = createSiliconFlowVoiceUnderstandingProvider({
    env: { SILICONFLOW_API_KEY: "secret-test-key" },
    normalizeAudioInput: async ({ bytes, mimeType }) => {
      assert.equal(mimeType, "audio/webm")
      assert.deepEqual(bytes, webmBytes())
      return { bytes: Buffer.from("wav"), mimeType: "audio/wav" }
    },
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body)
      return jsonResponse(200, {
        choices: [{ message: { content: JSON.stringify({ transcript: "你好" }) } }],
      })
    },
  })

  await provider.understand({ bytes: webmBytes(), mimeType: "audio/webm" })
  assert.match(request.messages[1].content[0].audio_url.url, /^data:audio\/wav;base64,d2F2$/)
})

function testProvider(options) {
  return createSiliconFlowVoiceUnderstandingProvider({
    normalizeAudioInput: passthroughAudio,
    ...options,
  })
}

async function passthroughAudio({ bytes, mimeType }) {
  return { bytes, mimeType }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function webmBytes() {
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01])
}
