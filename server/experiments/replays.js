import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  parseAbi,
  formatEther,
  formatUnits,
  getAddress,
  encodeFunctionData,
  parseEventLogs,
  BaseError,
  ContractFunctionRevertedError,
} from 'viem'
import { mainnet } from 'viem/chains'

const ANVIL = `${homedir()}/.foundry/bin/anvil`
const PORT = 8546
const LOCAL_RPC = `http://127.0.0.1:${PORT}`
const STATES = new URL('../../contracts/fork-states/', import.meta.url)
const ARTIFACTS = new URL('../../contracts/out/', import.meta.url)
const statePath = (name) => fileURLToPath(new URL(`${name}.json`, STATES))
const metaPath = (name) => fileURLToPath(new URL(`${name}-meta.json`, STATES))

const BYBIT = {
  forkArgs: ['--fork-block-number', '21895237'],
  safe: getAddress('0x1Db92e2EeBC8E0c075a02BeA49a2935BcD2dFCF4'),
  attacker: getAddress('0x0fa09C3A328792253f8dee7116848723b72a6d2e'),
  attackTx: '0x46deef0f52e3a983b67abf4714448a41dd7ffd6d32d32da69d62081c68ad7882',
  drainTx: '0xb61413c495fdad6114a7aa863a00b2e3c28945979a10885b12b30316ea9f072c',
  borrowedCode: getAddress('0x96221423681A6d52E184D440a8eFCEbB105C7242'),
  attackerCode: getAddress('0xbDd077f651EBe7f7b3cE16fe5F2b025BE2969516'),
  ethHeld: 401346768858404671846374n,
}

const AAVE = {
  forkArgs: ['--fork-transaction-hash', '0x6a1c894897b97f7d388f2943b5dad3c1138791c739ed33f3ef18b13fbfc0053e'],
  owner: getAddress('0x98b9d979c33dd7284c854909bcc09b51fbf97ac8'),
  aEthUsdt: getAddress('0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a'),
  usdtAmount: 50432688416180n,
  realWethOut: '17957.8108',
  realAaveOut: '331.3053',
  quotedAaveOut: '329',
  feeds: {
    aaveUsd: getAddress('0x547a514d5e3769680Ce22B2361c10Ea13619e8a9'),
    usdtUsd: getAddress('0x3E7d1eAB13ad0104d2750B8863b489D65364e32D'),
  },
}

const secrets = [process.env.MAINNET_RPC_URL, process.env.MAINNET_RPC_URL?.split('/').pop()].filter(Boolean)
const redact = (text) => secrets.reduce((result, secret) => result.split(secret).join('[hidden]'), String(text))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const local = {
  public: createPublicClient({ chain: mainnet, transport: http(LOCAL_RPC) }),
  wallet: createWalletClient({ chain: mainnet, transport: http(LOCAL_RPC) }),
  test: createTestClient({ chain: mainnet, mode: 'anvil', transport: http(LOCAL_RPC) }),
}
const erc20Abi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])
const transferData = () => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [BYBIT.attackerCode, 0n] })
const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
])
const feedReads = ['latestRoundData', 'decimals', 'description']

async function readFeed(address) {
  const read = (functionName) => local.public.readContract({ address, abi: feedAbi, functionName })
  const [[, answer, , updatedAt], decimals, description] = await Promise.all(feedReads.map(read))
  return { description, answer, decimals, updatedAt, price: formatUnits(answer, decimals) }
}

function artifact(file, name) {
  const json = JSON.parse(readFileSync(new URL(`${file}/${name}.json`, ARTIFACTS), 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode.object }
}

async function startAnvil(args) {
  const child = spawn(ANVIL, ['--port', String(PORT), '--chain-id', '1', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  child.stderr.on('data', (chunk) => {
    errors += chunk
  })
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`anvil stopped: ${redact(errors)}`)
    try {
      await local.public.getChainId()
      return child
    } catch {
      await sleep(500)
    }
  }
  child.kill('SIGINT')
  throw new Error('anvil did not start within 2 minutes')
}

function stopAnvil(child) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    child.once('exit', resolve)
    child.kill('SIGINT')
  })
}

async function withAnvil(args, work) {
  const child = await startAnvil(args)
  try {
    return await work()
  } finally {
    await stopAnvil(child)
  }
}

async function revertReason(request) {
  try {
    await local.public.simulateContract(request)
    return null
  } catch (error) {
    const reverted = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : null
    return reverted?.reason ?? error.shortMessage ?? String(error.message).split('\n')[0]
  }
}

async function sendAs(account, request) {
  const hash = await local.wallet.sendTransaction({ account, gas: 15_000_000n, ...request })
  return local.public.waitForTransactionReceipt({ hash })
}

async function impersonate(address) {
  await local.test.impersonateAccount({ address })
  await local.test.setBalance({ address, value: 10n ** 19n })
}

