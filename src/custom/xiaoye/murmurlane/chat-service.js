const crypto = require("crypto")
const path = require("path")

const { normalizeWebChatSendContract } = require("./webchat/contract")
const { createUserVoiceInput } = require("../voice")
const { createVoiceAssetStore } = require("../voice/asset-store")
const { probeAudioFile } = require("../voice/audio-probe")
const { createVoiceGenerationStore } = require("../voice/generation-store")
const { createConfiguredVoiceProfile, createVoiceProfileStore } = require("../voice/profile-store")
const { createConfiguredSynthesisProvider, resolveSynthesisProviderId } = require("../voice/synthesis-provider")
const { createAssistantVoiceSynthesis } = require("../voice/synthesis-service")

function createMurmurLaneChatService({
  config,
  adapter,
  cyberbossPort,
  conversationCommands = null,
  voiceDependencies = null,
  env = process.env,
} = {}) {
  if (!cyberbossPort || typeof cyberbossPort !== "object") {
    throw new Error("murmurlane chat service requires cyberbossPort")
  }
  const getRuntimeAdapterFromPort = requirePortFunction(cyberbossPort, "getRuntimeAdapter")
  const getThreadStateStoreFromPort = requirePortFunction(cyberbossPort, "getThreadStateStore")
  const getThreadUsageTotals = requirePortFunction(cyberbossPort, "getThreadUsageTotals")
  const deleteThreadUsage = requirePortFunction(cyberbossPort, "deleteThreadUsage")
  const getRuntimeSettings = requirePortFunction(cyberbossPort, "getRuntimeSettings")
  const updateRuntimeSettings = requirePortFunction(cyberbossPort, "updateRuntimeSettings")
  const resolveWorkspaceRoot = requirePortFunction(cyberbossPort, "resolveWorkspaceRoot")
  const routePreparedInbound = requirePortFunction(cyberbossPort, "routePreparedInbound")
  const isPathWithinRoot = requirePortFunction(cyberbossPort, "isPathWithinRoot")
  const buildInboundDraft = requirePortFunction(cyberbossPort, "buildInboundDraft")
  const buildMergedInboundPrepared = requirePortFunction(cyberbossPort, "buildMergedInboundPrepared")
  const normalizeWorkspaceRoot = requirePortFunction(cyberbossPort, "normalizeWorkspaceRoot")
  const userVoiceInput = createUserVoiceInput({
    config,
    env,
    dependencies: voiceDependencies || {},
    stateSink: persistVoiceState,
    submitRuntime: submitVoiceRuntime,
  })
  const assistantVoiceEnabled = resolveEnabled(
    config.assistantVoiceMessageEnabled,
    env.CYBERBOSS_ASSISTANT_VOICE_MESSAGE_ENABLED,
  )
  const speechRenditionEnabled = resolveEnabled(
    config.speechRenditionEnabled,
    env.CYBERBOSS_SPEECH_RENDITION_ENABLED,
    assistantVoiceEnabled,
  )
  const assistantProviderId = resolveSynthesisProviderId(config, env)
  const assistantProvider = voiceDependencies?.assistantProvider || createConfiguredSynthesisProvider({
    providerId: assistantProviderId,
    env,
    fetchImpl: voiceDependencies?.fetchImpl || globalThis.fetch,
    timeoutMs: numberSetting(config.assistantVoiceProviderTimeoutMs, env.CYBERBOSS_ASSISTANT_VOICE_PROVIDER_TIMEOUT_MS, 120_000),
  })
  const assistantVoiceSynthesis = assistantVoiceEnabled || speechRenditionEnabled
    ? (voiceDependencies?.assistantVoiceSynthesis || createAssistantVoiceSynthesis({
        provider: assistantProvider,
        profileStore: voiceDependencies?.assistantProfileStore || createVoiceProfileStore({
          stateDir: config.stateDir,
          initialProfile: createConfiguredVoiceProfile({ env, providerId: assistantProviderId }),
          preferConfiguredProvider: true,
        }),
        generationStore: voiceDependencies?.assistantGenerationStore || createVoiceGenerationStore({ stateDir: config.stateDir }),
        assetStore: voiceDependencies?.assistantAssetStore || createVoiceAssetStore({
          stateDir: config.stateDir,
          maxBytes: numberSetting(config.assistantVoiceMaxBytes, env.CYBERBOSS_ASSISTANT_VOICE_MAX_BYTES, config.webChatMaxUploadBytes || 25 * 1024 * 1024),
          probeAudio: voiceDependencies?.probeAudio || ((input) => probeAudioFile({
            ...input,
            timeoutMs: numberSetting(config.assistantVoiceProbeTimeoutMs, env.CYBERBOSS_ASSISTANT_VOICE_PROBE_TIMEOUT_MS, 5_000),
          })),
        }),
        stateSink: persistAssistantVoiceState,
      }))
    : null

  function getRuntimeAdapter() {
    return requirePortObjectResult(getRuntimeAdapterFromPort(), "getRuntimeAdapter")
  }

  function getThreadStateStore() {
    return requirePortObjectResult(getThreadStateStoreFromPort(), "getThreadStateStore")
  }

  function getWebChatIdentity() {
    let account = null
    try {
      account = cyberbossPort.resolveWeixinAccount?.() || null
    } catch {
      account = null
    }
    return {
      workspaceId: config.workspaceId,
      workspaceRoot: normalizeWorkspaceRoot(config.workspaceRoot),
      accountId: normalizeCommandArgument(
        cyberbossPort.getActiveAccountId?.() || config.accountId || account?.accountId
      ) || "default",
      senderId: normalizeCommandArgument(
        config.webChatSenderId
          || config.allowedUserIds?.[0]
          || account?.userId
      ),
    }
  }

  function resolveWebChatContext(senderId = "") {
    const identity = getWebChatIdentity()
    const normalizedSenderId = normalizeCommandArgument(senderId) || identity.senderId
    if (!normalizedSenderId) {
      throw new Error("CYBERBOSS_WEB_CHAT_SENDER_ID or an allowed WeChat user is required")
    }
    const runtimeAdapter = getRuntimeAdapter()
    const accountId = identity.accountId
    const bindingKey = runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: identity.workspaceId,
      accountId,
      senderId: normalizedSenderId,
    })
    return {
      ...identity,
      senderId: normalizedSenderId,
      accountId,
      bindingKey,
      workspaceRoot: resolveWorkspaceRoot(bindingKey),
    }
  }

  function getWebChatStatus({ senderId = "", threadId = "" } = {}) {
    const context = resolveWebChatContext(senderId)
    const runtimeAdapter = getRuntimeAdapter()
    const threadStateStore = getThreadStateStore()
    const sessionStore = runtimeAdapter.getSessionStore()
    const selectedThreadId = normalizeThreadId(threadId)
      || sessionStore.getThreadIdForWorkspace(context.bindingKey, context.workspaceRoot)
      || ""
    const threadState = selectedThreadId ? threadStateStore.getThreadState(selectedThreadId) : null
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(context.bindingKey, context.workspaceRoot)
    const contextUsage = threadState?.context
      || (!selectedThreadId ? threadStateStore.getLatestContext(runtimeAdapter.describe().id) : null)
    const usageTotals = selectedThreadId
      ? getThreadUsageTotals(selectedThreadId) || null
      : null
    return {
      connected: config.webChatEnabled !== false,
      workspaceId: context.workspaceId,
      threadId: selectedThreadId,
      status: threadState?.status || "idle",
      model: runtimeParams.model || normalizeCommandArgument(runtimeAdapter.describe().model),
      modelProvider: runtimeParams.modelProvider || normalizeCommandArgument(runtimeAdapter.describe().modelProvider),
      effort: normalizeCommandArgument(runtimeParams.effort),
      contextUsage: contextUsage || null,
      usageTotals,
      pendingApproval: threadState?.pendingApproval || null,
      webClients: adapter.getClientCount(),
      eventCursor: adapter.getEventCursor({
        senderId: context.senderId,
        threadId: selectedThreadId,
      }),
      voiceInput: userVoiceInput.getStatus(),
      assistantVoice: {
        enabled: assistantVoiceEnabled,
        ...(assistantProvider.getStatus?.() || { provider: assistantProvider.id || "minimax", configured: false, available: false }),
      },
      speechRendition: {
        enabled: speechRenditionEnabled,
        ...(assistantProvider.getStatus?.() || { provider: assistantProvider.id || "minimax", configured: false, available: false }),
      },
    }
  }

  async function getWebChatModels({ senderId = "" } = {}) {
    const context = resolveWebChatContext(senderId)
    const settings = await getRuntimeSettings({
      bindingKey: context.bindingKey,
      workspaceRoot: context.workspaceRoot,
      refreshCatalog: true,
      waitForCatalogRefresh: false,
    })
    if (!settings || typeof settings !== "object") {
      throw new Error("cyberbossPort.getRuntimeSettings must return runtime settings")
    }
    return settings
  }

  async function setWebChatModel({ senderId = "", model = "", modelProvider = "" } = {}) {
    const context = resolveWebChatContext(senderId)
    const query = normalizeCommandArgument(model)
    if (!query) {
      return getWebChatModels({ senderId: context.senderId })
    }
    return updateWebChatRuntimeSettings({
      senderId: context.senderId,
      model: query,
      modelProvider,
    })
  }

  async function setWebChatEffort({ senderId = "", effort } = {}) {
    const context = resolveWebChatContext(senderId)
    return updateWebChatRuntimeSettings({
      senderId: context.senderId,
      effort,
    })
  }

  async function updateWebChatRuntimeSettings({
    senderId = "",
    model,
    modelProvider,
    effort,
  } = {}) {
    const context = resolveWebChatContext(senderId)
    const runtimeAdapter = getRuntimeAdapter()
    const sessionStore = runtimeAdapter.getSessionStore()
    const selectedThreadId = sessionStore.getThreadIdForWorkspace(context.bindingKey, context.workspaceRoot) || ""
    const settings = await updateRuntimeSettings({
      bindingKey: context.bindingKey,
      workspaceRoot: context.workspaceRoot,
      ...(model !== undefined ? { model } : {}),
      ...(modelProvider !== undefined ? { modelProvider } : {}),
      ...(effort !== undefined ? { effort } : {}),
      senderId: context.senderId,
      threadId: selectedThreadId,
    })
    if (!settings || typeof settings !== "object") {
      throw new Error("cyberbossPort.updateRuntimeSettings must return runtime settings")
    }
    return {
      ...getWebChatStatus({ senderId: context.senderId }),
      runtimeSettings: settings,
    }
  }

  async function selectWebChatThread({ senderId = "", threadId = "", clientId = "" } = {}) {
    const context = resolveWebChatContext(senderId)
    const normalizedThreadId = normalizeThreadId(threadId)
    if (!normalizedThreadId) {
      throw new Error("threadId is required")
    }
    const runtimeAdapter = getRuntimeAdapter()
    const sessionStore = runtimeAdapter.getSessionStore()
    assertThreadRuntimeCompatible({
      sessionStore,
      runtimeAdapter,
      threadId: normalizedThreadId,
    })
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(context.bindingKey, context.workspaceRoot)
    const resumed = await runtimeAdapter.resumeThread({
      threadId: normalizedThreadId,
      workspaceRoot: context.workspaceRoot,
      model: runtimeParams.model,
      modelProvider: runtimeParams.modelProvider,
      effort: runtimeParams.effort,
    })
    const selectedThreadId = normalizeThreadId(resumed?.threadId) || normalizedThreadId
    sessionStore.setThreadIdForWorkspace(
      context.bindingKey,
      context.workspaceRoot,
      selectedThreadId,
      { accountId: context.accountId, senderId: context.senderId },
    )
    adapter.setActiveTarget({
      userId: context.senderId,
      contextToken: `web:${normalizeCommandArgument(clientId) || crypto.randomUUID()}`,
      clientId,
      threadId: selectedThreadId,
    })
    adapter.publish({
      kind: "thread.selected",
      senderId: context.senderId,
      threadId: selectedThreadId,
    })
    return getWebChatStatus({ senderId: context.senderId, threadId: selectedThreadId })
  }

  async function deleteWebChatThread({ threadId = "" } = {}) {
    const normalizedThreadId = normalizeThreadId(threadId)
    if (!normalizedThreadId) {
      const error = new Error("threadId is required")
      error.statusCode = 400
      throw error
    }
    const threadState = getThreadStateStore().getThreadState(normalizedThreadId)
    if (hasActiveThreadWork(threadState)) {
      const error = new Error(
        `thread ${normalizedThreadId} has active work and cannot be deleted`
      )
      error.code = "THREAD_DELETE_BUSY"
      error.statusCode = 409
      throw error
    }
    if (typeof conversationCommands?.deleteThreadRecords !== "function") {
      throw new Error("conversationCommands.deleteThreadRecords is required")
    }
    const result = await conversationCommands.deleteThreadRecords({ threadId: normalizedThreadId })
    deleteThreadUsage(normalizedThreadId)
    return result
  }

  async function handleWebChatMessages({
    senderId = "",
    clientId = "",
    threadId = "",
    newThread = false,
    model = "",
    modelProvider = "",
    effort,
    requestId = "",
    batchId = "",
    messageId = "",
    messages = [],
    text = "",
  } = {}) {
    const context = resolveWebChatContext(senderId)
    const runtimeAdapter = getRuntimeAdapter()
    const sessionStore = runtimeAdapter.getSessionStore()
    const normalizedClientId = normalizeCommandArgument(clientId) || crypto.randomUUID()
    const requestedThreadId = normalizeThreadId(threadId)
    let workspaceRoot = context.workspaceRoot

    const runtimeMismatch = requestedThreadId
      ? getThreadRuntimeMismatch({
          sessionStore,
          runtimeAdapter,
          threadId: requestedThreadId,
        })
      : null
    if (runtimeMismatch) {
      return {
        accepted: false,
        status: "failed",
        error: runtimeMismatch.message,
        errorCode: runtimeMismatch.code,
        requestId: normalizeCommandArgument(requestId),
        messageId: normalizeCommandArgument(messageId),
        logicalTurnId: `web:${normalizeCommandArgument(requestId)}`,
        threadId: requestedThreadId,
        turnId: "",
      }
    }

    if (newThread) {
      await runtimeAdapter.startFreshThreadDraft({ workspaceRoot })
      sessionStore.clearThreadIdForWorkspace(context.bindingKey, workspaceRoot)
    } else if (requestedThreadId) {
      const currentThreadId = sessionStore.getThreadIdForWorkspace(context.bindingKey, workspaceRoot)
      if (currentThreadId !== requestedThreadId) {
        await selectWebChatThread({
          senderId: context.senderId,
          threadId: requestedThreadId,
          clientId: normalizedClientId,
        })
        workspaceRoot = resolveWorkspaceRoot(context.bindingKey)
      }
    }

    const requestedModel = normalizeCommandArgument(model)
    if (requestedModel || effort !== undefined) {
      if (requestedModel && effort !== undefined) {
        await updateWebChatRuntimeSettings({
          senderId: context.senderId,
          model: requestedModel,
          modelProvider,
          effort,
        })
      } else if (requestedModel) {
        await setWebChatModel({
          senderId: context.senderId,
          model: requestedModel,
          modelProvider,
        })
      } else {
        await setWebChatEffort({
          senderId: context.senderId,
          effort,
        })
      }
    }

    const sendContract = normalizeWebChatSendContract({
      requestId,
      batchId,
      messageId,
      messages: Array.isArray(messages) && messages.length
        ? messages.slice(0, 64)
        : [{ text }],
    })
    const rawMessages = sendContract.messages
    const preparedMessages = rawMessages
      .map((message, index) => normalizeWebInboundMessage({
        message,
        index,
        clientId: normalizedClientId,
        context,
        stateDir: config.stateDir,
        isPathWithinRoot,
      }))
      .filter(Boolean)
      .map((message) => buildInboundDraft(message, { attachments: message.attachments }))
    if (!preparedMessages.length || !preparedMessages.some((message) => message.originalText || message.attachments.length)) {
      throw new Error("at least one text or attachment is required")
    }

    const currentThreadId = sessionStore.getThreadIdForWorkspace(context.bindingKey, workspaceRoot) || ""
    const contextToken = `web:${normalizedClientId}`
    adapter.setActiveTarget({
      userId: context.senderId,
      contextToken,
      clientId: normalizedClientId,
      threadId: currentThreadId,
    })
    const prepared = buildMergedInboundPrepared({
      bindingKey: context.bindingKey,
      workspaceRoot,
      messages: preparedMessages,
      requestId: sendContract.requestId,
      messageId: sendContract.messageId,
      logicalTurnId: sendContract.logicalTurnId,
      bubbleSegments: sendContract.messages[0].bubbleSegments,
    })
    const result = await routePreparedInbound({
      bindingKey: context.bindingKey,
      workspaceRoot,
      prepared,
    })
    if (!result) {
      return {
        accepted: false,
        status: "failed",
        requestId: sendContract.requestId,
        messageId: sendContract.messageId,
        logicalTurnId: sendContract.logicalTurnId,
        threadId: currentThreadId,
        turnId: "",
      }
    }
    return {
      ...result,
      status: "accepted",
      requestId: sendContract.requestId,
      messageId: sendContract.messageId,
      logicalTurnId: sendContract.logicalTurnId,
      clientId: normalizedClientId,
      clientMessageId: sendContract.messageId,
      messageIds: [sendContract.messageId],
      threadId: result.threadId || currentThreadId,
    }
  }

  async function handleWebChatVoiceMessage({
    bytes,
    contentType = "",
    senderId = "",
    clientId = "",
    threadId = "",
    newThread = false,
    requestId = "",
    messageId = "",
    receivedAt = "",
    signal = null,
  } = {}) {
    if (!userVoiceInput.enabled) {
      return userVoiceInput.submitUserVoice({})
    }
    const context = resolveWebChatContext(senderId)
    const runtimeAdapter = getRuntimeAdapter()
    const sessionStore = runtimeAdapter.getSessionStore()
    const normalizedClientId = normalizeCommandArgument(clientId) || crypto.randomUUID()
    const requestedThreadId = normalizeThreadId(threadId)
    let workspaceRoot = context.workspaceRoot

    const runtimeMismatch = requestedThreadId
      ? getThreadRuntimeMismatch({ sessionStore, runtimeAdapter, threadId: requestedThreadId })
      : null
    if (runtimeMismatch) {
      const error = new Error(runtimeMismatch.message)
      error.code = runtimeMismatch.code
      error.statusCode = 409
      throw error
    }
    if (newThread) {
      await runtimeAdapter.startFreshThreadDraft({ workspaceRoot })
      sessionStore.clearThreadIdForWorkspace(context.bindingKey, workspaceRoot)
    } else if (requestedThreadId) {
      const currentThreadId = sessionStore.getThreadIdForWorkspace(context.bindingKey, workspaceRoot)
      if (currentThreadId !== requestedThreadId) {
        await selectWebChatThread({ senderId: context.senderId, threadId: requestedThreadId, clientId: normalizedClientId })
        workspaceRoot = resolveWorkspaceRoot(context.bindingKey)
      }
    }
    const currentThreadId = sessionStore.getThreadIdForWorkspace(context.bindingKey, workspaceRoot) || ""
    return userVoiceInput.submitUserVoice({
      bytes,
      contentType,
      requestId,
      messageId,
      threadId: requestedThreadId || currentThreadId,
      senderId: context.senderId,
      clientId: normalizedClientId,
      receivedAt,
      signal,
    })
  }

  async function handleWebChatVoiceRetry({ senderId = "", clientId = "", messageId = "", signal = null } = {}) {
    const command = resolvePersistedVoiceCommand({ senderId, clientId, messageId, signal })
    return userVoiceInput.retryUserVoice(command)
  }

  async function handleWebChatVoiceTranscriptConfirm({
    senderId = "",
    clientId = "",
    messageId = "",
    normalizedText = "",
    signal = null,
  } = {}) {
    const command = resolvePersistedVoiceCommand({ senderId, clientId, messageId, signal })
    return userVoiceInput.confirmTranscript({ ...command, normalizedText })
  }

  async function handleWebChatAssistantVoice({
    senderId = "",
    threadId = "",
    messageId = "",
    itemId = "",
    turnId = "",
    spokenText = "",
    speechDeliveryPlan = null,
    signal = null,
  } = {}) {
    ensureAssistantVoiceEnabled()
    const context = resolveWebChatContext(senderId)
    const currentThreadId = resolveCurrentThreadId(context)
    const result = await assistantVoiceSynthesis.synthesizeAssistantVoice({
      threadId: normalizeThreadId(threadId) || currentThreadId,
      messageId: normalizeCommandArgument(messageId) || crypto.randomUUID(),
      itemId: normalizeCommandArgument(itemId),
      turnId: normalizeCommandArgument(turnId),
      spokenText,
      speechDeliveryPlan,
      signal,
    })
    const delivered = result.kind === "delivered"
    return { accepted: delivered, status: delivered ? "accepted" : "failed", ...result }
  }

  async function handleWebChatAssistantVoiceRetry({ senderId = "", messageId = "", signal = null, useCurrentProfile = false } = {}) {
    ensureAssistantVoiceEnabled()
    const record = conversationCommands?.getAssistantVoiceMessage?.({ messageId: normalizeCommandArgument(messageId) })
    if (!record?.meta?.voiceMessage) {
      const error = new Error("assistant voice message was not found")
      error.statusCode = 404
      throw error
    }
    const result = await assistantVoiceSynthesis.retryAssistantVoice({
      voiceMessage: record.meta.voiceMessage,
      signal,
      useCurrentProfile,
    })
    const delivered = result.kind === "delivered"
    return { accepted: delivered, status: delivered ? "accepted" : "failed", ...result }
  }

  async function handleWebChatSpeechRendition({ senderId = "", messageId = "", signal = null, speechDeliveryPlan = null } = {}) {
    ensureSpeechRenditionEnabled()
    const requestedRecordId = normalizeCommandArgument(messageId)
    const record = conversationCommands?.getAssistantMessage?.({ messageId: requestedRecordId })
    if (!record || record.type !== "assistant" || !normalizeText(record.text)) {
      const error = new Error("assistant text message was not found")
      error.statusCode = 404
      throw error
    }
    const context = resolveWebChatContext(senderId)
    const threadId = normalizeThreadId(record.threadId) || resolveCurrentThreadId(context)
    if (!threadId) {
      const error = new Error("assistant text message has no active thread")
      error.statusCode = 409
      throw error
    }
    const rendition = await assistantVoiceSynthesis.synthesizeSpeechRendition({
      threadId,
      sourceText: record.text,
      existingRendition: record.meta?.speechRendition || null,
      speechDeliveryPlan,
      signal,
    })
    const persistedRecordId = normalizeCommandArgument(record.messageId || record.meta?.messageId)
      || requestedRecordId
      || normalizeCommandArgument(record.itemId || record.meta?.itemId)
    const persisted = conversationCommands?.recordAssistantSpeechRendition?.({
      messageId: persistedRecordId,
      speechRendition: rendition,
    })
    const nextRecord = persisted?.record || {
      ...record,
      threadId,
      meta: { ...record.meta, speechRendition: rendition },
    }
    adapter.publish({
      kind: "message",
      messageKind: "assistant",
      senderId: context.senderId,
      threadId: normalizeThreadId(nextRecord.threadId) || threadId,
      turnId: nextRecord.turnId,
      itemId: nextRecord.itemId,
      record: nextRecord,
    })
    const accepted = rendition.status !== "failed"
    return { accepted, status: accepted ? "accepted" : "failed", rendition }
  }

  function resolvePersistedVoiceCommand({ senderId, clientId, messageId, signal }) {
    const context = resolveWebChatContext(senderId)
    if (typeof conversationCommands?.getWebVoiceMessage !== "function") {
      throw new Error("conversationCommands.getWebVoiceMessage is required for voice recovery")
    }
    const record = conversationCommands.getWebVoiceMessage({ messageId: normalizeCommandArgument(messageId) })
    if (!record || record.type !== "user" || !record.meta?.voiceMessage) {
      const error = new Error("voice message was not found")
      error.statusCode = 404
      throw error
    }
    const attachment = [...(record.meta.attachments || []), ...(record.meta.files || [])]
      .find((item) => item?.kind === "voice" || String(item?.contentType || "").startsWith("audio/"))
    if (!attachment) {
      const error = new Error("voice message asset is unavailable")
      error.statusCode = 409
      throw error
    }
    return {
      requestId: normalizeCommandArgument(record.meta.requestId) || `voice:${record.messageId}`,
      messageId: normalizeCommandArgument(record.messageId || record.meta.messageId),
      threadId: normalizeCommandArgument(record.threadId),
      senderId: context.senderId,
      clientId: normalizeCommandArgument(clientId) || crypto.randomUUID(),
      receivedAt: normalizeCommandArgument(record.timestamp) || new Date().toISOString(),
      voiceMessage: record.meta.voiceMessage,
      attachment,
      signal,
    }
  }

  async function persistVoiceState(snapshot) {
    if (typeof conversationCommands?.upsertVoiceMessage !== "function") {
      throw new Error("conversationCommands.upsertVoiceMessage is required for voice input")
    }
    const context = resolveWebChatContext(snapshot.senderId)
    const prepared = buildVoicePrepared(snapshot, context)
    return conversationCommands.upsertVoiceMessage({
      prepared,
      context: {
        runtimeId: normalizeCommandArgument(getRuntimeAdapter().describe?.().id),
        threadId: snapshot.threadId,
        turnId: snapshot.turnId,
        workspaceRoot: context.workspaceRoot,
      },
    })
  }

  async function persistAssistantVoiceState(snapshot) {
    if (snapshot.kind !== "assistant-voice-message") return null
    if (typeof conversationCommands?.recordAssistantVoiceMessage !== "function") {
      throw new Error("conversationCommands.recordAssistantVoiceMessage is required for assistant voice")
    }
    const context = resolveWebChatContext(snapshot.senderId)
    const messageId = normalizeCommandArgument(snapshot.messageId) || crypto.randomUUID()
    const result = conversationCommands.recordAssistantVoiceMessage({
      voiceMessage: snapshot.voiceMessage,
      messageId,
      itemId: normalizeCommandArgument(snapshot.itemId) || messageId,
      threadId: normalizeThreadId(snapshot.threadId),
      turnId: normalizeCommandArgument(snapshot.turnId),
      runtimeId: normalizeCommandArgument(getRuntimeAdapter().describe?.().id),
      workspaceRoot: context.workspaceRoot,
    })
    adapter.publishAssistantVoice({
      userId: context.senderId,
      voiceMessage: snapshot.voiceMessage,
      threadId: normalizeThreadId(snapshot.threadId),
      turnId: normalizeCommandArgument(snapshot.turnId),
      itemId: normalizeCommandArgument(snapshot.itemId) || messageId,
      messageId,
    })
    return result
  }

  function ensureAssistantVoiceEnabled() {
    if (assistantVoiceEnabled && assistantVoiceSynthesis) return
    const error = new Error("assistant voice message is disabled")
    error.code = "ASSISTANT_VOICE_DISABLED"
    error.statusCode = 404
    throw error
  }

  function ensureSpeechRenditionEnabled() {
    if (speechRenditionEnabled && assistantVoiceSynthesis) return
    const error = new Error("speech rendition is disabled")
    error.code = "SPEECH_RENDITION_DISABLED"
    error.statusCode = 404
    throw error
  }

  function resolveCurrentThreadId(context) {
    const runtimeAdapter = getRuntimeAdapter()
    const sessionStore = runtimeAdapter.getSessionStore()
    return sessionStore.getThreadIdForWorkspace(context.bindingKey, resolveWorkspaceRoot(context.bindingKey)) || ""
  }

  async function submitVoiceRuntime(input) {
    const context = resolveWebChatContext(input.senderId)
    const runtimeAdapter = getRuntimeAdapter()
    const sessionStore = runtimeAdapter.getSessionStore()
    const workspaceRoot = resolveWorkspaceRoot(context.bindingKey)
    const attachment = normalizeWebAttachment(input.attachment, config.stateDir, isPathWithinRoot)
    const draft = buildInboundDraft({
      provider: "web",
      workspaceId: context.workspaceId,
      accountId: context.accountId,
      senderId: context.senderId,
      clientId: input.clientId,
      messageId: input.messageId,
      requestId: input.requestId,
      logicalTurnId: input.logicalTurnId,
      contextToken: `web:${input.clientId}`,
      text: input.runtimeText,
      displayText: input.displayText,
      voiceMessage: input.voiceMessage,
      receivedAt: input.receivedAt,
    }, { attachments: [attachment] })
    const currentThreadId = sessionStore.getThreadIdForWorkspace(context.bindingKey, workspaceRoot) || ""
    adapter.setActiveTarget({
      userId: context.senderId,
      contextToken: `web:${input.clientId}`,
      clientId: input.clientId,
      threadId: currentThreadId || input.threadId,
    })
    const prepared = buildMergedInboundPrepared({
      bindingKey: context.bindingKey,
      workspaceRoot,
      messages: [draft],
      requestId: input.requestId,
      messageId: input.messageId,
      logicalTurnId: input.logicalTurnId,
    })
    prepared.voiceMessage = input.voiceMessage
    prepared.displayText = input.displayText
    prepared.bubbleSegments = []
    return routePreparedInbound({ bindingKey: context.bindingKey, workspaceRoot, prepared })
  }

  function buildVoicePrepared(snapshot, context) {
    const attachment = snapshot.attachment
      ? normalizeWebAttachment(snapshot.attachment, config.stateDir, isPathWithinRoot)
      : null
    return {
      provider: "web",
      workspaceId: context.workspaceId,
      accountId: context.accountId,
      senderId: context.senderId,
      clientId: snapshot.clientId,
      messageId: snapshot.messageId,
      requestId: snapshot.requestId,
      logicalTurnId: snapshot.logicalTurnId,
      contextToken: `web:${snapshot.clientId}`,
      originalText: snapshot.displayText,
      text: snapshot.displayText,
      displayText: snapshot.displayText,
      attachments: attachment ? [attachment] : [],
      voiceMessage: snapshot.voiceMessage,
      receivedAt: snapshot.receivedAt,
    }
  }

  return {
    getWebChatIdentity,
    resolveWebChatContext,
    getWebChatStatus,
    getWebChatModels,
    setWebChatModel,
    setWebChatEffort,
    selectWebChatThread,
    deleteWebChatThread,
    handleWebChatMessages,
    handleWebChatVoiceMessage,
    handleWebChatVoiceRetry,
    handleWebChatVoiceTranscriptConfirm,
    handleWebChatAssistantVoice,
    handleWebChatAssistantVoiceRetry,
    handleWebChatSpeechRendition,
  }
}

