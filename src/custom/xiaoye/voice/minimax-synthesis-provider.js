const { VoiceSynthesisError } = require("./synthesis-errors")
const {
  applySpeechDeliveryPlan,
  normalizeSpeechDeliveryPlan,
  normalizeVoiceProfile,
} = require("./synthesis-contract")

const DEFAULT_BASE_URL = "https://api.minimax.io"
const MAX_PROVIDER_BODY_BYTES = 32 * 1024 * 1024
const MIME_BY_FORMAT = { mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac" }
const MINIMAX_EMOTION_BY_EXPRESSION = Object.freeze({
  gentle: "calm",
  warm: "calm",
  calm: "calm",
  happy: "happy",
  sad: "sad",
  angry: "angry",
  fearful: "fearful",
  disgusted: "disgusted",
  surprised: "surprised",
  fluent: "fluent",
})

function createMiniMaxSynthesisProvider({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("MiniMax synthesis provider requires fetch")
  const id = "minimax"
  const baseUrl = (text(env.MINIMAX_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/gu, "")

  function getStatus() {
    const configured = Boolean(text(env.MINIMAX_API_KEY))
    return { provider: id, configured, available: configured }
  }

  async function synthesize({ spokenText, voiceProfile, speechDeliveryPlan, signal = null } = {}) {
    const apiKey = text(env.MINIMAX_API_KEY)
    if (!apiKey) throw synthesisError("provider-unconfigured", "MiniMax speech synthesis is not configured", 503)
    const profile = normalizeVoiceProfile(voiceProfile)
    const plan = normalizeSpeechDeliveryPlan(speechDeliveryPlan)
    const binding = profile.bindings.minimax
    const safeSpokenText = requiredSpokenText(spokenText)
    const providerText = applySpeechDeliveryPlan(safeSpokenText, plan, {
      soundTags: /^speech-2\.8-/u.test(binding.model),
    })
    const emotion = mapMiniMaxEmotion(plan.emotion || profile.defaultExpression)
    const deadline = createDeadlineSignal({ timeoutMs, signal })
    try {
      const response = await fetchImpl(`${baseUrl}/v1/t2a_v2`, {
        method: "POST",
        signal: deadline.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: binding.model,
          text: providerText,
          stream: false,
          language_boost: binding.languageBoost,
          output_format: "hex",
          voice_setting: {
            voice_id: binding.voiceId,
            speed: offset(binding.speed, plan.speedOffset, 0.5, 2),
            vol: offset(binding.volume, plan.volumeOffset, 0, 10),
            pitch: offset(binding.pitch, plan.pitchOffset, -12, 12),
            ...(emotion ? { emotion } : {}),
          },
          pronunciation_dict: { tone: binding.pronunciationDictionary },
          audio_setting: {
            sample_rate: binding.audio.sampleRate,
            bitrate: binding.audio.bitrate,
            format: binding.audio.format,
            channel: binding.audio.channel,
          },
        }),
      })
      const bodyText = await readBoundedBody(response)
      if (!response.ok) {
        const reason = response.status >= 400 && response.status < 500 && response.status !== 429
          ? "provider-rejected"
          : "provider-unavailable"
        throw synthesisError(reason, `MiniMax synthesis request failed with HTTP ${response.status}`, reason === "provider-rejected" ? 422 : 503)
      }
      return normalizeResponse({ bodyText, spokenText: safeSpokenText, binding })
    } catch (error) {
      if (error instanceof VoiceSynthesisError) throw error
      if (signal?.aborted) throw synthesisError("cancelled", "speech synthesis was cancelled", 499, error)
      if (deadline.signal.aborted) throw synthesisError("provider-timeout", "speech synthesis timed out", 504, error)
      throw synthesisError("provider-unavailable", "speech synthesis provider is unavailable", 503, error)
    } finally {
      deadline.dispose()
    }
  }

  return { id, getStatus, synthesize }
}

function normalizeResponse({ bodyText, spokenText, binding }) {
  let envelope
  try {
    envelope = JSON.parse(bodyText)
  } catch {
    throw malformed("MiniMax synthesis returned non-JSON output")
  }
  if (!envelope?.base_resp || envelope.base_resp.status_code !== 0) {
    throw synthesisError("provider-rejected", "MiniMax synthesis rejected the request", 422)
  }
  const audioHex = envelope?.data?.audio
  if (typeof audioHex !== "string" || !audioHex || audioHex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(audioHex)) {
    throw malformed("MiniMax synthesis returned invalid audio")
  }
  const bytes = Buffer.from(audioHex, "hex")
  const durationMs = Number(envelope?.extra_info?.audio_length)
  const format = text(envelope?.extra_info?.audio_format).toLowerCase()
  if (!bytes.length || !Number.isFinite(durationMs) || durationMs <= 0 || format !== binding.audio.format) {
    throw malformed("MiniMax synthesis returned inconsistent audio metadata")
  }
  const declaredSize = Number(envelope?.extra_info?.audio_size)
  if (Number.isFinite(declaredSize) && declaredSize !== bytes.length) {
    throw malformed("MiniMax synthesis returned an inconsistent audio size")
  }
  return {
    provider: "minimax",
    model: binding.model,
    spokenText,
    bytes,
    mimeType: MIME_BY_FORMAT[format],
    durationMs: Math.round(durationMs),
  }
}

async function readBoundedBody(response) {
  const declaredLength = Number(response.headers?.get?.("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_BODY_BYTES) throw oversized()
  const reader = response.body?.getReader?.()
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_PROVIDER_BODY_BYTES) throw oversized()
    return bytes.toString("utf8")
  }
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > MAX_PROVIDER_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      throw oversized()
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total).toString("utf8")
}

function createDeadlineSignal({ timeoutMs, signal }) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener?.("abort", onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const timer = setTimeout(() => controller.abort(new Error("provider timeout")), positiveInteger(timeoutMs, 120_000))
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener?.("abort", onAbort)
    },
  }
}

function requiredSpokenText(value) {
  if (typeof value !== "string") throw new TypeError("spokenText must be a string")
  const normalized = value.trim()
  if (!normalized || normalized.length >= 10_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError("spokenText is invalid")
  }
  return normalized
}

function offset(base, change, minimum, maximum) {
  return Number(Math.min(maximum, Math.max(minimum, base + change)).toFixed(2))
}

function mapMiniMaxEmotion(value) {
  return MINIMAX_EMOTION_BY_EXPRESSION[text(value).toLowerCase()] || ""
}

function synthesisError(reason, message, statusCode, cause = null) {
  return new VoiceSynthesisError(reason, message, { statusCode, cause })
}

function malformed(message) {
  return synthesisError("malformed-provider-output", message, 502)
}

function oversized() {
  return malformed("MiniMax synthesis response is too large")
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = { createMiniMaxSynthesisProvider }
