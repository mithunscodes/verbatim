import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
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
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { normalize, packetToBytes } from 'viem/ens'

export const ETH_REGISTRAR = getAddress('0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3')
export const ETH_REGISTRY = getAddress('0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4')
export const UNIVERSAL_RESOLVER = getAddress('0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe')
export const VERIFIABLE_FACTORY = getAddress('0xda70306c98e97ece36f997a21368e53298572991')
export const RESOLVER_IMPL = getAddress('0x115eb53f0c60696633855f90b138178fb40b2b2c')
export const USER_REGISTRY_IMPL = getAddress('0x9bd8a88719068d09ecee662f36c0e3856708366a')
export const MOCK_USDC = getAddress('0x240b0316df57887dbbe58b586508b19e633a14aa')

export const DURATION = 31_536_000n
export const ETH_COIN_TYPE = 60n
export const admin = (roles) => roles << 128n
export const ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111n
export const ROLE_REGISTRAR = 1n << 0n
export const ROLE_SET_PARENT = 1n << 8n
export const ROLE_RENEW = 1n << 16n
export const ROLE_SET_SUBREGISTRY = 1n << 20n
export const ROLE_SET_RESOLVER = 1n << 24n
export const ROLE_CAN_TRANSFER_ADMIN = (1n << 28n) << 128n
export const NAME_ROLES = ROLE_SET_RESOLVER | ROLE_SET_SUBREGISTRY | admin(ROLE_SET_RESOLVER | ROLE_SET_SUBREGISTRY) | ROLE_CAN_TRANSFER_ADMIN
export const RESOLVER_SET_ADDRESS = 1n << 0n
export const RESOLVER_SET_TEXT = 1n << 4n

const LOCAL_PORT = 8546
const EXPLORER = 'https://sepolia.etherscan.io/tx/'

const eacErrors = [
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)',
]
export const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
])
export const registrarAbi = parseAbi([
  'function isAvailable(string label) view returns (bool)',
  'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)',
  'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) view returns (bytes32)',
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)',
  'function MIN_COMMITMENT_AGE() view returns (uint64)',
])
export const registryAbi = parseAbi([
  'function initialize((address account, uint256 roleBitmap)[] grants)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
  'function renew(uint256 anyId, uint64 newExpiry)',
  'function unregister(uint256 anyId)',
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
export const resolverAbi = parseAbi([
  'function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)',
  'function setAddress(bytes name, uint256 coinType, bytes addressBytes)',
  'function setText(bytes name, string key, string value)',
  'function grantSetterRoles(bytes setter, address account) returns (bool)',
  'function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function resolve(bytes name, bytes data) view returns (bytes)',
  'function addr(bytes32 node, uint256 coinType) view returns (bytes)',
  'function text(bytes32 node, string key) view returns (string)',
  ...eacErrors,
])
export const factoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address)',
  'function predictProxyAddress(address deployer, uint256 salt) view returns (address)',
  'function verifyContract(address proxy) view returns (address implementation)',
])
export const universalResolverAbi = parseAbi(['function findResolver(bytes name) view returns (address resolver, bytes32 node, uint256 offset)'])

export const live = process.argv.includes('--live')
export const dns = (name) => toHex(packetToBytes(normalize(name)))

export function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : process.argv[index + 1]
}

export function options(name) {
  return process.argv.flatMap((arg, i) => (arg === `--${name}` ? [process.argv[i + 1]] : []))
}

const knownSecrets = () =>
  [process.env.SEPOLIA_RPC_URL, process.env.SEPOLIA_RPC_URL?.split('/').pop()]
    .concat(Object.entries(process.env).filter(([name]) => name.endsWith('_PRIVATE_KEY')).map(([, value]) => value))
    .filter(Boolean)
export const redact = (text) => knownSecrets().reduce((result, secret) => result.split(secret).join('[hidden]'), String(text))

export function accountFor(keyName, makeWith = 'scripts/directory.js keys') {
  const key = process.env[keyName]
  if (!key) throw new Error(`${keyName} is missing from .env. Run: node --env-file=../.env ${makeWith}`)
  return privateKeyToAccount(key)
}

export async function startLocalCopy() {
  const child = spawn('anvil', ['--fork-url', process.env.SEPOLIA_RPC_URL, '--port', String(LOCAL_PORT), '--quiet'], { stdio: 'ignore' })
  const url = `http://127.0.0.1:${LOCAL_PORT}`
  const probe = createPublicClient({ transport: http(url) })
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await probe.getChainId()
      return { url, pid: child.pid, stop: () => child.kill(), leave: () => child.unref() }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  child.kill()
  throw new Error(`The local copy of Sepolia did not start. Is Foundry installed, and is port ${LOCAL_PORT} free?`)
}

export function connect(url) {
  const transport = http(url, { timeout: 120_000 })
  const publicClient = createPublicClient({ chain: sepolia, transport })
  const testClient = live ? null : createTestClient({ chain: sepolia, mode: 'anvil', transport })
  const wallet = (account) => createWalletClient({ account, chain: sepolia, transport })
  return { publicClient, testClient, wallet, builder: accountFor('BUILDER_PRIVATE_KEY') }
}

