const { createConversationArchive } = require("./conversation")
const { createMurmurLaneModule } = require("./murmurlane")

function createXiaoyeModules({ config, cyberbossPort } = {}) {
  const conversation = createConversationArchive({ config })
  const murmurlane = createMurmurLaneModule({ config, cyberbossPort })

  return {
    conversation,
    murmurlane,
    async start() {
      return murmurlane.start()
    },
    async close() {
      conversation?.close?.()
      return murmurlane.close()
    },
    handleRuntimeEvent(event, rawEvent) {
      if (event) {
        murmurlane.publishRuntimeEvent(event)
        cyberbossPort.applyRuntimeEventToThreadState?.(event)
      }
      try {
        const result = conversation?.recordRuntimeRaw({
          runtimeId: cyberbossPort.getRuntimeId?.() || "",
          raw: rawEvent,
          mappedEvent: event,
          workspaceRoot: cyberbossPort.resolveConversationWorkspaceRoot?.(event) || "",
        })
        logConversationWarnings(result?.warnings)
        return result
      } catch (error) {
        console.warn(`[cyberboss] conversation runtime archive failed: ${formatErrorMessage(error)}`)
        return null
      }
    },
    recordInbound(prepared, context = {}, { publish = true } = {}) {
      try {
        const result = prepared?.provider === "web" && typeof conversation?.recordMergedWebInbound === "function"
          ? conversation.recordMergedWebInbound(prepared, context)
          : conversation?.recordInboundMessage(prepared, context)
        logConversationWarnings(result?.warnings)
        if (prepared?.provider === "web" && publish) {
          murmurlane.adapter.publishInbound({
            prepared,
            threadId: context.threadId || "",
            turnId: context.turnId || "",
          })
        }
        return result
      } catch (error) {
        console.warn(`[cyberboss] conversation inbound archive failed: ${formatErrorMessage(error)}`)
        return null
      }
    },
  }
}

function logConversationWarnings(warnings = []) {
  for (const warning of Array.isArray(warnings) ? warnings : []) {
    console.warn(`[cyberboss] conversation archive warning: ${warning}`)
  }
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "unknown error")
}

module.exports = { createXiaoyeModules }
