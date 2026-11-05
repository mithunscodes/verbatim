import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createPublicClient, encodeFunctionData, formatEther, http, parseEther, size, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { EXPLORER, FACTORY, factoryAbi, vaultAbi } from '../../app/src/config.js'
import { BYBIT } from '../src/replays.js'
import {
  BYBIT_REASON,
  DEPLOYER,
  GAS_MONEY,
  HELD,
  REPLAY_KEYS,
  SAFE,
  bybitScene,
  codeOf,
  copies,
  prepareBybit,
  replayAccounts,
  runBybit,
  safeAbi,
  sendSteps,
} from '../src/sepolia-replays.js'
import { connect, isMain, live, option, redact, startLocalCopy } from './ens.js'

const ENV_FILE = new URL('../../.env', import.meta.url)
const CODE_FILE = new URL('../src/bybit-code.json', import.meta.url)
const TARGET_MS = 60_000
const REHEARSAL_RUNS = 2
const REHEARSAL_ETH = parseEther('10')

const where = () => (live ? 'Sepolia' : 'the local copy of Sepolia')
const link = (hash) => (live ? `${EXPLORER}/tx/${hash}` : `${hash.slice(0, 10)}… on the local copy`)
const place = (address) => (live ? `${EXPLORER}/address/${address}` : address)
const eth = (wei) => `${formatEther(wei)} test ETH`
const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`
const seconds = (ms) => (ms / 1000).toFixed(1)
const log = (label, receipt) => console.log(`  ✓ ${label} (${link(receipt.transactionHash)})`)

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

async function fundGas(ctx, accounts) {
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
    steps.push({ label: `${eth(value)} for fees, from the Builder key to the replay ${role} key`, request: { to: address, value } })
  }
  await sendSteps(ctx, ctx.builder, steps, log)
}

const vaultOf = (ctx, accounts) =>
  ctx.publicClient.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'vaultOf', args: [accounts.everyday.address] })

async function setup(ctx, accounts) {
  console.log(`Setting up the Bybit replay on ${where()}`)
  await fundGas(ctx, accounts)
  const missing = []
  for (const [name, copy] of Object.entries(copies(accounts.thief.address))) {
    if (await ctx.publicClient.getCode({ address: copy.address })) continue
    missing.push({ label: `Copy Bybit's ${name} to ${copy.address}`, request: { to: DEPLOYER, data: copy.deploy } })
  }
  await sendSteps(ctx, ctx.builder, missing, log)
  if ((await vaultOf(ctx, accounts)) === zeroAddress) {
    await sendSteps(ctx, accounts.everyday, [{
      label: 'The replay everyday key creates its vault through the factory, guarded by the replay Rules key',
      request: { to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: 'createVault', args: [accounts.rules.address] }) },
    }], log)
  }
  const vault = await vaultOf(ctx, accounts)
  console.log(`  Vault: ${vault}`)
  if (!(await ctx.publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'setupFinished' }))) {
    await sendSteps(ctx, accounts.rules, [{ label: 'Finish setup', request: { to: vault, data: encodeFunctionData({ abi: vaultAbi, functionName: 'finishSetup' }) } }], log)
  }
  const held = await ctx.publicClient.getBalance({ address: vault })
  if (held < HELD) await sendSteps(ctx, ctx.builder, [{ label: `Put ${eth(HELD - held)} in the vault`, request: { to: vault, value: HELD - held } }], log)
  await prepareBybit(ctx, accounts, log)
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

async function runOnce(ctx, accounts, number, report) {
  const scene = await bybitScene(ctx.publicClient, accounts)
  const read = (functionName) => ctx.publicClient.readContract({ address: scene.safe, abi: safeAbi, functionName })
  const [version, owners, threshold] = await Promise.all([read('VERSION'), read('getOwners'), read('getThreshold')])
  console.log(`\nRun ${number} on ${where()}: Safe #${scene.run}, ${place(scene.safe)}`)
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

async function status(ctx, accounts) {
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

async function rehearse() {
  console.log('Rehearsal on a private local copy of Sepolia. Nothing is sent to the real network.\n')
  const copy = await startLocalCopy()
  try {
    const ctx = connect(copy.url)
    await ctx.testClient.setBalance({ address: ctx.builder.address, value: REHEARSAL_ETH })
    const accounts = replayAccounts()
    await setup(ctx, accounts)
    const { report, finish } = reporter()
    console.log('')
    await checkCopies(ctx, accounts, report)
    for (let i = 1; i <= REHEARSAL_RUNS; i++) await runOnce(ctx, accounts, i, report)
    finish()
  } finally {
    copy.stop()
  }
}

async function main() {
  const command = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'rehearse'
  if (command === 'keys') return makeKeys()
  if (command === 'code') return saveCode()
  if (!live) {
    if (command !== 'rehearse') throw new Error('Without --live, the only commands are keys, code and rehearse (the default)')
    return rehearse()
  }
  const ctx = connect(process.env.SEPOLIA_RPC_URL)
  const accounts = replayAccounts()
  if (command === 'setup') return setup(ctx, accounts).then(() => status(ctx, accounts))
  if (command === 'status') return status(ctx, accounts)
  const { report, finish } = reporter()
  if (command === 'check') {
    await checkCopies(ctx, accounts, report)
    return finish()
  }
  if (command === 'run') {
    const times = Number(option('times') ?? 1)
    for (let i = 1; i <= times; i++) await runOnce(ctx, accounts, i, report)
    return finish()
  }
  throw new Error('With --live, use setup, status, check or run')
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    const hidden = [process.env.MAINNET_RPC_URL, process.env.MAINNET_RPC_URL?.split('/').pop()].filter(Boolean)
    console.error(hidden.reduce((text, secret) => text.split(secret).join('[hidden]'), redact(error.stack ?? error)))
    process.exit(1)
  })
}
