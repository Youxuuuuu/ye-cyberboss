const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { probeAudioFile, hasAudioTrack } = require("../src/custom/xiaoye/voice/audio-probe")
const { createSiliconFlowAudioInputNormalizer } = require("../src/custom/xiaoye/voice/audio-input-normalizer")
const { VoiceInputError } = require("../src/custom/xiaoye/voice/errors")

test("audio probe decodes duration from the stored file rather than trusting client metadata", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-audio-probe-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const absolutePath = path.join(directory, "one-second.wav")
  fs.writeFileSync(absolutePath, oneSecondWav())

  const result = await probeAudioFile({ absolutePath, timeoutMs: 2_000 })

  assert.equal(result.durationMs, 1_000)
  assert.equal(result.container, "WAVE")
})

test("audio probe accepts a durationless WebM emitted by browser MediaRecorder", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-audio-probe-webm-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const absolutePath = path.join(directory, "browser-recorder.webm")
  fs.writeFileSync(absolutePath, browserMediaRecorderWebm())

  const result = await probeAudioFile({
    absolutePath,
    mimeType: "audio/webm;codecs=opus",
    timeoutMs: 2_000,
  })

  assert.equal(result.container, "EBML/webm")
  assert.ok(result.durationMs >= 100 && result.durationMs <= 1_000)
})

test("SiliconFlow input normalizer converts the same browser MediaRecorder WebM to mono WAV", async () => {
  const normalizer = createSiliconFlowAudioInputNormalizer()
  const result = await normalizer.normalize({
    bytes: browserMediaRecorderWebm(),
    mimeType: "audio/webm;codecs=opus",
  })

  assert.equal(result.mimeType, "audio/wav")
  assert.equal(result.bytes.toString("ascii", 0, 4), "RIFF")
  assert.equal(result.bytes.toString("ascii", 8, 12), "WAVE")
  assert.equal(result.bytes.readUInt16LE(22), 1)
  assert.equal(result.bytes.readUInt32LE(24), 16_000)
})

test("audio probe preserves caller workflow timeout rather than reporting cancellation", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-audio-probe-abort-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const absolutePath = path.join(directory, "one-second.wav")
  fs.writeFileSync(absolutePath, oneSecondWav())
  const controller = new AbortController()
  controller.abort(new VoiceInputError("provider-timeout", "voice workflow timed out", { statusCode: 504 }))

  await assert.rejects(
    probeAudioFile({ absolutePath, signal: controller.signal }),
    (error) => error instanceof VoiceInputError && error.reason === "provider-timeout",
  )
})

test("audio probe never accepts a video-only container from a codec name alone", () => {
  assert.equal(hasAudioTrack({ codec: "V_MPEG4/ISO/AVC", hasVideo: true }), false)
  assert.equal(hasAudioTrack({ codec: "A_OPUS", numberOfChannels: 1 }), true)
  assert.equal(hasAudioTrack({ hasAudio: true, codec: "unknown" }), true)
})

function oneSecondWav() {
  const dataLength = 16_000 * 2
  const bytes = Buffer.alloc(44 + dataLength)
  bytes.write("RIFF", 0, "ascii")
  bytes.writeUInt32LE(36 + dataLength, 4)
  bytes.write("WAVE", 8, "ascii")
  bytes.write("fmt ", 12, "ascii")
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16_000, 24)
  bytes.writeUInt32LE(32_000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write("data", 36, "ascii")
  bytes.writeUInt32LE(dataLength, 40)
  return bytes
}

