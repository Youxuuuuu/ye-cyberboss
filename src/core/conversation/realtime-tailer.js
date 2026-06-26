const fs = require("fs")

class RealtimeTailer {
  constructor() {
    this.stateByFile = new Map()
  }

  readAvailableLines(sourceFile = "") {
    if (!sourceFile || !fs.existsSync(sourceFile)) {
      return []
    }

    const stat = fs.statSync(sourceFile)
    let state = this.stateByFile.get(sourceFile) || {
      offset: 0,
      sourceLine: 0,
      remainder: "",
    }

    if (stat.size < state.offset) {
      state = {
        offset: 0,
        sourceLine: 0,
        remainder: "",
      }
    }

    if (stat.size === state.offset) {
      this.stateByFile.set(sourceFile, state)
      return []
    }

    const handle = fs.openSync(sourceFile, "r")
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
          sourceFile,
          sourceLine: state.sourceLine,
          rawLine: trimmed,
        })
      }

      this.stateByFile.set(sourceFile, state)
      return lines
    } finally {
      fs.closeSync(handle)
    }
  }
}

module.exports = {
  RealtimeTailer,
}
