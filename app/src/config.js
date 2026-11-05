import { parseAbi } from 'viem'
import { sepolia } from 'viem/chains'

export const chain = sepolia

export const VAULT = '0xd03a1550f19E6b815a80a51ae40b8807c4702A69'

export const EXPLORER = 'https://sepolia.etherscan.io'

export const vaultAbi = parseAbi([
  'function everydayKey() view returns (address)',
  'function rulesKey() view returns (address)',
  'function watchedTokens(uint256) view returns (address)',
])