function normalizeWebInboundMessage({
  message,
  index,
  clientId,
  context,
  stateDir,
  isPathWithinRoot,
}) {
  if (!message || typeof message !== "object") {
    return null
  }
  const rawText = normalizeText(message.text)
  const bubbleSegments = normalizeWebBubbleSegments(
    message.bubbleSegments,
    stateDir,
    isPathWithinRoot,
  )
  const quoteText = normalizeWebQuote(message.quote)
  const text = bubbleSegments.length
    ? bubbleSegments.map((segment) => {
      const segmentQuote = normalizeWebQuote(segment.quote)
      return segmentQuote
        ? `[Quoted: ${segmentQuote}]\n${segment.text}`.trim()
        : segment.text
    }).filter(Boolean).join("\n\n")
    : (quoteText ? `[Quoted: ${quoteText}]\n${rawText}`.trim() : rawText)
  const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
    .map((item) => normalizeWebAttachment(item, stateDir, isPathWithinRoot))
    .filter(Boolean)
  if (!text && !attachments.length) {
    return null
  }
  return {
    provider: "web",
    workspaceId: context.workspaceId,
    accountId: context.accountId,
    senderId: context.senderId,
    clientId,
    messageId: normalizeCommandArgument(message.messageId) || `web-${clientId}-${index}-${Date.now()}`,
    requestId: normalizeCommandArgument(message.requestId),
    logicalTurnId: normalizeCommandArgument(message.logicalTurnId),
    bubbleSegments,
    contextToken: `web:${clientId}`,
    text,
    quote: quoteText,
    attachments,
    receivedAt: normalizeIsoTime(message.receivedAt) || new Date().toISOString(),
  }
}

