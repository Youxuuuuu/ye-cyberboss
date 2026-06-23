const { ClaudeCodeParser } = require("./claudecode-import")

function createClaudeCodeRealtimeParser() {
  return new ClaudeCodeParser({ mode: "realtime" })
}

module.exports = {
  createClaudeCodeRealtimeParser,
}
