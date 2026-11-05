import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { encodeFunctionData, formatEther, formatUnits, parseAbi } from 'viem'
import { AAVE, BYBIT, aaveOnCopy, aaveSetupOnCopy, bybitOnCopy, metaPath, startCopy, statePath } from '../src/replays.js'

const AAVE_FORK_TX = '0x6a1c894897b97f7d388f2943b5dad3c1138791c739ed33f3ef18b13fbfc0053e'
const TARGET_MS = 20_000
const BYBIT_REASON = 'Borrowed code would run in your account'
const AAVE_REASON = 'Unfair trade'
const FEED_READS = parseAbi(['function latestRoundData()', 'function decimals()'])

const secrets = () => [process.env.MAINNET_RPC_URL, process.env.MAINNET_RPC_URL?.split('/').pop()].filter(Boolean)
const redact = (text) => secrets().reduce((result, secret) => result.split(secret).join('[hidden]'), String(text))
const eth = (wei) => Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 2 })

let failures = 0
function report(ok, text) {
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${text}`)
}

async function tracePrestate(c, hashes, into) {
  for (const hash of hashes) {
    const trace = await c.public.request({ method: 'debug_traceTransaction', params: [hash, { tracer: 'prestateTracer' }] })
    for (const [address, account] of Object.entries(trace)) {
      const known = into.get(address.toLowerCase()) ?? { storage: {} }
      known.balance ??= account.balance
      known.nonce ??= account.nonce
      known.code ??= account.code
      for (const [slot, value] of Object.entries(account.storage ?? {})) {
        if (!(slot in known.storage)) known.storage[slot] = value
      }
      into.set(address.toLowerCase(), known)
    }
  }
}

async function pin(c, accounts) {
  let slots = 0
  for (const [address, account] of accounts) {
    if (account.code && account.code !== '0x') await c.test.setCode({ address, bytecode: account.code })
    if (account.balance !== undefined) await c.test.setBalance({ address, value: BigInt(account.balance) })
    if (account.nonce !== undefined) await c.test.setNonce({ address, nonce: Number(account.nonce) })
    for (const [slot, value] of Object.entries(account.storage)) {
      await c.test.setStorageAt({ address, index: slot, value })
      slots++
    }
  }
  return slots
}

async function prepare() {
  if (!process.env.MAINNET_RPC_URL) throw new Error('MAINNET_RPC_URL is missing from .env. Run this from server/ with --env-file=../.env')
  const target = statePath(AAVE.state)
  if (existsSync(target)) {
    copyFileSync(target, `${target}.previous`)
    console.log(`Kept the old copy as ${AAVE.state}.json.previous, in case this fails halfway`)
  }
  console.log('Copying Ethereum just before the $50.4M Aave trade (online, once)…')
  const { c, stop } = await startCopy(['--fork-url', process.env.MAINNET_RPC_URL, '--fork-transaction-hash', AAVE_FORK_TX, '--dump-state', target])
  try {
    const setup = await aaveSetupOnCopy(c)
    writeFileSync(metaPath(AAVE.state), JSON.stringify(setup, null, 2))
    console.log(`  Set up the route ${setup.route}, the Chainlink price reader ${setup.source} and a Verbatim vault ${setup.vault}`)
    const accounts = new Map()
    const result = await aaveOnCopy(c, { afterPhase: (hashes) => tracePrestate(c, hashes, accounts) })
    const [deployer] = await c.wallet.getAddresses()
    const feedReads = []
    for (const feed of Object.values(AAVE.feeds)) {
      for (const functionName of ['latestRoundData', 'decimals']) {
        const hash = await c.wallet.sendTransaction({ account: deployer, to: feed, data: encodeFunctionData({ abi: FEED_READS, functionName }) })
        feedReads.push((await c.public.waitForTransactionReceipt({ hash })).transactionHash)
      }
    }
    await tracePrestate(c, feedReads, accounts)
    console.log(`  Online: the normal wallet got ${formatEther(result.wallet.aaveOut)} AAVE; the vault: "${result.vault.reason}"`)
    const slots = await pin(c, accounts)
    console.log(`  Pinned ${accounts.size} accounts and ${slots} storage slots, so the copy runs without internet`)
  } finally {
    await stop()
  }
  console.log(`Saved to contracts/fork-states/${AAVE.state}.json`)
}

async function runBybit() {
  const started = Date.now()
  const { c, stop } = await startCopy(['--load-state', statePath(BYBIT.state)])
  try {
    const { wallet, vault } = await bybitOnCopy(c)
    const ms = Date.now() - started
    console.log(`\nBybit, ${BYBIT.date}: its exact attack, on the saved copy of Ethereum (block ${BYBIT.block.toLocaleString('en-US')})`)
    report(
      wallet.takeover === 'success' && wallet.sweep === 'success' && wallet.after === 0n && wallet.codeAfter === BYBIT.attackerCode,
      `Bybit's real wallet: code replaced (${wallet.codeBefore.slice(0, 6)}… → ${wallet.codeAfter.slice(0, 6)}…), then swept: ${eth(wallet.before)} → ${eth(wallet.after)} ETH`,
    )
    report(
      vault.status === 'reverted' && vault.reason === BYBIT_REASON && vault.after === vault.before && vault.before === BYBIT.ethHeld,
      `A Verbatim vault (version 3 code) holding ${eth(vault.before)} ETH, same attack: refused, "${vault.reason}". Still ${eth(vault.after)} ETH`,
    )
    report(ms < TARGET_MS, `Took ${(ms / 1000).toFixed(1)} s, including starting the copy`)
  } finally {
    await stop()
  }
}

