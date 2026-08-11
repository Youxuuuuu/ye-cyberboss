const test = require("node:test")
const assert = require("node:assert/strict")

const {
  createConfiguredSynthesisProvider,
  resolveSynthesisProviderId,
} = require("../src/custom/xiaoye/voice/synthesis-provider")

test("synthesis provider selection defaults to MiniMax and accepts explicit Mossland", () => {
  assert.equal(resolveSynthesisProviderId({}, {}), "minimax")
  assert.equal(resolveSynthesisProviderId({ assistantVoiceProvider: "mossland" }, {}), "mossland")
  assert.equal(resolveSynthesisProviderId({}, { CYBERBOSS_ASSISTANT_VOICE_PROVIDER: "mossland" }), "mossland")
  assert.throws(() => resolveSynthesisProviderId({}, { CYBERBOSS_ASSISTANT_VOICE_PROVIDER: "unknown" }), /not supported/u)

  const provider = createConfiguredSynthesisProvider({
    providerId: "mossland",
    env: {},
    fetchImpl: async () => new Response(),
  })
  assert.equal(provider.id, "mossland")
})
