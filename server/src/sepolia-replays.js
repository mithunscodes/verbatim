import { existsSync, readFileSync } from 'node:fs'
import {
  BaseError,
  ContractFunctionRevertedError,
  concat,
  encodeDeployData,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  formatEther,
  getAddress,
  getContractAddress,
  keccak256,
  pad,
  parseAbi,
  parseEther,
  parseEventLogs,
  size,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { REPLAY_ATTEMPT_GAS, REPLAY_PRIORITY_FEE } from './config.js'
import { AAVE, BYBIT } from './replays.js'

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

export const GAS_MONEY = { everyday: parseEther('0.01'), rules: parseEther('0.001'), thief: parseEther('0.003') }

export const BYBIT_REASON = 'Borrowed code would run in your account'

export const AAVE_REASON = 'Unfair trade'

export const UNISWAP = {
  v3Factory: getAddress('0x0227628f3F023bb0B980b67D528571c95c6DaC1c'),
  v2Factory: getAddress('0xF62c03E08ada871A0bEb309762E260a7a6a880E6'),
}

const AAVE_TOKENS = [
  ['aave', 'Test AAVE (Verbatim replay)', 'tAAVE', 18],
  ['weth', 'Test WETH (Verbatim replay)', 'tWETH', 18],
  ['usdt', 'Test USDT (Verbatim replay)', 'tUSDT', 6],
]
const LOW_ADDRESS = 2n ** 158n
const MAX_SALTS = 100_000n
const ATTEMPT_GAS_EXTRA = 1_000_000n
const SELL_BACK_GAS = 200_000n
const CheckKind = { AtMostLeaves: 0, AtLeastArrives: 1 }

export const REPLAY_CONTRACTS = ['VerbatimVault', 'ReplayDirectory', 'ReplayPools', 'ReplayToken', 'ReplayRoute', 'FixedPriceSource']

export const REPLAY_KEYS = {
  REPLAY_EVERYDAY_PRIVATE_KEY: "Replay vaults' everyday key",
  REPLAY_RULES_PRIVATE_KEY: "Replay vaults' Rules key, kept on the laptop",
  REPLAY_THIEF_PRIVATE_KEY: 'Replay thief: plays the attacker and receives what the Bybit sweep takes',
  ...Object.fromEntries(
    Array.from({ length: SAFE.owners }, (_, i) => [`BYBIT_SIGNER_${i + 1}_PRIVATE_KEY`, `Owner ${i + 1} of the Bybit replay's Safes`]),
  ),
}

const MAKE_KEYS = 'scripts/sepolia-replays.js keys'
const SAVE_CONTRACTS = 'scripts/sepolia-replays.js contracts'
const CODE = new URL('./bybit-code.json', import.meta.url)
const CONTRACTS = new URL('./replay-contracts.json', import.meta.url)
const POOLS = new URL('./aave-pools.json', import.meta.url)
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
const factoryAbi = parseAbi(['function vaultOf(address everydayKey) view returns (address)'])
const pairAbi = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)',
  'function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)',
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
  return { maxPriorityFeePerGas: REPLAY_PRIORITY_FEE, maxFeePerGas: (baseFeePerGas ?? 0n) * 2n + REPLAY_PRIORITY_FEE }
}

export async function sendSteps({ publicClient, wallet }, account, steps, log = () => {}) {
  if (steps.length === 0) return []
  const [nonce, fees] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    demoFees(publicClient),
  ])
  const hashes = []
  for (const [i, step] of steps.entries()) {
    const gas = step.gas ?? ((await publicClient.estimateGas({ account, ...step.request })) * BUFFER) / 10n
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

export async function topUpFees(ctx, accounts, log = () => {}) {
  const steps = []
  for (const role of ['everyday', 'rules', 'thief']) {
    const address = accounts[role].address
    const balance = await ctx.publicClient.getBalance({ address })
    if (balance >= GAS_MONEY[role] / 2n) continue
    if (ctx.testClient) {
      await ctx.testClient.setBalance({ address, value: GAS_MONEY[role] })
      continue
    }
    const value = GAS_MONEY[role] - balance
    steps.push({ label: `${formatEther(value)} test ETH for fees, from the Builder key to the replay ${role} key`, request: { to: address, value } })
  }
  await sendSteps(ctx, ctx.builder, steps, log)
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

const sent = ({ transactionHash, status, blockNumber, gasUsed, effectiveGasPrice }) => ({
  hash: transactionHash,
  status,
  block: blockNumber,
  fee: gasUsed * effectiveGasPrice,
})

let frozen = null

function replayContracts() {
  if (!existsSync(CONTRACTS)) throw new Error(`server/src/replay-contracts.json is missing. Run: node --env-file=../.env ${SAVE_CONTRACTS}`)
  frozen ??= JSON.parse(readFileSync(CONTRACTS, 'utf8'))
  return frozen
}

export const vaultFactory = () => replayContracts().vaultFactory

export const abiOf = (name) => replayContracts().contracts[name].abi

const built = (name, args) => encodeDeployData({ abi: abiOf(name), bytecode: replayContracts().contracts[name].bytecode, args })

export function bybitCode() {
  return JSON.parse(readFileSync(CODE, 'utf8'))
}

const creationCode = (runtime) => concat(['0x61', toHex(size(runtime), { size: 2 }), '0x80600c6000396000f3', runtime])

const viaDeployer = (bytecode, salt = zeroHash) => ({
  deploy: concat([salt, bytecode]),
  address: getContractAddress({ opcode: 'CREATE2', from: DEPLOYER, salt, bytecode }),
})

export function copies(thief) {
  const code = bybitCode()
  const attacker = BYBIT.attacker.slice(2).toLowerCase()
  const runtimes = { trojan: code.trojan, backdoor: code.backdoor.toLowerCase().split(attacker).join(thief.slice(2).toLowerCase()) }
  return Object.fromEntries(Object.entries(runtimes).map(([name, runtime]) => [name, { runtime, ...viaDeployer(creationCode(runtime)) }]))
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
    publicClient.readContract({ address: vaultFactory(), abi: factoryAbi, functionName: 'vaultOf', args: [accounts.everyday.address] }),
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
    abi: abiOf('VerbatimVault'),
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
    wallet(accounts.everyday).writeContract({ ...attempt, ...fees, gas: REPLAY_ATTEMPT_GAS }),
  ])
  const receipts = await Promise.all(hashes.map((hash) => publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })))
  const [codeAfter, safeAfter, vaultAfter] = await Promise.all([codeOf(publicClient, scene.safe), balance(scene.safe), balance(scene.vault)])
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

