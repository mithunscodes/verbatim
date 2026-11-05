import { readFileSync } from 'node:fs'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  formatEther,
  getAddress,
  keccak256,
  stringToHex,
  encodeAbiParameters,
  encodeFunctionData,
  encodeDeployData,
  decodeFunctionResult,
  parseEventLogs,
  concat,
  getCreate2Address,
  namehash,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { normalize, packetToBytes } from 'viem/ens'

const ETH_REGISTRAR = getAddress('0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3')
const ETH_REGISTRY = getAddress('0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4')
const UNIVERSAL_RESOLVER = getAddress('0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe')
const VERIFIABLE_FACTORY = getAddress('0xda70306c98e97ece36f997a21368e53298572991')
const RESOLVER_IMPL = getAddress('0x115eb53f0c60696633855f90b138178fb40b2b2c')
const MOCK_USDC = getAddress('0x240b0316df57887dbbe58b586508b19e633a14aa')
const RECORD = getAddress('0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b')
const LABEL = 'ensreadtest'
const NAME = normalize(`${LABEL}.eth`)
const DNS_NAME = toHex(packetToBytes(NAME))
const NODE = namehash(NAME)
const DURATION = 31_536_000n
const ETH_COIN_TYPE = 60n
const ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111n
const MINT_AMOUNT = 10_000_000n
const EXPLORER = 'https://sepolia.etherscan.io/tx/'
const ARTIFACT = new URL('../../contracts/out/EnsReadTest.sol/EnsReadTest.json', import.meta.url)

const secrets = [
  process.env.BUILDER_PRIVATE_KEY,
  process.env.SEPOLIA_RPC_URL,
  process.env.SEPOLIA_RPC_URL?.split('/').pop(),
].filter(Boolean)
const redact = (text) => secrets.reduce((result, secret) => result.split(secret).join('[hidden]'), String(text))

const account = privateKeyToAccount(process.env.BUILDER_PRIVATE_KEY)
const transport = http(process.env.SEPOLIA_RPC_URL)
const publicClient = createPublicClient({ chain: sepolia, transport })
const walletClient = createWalletClient({ account, chain: sepolia, transport })

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
const registryAbi = parseAbi(['function getResolver(string label) view returns (address)'])
const universalResolverAbi = parseAbi([
  'function findResolver(bytes name) view returns (address resolver, bytes32 node, uint256 offset)',
])
const factoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data)',
  'function proxyLogic() view returns (address)',
  'event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)',
])
const resolverAbi = parseAbi([
  'function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)',
  'function setAddress(bytes name, uint256 coinType, bytes value)',
  'function resolve(bytes name, bytes data) view returns (bytes)',
  'function addr(bytes32 node, uint256 coinType) view returns (bytes)',
])

const resolverSalt = BigInt(keccak256(encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
  [keccak256(stringToHex('OwnedResolver')), account.address, 0n],
)))

const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args })

async function predictResolver() {
  const proxyLogic = await read(VERIFIABLE_FACTORY, factoryAbi, 'proxyLogic')
  const outerSalt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account.address, resolverSalt]))
  const initCode = concat(['0x3d604d80600a3d3981f3363d3d373d3d3d363d73', proxyLogic, '0x5af43d82803e903d91602b57fd5bf3', outerSalt])
  return getCreate2Address({ from: VERIFIABLE_FACTORY, salt: outerSalt, bytecodeHash: keccak256(initCode) })
}

async function registerPrice() {
  const [base, premium] = await read(ETH_REGISTRAR, registrarAbi, 'getRegisterPrice', [LABEL, DURATION, MOCK_USDC])
  return base + premium
}

async function readRecord(resolver) {
  const data = encodeFunctionData({ abi: resolverAbi, functionName: 'addr', args: [NODE, ETH_COIN_TYPE] })
  const result = await read(resolver, resolverAbi, 'resolve', [DNS_NAME, data])
  const value = decodeFunctionResult({ abi: resolverAbi, functionName: 'addr', data: result })
  return value === '0x' ? null : getAddress(value)
}

