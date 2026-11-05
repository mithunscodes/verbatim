import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  parseEventLogs,
  parseUnits,
} from 'viem'
import { mainnet } from 'viem/chains'
import { ANVIL, REPLAY_PORT, REPLAY_START_TIMEOUT_MS } from './config.js'
import { RequestError } from './uniswap.js'

const LOCAL_RPC = `http://127.0.0.1:${REPLAY_PORT}`
const STATES = new URL('../../contracts/fork-states/', import.meta.url)
const ARTIFACTS = new URL('../../contracts/out/', import.meta.url)
const FORCED_GAS = 15_000_000n
const DEADLINE_SECONDS = 3600n
const ETH = '0x0000000000000000000000000000000000000000'
const POLL_MS = 100

export const BYBIT = {
  state: 'bybit',
  block: 21895237,
  date: '21 Feb 2025',
  safe: getAddress('0x1Db92e2EeBC8E0c075a02BeA49a2935BcD2dFCF4'),
  attacker: getAddress('0x0fa09C3A328792253f8dee7116848723b72a6d2e'),
  attackTx: '0x46deef0f52e3a983b67abf4714448a41dd7ffd6d32d32da69d62081c68ad7882',
  borrowedCode: getAddress('0x96221423681A6d52E184D440a8eFCEbB105C7242'),
  attackerCode: getAddress('0xbDd077f651EBe7f7b3cE16fe5F2b025BE2969516'),
  ethHeld: 401346768858404671846374n,
  sentence: 'Move ETH to our warm wallet. Nothing else.',
}

export const AAVE = {
  state: 'aave-vault',
  date: '12 Mar 2026',
  tradeTx: '0x9fa9feab3c1989a33424728c23e6de07a40a26a98ff7ff5139f3492ce430801f',
  owner: getAddress('0x98b9d979c33dd7284c854909bcc09b51fbf97ac8'),
  aEthUsdt: getAddress('0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a'),
  aave: getAddress('0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9'),
  amount: 50432688416180n,
  quoted: parseUnits('329', 18),
  feeds: {
    aaveUsd: getAddress('0x547a514d5e3769680Ce22B2361c10Ea13619e8a9'),
    usdtUsd: getAddress('0x3E7d1eAB13ad0104d2750B8863b489D65364e32D'),
  },
  maxPriceAge: 93_600n,
  sentence: 'Swap my 50.4 million USDT for AAVE, at least 329 AAVE.',
}

const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
])
const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
])
const CheckKind = { AtMostLeaves: 0, AtLeastArrives: 1 }

