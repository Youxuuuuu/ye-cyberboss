const crypto = require("node:crypto")
const fs = require("node:fs/promises")
const path = require("node:path")

const { VoiceInputError } = require("./errors")

const MAX_DURATION_MS = 60_000
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

function createVoiceAssetStore({
  stateDir,
  maxBytes = DEFAULT_MAX_BYTES,
  maxDurationMs = MAX_DURATION_MS,
  probeAudio,
  now = () => new Date(),
  createId = () => crypto.randomUUID(),
} = {}) {
  const stateRoot = path.resolve(requiredText(stateDir, "stateDir"))
  const voiceRoot = path.join(stateRoot, "MLane", "voice")
  if (typeof probeAudio !== "function") {
    throw new TypeError("voice asset store requires probeAudio")
  }

  async function persistUserVoice({ bytes, contentType = "", signal = null } = {}) {
    const payload = normalizeBytes(bytes)
    if (!payload.length) {
      throw new VoiceInputError("invalid-media", "voice upload is empty")
    }
    if (payload.length > maxBytes) {
      throw new VoiceInputError("too-large", `voice upload exceeds ${maxBytes} bytes`, { statusCode: 413 })
    }

    const detected = detectAudioFormat(payload)
    const declaredMime = normalizeMimeType(contentType)
    if (!detected || (declaredMime && declaredMime !== detected.mimeType)) {
      throw new VoiceInputError("invalid-media", "voice bytes do not match the declared audio type")
    }

    const stored = await writeTimestampedAsset({
      voiceRoot,
      scope: "self",
      extension: detected.extension,
      bytes: payload,
      now: normalizeDate(now()),
      signal,
    })
    const assetId = requiredText(createId(), "assetId")
    let probe
    try {
      probe = await probeAudio({
        absolutePath: stored.absolutePath,
        mimeType: detected.mimeType,
        sizeBytes: payload.length,
        signal,
      })
    } catch (error) {
      throw asInvalidMedia(error)
    }
    const durationMs = Number(probe?.durationMs)
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new VoiceInputError("invalid-media", "voice duration could not be decoded")
    }
    if (durationMs > maxDurationMs) {
      const error = new VoiceInputError("too-long", `voice duration exceeds ${maxDurationMs} ms`, { statusCode: 413 })
      error.asset = {
        assetId,
        relativePath: stored.relativePath,
        mimeType: detected.mimeType,
        sizeBytes: payload.length,
        durationMs: Math.round(durationMs),
      }
      throw error
    }

    return {
      assetId,
      relativePath: stored.relativePath,
      mimeType: detected.mimeType,
      sizeBytes: payload.length,
      durationMs: Math.round(durationMs),
    }
  }

  async function readUserVoiceAsset(asset = {}, { signal = null } = {}) {
    const relativePath = typeof asset.relativePath === "string"
      ? asset.relativePath.trim().replace(/\\/gu, "/")
      : ""
    if (!relativePath.startsWith("self/") || relativePath.includes("..") || path.posix.isAbsolute(relativePath)) {
      throw new VoiceInputError("invalid-media", "voice asset path is invalid")
    }
    const absolutePath = path.resolve(voiceRoot, ...relativePath.split("/"))
    if (absolutePath !== voiceRoot && !absolutePath.startsWith(`${voiceRoot}${path.sep}`)) {
      throw new VoiceInputError("invalid-media", "voice asset path escapes the voice root")
    }
    let bytes
    try {
      bytes = await fs.readFile(absolutePath, signal ? { signal } : undefined)
    } catch (error) {
      if (signal?.aborted) throw typedAbortReason(signal, error)
      throw new VoiceInputError("invalid-media", "voice asset could not be reopened", { cause: error })
    }
    const detected = detectAudioFormat(bytes)
    const expectedMime = normalizeMimeType(asset.mimeType)
    if (!detected || (expectedMime && detected.mimeType !== expectedMime)) {
      throw new VoiceInputError("invalid-media", "stored voice asset no longer matches its media contract")
    }
    return { bytes, mimeType: detected.mimeType, absolutePath, relativePath }
  }

  async function persistGeneratedVoice({ threadId, bytes, contentType = "", signal = null } = {}) {
    const safeThreadId = typeof threadId === "string" ? threadId.trim() : ""
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(safeThreadId)) {
      throw new VoiceInputError("invalid-media", "assistant voice thread id is invalid")
    }
    const payload = normalizeBytes(bytes)
    if (!payload.length) throw new VoiceInputError("invalid-media", "assistant voice audio is empty")
    if (payload.length > maxBytes) {
      throw new VoiceInputError("too-large", `assistant voice audio exceeds ${maxBytes} bytes`, { statusCode: 413 })
    }
    const detected = detectAudioFormat(payload)
    const declaredMime = normalizeMimeType(contentType)
    if (!detected || (declaredMime && declaredMime !== detected.mimeType)) {
      throw new VoiceInputError("invalid-media", "assistant voice bytes do not match the declared audio type")
    }
    const stored = await writeTimestampedAsset({
      voiceRoot,
      scope: `threads/${safeThreadId}`,
      extension: detected.extension,
      bytes: payload,
      now: normalizeDate(now()),
      signal,
    })
    const assetId = requiredText(createId(), "assetId")
    let probe
    try {
      probe = await probeAudio({
        absolutePath: stored.absolutePath,
        mimeType: detected.mimeType,
        sizeBytes: payload.length,
        signal,
      })
    } catch (error) {
      throw asInvalidMedia(error)
    }
    const durationMs = Number(probe?.durationMs)
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new VoiceInputError("invalid-media", "assistant voice duration could not be decoded")
    }
    return {
      assetId,
      relativePath: stored.relativePath,
      mimeType: detected.mimeType,
      sizeBytes: payload.length,
      durationMs: Math.round(durationMs),
    }
  }

  return { voiceRoot, persistGeneratedVoice, persistUserVoice, readUserVoiceAsset }
}

