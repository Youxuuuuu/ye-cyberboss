const fs = require("fs")
const path = require("path")

const { ConversationWriter } = require("./writer")
const { createClaudeCodeImportParser } = require("./providers/claudecode-import")
const { createCodexImportParser } = require("./providers/codex-import")

class ConversationImporter {
  constructor({ config, writer = null, logger = console } = {}) {
    this.config = config || {}
    this.writer = writer || new ConversationWriter({
      conversationDir: this.config.conversationDir,
      deletionStateFile: this.config.conversationDeletionStateFile
        || path.join(path.resolve(normalizeText(this.config.conversationDir) || "."), ".conversation-deletion-state.json"),
      logger,
    })
    this.logger = logger
  }

  importFile({ runtimeId = "", sourceFile = "", workspaceRoot = "" } = {}) {
    const normalizedSourceFile = normalizeSourceFile(sourceFile)
    if (!normalizedSourceFile) {
      throw new Error("conversation import requires sourceFile")
    }
    if (!fs.existsSync(normalizedSourceFile)) {
      throw new Error(`conversation import sourceFile does not exist: ${normalizedSourceFile}`)
    }
    const parser = createImportParser(runtimeId, this.config.stateDir)
    const warnings = []
    const records = []
    const raw = fs.readFileSync(normalizedSourceFile, "utf8")
    const lines = raw.split(/\r?\n/u)

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim()
      if (!line) {
        continue
      }
      try {
        const parsed = JSON.parse(line)
        records.push(...parser.parseRaw({
          raw: parsed,
          workspaceRoot,
          sourceFile: normalizedSourceFile,
          sourceLine: index + 1,
        }))
      } catch (error) {
        const message = `Invalid JSONL line ${index + 1} in ${normalizedSourceFile}: ${error.message}`
        warnings.push(message)
        this.logger?.warn?.(message)
      }
    }

    const writeResult = this.writer.writeRecords(records)
    return {
      importedCount: records.length,
      writtenCount: writeResult.writtenCount,
      warnings: [...warnings, ...writeResult.warnings],
    }
  }
}

function createImportParser(runtimeId = "", stateDir = "") {
  const normalized = String(runtimeId || "").trim().toLowerCase()
  if (normalized === "claudecode") {
    return createClaudeCodeImportParser({ mode: "import", stateDir })
  }
  if (normalized === "codex") {
    return createCodexImportParser({ mode: "import", stateDir })
  }
  throw new Error(`unsupported conversation runtime: ${normalized || "(empty)"}`)
}

function normalizeSourceFile(sourceFile) {
  const normalized = typeof sourceFile === "string" ? sourceFile.trim() : ""
  return normalized ? path.resolve(normalized) : ""
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  ConversationImporter,
}