async function send(label, request) {
  console.log(label)
  const { request: simulated } = await publicClient.simulateContract({ account, ...request })
  const estimate = await publicClient.estimateContractGas({ account, ...request })
  const hash = await walletClient.writeContract({ ...simulated, gas: (estimate * 12n) / 10n })
  console.log(`  Sent: ${EXPLORER}${hash}`)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Transaction failed: ${EXPLORER}${hash}`)
  console.log(`  Result: success, block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`)
  return receipt
}

async function status() {
  const resolver = await predictResolver()
  const resolverCode = await publicClient.getCode({ address: resolver })
  const registryResolver = await read(ETH_REGISTRY, registryAbi, 'getResolver', [LABEL])
  const [found, , offset] = await read(UNIVERSAL_RESOLVER, universalResolverAbi, 'findResolver', [DNS_NAME])
  console.log(`Builder key: ${account.address}`)
  console.log(`ETH: ${formatEther(await publicClient.getBalance({ address: account.address }))}`)
  console.log(`Mock USDC: ${formatUnits(await read(MOCK_USDC, erc20Abi, 'balanceOf', [account.address]), 6)}`)
  console.log(`Mock USDC the ETH Registrar may take: ${formatUnits(await read(MOCK_USDC, erc20Abi, 'allowance', [account.address, ETH_REGISTRAR]), 6)}`)
  const available = await read(ETH_REGISTRAR, registrarAbi, 'isAvailable', [LABEL])
  console.log(`Our resolver: ${resolver} (${resolverCode ? 'created' : 'not created yet'})`)
  console.log(`${NAME} available: ${available}`)
  if (available) console.log(`Price of ${NAME} for 1 year: ${formatUnits(await registerPrice(), 6)} mock USDC`)
  console.log(`${NAME} resolver in the .eth registry: ${registryResolver}`)
  console.log(`Universal Resolver finds: ${found} (offset ${offset})`)
  if (resolverCode && getAddress(registryResolver) === resolver) console.log(`Record (ETH address): ${(await readRecord(resolver)) ?? 'none'}`)
}

async function setup() {
  const resolver = await predictResolver()
  const available = await read(ETH_REGISTRAR, registrarAbi, 'isAvailable', [LABEL])

  if (available) {
    const price = await registerPrice()
    if ((await read(MOCK_USDC, erc20Abi, 'balanceOf', [account.address])) < price) {
      await send(`Mint ${formatUnits(MINT_AMOUNT, 6)} free mock USDC`, { address: MOCK_USDC, abi: erc20Abi, functionName: 'mint', args: [account.address, MINT_AMOUNT] })
    }
    if ((await read(MOCK_USDC, erc20Abi, 'allowance', [account.address, ETH_REGISTRAR])) < price) {
      await send(`Let the ETH Registrar take exactly ${formatUnits(price, 6)} mock USDC`, { address: MOCK_USDC, abi: erc20Abi, functionName: 'approve', args: [ETH_REGISTRAR, price] })
    }
  }
  if (!(await publicClient.getCode({ address: resolver }))) {
    const data = encodeFunctionData({ abi: resolverAbi, functionName: 'initialize', args: [[{ account: account.address, roleBitmap: ALL_ROLES }], []] })
    const receipt = await send('Create our own resolver', { address: VERIFIABLE_FACTORY, abi: factoryAbi, functionName: 'deployProxy', args: [RESOLVER_IMPL, resolverSalt, data] })
    const [log] = parseEventLogs({ abi: factoryAbi, eventName: 'ProxyDeployed', logs: receipt.logs })
    if (getAddress(log.args.proxyAddress) !== resolver) throw new Error(`Resolver created at ${log.args.proxyAddress}, expected ${resolver}`)
  }
  if (available) {
    const secret = toHex(crypto.getRandomValues(new Uint8Array(32)))
    const commitment = await read(ETH_REGISTRAR, registrarAbi, 'makeCommitment', [LABEL, account.address, secret, zeroAddress, resolver, DURATION, zeroHash])
    await send(`Commit to ${NAME} (step 1 of 2)`, { address: ETH_REGISTRAR, abi: registrarAbi, functionName: 'commit', args: [commitment] })
    const wait = Number(await read(ETH_REGISTRAR, registrarAbi, 'MIN_COMMITMENT_AGE')) + 15
    console.log(`  Waiting ${wait} seconds, as ENS requires`)
    await new Promise((resolve) => setTimeout(resolve, wait * 1000))
    await send(`Register ${NAME} for 1 year (step 2 of 2)`, { address: ETH_REGISTRAR, abi: registrarAbi, functionName: 'register', args: [LABEL, account.address, secret, zeroAddress, resolver, DURATION, MOCK_USDC, zeroHash] })
  }
  const registryResolver = await read(ETH_REGISTRY, registryAbi, 'getResolver', [LABEL])
  if (getAddress(registryResolver) !== resolver) throw new Error(`${NAME} is not ours: its resolver is ${registryResolver}`)
  if ((await readRecord(resolver)) !== RECORD) {
    await send(`Set ${NAME} to point to ${RECORD}`, { address: resolver, abi: resolverAbi, functionName: 'setAddress', args: [DNS_NAME, ETH_COIN_TYPE, RECORD] })
  }
  console.log('')
  await status()
}

function loadArtifact() {
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'))
  return { abi: artifact.abi, bytecode: artifact.bytecode.object }
}

async function deploy() {
  const { abi, bytecode } = loadArtifact()
  const args = [UNIVERSAL_RESOLVER, VERIFIABLE_FACTORY, RESOLVER_IMPL]
  const estimate = await publicClient.estimateGas({ account, data: encodeDeployData({ abi, bytecode, args }) })
  console.log('Deploy the reader contract')
  const hash = await walletClient.deployContract({ abi, bytecode, args, gas: (estimate * 12n) / 10n })
  console.log(`  Sent: ${EXPLORER}${hash}`)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Transaction failed: ${EXPLORER}${hash}`)
  console.log(`  Result: success, block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`)
  console.log(`Reader contract: ${receipt.contractAddress}`)
}

async function readInTransaction() {
  const reader = getAddress(process.argv[3])
  const { abi } = loadArtifact()
  const request = { address: reader, abi, functionName: 'read', args: [DNS_NAME] }
  const { result } = await publicClient.simulateContract({ account, ...request })
  console.log(`Practice run: ${NAME} points to ${result}`)
  const receipt = await send(`Read ${NAME} inside a transaction`, request)
  const [log] = parseEventLogs({ abi, eventName: 'RecordRead', logs: receipt.logs })
  const { record, resolver, findResolverGas, readRecordGas, verifyResolverGas } = log.args
  console.log(`Record read on-chain: ${record} (${getAddress(record) === RECORD ? 'matches' : 'DOES NOT match'} the record we set)`)
  console.log(`Resolver: ${resolver}`)
  console.log(`Gas: find resolver ${findResolverGas}, read record ${readRecordGas}, check resolver is genuine ${verifyResolverGas}, whole transaction ${receipt.gasUsed}`)
}

const commands = { status, setup, deploy, read: readInTransaction }
const command = commands[process.argv[2]]
if (!command) {
  console.log('Usage: node --env-file=../.env experiments/ens-read.js status|setup|deploy|read <reader address>')
  process.exit(1)
}
command().catch((error) => {
  console.error(redact(error.stack ?? error))
  process.exit(1)
})
