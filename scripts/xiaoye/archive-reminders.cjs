require("dotenv").config();
const fs = require("fs");
const path = require("path");

const DEFAULT_STATE_DIR = "D:/study/.cyberboss";
const STATE_DIR = process.env.CYBERBOSS_STATE_DIR || DEFAULT_STATE_DIR;
const REMINDER_QUEUE_FILE = process.env.CYBERBOSS_REMINDER_QUEUE_FILE || path.join(STATE_DIR, "reminder-queue.json");
const ARCHIVE_DIR = process.env.CYBERBOSS_REMINDER_ARCHIVE_DIR || path.join(STATE_DIR, "reminder-archive");
const SEEN_FILE = path.join(ARCHIVE_DIR, "_seen-reminder-ids.json");
const HISTORY_FILE = path.join(ARCHIVE_DIR, "reminders-history.jsonl");

fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function appendHistory(record) {
  fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(record)}\n`, "utf8");
}

function archiveReminder(reminder) {
  if (!reminder || typeof reminder !== "object") {
    return null;
  }

  const id = typeof reminder.id === "string" ? reminder.id.trim() : "";
  if (!id) {
    return null;
  }

  return {
    archivedAt: new Date().toISOString(),
    sourceFile: REMINDER_QUEUE_FILE,
    reminder,
  };
}

function scanOnce() {
  const queue = readJsonSafe(REMINDER_QUEUE_FILE, { reminders: [] });
  const reminders = Array.isArray(queue.reminders) ? queue.reminders : [];
  const seenIds = new Set(readJsonSafe(SEEN_FILE, []));
  let changed = false;

  for (const reminder of reminders) {
    const reminderId = typeof reminder?.id === "string" ? reminder.id.trim() : "";
    if (!reminderId || seenIds.has(reminderId)) {
      continue;
    }

    const archivedPayload = archiveReminder(reminder);
    if (!archivedPayload) {
      continue;
    }

    // 不再为单条提醒写独立 JSON 文件，历史统一写入 JSONL。
    appendHistory(archivedPayload);
    seenIds.add(reminderId);
    changed = true;
    console.log(`[reminder-archive] archived ${reminderId}`);
  }

  if (changed) {
    writeJson(SEEN_FILE, Array.from(seenIds).sort());
  }
}

console.log(`[reminder-archive] watching ${REMINDER_QUEUE_FILE}`);
console.log(`[reminder-archive] archive dir ${ARCHIVE_DIR}`);

scanOnce();

fs.watchFile(
  REMINDER_QUEUE_FILE,
  {
    interval: 1000,
  },
  () => {
    scanOnce();
  }
);
