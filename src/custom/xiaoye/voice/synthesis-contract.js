const crypto = require("node:crypto")

const MINIMAX_MODELS = new Set([
  "speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd", "speech-2.6-turbo",
  "speech-02-hd", "speech-02-turbo", "speech-01-hd", "speech-01-turbo",
])
const AUDIO_FORMATS = new Set(["mp3", "wav", "flac"])
const MOSS_AUDIO_FORMATS = new Set(["mp3", "wav"])
const VOICE_PROVIDERS = new Set(["minimax", "mossland"])
const SOUND_TAGS = new Set([
  "laughs", "chuckle", "coughs", "clear-throat", "groans", "breath", "pant",
  "inhale", "exhale", "gasps", "sniffs", "sighs", "snorts", "burps",
  "lip-smacking", "humming", "hissing", "emm", "sneezes",
])

function normalizeVoiceProfile(value) {
  const profile = plainObject(value, "voiceProfile")
  if (profile.schemaVersion !== 1) throw new TypeError("voiceProfile.schemaVersion must be 1")
  const defaultProvider = requiredToken(profile.defaultProvider, "voiceProfile.defaultProvider")
  if (!VOICE_PROVIDERS.has(defaultProvider)) throw new TypeError("voiceProfile.defaultProvider is not supported")
  const bindings = plainObject(profile.bindings, "voiceProfile.bindings")
  const normalizedBindings = {}
  if (bindings.minimax != null) normalizedBindings.minimax = normalizeMiniMaxBinding(bindings.minimax)
  if (bindings.mossland != null) normalizedBindings.mossland = normalizeMosslandBinding(bindings.mossland)
  if (!normalizedBindings[defaultProvider]) throw new TypeError("voiceProfile default provider binding is required")
  const normalized = {
    schemaVersion: 1,
    version: requiredToken(profile.version, "voiceProfile.version"),
    defaultProvider,
    defaultExpression: optionalText(profile.defaultExpression, 100, "voiceProfile.defaultExpression"),
    bindings: normalizedBindings,
  }
  return deepFreeze(normalized)
}

function getVoiceProfileBinding(value, providerId) {
  const profile = normalizeVoiceProfile(value)
  const id = requiredToken(providerId, "synthesis.provider")
  const binding = profile.bindings[id]
  if (!binding) throw new TypeError(`voiceProfile binding for ${id} is required`)
  return binding
}

function normalizeSpeechDeliveryPlan(value) {
  const plan = plainObject(value, "speechDeliveryPlan")
  if (plan.schemaVersion !== 1) throw new TypeError("speechDeliveryPlan.schemaVersion must be 1")
  const normalized = {
    schemaVersion: 1,
    version: requiredToken(plan.version, "speechDeliveryPlan.version"),
    emotion: optionalText(plan.emotion, 64, "speechDeliveryPlan.emotion"),
    speedOffset: numberInRange(plan.speedOffset ?? 0, -0.5, 0.5, "speechDeliveryPlan.speedOffset"),
    volumeOffset: numberInRange(plan.volumeOffset ?? 0, -2, 2, "speechDeliveryPlan.volumeOffset"),
    pitchOffset: numberInRange(plan.pitchOffset ?? 0, -6, 6, "speechDeliveryPlan.pitchOffset"),
    pauses: normalizePositionedItems(plan.pauses, "pause", (item) => ({
      afterCharacter: nonNegativeInteger(item.afterCharacter, "speechDeliveryPlan.pauses[].afterCharacter"),
      durationSeconds: numberInRange(item.durationSeconds, 0.01, 10, "speechDeliveryPlan.pauses[].durationSeconds"),
    })),
    soundTags: normalizePositionedItems(plan.soundTags, "sound tag", (item) => {
      const tag = requiredToken(item.tag, "speechDeliveryPlan.soundTags[].tag")
      if (!SOUND_TAGS.has(tag)) throw new TypeError("speechDeliveryPlan sound tag is not supported")
      return {
        afterCharacter: nonNegativeInteger(item.afterCharacter, "speechDeliveryPlan.soundTags[].afterCharacter"),
        tag,
      }
    }),
  }
  return deepFreeze(normalized)
}

function createSynthesisMetadata({
  provider,
  model,
  generationId,
  spokenText,
  voiceProfile,
  speechDeliveryPlan,
} = {}) {
  const profile = normalizeVoiceProfile(voiceProfile)
  const plan = normalizeSpeechDeliveryPlan(speechDeliveryPlan)
  return {
    provider: requiredToken(provider, "synthesis.provider"),
    model: requiredText(model, 100, "synthesis.model"),
    generationId: requiredToken(generationId, "synthesis.generationId"),
    sourceTextHash: sourceTextHash(spokenText),
    voiceProfileVersion: profile.version,
    speechDeliveryPlanVersion: plan.version,
  }
}

