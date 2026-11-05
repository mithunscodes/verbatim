import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  formatEther,
  getAddress,
  keccak256,
  stringToHex,
  encodeAbiParameters,
  encodeFunctionData,
  decodeFunctionResult,
  namehash,
  toHex,
  zeroAddress,
  zeroHash,
  BaseError,
  ContractFunctionRevertedError,
} from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { normalize, packetToBytes } from 'viem/ens'

const DIRECTORY_LABEL = 'verbatimdirectory'
const ORGANIZATIONS = [
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
]

const ETH_REGISTRAR = getAddress('0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3')
const ETH_REGISTRY = getAddress('0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4')
const UNIVERSAL_RESOLVER = getAddress('0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe')
const VERIFIABLE_FACTORY = getAddress('0xda70306c98e97ece36f997a21368e53298572991')
const RESOLVER_IMPL = getAddress('0x115eb53f0c60696633855f90b138178fb40b2b2c')
const USER_REGISTRY_IMPL = getAddress('0x9bd8a88719068d09ecee662f36c0e3856708366a')
const MOCK_USDC = getAddress('0x240b0316df57887dbbe58b586508b19e633a14aa')

const DURATION = 31_536_000n
const ETH_COIN_TYPE = 60n
const ROLE_REGISTRAR = 1n << 0n
const ROLE_SET_PARENT = 1n << 8n
const ROLE_RENEW = 1n << 16n
const ROLE_SET_SUBREGISTRY = 1n << 20n
const ROLE_SET_RESOLVER = 1n << 24n
const ROLE_CAN_TRANSFER_ADMIN = (1n << 28n) << 128n
const ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111n
const admin = (roles) => roles << 128n
const OPERATOR_ROLES = ROLE_REGISTRAR | ROLE_RENEW | ROLE_SET_PARENT | admin(ROLE_REGISTRAR | ROLE_RENEW | ROLE_SET_PARENT)
const ORGANIZATION_ROLES = ROLE_SET_RESOLVER | ROLE_SET_SUBREGISTRY | admin(ROLE_SET_RESOLVER | ROLE_SET_SUBREGISTRY) | ROLE_CAN_TRANSFER_ADMIN
const ORGANIZATION_GAS = 6_000_000n
const LOCAL_PORT = 8546
const ENV_FILE = new URL('../../.env', import.meta.url)
const EXPLORER = 'https://sepolia.etherscan.io/tx/'

const eacErrors = [
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)',
]
const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
])
const registrarAbi = parseAbi([
  'function isAvailable(string label) view returns (bool)',
  'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)',
  'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) view returns (bytes32)',
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)',
  'function MIN_COMMITMENT_AGE() view returns (uint64)',
])
const registryAbi = parseAbi([
  'function initialize((address account, uint256 roleBitmap)[] grants)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
  'function setParent(address parent, string label)',
  'function getParent() view returns (address parent, string label)',
  'function setResolver(uint256 anyId, address resolver)',
  'function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)',
  'function grantRootRoles(uint256 roleBitmap, address account) returns (bool)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function findOwner(string label) view returns (address)',
  'function findExpiry(string label) view returns (uint64)',
  'function getSubregistry(string label) view returns (address)',
  'function isEmancipated() view returns (bool)',
  ...eacErrors,
])
const resolverAbi = parseAbi([
  'function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)',
  'function setAddress(bytes name, uint256 coinType, bytes addressBytes)',
  'function resolve(bytes name, bytes data) view returns (bytes)',
  'function addr(bytes32 node, uint256 coinType) view returns (bytes)',
  ...eacErrors,
])
const factoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address)',
  'function predictProxyAddress(address deployer, uint256 salt) view returns (address)',
  'function verifyContract(address proxy) view returns (address implementation)',
])
const universalResolverAbi = parseAbi(['function findResolver(bytes name) view returns (address resolver, bytes32 node, uint256 offset)'])

const live = process.argv.includes('--live')
const directoryName = `${DIRECTORY_LABEL}.eth`
const dns = (name) => toHex(packetToBytes(normalize(name)))
const organizationName = (organization) => `${organization.label}.${directoryName}`
const contractName = (organization, label) => `${label}.${organizationName(organization)}`

