const { ConversationArchive } = require("./recorder")
const { ConversationImporter } = require("./importer")
const { ConversationWriter } = require("./writer")

function createConversationArchive(options = {}) {
  return new ConversationArchive(options)
}

module.exports = {
  ConversationArchive,
  ConversationImporter,
  ConversationWriter,
  createConversationArchive,
}
