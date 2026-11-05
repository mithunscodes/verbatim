import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import {
  createPublicClient,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  keccak256,
  maxUint160,
  maxUint256,
  parseAbi,
  parseEther,
  parseEventLogs,
  size,
  toHex,
  zeroAddress,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { EXPLORER, FACTORY, factoryAbi, vaultAbi } from '../../app/src/config.js'
import { AAVE, BYBIT, artifact, metaPath, startCopy, statePath } from '../src/replays.js'
import {
  AAVE_REASON,
  BYBIT_REASON,
  DEPLOYER,
  HELD,
  HOOK,
  HOOK_REASON,
  PRINT,
  PRINT_REASON,
  REPLAY_CONTRACTS,
  REPLAY_KEYS,
  SAFE,
  aaveReady,
  aaveScene,
  abiOf,
  bybitScene,
  codeOf,
  copies,
  hookReady,
  hookScene,
  permit2Abi,
  prepareBybit,
  preparePrint,
  printScene,
  quoteHook,
  replayAccounts,
  resetAave,
  resetHook,
  runAave,
  runBybit,
  runHook,
  runPrint,
  safeAbi,
  sendSteps,
  topUpFees,
  UNISWAP,
  vaultFactory,
} from '../src/sepolia-replays.js'
import { connect, isMain, live, option, redact, startLocalCopy } from './ens.js'

const ENV_FILE = new URL('../../.env', import.meta.url)
const CODE_FILE = new URL('../src/bybit-code.json', import.meta.url)
const POOLS_FILE = new URL('../src/aave-pools.json', import.meta.url)
const CONTRACTS_FILE = new URL('../src/replay-contracts.json', import.meta.url)
const HOOK_FILE = new URL('../src/hook-pool.json', import.meta.url)
const REPLAYS = ['bybit', 'aave', 'hook', 'print']
const TARGET_MS = 60_000
const REHEARSAL_RUNS = 2
const REHEARSAL_ETH = parseEther('10')
const BATCH = 12
const REAL_POOL = '0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36'
const REAL_PAIR = '0xD75EA151a61d06868E31F8988D28DFE5E9df57B4'
const PRICE_DECIMALS = 8
const STATE_VIEW = '0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C'
const MAX_UINT48 = 2 ** 48 - 1

const realPoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function liquidity() view returns (uint128)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function tickBitmap(int16 word) view returns (uint256)',
  'function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256, uint256, int56, uint160, uint32, bool)',
  'function positions(bytes32 key) view returns (uint128 liquidity, uint256, uint256, uint128, uint128)',
])
const pairAbi = parseAbi(['function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)'])
const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
])
const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80)',
  'function decimals() view returns (uint8)',
])

const where = () => (live ? 'Sepolia' : 'the local copy of Sepolia')
const link = (hash) => (live ? `${EXPLORER}/tx/${hash}` : `${hash.slice(0, 10)}… on the local copy`)
const place = (address) => (live ? `${EXPLORER}/address/${address}` : address)
const eth = (wei) => `${formatEther(wei)} test ETH`
const units = (value, decimals, digits = 4) => Number(formatUnits(value, decimals)).toLocaleString('en-US', { maximumFractionDigits: digits })
const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`
const seconds = (ms) => (ms / 1000).toFixed(1)
const log = (label, receipt) => console.log(`  ✓ ${label} (${link(receipt.transactionHash)})`)
const within = (ours, real) => (ours > real ? ours - real : real - ours) * 1000n <= real

function reporter() {
  let failures = 0
  const report = (ok, text) => {
    if (!ok) failures++
    console.log(`${ok ? '✓' : '✗'} ${text}`)
  }
  const finish = () => {
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
    if (failures > 0) process.exitCode = 1
  }
  return { report, finish }
}

function makeKeys() {
  for (const [name, role] of Object.entries(REPLAY_KEYS)) {
    const env = readFileSync(ENV_FILE, 'utf8')
    if (process.env[name] || new RegExp(`^${name}=`, 'm').test(env)) {
      console.log(`${name} is already in .env, kept as it is`)
      continue
    }
    const key = generatePrivateKey()
    appendFileSync(ENV_FILE, `${env.endsWith('\n') ? '' : '\n'}${name}=${key}\n`)
    console.log(`${name} added to .env. ${role}. Address: ${privateKeyToAccount(key).address}`)
  }
}

function mainnet() {
  if (!process.env.MAINNET_RPC_URL) throw new Error('MAINNET_RPC_URL is missing from .env. Run this from server/ with --env-file=../.env')
  return createPublicClient({ transport: http(process.env.MAINNET_RPC_URL) })
}

async function saveCode() {
  const client = mainnet()
  const [trojan, backdoor] = await Promise.all([BYBIT.borrowedCode, BYBIT.attackerCode].map((address) => client.getCode({ address })))
  writeFileSync(CODE_FILE, `${JSON.stringify({ trojan, backdoor }, null, 2)}\n`)
  console.log(`Saved Bybit's trojan (${size(trojan)} bytes, ${BYBIT.borrowedCode}) and backdoor (${size(backdoor)} bytes, ${BYBIT.attackerCode}) from mainnet`)
}

