const fs = require("fs")

const { ConversationWriter } = require("./writer")
const { createClaudeCodeImportParser } = require("./providers/claudecode-import")
const { createCodexImportParser } = require("./providers/codex-import")

class ConversationImporter {
  constructor({ config, writer = null, logger = console } = {}) {
    this.config = config || {}
    this.writer = writer || new ConversationWriter({
      conversationDir: this.config.conversationDir,
    })
    this.logger = logger
  }

  importFile({ runtimeId = "", sourceFile = "", workspaceRoot = "" } = {}) {
    const parser = createImportParser(runtimeId)
    const warnings = []
    const records = []
    const raw = fs.readFileSync(sourceFile, "utf8")
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
          sourceFile,
          sourceLine: index + 1,
        }))
      } catch (error) {
        const message = `Invalid JSONL line ${index + 1} in ${sourceFile}: ${error.message}`
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

function createImportParser(runtimeId = "") {
  const normalized = String(runtimeId || "").trim().toLowerCase()
  if (normalized === "claudecode") {
    return createClaudeCodeImportParser()
  }
  return createCodexImportParser()
}

module.exports = {
  ConversationImporter,
}
