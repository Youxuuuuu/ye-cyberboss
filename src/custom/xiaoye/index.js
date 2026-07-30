const { createChannelRouter } = require("../../adapters/channel/router")
const { createWeixinChannelAdapter } = require("../../adapters/channel/weixin")
const { createProjectTooling } = require("../../tools/create-project-tooling")
const { createConversationArchive } = require("./conversation")
const { createMurmurLaneModule } = require("./murmurlane")
const { createWebChatDeliveryClient } = require("./murmurlane/webchat/delivery-client")

function createXiaoyeModules({ config, cyberbossPort } = {}) {
  const conversation = createConversationArchive({ config })
  const murmurlane = createMurmurLaneModule({
    config,
    cyberbossPort: createMurmurLanePort(cyberbossPort),
    conversationCommands: {
      deleteThreadRecords: (...args) => conversation.deleteThreadRecords(...args),
    },
  })

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
    handleIncomingProvider(normalized) {
      return murmurlane.handleIncomingProvider(normalized)
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
    recordPreparedInbound(prepared, context = {}) {
      return this.recordInbound(prepared, {
        ...context,
        turnId: context.turnId
          || (prepared?.provider === "web" ? prepared.logicalTurnId || "" : ""),
      })
    },
    handleRuntimeTurnStarted({
      prepared,
      turn,
      previousThreadId = "",
    } = {}) {
      const handled = murmurlane.handleRuntimeTurnStarted({
        prepared,
        turn,
        previousThreadId,
      })
      if (!handled) {
        return null
      }
      return handled
    },
  }
}

function createXiaoyeProjectTooling(config, options = {}) {
  const channelAdapter = options.channelAdapter || createChannelRouter({
    weixin: createWeixinChannelAdapter(config),
    web: createWebChatDeliveryClient({ config }),
  })
  return createProjectTooling(config, {
    ...options,
    channelAdapter,
  })
}

function createMurmurLanePort(cyberbossPort) {
  return {
    resolveWeixinAccount: (...args) => cyberbossPort.resolveWeixinAccount(...args),
    getActiveAccountId: (...args) => cyberbossPort.getActiveAccountId(...args),
    getRuntimeAdapter: (...args) => cyberbossPort.getRuntimeAdapter(...args),
    getThreadStateStore: (...args) => cyberbossPort.getThreadStateStore(...args),
    resolveWorkspaceRoot: (...args) => cyberbossPort.resolveWorkspaceRoot(...args),
    routePreparedInbound: (...args) => cyberbossPort.routePreparedInbound(...args),
    findModelByQuery: (...args) => cyberbossPort.findModelByQuery(...args),
    isPathWithinRoot: (...args) => cyberbossPort.isPathWithinRoot(...args),
    buildInboundDraft: (...args) => cyberbossPort.buildInboundDraft(...args),
    buildMergedInboundPrepared: (...args) => cyberbossPort.buildMergedInboundPrepared(...args),
    normalizeWorkspaceRoot: (...args) => cyberbossPort.normalizeWorkspaceRoot(...args),
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

module.exports = { createXiaoyeModules, createXiaoyeProjectTooling }
