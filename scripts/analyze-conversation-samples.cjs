const fs = require("node:fs")
const crypto = require("node:crypto")
const os = require("node:os")
const path = require("node:path")

const {
  ConversationArchive,
  ConversationImporter,
} = require("../src/custom/xiaoye/conversation")

const files = process.argv.slice(2)

if (files[0] === "--parser-parity") {
  compareParserModes(files[1], files[2])
  return
}

if (files[0] === "--compare-visible") {
  compareVisible(files[1], files[2])
  return
}

for (const filePath of files) {
  const raw = fs.readFileSync(filePath, "utf8")
  const values = parseValues(raw)
  const records = values.flatMap(flattenTopLevel)
  const counts = new Map()
  const toolNames = new Map()
  const mediaKinds = new Map()
  let bootstrapCandidates = 0
  let nestedQuotes = 0
  const mcpSamples = []

  for (const [index, record] of records.entries()) {
    const payload = record?.payload && typeof record.payload === "object" ? record.payload : {}
    const message = record?.message && typeof record.message === "object" ? record.message : {}
    const key = [
      record?.type || "",
      payload.type || record?.subtype || message.role || record?.role || "",
    ].filter(Boolean).join(":") || "unknown"
    increment(counts, key)

    const toolName = payload.invocation?.tool
      || payload.name
      || record?.name
      || message?.name
      || record?.toolName
      || record?.meta?.toolName
    if (typeof toolName === "string" && toolName.trim()) {
      increment(toolNames, toolName.trim())
    }

    for (const item of collectMedia(record)) {
      increment(mediaKinds, item)
    }

    const text = collectText(record)
    if (text.includes("<recommended_plugins>")
      && text.includes("# AGENTS.md instructions")
      && text.includes("<environment_context>")) {
      bootstrapCandidates += 1
    }
    if (text.includes("[Quoted: [")) {
      nestedQuotes += 1
    }
    if (payload.type === "mcp_tool_call_end" && mcpSamples.length < 20) {
      mcpSamples.push({
        index,
        payloadKeys: Object.keys(payload),
        invocation: valueShape(payload.invocation, { keep: new Set(["server", "tool"]) }),
        result: valueShape(parseStructured(payload.result)),
        previous: recordIdentity(records[index - 1]),
        next: recordIdentity(records[index + 1]),
      })
    }
  }

  process.stdout.write(`${JSON.stringify({
    file: filePath.replace(/^.*[\\/]/, ""),
    bytes: Buffer.byteLength(raw),
    parsedValues: values.length,
    records: records.length,
    counts: sortedObject(counts),
    toolNames: sortedObject(toolNames),
    mediaKinds: sortedObject(mediaKinds),
    bootstrapCandidates,
    nestedQuotes,
    mcpSamples,
  }, null, 2)}\n`)
}

