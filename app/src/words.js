import { describeCheck, describeFailure, shortfallOf } from './checks.js'

const HINTS = {
  'An action failed': 'For example, the vault may not hold enough, or a swap price moved.',
  'Unfair trade': 'The swap would get less than the fair price, minus your margin.',
}

export const SOMETHING_ELSE = 'Something else would leave your account'

export const UNFAIR_TRADE = 'Unfair trade'

function escapeText(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function patternFor(text) {
  return new RegExp(text.trim().split(/\s+/).map(escapeText).join('\\s+'), 'gi')
}

export function wordsOf(step) {
  return Array.isArray(step?.words) ? step.words.filter((piece) => typeof piece === 'string' && piece.trim()) : []
}

export function untraced(result) {
  return (result?.steps ?? []).filter((step) => !wordsOf(step).length).length
}

export function saidFor(result, origins) {
  if (!result) return null
  const stepWords = (result.steps ?? []).map(wordsOf)
  return {
    perCheck: (origins ?? []).map((indices) => [...new Set(indices.flatMap((i) => stepWords[i] ?? []))]),
    nothingElse: result.nothingElseWords ?? null,
    riskLimit: result.riskLimitWords ?? null,
    swaps: (result.steps ?? []).flatMap((step, i) => (step.type === 'swap' ? stepWords[i] : [])),
  }
}

export function quoteWords(list) {
  const quoted = list.map((piece) => `“${piece}”`)
  if (quoted.length <= 1) return quoted.join('')
  return `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`
}

export function asSentence(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

export function explainRefusal(failure, vault, checks, said, actions) {
  const check = failure.checkNumber ? checks?.[failure.checkNumber - 1] : null
  if (check && vault) {
    const plain = `${describeCheck(vault, check).text}, ${describeFailure(vault, check, failure.actual)}`
    const words = said?.perCheck?.[failure.checkNumber - 1] ?? []
    return words.length ? `You said ${quoteWords(words)}. ${asSentence(plain)}` : plain
  }
  const short = failure.reason === 'An action failed' && vault ? shortfallOf(vault, actions) : null
  const hint = short ? `${short}.` : HINTS[failure.reason]
  const plain = hint ? `${failure.reason}. ${hint}` : failure.reason
  const words = failure.reason === SOMETHING_ELSE && said?.nothingElse
    ? [said.nothingElse]
    : failure.reason === UNFAIR_TRADE && said?.swaps?.length
      ? said.swaps
      : []
  return words.length ? `You said ${quoteWords(words)}. ${asSentence(plain)}` : plain
}

export function marksFor(result) {
  const marks = []
  for (const [i, step] of (result?.steps ?? []).entries()) {
    for (const piece of wordsOf(step)) marks.push({ text: piece, kind: 'step', label: String(i + 1) })
  }
  if (result?.riskLimitWords) marks.push({ text: result.riskLimitWords, kind: 'risk', label: '%' })
  if (result?.nothingElseWords) marks.push({ text: result.nothingElseWords, kind: 'else', label: '✓' })
  for (const piece of result?.leftOut ?? []) marks.push({ text: piece, kind: 'left', label: '!' })
  return marks
}

export function layoutWords(sentence, marks) {
  const placed = []
  const elsewhere = []
  for (const mark of marks) {
    let spot = null
    for (const found of sentence.matchAll(patternFor(mark.text))) {
      const start = found.index
      const end = start + found[0].length
      if (!placed.some((p) => start < p.end && p.start < end)) {
        spot = { start, end }
        break
      }
    }
    if (spot) placed.push({ ...mark, ...spot })
    else elsewhere.push(mark)
  }
  placed.sort((a, b) => a.start - b.start)
  const segments = []
  let at = 0
  for (const mark of placed) {
    if (mark.start > at) segments.push({ text: sentence.slice(at, mark.start) })
    segments.push({ text: sentence.slice(mark.start, mark.end), mark })
    at = mark.end
  }
  if (at < sentence.length) segments.push({ text: sentence.slice(at) })
  return { segments, elsewhere }
}
