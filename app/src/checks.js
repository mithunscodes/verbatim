import { decodeFunctionData, erc20Abi, isAddress, zeroAddress } from 'viem'
import {
  PERMIT2,
  permit2Abi,
  routerAbi,
  SHOWN_DIGITS,
  SMALL_EXTRA_BPS,
  SWAP_SLIPPAGE_BPS,
  UNIVERSAL_ROUTER,
} from './config.js'
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

const NEVER_ALLOWED = {
  'Borrowed code would run in your account': 'This would run outside code inside your vault.',
  'Your account would change': "This would change your vault's keys, contacts or rules.",
  'Not a trusted contract': "This uses a contract your vault doesn't trust.",
  'Permission for an untrusted contract': "This gives a permission to a contract your vault doesn't trust.",
  "This kind of action isn't allowed": "This uses a kind of action your vault doesn't allow.",
  'Permission left behind': 'This would leave a permission behind after it finishes.',
}

const OVER_LIMIT = {
  'Over the daily limit': "today's limit",
  'Over the new-contact limit': "a new contact's limit",
}

function unsavedPayments(vault, actions) {
  const saved = new Set(vault.contacts.map((contact) => contact.address))
  const payments = []
  for (const action of actions) {
    if (action.data === '0x') {
      if (!saved.has(action.target)) payments.push({ to: action.target, token: zeroAddress, amount: action.value })
      continue
    }
    const call = holdingOf(vault, action.target) ? decodeAction(action.data) : null
    if (call?.functionName === 'transfer' && !saved.has(call.args[0])) {
      payments.push({ to: call.args[0], token: action.target, amount: call.args[1] })
    }
  }
  return payments
}

export function classifyFailure(vault, request, failure) {
  if (failure.checkNumber) {
    const index = failure.checkNumber - 1
    const check = request.checks[index]
    if (check.kind !== CheckKind.AtMostLeaves || failure.actual <= check.amount) return null
    const extra = failure.actual - check.amount
    const small = extra * 10_000n <= check.amount * SMALL_EXTRA_BPS
    return { level: small ? 'small' : 'risky', why: 'extra', index, token: check.token, extra, total: failure.actual }
  }
  if (NEVER_ALLOWED[failure.reason]) return { level: 'never', reason: failure.reason }
  if (failure.reason === 'Not a saved contact') return { level: 'risky', why: 'unsaved', payments: unsavedPayments(vault, request.actions) }
  if (OVER_LIMIT[failure.reason]) return { level: 'risky', why: 'limit', reason: failure.reason }
  if (failure.reason === 'Something else would leave your account') return { level: 'risky', why: 'other' }
  if (failure.reason === "This contact's address changed") return { level: 'risky', why: 'moved' }
  return null
}

function describeUnsaved(vault, payments) {
  const sends = payments.map((p) => `${show(vault, p.token, p.amount)} to ${shortAddress(p.to)}`).join(' and ')
  const first = payments[0]
  const what = !first
    ? "money to an address you haven't saved"
    : `${sends}, ${payments.length === 1 ? "an address you haven't saved" : "addresses you haven't saved"}`
  const rule = first
    ? `at most ${show(vault, first.token, holdingOf(vault, first.token).newContactLimit)} in its first ${formatDuration(vault.newContactPeriod)}`
    : 'a limit for its first days'
  return `This also sends ${what}. That needs your phone: save the address on the phone page first. The new-contact rule then applies: ${rule}.`
}

export function describeExtra(vault, extra, note) {
  if (extra.level === 'never') {
    return {
      icon: '🔴',
      title: 'Never allowed',
      text: `${NEVER_ALLOWED[extra.reason]} That can never be added to a request, so it's always stopped.`,
    }
  }
  if (extra.level === 'small') {
    const amount = show(vault, extra.token, extra.extra)
    return {
      icon: '🟢',
      title: 'Small and expected',
      text: `This also takes ${amount} more than you said.${note ? ` The app says it's ${note}.` : ''}`,
      question: `Add ${amount} to your request? Your vault will then allow exactly that much more, and nothing else.`,
    }
  }
  const words = {
    extra: () => `This takes ${show(vault, extra.token, extra.extra)} more than you said, which is over ${formatAmount(SMALL_EXTRA_BPS, 2)}% extra. That's too big to add with one tap. If you really meant it, change the amount in your request.`,
    unsaved: () => describeUnsaved(vault, extra.payments),
    limit: () => `This goes over ${OVER_LIMIT[extra.reason]}. Only your phone can raise it: a proposal, the phone's approval and a wait.`,
    other: () => "Another token would leave your vault that your request doesn't mention. That can't be added with one tap. If you meant it, change your request.",
    moved: () => "This contact's ENS name now points to a different address, so nothing can be sent to it. If the change is real, propose the new address below. Your phone must approve it, then it waits before any money can go there.",
  }
  return { icon: '🟡', title: 'Risky', text: words[extra.why]() }
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
