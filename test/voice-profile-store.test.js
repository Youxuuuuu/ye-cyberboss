const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")

const {
  createVoiceProfileStore,
  createConfiguredVoiceProfile,
} = require("../src/custom/xiaoye/voice/profile-store")

test("voice profile store persists one global versioned profile without secrets", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-voice-profile-"))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const store = createVoiceProfileStore({ stateDir })
  const profile = createConfiguredVoiceProfile({
    env: { MINIMAX_VOICE_ID: "xiaoye-approved-voice", MINIMAX_API_KEY: "secret-not-profile" },
    version: "voice-profile-v1",
  })
  await store.save(profile)
  const loaded = await store.load()
  assert.equal(loaded.version, "voice-profile-v1")
  assert.equal(JSON.stringify(loaded).includes("secret-not-profile"), false)
  assert.equal(await store.loadVersion("voice-profile-v1").then((value) => value.version), "voice-profile-v1")
})

test("profile configuration stays unavailable until a voice id is explicitly approved", () => {
  assert.equal(createConfiguredVoiceProfile({ env: {} }), null)
})

test("configured profile bootstraps once and remains a persisted global profile", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-voice-profile-bootstrap-"))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const profile = createConfiguredVoiceProfile({
    env: { MINIMAX_VOICE_ID: "global-approved-voice" },
  })
  const store = createVoiceProfileStore({ stateDir, initialProfile: profile })
  const loaded = await store.load()
  assert.equal(loaded.bindings.minimax.voiceId, "global-approved-voice")
  assert.equal(JSON.parse(await fs.readFile(store.filePath, "utf8")).version, loaded.version)

  const laterStore = createVoiceProfileStore({
    stateDir,
    initialProfile: createConfiguredVoiceProfile({ env: { MINIMAX_VOICE_ID: "a-different-voice" } }),
  })
  const persisted = await laterStore.load()
  assert.equal(persisted.bindings.minimax.voiceId, "global-approved-voice")
})

test("explicit Mossland selection can use a configured profile without overwriting the persisted MiniMax profile", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-voice-profile-mossland-"))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const minimax = createConfiguredVoiceProfile({ env: { MINIMAX_VOICE_ID: "minimax-voice" } })
  const originalStore = createVoiceProfileStore({ stateDir, initialProfile: minimax })
  await originalStore.load()

  const mossland = createConfiguredVoiceProfile({
    providerId: "mossland",
    env: {
      MOSS_VOICE_ID: "mossland-voice",
      MOSS_TTS_VERSION: "moss-tts-v1.5-flash",
    },
  })
  const selectedStore = createVoiceProfileStore({
    stateDir,
    initialProfile: mossland,
    preferConfiguredProvider: true,
  })

  const selected = await selectedStore.load()
  const persisted = JSON.parse(await fs.readFile(selectedStore.filePath, "utf8"))
  assert.equal(selected.defaultProvider, "mossland")
  assert.equal(selected.bindings.mossland.voiceId, "mossland-voice")
  assert.equal(persisted.defaultProvider, "minimax")
})
