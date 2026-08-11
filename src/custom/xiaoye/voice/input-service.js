const path = require("node:path")

const { VoiceInputError } = require("./errors")
const {
  buildRuntimeVoiceText,
  createUserVoiceMessage,
  hasSubstantiveSpeech,
  normalizeVoiceMessage,
} = require("./contract")

function createVoiceInputService({
  assetStore,
  provider,
  stateSink,
  submitRuntime,
  now = () => new Date().toISOString(),
  logger = console,
  transcriptConfidenceThreshold = 0.6,
  affectWaitMs = 5_000,
  workflowTimeoutMs = 130_000,
} = {}) {
  if (typeof assetStore?.persistUserVoice !== "function") throw new TypeError("voice input service requires assetStore")
  const hasCombinedUnderstanding = typeof provider?.understand === "function"
  const hasSplitUnderstanding = typeof provider?.understandTranscript === "function"
    && typeof provider?.understandAffect === "function"
  if (!hasCombinedUnderstanding && !hasSplitUnderstanding) throw new TypeError("voice input service requires provider")
  if (typeof stateSink !== "function") throw new TypeError("voice input service requires stateSink")
  if (typeof submitRuntime !== "function") throw new TypeError("voice input service requires submitRuntime")

  async function submitUserVoice(command = {}) {
    const identity = normalizeCommandIdentity(command)
    const workflow = createWorkflowSignal({ signal: command.signal, timeoutMs: workflowTimeoutMs })
    let voiceMessage = createUserVoiceMessage({
      state: "uploading",
      updatedAt: now(),
      provider: provider.id,
      model: provider.model,
    })
    let attachment = null
    try {
      await emitState({ identity, voiceMessage, attachment, displayText: "", signal: workflow.signal })
      let asset
      try {
        asset = await assetStore.persistUserVoice({
          bytes: command.bytes,
          contentType: command.contentType,
          signal: workflow.signal,
        })
      } catch (error) {
        const reason = normalizeFailureReason(error)
        asset = error?.asset || null
        attachment = asset ? buildCompatibleAttachment(asset) : null
        voiceMessage = normalizeVoiceMessage({
          ...voiceMessage,
          ...(asset ? { asset } : {}),
          processing: { state: "failed", reason, updatedAt: now() },
          transcript: { ...voiceMessage.transcript, status: "failed" },
          affect: { ...voiceMessage.affect, status: affectFailureStatus(reason) },
        })
        await emitState({ identity, voiceMessage, attachment, displayText: "", signal: workflow.signal })
        logOutcome(logger, identity, reason)
        return buildResult({ identity, voiceMessage, attachment, accepted: true })
      }
      attachment = buildCompatibleAttachment(asset)
      voiceMessage = createUserVoiceMessage({
        asset,
        state: "transcribing",
        updatedAt: now(),
        provider: provider.id,
        model: provider.model,
      })
      await emitState({ identity, voiceMessage, attachment, displayText: "", signal: workflow.signal })

      let understanding
      try {
        understanding = await runUnderstanding({ bytes: command.bytes, mimeType: asset.mimeType, signal: workflow.signal })
      } catch (error) {
        return failTranscription({ error, identity, voiceMessage, attachment, displayText: "", signal: workflow.signal })
      }

      return await finishUnderstoodVoice({ identity, voiceMessage, attachment, ...understanding, signal: workflow.signal })
    } finally {
      workflow.dispose()
    }
  }

  async function retryUserVoice(command = {}) {
    const identity = normalizeCommandIdentity(command)
    const workflow = createWorkflowSignal({ signal: command.signal, timeoutMs: workflowTimeoutMs })
    let voiceMessage = normalizeVoiceMessage(command.voiceMessage)
    if (!["transcription-failed", "needs-transcript-review"].includes(voiceMessage.processing.state)) {
      throw new VoiceInputError("unknown", "voice message is not eligible for transcription retry", { statusCode: 409 })
    }
    const asset = voiceMessage.asset
    if (!asset) throw new VoiceInputError("invalid-media", "voice retry requires a permanent asset")
    const attachment = command.attachment || buildCompatibleAttachment(asset)
    try {
      voiceMessage = normalizeVoiceMessage({
        ...voiceMessage,
        processing: { state: "transcribing", reason: null, updatedAt: now() },
        transcript: { ...voiceMessage.transcript, status: "pending" },
        affect: { ...voiceMessage.affect, status: "pending" },
      })
      await emitState({
        identity,
        voiceMessage,
        attachment,
        displayText: normalizeText(voiceMessage.transcript?.normalizedText),
        signal: workflow.signal,
      })
      let understanding
      try {
        understanding = await runUnderstanding({ bytes: command.bytes, mimeType: asset.mimeType, signal: workflow.signal })
      } catch (error) {
        return failTranscription({
          error,
          identity,
          voiceMessage,
          attachment,
          displayText: normalizeText(voiceMessage.transcript?.normalizedText),
          signal: workflow.signal,
        })
      }
      return await finishUnderstoodVoice({
        identity,
        voiceMessage,
        attachment,
        ...understanding,
        preservedOriginalText: voiceMessage.transcript?.originalText,
        signal: workflow.signal,
      })
    } finally {
      workflow.dispose()
    }
  }

  async function confirmTranscript(command = {}) {
    const identity = normalizeCommandIdentity(command)
    const workflow = createWorkflowSignal({ signal: command.signal, timeoutMs: workflowTimeoutMs })
    let voiceMessage = normalizeVoiceMessage(command.voiceMessage)
    if (voiceMessage.processing.state !== "needs-transcript-review" || voiceMessage.transcript?.status !== "needs-review") {
      throw new VoiceInputError("unknown", "voice transcript is not awaiting review", { statusCode: 409 })
    }
    const normalizedText = normalizeText(command.normalizedText)
    if (!hasSubstantiveSpeech({ transcript: normalizedText })) {
      throw new VoiceInputError("no-substantive-speech", "confirmed voice transcript is empty")
    }
    const attachment = command.attachment || buildCompatibleAttachment(voiceMessage.asset)
    voiceMessage = normalizeVoiceMessage({
      ...voiceMessage,
      processing: { state: "analyzing-affect", reason: null, updatedAt: now() },
      transcript: {
        ...voiceMessage.transcript,
        status: "ready",
        normalizedText,
        correctedByUser: true,
      },
    })
    try {
      await emitState({ identity, voiceMessage, attachment, displayText: normalizedText, signal: workflow.signal })
      return await submitReadyVoice({ identity, voiceMessage, attachment, normalizedText, signal: workflow.signal })
    } finally {
      workflow.dispose()
    }
  }

  async function runUnderstanding({ bytes, mimeType, signal }) {
    if (hasCombinedUnderstanding) {
      return { understood: await provider.understand({ bytes, mimeType, signal }), affectTask: null }
    }
    const affectTask = startSplitAffect(provider, { bytes, mimeType, signal })
    const understood = await provider.understandTranscript({ bytes, mimeType, signal })
    return { understood, affectTask }
  }

  async function failTranscription({ error, identity, voiceMessage, attachment, displayText, signal }) {
    const reason = normalizeFailureReason(error)
    const failed = normalizeVoiceMessage({
      ...voiceMessage,
      processing: { state: "transcription-failed", reason, updatedAt: now() },
      transcript: { ...voiceMessage.transcript, status: "failed" },
      affect: { ...voiceMessage.affect, status: affectFailureStatus(reason) },
    })
    await emitState({ identity, voiceMessage: failed, attachment, displayText, signal })
    logOutcome(logger, identity, reason)
    return buildResult({ identity, voiceMessage: failed, attachment, accepted: true })
  }

  async function finishUnderstoodVoice({
    identity,
    voiceMessage,
    attachment,
    understood,
    affectTask = null,
    preservedOriginalText = "",
    signal = null,
  }) {
    const originalText = normalizeText(preservedOriginalText) || normalizeText(understood?.transcript?.originalText)
    const normalizedText = normalizeText(understood?.transcript?.normalizedText || originalText)
    const substantive = hasSubstantiveSpeech({ transcript: normalizedText, audioEvents: understood?.audioEvents })
    const transcriptConfidence = understood?.transcript?.confidence || { kind: "unavailable", value: null }
    const confidenceAllowsSubmit = transcriptConfidence.kind === "model-self-report"
      && transcriptConfidence.value >= transcriptConfidenceThreshold
    const shouldSubmit = substantive && confidenceAllowsSubmit
    const transcriptStatus = shouldSubmit ? "ready" : "needs-review"
    const affect = affectTask ? pendingAffect(provider) : normalizeAffectResult(understood, provider)
    voiceMessage = normalizeVoiceMessage({
      ...voiceMessage,
      processing: shouldSubmit
        ? { state: "analyzing-affect", reason: null, updatedAt: now() }
        : { state: "needs-transcript-review", reason: substantive ? null : "no-substantive-speech", updatedAt: now() },
      transcript: {
        status: transcriptStatus,
        originalText,
        normalizedText,
        correctedByUser: false,
        provider: normalizeText(understood?.provider || provider.id),
        model: normalizeText(understood?.model || provider.model),
        confidence: transcriptConfidence,
      },
      affect,
    })
    await emitState({ identity, voiceMessage, attachment, displayText: normalizedText, signal })

    if (!shouldSubmit) {
      if (affectTask) attachLateAffect({
        affectTask,
        identity,
        voiceMessage,
        attachment,
        displayText: normalizedText,
      })
      logOutcome(logger, identity, substantive ? "transcript-review-required" : "no-substantive-speech")
      return buildResult({ identity, voiceMessage, attachment, accepted: true })
    }

    if (affectTask) {
      const outcome = await waitForAffect(affectTask, affectWaitMs)
      if (outcome.kind === "timed-out") {
        voiceMessage = normalizeVoiceMessage({
          ...voiceMessage,
          affect: { ...pendingAffect(provider), status: "timed-out" },
        })
        await emitState({ identity, voiceMessage, attachment, displayText: normalizedText, signal })
        const result = await submitReadyVoice({ identity, voiceMessage, attachment, normalizedText, signal })
        attachLateAffect({
          affectTask,
          identity: { ...identity, threadId: result.threadId, turnId: result.turnId },
          voiceMessage: result.voiceMessage,
          attachment,
          displayText: normalizedText,
        })
        return result
      }
      voiceMessage = normalizeVoiceMessage({
        ...voiceMessage,
        affect: normalizeSplitAffectOutcome(outcome, provider),
      })
      await emitState({ identity, voiceMessage, attachment, displayText: normalizedText, signal })
    }

    return submitReadyVoice({ identity, voiceMessage, attachment, normalizedText, signal })
  }

  function attachLateAffect({ affectTask, identity, voiceMessage, attachment, displayText }) {
    void affectTask.then(async (outcome) => {
      const updated = normalizeVoiceMessage({
        ...voiceMessage,
        affect: normalizeSplitAffectOutcome(outcome, provider),
      })
      await emitState({ identity, voiceMessage: updated, attachment, displayText })
    }).catch((error) => logOutcome(logger, identity, normalizeFailureReason(error)))
  }

  async function submitReadyVoice({ identity, voiceMessage, attachment, normalizedText, signal = null }) {
    let runtimeResult
    try {
      runtimeResult = await awaitWithSignal(() => submitRuntime({
        ...identity,
        displayText: normalizedText,
        runtimeText: buildRuntimeVoiceText({ transcript: normalizedText, affect: voiceMessage.affect }),
        voiceMessage,
        attachment,
        signal,
      }), signal)
    } catch (error) {
      runtimeResult = { accepted: false, error }
    }
    if (!runtimeResult?.accepted) {
      const reason = normalizeFailureReason(runtimeResult?.error)
      voiceMessage = normalizeVoiceMessage({
        ...voiceMessage,
        processing: { state: "failed", reason, updatedAt: now() },
      })
      await emitState({ identity, voiceMessage, attachment, displayText: normalizedText })
      logOutcome(logger, identity, "runtime-submit-failed")
      return buildResult({ identity, voiceMessage, attachment, accepted: true, runtimeResult })
    }

    voiceMessage = normalizeVoiceMessage({
      ...voiceMessage,
      processing: { state: "delivered", reason: null, updatedAt: now() },
    })
    const finalIdentity = {
      ...identity,
      threadId: normalizeText(runtimeResult.threadId) || identity.threadId,
      turnId: normalizeText(runtimeResult.turnId),
    }
    await emitState({ identity: finalIdentity, voiceMessage, attachment, displayText: normalizedText, signal })
    return buildResult({ identity: finalIdentity, voiceMessage, attachment, accepted: true, runtimeResult })
  }

  async function emitState({ identity, voiceMessage, attachment, displayText, signal = null }) {
    return awaitWithSignal(() => stateSink({ ...identity, voiceMessage, attachment, displayText, signal }), signal)
  }

  return { submitUserVoice, retryUserVoice, confirmTranscript }
}

