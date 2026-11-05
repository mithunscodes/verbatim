import { parseUnits } from 'viem'
import { CheckKind } from './checks.js'
import { roundDown } from './format.js'

const SHARE_SCALE = 1_000_000n
const DEPOSIT_KEEP_BPS = 10n

function decimalsIn(value) {
  return (value.split('.')[1] ?? '').length
}

function resolveAmount(holding, amount) {
  if (amount.kind === 'all') return holding.amount > 0n ? holding.amount : null
  if (amount.kind === 'fraction_of_balance') {
    const share = BigInt(Math.round(Number(amount.value) * Number(SHARE_SCALE)))
    const part = (holding.amount * share) / SHARE_SCALE
    return part > 0n ? part : null
  }
  if (decimalsIn(amount.value) > holding.decimals) return null
  const exact = parseUnits(amount.value, holding.decimals)
  return exact > 0n ? exact : null
}

function add(map, key, amount, extra = {}) {
  const current = map.get(key)
  map.set(key, { ...extra, ...current, amount: (current?.amount ?? 0n) + amount })
}

export function describeStep(step) {
  const amount = step.amount.kind === 'all'
    ? `all your ${step.token}`
    : step.amount.kind === 'fraction_of_balance'
      ? `${Number(step.amount.value) * 100}% of your ${step.token}`
      : `${step.amount.value} ${step.token}`
  if (step.type === 'send') return `Send ${amount} to ${step.to}`
  if (step.type === 'swap') return `Swap ${amount} for ${step.toToken}`
  return `Deposit ${amount} into ${step.protocol}`
}

export function planFromSteps(context, result) {
  const { holdings, contacts, fairValue, deposits: depositPlaces = {}, slippageBps, shownDigits } = context
  const bySymbol = (symbol) => holdings.find((h) => h.symbol.toUpperCase() === symbol.toUpperCase())
  const byName = (name) => contacts.find((c) => c.name.toLowerCase() === name.toLowerCase())
  const slippage = result.riskLimitPercent ? BigInt(Math.round(result.riskLimitPercent * 100)) : slippageBps
  const problems = []
  const leaves = new Map()
  const arrives = new Map()
  const exactly = new Map()
  const sends = []
  const swaps = []
  const deposits = []

  for (const step of result.steps) {
    const holding = bySymbol(step.token)
    if (!holding) {
      problems.push(`Your vault doesn't hold ${step.token}.`)
      continue
    }
    const amount = resolveAmount(holding, step.amount)
    if (!amount) {
      problems.push(`"${describeStep(step)}" comes to nothing, or has more decimals than ${step.token} allows.`)
      continue
    }
    if (step.type === 'send') {
      const contact = byName(step.to)
      if (!contact) {
        problems.push(`${step.to} isn't one of your contacts.`)
        continue
      }
      add(leaves, holding.token, amount)
      add(exactly, `${holding.token}:${contact.address}`, amount, { token: holding.token, to: contact.address })
      sends.push({ token: holding.token, amount, to: contact.address, name: contact.name })
    } else if (step.type === 'swap') {
      const out = bySymbol(step.toToken)
      const expected = out ? fairValue(holding.token, amount, out.token) : null
      if (!out || expected === null) {
        problems.push(`Your vault can't check a fair price for ${step.token} → ${step.toToken}, so that swap isn't possible.`)
        continue
      }
      const minimum = roundDown((expected * (10_000n - slippage)) / 10_000n, shownDigits)
      add(leaves, holding.token, amount)
      add(arrives, out.token, minimum)
      swaps.push({ from: holding.token, to: out.token, amount, expected, minimum })
    } else {
      const receipt = depositPlaces[step.protocol]?.[holding.symbol]
      if (!receipt) {
        problems.push(`Deposits into ${step.protocol} aren't available on this vault yet.`)
        continue
      }
      add(leaves, holding.token, amount)
      add(arrives, receipt, (amount * (10_000n - DEPOSIT_KEEP_BPS)) / 10_000n)
      deposits.push({ token: holding.token, amount, protocol: step.protocol, receipt })
    }
  }

  const checks = []
  const tokens = [...new Set([...leaves.keys(), ...arrives.keys()])]
  for (const token of tokens) {
    const out = leaves.get(token)?.amount ?? 0n
    const back = arrives.get(token)?.amount ?? 0n
    if (out > back) checks.push({ kind: CheckKind.AtMostLeaves, token, to: '0x0000000000000000000000000000000000000000', amount: out - back })
  }
  for (const token of tokens) {
    const out = leaves.get(token)?.amount ?? 0n
    const back = arrives.get(token)?.amount ?? 0n
    if (back > out) checks.push({ kind: CheckKind.AtLeastArrives, token, to: '0x0000000000000000000000000000000000000000', amount: back - out })
  }
  for (const { token, to, amount } of exactly.values()) checks.push({ kind: CheckKind.ExactlyTo, token, to, amount })

  return {
    checks,
    sends,
    swaps,
    deposits,
    problems,
    questions: result.questions,
    nothingElse: result.nothingElse,
    riskLimitPercent: result.riskLimitPercent,
  }
}

export function sameChecks(a, b) {
  const key = (c) => `${c.kind}:${c.token.toLowerCase()}:${c.to.toLowerCase()}:${c.amount}`
  const left = a.map(key).sort()
  const right = b.map(key).sort()
  return left.length === right.length && left.every((k, i) => k === right[i])
}
