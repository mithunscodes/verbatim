import { formatUnits } from 'viem'

export function formatAmount(amount, decimals, maxFraction = 6) {
  const [whole, fraction = ''] = formatUnits(amount, decimals).split('.')
  const grouped = BigInt(whole).toLocaleString('en-US')
  const shown = fraction.slice(0, maxFraction).replace(/0+$/, '')
  return shown ? `${grouped}.${shown}` : grouped
}

export function roundDown(amount, digits) {
  const extra = amount.toString().length - digits
  if (extra <= 0) return amount
  const step = 10n ** BigInt(extra)
  return (amount / step) * step
}

export function formatAbout(amount, decimals, digits) {
  return formatAmount(roundDown(amount, digits), decimals, decimals)
}

export function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

const UNITS = [
  [86400n, 'day'],
  [3600n, 'hour'],
  [60n, 'minute'],
  [1n, 'second'],
]

export function formatDuration(seconds) {
  for (const [size, name] of UNITS) {
    if (seconds >= size && seconds % size === 0n) {
      const count = seconds / size
      return `${count} ${name}${count === 1n ? '' : 's'}`
    }
  }
  return `${seconds} seconds`
}

export function amountPattern(decimals) {
  return new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`)
}

export function formatCountdown(seconds) {
  if (seconds <= 0n) return '0:00'
  const hours = seconds / 3600n
  const minutes = (seconds % 3600n) / 60n
  const rest = seconds % 60n
  if (hours > 0n) return `${hours} h ${minutes} min`
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}

export function formatTime(timestamp) {
  return new Date(Number(timestamp) * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function formatMoment(timestamp) {
  const date = new Date(Number(timestamp) * 1000)
  if (date.toDateString() === new Date().toDateString()) return formatTime(timestamp)
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  return `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year })}, ${formatTime(timestamp)}`
}