function saveContracts() {
  const contracts = Object.fromEntries(REPLAY_CONTRACTS.map((name) => {
    const { abi, bytecode } = artifact(`${name}.sol`, name)
    return [name, { abi, bytecode }]
  }))
  const data = {
    from: 'contracts/out, frozen so the server needs no build folder. Every replay address follows from this bytecode and the keys, so refresh it only before a fresh setup',
    vaultFactory: FACTORY,
    contracts,
  }
  writeFileSync(CONTRACTS_FILE, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`Saved ${REPLAY_CONTRACTS.length} contracts (${REPLAY_CONTRACTS.join(', ')}) and the vault factory ${FACTORY} for the replays`)
}

async function savePools() {
  const meta = JSON.parse(readFileSync(metaPath(AAVE.state), 'utf8'))
  const { c, stop } = await startCopy(['--load-state', statePath(AAVE.state)])
  try {
    const read = (address, abi, functionName, args = []) => c.public.readContract({ address, abi, functionName, args })
    const [[sqrtPriceX96, tick], liquidity, fee, spacing, [aaveReserve, wethReserve], aaveFeed, usdtFeed, aaveDecimals, usdtDecimals] = await Promise.all([
      read(REAL_POOL, realPoolAbi, 'slot0'),
      read(REAL_POOL, realPoolAbi, 'liquidity'),
      read(REAL_POOL, realPoolAbi, 'fee'),
      read(REAL_POOL, realPoolAbi, 'tickSpacing'),
      read(REAL_PAIR, pairAbi, 'getReserves'),
      read(AAVE.feeds.aaveUsd, feedAbi, 'latestRoundData'),
      read(AAVE.feeds.usdtUsd, feedAbi, 'latestRoundData'),
      read(AAVE.feeds.aaveUsd, feedAbi, 'decimals'),
      read(AAVE.feeds.usdtUsd, feedAbi, 'decimals'),
    ])
    if (aaveDecimals !== PRICE_DECIMALS || usdtDecimals !== PRICE_DECIMALS) throw new Error('Chainlink feeds with unexpected decimals')
    const routeAbi = artifact('AaveRoute.sol', 'AaveRoute').abi
    await c.test.impersonateAccount({ address: AAVE.owner })
    await c.test.setBalance({ address: AAVE.owner, value: parseEther('10') })
    const approve = await c.wallet.writeContract({ account: AAVE.owner, address: AAVE.aEthUsdt, abi: erc20Abi, functionName: 'approve', args: [meta.route, AAVE.amount] })
    await c.public.waitForTransactionReceipt({ hash: approve })
    const hash = await c.wallet.writeContract({ account: AAVE.owner, address: meta.route, abi: routeAbi, functionName: 'swap', args: [AAVE.amount], gas: 15_000_000n })
    const receipt = await c.public.waitForTransactionReceipt({ hash })
    const [done] = parseEventLogs({ abi: routeAbi, eventName: 'RouteDone', logs: receipt.logs })
    const [, endTick] = await read(REAL_POOL, realPoolAbi, 'slot0')
    const from = Math.floor(tick / spacing)
    const to = Math.floor(endTick / spacing)
    const crossed = []
    for (let word = from >> 8; word <= to >> 8; word++) {
      const bitmap = await read(REAL_POOL, realPoolAbi, 'tickBitmap', [word])
      for (let bit = 0; bit < 256; bit++) {
        const compressed = word * 256 + bit
        if ((bitmap >> BigInt(bit)) & 1n && compressed > from && compressed <= to) crossed.push(compressed * spacing)
      }
    }
    const bounds = [from * spacing, ...crossed, (to + 1) * spacing]
    const segments = []
    let active = liquidity
    for (let i = 0; i < bounds.length - 1; i++) {
      if (i > 0) active += (await read(REAL_POOL, realPoolAbi, 'ticks', [bounds[i]]))[1]
      if (active > 0n) segments.push([bounds[i], bounds[i + 1], String(active)])
    }
    const data = {
      from: `Ethereum mainnet, the moment before the $50.4M trade ${AAVE.tradeTx}, read from the saved copy contracts/fork-states/${AAVE.state}.json`,
      v3: { pool: REAL_POOL, fee, tickSpacing: spacing, sqrtPriceX96: String(sqrtPriceX96), tick, endTick, segments },
      v2: { pair: REAL_PAIR, aave: String(aaveReserve), weth: String(wethReserve) },
      prices: { decimals: PRICE_DECIMALS, usdt: String(usdtFeed[1]), aave: String(aaveFeed[1]), usdtFeed: AAVE.feeds.usdtUsd, aaveFeed: AAVE.feeds.aaveUsd },
      trade: { usdtIn: String(done.args.usdtIn), wethOut: String(done.args.wethOut), aaveOut: String(done.args.aaveOut) },
    }
    writeFileSync(POOLS_FILE, `${JSON.stringify(data, null, 2)}\n`)
    console.log(`Saved the pools at the moment of the trade: ${segments.length} liquidity ranges (${crossed.length} ticks crossed), the SushiSwap pool's ${units(aaveReserve, 18)} AAVE and ${units(wethReserve, 18)} WETH, and Chainlink's prices`)
  } finally {
    await stop()
  }
}

