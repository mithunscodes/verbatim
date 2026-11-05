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
