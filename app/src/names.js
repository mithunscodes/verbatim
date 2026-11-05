import { erc20Abi, getAddress, zeroAddress } from 'viem'
import { normalize } from 'viem/ens'
import {
  DIRECTORY_NAMES,
  ENS_ETH_REGISTRY,
  ENS_RESOLVER_IMPL,
  ENS_UNIVERSAL_RESOLVER,
  directoryAbi,
  ensRegistryAbi,
  ENS_VERIFIABLE_FACTORY,
  vaultAbi,
  verifiableFactoryAbi,
} from './config.js'
import { RULE_KEYS } from './chain.js'

const MAX_CONTACTS = 20
const MAX_TOKENS = 10

const optional = (promise) => promise.catch(() => null)

function cleanName(text) {
  try {
    return normalize(text.trim())
  } catch {
    return null
  }
}

async function readAll(read, functionName, limit) {
  const items = []
  for (let i = 0; i < limit; i++) {
    const item = await optional(read(functionName, [BigInt(i)]))
    if (!item) break
    items.push(item)
  }
  return items
}

async function readVault(reader, address) {
  const read = (functionName, args = []) => reader.readContract({ address, abi: vaultAbi, functionName, args })
  const keys = await optional(Promise.all([read('everydayKey'), read('rulesKey'), read('directory'), read('ensName'), read('setupFinished')]))
  if (!keys) return null
  const [everydayKey, rulesKey, directory, ensName, setupFinished] = keys
  const [contactAddresses, tokens] = await Promise.all([readAll(read, 'contacts', MAX_CONTACTS), readAll(read, 'watchedTokens', MAX_TOKENS)])
  const symbols = await Promise.all(tokens.map((token) => optional(reader.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }))))
  const contacts = await Promise.all(contactAddresses.map(async (contact) => {
    const name = (await optional(read('nameOf', [contact]))) || null
    const now = name ? await optional(reader.readContract({ address: directory, abi: directoryAbi, functionName: 'addressOf', args: [name] })) : contact
    return { address: contact, name, now: now ?? zeroAddress, moved: Boolean(name) && now !== contact }
  }))
  const official = await Promise.all(DIRECTORY_NAMES.map(async (name) => ({
    name,
    address: await optional(reader.readContract({ address: directory, abi: directoryAbi, functionName: 'addressOf', args: [name] })),
  })))
  return { address, everydayKey, rulesKey, directory, ensName: ensName || null, setupFinished, contacts, symbols: ['ETH', ...symbols.filter(Boolean)], official }
}

export async function readName(reader, input) {
  const name = cleanName(input)
  if (!name || !name.includes('.')) return { problem: "That isn't an ENS name. Try something like verbatimalice.eth." }
  const ens = { name, universalResolverAddress: ENS_UNIVERSAL_RESOLVER }
  const parts = name.split('.')
  const label = parts.length === 2 && parts[1] === 'eth' ? parts[0] : null
  const [address, resolver, owner] = await Promise.all([
    optional(reader.getEnsAddress(ens)),
    optional(reader.getEnsResolver(ens)),
    label ? optional(reader.readContract({ address: ENS_ETH_REGISTRY, abi: ensRegistryAbi, functionName: 'findOwner', args: [label] })) : null,
  ])
  const implementation = resolver
    ? await optional(reader.readContract({ address: ENS_VERIFIABLE_FACTORY, abi: verifiableFactoryAbi, functionName: 'verifyContract', args: [resolver] }))
    : null
  const genuine = Boolean(implementation) && getAddress(implementation) === getAddress(ENS_RESOLVER_IMPL)
  const vault = address ? await readVault(reader, address) : null
  const keys = vault ? [...vault.symbols.flatMap((symbol) => [`dailyLimit.${symbol}`, `newContactLimit.${symbol}`]), ...RULE_KEYS] : []
  const values = await Promise.all(keys.map((key) => optional(reader.getEnsText({ ...ens, key: `verbatim.${key}` }))))
  const rules = keys.map((key, i) => ({ key, value: values[i] })).filter((rule) => rule.value)
  return {
    name,
    address: address && address !== zeroAddress ? address : null,
    resolver: resolver && resolver !== zeroAddress ? resolver : null,
    genuine,
    owner: owner && owner !== zeroAddress ? owner : null,
    vault,
    rules,
  }
}
