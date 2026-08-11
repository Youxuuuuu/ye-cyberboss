const fs = require("node:fs/promises")
const path = require("node:path")

const { VoiceInputError } = require("./errors")

async function probeAudioFile({ absolutePath = "", mimeType = "", timeoutMs = 5_000, signal = null } = {}) {
  const filePath = path.resolve(requiredText(absolutePath, "absolutePath"))
  const deadline = createDeadlineSignal({ timeoutMs, signal })
  try {
    const bytes = await fs.readFile(filePath, { signal: deadline.signal })
    const { parseBuffer } = await import("music-metadata")
    const metadata = await parseBuffer(bytes, { mimeType, size: bytes.length }, { duration: true })
    const format = metadata?.format || {}
    const codec = normalizeText(format.codec)
    // A container-level codec is not enough: MP4/WebM files can contain only
    // a video track while still exposing a perfectly valid duration and a
    // codec name. Require music-metadata's explicit audio fact or the
    // channel/sample-rate fields emitted by audio parsers.
    if (!hasAudioTrack(format)) {
      throw new VoiceInputError("unsupported-media", "media container does not expose a decodable audio track")
    }
    let durationMs = Math.round(Number(format.duration) * 1_000)
    if ((!Number.isFinite(durationMs) || durationMs <= 0) && isDurationlessBrowserWebm({ format, mimeType })) {
      durationMs = measureWebmOpusDurationMs(bytes)
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new VoiceInputError("invalid-media", "voice duration could not be decoded")
    }
    return {
      durationMs,
      container: normalizeText(format.container),
      codec,
    }
  } catch (error) {
    if (error instanceof VoiceInputError) throw error
    if (deadline.signal.aborted) {
      if (signal?.aborted && signal.reason instanceof VoiceInputError) throw signal.reason
      throw new VoiceInputError(signal?.aborted ? "cancelled" : "invalid-media", "voice decode was interrupted", {
        statusCode: signal?.aborted ? 499 : 408, cause: error,
      })
    }
    throw new VoiceInputError("invalid-media", "voice audio could not be decoded", { cause: error })
  } finally {
    deadline.dispose()
  }
}

function createDeadlineSignal({ timeoutMs, signal }) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener?.("abort", onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const timer = setTimeout(() => controller.abort(new Error("audio probe timeout")), positiveInteger(timeoutMs, 5_000))
  timer.unref?.()
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener?.("abort", onAbort)
    },
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