async function saveHookPrice() {
  const client = mainnet()
  const read = (address, functionName) => client.readContract({ address, abi: feedAbi, functionName })
  const [[, ethUsd, , updatedAt], [, usdcUsd], ethDecimals, usdcDecimals] = await Promise.all([
    read(HOOK.feeds.ethUsd, 'latestRoundData'),
    read(HOOK.feeds.usdcUsd, 'latestRoundData'),
    read(HOOK.feeds.ethUsd, 'decimals'),
    read(HOOK.feeds.usdcUsd, 'decimals'),
  ])
  if (ethDecimals !== PRICE_DECIMALS || usdcDecimals !== PRICE_DECIMALS) throw new Error('Chainlink feeds with unexpected decimals')
  const data = {
    from: "Chainlink's ETH/USD and USDC/USD on Ethereum mainnet. The hook replay's pool starts at this price, and its price source uses it, so refresh it only before a fresh setup",
    decimals: PRICE_DECIMALS,
    ethUsd: String(ethUsd),
    usdcUsd: String(usdcUsd),
    readAt: new Date(Number(updatedAt) * 1000).toISOString(),
    feeds: HOOK.feeds,
  }
  writeFileSync(HOOK_FILE, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`Saved Chainlink's prices for the hook replay: ETH $${units(ethUsd, PRICE_DECIMALS, 2)}, USDC $${units(usdcUsd, PRICE_DECIMALS, 5)}`)
}

async function deployMissing(ctx, contracts) {
  const steps = []
  for (const [label, contract] of contracts) {
    if (await ctx.publicClient.getCode({ address: contract.address })) continue
    steps.push({ label: `Deploy ${label} at ${contract.address}`, request: { to: DEPLOYER, data: contract.deploy } })
  }
  await sendSteps(ctx, ctx.builder, steps, log)
}

const call = (to, abi, functionName, args = []) => ({ to, data: encodeFunctionData({ abi, functionName, args }) })

const vaultOf = (ctx, accounts) =>
  ctx.publicClient.readContract({ address: vaultFactory(), abi: factoryAbi, functionName: 'vaultOf', args: [accounts.everyday.address] })

async function setupBybit(ctx, accounts) {
  console.log(`Setting up the Bybit replay on ${where()}`)
  await topUpFees(ctx, accounts, log)
  await deployMissing(ctx, Object.entries(copies(accounts.thief.address)).map(([name, copy]) => [`a copy of Bybit's ${name}`, copy]))
  if ((await vaultOf(ctx, accounts)) === zeroAddress) {
    await sendSteps(ctx, accounts.everyday, [{
      label: 'The replay everyday key creates its vault through the factory, guarded by the replay Rules key',
      request: call(vaultFactory(), factoryAbi, 'createVault', [accounts.rules.address]),
    }], log)
  }
  const vault = await vaultOf(ctx, accounts)
  console.log(`  Vault: ${vault}`)
  if (!(await ctx.publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'setupFinished' }))) {
    await sendSteps(ctx, accounts.rules, [{ label: 'Finish setup', request: call(vault, vaultAbi, 'finishSetup') }], log)
  }
  const held = await ctx.publicClient.getBalance({ address: vault })
  if (held < HELD) await sendSteps(ctx, ctx.builder, [{ label: `Put ${eth(HELD - held)} in the vault`, request: { to: vault, value: HELD - held } }], log)
  await prepareBybit(ctx, accounts, log)
}

async function addSegments(ctx, scene) {
  const segments = scene.data.v3.segments
  const key = ([lower, upper]) => keccak256(encodePacked(['address', 'int24', 'int24'], [scene.helper.address, lower, upper]))
  const held = await ctx.publicClient.multicall({
    allowFailure: false,
    contracts: segments.map((segment) => ({ address: scene.pool, abi: realPoolAbi, functionName: 'positions', args: [key(segment)] })),
  })
  const missing = segments.map((segment, i) => ({ segment, number: i + 1 })).filter((_, i) => held[i][0] === 0n)
  const steps = []
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH)
    const [lowers, uppers, amounts] = [0, 1, 2].map((part) => batch.map(({ segment }) => (part === 2 ? BigInt(segment[2]) : segment[part])))
    steps.push({
      label: `Copy mainnet's liquidity, ranges ${batch[0].number} to ${batch.at(-1).number} of ${segments.length}`,
      request: call(scene.helper.address, abiOf('ReplayPools'), 'addLiquidity', [lowers, uppers, amounts]),
    })
  }
  await sendSteps(ctx, ctx.builder, steps, log)
}

