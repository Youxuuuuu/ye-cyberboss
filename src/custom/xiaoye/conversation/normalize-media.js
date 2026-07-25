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
    relativePath: normalizeSlashPath(normalizeText(item.relativePath) || displayPath.relativePath),
    path: normalizeSlashPath(absolutePath),
    url: normalizeText(item.url),
    contentType: normalizeText(item.contentType || item.mimeType),
    stickerId: normalizeText(item.stickerId),
    kind,
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

function mergeMediaLists(existing = [], incoming = [], context = {}) {
  const result = []
  const indexByIdentity = new Map()
  const items = normalizeMediaList([
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(incoming) ? incoming : []),
  ], context)

  for (const item of items) {
    const identity = buildMediaIdentity(item)
    if (!identity || !indexByIdentity.has(identity)) {
      if (identity) {
        indexByIdentity.set(identity, result.length)
      }
      result.push(item)
      continue
    }
    const index = indexByIdentity.get(identity)
    result[index] = preferCanonicalMedia(result[index], item)
  }
  return result
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

function buildMediaIdentity(item = {}) {
  const stickerId = normalizeText(item.stickerId).toLowerCase()
  if (stickerId) {
    return `sticker:${stickerId}`
  }
  const kind = normalizeText(item.kind || item.type).toLowerCase()
  const filePath = normalizeComparablePath(item.path || item.filePath || item.absolutePath)
  if (filePath) {
    return `${kind || "media"}:path:${filePath}`
  }
  const relativePath = normalizeComparablePath(item.relativePath)
  if (relativePath) {
    return `${kind || "media"}:relative:${relativePath}`
  }
  const url = normalizeText(item.url)
  if (url) {
    return `${kind || "media"}:url:${url}`
  }
  const fileName = normalizeText(item.fileName).toLowerCase()
  return fileName ? `${kind || "media"}:file:${fileName}` : ""
}

function preferCanonicalMedia(existing, incoming) {
  const existingScore = scoreMedia(existing)
  const incomingScore = scoreMedia(incoming)
  return incomingScore >= existingScore ? incoming : existing
}

function scoreMedia(item = {}) {
  const normalizedPath = normalizeText(item.path || item.filePath)
  const relativePath = normalizeSlashPath(item.relativePath)
  let score = Object.keys(item).length
  if (normalizeText(item.stickerId)) score += 8
  if (/^[A-Za-z]:\//u.test(normalizeSlashPath(normalizedPath))) score += 4
  if (normalizedPath && !hasMalformedPathShape(normalizedPath)) score += 4
  if (relativePath.includes("/")) score += 4
  if (relativePath.startsWith("stickers/assets/")) score += 8
  return score
}

function hasMalformedPathShape(value = "") {
  const normalized = normalizeSlashPath(value)
  const withoutPrefix = normalized.startsWith("//") ? normalized.slice(2) : normalized
  return /\/{2,}/u.test(withoutPrefix) || /\/$/u.test(normalized)
}

function normalizeComparablePath(value = "") {
  const normalized = normalizeSlashPath(value).replace(/\/+$/u, "")
  const prefix = normalized.startsWith("//") ? "//" : ""
  const body = prefix ? normalized.slice(2) : normalized
  return `${prefix}${body.replace(/\/{2,}/gu, "/")}`.toLowerCase()
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  mergeMediaLists,
  normalizeMediaItem,
  normalizeMediaList,
}
