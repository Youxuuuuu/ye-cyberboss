const path = require("path")

const { normalizeDisplayPath, normalizeSlashPath } = require("./normalize-display-path")

function normalizeMediaItem(item = {}, context = {}) {
  const absolutePath = firstText(
    item.path,
    item.filePath,
    item.localPath,
    item.savedPath,
    item.absolutePath,
    item.createdPath
  )
  const displayPath = normalizeDisplayPath({
    path: absolutePath || item.relativePath || "",
    workspaceRoot: context.workspaceRoot,
    stateDir: context.stateDir,
  })
  const kind = normalizeMediaKind(item)
  const normalized = {
    label: normalizeText(item.label),
    fileName: normalizeText(item.fileName) || basenameFromPath(absolutePath || item.relativePath),
    relativePath: normalizeText(item.relativePath) || displayPath.relativePath,
    path: normalizeSlashPath(absolutePath),
    filePath: normalizeSlashPath(absolutePath),
    localPath: normalizeSlashPath(absolutePath),
    savedPath: normalizeSlashPath(absolutePath),
    url: normalizeText(item.url),
    mimeType: normalizeText(item.mimeType || item.contentType),
    contentType: normalizeText(item.contentType || item.mimeType),
    stickerId: normalizeText(item.stickerId),
    kind,
    type: kind,
    isImage: inferIsImage(item, kind),
    fileMeta: normalizeText(item.fileMeta),
  }

  return removeEmptyFields(normalized)
}

function normalizeMediaList(items, context = {}) {
  return Array.isArray(items)
    ? items
      .map((item) => normalizeMediaItem(item, context))
      .filter((item) => Object.keys(item).length > 0)
    : []
}

function normalizeMediaKind(item = {}) {
  const explicit = normalizeText(item.kind || item.type).toLowerCase()
  if (explicit) {
    return explicit
  }
  if (normalizeText(item.stickerId)) {
    return "sticker"
  }
  const contentType = normalizeText(item.contentType || item.mimeType).toLowerCase()
  if (contentType.startsWith("image/")) {
    return "image"
  }
  return "file"
}

function inferIsImage(item, kind) {
  if (typeof item?.isImage === "boolean") {
    return item.isImage
  }
  if (kind === "image" || kind === "sticker") {
    return true
  }
  const contentType = normalizeText(item?.contentType || item?.mimeType).toLowerCase()
  if (contentType.startsWith("image/")) {
    return true
  }
  const filePath = firstText(item?.path, item?.filePath, item?.localPath, item?.savedPath, item?.absolutePath)
  return /\.(?:png|jpe?g|gif|webp|bmp|svg)$/iu.test(filePath)
}

function basenameFromPath(value) {
  const normalized = normalizeText(value)
  return normalized ? path.basename(normalized) : ""
}

function firstText(...values) {
  for (const value of values) {
    const normalized = normalizeText(value)
    if (normalized) {
      return normalized
    }
  }
  return ""
}

function removeEmptyFields(value) {
  const output = {}
  for (const [key, entry] of Object.entries(value || {})) {
    if (entry === "" || entry == null) {
      continue
    }
    output[key] = entry
  }
  return output
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  normalizeMediaItem,
  normalizeMediaList,
}
