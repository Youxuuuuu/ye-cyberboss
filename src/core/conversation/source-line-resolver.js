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
    if (!normalizedThreadId || !fs.existsSync(this.claudeProjectsDir)) {
      return ""
    }
    const projectDirCandidates = normalizedWorkspaceRoot
      ? encodeClaudeProjectPathVariants(normalizedWorkspaceRoot).map((candidate) => path.join(this.claudeProjectsDir, candidate))
      : []

    for (const projectDir of projectDirCandidates) {
      const candidatePath = path.join(projectDir, `${normalizedThreadId}.jsonl`)
      if (fs.existsSync(candidatePath)) {
        return candidatePath
      }
    }

    return findClaudeTranscriptBySessionId(this.claudeProjectsDir, normalizedThreadId)
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

function encodeClaudeProjectPathVariants(workspaceRoot) {
  const normalized = normalizeWorkspaceRoot(workspaceRoot)
  if (!normalized) {
    return []
  }
  return Array.from(new Set([
    normalized.replace(/[\\/:\s]+/g, "-"),
    normalized.replace(/[\\/:\s]/g, "-"),
    `-${normalized.replace(/[\\/:\s]/g, "-")}`,
  ].filter(Boolean)))
}

function findClaudeTranscriptBySessionId(rootDir, threadId) {
  const targetName = `${threadId}.jsonl`
  const projectDirs = listDirectories(rootDir)
  for (const projectDirName of projectDirs) {
    const projectDir = path.join(rootDir, projectDirName)
    const directMatch = path.join(projectDir, targetName)
    if (fs.existsSync(directMatch)) {
      return directMatch
    }
    const nestedMatch = findFileRecursive(projectDir, targetName, 2)
    if (nestedMatch) {
      return nestedMatch
    }
  }
  return ""
}

function findFileRecursive(rootDir, targetName, depth) {
  if (depth < 0) {
    return ""
  }
  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name)
      if (entry.isFile() && entry.name === targetName) {
        return fullPath
      }
      if (entry.isDirectory()) {
        const nested = findFileRecursive(fullPath, targetName, depth - 1)
        if (nested) {
          return nested
        }
      }
    }
  } catch {
    return ""
  }
  return ""
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
