const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const MAX_EVENT_LOG_SIZE = 2_000;
const MAX_UPLOAD_FILE_NAME_LENGTH = 120;
const WEB_CHAT_EVENT_PROTOCOL_VERSION = 2;

function createWebChatChannelAdapter({ config }) {
  const clients = new Set();
  const activeTargets = new Map();
  const eventLog = [];
  let nextCursor = Date.now();

  function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function normalizeSenderId(value) {
    return normalizeText(value);
  }

  function buildEvent(event = {}) {
    const cursor = ++nextCursor;
    return {
      cursor,
      id: `web-${cursor}-${crypto.randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      senderId: normalizeSenderId(event.senderId),
      threadId: normalizeText(event.threadId),
      ...event,
      protocolVersion: WEB_CHAT_EVENT_PROTOCOL_VERSION,
      cursor,
    };
  }

  function matchesClient(event, client) {
    if (event.senderId && event.senderId !== client.senderId) {
      return false;
    }
    return !client.threadId
      || !event.threadId
      || event.threadId === client.threadId
      || event.previousThreadId === client.threadId;
  }

  function send(client, event) {
    try {
      client.response.write(`id: ${event.cursor}\n`);
      client.response.write("event: chat\n");
      client.response.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      clients.delete(client);
    }
  }

  function publish(event = {}) {
    const payload = buildEvent(event);
    eventLog.push(payload);
    if (eventLog.length > MAX_EVENT_LOG_SIZE) {
      eventLog.splice(0, eventLog.length - MAX_EVENT_LOG_SIZE);
    }
    clients.forEach((client) => {
      if (matchesClient(payload, client)) {
        send(client, payload);
        if (
          payload.kind === "thread.created"
          && payload.threadId
          && payload.previousThreadId
          && client.threadId === payload.previousThreadId
        ) {
          client.threadId = payload.threadId;
        }
      }
    });
    return payload;
  }

  function setActiveTarget({ userId, contextToken, clientId = "", threadId = "" } = {}) {
    const normalizedUserId = normalizeSenderId(userId);
    const normalizedContextToken = normalizeText(contextToken);
    if (!normalizedUserId || !normalizedContextToken) {
      return null;
    }
    const target = {
      userId: normalizedUserId,
      contextToken: normalizedContextToken,
      provider: "web",
      clientId: normalizeText(clientId),
      threadId: normalizeText(threadId),
      lastSeenAt: Date.now(),
    };
    activeTargets.set(normalizedUserId, target);
    return { ...target };
  }

  function clearActiveTarget(userId) {
    const normalizedUserId = normalizeSenderId(userId);
    if (!normalizedUserId) {
      return null;
    }
    const target = activeTargets.get(normalizedUserId) || null;
    activeTargets.delete(normalizedUserId);
    return target ? { ...target } : null;
  }

  function getReplyTarget(userId) {
    const normalizedUserId = normalizeSenderId(userId);
    const target = activeTargets.get(normalizedUserId);
    if (!target) {
      return null;
    }
    if (Date.now() - target.lastSeenAt > 10 * 60_000) {
      activeTargets.delete(normalizedUserId);
      return null;
    }
    return { ...target };
  }

  function subscribe(response, { senderId = "", threadId = "", after = 0, clientId = "" } = {}) {
    const client = {
      response,
      senderId: normalizeSenderId(senderId),
      threadId: normalizeText(threadId),
      clientId: normalizeText(clientId) || crypto.randomUUID(),
    };
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();
    response.write("retry: 3000\n\n");
    const cursor = Number(after);
    eventLog
      .filter((event) => Number.isFinite(cursor) && event.cursor > cursor)
      .filter((event) => matchesClient(event, client))
      .forEach((event) => send(client, event));

    clients.add(client);
    response.on("close", () => {
      clients.delete(client);
      const target = activeTargets.get(client.senderId);
      if (target?.clientId && target.clientId === client.clientId) {
        activeTargets.delete(client.senderId);
      }
    });

    publish({
      kind: "ready",
      senderId: client.senderId,
      threadId: client.threadId,
      connected: true,
      clientId: client.clientId,
    });

    return () => clients.delete(client);
  }

  function publishInbound({ prepared, threadId = "", turnId = "" } = {}) {
    if (!prepared) return null;
    const bubbleSegments = normalizeBubbleSegments(prepared.bubbleSegments);
    const text = bubbleSegments.map((segment) => segment.text).filter(Boolean).join("\n\n")
      || normalizeText(prepared.originalText || prepared.text);
    const quote = extractQuoteText(text);
    const visibleText = quote
      ? text.replace(/^\[Quoted:\s*[^\]]+\]\s*\r?\n/i, "").trim()
      : text;
    const turnIdentity = normalizeTurnIdentity({
      requestId: prepared.requestId,
      messageId: prepared.messageId,
      logicalTurnId: prepared.logicalTurnId,
      displayTurnId: prepared.logicalTurnId,
      transportTurnId: turnId,
    });
    const record = {
      id: `web-inbound-${normalizeText(prepared.messageId) || crypto.randomUUID()}`,
      messageId: normalizeText(prepared.messageId),
      type: "user",
      role: "user",
      timestamp: prepared.receivedAt || new Date().toISOString(),
      threadId: normalizeText(threadId),
      turnId: normalizeText(turnId),
      text: visibleText,
      meta: {
        messageId: normalizeText(prepared.messageId),
        ...(normalizeText(prepared.requestId) ? { requestId: normalizeText(prepared.requestId) } : {}),
        ...turnIdentity,
        ...(bubbleSegments.length ? { bubbleSegments } : {}),
        sourceKey: `web|message|${normalizeText(prepared.messageId)}`,
        ...(quote ? { quote } : {}),
        ...(Array.isArray(prepared.attachments) && prepared.attachments.length
          ? { attachments: prepared.attachments }
          : {}),
        ephemeral: true,
      },
    };
    return publish({
      kind: "message",
      messageKind: "user",
      senderId: prepared.senderId,
      threadId: record.threadId,
      turnId: record.turnId,
      ...turnIdentity,
      record,
    });
  }

  function publishRuntimeEvent(event) {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId || event?.payload?.transportTurnId);
    const turnIdentity = normalizeTurnIdentity(event?.payload);
    const senderId = resolveSenderIdForThread(threadId);
    if (!event?.type) return null;

    if (event.type === "runtime.context.updated") {
      return publish({
        kind: "usage",
        senderId,
        threadId,
        turnId,
        ...turnIdentity,
        usage: event.payload,
      });
    }

    if (event.type === "runtime.reply.delta") {
      return publish({
        kind: "assistant.delta",
        senderId,
        threadId,
        turnId,
        ...turnIdentity,
        itemId: normalizeText(event.payload.itemId),
        text: normalizeText(event.payload.text),
      });
    }

    if (event.type === "runtime.reply.completed") {
      return publish({
        kind: "assistant.partial",
        senderId,
        threadId,
        turnId,
        ...turnIdentity,
        itemId: normalizeText(event.payload.itemId),
        text: normalizeText(event.payload.text),
      });
    }

    if (event.type === "runtime.turn.started") {
      return publish({ kind: "turn.started", senderId, threadId, turnId, ...turnIdentity });
    }

    if (event.type === "runtime.turn.correlated") {
      return publish({ kind: "turn.correlated", senderId, threadId, turnId, ...turnIdentity });
    }

    if (event.type === "runtime.turn.completed") {
      return publish({ kind: "turn.completed", senderId, threadId, turnId, ...turnIdentity });
    }

    if (event.type === "runtime.turn.failed") {
      return publish({
        kind: "error",
        senderId,
        threadId,
        turnId,
        ...turnIdentity,
        text: normalizeText(event.payload.text) || "执行失败",
      });
    }

    if (event.type === "runtime.approval.requested") {
      return publish({
        kind: "approval",
        senderId,
        threadId,
        turnId,
        ...turnIdentity,
        approval: event.payload,
      });
    }

    return null;
  }

  function resolveSenderIdForThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    for (const [senderId, target] of activeTargets.entries()) {
      if (target.threadId && target.threadId === normalizedThreadId) {
        return senderId;
      }
    }
    return normalizeSenderId(config.webChatSenderId) || normalizeSenderId(config.allowedUserIds?.[0]);
  }

  function sendText({
    userId,
    text,
    threadId = "",
    turnId = "",
    itemId = "",
    messageId = "",
    requestId = "",
    logicalTurnId = "",
    displayTurnId = "",
    transportTurnId = "",
    canonicalTurnId = "",
  } = {}) {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) return Promise.resolve();
    const quote = extractQuoteText(normalizedText);
    const visibleText = quote
      ? normalizedText.replace(/^\[Quoted:\s*[^\]]+\]\s*\r?\n/i, "").trim()
      : normalizedText;
    const stableItemId = normalizeText(itemId) || normalizeText(messageId) || crypto.randomUUID();
    const turnIdentity = normalizeTurnIdentity({
      requestId,
      messageId,
      logicalTurnId,
      displayTurnId,
      transportTurnId: transportTurnId || turnId,
      canonicalTurnId,
    });
    const record = {
      id: `web-assistant-${stableItemId}`,
      itemId: stableItemId,
      type: "assistant",
      role: "assistant",
      timestamp: new Date().toISOString(),
      threadId: normalizeText(threadId),
      turnId: normalizeText(turnId),
      text: visibleText,
      meta: {
        itemId: stableItemId,
        ...turnIdentity,
        sourceKey: ["web", normalizeText(threadId), normalizeText(turnId), stableItemId, "assistant"].filter(Boolean).join("|"),
        ...(quote ? { quote } : {}),
        ephemeral: true,
        source: "webchat",
      },
    };
    publish({
      kind: "message",
      messageKind: "assistant",
      senderId: userId,
      threadId: record.threadId,
      turnId: record.turnId,
      itemId: stableItemId,
      ...turnIdentity,
      record,
    });
    return Promise.resolve();
  }

  function sendTyping({ userId, status = 1, threadId = "", turnId = "" } = {}) {
    publish({
      kind: "typing",
      senderId: userId,
      threadId,
      turnId,
      status: Number(status) ? 1 : 0,
    });
    return Promise.resolve();
  }

  function sendFile({
    userId,
    filePath,
    threadId = "",
    turnId = "",
    itemId = "",
    messageId = "",
    requestId = "",
    logicalTurnId = "",
    displayTurnId = "",
    transportTurnId = "",
    canonicalTurnId = "",
    file = null,
  } = {}) {
    const media = file || {
      kind: inferKindFromFilePath(filePath),
      fileName: path.basename(String(filePath || "")),
      path: filePath,
    };
    const stableItemId = normalizeText(itemId) || normalizeText(messageId) || crypto.randomUUID();
    const turnIdentity = normalizeTurnIdentity({
      requestId,
      messageId,
      logicalTurnId,
      displayTurnId,
      transportTurnId: transportTurnId || turnId,
      canonicalTurnId,
    });
    const record = {
      id: `web-assistant-file-${stableItemId}`,
      itemId: stableItemId,
      type: "assistant",
      role: "assistant",
      timestamp: new Date().toISOString(),
      threadId: normalizeText(threadId),
      turnId: normalizeText(turnId),
      text: "",
      meta: {
        itemId: stableItemId,
        ...turnIdentity,
        sourceKey: ["web", normalizeText(threadId), normalizeText(turnId), stableItemId, "assistant"].filter(Boolean).join("|"),
        files: [media],
        ephemeral: true,
        source: "webchat",
      },
    };
    publish({
      kind: "message",
      messageKind: "assistant",
      senderId: userId,
      threadId: record.threadId,
      turnId: record.turnId,
      itemId: stableItemId,
      ...turnIdentity,
      record,
    });
    return Promise.resolve({ filePath });
  }

  async function persistUpload({
    bytes = null,
    fileName = "attachment",
    contentType = "application/octet-stream",
    kind = "file",
  } = {}) {
    const payload = Buffer.isBuffer(bytes)
      ? bytes
      : bytes instanceof Uint8Array
        ? Buffer.from(bytes)
        : Buffer.alloc(0);
    const maxBytes = Number(config.webChatMaxUploadBytes) || 25 * 1024 * 1024;
    if (!payload.length || payload.length > maxBytes) {
      throw new Error(`upload must be between 1 byte and ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }

    const safeContentType = normalizeContentType(contentType) || "application/octet-stream";
    const safeKind = normalizeText(kind) || inferKind(safeContentType, fileName);
    const targetDir = path.join(config.stateDir, "inbox", dateFolder());
    await fs.mkdir(targetDir, { recursive: true });
    const safeName = sanitizeFileName(fileName, safeContentType, safeKind);
    const absolutePath = await writeUniqueFile(targetDir, safeName, payload);
    const relativePath = path.relative(config.stateDir, absolutePath).replace(/\\/g, "/");

    return {
      kind: safeKind,
      contentType: safeContentType,
      isImage: safeContentType.startsWith("image/") || safeKind === "sticker",
      sourceFileName: String(fileName || "").trim(),
      fileName: path.basename(absolutePath),
      absolutePath,
      relativePath,
      path: absolutePath,
      sizeBytes: payload.length,
      url: `/api/chat/media?path=${encodeURIComponent(absolutePath)}`,
    };
  }

  return {
    describe() {
      return {
        id: "webchat",
        kind: "channel",
        host: config.webChatHost,
        port: config.webChatPort,
        enabled: config.webChatEnabled !== false,
      };
    },
    subscribe,
    publish,
    publishInbound,
    publishRuntimeEvent,
    getReplyTarget,
    setActiveTarget,
    clearActiveTarget,
    getRecentEvents(after = 0) {
      const cursor = Number(after);
      return eventLog.filter((event) => Number.isFinite(cursor) && event.cursor > cursor);
    },
    getEventCursor() {
      return nextCursor;
    },
    sendText,
    sendTyping,
    sendFile,
    persistUpload,
    getClientCount() {
      return clients.size;
    },
  };
}

