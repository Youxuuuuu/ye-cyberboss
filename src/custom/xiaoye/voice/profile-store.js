const fs = require("node:fs/promises")
const path = require("node:path")

const { normalizeVoiceProfile } = require("./synthesis-contract")

function createVoiceProfileStore({ stateDir, initialProfile = null, preferConfiguredProvider = false } = {}) {
  const filePath = path.join(path.resolve(requiredText(stateDir, "stateDir")), "MLane", "voice-profile.json")
  const configuredProfile = initialProfile ? normalizeVoiceProfile(initialProfile) : null

  async function load() {
    try {
      const parsed = normalizeVoiceProfile(JSON.parse(await fs.readFile(filePath, "utf8")))
      if (preferConfiguredProvider && configuredProfile && parsed.defaultProvider !== configuredProfile.defaultProvider) {
        return configuredProfile
      }
      return parsed
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (!configuredProfile) return null
        await save(configuredProfile)
        return configuredProfile
      }
      if (error instanceof SyntaxError) return null
      throw error
    }
  }

  async function loadVersion(version) {
    const profile = await load()
    return profile?.version === version ? profile : null
  }

  async function save(profile) {
    const normalized = normalizeVoiceProfile(profile)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(normalized)}\n`, "utf8")
    try {
      await fs.rename(temporary, filePath)
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
    return normalized
  }

  return { filePath, load, loadVersion, save }
}

function createConfiguredVoiceProfile({ env = process.env, providerId = "", version = "" } = {}) {
  const selectedProvider = text(providerId || env.CYBERBOSS_ASSISTANT_VOICE_PROVIDER || "minimax").toLowerCase()
  if (selectedProvider === "mossland") return createConfiguredMosslandProfile({ env, version })
  if (selectedProvider !== "minimax") throw new TypeError(`Assistant voice provider is not supported: ${selectedProvider}`)
  return createConfiguredMiniMaxProfile({ env, version })
}

function createConfiguredMiniMaxProfile({ env, version }) {
  const voiceId = text(env.MINIMAX_VOICE_ID)
  if (!voiceId) return null
  return normalizeVoiceProfile({
    schemaVersion: 1,
    version: text(version || env.CYBERBOSS_ASSISTANT_VOICE_PROFILE_VERSION) || "voice-profile-v1",
    defaultProvider: "minimax",
    defaultExpression: text(env.CYBERBOSS_ASSISTANT_VOICE_DEFAULT_EXPRESSION || env.MINIMAX_DEFAULT_EXPRESSION) || "warm",
    bindings: {
      minimax: {
        model: text(env.MINIMAX_TTS_MODEL) || "speech-2.8-hd",
        voiceId,
        languageBoost: text(env.MINIMAX_TTS_LANGUAGE) || "Chinese",
        speed: numberSetting(env.MINIMAX_TTS_SPEED, 1),
        volume: numberSetting(env.MINIMAX_TTS_VOLUME, 1),
        pitch: numberSetting(env.MINIMAX_TTS_PITCH, 0),
        audio: {
          format: text(env.MINIMAX_TTS_FORMAT) || "mp3",
          sampleRate: integerSetting(env.MINIMAX_TTS_SAMPLE_RATE, 32000),
          bitrate: integerSetting(env.MINIMAX_TTS_BITRATE, 128000),
          channel: integerSetting(env.MINIMAX_TTS_CHANNEL, 1),
        },
        pronunciationDictionary: [],
      },
    },
  })
}

function createConfiguredMosslandProfile({ env, version }) {
  const voiceId = text(env.MOSS_VOICE_ID)
  if (!voiceId) return null
  return normalizeVoiceProfile({
    schemaVersion: 1,
    version: text(version || env.CYBERBOSS_ASSISTANT_VOICE_PROFILE_VERSION) || "voice-profile-mossland-v1",
    defaultProvider: "mossland",
    defaultExpression: text(env.CYBERBOSS_ASSISTANT_VOICE_DEFAULT_EXPRESSION || env.MOSS_DEFAULT_EXPRESSION) || "warm",
    bindings: {
      mossland: {
        model: text(env.MOSS_TTS_MODEL) || "moss-tts",
        version: text(env.MOSS_TTS_VERSION),
        voiceId,
        audio: { format: text(env.MOSS_TTS_FORMAT) || "mp3" },
      },
    },
  })
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

function numberSetting(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function integerSetting(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) ? number : fallback
}

function requiredText(value, label) {
  const normalized = text(value)
  if (!normalized) throw new TypeError(`${label} is required`)
  return normalized
}

module.exports = { createConfiguredVoiceProfile, createVoiceProfileStore }
