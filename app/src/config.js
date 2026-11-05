import { parseAbi } from 'viem'
import { sepolia } from 'viem/chains'

export const chain = sepolia

export const KNOWN_VAULTS = ['0xd03a1550f19E6b815a80a51ae40b8807c4702A69']

export const FACTORY = '0xFe61f5Eb31505232eC7a0BADFb70F1d35d7E7ee7'

export const PRICE_SOURCE = '0xC751D9a4bF3195BebEF18F3FFA7E2A1E0ae605a3'

export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

export const UNIVERSAL_ROUTER = '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b'

export const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'

export const BAD_ROUTE_POOL_FEE = 100

export const DEMO_TIMINGS = {
  looseningWait: 120n,
  newContactPeriod: 300n,
  allowanceMinAge: 600n,
}

export const EXPLORER = 'https://sepolia.etherscan.io'

export const NICKNAMES = {
  '0xc0bF91f3BD0d479D5104d975B08885A73b032ce2': 'Builder',
}

export const SWAP_SLIPPAGE_BPS = 100n

export const SHOWN_DIGITS = 4

export const DEADLINE_SECONDS = 600

export const FORCED_GAS = 1_000_000n

export const AUTO_REFRESH_MS = 15_000

export const SEPOLIA_TIP = 1_000_000n

export const QUOTE_DELAY_MS = 500

export const QUOTE_REFRESH_MS = 30_000

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
  'function setupFinished() view returns (bool)',
  'function setDailyLimit(address token, uint256 amount)',
  'function setNewContactLimit(address token, uint256 amount)',
  'function setPriceSource(address source)',
  'function setLooseningWait(uint256 duration)',
  'function setNewContactPeriod(uint256 duration)',
  'function setAllowanceMinAge(uint256 duration)',
  'function finishSetup()',
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

export const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
])

export const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])

export const priceSourceAbi = parseAbi([
  'function unit() view returns (address)',
  'function valueOf(address token, uint256 amount) view returns (uint256)',
])

export const factoryAbi = parseAbi([
  'function vaultOf(address everydayKey) view returns (address)',
  'function vaultsGuardedBy(address rulesKey) view returns (address[])',
  'function createVault(address rulesKey) returns (address vault)',
  'event VaultCreated(address indexed vault, address indexed everydayKey, address indexed rulesKey)',
])