function compareVisible(leftPath, rightPath) {
  const leftRecords = readRecords(leftPath)
  const rightRecords = readRecords(rightPath)
  const left = buildVisibleMultiset(leftRecords)
  const right = buildVisibleMultiset(rightRecords)
  const keys = new Set([...left.keys(), ...right.keys()])
  const differences = []

  for (const key of [...keys].sort()) {
    const leftEntry = left.get(key)
    const rightEntry = right.get(key)
    const leftCount = leftEntry?.count || 0
    const rightCount = rightEntry?.count || 0
    if (leftCount === rightCount) continue
    differences.push({
      label: leftEntry?.label || rightEntry?.label || "unknown",
      semanticHash: key,
      leftCount,
      rightCount,
    })
  }

  const summary = {
    left: leftPath.replace(/^.*[\\/]/, ""),
    right: rightPath.replace(/^.*[\\/]/, ""),
    leftRecords: leftRecords.length,
    rightRecords: rightRecords.length,
    visibleDifferences: differences.length,
    differences: differences.slice(0, 50),
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  if (differences.length) {
    process.exitCode = 1
  }
}

function compareParserModes(runtimeId, sourceFile) {
  if (!["codex", "claudecode"].includes(runtimeId) || !sourceFile) {
    throw new Error("usage: --parser-parity <codex|claudecode> <source-file>")
  }
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `cyberboss-${runtimeId}-parity-`))
  const realtimeDir = path.join(rootDir, "realtime")
  const importDir = path.join(rootDir, "import")

  try {
    const rawRecords = parseValues(fs.readFileSync(sourceFile, "utf8")).flatMap(flattenTopLevel)
    const realtimeArchive = createArchive(realtimeDir)
    rawRecords.forEach((raw, index) => {
      realtimeArchive.ingestRealtimeSessionLine({
        runtimeId,
        raw,
        sourceFile,
        sourceLine: index + 1,
        workspaceRoot: "D:/study/cyberboss",
      })
    })
    realtimeArchive.close()

    const importer = new ConversationImporter({
      config: {
        stateDir: importDir,
        conversationDir: path.join(importDir, "conversations"),
      },
      logger: { warn() {} },
    })
    importer.importFile({
      runtimeId,
      sourceFile,
      workspaceRoot: "D:/study/cyberboss",
    })

    const realtimeRecords = readConversationDirectory(realtimeDir)
    const importedRecords = readConversationDirectory(importDir)
    const differences = compareVisibleRecords(realtimeRecords, importedRecords)
    process.stdout.write(`${JSON.stringify({
      runtimeId,
      source: path.basename(sourceFile),
      rawRecords: rawRecords.length,
      realtime: summarizeVisibleRecords(realtimeRecords),
      imported: summarizeVisibleRecords(importedRecords),
      visibleDifferences: differences.length,
      differences: differences.slice(0, 50),
    }, null, 2)}\n`)
    if (differences.length) {
      process.exitCode = 1
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
}

function createArchive(stateDir) {
  return new ConversationArchive({
    config: {
      stateDir,
      conversationDir: path.join(stateDir, "conversations"),
    },
  })
}

function readConversationDirectory(stateDir) {
  const conversationDir = path.join(stateDir, "conversations")
  if (!fs.existsSync(conversationDir)) return []
  return fs.readdirSync(conversationDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => readRecords(path.join(conversationDir, name)))
}

function compareVisibleRecords(leftRecords, rightRecords) {
  const left = buildVisibleMultiset(leftRecords)
  const right = buildVisibleMultiset(rightRecords)
  const keys = new Set([...left.keys(), ...right.keys()])
  const differences = []
  for (const key of [...keys].sort()) {
    const leftEntry = left.get(key)
    const rightEntry = right.get(key)
    const leftCount = leftEntry?.count || 0
    const rightCount = rightEntry?.count || 0
    if (leftCount === rightCount) continue
    differences.push({
      label: leftEntry?.label || rightEntry?.label || "unknown",
      semanticHash: key,
      realtimeCount: leftCount,
      importCount: rightCount,
    })
  }
  return differences
}

function summarizeVisibleRecords(records) {
  const types = new Map()
  const toolNames = new Map()
  const mediaKinds = new Map()
  const assistantMediaCollections = {
    attachments: 0,
    files: 0,
    stickers: 0,
  }
  let assistantMediaRecords = 0
  for (const record of records) {
    increment(types, record?.type || "unknown")
    const meta = record?.meta && typeof record.meta === "object" ? record.meta : {}
    if (meta.toolName) increment(toolNames, meta.toolName)
    const media = {
      attachments: Array.isArray(meta.attachments) ? meta.attachments : [],
      files: Array.isArray(meta.files) ? meta.files : [],
      stickers: Array.isArray(meta.stickers) ? meta.stickers : [],
    }
    for (const item of [...media.attachments, ...media.files, ...media.stickers]) {
      increment(mediaKinds, item?.kind || "unknown")
    }
    if (record?.type === "assistant" && Object.values(media).some((items) => items.length)) {
      assistantMediaRecords += 1
      for (const key of Object.keys(assistantMediaCollections)) {
        assistantMediaCollections[key] += media[key].length
      }
    }
  }
  return {
    records: records.length,
    types: sortedObject(types),
    toolNames: sortedObject(toolNames),
    mediaKinds: sortedObject(mediaKinds),
    assistantMediaRecords,
    assistantMediaCollections,
  }
}

function readRecords(filePath) {
  return parseValues(fs.readFileSync(filePath, "utf8")).flatMap(flattenTopLevel)
}

function buildVisibleMultiset(records) {
  const multiset = new Map()
  for (const record of records) {
    const semantics = visibleSemantics(record)
    const key = crypto.createHash("sha256").update(stableJson(semantics)).digest("hex").slice(0, 16)
    const label = [
      semantics.runtimeId || "runtime?",
      semantics.type || "type?",
      semantics.toolName || semantics.visibleAs || semantics.operationKind || "record",
    ].join(":")
    const entry = multiset.get(key) || { count: 0, label }
    entry.count += 1
    multiset.set(key, entry)
  }
  return multiset
}

function visibleSemantics(record) {
  const meta = record?.meta && typeof record.meta === "object" ? record.meta : {}
  return {
    type: record?.type || "",
    runtimeId: record?.runtimeId || meta.runtimeId || "",
    threadId: record?.threadId || meta.threadId || "",
    turnId: record?.turnId || meta.turnId || "",
    itemId: record?.itemId || meta.itemId || "",
    messageId: record?.messageId || meta.messageId || "",
    text: record?.text || "",
    quote: record?.quote || meta.quote || "",
    toolName: record?.toolName || meta.toolName || "",
    operationKind: record?.operationKind || meta.operationKind || "",
    attachments: normalizeVisibleMedia(record?.attachments || meta.attachments),
    files: normalizeVisibleMedia(record?.files || meta.files),
    stickers: normalizeVisibleMedia(record?.stickers || meta.stickers),
    visibleAs: record?.visibleAs || meta.visibleAs || "",
    displayText: record?.displayText || meta.displayText || "",
  }
}

function normalizeVisibleMedia(value) {
  return (Array.isArray(value) ? value : []).map((item) => stableObject(item))
}

function stableJson(value) {
  return JSON.stringify(stableObject(value))
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableObject(value[key])]),
  )
}

