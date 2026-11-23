// Parse JSONC with source offsets so an install can edit one key and retain comments and formatting.
export const parseJsonc = (source) => {
  const lexer = /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\r\n]|\\.)*"|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gy
  function next() {
    while (lexer.lastIndex < source.length) {
      const start = lexer.lastIndex
      const match = lexer.exec(source)
      if (!match) throw new Error(`Invalid JSONC at offset ${start}`)
      const token = match[0]
      if (!/^(?:\s|\/)/.test(token)) return { token, start, end: lexer.lastIndex }
    }
    return { token: '', start: source.length, end: source.length }
  }
  let current = next()
  const read = (expected) => {
    const token = current
    if (expected !== undefined && token.token !== expected) throw new Error(`Expected ${expected} at offset ${token.start}`)
    current = next()
    return token
  }
  function value() {
    const start = current.start
    const isObject = current.token === '{'
    if (!isObject && current.token !== '[') {
      const { token, end } = read()
      return { start, end, value: JSON.parse(token) }
    }
    read()
    const endToken = isObject ? '}' : ']'
    const children = new Map()
    const items = []
    let comma = false
    while (current.token !== endToken) {
      if (isObject) {
        const key = JSON.parse(read().token)
        if (typeof key !== 'string' || children.has(key)) throw new Error(`Invalid or duplicate object key: ${key}`)
        read(':')
        children.set(key, value())
      } else items.push(value())
      comma = current.token === ','
      if (!comma) break
      read(',')
    }
    const close = read(endToken)
    return { start, end: close.end, close: close.start, comma, children: isObject ? children : null,
      value: isObject ? Object.fromEntries([...children].map(([key, item]) => [key, item.value])) : items.map((item) => item.value) }
  }
  const root = value()
  if (current.token !== '') throw new Error(`Unexpected content at offset ${current.start}`)
  return root
}

export const patchJsonc = (source, keys, value) => {
  let node = parseJsonc(source)
  for (const [index, key] of keys.entries()) {
    if (!node.children) throw new Error(`Expected an object for ${keys.slice(0, index).join('.')}`)
    const child = node.children.get(key)
    if (!child) {
      let entry = value
      for (const parent of keys.slice(index + 1).reverse()) entry = { [parent]: entry }
      const last = [...node.children.values()].at(-1)
      const quoted = JSON.stringify(key)
      const field = `\n  ${quoted}: ${JSON.stringify(entry, null, 2).replaceAll('\n', '\n  ')}\n`
      const before = last && !node.comma
        ? source.slice(0, last.end) + ',' + source.slice(last.end, node.close)
        : source.slice(0, node.close)
      return before + field + source.slice(node.close)
    }
    node = child
  }
  if (JSON.stringify(node.value) === JSON.stringify(value)) return source
  return source.slice(0, node.start) + JSON.stringify(value, null, 2) + source.slice(node.end)
}
