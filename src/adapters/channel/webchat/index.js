const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const MAX_EVENT_LOG_SIZE = 2_000;
const MAX_UPLOAD_FILE_NAME_LENGTH = 120;

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
    const text = normalizeText(prepared.originalText || prepared.text);
    const quote = extractQuoteText(text);
    const visibleText = quote
      ? text.replace(/^\[Quoted:\s*[^\]]+\]\s*\r?\n/i, "").trim()
      : text;
    const record = {
      id: `web-inbound-${normalizeText(prepared.messageId) || crypto.randomUUID()}`,
      type: "user",
      role: "user",
      timestamp: prepared.receivedAt || new Date().toISOString(),
      threadId: normalizeText(threadId),
      turnId: normalizeText(turnId),
      text: visibleText,
      meta: {
        messageId: normalizeText(prepared.messageId),
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
      record,
    });
  }

  function publishRuntimeEvent(event) {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    const senderId = resolveSenderIdForThread(threadId);
    if (!event?.type) return null;

    if (event.type === "runtime.context.updated") {
      return publish({
        kind: "usage",
        senderId,
        threadId,
        turnId,
        usage: event.payload,
      });
    }

    if (event.type === "runtime.reply.delta") {
      return publish({
        kind: "assistant.delta",
        senderId,
        threadId,
        turnId,
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
        itemId: normalizeText(event.payload.itemId),
        text: normalizeText(event.payload.text),
      });
    }

    if (event.type === "runtime.turn.started") {
      return publish({ kind: "turn.started", senderId, threadId, turnId });
    }

    if (event.type === "runtime.turn.completed") {
      return publish({ kind: "turn.completed", senderId, threadId, turnId });
    }

    if (event.type === "runtime.turn.failed") {
      return publish({
        kind: "error",
        senderId,
        threadId,
        turnId,
        text: normalizeText(event.payload.text) || "执行失败",
      });
    }

    if (event.type === "runtime.approval.requested") {
      return publish({
        kind: "approval",
        senderId,
        threadId,
        turnId,
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

  function sendText({ userId, text, threadId = "", turnId = "", messageId = "" } = {}) {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) return Promise.resolve();
    const quote = extractQuoteText(normalizedText);
    const visibleText = quote
      ? normalizedText.replace(/^\[Quoted:\s*[^\]]+\]\s*\r?\n/i, "").trim()
      : normalizedText;
    const record = {
      id: `web-assistant-${normalizeText(messageId) || crypto.randomUUID()}`,
      type: "assistant",
      role: "assistant",
      timestamp: new Date().toISOString(),
      threadId: normalizeText(threadId),
      turnId: normalizeText(turnId),
      text: visibleText,
      meta: {
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

  function sendFile({ userId, filePath, threadId = "", turnId = "", file = null } = {}) {
    const media = file || {
      kind: inferKindFromFilePath(filePath),
      fileName: path.basename(String(filePath || "")),
      path: filePath,
    };
    const record = {
      id: `web-assistant-file-${crypto.randomUUID()}`,
      type: "assistant",
      role: "assistant",
      timestamp: new Date().toISOString(),
      threadId: normalizeText(threadId),
      turnId: normalizeText(turnId),
      text: "",
      meta: {
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
      record,
    });
    return Promise.resolve({ filePath });
  }

  async function persistUpload({
    dataUrl = "",
    fileName = "attachment",
    contentType = "application/octet-stream",
    kind = "file",
  } = {}) {
    const match = String(dataUrl).match(/^data:([^;,]+);base64,([a-z0-9+/=]+)$/i);
    if (!match) {
      throw new Error("upload must be a base64 data URL");
    }
    const bytes = Buffer.from(match[2], "base64");
    const maxBytes = Number(config.webChatMaxUploadBytes) || 25 * 1024 * 1024;
    if (!bytes.length || bytes.length > maxBytes) {
      throw new Error(`upload must be between 1 byte and ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }

    const safeContentType = normalizeContentType(contentType) || normalizeContentType(match[1]);
    const safeKind = normalizeText(kind) || inferKind(safeContentType, fileName);
    const targetDir = path.join(config.stateDir, "inbox", dateFolder());
    await fs.mkdir(targetDir, { recursive: true });
    const safeName = sanitizeFileName(fileName, safeContentType, safeKind);
    const absolutePath = await writeUniqueFile(targetDir, safeName, bytes);
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
      sizeBytes: bytes.length,
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
    sendText,
    sendTyping,
    sendFile,
    persistUpload,
    getClientCount() {
      return clients.size;
    },
  };
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
