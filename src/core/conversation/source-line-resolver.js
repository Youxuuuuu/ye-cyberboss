const fs = require("fs")
const os = require("os")
const path = require("path")

const { normalizeWorkspaceRoot } = require("../workspace-root")

class ConversationSourceLineResolver {
  constructor({ codexHome = "", claudeConfigDir = "" } = {}) {
    this.codexSessionsDir = path.join(codexHome || path.join(os.homedir(), ".codex"), "sessions")
    this.claudeProjectsDir = path.join(claudeConfigDir || path.join(os.homedir(), ".claude"), "projects")
    this.sourceFileByRuntimeThread = new Map()
  }

  rememberSourceFile({ runtimeId = "", threadId = "", workspaceRoot = "", sourceFile = "" } = {}) {
    const key = buildThreadKey(runtimeId, threadId, workspaceRoot)
    const normalizedSourceFile = normalizeText(sourceFile)
    if (key && normalizedSourceFile) {
      this.sourceFileByRuntimeThread.set(key, normalizedSourceFile)
    }
    return normalizedSourceFile
  }

  resolveSourceFile({ runtimeId = "", threadId = "", workspaceRoot = "" } = {}) {
    const key = buildThreadKey(runtimeId, threadId, workspaceRoot)
    if (key && this.sourceFileByRuntimeThread.has(key)) {
      return this.sourceFileByRuntimeThread.get(key)
    }

    const normalizedRuntimeId = normalizeText(runtimeId).toLowerCase()
    let resolved = ""
    if (normalizedRuntimeId === "claudecode") {
      resolved = this.resolveClaudeTranscriptPath({ threadId, workspaceRoot })
    } else if (normalizedRuntimeId === "codex") {
      resolved = this.resolveCodexSessionPath({ threadId })
    }

    if (key && resolved) {
      this.sourceFileByRuntimeThread.set(key, resolved)
    }
    return resolved
  }

  resolveClaudeTranscriptPath({ threadId = "", workspaceRoot = "" } = {}) {
    const normalizedThreadId = normalizeThreadId(threadId)
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot)
    if (!normalizedThreadId || !normalizedWorkspaceRoot) {
      return ""
    }
    return path.join(this.claudeProjectsDir, encodeClaudeProjectPath(normalizedWorkspaceRoot), `${normalizedThreadId}.jsonl`)
  }

  resolveCodexSessionPath({ threadId = "" } = {}) {
    const normalizedThreadId = normalizeThreadId(threadId)
    if (!normalizedThreadId || !fs.existsSync(this.codexSessionsDir)) {
      return ""
    }
    return findFileByThreadId(this.codexSessionsDir, normalizedThreadId)
  }
}

function findFileByThreadId(rootDir, threadId) {
  const years = listDirectories(rootDir).sort().reverse()
  for (const year of years) {
    const yearDir = path.join(rootDir, year)
    const months = listDirectories(yearDir).sort().reverse()
    for (const month of months) {
      const monthDir = path.join(yearDir, month)
      const days = listDirectories(monthDir).sort().reverse()
      for (const day of days) {
        const dayDir = path.join(monthDir, day)
        const match = fs.readdirSync(dayDir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .find((name) => name.endsWith(`${threadId}.jsonl`))
        if (match) {
          return path.join(dayDir, match)
        }
      }
    }
  }
  return ""
}

function listDirectories(rootDir) {
  try {
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function buildThreadKey(runtimeId = "", threadId = "", workspaceRoot = "") {
  const normalizedRuntimeId = normalizeText(runtimeId).toLowerCase()
  const normalizedThreadId = normalizeThreadId(threadId)
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot)
  if (!normalizedRuntimeId || !normalizedThreadId) {
    return ""
  }
  return [normalizedRuntimeId, normalizedThreadId, normalizedWorkspaceRoot].join("|")
}

function encodeClaudeProjectPath(workspaceRoot) {
  return normalizeWorkspaceRoot(workspaceRoot).replace(/[\\/:\s]+/g, "-")
}

function normalizeThreadId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : ""
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  ConversationSourceLineResolver,
}