async function setupAave(ctx, accounts) {
  console.log(`\nSetting up the Aave replay on ${where()}`)
  await topUpFees(ctx, accounts, log)
  let scene = await aaveScene(ctx.publicClient, ctx.builder.address, accounts)
  const { data, tokens } = scene
  await deployMissing(ctx, [['the pool helper', scene.helper], ...['aave', 'weth', 'usdt'].map((name) => [tokens[name].symbol, tokens[name]])])
  if (scene.pool === zeroAddress) {
    await sendSteps(ctx, ctx.builder, [{
      label: "Make the Uniswap v3 tWETH/tUSDT pool at mainnet's price, and the Uniswap v2 tAAVE/tWETH pool",
      request: call(scene.helper.address, abiOf('ReplayPools'), 'init', [
        tokens.usdt.address,
        tokens.weth.address,
        tokens.aave.address,
        data.v3.fee,
        BigInt(data.v3.sqrtPriceX96),
        BigInt(data.v2.aave),
        BigInt(data.v2.weth),
        BigInt(data.trade.usdtIn),
      ]),
    }], log)
    scene = await aaveScene(ctx.publicClient, ctx.builder.address, accounts)
  }
  await addSegments(ctx, scene)
  await deployMissing(ctx, [
    ['the route', scene.route],
    ["the fixed price source (Chainlink's prices that day)", scene.source],
    ['the trusted list (only the route)', scene.directory],
    ['the Aave replay vault', scene.vault],
  ])
  const vault = scene.vault.address
  if (!(await ctx.publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'setupFinished' }))) {
    const limit = BigInt(data.trade.usdtIn) * 2n
    await sendSteps(ctx, accounts.rules, [
      { label: `Daily limit: ${units(limit, 6)} tUSDT (twice the trade)`, request: call(vault, vaultAbi, 'setDailyLimit', [tokens.usdt.address, limit]) },
      { label: "Price source: Chainlink's prices that day", request: call(vault, vaultAbi, 'setPriceSource', [scene.source.address]) },
      { label: 'Finish setup', request: call(vault, vaultAbi, 'finishSetup') },
    ], log)
  }
  await resetAave(ctx, accounts, log)
  const allowance = await ctx.publicClient.readContract({ address: tokens.usdt.address, abi: erc20Abi, functionName: 'allowance', args: [accounts.everyday.address, scene.route.address] })
  if (allowance < BigInt(data.trade.usdtIn)) {
    await sendSteps(ctx, accounts.everyday, [{
      label: 'The normal wallet lets the route take its tUSDT, once',
      request: call(tokens.usdt.address, erc20Abi, 'approve', [scene.route.address, maxUint256]),
    }], log)
  }
}

async function setupHook(ctx, accounts) {
  console.log(`\nSetting up the Uniswap v4 hook replay on ${where()}`)
  await topUpFees(ctx, accounts, log)
  const scene = hookScene(ctx.builder.address, accounts)
  const { tokens, data } = scene
  await deployMissing(ctx, [
    ['the pool helper', scene.helper],
    ['tUSDC', tokens.usdc],
    ['tWETH', tokens.weth],
    [`the bad hook (it takes ${Number(HOOK.cutBps) / 100}% of every swap, except when Uniswap's quoter asks)`, scene.hook],
  ])
  const made = await ctx.publicClient.readContract({ address: scene.helper.address, abi: abiOf('HookPools'), functionName: 'hook' })
  if (made === zeroAddress) {
    await sendSteps(ctx, ctx.builder, [{
      label: `Make the Uniswap v4 tUSDC/tWETH pool with the bad hook, at Chainlink's price ($${units(BigInt(data.ethUsd), data.decimals, 2)}), with about ${units(HOOK.poolWeth, 18)} tWETH in it`,
      request: call(scene.helper.address, abiOf('HookPools'), 'init', [tokens.usdc.address, tokens.weth.address, scene.hook.address, scene.startPrice, scene.liquidity, HOOK.amount]),
    }], log)
  }
  await deployMissing(ctx, [
    ["the fixed price source (Chainlink's prices)", scene.source],
    ["the trusted list (only Uniswap's Universal Router)", scene.directory],
    ['the hook replay vault', scene.vault],
  ])
  const vault = scene.vault.address
  if (!(await ctx.publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'setupFinished' }))) {
    const limit = HOOK.amount * 2n
    await sendSteps(ctx, accounts.rules, [
      { label: `Daily limit: ${units(limit, 6)} tUSDC (twice the swap)`, request: call(vault, vaultAbi, 'setDailyLimit', [tokens.usdc.address, limit]) },
      { label: "Price source: Chainlink's prices", request: call(vault, vaultAbi, 'setPriceSource', [scene.source.address]) },
      { label: 'Finish setup', request: call(vault, vaultAbi, 'finishSetup') },
    ], log)
  }
  await resetHook(ctx, accounts, log)
  const owner = accounts.everyday.address
  const [allowance, [permitted]] = await Promise.all([
    ctx.publicClient.readContract({ address: tokens.usdc.address, abi: erc20Abi, functionName: 'allowance', args: [owner, UNISWAP.permit2] }),
    ctx.publicClient.readContract({ address: UNISWAP.permit2, abi: permit2Abi, functionName: 'allowance', args: [owner, tokens.usdc.address, UNISWAP.universalRouter] }),
  ])
  const steps = []
  if (allowance < HOOK.amount) {
    steps.push({ label: "The normal wallet lets Uniswap's Permit2 move its tUSDC, once", request: call(tokens.usdc.address, erc20Abi, 'approve', [UNISWAP.permit2, maxUint256]) })
  }
  if (permitted < HOOK.amount) {
    steps.push({
      label: "The normal wallet lets Uniswap's Universal Router use that, once",
      request: call(UNISWAP.permit2, permit2Abi, 'approve', [tokens.usdc.address, UNISWAP.universalRouter, maxUint160, MAX_UINT48]),
    })
  }
  await sendSteps(ctx, accounts.everyday, steps, log)
}