export const statePath = (name) => fileURLToPath(new URL(`${name}.json`, STATES))
export const metaPath = (name) => fileURLToPath(new URL(`${name}-meta.json`, STATES))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function artifact(file, name) {
  const json = JSON.parse(readFileSync(new URL(`${file}/${name}.json`, ARTIFACTS), 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode.object }
}

export function copyClients(url = LOCAL_RPC) {
  const transport = http(url, { timeout: 120_000 })
  return {
    public: createPublicClient({ chain: mainnet, transport, pollingInterval: POLL_MS }),
    wallet: createWalletClient({ chain: mainnet, transport, pollingInterval: POLL_MS }),
    test: createTestClient({ chain: mainnet, mode: 'anvil', transport }),
  }
}

export async function startCopy(args) {
  const child = spawn(ANVIL, ['--port', String(REPLAY_PORT), '--chain-id', '1', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  child.stderr.on('data', (chunk) => {
    errors += chunk
  })
  const c = copyClients()
  const stop = () =>
    child.exitCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => {
          child.once('exit', resolve)
          child.kill('SIGINT')
        })
  const started = Date.now()
  while (Date.now() - started < REPLAY_START_TIMEOUT_MS) {
    if (child.exitCode !== null) throw new Error(`The saved copy of Ethereum didn't start: ${errors.split('\n')[0]}`)
    try {
      await c.public.getChainId()
      return { c, stop }
    } catch {
      await sleep(200)
    }
  }
  await stop()
  throw new Error(`The saved copy of Ethereum didn't start. Is Foundry installed, and is port ${REPLAY_PORT} free?`)
}

async function reasonOf(c, request) {
  try {
    await c.public.simulateContract(request)
    return null
  } catch (error) {
    const reverted = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : null
    return reverted?.reason ?? reverted?.data?.errorName ?? error.shortMessage ?? 'refused'
  }
}

async function send(c, account, request) {
  const hash = await c.wallet.sendTransaction({ account, gas: FORCED_GAS, ...request })
  return c.public.waitForTransactionReceipt({ hash })
}

async function call(c, account, request) {
  const reason = await reasonOf(c, { account, ...request })
  const receipt = await send(c, account, { to: request.address, data: encodeFunctionData(request) })
  return { receipt, reason }
}

async function deploy(c, account, file, name, args) {
  const { abi, bytecode } = artifact(file, name)
  const hash = await c.wallet.deployContract({ account, abi, bytecode, args })
  const { contractAddress } = await c.public.waitForTransactionReceipt({ hash })
  return { address: getAddress(contractAddress), abi }
}

async function impersonate(c, address) {
  await c.test.impersonateAccount({ address })
  await c.test.setBalance({ address, value: 10n ** 19n })
}

async function deadlineOf(c) {
  const { timestamp } = await c.public.getBlock()
  return timestamp + DEADLINE_SECONDS
}

export async function vaultOnCopy(c, { tokens, trusted }) {
  const [deployer, everydayKey, rulesKey] = await c.wallet.getAddresses()
  const directory = await deploy(c, deployer, 'ReplayDirectory.sol', 'ReplayDirectory', [trusted])
  const vault = await deploy(c, deployer, 'VerbatimVault.sol', 'VerbatimVault', [everydayKey, rulesKey, tokens, directory.address])
  return { ...vault, everydayKey, rulesKey, directory: directory.address }
}

export async function bybitOnCopy(c) {
  const balance = (address) => c.public.getBalance({ address })
  const codeOf = async () => getAddress(`0x${(await c.public.getStorageAt({ address: BYBIT.safe, slot: '0x0' })).slice(-40)}`)
  const meta = JSON.parse(readFileSync(metaPath('bybit'), 'utf8'))
  const safeBefore = await balance(BYBIT.safe)
  const codeBefore = await codeOf()
  await impersonate(c, BYBIT.attacker)
  const takeover = await send(c, BYBIT.attacker, { to: BYBIT.safe, data: meta.attackInput })
  const codeAfter = await codeOf()
  const sweep = await send(c, BYBIT.attacker, { to: BYBIT.safe, data: meta.drainInput })
  const safeAfter = await balance(BYBIT.safe)

  const vault = await vaultOnCopy(c, { tokens: [], trusted: [] })
  await send(c, vault.rulesKey, { to: vault.address, data: encodeFunctionData({ abi: vault.abi, functionName: 'finishSetup' }) })
  await c.test.setBalance({ address: vault.address, value: BYBIT.ethHeld })
  const vaultBefore = await balance(vault.address)
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [BYBIT.attackerCode, 0n] })
  const attack = await call(c, vault.everydayKey, {
    address: vault.address,
    abi: vault.abi,
    functionName: 'run',
    args: [[{ target: BYBIT.borrowedCode, value: 0n, data, operation: 1 }], [], await deadlineOf(c)],
  })
  return {
    wallet: {
      before: safeBefore,
      after: safeAfter,
      codeBefore,
      codeAfter,
      takeover: takeover.status,
      sweep: sweep.status,
    },
    vault: {
      address: vault.address,
      before: vaultBefore,
      after: await balance(vault.address),
      status: attack.receipt.status,
      reason: attack.reason,
    },
  }
}

async function readFeed(c, address) {
  const [[, answer, , updatedAt], decimals] = await Promise.all([
    c.public.readContract({ address, abi: feedAbi, functionName: 'latestRoundData' }),
    c.public.readContract({ address, abi: feedAbi, functionName: 'decimals' }),
  ])
  return { answer, decimals, updatedAt }
}

export async function aaveSetupOnCopy(c) {
  const [deployer] = await c.wallet.getAddresses()
  const route = await deploy(c, deployer, 'AaveRoute.sol', 'AaveRoute', [])
  const source = await deploy(c, deployer, 'ChainlinkPriceSource.sol', 'ChainlinkPriceSource', [
    [AAVE.aEthUsdt, AAVE.aave],
    [AAVE.feeds.usdtUsd, AAVE.feeds.aaveUsd],
    [6, 18],
    AAVE.maxPriceAge,
  ])
  const vault = await vaultOnCopy(c, { tokens: [AAVE.aEthUsdt, AAVE.aave], trusted: [route.address] })
  const setup = (functionName, args = []) => send(c, vault.rulesKey, { to: vault.address, data: encodeFunctionData({ abi: vault.abi, functionName, args }) })
  await setup('setDailyLimit', [AAVE.aEthUsdt, AAVE.amount * 2n])
  await setup('setPriceSource', [source.address])
  await setup('finishSetup')
  return { route: route.address, source: source.address, vault: vault.address, everydayKey: vault.everydayKey, rulesKey: vault.rulesKey }
}