function requiredText(value, label) {
  const normalized = normalizeText(value)
  if (!normalized) throw new TypeError(`audio probe requires ${label}`)
  return normalized
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

module.exports = { probeAudioFile, hasAudioTrack }

function hasAudioTrack(format = {}) {
  return format?.hasAudio === true
    || Number(format?.sampleRate) > 0
    || Number(format?.numberOfChannels) > 0
}

function isDurationlessBrowserWebm({ format = {}, mimeType = "" } = {}) {
  return /webm/iu.test(normalizeText(format.container))
    || /^audio\/webm(?:;|$)/iu.test(normalizeText(mimeType))
}

// MediaRecorder commonly emits WebM with unknown-size Clusters and no Info/
// Duration element. music-metadata correctly establishes the container, codec
// and audio track, but cannot infer the duration. For an Opus-only WebM we can
// safely derive it from each Matroska block timestamp plus its Opus packet
// duration. This remains server-side validation; the browser's elapsed timer
// is never accepted as media metadata.
function measureWebmOpusDurationMs(bytes) {
  try {
    const segment = findSegment(bytes)
    if (!segment) return 0
    let timestampScaleNs = 1_000_000
    let opusTracks = new Set()
    let maximumEndNs = 0
    let offset = segment.dataStart
    while (offset < segment.dataEnd) {
      const element = readEbmlElement(bytes, offset, segment.dataEnd)
      if (!element) return 0
      if (element.id === EBML_IDS.INFO) {
        timestampScaleNs = readTimestampScale(bytes, element) || timestampScaleNs
      } else if (element.id === EBML_IDS.TRACKS) {
        opusTracks = readOpusTrackNumbers(bytes, element)
      } else if (element.id === EBML_IDS.CLUSTER && opusTracks.size) {
        const measured = measureCluster(bytes, element, { timestampScaleNs, opusTracks })
        maximumEndNs = Math.max(maximumEndNs, measured.maximumEndNs)
        offset = measured.nextOffset
        continue
      }
      offset = element.dataEnd
    }
    return maximumEndNs > 0 ? Math.ceil(maximumEndNs / 1_000_000) : 0
  } catch {
    return 0
  }
}

const EBML_IDS = Object.freeze({
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMESTAMP_SCALE: 0x2ad7b1,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  BLOCK_DURATION: 0x9b,
})

function findSegment(bytes) {
  let offset = 0
  while (offset < bytes.length) {
    const element = readEbmlElement(bytes, offset, bytes.length)
    if (!element) return null
    if (element.id === EBML_IDS.SEGMENT) return element
    offset = element.dataEnd
  }
  return null
}

function readTimestampScale(bytes, info) {
  let offset = info.dataStart
  while (offset < info.dataEnd) {
    const element = readEbmlElement(bytes, offset, info.dataEnd)
    if (!element) return 0
    if (element.id === EBML_IDS.TIMESTAMP_SCALE) return readUnsigned(bytes, element.dataStart, element.dataEnd)
    offset = element.dataEnd
  }
  return 0
}

function readOpusTrackNumbers(bytes, tracks) {
  const numbers = new Set()
  let offset = tracks.dataStart
  while (offset < tracks.dataEnd) {
    const entry = readEbmlElement(bytes, offset, tracks.dataEnd)
    if (!entry) return new Set()
    if (entry.id === EBML_IDS.TRACK_ENTRY) {
      let trackNumber = 0
      let trackType = 0
      let codecId = ""
      let childOffset = entry.dataStart
      while (childOffset < entry.dataEnd) {
        const child = readEbmlElement(bytes, childOffset, entry.dataEnd)
        if (!child) return new Set()
        if (child.id === EBML_IDS.TRACK_NUMBER) trackNumber = readUnsigned(bytes, child.dataStart, child.dataEnd)
        if (child.id === EBML_IDS.TRACK_TYPE) trackType = readUnsigned(bytes, child.dataStart, child.dataEnd)
        if (child.id === EBML_IDS.CODEC_ID) codecId = bytes.subarray(child.dataStart, child.dataEnd).toString("utf8")
        childOffset = child.dataEnd
      }
      if (trackNumber > 0 && trackType === 2 && /OPUS/iu.test(codecId)) numbers.add(trackNumber)
    }
    offset = entry.dataEnd
  }
  return numbers
}

function measureCluster(bytes, cluster, { timestampScaleNs, opusTracks }) {
  let clusterTimecode = 0
  let maximumEndNs = 0
  let offset = cluster.dataStart
  while (offset < cluster.dataEnd) {
    const element = readEbmlElement(bytes, offset, cluster.dataEnd)
    if (!element) return { maximumEndNs: 0, nextOffset: cluster.dataEnd }
    // Unknown-size Clusters end immediately before the next Cluster. It is a
    // sibling, not nested content, even though the enclosing Segment has no
    // explicit end offset to give us.
    if (element.id === EBML_IDS.CLUSTER) return { maximumEndNs, nextOffset: element.start }
    if (element.id === EBML_IDS.TIMECODE) {
      clusterTimecode = readUnsigned(bytes, element.dataStart, element.dataEnd)
    } else if (element.id === EBML_IDS.SIMPLE_BLOCK) {
      maximumEndNs = Math.max(maximumEndNs, blockEndNs(bytes, element, {
        clusterTimecode,
        timestampScaleNs,
        opusTracks,
      }))
    } else if (element.id === EBML_IDS.BLOCK_GROUP) {
      maximumEndNs = Math.max(maximumEndNs, blockGroupEndNs(bytes, element, {
        clusterTimecode,
        timestampScaleNs,
        opusTracks,
      }))
    }
    offset = element.dataEnd
  }
  return { maximumEndNs, nextOffset: cluster.dataEnd }
}

function blockGroupEndNs(bytes, group, context) {
  let block = null
  let blockDurationTicks = 0
  let offset = group.dataStart
  while (offset < group.dataEnd) {
    const element = readEbmlElement(bytes, offset, group.dataEnd)
    if (!element) return 0
    if (element.id === EBML_IDS.BLOCK) block = element
    if (element.id === EBML_IDS.BLOCK_DURATION) blockDurationTicks = readUnsigned(bytes, element.dataStart, element.dataEnd)
    offset = element.dataEnd
  }
  return blockEndNs(bytes, block, { ...context, blockDurationTicks })
}

function blockEndNs(bytes, block, { clusterTimecode, timestampScaleNs, opusTracks, blockDurationTicks = 0 } = {}) {
  if (!block || block.dataEnd - block.dataStart < 4) return 0
  const track = readEbmlVintValue(bytes, block.dataStart, block.dataEnd)
  if (!track || !opusTracks.has(track.value)) return 0
  const timecodeOffset = block.dataStart + track.length
  if (timecodeOffset + 3 > block.dataEnd) return 0
  const relativeTimecode = readSigned16(bytes, timecodeOffset)
  const flags = bytes[timecodeOffset + 2]
  const packetDurationMs = readOpusBlockDurationMs(bytes, timecodeOffset + 3, block.dataEnd, flags)
  const durationNs = blockDurationTicks > 0
    ? blockDurationTicks * timestampScaleNs
    : packetDurationMs * 1_000_000
  const startNs = (clusterTimecode + relativeTimecode) * timestampScaleNs
  return Number.isFinite(startNs) && Number.isFinite(durationNs) && startNs >= 0 && durationNs > 0
    ? startNs + durationNs
    : 0
}

function readOpusBlockDurationMs(bytes, offset, end, flags) {
  const packets = readLacedPackets(bytes, offset, end, flags)
  if (!packets.length) return 0
  let durationMs = 0
  for (const packet of packets) {
    const packetDuration = readOpusPacketDurationMs(packet)
    if (!packetDuration) return 0
    durationMs += packetDuration
  }
  return durationMs > 0 && durationMs <= 120 ? durationMs : 0
}

function readLacedPackets(bytes, offset, end, flags) {
  const lacing = flags & 0x06
  if (offset >= end) return []
  if (!lacing) return [bytes.subarray(offset, end)]
  const frameCount = bytes[offset] + 1
  let cursor = offset + 1
  if (frameCount < 2 || frameCount > 256) return []
  const sizes = []
  if (lacing === 0x04) {
    const remaining = end - cursor
    if (remaining <= 0 || remaining % frameCount) return []
    sizes.push(...Array(frameCount).fill(remaining / frameCount))
  } else if (lacing === 0x02) {
    for (let index = 0; index < frameCount - 1; index += 1) {
      let size = 0
      let part = 255
      while (part === 255) {
        if (cursor >= end) return []
        part = bytes[cursor]
        cursor += 1
        size += part
      }
      sizes.push(size)
    }
    const remaining = end - cursor - sizes.reduce((total, size) => total + size, 0)
    if (remaining < 0) return []
    sizes.push(remaining)
  } else if (lacing === 0x06) {
    const first = readEbmlVintValue(bytes, cursor, end)
    if (!first) return []
    cursor += first.length
    sizes.push(first.value)
    for (let index = 1; index < frameCount - 1; index += 1) {
      const difference = readEbmlVintValue(bytes, cursor, end)
      if (!difference) return []
      cursor += difference.length
      const bias = (2 ** (7 * difference.length - 1)) - 1
      const size = sizes[index - 1] + difference.value - bias
      if (!Number.isInteger(size) || size < 0) return []
      sizes.push(size)
    }
    const remaining = end - cursor - sizes.reduce((total, size) => total + size, 0)
    if (remaining < 0) return []
    sizes.push(remaining)
  } else {
    return []
  }
  const packets = []
  for (const size of sizes) {
    if (!Number.isInteger(size) || size <= 0 || cursor + size > end) return []
    packets.push(bytes.subarray(cursor, cursor + size))
    cursor += size
  }
  return cursor === end ? packets : []
}

function readOpusPacketDurationMs(packet) {
  if (!packet?.length) return 0
  const toc = packet[0]
  const configuration = toc >>> 3
  const frameDurationMs = configuration < 12
    ? 10 * (2 ** (configuration & 3))
    : configuration < 16
      ? 10 * (2 ** (configuration & 1))
      : 2.5 * (2 ** (configuration & 3))
  const code = toc & 0x03
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] & 0x3f) : 2
  const durationMs = frameDurationMs * frames
  return Number.isFinite(durationMs) && frames > 0 && durationMs <= 120 ? durationMs : 0
}

