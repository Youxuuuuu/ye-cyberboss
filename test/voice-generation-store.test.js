const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")

const { createVoiceGenerationStore } = require("../src/custom/xiaoye/voice/generation-store")

test("generation store keeps profile and delivery plan snapshots for deterministic retry", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-voice-generations-"))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const store = createVoiceGenerationStore({ stateDir })
  const record = {
    schemaVersion: 1,
    generationId: "generation-1",
    kind: "assistant-voice-message",
    threadId: "thread-1",
    spokenText: "今天也要好好的。",
    sourceTextHash: "sha256:abc",
    voiceProfile: { schemaVersion: 1, version: "voice-profile-v1" },
    speechDeliveryPlan: { schemaVersion: 1, version: "speech-delivery-plan-v1" },
    createdAt: "2026-08-09T01:02:03.004Z",
  }
  await store.save(record)
  assert.deepEqual(await store.get("generation-1"), record)
  assert.equal(await store.get("../outside"), null)
})

test("generation store rejects unsafe ids and does not expose malformed records", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-voice-generations-invalid-"))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const store = createVoiceGenerationStore({ stateDir })
  await assert.rejects(store.save({ generationId: "../outside" }), /generationId/u)
})