function browserMediaRecorderWebm() {
  // A short synthetic tone emitted by Edge MediaRecorder. It has audio-track
  // metadata but intentionally omits the WebM Duration element, matching the
  // browser recordings accepted by the WebChat composer.
  return Buffer.from("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwH/////////FUmpZpkq17GDD0JATYCGQ2hyb21lV0GGQ2hyb21lFlSua7+uvdeBAXPFhzq7Ame8o+aDgQKGhkFfT1BVU2Oik09wdXNIZWFkAQIAAIC7AAAAAADhjbWERzuAAJ+BAmJkgSAfQ7Z1Af/////////ngQCjQ8OBAACA/wO1SlThdDM/bTLdvXOI2dP7BYbo/dJt/EiipQHOndv+TQSvt+VQRoor07zj1Hhz0v7mVpwJiz6QVJYe2SVtrU/80+wUuxxkdgtkZOaSiiEgoI7uUUEZalsXOI29H050ZWcpBytp/7PpB6TqQUPu/Wz64Io3mlWBsmpzKCwiksnhH9/1C9fwxlR8+UiCZs0IHIrndduOQyTryr6cGI0r/dwG6viHdQAAAAAD8/Mz//JdPChpPBi6hy0pXui6hy2Aa7pvvwmDMzsiHPpEteKiHPp8cezJ//qXqkSr4r/Rdpc5HUqJvPRfH85Dphm0aKDWgZ8IGfVHRBkVa/596VeYPjv69A21qmDip6utu7CZAoh21TRvtGyt1c+k+Te9S2a/OE1bZPnEDcgv/z6c2082IsLWgW/tk2pbfX9tJLIB/5NtsC7DCBpV/n6kC+C54JDg5pHqOChjoSkC8C7cGbrHSZTmB2TwQ6+8n2cA7rtpb6yn+u/CIQBKioCQUdwsADCpnrQHuyzAo5ArIvjSnE8a3XE3qeYen1jqXE56+l8ni94l+0AWc9GwJkM7GoevkYziJWPJEswMnZBE/4lBwi3cbzgbbJ+ZJoqJ7AL2tWYgHLo3cVHq2p4btkRwlz+MGQaFO8OegUxK0xIfkrz3OkXRyJyU2A4ZfeWgbgZNZULJEIQxdoLSLTIpRltsW0ByuUsGnyNcJT9BEIYpyIthALpxODeAVQo257ioch9qHAOQBerWYVHrEGQDBf9jD2q1hNhZEkYx6P7ap4A4+wavEchVpaimcn6nzBtJ1chtKb1zxAfZVJKcGEXQREPgAOeSSSJAbWtqqSSV3WuchDpoCCkl7qytKqpjmWRsZ2PSKGjmG3ArwFX9H9HbEGeUNhO7r0ZjkzsMXCLv+HBI0ZVLITsgh+dL6XRGtQrm/gSMU2dz++ggCTseIM3sOA1KtlHZprf2bcmBJy/6bIUL1/bePFhXHLb9PiHGbNi9oc1fF18e4abvFuV+rO8PS3nQvh0iiaf5wyVeW+gf3QP7c/DOS7ewc+tTnh1KLVExSw0rf1v4EjYlvLLE3jsYaxcQExbeCl6qG79kM5xBLp5P6Agiw+VxKSyj/t6IeXnw3331Wc0klOJHJKjThPo3wdYBJI85NoCinJYW9bNgRLFPPiSfQ82aCNyOQI16zrHJjUbiX3qvS4LsdxF/Jn7hs36qLd+vreKvL81ZXe1y16tP9/2nXXniOA5HqLFYsx6ev/4ACIZ27SJf7AuxMjuELGb3vZCcce6jQ8OBAEGA/wOq1lgFUgd8xImKomApyrEKQ9T9hsxsv+pcE/RAVwQozlM8TUOM1sjOYhQoiomteaIOZ0l1nS4km3o1Hx1rRXIxFJPDkuX6jwZh7CAf9/q/6PopjVBUu/AvqhhaGcYqkvaULRijXf3yzNztKd1z5KKXadvj9DLqHZw4jBPgm/pdZs5r7dNfvU9z2cb/jooHPZrlpNjF/Yz7Xhu+S/h2+CpIYQV9ZSiHyK22mFM9cg9JYRGr4sG396gWGyFTjdBfdoISRjLWd7RiZ7wld9LuvSbXJYDYPhDmUfK4lsXN7tIa379CBM0iT+1LRim00feImBZCMdEg/RITqLQtOw1BttrRWaItz/MBd0HznPfYkXfckXMHTGa2KiN4/32JoEBzQ1OGvxld1RpwcUAD/4RXdraQFpPqBsSAIRe+c/+508/urJ18RVMmaqqomAi5AXwvQ5Z9WabITISqN6AwT5ieEhznVTp5yY4AKBebMBXxu/c8m/r6V8zoNu2I3OafuSbhdS3uNYgqpURKKk7MTML40qMlmjaBrrxiDKyngqCpSVmt2xMkVRNOLFBrs4VfsoSRg65+D3oeSx8TPgf5xyY2sspl8LXsvePoBgHoFtgEgM0sl32q1w33xshJEuLNpmir3XhRkEDz87OwIfAvx9ixksnS3+ECIJ3ERwueglSDINBgRwKrYXfKBN6swnp0b2Zry6sDnLVJB2+a9QbQiyhneNIJfk3X4J5htH63AyPjW4iqDNo/4zyFSO/ezZ5/rlSO+zeJebCRa87gbe5lZvAeiLz7zybLOxq5J/vwJbeSCN6fQqo9ge4Jm52//AcAAjJI2BbIC7JNkUIf+pW9qV557qrfhdiibxjmWI3Z9LDrqoXhe6Dtc1qVqPJfl1e2+bQp8Z32B44g5lZ3QcFZsSSl/lavmAxZJwvp9MfgLDEKTOHNh8QlB/KiQPS105nSwU7qxR5iVDRhXqs+5YtBLcgPsdPSNfuxg8viXNxZXB989IKdz8rAnSPbHk4uJhCyncPdzBYd4Hls4embDPP9jDJxuNj16b/LK6tCDx4XK3FNYOWmRT2Buu5bpTaSxAfHRpLE+IgcrKgMXFXa7rFtgHLJa/PDvNBDSvfk8w/nuWexg0ykL86GNKs8FNaATmIBhWhMU4lf2gihiVBPaAGzNe5YYbn7BRG4VxJn5Rm3zHQDQ0vSSexIFRPgAKofxWF6BINh4KHOtE5OaoTQxrUHPl/WptFCCgFY7mYmP/AHCIIyNgf2k+FoGzuc6U72MYQpp+4fQ7Z1Af/////////ngXWjQ8OBAACA/wOqsSzH3wRnDrVVRq9XAicLZKKg3IArzPzOjESQubzlW0AQ+ezxLt4Mq1ZztQFp27s7ZrvJJHDgOAyTGW2xKhZ4BFf1vI78cON3tTLwV2ASx+tZx7kkrXobU9fnc0mif1rEhyZuQcYYm69oZBuGHTb/bhOFevYpaoCY1r4Ktyc/J4d89kdmSyPFX7hwnnOt2PNB4p4mTIA/xtVfpWpvcw2pqGQgf1OHbDFKI351j91hHcC9GG11W40JzSQfXe9uxyFTaFJ51fyspbCRTnxpwlMBXqM+AHCvCT+2RMSwNnYcfVU8XfXnutGrHp3Ke2hOzxR1BM/EfPZ2tdmtreeO6y5DGC1fEXOSOekARA26jiEtUOurQTfHsrMKtznCJwhlaG76fbTC61jH+kAB/4AVVskhP7fr/+TmQh70pb3ObLPurK0oPCzAbgj0Cn0DtvjRjFKLRcHnnng2y6UVU4ZjxTCFLJYQRnTFrdvbfgFSfPkmiulZV3gZ/3sDctmz4Ate2AdcvigiwbUfDJV/bw/K7JrTrzhOjzytlcSP2Vn/QvUzXsop8cXaPP5Nz+9OmYFuKabD9Os4Oh49ZPGX1/lYdiJ1uK5QWgFMt9Q1eTS+Mz5CYl/jBhRlt3skEfFfvK5YUpYIbXLK9G64JbT2mphwzcB5LRbkyJcTQmRY4iKIKEnzllFD06zhtMbqdg2xKN6fut5Alv6De17YapxJHnKo3JXinKIoPsGNErFajdLVVZZpMMRUT+x2NNqqYuJfeq9Lgux3EX8mfuGzfqUt36+t4q8vzVld7XKBq2/4Paddf344DkeosVizHx8//gAMyJtbal/stAN2xEpCEMfvPfrr7qrWWAVSDkCBz8yQsrxHEQYfMGZBxBw5A4ECgisbRjxZP45qE4Icm4S6lOGGoJUC1jVFJ7Qe5KAiByrILa8uoufSoUycGoMJS5cFaOMxKQNPky7IB1U2M/8C4/AguAE3JCJoVg6QA0O5N+X3niG0/qPnkGkciPT2hU+/EYu8Wm4L92ZGV0iOSxIJBs/qHmyXakXCevkCo34FEmibuJU/dcuZ4oQhH3seBTt3ySm26JHtXWAQNT4g3wlVHeTiSwNXrOQwMC9Cr5YxhKlf2m3l9utmZtbrlu3J/fh8Z7C9gfTr6IB0mVTN/M9R2dI9b18v7h2s8BwZGRDGw8OepcKGpuGtTxbn+7S7oM+x8xigonhI158JX9vzEbx/DPWgTumfU4a/GKvVGnBxQAP/9Uqttgf2k+v+xIAhF75z/73zz+4=", "base64")
}
