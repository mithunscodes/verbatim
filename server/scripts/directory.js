import { appendFileSync, readFileSync } from 'node:fs'
import { encodeFunctionData, getAddress, keccak256, stringToHex, zeroAddress } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { normalize } from 'viem/ens'
import {
  ALL_ROLES,
  ETH_COIN_TYPE,
  ETH_REGISTRY,
  NAME_ROLES,
  RESOLVER_IMPL,
  ROLE_REGISTRAR,
  ROLE_RENEW,
  ROLE_SET_PARENT,
  ROLE_SET_RESOLVER,
  UNIVERSAL_RESOLVER,
  VERIFIABLE_FACTORY,
  accountFor,
  admin,
  connect,
  dns,
  ensTools,
  factoryAbi,
  isMain,
  live,
  registryAbi,
  resolverAbi,
  runMain,
  startLocalCopy,
  universalResolverAbi,
} from './ens.js'

export const DIRECTORY_LABEL = 'verbatim'
export const ORGANIZATIONS = [
  {
    label: 'uniswap',
    keyName: 'UNISWAP_ORG_PRIVATE_KEY',
    contracts: {
      router: '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b',
      permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    },
  },
  {
    label: 'circle',
    keyName: 'CIRCLE_ORG_PRIVATE_KEY',
    contracts: {
      usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    },
  },
  {
    label: 'studio',
    keyName: 'VERBATIM_ORG_PRIVATE_KEY',
    contracts: {
      prints: '0xF81489BDeD06e68969b350E739bc3f2773Dd750E',
    },
  },
]
export const TRUSTED_NAMES = [`router.uniswap.${DIRECTORY_LABEL}.eth`, `prints.studio.${DIRECTORY_LABEL}.eth`]

const OPERATOR_ROLES = ROLE_REGISTRAR | ROLE_RENEW | ROLE_SET_PARENT | admin(ROLE_REGISTRAR | ROLE_RENEW | ROLE_SET_PARENT)
const ORGANIZATION_GAS = 6_000_000n
const ENV_FILE = new URL('../../.env', import.meta.url)

const directoryName = `${DIRECTORY_LABEL}.eth`
const organizationName = (organization) => `${organization.label}.${directoryName}`
const contractName = (organization, label) => `${label}.${organizationName(organization)}`

function makeKeys() {
  const env = readFileSync(ENV_FILE, 'utf8')
  for (const organization of ORGANIZATIONS) {
    if (process.env[organization.keyName] || new RegExp(`^${organization.keyName}=`, 'm').test(env)) {
      console.log(`${organization.keyName} is already in .env, kept as it is`)
      continue
    }
    const key = generatePrivateKey()
    const prefix = readFileSync(ENV_FILE, 'utf8').endsWith('\n') ? '' : '\n'
    appendFileSync(ENV_FILE, `${prefix}${organization.keyName}=${key}\n`)
    console.log(`${organization.keyName} added to .env. Address: ${privateKeyToAccount(key).address}`)
  }
}

const withKeys = () => ORGANIZATIONS.map((organization) => ({ ...organization, account: accountFor(organization.keyName) }))

export async function setupDirectory(clients) {
  const { builder } = clients
  const tools = ensTools(clients)
  const { read, send, deployResolver, deployRegistry, registerEthName, fund } = tools
  const organizations = withKeys()

  console.log(`Directory: ${directoryName}, owned by the Builder key ${builder.address}`)
  const { address: builderResolver } = await deployResolver("Create the Builder key's resolver", builder, builder.address, [{ account: builder.address, roleBitmap: ALL_ROLES }], [])
  const { address: directoryRegistry } = await deployRegistry("Create the directory's registry", builder, directoryName, [{ account: builder.address, roleBitmap: OPERATOR_ROLES }])
  const expiry = await registerEthName(DIRECTORY_LABEL, builder.address, directoryRegistry, builderResolver)
  if (await read(directoryRegistry, registryAbi, 'hasRootRoles', [ROLE_SET_PARENT, builder.address])) {
    await send('Record where the directory sits under .eth', builder, { address: directoryRegistry, abi: registryAbi, functionName: 'setParent', args: [ETH_REGISTRY, DIRECTORY_LABEL] })
    await send('Lock that, so it can never move', builder, {
      address: directoryRegistry,
      abi: registryAbi,
      functionName: 'revokeRootRoles',
      args: [ROLE_SET_PARENT | admin(ROLE_SET_PARENT), builder.address],
    })
  }

  for (const organization of organizations) {
    const { account } = organization
    const name = organizationName(organization)
    console.log(`Organization: ${name}, owned by ${account.address}`)
    await fund(account, ORGANIZATION_GAS)
    const records = Object.entries(organization.contracts).map(([label, address]) =>
      encodeFunctionData({ abi: resolverAbi, functionName: 'setAddress', args: [dns(contractName(organization, label)), ETH_COIN_TYPE, address] }),
    )
    const grants = [{ account: account.address, roleBitmap: ALL_ROLES }]
    const { address: resolver } = await deployResolver(`Create ${organization.label}'s resolver, with its contract addresses`, account, account.address, grants, records)
    const { address: registry } = await deployRegistry(`Create ${organization.label}'s registry`, account, name, grants)
    for (const [label, address] of Object.entries(organization.contracts)) {
      if ((await read(registry, registryAbi, 'findOwner', [label])) === zeroAddress) {
        await send(`Register ${contractName(organization, label)}`, account, {
          address: registry,
          abi: registryAbi,
          functionName: 'register',
          args: [label, account.address, zeroAddress, resolver, NAME_ROLES, expiry],
        })
      }
      const { record } = await tools.lookup(contractName(organization, label)).catch(() => ({ record: null }))
      if (record !== getAddress(address)) {
        await send(`Point ${contractName(organization, label)} to ${address}`, account, {
          address: resolver,
          abi: resolverAbi,
          functionName: 'setAddress',
          args: [dns(contractName(organization, label)), ETH_COIN_TYPE, address],
        })
      }
    }
    const [parent] = await read(registry, registryAbi, 'getParent')
    if (parent === zeroAddress) {
      await send(`Record where ${organization.label}'s registry sits`, account, {
        address: registry,
        abi: registryAbi,
        functionName: 'setParent',
        args: [directoryRegistry, organization.label],
      })
    }
    if ((await read(directoryRegistry, registryAbi, 'findOwner', [organization.label])) === zeroAddress) {
      await send(`Give ${name} to ${organization.label}`, builder, {
        address: directoryRegistry,
        abi: registryAbi,
        functionName: 'register',
        args: [organization.label, account.address, registry, resolver, NAME_ROLES, expiry],
      })
    }
  }
}