export async function aaveOnCopy(c, { afterPhase = async () => {} } = {}) {
  const meta = JSON.parse(readFileSync(metaPath(AAVE.state), 'utf8'))
  const { abi: routeAbi } = artifact('AaveRoute.sol', 'AaveRoute')
  const { abi: vaultAbi } = artifact('VerbatimVault.sol', 'VerbatimVault')
  const token = (address, functionName, args) => ({ to: address, data: encodeFunctionData({ abi: erc20Abi, functionName, args }) })
  const balanceOf = (address, owner) => c.public.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })

  const start = await c.test.snapshot()
  await impersonate(c, AAVE.owner)
  const approve = await send(c, AAVE.owner, token(AAVE.aEthUsdt, 'approve', [meta.route, AAVE.amount]))
  const trade = await send(c, AAVE.owner, { to: meta.route, data: encodeFunctionData({ abi: routeAbi, functionName: 'swap', args: [AAVE.amount] }) })
  const [done] = parseEventLogs({ abi: routeAbi, eventName: 'RouteDone', logs: trade.logs })
  const wallet = { status: trade.status, usdtIn: done?.args.usdtIn ?? 0n, wethOut: done?.args.wethOut ?? 0n, aaveOut: done?.args.aaveOut ?? 0n }
  await afterPhase([approve.transactionHash, trade.transactionHash])
  await c.test.revert({ id: start })

  const again = await c.test.snapshot()
  await impersonate(c, AAVE.owner)
  const funded = await send(c, AAVE.owner, token(AAVE.aEthUsdt, 'transfer', [meta.vault, AAVE.amount]))
  const held = await balanceOf(AAVE.aEthUsdt, meta.vault)
  const aaveBefore = await balanceOf(AAVE.aave, meta.vault)
  const actions = [
    { target: AAVE.aEthUsdt, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [meta.route, held] }), operation: 0 },
    { target: meta.route, value: 0n, data: encodeFunctionData({ abi: routeAbi, functionName: 'swap', args: [held] }), operation: 0 },
  ]
  const checks = [
    { kind: CheckKind.AtMostLeaves, token: AAVE.aEthUsdt, to: ETH, amount: held },
    { kind: CheckKind.AtLeastArrives, token: AAVE.aave, to: ETH, amount: AAVE.quoted },
  ]
  const attempt = await call(c, meta.everydayKey, { address: meta.vault, abi: vaultAbi, functionName: 'run', args: [actions, checks, await deadlineOf(c)] })
  const aaveFeed = await readFeed(c, AAVE.feeds.aaveUsd)
  const usdtFeed = await readFeed(c, AAVE.feeds.usdtUsd)
  const { timestamp } = await c.public.getBlock()
  const vault = {
    address: meta.vault,
    held,
    status: attempt.receipt.status,
    reason: attempt.reason,
    heldAfter: await balanceOf(AAVE.aEthUsdt, meta.vault),
    aaveAfter: (await balanceOf(AAVE.aave, meta.vault)) - aaveBefore,
  }
  await afterPhase([funded.transactionHash, attempt.receipt.transactionHash])
  await c.test.revert({ id: again })

  const fair = (wallet.usdtIn * 10n ** 12n * usdtFeed.answer * 10n ** BigInt(aaveFeed.decimals)) / (aaveFeed.answer * 10n ** BigInt(usdtFeed.decimals))
  const lessBps = fair > 0n ? ((fair - wallet.aaveOut) * 10_000n + fair / 2n) / fair : 0n
  return {
    wallet,
    vault,
    quoted: AAVE.quoted,
    prices: {
      aaveUsd: { answer: aaveFeed.answer, decimals: aaveFeed.decimals, minutesOld: (timestamp - aaveFeed.updatedAt) / 60n },
      usdtUsd: { answer: usdtFeed.answer, decimals: usdtFeed.decimals, minutesOld: (timestamp - usdtFeed.updatedAt) / 60n },
    },
    fair,
    lessBps,
  }
}

const REPLAYS = {
  bybit: { state: BYBIT.state, run: bybitOnCopy, facts: BYBIT },
  aave: { state: AAVE.state, run: aaveOnCopy, facts: AAVE },
}

let running = false

export async function replay(body) {
  const chosen = REPLAYS[body?.name]
  if (!chosen) throw new RequestError('Choose the bybit or aave replay.')
  if (!existsSync(statePath(chosen.state))) {
    throw new RequestError(`The saved copy for this replay is missing (contracts/fork-states/${chosen.state}.json). Make it with server/scripts/replays.js prepare.`, 503)
  }
  if (running) throw new RequestError('A replay is already running. Try again in a few seconds.', 409)
  running = true
  const started = Date.now()
  try {
    const { c, stop } = await startCopy(['--load-state', statePath(chosen.state)])
    try {
      const readyMs = Date.now() - started
      const result = await chosen.run(c)
      return { name: body.name, facts: chosen.facts, result, readyMs, totalMs: Date.now() - started, block: Number(await c.public.getBlockNumber()) }
    } finally {
      await stop()
    }
  } finally {
    running = false
  }
}