const secrets = () =>
  [
    process.env.SEPOLIA_RPC_URL,
    process.env.SEPOLIA_RPC_URL?.split('/').pop(),
    process.env.BUILDER_PRIVATE_KEY,
    ...ORGANIZATIONS.map((organization) => process.env[organization.keyName]),
  ].filter(Boolean)
const redact = (text) => secrets().reduce((result, secret) => result.split(secret).join('[hidden]'), String(text))

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

function accountFor(keyName) {
  const key = process.env[keyName]
  if (!key) throw new Error(`${keyName} is missing from .env. Run: node --env-file=../.env scripts/directory.js keys`)
  return privateKeyToAccount(key)
}

function connect(url) {
  const transport = http(url)
  const publicClient = createPublicClient({ chain: sepolia, transport })
  const testClient = live ? null : createTestClient({ chain: sepolia, mode: 'anvil', transport })
  const wallet = (account) => createWalletClient({ account, chain: sepolia, transport })
  const builder = accountFor('BUILDER_PRIVATE_KEY')
  const organizations = ORGANIZATIONS.map((organization) => ({ ...organization, account: accountFor(organization.keyName) }))
  return { publicClient, testClient, wallet, builder, organizations }
}

async function startLocalCopy() {
  const child = spawn('anvil', ['--fork-url', process.env.SEPOLIA_RPC_URL, '--port', String(LOCAL_PORT), '--quiet'], { stdio: 'ignore' })
  const url = `http://127.0.0.1:${LOCAL_PORT}`
  const probe = createPublicClient({ transport: http(url) })
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await probe.getChainId()
      return { url, stop: () => child.kill() }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  child.kill()
  throw new Error('The local copy of Sepolia did not start. Is Foundry installed, and is port 8546 free?')
}

