const fs = require("fs")
const path = require("path")

class RealtimeTailer {
  constructor({ checkpointFile = "", bootstrapToEnd = false, logger = console } = {}) {
    this.checkpointFile = normalizeSourceFile(checkpointFile)
    this.bootstrapToEnd = Boolean(bootstrapToEnd)
    this.logger = logger
    this.stateByFile = new Map()
    this.resetFiles = new Set()
    this.restoredFiles = new Set()
    this.pendingStates = new Map()
    this.loadCheckpoints()
  }

  readAvailableLines(sourceFile = "") {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    if (!normalizedSourceFile || !fs.existsSync(normalizedSourceFile)) {
      return []
    }

    const stat = fs.statSync(normalizedSourceFile)
    let state = this.stateByFile.get(normalizedSourceFile)
    if (!state) {
      if (this.bootstrapToEnd) {
        state = readStateAtEnd(normalizedSourceFile)
        this.rememberStateChange(normalizedSourceFile, null)
      } else {
        state = createEmptyState()
        this.rememberStateChange(normalizedSourceFile, null)
      }
      this.stateByFile.set(normalizedSourceFile, state)
    }

    if (stat.size < state.offset) {
      this.rememberStateChange(normalizedSourceFile, state)
      state = createEmptyState()
      this.stateByFile.set(normalizedSourceFile, state)
      this.restoredFiles.delete(normalizedSourceFile)
      this.resetFiles.add(normalizedSourceFile)
    }

    if (stat.size === state.offset) {
      return []
    }

    const previousState = cloneState(state)
    const handle = fs.openSync(normalizedSourceFile, "r")
    try {
      const length = stat.size - state.offset
      const buffer = Buffer.alloc(length)
      fs.readSync(handle, buffer, 0, length, state.offset)
      const chunk = `${state.remainder}${buffer.toString("utf8")}`
      const parts = chunk.split(/\r?\n/u)
      state.remainder = parts.pop() || ""
      state.offset = stat.size

      const lines = []
      for (const part of parts) {
        const trimmed = part.trim()
        if (!trimmed) {
          continue
        }
        state.sourceLine += 1
        lines.push({
          sourceFile: normalizedSourceFile,
          sourceLine: state.sourceLine,
          rawLine: trimmed,
        })
      }

      this.rememberStateChange(normalizedSourceFile, previousState)
      return lines
    } finally {
      fs.closeSync(handle)
    }
  }

  bootstrapSource(sourceFile = "") {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    if (!normalizedSourceFile || !this.bootstrapToEnd || this.stateByFile.has(normalizedSourceFile)) {
      return false
    }
    if (!fs.existsSync(normalizedSourceFile)) {
      return false
    }
    this.stateByFile.set(normalizedSourceFile, readStateAtEnd(normalizedSourceFile))
    this.rememberStateChange(normalizedSourceFile, null)
    return true
  }

  shouldBootstrap(sourceFile = "") {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    return Boolean(
      normalizedSourceFile
      && this.bootstrapToEnd
      && !this.stateByFile.has(normalizedSourceFile)
    )
  }

  hasState(sourceFile = "") {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    return Boolean(normalizedSourceFile && this.stateByFile.has(normalizedSourceFile))
  }

  isRestored(sourceFile = "") {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    return Boolean(normalizedSourceFile && this.restoredFiles.has(normalizedSourceFile))
  }

  isTruncated(sourceFile = "") {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    const state = normalizedSourceFile ? this.stateByFile.get(normalizedSourceFile) : null
    if (!state || !fs.existsSync(normalizedSourceFile)) {
      return false
    }
    return fs.statSync(normalizedSourceFile).size < state.offset
  }

  getSourceLine(sourceFile = "") {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    return normalizedSourceFile ? this.stateByFile.get(normalizedSourceFile)?.sourceLine || 0 : 0
  }

  findSourceLineForRaw(sourceFile = "", raw = null) {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    const state = normalizedSourceFile ? this.stateByFile.get(normalizedSourceFile) : null
    if (!normalizedSourceFile || !state || !raw || typeof raw !== "object") {
      return { found: false, sourceLine: (state?.sourceLine || 0) + 1 }
    }
    if (!fs.existsSync(normalizedSourceFile)) {
      return { found: false, sourceLine: state.sourceLine + 1 }
    }

    const rawText = JSON.stringify(raw)
    const contents = fs.readFileSync(normalizedSourceFile, "utf8")
    const parts = contents.split(/\r?\n/u)
    let sourceLine = 0
    for (const part of parts) {
      const trimmed = part.trim()
      if (!trimmed) {
        continue
      }
      sourceLine += 1
      if (trimmed === rawText) {
        return { found: true, sourceLine }
      }
      try {
        if (sameRawIdentity(JSON.parse(trimmed), raw)) {
          return { found: true, sourceLine }
        }
      } catch {
        // The normal tail path reports malformed lines separately.
      }
    }
    return { found: false, sourceLine: state.sourceLine + 1 }
  }

  readHistoricalLines(sourceFile = "") {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    const state = normalizedSourceFile ? this.stateByFile.get(normalizedSourceFile) : null
    if (!normalizedSourceFile || !state || state.offset <= 0 || !fs.existsSync(normalizedSourceFile)) {
      return []
    }

    const stat = fs.statSync(normalizedSourceFile)
    const length = Math.min(state.offset, stat.size)
    if (length <= 0) {
      return []
    }

    const handle = fs.openSync(normalizedSourceFile, "r")
    try {
      const buffer = Buffer.alloc(length)
      fs.readSync(handle, buffer, 0, length, 0)
      const parts = buffer.toString("utf8").split(/\r?\n/u)
      parts.pop()

      const lines = []
      let sourceLine = 0
      for (const part of parts) {
        const trimmed = part.trim()
        if (!trimmed) {
          continue
        }
        sourceLine += 1
        lines.push({
          sourceFile: normalizedSourceFile,
          sourceLine,
          rawLine: trimmed,
        })
      }
      return lines
    } finally {
      fs.closeSync(handle)
    }
  }

