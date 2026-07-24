const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")

const {
  buildVisibleAssistantRecordFromToolCall,
} = require("../src/custom/xiaoye/conversation/normalize-operation")

test("assistant file, image, and sticker tool results normalize as media-only records", () => {
  const stateDir = path.resolve("D:/state")
  const image = buildVisibleAssistantRecordFromToolCall({
    toolName: "cyberboss_channel_send_file",
    args: { filePath: path.join(stateDir, "inbox", "photo.jpg") },
    stateDir,
  })
  const file = buildVisibleAssistantRecordFromToolCall({
    toolName: "cyberboss_channel_send_file",
    args: { filePath: path.join(stateDir, "inbox", "小诗.txt") },
    stateDir,
  })
  const sticker = buildVisibleAssistantRecordFromToolCall({
    toolName: "cyberboss_sticker_send",
    args: { stickerId: "stk_017" },
    stateDir,
  })

  assert.equal(image.text, "")
  assert.equal(image.meta.attachments.length, 1)
  assert.equal(image.meta.attachments[0].kind, "image")
  assert.equal(image.meta.files.length, 0)

  assert.equal(file.text, "")
  assert.equal(file.meta.attachments.length, 0)
  assert.equal(file.meta.files.length, 1)
  assert.equal(file.meta.files[0].kind, "file")

  assert.equal(sticker.text, "")
  assert.equal(sticker.meta.attachments.length, 1)
  assert.equal(sticker.meta.stickers.length, 1)
  assert.equal(sticker.meta.stickers[0].stickerId, "stk_017")
})
