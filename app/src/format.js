import { formatUnits } from 'viem'

export function formatAmount(amount, decimals, maxFraction = 6) {
  const [whole, fraction = ''] = formatUnits(amount, decimals).split('.')
  const grouped = BigInt(whole).toLocaleString('en-US')
  const shown = fraction.slice(0, maxFraction).replace(/0+$/, '')
  return shown ? `${grouped}.${shown}` : grouped
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
