const { VoiceInputError } = require("./errors")

const OUTPUT_SAMPLE_RATE = 16_000
const OUTPUT_CHANNELS = 1
const OUTPUT_BITS_PER_SAMPLE = 16
const DEFAULT_MAX_DURATION_MS = 60_000

function createSiliconFlowAudioInputNormalizer({
  decode = decodeAudio,
  outputSampleRate = OUTPUT_SAMPLE_RATE,
  maxDurationMs = DEFAULT_MAX_DURATION_MS,
} = {}) {
  if (typeof decode !== "function") throw new TypeError("SiliconFlow audio input normalizer requires decode")
  const sampleRate = positiveInteger(outputSampleRate, OUTPUT_SAMPLE_RATE)
  const maxOutputBytes = Math.ceil(maxDurationMs / 1_000 * sampleRate) * OUTPUT_CHANNELS * (OUTPUT_BITS_PER_SAMPLE / 8) + 44

  async function normalize({ bytes, mimeType = "", signal = null } = {}) {
    const payload = normalizeBytes(bytes)
    if (!payload.length) throw new VoiceInputError("invalid-media", "voice provider input is empty")
    const inputMimeType = normalizeMimeType(mimeType)
    if (!inputMimeType.startsWith("audio/")) {
      throw new VoiceInputError("unsupported-media", "voice provider requires an audio MIME type")
    }
    if (inputMimeType !== "audio/webm") return { bytes: payload, mimeType: inputMimeType }

    throwIfAborted(signal)
    let decoded
    try {
      decoded = await decode(payload)
    } catch (error) {
      throwIfAborted(signal)
      if (error instanceof VoiceInputError) throw error
      throw new VoiceInputError("unsupported-media", "voice provider could not decode this audio format", {
        statusCode: 422,
        cause: error,
      })
    }
    throwIfAborted(signal)
    return {
      bytes: encodeMonoWav(decoded, { sampleRate, maxOutputBytes }),
      mimeType: "audio/wav",
    }
  }

  return { normalize }
}

async function decodeAudio(bytes) {
  const module = await import("@audio/decode-webm")
  const decode = module.default || module.decode || module
  if (typeof decode !== "function") throw new TypeError("WebM audio decoder does not export a decoder")
  return decode(bytes)
}

function encodeMonoWav(decoded, { sampleRate, maxOutputBytes }) {
  const sourceSampleRate = positiveInteger(decoded?.sampleRate, 0)
  const channels = Array.isArray(decoded?.channelData)
    ? decoded.channelData.filter((channel) => channel instanceof Float32Array)
    : []
  const frameCount = channels.length ? Math.min(...channels.map((channel) => channel.length)) : 0
  if (!sourceSampleRate || !frameCount) {
    throw new VoiceInputError("unsupported-media", "decoded voice audio has no PCM samples", { statusCode: 422 })
  }

  const outputFrameCount = Math.ceil(frameCount * sampleRate / sourceSampleRate)
  const outputByteLength = 44 + outputFrameCount * 2
  if (!Number.isSafeInteger(outputByteLength) || outputByteLength > maxOutputBytes) {
    throw new VoiceInputError("too-long", "voice audio exceeds the supported transcription duration", { statusCode: 413 })
  }

  const wav = Buffer.alloc(outputByteLength)
  writeWavHeader(wav, { sampleRate, frameCount: outputFrameCount })
  for (let index = 0; index < outputFrameCount; index += 1) {
    const sourcePosition = (index + 0.5) * sourceSampleRate / sampleRate - 0.5
    const lowerIndex = clamp(Math.floor(sourcePosition), 0, frameCount - 1)
    const upperIndex = clamp(lowerIndex + 1, 0, frameCount - 1)
    const fraction = clamp(sourcePosition - Math.floor(sourcePosition), 0, 1)
    let sample = 0
    for (const channel of channels) {
      const lower = Number.isFinite(channel[lowerIndex]) ? channel[lowerIndex] : 0
      const upper = Number.isFinite(channel[upperIndex]) ? channel[upperIndex] : lower
      sample += lower + (upper - lower) * fraction
    }
    const pcm = Math.round(clamp(sample / channels.length, -1, 1) * (sample < 0 ? 32_768 : 32_767))
    wav.writeInt16LE(pcm, 44 + index * 2)
  }
  return wav
}

function writeWavHeader(bytes, { sampleRate, frameCount }) {
  const dataBytes = frameCount * 2
  bytes.write("RIFF", 0, "ascii")
  bytes.writeUInt32LE(36 + dataBytes, 4)
  bytes.write("WAVE", 8, "ascii")
  bytes.write("fmt ", 12, "ascii")
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(OUTPUT_CHANNELS, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(OUTPUT_BITS_PER_SAMPLE, 34)
  bytes.write("data", 36, "ascii")
  bytes.writeUInt32LE(dataBytes, 40)
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  if (signal.reason instanceof VoiceInputError) throw signal.reason
  throw new VoiceInputError("cancelled", "voice audio normalization was cancelled", { statusCode: 499 })
}

function normalizeBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.alloc(0)
}

function normalizeMimeType(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : ""
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum)
}

module.exports = { createSiliconFlowAudioInputNormalizer, encodeMonoWav }