function recordIdentity(record) {
  return {
    type: record?.type || "",
    payloadType: record?.payload?.type || "",
    name: record?.payload?.name || "",
    callId: record?.payload?.call_id || "",
  }
}

function parseStructured(value) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function valueShape(value, { keep = new Set() } = {}) {
  if (Array.isArray(value)) {
    return value.slice(0, 3).map((item) => valueShape(item, { keep }))
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? `<string:${value.length}>` : typeof value
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    keep.has(key) ? item : valueShape(item, { keep }),
  ]))
}

function parseValues(raw) {
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    return [JSON.parse(trimmed)]
  } catch {}
  return trimmed.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

function flattenTopLevel(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.records)) return value.records
  if (Array.isArray(value?.items)) return value.items
  return value && typeof value === "object" ? [value] : []
}

function collectText(record) {
  const candidates = [
    record?.text,
    record?.payload?.text,
    record?.payload?.message,
    record?.message?.content,
    record?.content,
  ]
  return candidates.flatMap((value) => {
    if (typeof value === "string") return [value]
    if (Array.isArray(value)) return value.map((item) => item?.text).filter((item) => typeof item === "string")
    return []
  }).join("\n")
}

function collectMedia(record) {
  const groups = [
    record?.attachments,
    record?.files,
    record?.stickers,
    record?.meta?.attachments,
    record?.meta?.files,
    record?.meta?.stickers,
  ]
  return groups.flatMap((group) => Array.isArray(group) ? group : []).map((item) => (
    item?.kind || item?.contentType || "unknown"
  ))
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1)
}

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
}