function steps({ publicClient, testClient, wallet, builder, organizations }) {
  const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args })
  const hasCode = async (address) => Boolean(await publicClient.getCode({ address }))

  async function send(label, account, request, transfer) {
    console.log(`  ${label}`)
    let hash
    if (transfer) {
      hash = await wallet(account).sendTransaction(transfer)
    } else {
      const { request: simulated } = await publicClient.simulateContract({ account, ...request })
      const estimate = await publicClient.estimateContractGas({ account, ...request })
      hash = await wallet(account).writeContract({ ...simulated, gas: (estimate * 12n) / 10n })
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`Transaction failed: ${hash}`)
    console.log(`    ${live ? `${EXPLORER}${hash}` : 'done on the local copy'}, gas ${receipt.gasUsed}`)
    return receipt
  }

  async function waitSeconds(seconds) {
    if (testClient) {
      await testClient.increaseTime({ seconds })
      await testClient.mine({ blocks: 1 })
      return
    }
    console.log(`  Waiting ${seconds} seconds, as ENS requires`)
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  }

  const resolverSalt = (owner) =>
    BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }], [keccak256(stringToHex('OwnedResolver')), owner, 0n])))
  const registrySalt = (name) =>
    BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }], [keccak256(stringToHex('UserRegistry')), namehash(name), 0n])))
  const predict = (deployer, salt) => read(VERIFIABLE_FACTORY, factoryAbi, 'predictProxyAddress', [deployer, salt])

  async function deployResolver(label, owner, records) {
    const salt = resolverSalt(owner.address)
    const address = await predict(owner.address, salt)
    if (await hasCode(address)) return address
    const data = encodeFunctionData({ abi: resolverAbi, functionName: 'initialize', args: [[{ account: owner.address, roleBitmap: ALL_ROLES }], records] })
    await send(label, owner, { address: VERIFIABLE_FACTORY, abi: factoryAbi, functionName: 'deployProxy', args: [RESOLVER_IMPL, salt, data] })
    return address
  }

  async function deployRegistry(label, name, owner, roles) {
    const salt = registrySalt(name)
    const address = await predict(owner.address, salt)
    if (await hasCode(address)) return address
    const data = encodeFunctionData({ abi: registryAbi, functionName: 'initialize', args: [[{ account: owner.address, roleBitmap: roles }]] })
    await send(label, owner, { address: VERIFIABLE_FACTORY, abi: factoryAbi, functionName: 'deployProxy', args: [USER_REGISTRY_IMPL, salt, data] })
    return address
  }

  async function lookup(name) {
    const encoded = dns(name)
    const [resolver, node, offset] = await read(UNIVERSAL_RESOLVER, universalResolverAbi, 'findResolver', [encoded])
    if (resolver === zeroAddress || offset !== 0n) return { resolver, record: null }
    const data = encodeFunctionData({ abi: resolverAbi, functionName: 'addr', args: [node, ETH_COIN_TYPE] })
    const value = decodeFunctionResult({ abi: resolverAbi, functionName: 'addr', data: await read(resolver, resolverAbi, 'resolve', [encoded, data]) })
    return { resolver, record: value === '0x' ? null : getAddress(value) }
  }

  async function fund(account) {
    const needed = ORGANIZATION_GAS * (await publicClient.getGasPrice()) * 2n
    const balance = await publicClient.getBalance({ address: account.address })
    if (balance >= needed) return
    if (testClient) {
      await testClient.setBalance({ address: account.address, value: needed })
      return
    }
    const hash = await send(`Send ${formatEther(needed - balance)} Sepolia ETH from the Builder key for gas`, builder, null, { to: account.address, value: needed - balance })
    return hash
  }

  async function registerDirectory() {
    console.log(`Directory: ${directoryName}, owned by the Builder key ${builder.address}`)
    const builderResolver = await deployResolver("Create the Builder key's resolver", builder, [])
    const directoryRegistry = await deployRegistry("Create the directory's registry", directoryName, builder, OPERATOR_ROLES)
    if (await read(ETH_REGISTRAR, registrarAbi, 'isAvailable', [DIRECTORY_LABEL])) {
      const [base, premium] = await read(ETH_REGISTRAR, registrarAbi, 'getRegisterPrice', [DIRECTORY_LABEL, DURATION, MOCK_USDC])
      const price = base + premium
      if ((await read(MOCK_USDC, erc20Abi, 'balanceOf', [builder.address])) < price) {
        await send('Mint free mock USDC for the registration fee', builder, { address: MOCK_USDC, abi: erc20Abi, functionName: 'mint', args: [builder.address, price] })
      }
      if ((await read(MOCK_USDC, erc20Abi, 'allowance', [builder.address, ETH_REGISTRAR])) < price) {
        await send('Let the ETH Registrar take exactly the fee', builder, { address: MOCK_USDC, abi: erc20Abi, functionName: 'approve', args: [ETH_REGISTRAR, price] })
      }
      const secret = toHex(crypto.getRandomValues(new Uint8Array(32)))
      const commitArgs = [DIRECTORY_LABEL, builder.address, secret, directoryRegistry, builderResolver, DURATION, zeroHash]
      const commitment = await read(ETH_REGISTRAR, registrarAbi, 'makeCommitment', commitArgs)
      await send(`Commit to ${directoryName} (step 1 of 2)`, builder, { address: ETH_REGISTRAR, abi: registrarAbi, functionName: 'commit', args: [commitment] })
      await waitSeconds(Number(await read(ETH_REGISTRAR, registrarAbi, 'MIN_COMMITMENT_AGE')) + 15)
      await send(`Register ${directoryName} for 1 year (step 2 of 2)`, builder, {
        address: ETH_REGISTRAR,
        abi: registrarAbi,
        functionName: 'register',
        args: [DIRECTORY_LABEL, builder.address, secret, directoryRegistry, builderResolver, DURATION, MOCK_USDC, zeroHash],
      })
    }
    const current = await read(ETH_REGISTRY, registryAbi, 'getSubregistry', [DIRECTORY_LABEL])
    if (getAddress(current) !== directoryRegistry) throw new Error(`${directoryName} is not ours: its registry is ${current}`)
    if (await read(directoryRegistry, registryAbi, 'hasRootRoles', [ROLE_SET_PARENT, builder.address])) {
      await send('Record where the directory sits under .eth', builder, { address: directoryRegistry, abi: registryAbi, functionName: 'setParent', args: [ETH_REGISTRY, DIRECTORY_LABEL] })
      await send('Lock that, so it can never move', builder, {
        address: directoryRegistry,
        abi: registryAbi,
        functionName: 'revokeRootRoles',
        args: [ROLE_SET_PARENT | admin(ROLE_SET_PARENT), builder.address],
      })
    }
    return directoryRegistry
  }

  async function setUpOrganization(organization, directoryRegistry, expiry) {
    const { account } = organization
    const name = organizationName(organization)
    console.log(`Organization: ${name}, owned by ${account.address}`)
    await fund(account)
    const records = Object.entries(organization.contracts).map(([label, address]) =>
      encodeFunctionData({ abi: resolverAbi, functionName: 'setAddress', args: [dns(contractName(organization, label)), ETH_COIN_TYPE, address] }),
    )
    const resolver = await deployResolver(`Create ${organization.label}'s resolver, with its contract addresses`, account, records)
    const registry = await deployRegistry(`Create ${organization.label}'s registry`, name, account, ALL_ROLES)
    for (const [label, address] of Object.entries(organization.contracts)) {
      if ((await read(registry, registryAbi, 'findOwner', [label])) === zeroAddress) {
        await send(`Register ${contractName(organization, label)}`, account, {
          address: registry,
          abi: registryAbi,
          functionName: 'register',
          args: [label, account.address, zeroAddress, resolver, ORGANIZATION_ROLES, expiry],
        })
      }
      const encoded = dns(contractName(organization, label))
      const data = encodeFunctionData({ abi: resolverAbi, functionName: 'addr', args: [namehash(contractName(organization, label)), ETH_COIN_TYPE] })
      const value = decodeFunctionResult({ abi: resolverAbi, functionName: 'addr', data: await read(resolver, resolverAbi, 'resolve', [encoded, data]) })
      if (value === '0x' || getAddress(value) !== getAddress(address)) {
        await send(`Point ${contractName(organization, label)} to ${address}`, account, {
          address: resolver,
          abi: resolverAbi,
          functionName: 'setAddress',
          args: [encoded, ETH_COIN_TYPE, address],
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
        args: [organization.label, account.address, registry, resolver, ORGANIZATION_ROLES, expiry],
      })
    }
    return { ...organization, resolver, registry }
  }

  async function setup() {
    const directoryRegistry = await registerDirectory()
    const expiry = await read(ETH_REGISTRY, registryAbi, 'findExpiry', [DIRECTORY_LABEL])
    for (const organization of organizations) await setUpOrganization(organization, directoryRegistry, expiry)
  }

  async function refusal(account, request) {
    try {
      await publicClient.simulateContract({ account, ...request })
      return null
    } catch (error) {
      const reverted = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : null
      return reverted?.data?.errorName ?? reverted?.reason ?? 'refused'
    }
  }

  async function check() {
    let failures = 0
    const report = (ok, text) => {
      if (!ok) failures++
      console.log(`${ok ? '✓' : '✗'} ${text}`)
    }
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
    console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`)
    if (failures > 0) process.exitCode = 1
  }

  return { setup, check }
}

async function main() {
  const command = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'rehearse'
  if (command === 'keys') return makeKeys()
  if (live) {
    if (!['setup', 'check'].includes(command)) throw new Error('With --live, use setup or check')
    const run = steps(connect(process.env.SEPOLIA_RPC_URL))
    return run[command]()
  }
  if (command !== 'rehearse') throw new Error('Without --live, the only commands are keys and rehearse (the default)')
  console.log('Rehearsal on a private local copy of Sepolia. Nothing is sent to the real network.\n')
  const copy = await startLocalCopy()
  try {
    const run = steps(connect(copy.url))
    await run.setup()
    console.log('')
    await run.check()
  } finally {
    copy.stop()
  }
}

main().catch((error) => {
  console.error(redact(error.stack ?? error))
  process.exit(1)
})
