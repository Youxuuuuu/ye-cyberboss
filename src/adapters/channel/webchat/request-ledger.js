const fs = require("fs")
const path = require("path")

class WebChatRequestLedger {
  constructor({ filePath = "", maxEntries = 1000, logger = console } = {}) {
    this.filePath = normalizeText(filePath) ? path.resolve(filePath) : ""
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 1000))
    this.logger = logger
    this.entries = new Map()
    this.pending = new Map()
    this.hydrate()
  }

  execute({ requestId = "", fingerprint = "", run } = {}) {
    const stableRequestId = requiredText(requestId, "requestId")
    const stableFingerprint = requiredText(fingerprint, "fingerprint")
    if (typeof run !== "function") throw new Error("web chat request ledger requires run")

    const existing = this.entries.get(stableRequestId)
    if (existing && existing.fingerprint !== stableFingerprint) {
      const error = new Error("requestId was already used with a different payload")
      error.statusCode = 409
      return Promise.reject(error)
    }

    const pending = this.pending.get(stableRequestId)
    if (pending) {
      return pending.then((result) => ({ ...result, deduplicated: true }))
    }
    if (existing?.status === "accepted") {
      return Promise.resolve({ ...existing.result, deduplicated: true })
    }
    if (existing?.status === "unknown" || existing?.status === "submitting") {
      return Promise.resolve({
        accepted: false,
        status: "unknown",
        requestId: stableRequestId,
        deduplicated: true,
      })
    }

    this.entries.set(stableRequestId, {
      requestId: stableRequestId,
      fingerprint: stableFingerprint,
      status: "submitting",
      updatedAt: new Date().toISOString(),
    })
    this.persist()

    let runResult
    try {
      runResult = run()
    } catch (error) {
      this.markUnknown(stableRequestId, stableFingerprint)
      return Promise.reject(error)
    }
    const execution = Promise.resolve(runResult)
      .then((result) => {
        const normalizedResult = {
          ...(result && typeof result === "object" ? result : {}),
          requestId: stableRequestId,
          status: result?.accepted ? "accepted" : (result?.status || "failed"),
          deduplicated: false,
        }
        if (result?.accepted) {
          this.entries.set(stableRequestId, {
            requestId: stableRequestId,
            fingerprint: stableFingerprint,
            status: "accepted",
            result: normalizedResult,
            updatedAt: new Date().toISOString(),
          })
        } else {
          this.entries.delete(stableRequestId)
        }
        this.persist()
        return normalizedResult
      })
      .catch((error) => {
        this.markUnknown(stableRequestId, stableFingerprint)
        throw error
      })
      .finally(() => {
        this.pending.delete(stableRequestId)
      })
    this.pending.set(stableRequestId, execution)
    return execution
  }

  get(requestId = "") {
    const entry = this.entries.get(normalizeText(requestId))
    if (!entry) return null
    return {
      requestId: entry.requestId,
      status: entry.status === "submitting" ? "unknown" : entry.status,
      ...(entry.result ? { result: entry.result } : {}),
    }
  }

  markUnknown(requestId, fingerprint) {
    this.entries.set(requestId, {
      requestId,
      fingerprint,
      status: "unknown",
      updatedAt: new Date().toISOString(),
    })
    this.persist()
  }

  hydrate() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"))
      for (const entry of Array.isArray(parsed?.entries) ? parsed.entries : []) {
        const requestId = normalizeText(entry?.requestId)
        const fingerprint = normalizeText(entry?.fingerprint)
        if (!requestId || !fingerprint) continue
        this.entries.set(requestId, {
          ...entry,
          requestId,
          fingerprint,
          status: entry.status === "submitting" ? "unknown" : entry.status,
        })
      }
      this.prune()
    } catch (error) {
      this.logger?.warn?.(`[webchat] could not load request ledger: ${error.message}`)
    }
  }

  prune() {
    if (this.entries.size <= this.maxEntries) return
    const removeCount = this.entries.size - this.maxEntries
    const oldest = [...this.entries.values()]
      .sort((left, right) => Date.parse(left.updatedAt || "") - Date.parse(right.updatedAt || ""))
      .slice(0, removeCount)
    oldest.forEach((entry) => this.entries.delete(entry.requestId))
  }

  persist() {
    if (!this.filePath) return
    this.prune()
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    const body = JSON.stringify({ version: 1, entries: [...this.entries.values()] }, null, 2) + "\n"
    try {
      fs.writeFileSync(tempPath, body, "utf8")
      fs.renameSync(tempPath, this.filePath)
    } finally {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
    }
  }
}

function requiredText(value, label) {
  const normalized = normalizeText(value)
  if (!normalized) throw new Error(`web chat request ledger requires ${label}`)
  return normalized
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = { WebChatRequestLedger }
