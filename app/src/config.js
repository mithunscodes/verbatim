import { parseAbi } from 'viem'
import { sepolia } from 'viem/chains'

export const chain = sepolia

export const VAULT = '0xd03a1550f19E6b815a80a51ae40b8807c4702A69'

export const EXPLORER = 'https://sepolia.etherscan.io'

export const NICKNAMES = {
  '0xc0bF91f3BD0d479D5104d975B08885A73b032ce2': 'Builder',
}

export const SWAP_SLIPPAGE_BPS = 100n

export const SHOWN_DIGITS = 4

export const DEADLINE_SECONDS = 600

export const FORCED_GAS = 600_000n

export const vaultAbi = parseAbi([
  'function everydayKey() view returns (address)',
  'function rulesKey() view returns (address)',
  'function watchedTokens(uint256) view returns (address)',
  'function contacts(uint256) view returns (address)',
  'function savedAt(address) view returns (uint256)',
  'function dailyLimit(address) view returns (uint256)',
  'function leftToday(address) view returns (uint256)',
  'function newContactLimit(address) view returns (uint256)',
  'function newContactPeriod() view returns (uint256)',
  'function tradeTolerance() view returns (uint256)',
  'function priceSource() view returns (address)',
  'struct Action { address target; uint256 value; bytes data; uint8 operation; }',
  'struct Check { uint8 kind; address token; address to; uint256 amount; }',
  'function run(Action[] actions, Check[] checks, uint256 deadline)',
  'error CheckFailed(uint256 checkNumber, string check, uint256 expected, uint256 actual)',
])

export const priceSourceAbi = parseAbi([
  'function unit() view returns (address)',
  'function valueOf(address token, uint256 amount) view returns (uint256)',
])
