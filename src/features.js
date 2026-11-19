import { existsSync } from 'node:fs'

const penBundled = existsSync(new URL('./pen.js', import.meta.url))

export const supportsPen = (ctx) => ctx?.penEnabled !== false && penBundled
