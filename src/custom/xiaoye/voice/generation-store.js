const fs = require("node:fs/promises")
const path = require("node:path")

function createVoiceGenerationStore({ stateDir } = {}) {
  const root = path.join(path.resolve(requiredText(stateDir, "stateDir")), "MLane", "voice", "generations")

  async function save(record = {}) {
    const generationId = safeId(record.generationId)
    if (!generationId) throw new TypeError("generationId is required")
    const normalized = { ...record, schemaVersion: 1, generationId }
    await fs.mkdir(root, { recursive: true })
    const target = path.join(root, `${generationId}.json`)
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(normalized)}\n`, "utf8")
    try {
      await fs.rename(temporary, target)
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
    return normalized
  }

  async function get(generationId) {
    const safe = safeId(generationId)
    if (!safe) return null
    try {
      const raw = await fs.readFile(path.join(root, `${safe}.json`), "utf8")
      const parsed = JSON.parse(raw)
      return parsed && parsed.schemaVersion === 1 && parsed.generationId === safe ? parsed : null
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null
      throw error
    }
  }

  return { root, get, save }
}

function safeId(value) {
  const normalized = typeof value === "string" ? value.trim() : ""
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized) ? normalized : ""
}

function requiredText(value, label) {
  const normalized = typeof value === "string" ? value.trim() : ""
  if (!normalized) throw new TypeError(`${label} is required`)
  return normalized
}

module.exports = { createVoiceGenerationStore }