function readEbmlElement(bytes, start, limit) {
  const id = readEbmlId(bytes, start, limit)
  if (!id) return null
  const size = readEbmlSize(bytes, start + id.length, limit)
  if (!size) return null
  const dataStart = start + id.length + size.length
  const dataEnd = size.unknown ? limit : dataStart + size.value
  if (dataStart > limit || dataEnd > limit || dataEnd < dataStart) return null
  return { id: id.value, start, dataStart, dataEnd }
}

function readEbmlId(bytes, offset, limit) {
  const length = ebmlLength(bytes[offset])
  if (!length || offset + length > limit || length > 4) return null
  let value = 0
  for (let index = 0; index < length; index += 1) value = value * 256 + bytes[offset + index]
  return { length, value }
}

function readEbmlSize(bytes, offset, limit) {
  const first = bytes[offset]
  const length = ebmlLength(first)
  if (!length || offset + length > limit) return null
  let unknown = (first & (0xff >>> length)) === (0xff >>> length)
  for (let index = 1; index < length; index += 1) unknown &&= bytes[offset + index] === 0xff
  if (unknown) return { length, value: 0, unknown: true }
  let value = first & (0xff >>> length)
  for (let index = 1; index < length; index += 1) value = value * 256 + bytes[offset + index]
  return Number.isSafeInteger(value) ? { length, value, unknown: false } : null
}

function readEbmlVintValue(bytes, offset, limit) {
  const size = readEbmlSize(bytes, offset, limit)
  return size && !size.unknown ? { length: size.length, value: size.value } : null
}

function ebmlLength(first) {
  if (!Number.isInteger(first) || first <= 0) return 0
  for (let length = 1; length <= 8; length += 1) {
    if (first & (1 << (8 - length))) return length
  }
  return 0
}

function readUnsigned(bytes, start, end) {
  if (end <= start || end - start > 6) return 0
  let value = 0
  for (let index = start; index < end; index += 1) value = value * 256 + bytes[index]
  return Number.isSafeInteger(value) ? value : 0
}

function readSigned16(bytes, offset) {
  const value = (bytes[offset] << 8) | bytes[offset + 1]
  return value & 0x8000 ? value - 0x1_0000 : value
}
