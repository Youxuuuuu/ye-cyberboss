#!/usr/bin/env node

const os = require("os")
const path = require("path")

const {
  migrateLegacyWebChatConversationDirectory,
} = require("../src/core/conversation/migrate-legacy-webchat")

function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write([
      "Usage:",
      "  npm run conversation:migrate-webchat -- [--state-dir PATH | --conversation-dir PATH] [--write]",
      "",
      "The default mode is dry-run. --write creates a timestamped backup before replacing any JSONL file.",
      "",
    ].join("\n"))
    return
  }

  const stateDir = path.resolve(
    readOption(argv, "--state-dir")
      || process.env.CYBERBOSS_STATE_DIR
      || path.join(os.homedir(), ".cyberboss"),
  )
  const conversationDir = path.resolve(
    readOption(argv, "--conversation-dir")
      || path.join(stateDir, "conversations"),
  )
  const result = migrateLegacyWebChatConversationDirectory({
    conversationDir,
    write: argv.includes("--write"),
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

function readOption(argv, name) {
  const directIndex = argv.indexOf(name)
  if (directIndex >= 0) {
    const value = String(argv[directIndex + 1] || "").trim()
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a path`)
    }
    return value
  }
  const prefix = `${name}=`
  const inline = argv.find((value) => String(value).startsWith(prefix))
  return inline ? String(inline).slice(prefix.length).trim() : ""
}

try {
  main()
} catch (error) {
  process.stderr.write(`[cyberboss] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