export async function checkDirectory(clients) {
  const { publicClient, builder } = clients
  const { read, lookup, refusal, reporter } = ensTools(clients)
  const organizations = withKeys()
  const { report, finish } = reporter()
  console.log(`Checks for ${directoryName} on ${live ? 'Sepolia' : 'the local copy of Sepolia'}`)
  for (const organization of organizations) {
    for (const [label, expected] of Object.entries(organization.contracts)) {
      const name = contractName(organization, label)
      const viaViem = await publicClient.getEnsAddress({ name: normalize(name), universalResolverAddress: UNIVERSAL_RESOLVER })
      const { resolver, record } = await lookup(name)
      const implementation = await read(VERIFIABLE_FACTORY, factoryAbi, 'verifyContract', [resolver]).catch(() => null)
      report(
        record === getAddress(expected) && viaViem === getAddress(expected) && implementation === RESOLVER_IMPL,
        `${name} → ${record ?? 'nothing'} (expected ${getAddress(expected)}), from a genuine ENSv2 resolver: ${implementation === RESOLVER_IMPL}`,
      )
    }
  }
  const directoryRegistry = await read(ETH_REGISTRY, registryAbi, 'getSubregistry', [DIRECTORY_LABEL])
  const [uniswap, circle] = organizations
  const uniswapRouter = contractName(uniswap, 'router')
  const [uniswapResolver] = await read(UNIVERSAL_RESOLVER, universalResolverAbi, 'findResolver', [dns(uniswapRouter)])
  const editUniswapRouter = { address: uniswapResolver, abi: resolverAbi, functionName: 'setAddress', args: [dns(uniswapRouter), ETH_COIN_TYPE, uniswap.contracts.router] }
  const uniswapLabel = BigInt(keccak256(stringToHex('uniswap')))

  const own = await refusal(uniswap.account, editUniswapRouter)
  report(own === null, `Uniswap's key can edit Uniswap's records${own ? ` (refused: ${own})` : ''}`)
  const crossEdit = await refusal(circle.account, editUniswapRouter)
  report(crossEdit !== null, `Circle's key can't edit Uniswap's records (${crossEdit ?? 'it was allowed'})`)
  const takeover = await refusal(circle.account, { address: directoryRegistry, abi: registryAbi, functionName: 'setResolver', args: [uniswapLabel, circle.account.address] })
  report(takeover !== null, `Circle's key can't repoint Uniswap's name (${takeover ?? 'it was allowed'})`)
  const override = await refusal(builder, { address: directoryRegistry, abi: registryAbi, functionName: 'setResolver', args: [uniswapLabel, builder.address] })
  report(override !== null, `The directory's own key can't repoint Uniswap's name (${override ?? 'it was allowed'})`)
  const escalate = await refusal(builder, { address: directoryRegistry, abi: registryAbi, functionName: 'grantRootRoles', args: [ROLE_SET_RESOLVER, builder.address] })
  report(escalate !== null, `The directory's own key can't give itself that power (${escalate ?? 'it was allowed'})`)
  report(await read(directoryRegistry, registryAbi, 'isEmancipated'), 'The directory is emancipated: no key holds override roles on it')
  finish()
}

async function main() {
  const command = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'rehearse'
  if (command === 'keys') return makeKeys()
  if (live) {
    if (!['setup', 'check'].includes(command)) throw new Error('With --live, use setup or check')
    const clients = connect(process.env.SEPOLIA_RPC_URL)
    return command === 'setup' ? setupDirectory(clients) : checkDirectory(clients)
  }
  if (command !== 'rehearse') throw new Error('Without --live, the only commands are keys and rehearse (the default)')
  console.log('Rehearsal on a private local copy of Sepolia. Nothing is sent to the real network.\n')
  const copy = await startLocalCopy()
  try {
    const clients = connect(copy.url)
    await setupDirectory(clients)
    console.log('')
    await checkDirectory(clients)
  } finally {
    copy.stop()
  }
}

if (isMain(import.meta.url)) runMain(main)
