import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { SCRIPTED_SENTENCES } from './config.js'

const FOLDER = new URL('../recorded/', import.meta.url)
const FILE = new URL('answers.json', FOLDER)
const MODES = ['fallback', 'first', 'off']

const normal = (text) => String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

export function recordedMode() {
  const mode = process.env.VERBATIM_RECORDED_AI ?? 'fallback'
  return MODES.includes(mode) ? mode : 'fallback'
}

function keyOf(ask) {
  return JSON.stringify([
    normal(ask.sentence),
    ask.names.map(normal).sort(),
    ask.tokens.map((token) => token.toUpperCase()).sort(),
    ask.protocols.map(normal).sort(),
  ])
}

function isScripted(ask) {
  return ask.turns.length === 0 && SCRIPTED_SENTENCES.some((sentence) => normal(sentence) === normal(ask.sentence))
}

function readAll() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'))
  } catch {
    return {}
  }
}

export function recordedAnswer(ask) {
  return isScripted(ask) ? readAll()[keyOf(ask)] ?? null : null
}

export function recordAnswer(ask, answer) {
  if (!isScripted(ask) || !answer.understood) return
  const all = readAll()
  all[keyOf(ask)] = { ...answer, recordedAt: new Date().toISOString() }
  mkdirSync(FOLDER, { recursive: true })
  writeFileSync(FILE, `${JSON.stringify(all, null, 2)}\n`)
}

export function labelled(answer, reason) {
  const { recordedAt, ...rest } = answer
  return { ...rest, recorded: { at: recordedAt, reason } }
}
