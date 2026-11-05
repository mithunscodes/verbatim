import { zeroAddress } from 'viem'
import { SHOWN_DIGITS, SWAP_SLIPPAGE_BPS } from './config.js'
import { formatAmount, formatDuration, shortAddress } from './format.js'

export const CheckKind = {
  AtMostLeaves: 0,
  AtLeastArrives: 1,
  ExactlyTo: 2,
}

const ONE_ETH = 10n ** 18n

export const ALWAYS_ON = [
  'No borrowed code runs in your account',
  'Your keys, contacts and rules stay the same',
  'Only your saved contacts and trusted contracts can be used',
  'Only allowed kinds of action can run',
  'No permission is left behind',
  'Nothing else leaves your account',
  'Your account never signs permissions',
]

export function holdingOf(vault, token) {
  return vault.holdings.find((holding) => holding.token === token)
}

export function nameOf(vault, address) {
  const contact = vault.contacts.find((c) => c.address === address)
  return contact?.nickname ?? shortAddress(address)
}

function show(vault, token, amount) {
  const holding = holdingOf(vault, token)
  return `${formatAmount(amount, holding.decimals, holding.decimals)} ${holding.symbol}`
}

function roundDown(amount, digits) {
  const extra = amount.toString().length - digits
  if (extra <= 0) return amount
  const step = 10n ** BigInt(extra)
  return (amount / step) * step
}

export function sendChecks({ token, amount, to }) {
  return [
    { kind: CheckKind.AtMostLeaves, token, to: zeroAddress, amount },
    { kind: CheckKind.ExactlyTo, token, to, amount },
  ]
}

export function canSwap(vault, from, to) {
  const unit = vault.fairPrice?.unit
  return Boolean(unit) && from !== to && [from, to].every((t) => t === zeroAddress || t === unit)
}

export function expectedArrival(vault, from, amount) {
  const { ethPrice } = vault.fairPrice
  return from === zeroAddress ? (amount * ethPrice) / ONE_ETH : (amount * ONE_ETH) / ethPrice
}

export function swapChecks(vault, { from, to, amount }) {
  const expected = expectedArrival(vault, from, amount)
  const lowest = roundDown((expected * (10_000n - SWAP_SLIPPAGE_BPS)) / 10_000n, SHOWN_DIGITS)
  return {
    expected,
    checks: [
      { kind: CheckKind.AtMostLeaves, token: from, to: zeroAddress, amount },
      { kind: CheckKind.AtLeastArrives, token: to, to: zeroAddress, amount: lowest },
    ],
  }
}

export function describeCheck(vault, check) {
  const amount = show(vault, check.token, check.amount)
  if (check.kind === CheckKind.AtMostLeaves) return { icon: '↓', text: `At most ${amount} leaves your vault` }
  if (check.kind === CheckKind.AtLeastArrives) return { icon: '↑', text: `At least ${amount} arrives in your vault` }
  return { icon: '→', text: `Exactly ${amount} goes to ${nameOf(vault, check.to)}` }
}

export function describeFailure(vault, check, actual) {
  const amount = show(vault, check.token, actual)
  if (check.kind === CheckKind.AtMostLeaves) return `but ${amount} would leave`
  if (check.kind === CheckKind.AtLeastArrives) return `but only ${amount} would arrive`
  return `but ${amount} would arrive`
}

export function rulesFor(vault, checks) {
  const lines = []
  for (const check of checks.filter((c) => c.kind === CheckKind.AtMostLeaves)) {
    const holding = holdingOf(vault, check.token)
    lines.push(
      `Within today's limit: ${show(vault, check.token, holding.leftToday)} left of ${show(vault, check.token, holding.dailyLimit)}`,
    )
  }
  for (const check of checks.filter((c) => c.kind === CheckKind.ExactlyTo)) {
    const contact = vault.contacts.find((c) => c.address === check.to)
    if (!contact || vault.timestamp >= contact.savedAt + vault.newContactPeriod) continue
    const limit = holdingOf(vault, check.token).newContactLimit
    lines.push(
      `${nameOf(vault, check.to)} is a new contact: at most ${show(vault, check.token, limit)} in their first ${formatDuration(vault.newContactPeriod)}`,
    )
  }
  if (checks.some((c) => c.kind === CheckKind.AtLeastArrives)) {
    const usdc = vault.fairPrice.unit
    lines.push(
      `A fair trade: within ${formatAmount(vault.tradeTolerance, 2)}% of the fair price, 1 ETH = ${show(vault, usdc, vault.fairPrice.ethPrice)}`,
    )
  }
  return lines
}