function normalizeAffectResult(understood, provider) {
  const providerId = normalizeText(understood?.provider || provider?.id)
  const model = normalizeText(understood?.model || provider?.model)
  if (understood?.affectFailure) {
    return {
      status: understood.affectFailure.status === "provider-rejected" ? "provider-rejected" : "failed",
      provider: providerId,
      model,
      label: null,
      description: null,
      confidence: { kind: "unavailable", value: null },
      qualityFlags: [],
    }
  }
  if (!understood?.affect) {
    return {
      status: "unavailable",
      provider: providerId,
      model,
      label: null,
      description: null,
      confidence: { kind: "unavailable", value: null },
      qualityFlags: [],
    }
  }
  return {
    status: "ready",
    provider: providerId,
    model,
    label: understood.affect.label,
    description: understood.affect.description,
    confidence: understood.affect.confidence || { kind: "unavailable", value: null },
    qualityFlags: Array.isArray(understood.affect.qualityFlags) ? understood.affect.qualityFlags : [],
  }
}

function pendingAffect(provider) {
  return {
    status: "pending",
    provider: normalizeText(provider?.id),
    model: normalizeText(provider?.model),
    label: null,
    description: null,
    confidence: { kind: "unavailable", value: null },
    qualityFlags: [],
  }
}