async function runAave() {
  const started = Date.now()
  const { c, stop } = await startCopy(['--load-state', statePath(AAVE.state)])
  try {
    const { wallet, vault, fair, lessBps, prices } = await aaveOnCopy(c)
    const ms = Date.now() - started
    console.log(`\nAave, ${AAVE.date}: the $50.4M trade, same pools, on the saved copy of Ethereum`)
    report(
      wallet.status === 'success' && wallet.aaveOut >= AAVE.quoted,
      `A normal wallet: ${formatUnits(wallet.usdtIn, 6)} USDT → ${formatEther(wallet.wethOut)} WETH → ${formatEther(wallet.aaveOut)} AAVE (quoted: about 329)`,
    )
    report(
      vault.status === 'reverted' && vault.reason === AAVE_REASON && vault.heldAfter >= vault.held,
      `A Verbatim vault, same trade and the user's own checks (at least 329 AAVE): refused, "${vault.reason}". Nothing left: ${formatUnits(vault.held, 6)} → ${formatUnits(vault.heldAfter, 6)} aEthUSDT (Aave interest only)`,
    )
    report(
      lessBps >= 9990n,
      `Chainlink (AAVE $${formatUnits(prices.aaveUsd.answer, prices.aaveUsd.decimals)}, ${prices.aaveUsd.minutesOld} min old; USDT $${formatUnits(prices.usdtUsd.answer, prices.usdtUsd.decimals)}, ${prices.usdtUsd.minutesOld} min old): fair is ${Number(formatEther(fair)).toLocaleString('en-US', { maximumFractionDigits: 2 })} AAVE. "You'd get ${formatUnits(lessBps, 2)}% less than a fair price"`,
    )
    report(ms < TARGET_MS, `Took ${(ms / 1000).toFixed(1)} s, including starting the copy`)
  } finally {
    await stop()
  }
}

async function main() {
  const command = process.argv[2] ?? 'run'
  if (command === 'prepare') return prepare()
  if (command !== 'run') throw new Error('Use: scripts/replays.js prepare (online, once) or run (offline)')
  const which = process.argv[3]
  if (!which || which === 'bybit') await runBybit()
  if (!which || which === 'aave') await runAave()
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(redact(error.stack ?? error))
  process.exit(1)
})
