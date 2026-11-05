import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  custom,
  erc20Abi,
  getAddress,
} from 'viem'
import { chain, VAULT, vaultAbi } from './config.js'

const MAX_TOKENS = 20

export function getWallet() {
  return typeof window === 'undefined' ? undefined : window.ethereum
}

export async function requestAccount(wallet) {
  const accounts = await wallet.request({ method: 'eth_requestAccounts' })
  return accounts.length ? getAddress(accounts[0]) : null
}

export async function readAccount(wallet) {
  const accounts = await wallet.request({ method: 'eth_accounts' })
  return accounts.length ? getAddress(accounts[0]) : null
}

export async function readChainId(wallet) {
  return Number(await wallet.request({ method: 'eth_chainId' }))
}

export async function switchToSepolia(wallet) {
  const chainId = `0x${chain.id.toString(16)}`
  try {
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
  } catch (error) {
    if (error.code !== 4902) throw error
    await wallet.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId,
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: chain.rpcUrls.default.http,
        blockExplorerUrls: [chain.blockExplorers.default.url],
      }],
    })
  }
}

function isRevert(error) {
  return error instanceof BaseError && Boolean(error.walk((e) => e instanceof ContractFunctionRevertedError))
}

async function readWatchedTokens(client, blockNumber) {
  const tokens = []
  for (let i = 0n; i < MAX_TOKENS; i++) {
    try {
      tokens.push(await client.readContract({
        address: VAULT,
        abi: vaultAbi,
        functionName: 'watchedTokens',
        args: [i],
        blockNumber,
      }))
    } catch (error) {
      if (isRevert(error)) return tokens
      throw error
    }
  }
  return tokens
}

async function readToken(client, token, blockNumber) {
  const read = (functionName, args = []) =>
    client.readContract({ address: token, abi: erc20Abi, functionName, args, blockNumber })
  const [symbol, decimals, amount] = await Promise.all([
    read('symbol'),
    read('decimals'),
    read('balanceOf', [VAULT]),
  ])
  return { token, symbol, decimals, amount }
}

export async function readVault(wallet) {
  const client = createPublicClient({ chain, transport: custom(wallet) })
  const blockNumber = await client.getBlockNumber()
  const readVaultField = (functionName) =>
    client.readContract({ address: VAULT, abi: vaultAbi, functionName, blockNumber })
  const [everydayKey, rulesKey, eth, tokens] = await Promise.all([
    readVaultField('everydayKey'),
    readVaultField('rulesKey'),
    client.getBalance({ address: VAULT, blockNumber }),
    readWatchedTokens(client, blockNumber),
  ])
  const holdings = await Promise.all(tokens.map((token) => readToken(client, token, blockNumber)))
  return {
    blockNumber,
    everydayKey,
    rulesKey,
    holdings: [{ token: null, symbol: 'ETH', decimals: chain.nativeCurrency.decimals, amount: eth }, ...holdings],
  }
}
