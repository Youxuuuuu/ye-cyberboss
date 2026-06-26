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
  const normalizedStateDir = normalizeRootPath(stateDir || process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss"))

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

module.exports = {
  normalizeDisplayPath,
  normalizeSlashPath,
}
