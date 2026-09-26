// Call only after JSON.parse has established that the text is valid JSON.
export function hasDuplicateObjectKeys(text) {
  const stack = []
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '{') stack.push({ kind: 'object', keys: new Set(), expectingKey: true })
    else if (character === '[') stack.push({ kind: 'array' })
    else if (character === '}' || character === ']') stack.pop()
    else if (character === ',' && stack.at(-1)?.kind === 'object') stack.at(-1).expectingKey = true
    else if (character === ':' && stack.at(-1)?.kind === 'object') stack.at(-1).expectingKey = false
    else if (character === '"') {
      const start = index
      for (index += 1; index < text.length; index += 1) {
        if (text[index] === '\\') { index += 1; continue }
        if (text[index] === '"') break
      }
      const frame = stack.at(-1)
      if (frame?.kind === 'object' && frame.expectingKey) {
        const key = JSON.parse(text.slice(start, index + 1))
        if (frame.keys.has(key)) return true
        frame.keys.add(key)
      }
    }
  }
  return false
}
