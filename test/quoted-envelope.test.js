const assert = require("node:assert/strict")
const test = require("node:test")

const { parseQuotedEnvelope } = require("../src/custom/xiaoye/shared/quoted-envelope")

test("quoted envelope supports nested square brackets", () => {
  assert.deepEqual(
    parseQuotedEnvelope("[Quoted: [表情包]]\n萌~"),
    {
      quote: "[表情包]",
      text: "萌~",
    },
  )
})

test("quoted envelope leaves ordinary bracket text unchanged", () => {
  assert.deepEqual(
    parseQuotedEnvelope("今天讨论 [AGENTS.md] 的内容"),
    {
      quote: undefined,
      text: "今天讨论 [AGENTS.md] 的内容",
    },
  )
})

test("quoted envelope leaves an unclosed envelope unchanged", () => {
  assert.deepEqual(
    parseQuotedEnvelope("[Quoted: [cloud_music_play] 287248\n好听哦"),
    {
      quote: undefined,
      text: "[Quoted: [cloud_music_play] 287248\n好听哦",
    },
  )
})
