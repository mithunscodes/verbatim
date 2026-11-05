import { decodeFunctionData, erc20Abi, isAddress, zeroAddress } from 'viem'
import { PERMIT2, permit2Abi, routerAbi, SHOWN_DIGITS, SWAP_SLIPPAGE_BPS, UNIVERSAL_ROUTER } from './config.js'
import { formatAmount, formatDuration, roundDown, shortAddress } from './format.js'

const actionAbi = [...erc20Abi, ...permit2Abi, ...routerAbi]

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

function labelOf(vault, address) {
  if (address === PERMIT2) return 'Permit2'
  if (address === UNIVERSAL_ROUTER) return 'Universal Router'
  return holdingOf(vault, address)?.symbol ?? nameOf(vault, address)
}

function decodeAction(data) {
  try {
    return decodeFunctionData({ abi: actionAbi, data })
  } catch {
    return null
  }
}

export function describeAction(vault, action) {
  const target = labelOf(vault, action.target)
  const value = action.value ? ` · value ${action.value}` : ''
  if (action.data === '0x') return `${target} · plain payment${value}`
  const call = decodeAction(action.data)
  if (!call) return `${target} · call ${action.data.slice(0, 10)}${value}`
  const args = call.functionName === 'execute'
    ? [call.args[0], `${call.args[1].length} input${call.args[1].length === 1 ? '' : 's'}`, `deadline ${call.args[2]}`]
    : call.args.map((arg) => (typeof arg === 'string' && isAddress(arg) ? labelOf(vault, arg) : String(arg)))
  return `${target} · ${call.functionName}(${args.join(', ')})${value}`
}

export function describeOutcome(vault, check, moved) {
  if (check.kind === CheckKind.AtMostLeaves) return `${show(vault, check.token, moved.left)} left`
  return `${show(vault, check.token, moved.arrived)} arrived`
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
