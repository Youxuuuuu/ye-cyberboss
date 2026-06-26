const path = require("path")

const { normalizeMediaList } = require("./normalize-media")

const SYNTHETIC_MARKERS = [
  /^Saved attachments:\s*$/imu,
  /^Visual context(?: from attachments)?:/imu,
  /^Use the saved local files if they are needed for the request\./imu,
  /^If some images are reusable stickers,/imu,
]

function extractSavedAttachmentsFromText(text = "", context = {}) {
  const normalized = String(text || "").replace(/\r\n/g, "\n")
  const attachments = []

  const itemPattern = /^\s*-\s*\[(image|file|sticker)\]\s+(.+?)\s*$/gimu
  for (const match of normalized.matchAll(itemPattern)) {
    const filePath = cleanAttachmentPath(match[2])
    const kind = normalizeAttachmentKind(match[1], filePath)
    if (!filePath) {
      continue
    }
    attachments.push({
      kind,
      type: kind,
      fileName: path.basename(filePath),
      path: filePath,
      filePath,
      isImage: kind === "image" || kind === "sticker",
    })
  }

  const cleanedText = trimSyntheticPrompt(normalized)
  const normalizedAttachments = normalizeMediaList(attachments, context)
  return {
    text: cleanedText,
    attachments: normalizedAttachments,
    files: normalizedAttachments.filter((item) => item.kind === "file"),
    stickers: normalizedAttachments.filter((item) => item.kind === "sticker"),
    visibleAttachments: normalizedAttachments.filter((item) => item.kind !== "file"),
    hasSavedAttachments: normalizedAttachments.length > 0,
  }
}

function trimSyntheticPrompt(text = "") {
  const normalized = String(text || "").replace(/\r\n/g, "\n")
  let cutoff = normalized.length
  for (const marker of SYNTHETIC_MARKERS) {
    const match = marker.exec(normalized)
    marker.lastIndex = 0
    if (match && typeof match.index === "number") {
      cutoff = Math.min(cutoff, match.index)
    }
  }
  return normalized.slice(0, cutoff).trim()
}

function normalizeAttachmentKind(kind = "", filePath = "") {
  const normalizedKind = normalizeText(kind).toLowerCase()
  if (normalizedKind === "sticker") {
    return "sticker"
  }
  if (normalizedKind === "file") {
    return "file"
  }
  if (/\/stickers\/assets\//iu.test(filePath) || /(?:^|\/)stk_[^/]+\.gif$/iu.test(filePath)) {
    return "sticker"
  }
  return "image"
}

function cleanAttachmentPath(value = "") {
  return normalizeText(value)
    .replace(/\s+\(original name:\s*[^)]*\)\s*$/iu, "")
    .replace(/^["']|["']$/gu, "")
    .trim()
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = {
  cleanAttachmentPath,
  extractSavedAttachmentsFromText,
  trimSyntheticPrompt,
}