function normalizeBubbleSegments(segments = []) {
  return (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment && typeof segment === "object")
    .map((segment) => ({
      segmentId: normalizeString(segment.segmentId),
      text: normalizeString(segment.text),
      ...(segment.quote ? { quote: segment.quote } : {}),
      ...(Array.isArray(segment.attachments) && segment.attachments.length
        ? { attachments: segment.attachments }
        : {}),
    }))
    .filter((segment) => segment.segmentId);
}

function normalizeTurnIdentity(identity = {}) {
  const requestId = normalizeString(identity.requestId);
  const messageId = normalizeString(identity.messageId);
  const logicalTurnId = normalizeString(identity.logicalTurnId);
  const displayTurnId = normalizeString(identity.displayTurnId) || logicalTurnId;
  const transportTurnId = normalizeString(identity.transportTurnId);
  const canonicalTurnId = normalizeString(identity.canonicalTurnId);
  return {
    ...(requestId ? { requestId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(logicalTurnId ? { logicalTurnId } : {}),
    ...(displayTurnId ? { displayTurnId } : {}),
    ...(transportTurnId ? { transportTurnId } : {}),
    ...(canonicalTurnId ? { canonicalTurnId } : {}),
  };
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function extractQuoteText(text) {
  const match = String(text || "").match(/^\[Quoted:\s*([^\]]+)\]\s*\r?\n/i);
  return match?.[1]?.trim() || "";
}

function normalizeContentType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function inferKind(contentType, fileName) {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "voice";
  if (contentType.startsWith("video/")) return "video";
  if (/^https?:\/\//i.test(String(fileName || ""))) return "link";
  return "file";
}

function inferKindFromFilePath(filePath) {
  const value = String(filePath || "").toLowerCase();
  if (/\.(mp3|m4a|wav|ogg|oga|webm|aac|flac)$/.test(value)) return "voice";
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(value)) return "image";
  return "file";
}

function dateFolder() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function sanitizeFileName(fileName, contentType, kind) {
  const raw = String(fileName || "").trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
  const parsed = path.parse(raw || `${kind || "attachment"}-${Date.now()}`);
  const baseName = (parsed.name || "attachment").slice(0, MAX_UPLOAD_FILE_NAME_LENGTH);
  const extension = parsed.ext || inferExtension(contentType, kind);
  return `${baseName}${extension.slice(0, 16)}`;
}

function inferExtension(contentType, kind) {
  const map = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return map[contentType] || (kind === "voice" ? ".webm" : ".bin");
}

async function writeUniqueFile(targetDir, fileName, bytes) {
  const parsed = path.parse(fileName);
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(targetDir, `${parsed.name}${suffix}${parsed.ext}`);
    try {
      await fs.writeFile(candidate, bytes, { flag: "wx" });
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("unable to allocate a unique upload file name");
}

module.exports = { createWebChatChannelAdapter };