async function captureState(replay) {
  const snapshot = await local.test.snapshot()
  const hashes = await replay()
  const accounts = new Map()
  for (const hash of hashes) {
    const trace = await local.public.request({ method: 'debug_traceTransaction', params: [hash, { tracer: 'prestateTracer' }] })
    for (const [address, account] of Object.entries(trace)) {
      const known = accounts.get(address.toLowerCase()) ?? { storage: {} }
      known.balance ??= account.balance
      known.nonce ??= account.nonce
      known.code ??= account.code
      for (const [slot, value] of Object.entries(account.storage ?? {})) {
        if (!(slot in known.storage)) known.storage[slot] = value
      }
      accounts.set(address.toLowerCase(), known)
    }
  }
  await local.test.revert({ id: snapshot })
  let slots = 0
  for (const [address, account] of accounts) {
    if (account.code && account.code !== '0x') await local.test.setCode({ address, bytecode: account.code })
    if (account.balance !== undefined) await local.test.setBalance({ address, value: BigInt(account.balance) })
    if (account.nonce !== undefined) await local.test.setNonce({ address, nonce: Number(account.nonce) })
    for (const [slot, value] of Object.entries(account.storage)) {
      await local.test.setStorageAt({ address, index: slot, value })
      slots += 1
    }
  }
  return { accounts: accounts.size, slots }
}

async function prepareBybit() {
  const mainnetClient = createPublicClient({ chain: mainnet, transport: http(process.env.MAINNET_RPC_URL) })
  const attack = await mainnetClient.getTransaction({ hash: BYBIT.attackTx })
  const drain = await mainnetClient.getTransaction({ hash: BYBIT.drainTx })
  await withAnvil(['--fork-url', process.env.MAINNET_RPC_URL, ...BYBIT.forkArgs, '--dump-state', statePath('bybit')], async () => {
    const [deployer, everydayKey] = await local.wallet.getAddresses()
    const { abi, bytecode } = artifact('BybitReplayVault.sol', 'BybitReplayVault')
    const deployHash = await local.wallet.deployContract({ account: deployer, abi, bytecode, args: [everydayKey] })
    const { contractAddress: vault } = await local.public.waitForTransactionReceipt({ hash: deployHash })
    await local.test.setBalance({ address: vault, value: BYBIT.ethHeld })
    console.log(`Copied Ethereum at block ${await local.public.getBlockNumber()}, set up the vault at ${vault} holding ${formatEther(BYBIT.ethHeld)} ETH`)
    const captured = await captureState(async () => {
      await impersonate(BYBIT.attacker)
      const takeover = await sendAs(BYBIT.attacker, { to: BYBIT.safe, data: attack.input })
      const sweep = await sendAs(BYBIT.attacker, { to: BYBIT.safe, data: drain.input })
      const forced = await sendAs(everydayKey, { to: vault, data: encodeFunctionData({ abi, functionName: 'execute', args: [BYBIT.borrowedCode, 0n, transferData(), 1] }) })
      console.log(`Online replay: takeover ${takeover.status}, sweep ${sweep.status}, vault attack ${forced.status}`)
      return [takeover.transactionHash, sweep.transactionHash, forced.transactionHash]
    })
    console.log(`Pinned ${captured.accounts} accounts and ${captured.slots} storage slots into the copy`)
    writeFileSync(metaPath('bybit'), JSON.stringify({ vault, deployer, everydayKey, attackInput: attack.input, drainInput: drain.input }, null, 2))
  })
  console.log(`Saved to ${statePath('bybit')}`)
}

async function runBybit() {
  const meta = JSON.parse(readFileSync(metaPath('bybit'), 'utf8'))
  await withAnvil(['--load-state', statePath('bybit')], async () => {
    const slot0 = () => local.public.getStorageAt({ address: BYBIT.safe, slot: '0x0' })
    console.log("Bybit's real wallet (a Safe, version 1.1.1), on the saved copy")
    console.log(`  Before: ${formatEther(await local.public.getBalance({ address: BYBIT.safe }))} ETH, code ${await slot0()}`)
    await impersonate(BYBIT.attacker)
    const takeover = await sendAs(BYBIT.attacker, { to: BYBIT.safe, data: meta.attackInput })
    console.log(`  Bybit's exact attack transaction: ${takeover.status}. Code is now ${await slot0()}`)
    const drain = await sendAs(BYBIT.attacker, { to: BYBIT.safe, data: meta.drainInput })
    console.log(`  The attacker's sweep: ${drain.status}. Left in the wallet: ${formatEther(await local.public.getBalance({ address: BYBIT.safe }))} ETH`)

    const { abi } = artifact('BybitReplayVault.sol', 'BybitReplayVault')
    const request = { account: meta.everydayKey, address: meta.vault, abi, functionName: 'execute', args: [BYBIT.borrowedCode, 0n, transferData(), 1] }
    console.log('Throwaway Verbatim vault, same attack')
    console.log(`  Before: ${formatEther(await local.public.getBalance({ address: meta.vault }))} ETH`)
    const reason = await revertReason(request)
    const forced = await sendAs(meta.everydayKey, { to: meta.vault, data: encodeFunctionData(request) })
    console.log(`  The same borrowed-code call, sent anyway: ${forced.status}. Reason: ${reason}`)
    console.log(`  After: ${formatEther(await local.public.getBalance({ address: meta.vault }))} ETH`)
  })
}