function startSplitAffect(provider, input) {
  return Promise.resolve()
    .then(() => provider.understandAffect(input))
    .then(
      (value) => ({ kind: "ready", value }),
      (error) => ({ kind: "failed", error }),
    )
}

function waitForAffect(affectTask, waitMs) {
  const timeoutMs = Math.max(0, Number(waitMs) || 0)
  if (timeoutMs === 0) return Promise.resolve({ kind: "timed-out" })
  let timer
  return Promise.race([
    affectTask,
    new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
}

function normalizeSplitAffectOutcome(outcome, provider) {
  if (outcome?.kind === "ready") return normalizeAffectResult(outcome.value, provider)
  const reason = normalizeFailureReason(outcome?.error)
  return {
    ...pendingAffect(provider),
    status: affectFailureStatus(reason),
  }
}

function buildCompatibleAttachment(asset) {
  const fileName = path.posix.basename(asset.relativePath)
  return {
    kind: "voice",
    contentType: asset.mimeType,
    fileName,
    relativePath: `MLane/voice/${asset.relativePath}`,
    sizeBytes: asset.sizeBytes,
    durationMs: asset.durationMs,
  }
}

function normalizeCommandIdentity(command) {
  const requestId = requiredText(command.requestId, "requestId")
  const messageId = requiredText(command.messageId, "messageId")
  return {
    requestId,
    messageId,
    logicalTurnId: `web:${requestId}`,
    threadId: normalizeText(command.threadId),
    turnId: "",
    senderId: requiredText(command.senderId, "senderId"),
    clientId: requiredText(command.clientId, "clientId"),
    receivedAt: normalizeIsoTime(command.receivedAt) || new Date().toISOString(),
  }
}

function normalizeFailureReason(error) {
  const allowed = new Set([
    "invalid-media", "unsupported-media", "too-large", "too-long", "provider-unconfigured",
    "provider-rejected", "provider-timeout", "provider-unavailable", "malformed-provider-output",
    "no-substantive-speech", "cancelled", "unknown",
  ])
  return error instanceof VoiceInputError && allowed.has(error.reason) ? error.reason : "unknown"
}

function affectFailureStatus(reason) {
  if (reason === "provider-timeout") return "timed-out"
  if (reason === "provider-rejected") return "provider-rejected"
  if (reason === "provider-unconfigured" || reason === "provider-unavailable") return "unavailable"
  return "failed"
}

function buildResult({ identity, voiceMessage, attachment, accepted, runtimeResult = null }) {
  return {
    accepted,
    status: accepted ? "accepted" : "failed",
    requestId: identity.requestId,
    messageId: identity.messageId,
    logicalTurnId: identity.logicalTurnId,
    threadId: identity.threadId,
    turnId: identity.turnId || normalizeText(runtimeResult?.turnId),
    voiceMessage,
    attachment,
  }
}

function logOutcome(logger, identity, reason) {
  logger?.warn?.(`[voice-input] request=${safeLogToken(identity.requestId)} message=${safeLogToken(identity.messageId)} outcome=${safeLogToken(reason)}`)
}

function createWorkflowSignal({ signal, timeoutMs }) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener?.("abort", onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const timer = setTimeout(() => controller.abort(new VoiceInputError(
    "provider-timeout",
    "voice workflow deadline exceeded",
    { statusCode: 504 },
  )), Number(timeoutMs) || 130_000)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener?.("abort", onAbort)
    },
  }
}

function awaitWithSignal(factory, signal) {
  if (!signal) return Promise.resolve().then(factory)
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }
    const onAbort = () => settle(reject, abortReason(signal))
    signal.addEventListener("abort", onAbort, { once: true })
    Promise.resolve()
      .then(factory)
      .then((value) => settle(resolve, value), (error) => settle(reject, error))
  })
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  return new VoiceInputError("cancelled", "voice workflow was cancelled", { statusCode: 499 })
}

function safeLogToken(value) {
  return normalizeText(value).replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 128) || "unknown"
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value)
  if (!normalized) return ""
  const time = Date.parse(normalized)
  return Number.isNaN(time) ? "" : new Date(time).toISOString()
}

function requiredText(value, label) {
  const normalized = normalizeText(value)
  if (!normalized) throw new VoiceInputError("unknown", `voice command requires ${label}`)
  return normalized
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = { createVoiceInputService, buildCompatibleAttachment }