async function setupPrint(ctx, accounts) {
  console.log(`\nSetting up the AI print mint on ${where()}`)
  await topUpFees(ctx, accounts, log)
  const scene = printScene(ctx.builder.address, accounts)
  await deployMissing(ctx, [
    [`the Verbatim Prints NFT contract (${eth(PRINT.price)} a print, paid to the Builder key)`, scene.prints],
    ["the fixed price source (Chainlink's ETH price)", scene.source],
    ['the trusted list (only the Verbatim Prints contract)', scene.directory],
    ['the print vault', scene.vault],
  ])
  const vault = scene.vault.address
  if (!(await ctx.publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'setupFinished' }))) {
    await sendSteps(ctx, accounts.rules, [
      { label: `Daily limit: ${eth(PRINT.dailyLimit)}`, request: call(vault, vaultAbi, 'setDailyLimit', [zeroAddress, PRINT.dailyLimit]) },
      { label: "Price source: Chainlink's ETH price", request: call(vault, vaultAbi, 'setPriceSource', [scene.source.address]) },
      { label: 'Fair-price rule off (100%): a picture has no market price, so your words do the work', request: call(vault, abiOf('VerbatimVault'), 'setTradeTolerance', [PRINT.noFairPrice]) },
      { label: 'Finish setup', request: call(vault, vaultAbi, 'finishSetup') },
    ], log)
  }
  await preparePrint(ctx, accounts, log)
}

async function checkCopies(ctx, accounts, report) {
  const client = mainnet()
  const made = copies(accounts.thief.address)
  const [realTrojan, realBackdoor, ourTrojan, ourBackdoor] = await Promise.all([
    client.getCode({ address: BYBIT.borrowedCode }),
    client.getCode({ address: BYBIT.attackerCode }),
    ctx.publicClient.getCode({ address: made.trojan.address }),
    ctx.publicClient.getCode({ address: made.backdoor.address }),
  ])
  report(
    Boolean(ourTrojan) && ourTrojan.toLowerCase() === realTrojan.toLowerCase(),
    `The trojan copy ${made.trojan.address} matches Bybit's on mainnet (${BYBIT.borrowedCode}) byte for byte, ${size(realTrojan)} bytes`,
  )
  const attacker = BYBIT.attacker.slice(2).toLowerCase()
  const parts = realBackdoor.toLowerCase().split(attacker)
  const expected = parts.join(accounts.thief.address.slice(2).toLowerCase())
  report(
    parts.length - 1 === 3 && Boolean(ourBackdoor) && ourBackdoor.toLowerCase() === expected,
    `The backdoor copy ${made.backdoor.address} matches Bybit's on mainnet (${BYBIT.attackerCode}) except the attacker's address, swapped for our thief's in its ${parts.length - 1} places`,
  )
}

async function checkPools(ctx, accounts, report) {
  const scene = await aaveScene(ctx.publicClient, ctx.builder.address, accounts)
  const { data } = scene
  const segments = data.v3.segments
  const [[sqrtPriceX96], [aaveReserve, wethReserve], ...positions] = await ctx.publicClient.multicall({
    allowFailure: false,
    contracts: [
      { address: scene.pool, abi: realPoolAbi, functionName: 'slot0' },
      { address: scene.pair, abi: pairAbi, functionName: 'getReserves' },
      ...segments.map(([lower, upper]) => ({
        address: scene.pool,
        abi: realPoolAbi,
        functionName: 'positions',
        args: [keccak256(encodePacked(['address', 'int24', 'int24'], [scene.helper.address, lower, upper]))],
      })),
    ],
  })
  report(
    String(sqrtPriceX96) === data.v3.sqrtPriceX96 && positions.every(([liquidity], i) => String(liquidity) === segments[i][2]),
    `The Uniswap v3 pool ${scene.pool} starts at mainnet's price, with all ${segments.length} liquidity ranges the trade moved through, copied from ${short(data.v3.pool)}`,
  )
  report(
    String(aaveReserve) === data.v2.aave && String(wethReserve) === data.v2.weth,
    `The Uniswap v2 pool ${scene.pair} holds what SushiSwap's ${short(data.v2.pair)} held: ${units(aaveReserve, 18)} tAAVE and ${units(wethReserve, 18)} tWETH`,
  )
}