function sourceTextHash(value) {
  const text = requiredText(value, 10_000, "spokenText")
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`
}

function applySpeechDeliveryPlan(spokenText, deliveryPlan, { soundTags = true } = {}) {
  const text = requiredText(spokenText, 10_000, "spokenText")
  const plan = normalizeSpeechDeliveryPlan(deliveryPlan)
  const characters = Array.from(text)
  const insertions = new Map()
  const append = (position, token, order) => {
    if (position > characters.length) throw new TypeError("speechDeliveryPlan insertion exceeds spoken text")
    const list = insertions.get(position) || []
    list.push({ token, order })
    insertions.set(position, list)
  }
  if (soundTags) {
    for (const item of plan.soundTags) append(item.afterCharacter, `(${item.tag})`, 0)
  }
  for (const item of plan.pauses) append(item.afterCharacter, `<#${formatDecimal(item.durationSeconds)}#>`, 1)
  let output = ""
  for (let index = 0; index <= characters.length; index += 1) {
    const tokens = insertions.get(index)
    if (tokens) output += tokens.sort((a, b) => a.order - b.order).map((item) => item.token).join("")
    if (index < characters.length) output += characters[index]
  }
  return output
}

function normalizeMiniMaxBinding(value) {
  const minimax = plainObject(value, "voiceProfile.bindings.minimax")
  const model = requiredText(minimax.model, 100, "voiceProfile.bindings.minimax.model")
  if (!MINIMAX_MODELS.has(model)) throw new TypeError("voiceProfile.bindings.minimax.model is not supported")
  return {
    model,
    voiceId: requiredText(minimax.voiceId, 256, "voiceProfile.bindings.minimax.voiceId"),
    languageBoost: requiredText(minimax.languageBoost || "auto", 64, "voiceProfile.bindings.minimax.languageBoost"),
    speed: numberInRange(minimax.speed, 0.5, 2, "voiceProfile.bindings.minimax.speed"),
    volume: numberInRange(minimax.volume, 0, 10, "voiceProfile.bindings.minimax.volume"),
    pitch: numberInRange(minimax.pitch, -12, 12, "voiceProfile.bindings.minimax.pitch"),
    audio: normalizeMiniMaxAudioSettings(minimax.audio),
    pronunciationDictionary: normalizePronunciationDictionary(minimax.pronunciationDictionary),
  }
}

function normalizeMosslandBinding(value) {
  const mossland = plainObject(value, "voiceProfile.bindings.mossland")
  const model = requiredText(mossland.model, 100, "voiceProfile.bindings.mossland.model")
  if (model !== "moss-tts") throw new TypeError("voiceProfile.bindings.mossland.model is not supported")
  const audio = plainObject(mossland.audio, "voiceProfile.bindings.mossland.audio")
  const format = requiredToken(audio.format, "voiceProfile.bindings.mossland.audio.format")
  if (!MOSS_AUDIO_FORMATS.has(format)) throw new TypeError("voiceProfile.bindings.mossland.audio.format is not supported")
  return {
    model,
    version: optionalText(mossland.version, 100, "voiceProfile.bindings.mossland.version"),
    voiceId: requiredText(mossland.voiceId, 256, "voiceProfile.bindings.mossland.voiceId"),
    audio: { format },
  }
}

function normalizeMiniMaxAudioSettings(value) {
  const audio = plainObject(value, "voiceProfile.bindings.minimax.audio")
  const format = requiredToken(audio.format, "voiceProfile.bindings.minimax.audio.format")
  if (!AUDIO_FORMATS.has(format)) throw new TypeError("voiceProfile.bindings.minimax.audio.format is not supported")
  return {
    format,
    sampleRate: integerInSet(audio.sampleRate, new Set([8000, 16000, 22050, 24000, 32000, 44100]), "audio.sampleRate"),
    bitrate: integerInSet(audio.bitrate, new Set([32000, 64000, 128000, 256000]), "audio.bitrate"),
    channel: integerInSet(audio.channel, new Set([1, 2]), "audio.channel"),
  }
}

function normalizePronunciationDictionary(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 100) throw new TypeError("voiceProfile pronunciationDictionary is invalid")
  return value.map((item) => requiredText(item, 200, "voiceProfile pronunciationDictionary[]"))
}

function normalizePositionedItems(value, label, normalize) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 64) throw new TypeError(`speechDeliveryPlan ${label}s are invalid`)
  return value.map((item) => normalize(plainObject(item, `speechDeliveryPlan ${label}`)))
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value
}

function requiredToken(value, label) {
  const text = requiredText(value, 256, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text)) throw new TypeError(`${label} must be a safe token`)
  return text
}

function optionalText(value, maxLength, label) {
  if (value == null || value === "") return ""
  return requiredText(value, maxLength, label)
}

function requiredText(value, maxLength, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`)
  const text = value.trim()
  if (!text || text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new TypeError(`${label} is invalid`)
  }
  return text
}

function numberInRange(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be from ${minimum} to ${maximum}`)
  }
  return value
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`)
  return value
}

function integerInSet(value, allowed, label) {
  if (!Number.isInteger(value) || !allowed.has(value)) throw new TypeError(`${label} is not supported`)
  return value
}

function formatDecimal(value) {
  return Number(value.toFixed(2)).toString()
}

function deepFreeze(value) {
  Object.values(value).forEach((child) => {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child)
  })
  return Object.freeze(value)
}

module.exports = {
  SOUND_TAGS,
  applySpeechDeliveryPlan,
  createSynthesisMetadata,
  getVoiceProfileBinding,
  normalizeSpeechDeliveryPlan,
  normalizeVoiceProfile,
  sourceTextHash,
}
