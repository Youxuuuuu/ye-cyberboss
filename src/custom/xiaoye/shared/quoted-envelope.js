function parseQuotedEnvelope(value) {
  const text = String(value || "").trim()
  const prefix = text.match(/^\[Quoted:\s*/u)
  if (!prefix) {
    return { text, quote: undefined }
  }

  let depth = 1
  for (let index = prefix[0].length; index < text.length; index += 1) {
    if (text[index] === "[") {
      depth += 1
      continue
    }
    if (text[index] !== "]") {
      continue
    }
    depth -= 1
    if (depth !== 0) {
      continue
    }
    const quote = text.slice(prefix[0].length, index).trim()
    if (!quote) {
      return { text, quote: undefined }
    }
    return {
      text: text.slice(index + 1).trim(),
      quote,
    }
  }

  return { text, quote: undefined }
}

module.exports = { parseQuotedEnvelope }