function normalizeWebBubbleSegments(segments, stateDir, isPathWithinRoot) {
  return (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment && typeof segment === "object")
    .map((segment) => ({
      segmentId: normalizeCommandArgument(segment.segmentId),
      text: normalizeText(segment.text),
      ...(segment.quote ? { quote: segment.quote } : {}),
      ...(Array.isArray(segment.attachments) && segment.attachments.length
        ? {
          attachments: segment.attachments
            .map((item) => normalizeWebAttachment(item, stateDir, isPathWithinRoot))
            .filter(Boolean),
        }
        : {}),
    }))
    .filter((segment) => segment.segmentId)
}

function normalizeWebQuote(value) {
  if (typeof value === "string") {
    return normalizeText(value).slice(0, 4_000)
  }
  if (!value || typeof value !== "object") {
    return ""
  }
  return normalizeText(value.text || value.title).slice(0, 4_000)
}

function normalizeWebAttachment(item, stateDir, isPathWithinRoot) {
  if (!item || typeof item !== "object") {
    return null
  }
  const kind = normalizeText(item.kind) || "file"
  const url = normalizeText(item.url)
  if (!item.absolutePath && !item.path && !item.relativePath && (kind === "link" || /^https?:\/\//i.test(url))) {
    if (!url) {
      throw new Error("link attachment requires a URL")
    }
    return {
      kind: "link",
      url,
      path: url,
      absolutePath: url,
      fileName: normalizeText(item.fileName) || url,
      contentType: normalizeText(item.contentType) || "text/uri-list",
    }
  }

  const rawPath = normalizeText(item.absolutePath || item.path || item.relativePath)
  if (!rawPath) {
    throw new Error("web attachments must be uploaded before sending")
  }
  const stateRoot = path.resolve(stateDir)
  const absolutePath = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(stateRoot, rawPath))
  if (!isPathWithinRoot(absolutePath, stateRoot)) {
    throw new Error("web attachment path is outside the Cyberboss state directory")
  }
  return {
    ...item,
    kind,
    absolutePath,
    path: absolutePath,
    relativePath: path.relative(stateRoot, absolutePath).replace(/\\/g, "/"),
  }
}