async function writeTimestampedAsset({ voiceRoot, scope, extension, bytes, now, signal }) {
  for (let offset = 0; offset < 10_000; offset += 1) {
    const timestamp = new Date(now.getTime() + offset)
    const parts = shanghaiParts(timestamp)
    const relativePath = [
      scope,
      parts.year,
      parts.month,
      `${parts.year}-${parts.month}-${parts.day}-${parts.hour}-${parts.minute}-${parts.second}-${parts.millisecond}.${extension}`,
    ].join("/")
    const absolutePath = path.join(voiceRoot, ...relativePath.split("/"))
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    try {
      await fs.writeFile(absolutePath, bytes, { flag: "wx", ...(signal ? { signal } : {}) })
      return { absolutePath, relativePath }
    } catch (error) {
      if (signal?.aborted) throw typedAbortReason(signal, error)
      if (error?.code !== "EEXIST") throw error
    }
  }
  throw new VoiceInputError("unknown", "could not allocate a unique voice asset name", { statusCode: 500 })
}

function detectAudioFormat(bytes) {
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") {
    return { mimeType: "audio/wav", extension: "wav" }
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { mimeType: "audio/webm", extension: "webm" }
  }
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "OggS") {
    return { mimeType: "audio/ogg", extension: "ogg" }
  }
  if (bytes.length >= 3 && bytes.toString("ascii", 0, 3) === "ID3") {
    return { mimeType: "audio/mpeg", extension: "mp3" }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return { mimeType: "audio/mpeg", extension: "mp3" }
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") {
    return { mimeType: "audio/mp4", extension: "m4a" }
  }
  return null
}

function normalizeMimeType(value) {
  const normalized = typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : ""
  const aliases = {
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/mp3": "audio/mpeg",
    "video/webm": "audio/webm",
  }
  return aliases[normalized] || normalized
}

function shanghaiParts(date) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]))
  return { ...values, millisecond: String(date.getMilliseconds()).padStart(3, "0") }
}

function normalizeBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.alloc(0)
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError("voice asset store now() must return a valid date")
  return date
}

function asInvalidMedia(error) {
  if (error instanceof VoiceInputError) return error
  return new VoiceInputError("invalid-media", "voice audio could not be decoded", { cause: error })
}

function typedAbortReason(signal, cause) {
  if (signal?.reason instanceof VoiceInputError) return signal.reason
  return new VoiceInputError("cancelled", "voice asset persistence was cancelled", {
    statusCode: 499,
    cause,
  })
}

function requiredText(value, label) {
  const normalized = typeof value === "string" ? value.trim() : ""
  if (!normalized) throw new TypeError(`voice asset store requires ${label}`)
  return normalized
}

module.exports = { createVoiceAssetStore, VoiceInputError, detectAudioFormat, normalizeMimeType }
