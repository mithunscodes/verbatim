import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  custom,
  erc20Abi,
  getAddress,
  zeroAddress,
} from 'viem'
import { chain, NICKNAMES, priceSourceAbi, VAULT, vaultAbi } from './config.js'

const MAX_LIST = 50

const LIST_PAGE = 10

const ALLOWANCE = 2

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

async function readList(read, functionName) {
  const items = []
  while (items.length < MAX_LIST) {
    const start = items.length
    const results = await Promise.allSettled(
      Array.from({ length: LIST_PAGE }, (_, i) => read(functionName, [BigInt(start + i)])),
    )
    for (const result of results) {
      if (result.status === 'fulfilled') {
        items.push(result.value)
        continue
      }
      if (isRevert(result.reason)) return items
      throw result.reason
    }
  }
  return items
}

async function readFairPrice(client, priceSource, blockNumber) {
  if (priceSource === zeroAddress) return null
  const read = (functionName, args = []) =>
    client.readContract({ address: priceSource, abi: priceSourceAbi, functionName, args, blockNumber })
  try {
    const [unit, ethPrice] = await Promise.all([read('unit'), read('valueOf', [zeroAddress, 10n ** 18n])])
    return { unit, ethPrice }
  } catch (error) {
    if (isRevert(error)) return null
    throw error
  }
}

export async function readVault(wallet) {
  const client = createPublicClient({ chain, transport: custom(wallet), batch: { multicall: true } })
  const block = await client.getBlock()
  const blockNumber = block.number
  const read = (functionName, args = []) =>
    client.readContract({ address: VAULT, abi: vaultAbi, functionName, args, blockNumber })
  const readToken = (token, functionName, args = []) =>
    client.readContract({ address: token, abi: erc20Abi, functionName, args, blockNumber })

  const [
    everydayKey,
    rulesKey,
    eth,
    tokens,
    contactAddresses,
    newContactPeriod,
    tradeTolerance,
    priceSource,
    allowanceValidity,
    allowanceMinAge,
    looseningWait,
    changeCount,
  ] = await Promise.all([
    read('everydayKey'),
    read('rulesKey'),
    client.getBalance({ address: VAULT, blockNumber }),
    readList(read, 'watchedTokens'),
    readList(read, 'contacts'),
    read('newContactPeriod'),
    read('tradeTolerance'),
    read('priceSource'),
    read('allowanceValidity'),
    read('allowanceMinAge'),
    read('looseningWait'),
    read('changeCount'),
  ])

  const withRules = async (holding) => {
    const [dailyLimit, leftToday, newContactLimit] = await Promise.all([
      read('dailyLimit', [holding.token]),
      read('leftToday', [holding.token]),
      read('newContactLimit', [holding.token]),
    ])
    return { ...holding, dailyLimit, leftToday, newContactLimit }
  }

  const tokenHoldings = await Promise.all(tokens.map(async (token) => {
    const [symbol, decimals, amount] = await Promise.all([
      readToken(token, 'symbol'),
      readToken(token, 'decimals'),
      readToken(token, 'balanceOf', [VAULT]),
    ])
    return { token, symbol, decimals, amount }
  }))

  const readChange = async (id) => {
    const [kind, contact, token, value, valueBefore, readyAt, expiresAt, cancelled, done] = await read('changes', [id])
    const change = { id, kind, contact, token, value, valueBefore, readyAt, expiresAt, cancelled, done, used: false }
    if (kind !== ALLOWANCE || readyAt === 0n) return change
    const [, , activeFrom, , used] = await read('allowances', [contact])
    return { ...change, used: activeFrom === readyAt && used }
  }

  const [holdings, contacts, fairPrice, changes] = await Promise.all([
    Promise.all([
      { token: zeroAddress, symbol: 'ETH', decimals: chain.nativeCurrency.decimals, amount: eth },
      ...tokenHoldings,
    ].map(withRules)),
    Promise.all(contactAddresses.map(async (address) => ({
      address,
      nickname: NICKNAMES[address] ?? null,
      savedAt: await read('savedAt', [address]),
    }))),
    readFairPrice(client, priceSource, blockNumber),
    Promise.all(Array.from({ length: Number(changeCount) }, (_, i) => readChange(BigInt(i)))),
  ])

  return {
    blockNumber,
    timestamp: block.timestamp,
    everydayKey,
    rulesKey,
    holdings,
    contacts,
    newContactPeriod,
    tradeTolerance,
    priceSource,
    fairPrice,
    allowanceValidity,
    allowanceMinAge,
    looseningWait,
    changes,
  }
}
