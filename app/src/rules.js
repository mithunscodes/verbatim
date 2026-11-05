import { createPublicClient, createWalletClient, custom, getAddress, numberToHex } from 'viem'
import { chain } from './config.js'
import { holdingOf, nameOf } from './checks.js'
import { formatAmount, formatDuration, shortAddress } from './format.js'
import { explainFailure } from './run.js'
import { lowFees, requireNormalKey, whileSigning } from './chain.js'

export const ChangeKind = {
  DailyLimit: 0,
  NewContactLimit: 1,
  Allowance: 2,
  AllowanceValidity: 3,
  NewContactPeriod: 4,
  AllowanceMinAge: 5,
  LooseningWait: 6,
  TradeTolerance: 7,
  PriceSource: 8,
}

function currentValue(vault, change) {
  switch (change.kind) {
    case ChangeKind.DailyLimit: return holdingOf(vault, change.token)?.dailyLimit ?? 0n
    case ChangeKind.NewContactLimit: return holdingOf(vault, change.token)?.newContactLimit ?? 0n
    case ChangeKind.AllowanceValidity: return vault.allowanceValidity
    case ChangeKind.NewContactPeriod: return vault.newContactPeriod
    case ChangeKind.AllowanceMinAge: return vault.allowanceMinAge
    case ChangeKind.LooseningWait: return vault.looseningWait
    case ChangeKind.TradeTolerance: return vault.tradeTolerance
    case ChangeKind.PriceSource: return BigInt(vault.priceSource)
    default: return 0n
  }
}

function tokenAmount(vault, token, amount) {
  const holding = holdingOf(vault, token)
  return holding
    ? `${formatAmount(amount, holding.decimals, holding.decimals)} ${holding.symbol}`
    : `${amount} of ${shortAddress(token)}`
}

function percent(basisPoints) {
  return `${formatAmount(basisPoints, 2)}%`
}

function asAddress(value) {
  return shortAddress(getAddress(numberToHex(value, { size: 20 })))
}

function direction(next, before) {
  if (next > before) return 'Raise'
  if (next < before) return 'Lower'
  return 'Keep'
}

export function describeChange(vault, change) {
  const before = change.readyAt ? change.valueBefore : currentValue(vault, change)
  const next = change.value
  switch (change.kind) {
    case ChangeKind.DailyLimit:
      return `${direction(next, before)} the daily limit for ${holdingOf(vault, change.token)?.symbol ?? shortAddress(change.token)} from ${tokenAmount(vault, change.token, before)} to ${tokenAmount(vault, change.token, next)}`
    case ChangeKind.NewContactLimit:
      return `${direction(next, before)} the new-contact limit for ${holdingOf(vault, change.token)?.symbol ?? shortAddress(change.token)} from ${tokenAmount(vault, change.token, before)} to ${tokenAmount(vault, change.token, next)}`
    case ChangeKind.Allowance:
      return `Allow one payment of up to ${tokenAmount(vault, change.token, next)} to ${nameOf(vault, change.contact)}, beyond your daily limit`
    case ChangeKind.AllowanceValidity:
      return `Keep approved changes valid for ${formatDuration(next)}, instead of ${formatDuration(before)}`
    case ChangeKind.NewContactPeriod:
      return `Treat contacts as new for ${formatDuration(next)}, instead of ${formatDuration(before)}`
    case ChangeKind.AllowanceMinAge:
      return `Allow one-off payments to contacts saved at least ${formatDuration(next)} ago, instead of ${formatDuration(before)}`
    case ChangeKind.LooseningWait:
      return `Wait ${formatDuration(next)} before a change can switch on, instead of ${formatDuration(before)}`
    case ChangeKind.TradeTolerance:
      return `Allow trades up to ${percent(next)} below the fair price, instead of ${percent(before)}`
    case ChangeKind.PriceSource:
      return `Use the price source ${asAddress(next)}, instead of ${asAddress(before)}`
    default:
      return `An unknown change (kind ${change.kind})`
  }
}

export function statusOf(change, now) {
  if (change.cancelled) return { key: 'cancelled', text: 'Cancelled', open: false }
  if (change.done) return { key: 'done', text: 'Switched on', open: false }
  if (change.used) return { key: 'used', text: 'Used', open: false }
  if (change.readyAt === 0n) return { key: 'waiting', text: 'Waiting for your approval', open: true }
  const allowance = change.kind === ChangeKind.Allowance
  if (now < change.readyAt) {
    return { key: 'approved', text: allowance ? 'Approved. Active in' : 'Approved. Can switch on in', until: change.readyAt, open: true }
  }
  if (now <= change.expiresAt) {
    return { key: 'ready', text: allowance ? 'Active. Expires in' : 'Ready to switch on. Expires in', until: change.expiresAt, open: true }
  }
  return { key: 'expired', text: 'Expired', open: false }
}

export function canSwitchOn(change, status) {
  return status.key === 'ready' && change.kind !== ChangeKind.Allowance
}

export async function sendContractTx(wallet, account, target, functionName, args) {
  await requireNormalKey(wallet, account)
  const transport = custom(wallet)
  const reader = createPublicClient({ chain, transport })
  const signer = createWalletClient({ chain, transport, account })
  const { request } = await reader.simulateContract({ ...target, functionName, args, account })
  const fees = await lowFees(reader)
  const hash = await whileSigning(() => signer.writeContract({ ...request, ...fees }))
  const receipt = await reader.waitForTransactionReceipt({ hash })
  return { hash, ok: receipt.status === 'success' }
}

export function txError(error) {
  if (error?.code === 4001 || error?.cause?.code === 4001) return 'You cancelled in MetaMask. Nothing was sent.'
  return explainFailure(error).reason
}