export function aavePools() {
  return JSON.parse(readFileSync(POOLS, 'utf8'))
}

function aaveTokens(helper) {
  const tokens = {}
  let floor = 0n
  for (const [key, name, symbol, decimals] of AAVE_TOKENS) {
    const bytecode = built('ReplayToken', [name, symbol, decimals, helper])
    for (let salt = 0n; !tokens[key]; salt++) {
      if (salt === MAX_SALTS) throw new Error(`No salt puts ${symbol} in mainnet's token order`)
      const candidate = viaDeployer(bytecode, pad(toHex(salt)))
      const value = BigInt(candidate.address)
      if (value > floor && (floor > 0n || value < LOW_ADDRESS)) tokens[key] = { ...candidate, symbol, decimals }
    }
    floor = BigInt(tokens[key].address)
  }
  return tokens
}

export async function aaveScene(publicClient, owner, accounts) {
  const data = aavePools()
  const helper = viaDeployer(built('ReplayPools', [owner, UNISWAP.v3Factory, UNISWAP.v2Factory]))
  const tokens = aaveTokens(helper.address)
  const read = (functionName) =>
    publicClient.readContract({ address: helper.address, abi: abiOf('ReplayPools'), functionName }).catch(() => zeroAddress)
  const [pool, pair] = await Promise.all([read('pool'), read('pair')])
  const coins = [tokens.usdt, tokens.aave]
  const route = viaDeployer(built('ReplayRoute', [tokens.usdt.address, tokens.weth.address, pool, pair]))
  const source = viaDeployer(
    built('FixedPriceSource', [
      coins.map((token) => token.address),
      [BigInt(data.prices.usdt), BigInt(data.prices.aave)],
      coins.map((token) => token.decimals),
      data.prices.decimals,
    ]),
  )
  const directory = viaDeployer(built('ReplayDirectory', [[route.address]]))
  const vault = viaDeployer(
    built('VerbatimVault', [accounts.everyday.address, accounts.rules.address, coins.map((token) => token.address), directory.address]),
  )
  return { data, helper, tokens, pool, pair, route, source, directory, vault, holders: [accounts.everyday.address, vault.address] }
}

export async function aaveReady(publicClient, scene) {
  return publicClient
    .readContract({ address: scene.helper.address, abi: abiOf('ReplayPools'), functionName: 'isReset', args: [scene.holders] })
    .catch(() => false)
}

async function sellBack(ctx, accounts, scene, log) {
  const { publicClient } = ctx
  const [[aaveReserve, wethReserve], held] = await Promise.all([
    publicClient.readContract({ address: scene.pair, abi: pairAbi, functionName: 'getReserves' }),
    publicClient.readContract({ address: scene.tokens.aave.address, abi: erc20Abi, functionName: 'balanceOf', args: [accounts.everyday.address] }),
  ])
  const extra = wethReserve - BigInt(scene.data.v2.weth)
  if (extra <= 0n || held === 0n) return
  const needed = (aaveReserve * extra * 1000n) / ((wethReserve - extra) * 997n) + 1n
  const aaveIn = needed < held ? needed : held
  const wethOut = (aaveIn * 997n * wethReserve) / (aaveReserve * 1000n + aaveIn * 997n)
  await sendSteps(ctx, accounts.everyday, [
    {
      label: `The normal wallet sells ${formatEther(aaveIn)} tAAVE back into the v2 pool`,
      request: { to: scene.tokens.aave.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [scene.pair, aaveIn] }) },
    },
    {
      label: `The v2 pool's price goes back: ${formatEther(wethOut)} tWETH out, to the pool helper`,
      request: { to: scene.pair, data: encodeFunctionData({ abi: pairAbi, functionName: 'swap', args: [0n, wethOut, scene.helper.address, '0x'] }) },
      gas: SELL_BACK_GAS,
    },
  ], log)
}