function requirePortObjectResult(value, methodName) {
  if (!value || typeof value !== "object") {
    throw new Error(`cyberbossPort.${methodName} must return an object`)
  }
  return value
}

function assertThreadRuntimeCompatible({ sessionStore, runtimeAdapter, threadId }) {
  const mismatch = getThreadRuntimeMismatch({ sessionStore, runtimeAdapter, threadId })
  if (!mismatch) {
    return
  }
  const error = new Error(mismatch.message)
  error.code = mismatch.code
  error.statusCode = 409
  throw error
}

function getThreadRuntimeMismatch({ sessionStore, runtimeAdapter, threadId }) {
  const normalizedThreadId = normalizeThreadId(threadId)
  const activeRuntimeId = normalizeCommandArgument(runtimeAdapter?.describe?.().id)
  if (!normalizedThreadId || !activeRuntimeId) {
    return null
  }
  let ownerRuntimeId = ""
  try {
    ownerRuntimeId = normalizeCommandArgument(
      sessionStore?.getRuntimeIdForThreadId?.(normalizedThreadId)
    )
  } catch (error) {
    return {
      code: normalizeCommandArgument(error?.code) || "THREAD_RUNTIME_OWNERSHIP_CONFLICT",
      message: error instanceof Error ? error.message : String(error),
    }
  }
  if (!ownerRuntimeId || ownerRuntimeId === activeRuntimeId) {
    return null
  }
  return {
    code: "WEBCHAT_RUNTIME_MISMATCH",
    message: `thread ${normalizedThreadId} belongs to ${ownerRuntimeId}, but ${activeRuntimeId} is active`,
  }
}

