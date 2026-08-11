const { VoiceSynthesisError } = require("./synthesis-errors")
const {
  getVoiceProfileBinding,
  normalizeSpeechDeliveryPlan,
  normalizeVoiceProfile,
} = require("./synthesis-contract")

const DEFAULT_BASE_URL = "https://api.mosi.cn"
const MAX_PROVIDER_BODY_BYTES = 32 * 1024 * 1024
const MIME_BY_FORMAT = { mp3: "audio/mpeg", wav: "audio/wav" }

function createMosslandSynthesisProvider({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Mossland synthesis provider requires fetch")
  const id = "mossland"
  const baseUrl = (text(env.MOSS_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/gu, "")

  function getStatus() {
    const configured = Boolean(text(env.MOSS_API_KEY) && text(env.MOSS_VOICE_ID))
    return { provider: id, model: text(env.MOSS_TTS_MODEL) || "moss-tts", configured, available: configured }
  }

  async function synthesize({ spokenText, voiceProfile, speechDeliveryPlan, signal = null } = {}) {
    const apiKey = text(env.MOSS_API_KEY)
    if (!apiKey) throw synthesisError("provider-unconfigured", "Mossland speech synthesis is not configured", 503)
    const profile = normalizeVoiceProfile(voiceProfile)
    const binding = getVoiceProfileBinding(profile, id)
    normalizeSpeechDeliveryPlan(speechDeliveryPlan)
    const safeSpokenText = requiredSpokenText(spokenText)
    const deadline = createDeadlineSignal({ timeoutMs, signal })
    try {
      const response = await fetchImpl(`${baseUrl}/v1/audio/speech`, {
        method: "POST",
        signal: deadline.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: binding.model,
          ...(binding.version ? { version: binding.version } : {}),
          input: safeSpokenText,
          voice_id: binding.voiceId,
          response_format: binding.audio.format,
          delivery_method: "audio",
        }),
      })
      const bytes = await readBoundedBytes(response)
      if (!response.ok) {
        const reason = response.status >= 400 && response.status < 500 && response.status !== 429
          ? "provider-rejected"
          : "provider-unavailable"
        throw synthesisError(reason, `Mossland synthesis request failed with HTTP ${response.status}`, reason === "provider-rejected" ? 422 : 503)
      }
      const mimeType = MIME_BY_FORMAT[binding.audio.format]
      const contentType = text(response.headers?.get?.("content-type")).split(";", 1)[0].toLowerCase()
      if (!bytes.length || ![mimeType, "application/octet-stream"].includes(contentType) || !hasAudioSignature(bytes, binding.audio.format)) {
        throw malformed("Mossland synthesis returned invalid audio")
      }
      return {
        provider: id,
        model: binding.model,
        spokenText: safeSpokenText,
        bytes,
        mimeType,
        durationMs: null,
      }
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

async function readBoundedBytes(response) {
  const declaredLength = Number(response.headers?.get?.("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_BODY_BYTES) throw oversized()
  const reader = response.body?.getReader?.()
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_PROVIDER_BODY_BYTES) throw oversized()
    return bytes
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
  return Buffer.concat(chunks, total)
}

function hasAudioSignature(bytes, format) {
  if (format === "wav") {
    return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE"
  }
  if (format === "mp3") {
    return bytes.length >= 3 && (bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
  }
  return false
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

function synthesisError(reason, message, statusCode, cause = null) {
  return new VoiceSynthesisError(reason, message, { statusCode, cause })
}

function malformed(message) {
  return synthesisError("malformed-provider-output", message, 502)
}

function oversized() {
  return malformed("Mossland synthesis response is too large")
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = { createMosslandSynthesisProvider }
