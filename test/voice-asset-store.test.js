const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { createVoiceAssetStore, VoiceInputError } = require("../src/custom/xiaoye/voice/asset-store")

test("user voice is permanently stored under MLane/voice/self before it is decoded", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-voice-asset-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const observed = []
  const store = createVoiceAssetStore({
    stateDir,
    now: () => new Date("2026-08-09T01:02:03.004Z"),
    createId: () => "asset-1",
    async probeAudio(input) {
      observed.push({ ...input, exists: fs.existsSync(input.absolutePath) })
      return { durationMs: 8_250 }
    },
  })

  const asset = await store.persistUserVoice({
    bytes: wavBytes(),
    contentType: "audio/wav",
  })

  assert.equal(asset.assetId, "asset-1")
  assert.equal(asset.relativePath, "self/2026/08/2026-08-09-09-02-03-004.wav")
  assert.equal(asset.mimeType, "audio/wav")
  assert.equal(asset.durationMs, 8_250)
  assert.equal(observed[0].exists, true)
  assert.equal(fs.existsSync(path.join(stateDir, "MLane", "voice", ...asset.relativePath.split("/"))), true)
})

test("same-millisecond user voices receive unique timestamp-only names", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-voice-collision-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  let id = 0
  const store = createVoiceAssetStore({
    stateDir,
    now: () => new Date("2026-08-09T01:02:03.004Z"),
    createId: () => `asset-${++id}`,
    probeAudio: async () => ({ durationMs: 1_000 }),
  })

  const first = await store.persistUserVoice({ bytes: wavBytes(), contentType: "audio/wav" })
  const second = await store.persistUserVoice({ bytes: wavBytes(), contentType: "audio/wav" })

  assert.equal(first.relativePath, "self/2026/08/2026-08-09-09-02-03-004.wav")
  assert.equal(second.relativePath, "self/2026/08/2026-08-09-09-02-03-005.wav")
})

test("user voice rejects mismatched media and decoded audio over 60 seconds", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-voice-invalid-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const store = createVoiceAssetStore({
    stateDir,
    probeAudio: async () => ({ durationMs: 60_001 }),
  })

  await assert.rejects(
    store.persistUserVoice({ bytes: Buffer.from("not audio"), contentType: "audio/wav" }),
    (error) => error instanceof VoiceInputError && error.reason === "invalid-media",
  )
  await assert.rejects(
    store.persistUserVoice({ bytes: wavBytes(), contentType: "audio/wav" }),
    (error) => error instanceof VoiceInputError && error.reason === "too-long",
  )
})

test("user voice preserves a typed workflow abort during asset persistence", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-voice-abort-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const controller = new AbortController()
  controller.abort(new VoiceInputError("provider-timeout", "voice workflow timed out", { statusCode: 504 }))
  const store = createVoiceAssetStore({
    stateDir,
    probeAudio: async () => ({ durationMs: 1_000 }),
  })

  await assert.rejects(
    store.persistUserVoice({ bytes: wavBytes(), contentType: "audio/wav", signal: controller.signal }),
    (error) => error instanceof VoiceInputError && error.reason === "provider-timeout",
  )
})

test("a failed Voice Message can reopen its permanent self asset without accepting path escape", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-voice-reopen-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const store = createVoiceAssetStore({
    stateDir,
    now: () => new Date("2026-08-09T01:02:03.004Z"),
    createId: () => "asset-reopen",
    probeAudio: async () => ({ durationMs: 1_000 }),
  })
  const asset = await store.persistUserVoice({ bytes: wavBytes(), contentType: "audio/wav" })

  const reopened = await store.readUserVoiceAsset(asset)
  assert.equal(reopened.bytes.equals(wavBytes()), true)
  assert.equal(reopened.mimeType, "audio/wav")
  await assert.rejects(
    store.readUserVoiceAsset({ ...asset, relativePath: "../outside.wav" }),
    (error) => error instanceof VoiceInputError && error.reason === "invalid-media",
  )
})

test("assistant generations are permanently stored under their thread and keep over-limit audio", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-voice-assistant-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const store = createVoiceAssetStore({
    stateDir,
    now: () => new Date("2026-08-09T01:02:03.004Z"),
    createId: () => "asset-assistant-1",
    probeAudio: async ({ absolutePath }) => ({
      durationMs: fs.existsSync(absolutePath) ? 60_250 : 0,
    }),
  })

  const asset = await store.persistGeneratedVoice({
    threadId: "thread-voice-1",
    bytes: mp3Bytes(),
    contentType: "audio/mpeg",
  })

  assert.deepEqual(asset, {
    assetId: "asset-assistant-1",
    relativePath: "threads/thread-voice-1/2026/08/2026-08-09-09-02-03-004.mp3",
    mimeType: "audio/mpeg",
    sizeBytes: mp3Bytes().length,
    durationMs: 60_250,
  })
  assert.equal(fs.existsSync(path.join(stateDir, "MLane", "voice", ...asset.relativePath.split("/"))), true)
})

test("assistant generation storage rejects unsafe thread directories and mismatched bytes", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-voice-assistant-invalid-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const store = createVoiceAssetStore({
    stateDir,
    probeAudio: async () => ({ durationMs: 1_000 }),
  })

  await assert.rejects(
    store.persistGeneratedVoice({ threadId: "../outside", bytes: mp3Bytes(), contentType: "audio/mpeg" }),
    (error) => error instanceof VoiceInputError && error.reason === "invalid-media",
  )
  await assert.rejects(
    store.persistGeneratedVoice({ threadId: "thread-1", bytes: mp3Bytes(), contentType: "audio/wav" }),
    (error) => error instanceof VoiceInputError && error.reason === "invalid-media",
  )
})

function wavBytes() {
  const bytes = Buffer.alloc(44)
  bytes.write("RIFF", 0, "ascii")
  bytes.writeUInt32LE(36, 4)
  bytes.write("WAVE", 8, "ascii")
  bytes.write("fmt ", 12, "ascii")
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16_000, 24)
  bytes.writeUInt32LE(32_000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write("data", 36, "ascii")
  bytes.writeUInt32LE(0, 40)
  return bytes
}

function mp3Bytes() {
  return Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00])
}
