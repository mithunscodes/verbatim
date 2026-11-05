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

export const AUTO_REFRESH_MS = 15_000

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
  'function allowanceValidity() view returns (uint256)',
  'function allowanceMinAge() view returns (uint256)',
  'function looseningWait() view returns (uint256)',
  'function changeCount() view returns (uint256)',
  'function changes(uint256) view returns (uint8 kind, address contact, address token, uint256 value, uint256 valueBefore, uint256 readyAt, uint256 expiresAt, bool cancelled, bool done)',
  'function allowances(address) view returns (address token, uint256 amount, uint256 activeFrom, uint256 expiresAt, bool used)',
  'function saveContact(address contact)',
  'function propose(uint8 kind, address contact, address token, uint256 value) returns (uint256 id)',
  'function approve(uint256 id)',
  'function cancel(uint256 id)',
  'function switchOn(uint256 id)',
  'struct Action { address target; uint256 value; bytes data; uint8 operation; }',
  'struct Check { uint8 kind; address token; address to; uint256 amount; }',
  'function run(Action[] actions, Check[] checks, uint256 deadline)',
  'error CheckFailed(uint256 checkNumber, string check, uint256 expected, uint256 actual)',
])

export const priceSourceAbi = parseAbi([
  'function unit() view returns (address)',
  'function valueOf(address token, uint256 amount) view returns (uint256)',
])