async function checkHook(ctx, accounts, report) {
  const scene = hookScene(ctx.builder.address, accounts)
  const [[sqrtPriceX96], helperPrice, quoted] = await Promise.all([
    ctx.publicClient.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [scene.poolId] }),
    ctx.publicClient.readContract({ address: scene.helper.address, abi: abiOf('HookPools'), functionName: 'price' }),
    quoteHook(ctx.publicClient, scene, accounts.everyday),
  ])
  const fair = (HOOK.amount * BigInt(scene.data.usdcUsd) * 10n ** 12n) / BigInt(scene.data.ethUsd)
  report(
    (BigInt(scene.hook.address) & 0x3fffn) === 0x44n,
    `The hook ${scene.hook.address} has the address Uniswap v4 needs for "after swap" and "takes from the swap"`,
  )
  report(
    sqrtPriceX96 === scene.startPrice && helperPrice === scene.startPrice,
    `The Uniswap v4 pool ${scene.poolId.slice(0, 10)}… starts at Chainlink's price, $${units(BigInt(scene.data.ethUsd), scene.data.decimals, 2)} per tWETH (read through Uniswap's StateView)`,
  )
  report(
    quoted < fair && (fair - quoted) * 100n < fair,
    `Uniswap's quoter: ${units(HOOK.amount, 6)} tUSDC → ${units(quoted, 18)} tWETH, within 1% of the fair ${units(fair, 18)} (the pool's fee and price impact). The hook doesn't cut quotes`,
  )
}

async function checkPrint(ctx, accounts, report) {
  const scene = printScene(ctx.builder.address, accounts)
  const read = (address, abi, functionName, args = []) => ctx.publicClient.readContract({ address, abi, functionName, args })
  const [price, finished, tolerance, held] = await Promise.all([
    read(scene.prints.address, abiOf('VerbatimPrints'), 'price'),
    read(scene.vault.address, vaultAbi, 'setupFinished'),
    read(scene.vault.address, abiOf('VerbatimVault'), 'tradeTolerance'),
    ctx.publicClient.getBalance({ address: scene.vault.address }),
  ])
  report(price === PRINT.price, `Verbatim Prints ${scene.prints.address}: ${eth(price)} a print`)
  report(finished && tolerance === PRINT.noFairPrice && held >= PRINT.vaultHolds / 2n, `The print vault ${scene.vault.address} is set up, trusts only Verbatim Prints, and holds ${eth(held)}`)
}

async function runBybitOnce(ctx, accounts, number, report) {
  const scene = await bybitScene(ctx.publicClient, accounts)
  const read = (functionName) => ctx.publicClient.readContract({ address: scene.safe, abi: safeAbi, functionName })
  const [version, owners, threshold] = await Promise.all([read('VERSION'), read('getOwners'), read('getThreshold')])
  console.log(`\nBybit run ${number} on ${where()}: Safe #${scene.run}, ${place(scene.safe)}`)
  report(
    version === SAFE.version && owners.length === SAFE.owners && threshold === BigInt(SAFE.threshold),
    `Like Bybit's: Safe version ${version}, ${threshold} of ${owners.length} signers needed`,
  )
  const result = await runBybit(ctx, accounts)
  report(
    result.takeover.status === 'success' && result.codeBefore === SAFE.masterCopy && result.codeAfter === result.backdoor,
    `${result.signers.length} signers approved Bybit's instruction, and the Safe's code was swapped (${short(result.codeBefore)} → ${short(result.codeAfter)}): ${link(result.takeover.hash)}`,
  )
  report(
    result.sweep.status === 'success' && result.safe.before === HELD && result.safe.after === 0n,
    `Then the thief swept it: ${eth(result.safe.before)} → ${eth(result.safe.after)}: ${link(result.sweep.hash)}`,
  )
  report(
    result.attempt.status === 'reverted' && result.vault.reason === BYBIT_REASON && result.vault.after === result.vault.before && result.vault.before >= HELD,
    `A Verbatim vault, same instruction: refused, "${result.vault.reason}". Still ${eth(result.vault.after)}: ${link(result.attempt.hash)}`,
  )
  report(result.ms < TARGET_MS, `Took ${seconds(result.ms)} s, from the first read to the last result`)
  await prepareBybit(ctx, accounts, log)
}

async function runAaveOnce(ctx, accounts, number, report) {
  console.log(`\nAave run ${number} on ${where()}`)
  const result = await runAave(ctx, accounts)
  const real = { wethOut: BigInt(result.real.wethOut), aaveOut: BigInt(result.real.aaveOut) }
  const exact = result.trade.wethOut === real.wethOut && result.trade.aaveOut === real.aaveOut
  report(
    result.trade.status === 'success' && within(result.trade.wethOut, real.wethOut) && within(result.trade.aaveOut, real.aaveOut),
    `A normal wallet: ${units(result.trade.usdtIn, 6, 2)} tUSDT → ${units(result.trade.wethOut, 18)} tWETH → ${units(result.trade.aaveOut, 18)} tAAVE. The real trade: ${units(real.wethOut, 18)} WETH → ${units(real.aaveOut, 18)} AAVE, ${exact ? 'the same to the last digit' : 'within 0.1%'}: ${link(result.trade.hash)}`,
  )
  report(
    result.attempt.status === 'reverted' && result.attempt.reason === AAVE_REASON && result.vault.usdtAfter === result.vault.usdtBefore && result.vault.aaveAfter === result.vault.aaveBefore,
    `A Verbatim vault, same trade, with the user's own check "at least ${units(result.quoted, 18, 0)} AAVE": refused, "${result.attempt.reason}". Still ${units(result.vault.usdtAfter, 6, 2)} tUSDT: ${link(result.attempt.hash)}`,
  )
  report(
    result.lessBps >= 9990n,
    `Chainlink that day (AAVE $${units(result.prices.aave, result.prices.decimals, 3)}, USDT $${units(result.prices.usdt, result.prices.decimals, 5)}): fair is ${units(result.fair, 18, 0)} tAAVE. "You'd get ${formatUnits(result.lessBps, 2)}% less than a fair price"`,
  )
  report(result.ms < TARGET_MS, `Took ${seconds(result.ms)} s, from the first read to the last result`)
  const scene = await resetAave(ctx, accounts, log)
  report(await aaveReady(ctx.publicClient, scene), 'Both pools and the tUSDT are back exactly, ready for the next run')
}