  commit() {
    if (!this.pendingStates.size) {
      return
    }
    const committedFiles = [...this.pendingStates.keys()]
    this.persistCheckpoints()
    this.pendingStates.clear()
    for (const sourceFile of committedFiles) {
      this.restoredFiles.delete(sourceFile)
    }
  }

  rollback() {
    for (const [sourceFile, pending] of this.pendingStates.entries()) {
      if (pending.previous) {
        this.stateByFile.set(sourceFile, cloneState(pending.previous))
      } else {
        this.stateByFile.delete(sourceFile)
      }
    }
    this.pendingStates.clear()
    this.resetFiles.clear()
  }

  clear() {
    this.stateByFile.clear()
    this.resetFiles.clear()
    this.restoredFiles.clear()
    this.pendingStates.clear()
  }

  consumeReset(sourceFile = "") {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    if (!normalizedSourceFile || !this.resetFiles.has(normalizedSourceFile)) {
      return false
    }
    this.resetFiles.delete(normalizedSourceFile)
    return true
  }

  forget(sourceFile = "") {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    if (!normalizedSourceFile) {
      return
    }
    this.stateByFile.delete(normalizedSourceFile)
    this.restoredFiles.delete(normalizedSourceFile)
    this.resetFiles.delete(normalizedSourceFile)
    this.pendingStates.delete(normalizedSourceFile)
  }

  rememberStateChange(sourceFile, previousState) {
    if (!this.pendingStates.has(sourceFile)) {
      this.pendingStates.set(sourceFile, {
        previous: previousState ? cloneState(previousState) : null,
      })
    }
  }

  loadCheckpoints() {
    if (!this.checkpointFile || !fs.existsSync(this.checkpointFile)) {
      return
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.checkpointFile, "utf8"))
      const files = parsed && typeof parsed.files === "object" ? parsed.files : {}
      for (const [sourceFile, value] of Object.entries(files)) {
        const normalizedSourceFile = normalizeSourceFile(sourceFile)
        const state = normalizeState(value)
        if (!normalizedSourceFile || !state) {
          continue
        }
        this.stateByFile.set(normalizedSourceFile, state)
        this.restoredFiles.add(normalizedSourceFile)
      }
    } catch (error) {
      this.logger?.warn?.(`[conversation] could not load realtime checkpoints: ${formatErrorMessage(error)}`)
    }
  }

  persistCheckpoints() {
    if (!this.checkpointFile) {
      return
    }
    fs.mkdirSync(path.dirname(this.checkpointFile), { recursive: true })
    const files = {}
    for (const [sourceFile, state] of this.stateByFile.entries()) {
      files[sourceFile] = cloneState(state)
    }
    writeFileAtomically(this.checkpointFile, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      files,
    }, null, 2) + "\n")
  }
}

function createEmptyState() {
  return {
    offset: 0,
    sourceLine: 0,
    remainder: "",
  }
}

function readStateAtEnd(sourceFile) {
  const raw = fs.readFileSync(sourceFile, "utf8")
  const parts = raw.split(/\r?\n/u)
  const remainder = parts.pop() || ""
  return {
    offset: Buffer.byteLength(raw, "utf8"),
    sourceLine: parts.reduce((count, part) => count + (part.trim() ? 1 : 0), 0),
    remainder,
  }
}

function normalizeState(value) {
  if (!value || typeof value !== "object") {
    return null
  }
  const offset = Number(value.offset)
  const sourceLine = Number(value.sourceLine)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(sourceLine) || sourceLine < 0) {
    return null
  }
  return {
    offset,
    sourceLine,
    remainder: typeof value.remainder === "string" ? value.remainder : "",
  }
}

function cloneState(state) {
  return {
    offset: state.offset,
    sourceLine: state.sourceLine,
    remainder: state.remainder,
  }
}

function sameRawIdentity(left, right) {
  if (!left || !right || left.type !== right.type) {
    return false
  }
  const leftUuid = normalizeText(left.uuid || left.promptId)
  const rightUuid = normalizeText(right.uuid || right.promptId)
  if (leftUuid && rightUuid) {
    return leftUuid === rightUuid
  }
  if (left.type === "response_item") {
    const leftPayload = left.payload && typeof left.payload === "object" ? left.payload : {}
    const rightPayload = right.payload && typeof right.payload === "object" ? right.payload : {}
    const leftCallId = normalizeText(leftPayload.call_id)
    const rightCallId = normalizeText(rightPayload.call_id)
    if (leftCallId && rightCallId) {
      return leftCallId === rightCallId && normalizeText(leftPayload.type) === normalizeText(rightPayload.type)
    }
  }
  return false
}

function writeFileAtomically(filePath, body) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    fs.writeFileSync(tempPath, body, "utf8")
    try {
      fs.renameSync(tempPath, filePath)
    } catch (error) {
      if (!fs.existsSync(filePath) || !["EEXIST", "EPERM", "ENOTEMPTY"].includes(error?.code)) {
        throw error
      }
      fs.rmSync(filePath, { force: true })
      fs.renameSync(tempPath, filePath)
    }
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true })
    }
  }
}

function normalizeSourceFile(sourceFile) {
  const normalized = typeof sourceFile === "string" ? sourceFile.trim() : ""
  return normalized ? path.resolve(normalized) : ""
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "unknown error")
}

module.exports = {
  RealtimeTailer,
}
