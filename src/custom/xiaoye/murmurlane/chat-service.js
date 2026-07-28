const crypto = require("crypto")
const path = require("path")

const { normalizeWebChatSendContract } = require("./webchat/contract")

function createMurmurLaneChatService({ config, adapter, cyberbossPort } = {}) {
  if (!cyberbossPort || typeof cyberbossPort !== "object") {
    throw new Error("murmurlane chat service requires cyberbossPort")
  }
  const findModelByQuery = requirePortFunction(cyberbossPort, "findModelByQuery")
  const isPathWithinRoot = requirePortFunction(cyberbossPort, "isPathWithinRoot")
  const buildInboundDraft = requirePortFunction(cyberbossPort, "buildInboundDraft")
  const buildMergedInboundPrepared = requirePortFunction(cyberbossPort, "buildMergedInboundPrepared")
  const normalizeWorkspaceRoot = requirePortFunction(cyberbossPort, "normalizeWorkspaceRoot")

  function getRuntimeAdapter() {
    return requirePortObject(cyberbossPort, "getRuntimeAdapter")
  }

  function getThreadStateStore() {
    return requirePortObject(cyberbossPort, "getThreadStateStore")
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
      workspaceRoot: cyberbossPort.resolveWorkspaceRoot(bindingKey),
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
    return {
      connected: config.webChatEnabled !== false,
      workspaceId: context.workspaceId,
      threadId: selectedThreadId,
      status: threadState?.status || "idle",
      model: runtimeParams.model || normalizeCommandArgument(runtimeAdapter.describe().model),
      modelProvider: runtimeParams.modelProvider || normalizeCommandArgument(runtimeAdapter.describe().modelProvider),
      usage: contextUsage || null,
      pendingApproval: threadState?.pendingApproval || null,
      webClients: adapter.getClientCount(),
      eventCursor: adapter.getEventCursor({
        senderId: context.senderId,
        threadId: selectedThreadId,
      }),
    }
  }

  async function getWebChatModels({ senderId = "" } = {}) {
    const context = resolveWebChatContext(senderId)
    const runtimeAdapter = getRuntimeAdapter()
    const sessionStore = runtimeAdapter.getSessionStore()
    const catalog = typeof runtimeAdapter.listAvailableModels === "function"
      ? await runtimeAdapter.listAvailableModels()
      : sessionStore.getAvailableModelCatalog()
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(context.bindingKey, context.workspaceRoot)
    return {
      runtime: runtimeAdapter.describe().id,
      currentModel: runtimeParams.model || normalizeCommandArgument(runtimeAdapter.describe().model),
      currentModelProvider: runtimeParams.modelProvider || normalizeCommandArgument(runtimeAdapter.describe().modelProvider),
      models: Array.isArray(catalog?.models) ? catalog.models : [],
      updatedAt: catalog?.updatedAt || "",
    }
  }

  async function setWebChatModel({ senderId = "", model = "", modelProvider = "" } = {}) {
    const context = resolveWebChatContext(senderId)
    const query = normalizeCommandArgument(model)
    if (!query) {
      return getWebChatModels({ senderId: context.senderId })
    }
    const runtimeAdapter = getRuntimeAdapter()
    const sessionStore = runtimeAdapter.getSessionStore()
    const catalog = typeof runtimeAdapter.listAvailableModels === "function"
      ? await runtimeAdapter.listAvailableModels()
      : sessionStore.getAvailableModelCatalog()
    const runtimeId = runtimeAdapter.describe().id || "runtime"
    let matched = findModelByQuery(catalog?.models || [], query)
    if (!matched && runtimeId !== "codex" && !catalog?.models?.length) {
      matched = { model: query }
    }
    if (!matched) {
      throw new Error(`model not found: ${query}`)
    }
    sessionStore.setRuntimeParamsForWorkspace(context.bindingKey, context.workspaceRoot, {
      model: matched.model,
      ...(modelProvider ? { modelProvider } : {}),
    })
    adapter.publish({
      kind: "model.updated",
      senderId: context.senderId,
      threadId: sessionStore.getThreadIdForWorkspace(context.bindingKey, context.workspaceRoot) || "",
      model: matched.model,
      modelProvider: modelProvider || "",
    })
    return getWebChatStatus({ senderId: context.senderId })
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

  async function handleWebChatMessages({
    senderId = "",
    clientId = "",
    threadId = "",
    newThread = false,
    model = "",
    modelProvider = "",
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
        workspaceRoot = cyberbossPort.resolveWorkspaceRoot(context.bindingKey)
      }
    }

    if (normalizeCommandArgument(model)) {
      await setWebChatModel({
        senderId: context.senderId,
        model,
        modelProvider,
      })
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
    const result = await cyberbossPort.routePreparedInbound({
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

  return {
    getWebChatIdentity,
    resolveWebChatContext,
    getWebChatStatus,
    getWebChatModels,
    setWebChatModel,
    selectWebChatThread,
    handleWebChatMessages,
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

function requirePortObject(port, methodName) {
  const method = port[methodName]
  if (typeof method !== "function") {
    throw new Error(`cyberbossPort.${methodName} is required`)
  }
  const value = method()
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

module.exports = { createMurmurLaneChatService }
