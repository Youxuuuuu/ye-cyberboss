const os = require("os")
const path = require("path")

function normalizeDisplayPath({ path: inputPath = "", workspaceRoot = "", stateDir = "" } = {}) {
  const normalizedInput = normalizeSlashPath(inputPath)
  if (!normalizedInput) {
    return {
      displayPath: "",
      relativePath: "",
      path: "",
      filePath: "",
    }
  }

  const absolutePath = looksAbsolutePath(normalizedInput) ? normalizedInput : ""
  const normalizedWorkspaceRoot = normalizeRootPath(workspaceRoot)
  const inferredStateDir = inferStateDirFromAbsolutePath(absolutePath)
  const normalizedStateDir = normalizeRootPath(
    stateDir
    || process.env.CYBERBOSS_STATE_DIR
    || inferredStateDir
    || path.join(os.homedir(), ".cyberboss")
  )

  let relativePath = ""
  if (absolutePath && normalizedStateDir && isPathWithinRoot(absolutePath, normalizedStateDir)) {
    relativePath = normalizeSlashPath(path.relative(normalizedStateDir, absolutePath))
  } else if (absolutePath && normalizedWorkspaceRoot && isPathWithinRoot(absolutePath, normalizedWorkspaceRoot)) {
    relativePath = normalizeSlashPath(path.relative(normalizedWorkspaceRoot, absolutePath))
  } else if (!absolutePath) {
    relativePath = normalizedInput
  }

  const displayPath = relativePath || (absolutePath ? normalizeSlashPath(path.basename(absolutePath)) : normalizedInput)
  return {
    displayPath,
    relativePath: relativePath || displayPath,
    path: absolutePath || normalizedInput,
    filePath: absolutePath || normalizedInput,
  }
}

function normalizeSlashPath(value) {
  return typeof value === "string" ? value.trim().replace(/\\/g, "/") : ""
}

function normalizeRootPath(value) {
  const normalized = normalizeSlashPath(value)
  return normalized.replace(/\/+$/u, "")
}

function looksAbsolutePath(value = "") {
  return /^[A-Za-z]:\//u.test(value) || value.startsWith("//")
}

function isPathWithinRoot(targetPath = "", rootPath = "") {
  const normalizedTarget = normalizeRootPath(targetPath).toLowerCase()
  const normalizedRoot = normalizeRootPath(rootPath).toLowerCase()
  return Boolean(normalizedTarget && normalizedRoot)
    && (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`))
}

function inferStateDirFromAbsolutePath(absolutePath = "") {
  const normalized = normalizeSlashPath(absolutePath)
  if (!normalized) {
    return ""
  }
  const marker = normalized.toLowerCase().indexOf("/.cyberboss/")
  if (marker >= 0) {
    return normalized.slice(0, marker + "/.cyberboss".length)
  }
  if (normalized.toLowerCase().endsWith("/.cyberboss")) {
    return normalized
  }
  return ""
}

module.exports = {
  normalizeDisplayPath,
  normalizeSlashPath,
}