function requirePortFunction(port, methodName) {
  const method = port[methodName]
  if (typeof method !== "function") {
    throw new Error(`cyberbossPort.${methodName} is required`)
  }
  return method.bind(port)
}

function normalizeCommandArgument(value) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeThreadId(value) {
  const normalized = normalizeCommandArgument(value)
  if (!normalized) {
    return ""
  }
  return normalized.replace(/\s+/g, "")
}

function hasActiveThreadWork(threadState) {
  if (!threadState || typeof threadState !== "object") {
    return false
  }
  if (threadState.pendingApproval) {
    return true
  }
  const status = normalizeCommandArgument(threadState.status).toLowerCase()
  return !["", "idle", "failed", "completed", "cancelled"].includes(status)
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value)
  if (!normalized) {
    return ""
  }
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString()
}

function resolveEnabled(configValue, envValue, fallback = false) {
  if (typeof configValue === "boolean") return configValue
  const normalized = String(envValue || "").trim().toLowerCase()
  if (!normalized) return fallback
  return ["1", "true", "yes", "on"].includes(normalized)
}

function numberSetting(configValue, envValue, fallback) {
  for (const value of [configValue, envValue]) {
    const number = Number(value)
    if (Number.isFinite(number) && number > 0) return Math.floor(number)
  }
  return fallback
}

module.exports = { createMurmurLaneChatService }
