class VoiceInputError extends Error {
  constructor(reason, message, { statusCode = 400, cause = null } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = "VoiceInputError"
    this.code = `VOICE_${String(reason || "unknown").replace(/-/g, "_").toUpperCase()}`
    this.reason = reason || "unknown"
    this.statusCode = statusCode
  }
}

module.exports = { VoiceInputError }