async function runHookOnce(ctx, accounts, number, report) {
  console.log(`\nHook run ${number} on ${where()}`)
  const result = await runHook(ctx, accounts)
  report(
    result.trade.status === 'success' && result.lessBps >= 1990n && result.lessBps <= 2010n,
    `A normal wallet: Uniswap's quoter said ${units(result.quoted, 18)} tWETH for ${units(result.amount, 6)} tUSDC. The swap paid ${units(result.got, 18)}, ${formatUnits(result.lessBps, 2)}% less, and the hook sent ${units(result.cut, 18)} tWETH to its owner: ${link(result.trade.hash)}`,
  )
  report(
    result.attempt.status === 'reverted' && result.attempt.reason === HOOK_REASON && result.vault.usdcAfter === result.vault.usdcBefore,
    `A Verbatim vault, same swap, with the user's words "at least ${units(result.atLeast, 18)} tWETH": refused, "${result.attempt.reason}" (only ${units(result.attempt.actual ?? 0n, 18)} would arrive). Still ${units(result.vault.usdcAfter, 6, 2)} tUSDC: ${link(result.attempt.hash)}`,
  )
  report(result.withoutWords === AAVE_REASON, `Without the user's words, the vault's fair-price rule refuses it too: "${result.withoutWords}"`)
  report(result.ms < TARGET_MS, `Took ${seconds(result.ms)} s, from the first read to the last result`)
  const scene = await resetHook(ctx, accounts, log)
  report(await hookReady(ctx.publicClient, scene), 'The v4 pool and the tUSDC are back exactly, ready for the next run')
}

async function runPrintOnce(ctx, accounts, number, report) {
  const root = option('root') ?? keccak256(toHex('Verbatim print rehearsal'))
  console.log(`\nPrint run ${number} on ${where()}, image root ${root.slice(0, 10)}…`)
  const honest = await runPrint(ctx, accounts, { root, hacked: false })
  report(
    honest.attempt.status === 'success' && honest.paid === PRINT.price && honest.printsHeld.after === honest.printsHeld.before + 1n,
    `The user's words "at most ${eth(PRINT.price)}, and 1 print arrives": minted Verbatim Print #${honest.tokenId} into the vault for ${eth(honest.paid)}: ${link(honest.attempt.hash)}`,
  )
  await preparePrint(ctx, accounts, log)
  const hacked = await runPrint(ctx, accounts, { root, hacked: true })
  report(
    hacked.attempt.status === 'reverted' && hacked.attempt.reason === PRINT_REASON && hacked.paid === 0n,
    `A hacked mint site asks ${eth(hacked.asked)} and sends the print to the thief: refused, "${hacked.attempt.reason}". Nothing paid: ${link(hacked.attempt.hash)}`,
  )
  report(honest.ms + hacked.ms < TARGET_MS, `Took ${seconds(honest.ms)} s and ${seconds(hacked.ms)} s`)
  await preparePrint(ctx, accounts, log)
}

async function statusBybit(ctx, accounts) {
  const scene = await bybitScene(ctx.publicClient, accounts)
  const balance = (address) => ctx.publicClient.getBalance({ address })
  const code = await codeOf(ctx.publicClient, scene.safe)
  const ready = code === SAFE.masterCopy && (await balance(scene.safe)) >= HELD
  console.log(`\nBybit replay on ${where()}`)
  console.log(`  Next Safe: #${scene.run}, ${place(scene.safe)}, ${ready ? 'ready' : 'not ready (run setup)'}`)
  console.log(`  Vault: ${scene.vault === zeroAddress ? 'not made yet' : `${place(scene.vault)}, ${eth(await balance(scene.vault))}`}`)
  console.log(`  Trojan copy: ${place(scene.trojan)}. Backdoor copy: ${place(scene.backdoor)}`)
  for (const role of ['everyday', 'rules', 'thief']) console.log(`  Replay ${role} key: ${accounts[role].address}, ${eth(await balance(accounts[role].address))}`)
  console.log(`  Builder key: ${eth(await balance(ctx.builder.address))}`)
}