export function ensTools({ publicClient, testClient, wallet, builder }) {
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
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 600_000 })
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

  async function deployResolver(label, deployer, saltOwner, grants, records) {
    const salt = resolverSalt(saltOwner)
    const address = await predict(deployer.address, salt)
    if (await hasCode(address)) return { address, created: false }
    const data = encodeFunctionData({ abi: resolverAbi, functionName: 'initialize', args: [grants, records] })
    await send(label, deployer, { address: VERIFIABLE_FACTORY, abi: factoryAbi, functionName: 'deployProxy', args: [RESOLVER_IMPL, salt, data] })
    return { address, created: true }
  }

  async function deployRegistry(label, deployer, name, grants) {
    const salt = registrySalt(name)
    const address = await predict(deployer.address, salt)
    if (await hasCode(address)) return { address, created: false }
    const data = encodeFunctionData({ abi: registryAbi, functionName: 'initialize', args: [grants] })
    await send(label, deployer, { address: VERIFIABLE_FACTORY, abi: factoryAbi, functionName: 'deployProxy', args: [USER_REGISTRY_IMPL, salt, data] })
    return { address, created: true }
  }

  async function registerEthName(label, owner, subregistry, resolver) {
    const name = `${label}.eth`
    if (await read(ETH_REGISTRAR, registrarAbi, 'isAvailable', [label])) {
      const [base, premium] = await read(ETH_REGISTRAR, registrarAbi, 'getRegisterPrice', [label, DURATION, MOCK_USDC])
      const price = base + premium
      if ((await read(MOCK_USDC, erc20Abi, 'balanceOf', [builder.address])) < price) {
        await send('Mint free mock USDC for the registration fee', builder, { address: MOCK_USDC, abi: erc20Abi, functionName: 'mint', args: [builder.address, price] })
      }
      if ((await read(MOCK_USDC, erc20Abi, 'allowance', [builder.address, ETH_REGISTRAR])) < price) {
        await send('Let the ETH Registrar take exactly the fee', builder, { address: MOCK_USDC, abi: erc20Abi, functionName: 'approve', args: [ETH_REGISTRAR, price] })
      }
      const secret = toHex(crypto.getRandomValues(new Uint8Array(32)))
      const commitment = await read(ETH_REGISTRAR, registrarAbi, 'makeCommitment', [label, owner, secret, subregistry, resolver, DURATION, zeroHash])
      await send(`Commit to ${name} (step 1 of 2)`, builder, { address: ETH_REGISTRAR, abi: registrarAbi, functionName: 'commit', args: [commitment] })
      await waitSeconds(Number(await read(ETH_REGISTRAR, registrarAbi, 'MIN_COMMITMENT_AGE')) + 15)
      await send(`Register ${name} for 1 year (step 2 of 2)`, builder, {
        address: ETH_REGISTRAR,
        abi: registrarAbi,
        functionName: 'register',
        args: [label, owner, secret, subregistry, resolver, DURATION, MOCK_USDC, zeroHash],
      })
    }
    const current = await read(ETH_REGISTRY, registryAbi, 'getSubregistry', [label])
    if (getAddress(current) !== getAddress(subregistry)) throw new Error(`${name} is not ours: its registry is ${current}`)
    return read(ETH_REGISTRY, registryAbi, 'findExpiry', [label])
  }

  async function lookup(name) {
    const encoded = dns(name)
    const [resolver, node, offset] = await read(UNIVERSAL_RESOLVER, universalResolverAbi, 'findResolver', [encoded])
    if (resolver === zeroAddress || offset !== 0n) return { resolver, record: null }
    const data = encodeFunctionData({ abi: resolverAbi, functionName: 'addr', args: [node, ETH_COIN_TYPE] })
    const value = decodeFunctionResult({ abi: resolverAbi, functionName: 'addr', data: await read(resolver, resolverAbi, 'resolve', [encoded, data]) })
    return { resolver, record: value === '0x' ? null : getAddress(value) }
  }

  async function readText(name, key) {
    const encoded = dns(name)
    const [resolver, node] = await read(UNIVERSAL_RESOLVER, universalResolverAbi, 'findResolver', [encoded])
    const data = encodeFunctionData({ abi: resolverAbi, functionName: 'text', args: [node, key] })
    return decodeFunctionResult({ abi: resolverAbi, functionName: 'text', data: await read(resolver, resolverAbi, 'resolve', [encoded, data]) })
  }

  async function fund(account, gas) {
    const needed = gas * (await publicClient.getGasPrice()) * 2n
    const balance = await publicClient.getBalance({ address: account.address })
    if (balance >= needed) return
    if (testClient) {
      await testClient.setBalance({ address: account.address, value: needed })
      return
    }
    await send(`Send ${formatEther(needed - balance)} Sepolia ETH from the Builder key for gas`, builder, null, { to: account.address, value: needed - balance })
  }

  async function refusal(account, request) {
    try {
      await publicClient.simulateContract({ account, ...request })
      return null
    } catch (error) {
      const reverted = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : null
      return reverted?.data?.errorName === 'Error' ? reverted.data.args[0] : reverted?.data?.errorName ?? reverted?.reason ?? 'refused'
    }
  }

  function reporter() {
    let failures = 0
    const report = (ok, text) => {
      if (!ok) failures++
      console.log(`${ok ? '✓' : '✗'} ${text}`)
    }
    const finish = () => {
      console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`)
      if (failures > 0) process.exitCode = 1
    }
    return { report, finish }
  }

  return { read, hasCode, send, waitSeconds, deployResolver, deployRegistry, registerEthName, lookup, readText, fund, refusal, reporter }
}

export function artifact(file, contract) {
  const json = JSON.parse(readFileSync(new URL(`../../contracts/out/${file}/${contract}.json`, import.meta.url), 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode.object }
}

export function isMain(url) {
  return process.argv[1] && url === pathToFileURL(process.argv[1]).href
}

export function runMain(main) {
  main().catch((error) => {
    console.error(redact(error.stack ?? error))
    process.exit(1)
  })
}