export async function resetAave(ctx, accounts, log) {
  const scene = await aaveScene(ctx.publicClient, ctx.builder.address, accounts)
  if (await aaveReady(ctx.publicClient, scene)) return scene
  await sellBack(ctx, accounts, scene, log)
  const data = encodeFunctionData({ abi: abiOf('ReplayPools'), functionName: 'reset', args: [scene.holders] })
  await sendSteps(ctx, ctx.builder, [{ label: 'Put both pools and the tUSDT back exactly', request: { to: scene.helper.address, data } }], log)
  return scene
}

export async function runAave({ publicClient, wallet, builder }, accounts) {
  const started = Date.now()
  const scene = await aaveScene(publicClient, builder.address, accounts)
  const { usdt, aave } = scene.tokens
  const owner = accounts.everyday
  const vault = scene.vault.address
  const holdings = () =>
    publicClient.multicall({
      allowFailure: false,
      contracts: [
        [usdt, owner.address],
        [aave, owner.address],
        [usdt, vault],
        [aave, vault],
      ].map(([token, holder]) => ({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [holder] })),
    })
  const [ready, nonce, fees, block, before] = await Promise.all([
    aaveReady(publicClient, scene),
    publicClient.getTransactionCount({ address: owner.address, blockTag: 'pending' }),
    demoFees(publicClient),
    publicClient.getBlock(),
    holdings(),
  ])
  if (!ready) throw new Error("The Aave replay's pools are still being put back. Try again in a few seconds, or run setup.")
  const amount = BigInt(scene.data.trade.usdtIn)
  const routeAbi = abiOf('ReplayRoute')
  const trade = { address: scene.route.address, abi: routeAbi, functionName: 'swap', args: [amount] }
  const attempt = {
    address: vault,
    abi: abiOf('VerbatimVault'),
    functionName: 'run',
    args: [
      [
        { target: usdt.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [scene.route.address, amount] }), operation: 0 },
        { target: scene.route.address, value: 0n, data: encodeFunctionData(trade), operation: 0 },
      ],
      [
        { kind: CheckKind.AtMostLeaves, token: usdt.address, to: zeroAddress, amount },
        { kind: CheckKind.AtLeastArrives, token: aave.address, to: zeroAddress, amount: AAVE.quoted },
      ],
      block.timestamp + DEADLINE_SECONDS,
    ],
  }
  const [reason, tradeGas] = await Promise.all([
    reasonOf(publicClient, { ...attempt, account: owner }),
    publicClient.estimateContractGas({ ...trade, account: owner }),
  ])
  const attemptHash = await wallet(owner).writeContract({ ...attempt, ...fees, gas: tradeGas * 2n + ATTEMPT_GAS_EXTRA, nonce })
  const tradeHash = await wallet(owner).writeContract({ ...trade, ...fees, gas: (tradeGas * BUFFER) / 10n, nonce: nonce + 1 })
  const [attemptReceipt, tradeReceipt] = await Promise.all(
    [attemptHash, tradeHash].map((hash) => publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })),
  )
  const [done] = parseEventLogs({ abi: routeAbi, eventName: 'RouteDone', logs: tradeReceipt.logs })
  const after = await holdings()
  const prices = { usdt: BigInt(scene.data.prices.usdt), aave: BigInt(scene.data.prices.aave), decimals: scene.data.prices.decimals }
  const usdtIn = done?.args.usdtIn ?? 0n
  const aaveOut = done?.args.aaveOut ?? 0n
  const fair = (usdtIn * 10n ** BigInt(aave.decimals - usdt.decimals) * prices.usdt) / prices.aave
  return {
    tokens: { usdt: usdt.address, weth: scene.tokens.weth.address, aave: aave.address },
    pools: { v3: scene.pool, v2: scene.pair },
    route: scene.route.address,
    source: scene.source.address,
    owner: owner.address,
    trade: { ...sent(tradeReceipt), usdtIn, wethOut: done?.args.wethOut ?? 0n, aaveOut },
    attempt: { ...sent(attemptReceipt), reason },
    wallet: { usdtBefore: before[0], usdtAfter: after[0], aaveBefore: before[1], aaveAfter: after[1] },
    vault: { address: vault, usdtBefore: before[2], usdtAfter: after[2], aaveBefore: before[3], aaveAfter: after[3] },
    real: scene.data.trade,
    prices,
    quoted: AAVE.quoted,
    fair,
    lessBps: fair > 0n ? ((fair - aaveOut) * 10_000n + fair / 2n) / fair : 0n,
    ms: Date.now() - started,
  }
}