async function statusAave(ctx, accounts) {
  const scene = await aaveScene(ctx.publicClient, ctx.builder.address, accounts)
  const made = scene.pool !== zeroAddress
  console.log(`\nAave replay on ${where()}`)
  console.log(`  Pool helper: ${place(scene.helper.address)}`)
  console.log(`  Tokens: ${['usdt', 'weth', 'aave'].map((name) => `${scene.tokens[name].symbol} ${place(scene.tokens[name].address)}`).join(', ')}`)
  console.log(`  Uniswap v3 tWETH/tUSDT pool: ${made ? place(scene.pool) : 'not made yet'}. Uniswap v2 tAAVE/tWETH pool: ${made ? place(scene.pair) : 'not made yet'}`)
  console.log(`  Route: ${place(scene.route.address)}. Fixed price source: ${place(scene.source.address)}`)
  console.log(`  Vault: ${place(scene.vault.address)}. Normal wallet: ${accounts.everyday.address}`)
  console.log(`  Ready for a run: ${(await aaveReady(ctx.publicClient, scene)) ? 'yes' : 'no (run setup)'}`)
}

async function statusHook(ctx, accounts) {
  const scene = hookScene(ctx.builder.address, accounts)
  console.log(`\nUniswap v4 hook replay on ${where()}`)
  console.log(`  Pool helper: ${place(scene.helper.address)}. Bad hook: ${place(scene.hook.address)}`)
  console.log(`  Tokens: ${['usdc', 'weth'].map((name) => `${scene.tokens[name].symbol} ${place(scene.tokens[name].address)}`).join(', ')}`)
  console.log(`  Pool: ${scene.poolId}, in Uniswap's PoolManager ${place(UNISWAP.v4PoolManager)}`)
  console.log(`  Vault: ${place(scene.vault.address)}. Normal wallet: ${accounts.everyday.address}`)
  console.log(`  Ready for a run: ${(await hookReady(ctx.publicClient, scene)) ? 'yes' : 'no (run setup)'}`)
}

async function statusPrint(ctx, accounts) {
  const scene = printScene(ctx.builder.address, accounts)
  console.log(`\nAI print mint on ${where()}`)
  console.log(`  Verbatim Prints: ${place(scene.prints.address)}`)
  console.log(`  Print vault: ${place(scene.vault.address)}, ${eth(await ctx.publicClient.getBalance({ address: scene.vault.address }))}`)
}

const SETUP = { bybit: setupBybit, aave: setupAave, hook: setupHook, print: setupPrint }
const STATUS = { bybit: statusBybit, aave: statusAave, hook: statusHook, print: statusPrint }
const CHECK = { bybit: checkCopies, aave: checkPools, hook: checkHook, print: checkPrint }
const RUN = { bybit: runBybitOnce, aave: runAaveOnce, hook: runHookOnce, print: runPrintOnce }

async function rehearse(chosen) {
  console.log('Rehearsal on a private local copy of Sepolia. Nothing is sent to the real network.\n')
  const copy = await startLocalCopy()
  try {
    const ctx = connect(copy.url)
    await ctx.testClient.setBalance({ address: ctx.builder.address, value: REHEARSAL_ETH })
    const accounts = replayAccounts()
    for (const name of chosen) await SETUP[name](ctx, accounts)
    const { report, finish } = reporter()
    console.log('')
    for (const name of chosen) await CHECK[name](ctx, accounts, report)
    const runs = Number(option('times') ?? REHEARSAL_RUNS)
    for (let i = 1; i <= runs; i++) {
      for (const name of chosen) await RUN[name](ctx, accounts, i, report)
    }
    finish()
  } finally {
    copy.stop()
  }
}

async function main() {
  const command = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'rehearse'
  if (command === 'keys') return makeKeys()
  if (command === 'code') return saveCode()
  if (command === 'pools') return savePools()
  if (command === 'contracts') return saveContracts()
  if (command === 'hook-price') return saveHookPrice()
  const named = process.argv[2] === command ? process.argv[3] : process.argv[2]
  const chosen = named && !named.startsWith('--') ? [named] : REPLAYS
  if (!chosen.every((name) => REPLAYS.includes(name))) throw new Error('Choose bybit, aave, hook or print, or leave it out for all four')
  if (!live) {
    if (command !== 'rehearse') throw new Error('Without --live, the only commands are keys, code, pools, contracts, hook-price and rehearse (the default)')
    return rehearse(chosen)
  }
  const ctx = connect(process.env.SEPOLIA_RPC_URL)
  const accounts = replayAccounts()
  if (command === 'setup') {
    for (const name of chosen) await SETUP[name](ctx, accounts)
    for (const name of chosen) await STATUS[name](ctx, accounts)
    return
  }
  if (command === 'status') {
    for (const name of chosen) await STATUS[name](ctx, accounts)
    return
  }
  const { report, finish } = reporter()
  if (command === 'check') {
    for (const name of chosen) await CHECK[name](ctx, accounts, report)
    return finish()
  }
  if (command === 'run') {
    const times = Number(option('times') ?? 1)
    for (let i = 1; i <= times; i++) {
      for (const name of chosen) await RUN[name](ctx, accounts, i, report)
    }
    return finish()
  }
  throw new Error('With --live, use setup, status, check or run, then bybit, aave, hook or print (or nothing for all four)')
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    const hidden = [process.env.MAINNET_RPC_URL, process.env.MAINNET_RPC_URL?.split('/').pop()].filter(Boolean)
    console.error(hidden.reduce((text, secret) => text.split(secret).join('[hidden]'), redact(error.stack ?? error)))
    process.exit(1)
  })
}