async function prepareAave() {
  await withAnvil(['--fork-url', process.env.MAINNET_RPC_URL, ...AAVE.forkArgs, '--dump-state', statePath('aave')], async () => {
    const [deployer] = await local.wallet.getAddresses()
    const { abi, bytecode } = artifact('AaveRouteReplay.sol', 'AaveRouteReplay')
    const deployHash = await local.wallet.deployContract({ account: deployer, abi, bytecode })
    const { contractAddress: helper } = await local.public.waitForTransactionReceipt({ hash: deployHash })
    await impersonate(AAVE.owner)
    const moved = await sendAs(AAVE.owner, { to: AAVE.aEthUsdt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [helper, AAVE.usdtAmount] }) })
    await local.test.stopImpersonatingAccount({ address: AAVE.owner })
    console.log(`Copied Ethereum just before the trade (block ${await local.public.getBlockNumber()}). Moved ${formatUnits(AAVE.usdtAmount, 6)} aEthUSDT to the route contract: ${moved.status}`)
    for (const feed of Object.values(AAVE.feeds)) {
      const { description, price, updatedAt } = await readFeed(feed)
      console.log(`Chainlink ${description} at ${feed}: $${price}, updated ${new Date(Number(updatedAt) * 1000).toISOString()}`)
    }
    const captured = await captureState(async () => {
      const hashes = []
      for (const feed of Object.values(AAVE.feeds)) {
        for (const functionName of feedReads) {
          const read = await sendAs(deployer, { to: feed, data: encodeFunctionData({ abi: feedAbi, functionName }) })
          hashes.push(read.transactionHash)
        }
      }
      const receipt = await sendAs(deployer, { to: helper, data: encodeFunctionData({ abi, functionName: 'run', args: [AAVE.usdtAmount] }) })
      const [done] = parseEventLogs({ abi, eventName: 'RouteDone', logs: receipt.logs })
      console.log(`Online replay: ${receipt.status}, ${formatEther(done.args.wethOut)} WETH, then ${formatEther(done.args.aaveOut)} AAVE`)
      return [...hashes, receipt.transactionHash]
    })
    console.log(`Pinned ${captured.accounts} accounts and ${captured.slots} storage slots into the copy`)
    writeFileSync(metaPath('aave'), JSON.stringify({ helper, deployer }, null, 2))
  })
  console.log(`Saved to ${statePath('aave')}`)
}

async function runAave() {
  const meta = JSON.parse(readFileSync(metaPath('aave'), 'utf8'))
  await withAnvil(['--load-state', statePath('aave')], async () => {
    const { abi } = artifact('AaveRouteReplay.sol', 'AaveRouteReplay')
    const request = { account: meta.deployer, address: meta.helper, abi, functionName: 'run', args: [AAVE.usdtAmount] }
    const reason = await revertReason(request)
    if (reason) throw new Error(`The route would fail: ${reason}`)
    const receipt = await sendAs(meta.deployer, { to: meta.helper, data: encodeFunctionData(request) })
    const [done] = parseEventLogs({ abi, eventName: 'RouteDone', logs: receipt.logs })
    console.log('The $50.4M Aave trade, same route, same pools, on the saved copy')
    console.log(`  Transaction: ${receipt.status}, gas used ${receipt.gasUsed}`)
    console.log(`  In: ${formatUnits(done.args.usdtIn, 6)} USDT (redeemed from aEthUSDT on Aave)`)
    console.log(`  Uniswap V3 gave: ${formatEther(done.args.wethOut)} WETH (real trade: ${AAVE.realWethOut})`)
    console.log(`  SushiSwap gave: ${formatEther(done.args.aaveOut)} AAVE (real trade: ${AAVE.realAaveOut}, quoted: about ${AAVE.quotedAaveOut})`)
    const { timestamp } = await local.public.getBlock({ blockNumber: receipt.blockNumber })
    const aave = await readFeed(AAVE.feeds.aaveUsd)
    const usdt = await readFeed(AAVE.feeds.usdtUsd)
    for (const feed of [aave, usdt]) {
      console.log(`  Chainlink ${feed.description}: $${feed.price}, updated ${(timestamp - feed.updatedAt) / 60n} minutes before this block`)
    }
    const fair = (done.args.usdtIn * 10n ** 12n * usdt.answer * 10n ** BigInt(aave.decimals)) / (aave.answer * 10n ** BigInt(usdt.decimals))
    const less = ((fair - done.args.aaveOut) * 10000n + fair / 2n) / fair
    console.log(`  Fair amount at Chainlink's prices: ${formatEther(fair)} AAVE. You'd get ${formatUnits(less, 2)}% less`)
  })
}

const commands = {
  prepare: { bybit: prepareBybit, aave: prepareAave },
  run: { bybit: runBybit, aave: runAave },
}
const [action, target] = process.argv.slice(2)
const command = commands[action]?.[target]
if (!command) {
  console.log('Usage: node --env-file=../.env experiments/replays.js prepare|run bybit|aave')
  process.exit(1)
}
mkdirSync(STATES, { recursive: true })
command().catch((error) => {
  console.error(redact(error.stack ?? error))
  process.exit(1)
})
