import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  custom,
  erc20Abi,
  getAddress,
  toHex,
  zeroAddress,
} from 'viem'
import { normalize, packetToBytes } from 'viem/ens'
import {
  chain,
  DIRECTORY_NAMES,
  directoryAbi,
  ENS_ETH_REGISTRY,
  ENS_ROLE_RENEW,
  ENS_ROLE_UNREGISTER,
  ENS_UNIVERSAL_RESOLVER,
  ensRegistryAbi,
  FACTORY,
  factoryAbi,
  KNOWN_VAULTS,
  NICKNAMES,
  priceSourceAbi,
  RESOLVER_SET_TEXT,
  resolverAbi,
  SEPOLIA_TIP,
  vaultAbi,
} from './config.js'

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

const earlier = (a, b) => (a === null || b < a ? b : a)

export async function nameEnd(client, name, blockNumber) {
  const [top, ...labels] = name.split('.').reverse()
  if (top !== 'eth' || labels.length === 0) return null
  const read = (address, functionName, args) => optional(client.readContract({ address, abi: ensRegistryAbi, functionName, args, blockNumber }))
  let registry = ENS_ETH_REGISTRY
  let parentEnd = null
  for (const [i, label] of labels.entries()) {
    const ends = await read(registry, 'findExpiry', [label])
    if (ends === null) return null
    if (i === labels.length - 1) return { registry, label, endsAt: earlier(parentEnd, ends), parentEnd, temporary: parentEnd !== null && ends < parentEnd }
    parentEnd = earlier(parentEnd, ends)
    const next = await read(registry, 'getSubregistry', [label])
    if (!next || next === zeroAddress) return { registry: null, label: null, endsAt: parentEnd, parentEnd, temporary: false }
    registry = next
  }
  return null
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

export function dnsName(name) {
  return toHex(packetToBytes(normalize(name)))
}

export async function nameResolver(wallet, directory, name) {
  const client = createPublicClient({ chain, transport: custom(wallet) })
  const resolver = await client.readContract({ address: directory, abi: directoryAbi, functionName: 'resolverOf', args: [name] })
  return resolver === zeroAddress ? null : resolver
}

export async function checkEnsName(wallet, vault, name) {
  const client = createPublicClient({ chain, transport: custom(wallet) })
  const resolver = await client.readContract({ address: vault.directory, abi: directoryAbi, functionName: 'resolverOf', args: [name] })
  if (resolver === zeroAddress) return { resolver: null, canWrite: false }
  const canWrite = await client.readContract({ address: resolver, abi: resolverAbi, functionName: 'hasRootRoles', args: [RESOLVER_SET_TEXT, vault.address] })
  return { resolver, canWrite }
}

function primaryName(client, address) {
  if (!address || address === zeroAddress) return Promise.resolve(null)
  return client.getEnsName({ address, universalResolverAddress: ENS_UNIVERSAL_RESOLVER }).catch(() => null)
}

async function directoryNames(client, directory, blockNumber) {
  if (!directory) return []
  const found = await Promise.all(DIRECTORY_NAMES.map((name) =>
    optional(client.readContract({ address: directory, abi: directoryAbi, functionName: 'addressOf', args: [name], blockNumber }))))
  return found.map((address, i) => (address && address !== zeroAddress ? [address, DIRECTORY_NAMES[i]] : null)).filter(Boolean)
}

export const RULE_KEYS = ['allowanceValidity', 'newContactPeriod', 'allowanceMinAge', 'looseningWait', 'tradeTolerance', 'priceSource']

function parseChange(text) {
  try {
    const change = JSON.parse(text)
    return { ...change, readyAt: BigInt(change.readyAt), expiresAt: BigInt(change.expiresAt) }
  } catch {
    return null
  }
}

export async function readEnsRecords(wallet, vault) {
  if (!vault.ensName) return null
  const client = createPublicClient({ chain, transport: custom(wallet), batch: { multicall: true } })
  const text = (key) =>
    client.getEnsText({ name: vault.ensName, key: `verbatim.${key}`, universalResolverAddress: ENS_UNIVERSAL_RESOLVER }).catch(() => null)
  const keys = [...vault.holdings.flatMap((h) => [`dailyLimit.${h.symbol}`, `newContactLimit.${h.symbol}`]), ...RULE_KEYS]
  const [values, count] = await Promise.all([Promise.all(keys.map(text)), text('changeCount')])
  const total = Math.min(Number(count ?? 0) || 0, 200)
  const changes = (await Promise.all(Array.from({ length: total }, (_, i) => text(`change.${i}`)))).map(parseChange).filter(Boolean)
  return { name: vault.ensName, rules: keys.map((key, i) => ({ key, value: values[i] })), changes }
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
    ensName,
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
    optional(read('ensName')),
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
      const [currentAddress, end] = ensName
        ? await Promise.all([
          client.readContract({ address: directory, abi: directoryAbi, functionName: 'addressOf', args: [ensName], blockNumber }),
          nameEnd(client, ensName, blockNumber).catch(() => null),
        ])
        : [address, null]
      const canManage = end?.registry && end.temporary
        ? await optional(client.readContract({ address: end.registry, abi: ensRegistryAbi, functionName: 'hasRootRoles', args: [ENS_ROLE_RENEW | ENS_ROLE_UNREGISTER, rulesKey], blockNumber }))
        : false
      return {
        address,
        ensName: ensName || null,
        nickname: ensName || NICKNAMES[address] || null,
        currentAddress,
        moved: currentAddress !== address,
        end,
        ended: Boolean(end) && end.endsAt <= block.timestamp,
        canManage: Boolean(canManage),
        savedAt,
      }
    })),
    readFairPrice(client, priceSource, blockNumber),
    Promise.all(Array.from({ length: Number(changeCount) }, (_, i) => readChange(BigInt(i)))),
  ])

  const [found, everydayName, rulesName, priceName] = await Promise.all([
    directoryNames(client, directory, blockNumber),
    primaryName(client, everydayKey),
    primaryName(client, rulesKey),
    primaryName(client, priceSource),
  ])
  const names = {}
  const name = (account, value) => {
    if (account && value && !names[account]) names[account] = value
  }
  name(address, ensName || null)
  for (const contact of contacts) name(contact.address, contact.ensName)
  for (const [account, value] of found) name(account, value)
  name(everydayKey, everydayName)
  name(rulesKey, rulesName)
  name(priceSource, priceName)

  return {
    address,
    ensName: ensName || null,
    names,
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
    trusted: found.map(([account]) => account),
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
    if (!role) return null
    const [ensName, everydayName] = await Promise.all([
      optional(client.readContract({ address, abi: vaultAbi, functionName: 'ensName' })),
      primaryName(client, everydayKey),
    ])
    return { address, everydayKey, rulesKey, role, ensName: ensName || null, everydayName }
  }))
  return found.filter(Boolean)
}
