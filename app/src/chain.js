import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  custom,
  erc20Abi,
  getAddress,
  zeroAddress,
} from 'viem'
import { normalize } from 'viem/ens'
import { chain, directoryAbi, FACTORY, factoryAbi, KNOWN_VAULTS, NICKNAMES, priceSourceAbi, SEPOLIA_TIP, vaultAbi } from './config.js'

const MAX_LIST = 50

const LIST_PAGE = 10

const ALLOWANCE = 2

const DELEGATION_PREFIX = '0xef0100'

export const SMART_ACCOUNT_MESSAGE = 'MetaMask turned this key into a smart account. Switch it back first, then try again.'

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

export async function lowFees(client) {
  const { baseFeePerGas } = await client.getBlock()
  const base = baseFeePerGas ?? 0n
  return { maxPriorityFeePerGas: SEPOLIA_TIP, maxFeePerGas: base * 2n + SEPOLIA_TIP }
}

let signing = 0

export async function whileSigning(task) {
  signing++
  try {
    return await task()
  } finally {
    signing--
  }
}

export function isSigning() {
  return signing > 0
}

export function keyTypeFromCode(code) {
  if (!code || code === '0x') return { smart: false, delegate: null }
  const delegated = code.toLowerCase().startsWith(DELEGATION_PREFIX) && code.length === 48
  return { smart: true, delegate: delegated ? getAddress(`0x${code.slice(8)}`) : null }
}

export async function readKeyType(wallet, account) {
  const client = createPublicClient({ chain, transport: custom(wallet) })
  return keyTypeFromCode(await client.getCode({ address: account }))
}

export async function requireNormalKey(wallet, account) {
  if ((await readKeyType(wallet, account)).smart) throw new Error(SMART_ACCOUNT_MESSAGE)
}

function isRevert(error) {
  return error instanceof BaseError && Boolean(error.walk((e) => e instanceof ContractFunctionRevertedError))
}

function optional(promise) {
  return promise.catch((error) => {
    if (isRevert(error)) return null
    throw error
  })
}

export function normalName(text) {
  try {
    return normalize(text.trim())
  } catch {
    return null
  }
}

export async function resolveName(wallet, directory, name) {
  const client = createPublicClient({ chain, transport: custom(wallet) })
  const found = await client.readContract({ address: directory, abi: directoryAbi, functionName: 'addressOf', args: [name] })
  return found === zeroAddress ? null : found
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

export async function readVault(wallet, address) {
  const client = createPublicClient({ chain, transport: custom(wallet), batch: { multicall: true } })
  const block = await client.getBlock()
  const blockNumber = block.number
  const read = (functionName, args = []) =>
    client.readContract({ address, abi: vaultAbi, functionName, args, blockNumber })
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
    setupFinished,
    directory,
  ] = await Promise.all([
    read('everydayKey'),
    read('rulesKey'),
    client.getBalance({ address, blockNumber }),
    readList(read, 'watchedTokens'),
    readList(read, 'contacts'),
    read('newContactPeriod'),
    read('tradeTolerance'),
    read('priceSource'),
    read('allowanceValidity'),
    read('allowanceMinAge'),
    read('looseningWait'),
    read('changeCount'),
    read('setupFinished'),
    optional(read('directory')),
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
      readToken(token, 'balanceOf', [address]),
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
    Promise.all(contactAddresses.map(async (address) => {
      const [savedAt, ensName] = await Promise.all([read('savedAt', [address]), optional(read('nameOf', [address]))])
      const currentAddress = ensName
        ? await client.readContract({ address: directory, abi: directoryAbi, functionName: 'addressOf', args: [ensName], blockNumber })
        : address
      return {
        address,
        ensName: ensName || null,
        nickname: ensName || NICKNAMES[address] || null,
        currentAddress,
        moved: currentAddress !== address,
        savedAt,
      }
    })),
    readFairPrice(client, priceSource, blockNumber),
    Promise.all(Array.from({ length: Number(changeCount) }, (_, i) => readChange(BigInt(i)))),
  ])

  return {
    address,
    setupFinished,
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
    directory,
  }
}

export async function findVaults(wallet, account) {
  const client = createPublicClient({ chain, transport: custom(wallet), batch: { multicall: true } })
  const readKeys = (address) => Promise.all([
    client.readContract({ address, abi: vaultAbi, functionName: 'everydayKey' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'rulesKey' }),
  ])
  const [own, guarded] = FACTORY
    ? await Promise.all([
        client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'vaultOf', args: [account] }),
        client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'vaultsGuardedBy', args: [account] }),
      ])
    : [zeroAddress, []]
  const candidates = [...new Set([own, ...guarded, ...KNOWN_VAULTS].filter((a) => a !== zeroAddress).map((a) => getAddress(a)))]
  const found = await Promise.all(candidates.map(async (address) => {
    const [everydayKey, rulesKey] = await readKeys(address)
    const role = account === everydayKey ? 'Everyday key' : account === rulesKey ? 'Rules key' : null
    return role ? { address, everydayKey, rulesKey, role } : null
  }))
  return found.filter(Boolean)
}
