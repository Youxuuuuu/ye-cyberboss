class VoiceSynthesisError extends Error {
  constructor(reason, message, { statusCode = 400, cause = null } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = "VoiceSynthesisError"
    this.code = `VOICE_SYNTHESIS_${String(reason || "unknown").replace(/-/gu, "_").toUpperCase()}`
    this.reason = reason || "unknown"
    this.statusCode = statusCode
  }
}

module.exports = { VoiceSynthesisError }
