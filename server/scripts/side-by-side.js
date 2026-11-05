import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { erc20Abi, formatEther, formatUnits, parseEther, parseUnits, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { DEMO_ALLOWED_SEND, DEMO_TIMINGS, EXPLORER, FACTORY, factoryAbi, PRICE_SOURCE, UNIVERSAL_ROUTER, vaultAbi } from '../../app/src/config.js'
import { lowFees } from '../../app/src/chain.js'
import {
  ATTACKS,
  attackRequest,
  demoClients,
  findScene,
  readBalances,
  resultOf,
  sameAddress,
  sendAllowed,
  sendAttack,
  sendTry,
  sentenceRequest,
  sentenceVault,
  vaultRun,
} from '../../app/src/demo.js'
import { planFor } from '../../app/src/ai.js'
import { ChangeKind } from '../../app/src/rules.js'
import { explainRefusal, saidFor } from '../../app/src/words.js'
import {
  RESOLVER_IMPL,
  UNIVERSAL_RESOLVER,
  VERIFIABLE_FACTORY,
  accountFor,
  artifact,
  connect,
  ensTools,
  isMain,
  live,
  option,
  runMain,
  startLocalCopy,
} from './ens.js'
import { TRUSTED_NAMES, setupDirectory } from './directory.js'
import { UNISWAP_V3_POOLS } from '../src/config.js'
import { understand } from '../src/understand.js'

const ENV_FILE = new URL('../../.env', import.meta.url)
const MAKE_KEYS = 'scripts/side-by-side.js keys'
const KEYS = {
  DEMO_EVERYDAY_PRIVATE_KEY: 'Demo everyday key: the normal wallet, handed out by the QR code',
  DEMO_RULES_PRIVATE_KEY: "Demo Rules key: the demo vault's rules, kept on the laptop",
  DEMO_THIEF_PRIVATE_KEY: 'Demo thief: receives what the attack steals, so the reset can return it',
}
const STARTING = '20'
const DAILY_LIMIT = '100'
const NEW_CONTACT_LIMIT = '10'
const GAS_MONEY = { everyday: parseEther('0.005'), rules: parseEther('0.001'), thief: parseEther('0.001') }
const APP_PORT = 5173
const TARGET_MS = 60_000
const REHEARSAL_RUNS = 2
const REHEARSAL_BLOCK_MS = 1_000
const REHEARSAL_USDC = '100'
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const ETHERSCAN_WAIT_MS = 180_000
const CHAIN_POLL_MS = 5_000
const ETHERSCAN_POLL_MS = 3_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const seconds = (ms) => (ms / 1000).toFixed(1)
const where = () => (live ? 'Sepolia' : 'the local copy of Sepolia')
const link = (hash) => (live ? `${EXPLORER}/tx/${hash}` : `${hash.slice(0, 10)}… on the local copy`)

function makeKeys() {
  for (const [name, role] of Object.entries(KEYS)) {
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

function replaceKey(name, key) {
  const env = readFileSync(ENV_FILE, 'utf8')
  const line = new RegExp(`^${name}=.*$`, 'm')
  writeFileSync(ENV_FILE, line.test(env) ? env.replace(line, `${name}=${key}`) : `${env}${env.endsWith('\n') ? '' : '\n'}${name}=${key}\n`)
  process.env[name] = key
}

function context(url, factory) {
  return {
    ...connect(url),
    url,
    factory,
    everyday: accountFor('DEMO_EVERYDAY_PRIVATE_KEY', MAKE_KEYS),
    rules: accountFor('DEMO_RULES_PRIVATE_KEY', MAKE_KEYS),
    thief: accountFor('DEMO_THIEF_PRIVATE_KEY', MAKE_KEYS),
    funder: accountFor('EVERYDAY_PRIVATE_KEY'),
    phone: demoClients(url, process.env.DEMO_EVERYDAY_PRIVATE_KEY),
  }
}

async function sendAll(ctx, account, steps) {
  if (steps.length === 0) return []
  const { publicClient } = ctx
  const wallet = ctx.wallet(account)
  const [nonce, fees] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    lowFees(publicClient),
  ])
  const hashes = []
  for (const [i, step] of steps.entries()) {
    const common = { account, nonce: nonce + i, ...fees }
    if (!step.request.abi) {
      hashes.push(await wallet.sendTransaction({ ...step.request, ...common }))
      continue
    }
    const gas = ((await publicClient.estimateContractGas({ ...step.request, account })) * 13n) / 10n
    hashes.push(await wallet.writeContract({ ...step.request, ...common, gas }))
  }
  return Promise.all(steps.map(async (step, i) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: hashes[i], timeout: 180_000 })
    if (receipt.status !== 'success') throw new Error(`${step.label}: failed (${link(hashes[i])})`)
    console.log(`  ✓ ${step.label} (${link(hashes[i])})`)
    return receipt
  }))
}

async function fundGas(ctx) {
  const roles = [
    ['everyday', ctx.everyday, 'the demo everyday key'],
    ['rules', ctx.rules, 'the demo Rules key'],
    ['thief', ctx.thief, 'the thief'],
  ]
  const steps = []
  for (const [role, account, name] of roles) {
    const balance = await ctx.publicClient.getBalance({ address: account.address })
    if (balance >= GAS_MONEY[role] / 2n) continue
    if (ctx.testClient) {
      await ctx.testClient.setBalance({ address: account.address, value: GAS_MONEY[role] })
      continue
    }
    const value = GAS_MONEY[role] - balance
    steps.push({ label: `${formatEther(value)} test ETH for fees, from the Builder key to ${name}`, request: { to: account.address, value } })
  }
  await sendAll(ctx, ctx.builder, steps)
}

function vaultOf(ctx) {
  return ctx.publicClient.readContract({ address: ctx.factory, abi: factoryAbi, functionName: 'vaultOf', args: [ctx.everyday.address] })
}

async function scene(ctx) {
  const found = await findScene(ctx.phone.reader, ctx.everyday.address, ctx.thief.address, ctx.factory)
  if (!found.vault) throw new Error(`The demo vault doesn't exist yet on ${where()}. Run setup first.`)
  return found
}

async function setup(ctx) {
  console.log(`Setting up the side-by-side demo on ${where()}`)
  await fundGas(ctx)
  if ((await vaultOf(ctx)) === zeroAddress) {
    await sendAll(ctx, ctx.everyday, [{
      label: 'The demo everyday key creates its vault through the factory, guarded by the demo Rules key',
      request: { address: ctx.factory, abi: factoryAbi, functionName: 'createVault', args: [ctx.rules.address] },
    }])
  }
  const target = { address: await vaultOf(ctx), abi: vaultAbi }
  const read = (functionName, args = []) => ctx.publicClient.readContract({ ...target, functionName, args })
  console.log(`  Vault: ${target.address}`)
  if (!(await read('setupFinished'))) {
    const token = await read('watchedTokens', [0n])
    const decimals = await ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
    const unit = (text) => parseUnits(text, decimals)
    const rule = (label, functionName, args = []) => ({ label, request: { ...target, functionName, args } })
    const saved = (await read('savedAt', [ctx.builder.address])) > 0n
    await sendAll(ctx, ctx.rules, [
      !saved && rule('Save the Builder key as the only contact', 'saveContact', [ctx.builder.address]),
      rule(`Daily limit: ${DAILY_LIMIT} USDC`, 'setDailyLimit', [token, unit(DAILY_LIMIT)]),
      rule(`New-contact limit: ${NEW_CONTACT_LIMIT} USDC`, 'setNewContactLimit', [token, unit(NEW_CONTACT_LIMIT)]),
      rule(`Contacts count as new for ${DEMO_TIMINGS.newContactPeriod} seconds (demo time)`, 'setNewContactPeriod', [DEMO_TIMINGS.newContactPeriod]),
      rule(`Loosening wait: ${DEMO_TIMINGS.looseningWait} seconds (demo time)`, 'setLooseningWait', [DEMO_TIMINGS.looseningWait]),
      rule(`One-off payments to contacts saved ${DEMO_TIMINGS.allowanceMinAge} seconds ago (demo time)`, 'setAllowanceMinAge', [DEMO_TIMINGS.allowanceMinAge]),
      rule('Price source: the pool price reader', 'setPriceSource', [PRICE_SOURCE]),
      rule('Finish setup', 'finishSetup'),
    ].filter(Boolean))
  }
  await matchDailyLimit(ctx, target)
  await cancelOpenChanges(ctx, target.address)
  await reset(ctx)
}

async function cancelOpenChanges(ctx, vault) {
  const read = (functionName, args = []) => ctx.publicClient.readContract({ address: vault, abi: vaultAbi, functionName, args })
  const count = await read('changeCount')
  const steps = []
  for (let id = 0n; id < count; id++) {
    const [, , , , , , , cancelled, done] = await read('changes', [id])
    if (cancelled || done) continue
    steps.push({ label: `Cancel change #${id}, proposed with the demo key`, request: { address: vault, abi: vaultAbi, functionName: 'cancel', args: [id] } })
  }
  await sendAll(ctx, ctx.rules, steps)
}

async function waitUntil(ctx, timestamp) {
  if (ctx.testClient) {
    const { timestamp: now } = await ctx.publicClient.getBlock()
    if (now < timestamp) await ctx.testClient.increaseTime({ seconds: Number(timestamp - now) + 1 })
    await ctx.testClient.mine({ blocks: 1 })
    return
  }
  for (;;) {
    const { timestamp: now } = await ctx.publicClient.getBlock({ blockTag: 'latest' })
    if (now >= timestamp) return
    console.log(`  … the loosening wait: ${timestamp - now} s to go`)
    await sleep(CHAIN_POLL_MS)
  }
}

async function matchDailyLimit(ctx, target) {
  const read = (functionName, args = []) => ctx.publicClient.readContract({ ...target, functionName, args })
  const token = await read('watchedTokens', [0n])
  const decimals = await ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
  const want = parseUnits(DAILY_LIMIT, decimals)
  const current = await read('dailyLimit', [token])
  if (current === want) return
  if (want < current) {
    await sendAll(ctx, ctx.rules, [{ label: `Daily limit: ${DAILY_LIMIT} USDC (tightening is immediate)`, request: { ...target, functionName: 'setDailyLimit', args: [token, want] } }])
    return
  }
  const { timestamp: now } = await ctx.publicClient.getBlock()
  let id = null
  const count = await read('changeCount')
  for (let i = 0n; i < count; i++) {
    const [kind, , changeToken, value, , readyAt, expiresAt, cancelled, done] = await read('changes', [i])
    const usable = readyAt === 0n || expiresAt >= now
    if (Number(kind) === ChangeKind.DailyLimit && sameAddress(changeToken, token) && value === want && !cancelled && !done && usable) id = i
  }
  if (id === null) {
    await cancelOpenChanges(ctx, target.address)
    id = count
    await sendAll(ctx, ctx.everyday, [{
      label: `Propose a daily limit of ${DAILY_LIMIT} USDC, instead of ${formatUnits(current, decimals)} (raising one needs a proposal)`,
      request: { ...target, functionName: 'propose', args: [ChangeKind.DailyLimit, zeroAddress, token, want] },
    }])
  } else {
    console.log(`  Change #${id} already proposes ${DAILY_LIMIT} USDC a day, so it's picked up where it stopped`)
  }
  if ((await read('changes', [id]))[5] === 0n) {
    await sendAll(ctx, ctx.rules, [{ label: `The demo Rules key approves change #${id}`, request: { ...target, functionName: 'approve', args: [id] } }])
  }
  const [, , , , , readyAt] = await read('changes', [id])
  await waitUntil(ctx, readyAt)
  await sendAll(ctx, ctx.everyday, [{ label: `Switch on change #${id}: ${DAILY_LIMIT} USDC a day`, request: { ...target, functionName: 'switchOn', args: [id] } }])
}

async function reset(ctx) {
  const found = await scene(ctx)
  await fundGas(ctx)
  await cancelOpenChanges(ctx, found.vault)
  const unit = (text) => parseUnits(text, found.decimals)
  const usdc = (amount) => `${formatUnits(amount, found.decimals)} ${found.symbol}`
  const balanceOf = (address) => ctx.publicClient.readContract({ address: found.token, abi: erc20Abi, functionName: 'balanceOf', args: [address] })
  const sources = [
    { name: 'the Builder key', account: ctx.builder },
    { name: 'the thief', account: ctx.thief },
    { name: 'the main everyday key', account: ctx.funder },
  ]
  for (const source of sources) source.left = await balanceOf(source.account.address)
  const needs = [
    { name: 'the vault', address: found.vault, want: unit(STARTING) + unit(DEMO_ALLOWED_SEND) },
    { name: 'the normal wallet', address: ctx.everyday.address, want: unit(STARTING) },
  ]
  const plan = new Map()
  for (const need of needs) {
    const has = await balanceOf(need.address)
    if (has > need.want) console.log(`  ! ${need.name} holds ${usdc(has)}, more than ${usdc(need.want)}. The demo will show that amount.`)
    let missing = has < need.want ? need.want - has : 0n
    for (const source of sources) {
      const take = source.left < missing ? source.left : missing
      if (take === 0n) continue
      source.left -= take
      missing -= take
      const steps = plan.get(source) ?? []
      steps.push({
        label: `${usdc(take)} from ${source.name} to ${need.name}`,
        request: { address: found.token, abi: erc20Abi, functionName: 'transfer', args: [need.address, take] },
      })
      plan.set(source, steps)
    }
    if (missing > 0n) {
      throw new Error(`Not enough test USDC to refill ${need.name}: ${usdc(missing)} more is needed. Get 20 from faucet.circle.com (Ethereum Sepolia) for the main everyday key.`)
    }
  }
  if (plan.size === 0) console.log(`  Both accounts are already in place: ${usdc(needs[1].want)} in the normal wallet, ${usdc(needs[0].want)} in the vault`)
  await Promise.all([...plan].map(([source, steps]) => sendAll(ctx, source.account, steps)))
  await warnings(ctx, found)
}

async function isStuck(ctx, address) {
  const [latest, pending] = await Promise.all([
    ctx.publicClient.getTransactionCount({ address, blockTag: 'latest' }),
    ctx.publicClient.getTransactionCount({ address, blockTag: 'pending' }),
  ])
  return pending > latest
}

async function warnings(ctx, found) {
  const [left, stuck] = await Promise.all([
    ctx.publicClient.readContract({ address: found.vault, abi: vaultAbi, functionName: 'leftToday', args: [found.token] }),
    isStuck(ctx, ctx.everyday.address),
  ])
  const needed = parseUnits(DEMO_ALLOWED_SEND, found.decimals)
  if (left < needed) console.log(`  ! Today's limit has only ${formatUnits(left, found.decimals)} ${found.symbol} left, so the allowed send will be refused. Run fresh --live for a new key and vault.`)
  if (stuck) console.log('  ! The demo key has a transaction stuck waiting on Sepolia, so its next sends will wait too. Run fresh --live for a new key and vault.')
}

async function recover(ctx) {
  const found = await findScene(ctx.phone.reader, ctx.everyday.address, ctx.thief.address, ctx.factory)
  const key = ctx.everyday.address
  if (await isStuck(ctx, key)) {
    console.log(`  ! The old demo key ${key} has a stuck transaction, so its leftovers stay where they are.`)
    return
  }
  const balanceOf = (address) => ctx.publicClient.readContract({ address: found.token, abi: erc20Abi, functionName: 'balanceOf', args: [address] })
  const steps = []
  if (found.vault && found.contact && found.setupFinished) {
    const [held, left] = await Promise.all([
      balanceOf(found.vault),
      ctx.publicClient.readContract({ address: found.vault, abi: vaultAbi, functionName: 'leftToday', args: [found.token] }),
    ])
    const amount = held < left ? held : left
    if (amount > 0n) {
      steps.push({ label: `The old vault pays its ${formatUnits(amount, found.decimals)} ${found.symbol} back to its contact, the Builder key`, request: vaultRun(found, found.contact, amount) })
    }
    if (held > amount) console.log(`  ! ${formatUnits(held - amount, found.decimals)} ${found.symbol} stays in the old vault: today's limit is used up`)
  }
  if (found.token) {
    const loose = await balanceOf(key)
    if (loose > 0n) {
      steps.push({
        label: `The old normal wallet sends its ${formatUnits(loose, found.decimals)} ${found.symbol} back to the Builder key`,
        request: { address: found.token, abi: erc20Abi, functionName: 'transfer', args: [ctx.builder.address, loose] },
      })
    }
  }
  for (const step of steps) {
    try {
      await sendAll(ctx, ctx.everyday, [step])
    } catch (error) {
      console.log(`  ! Skipped: ${step.label} (${error.shortMessage ?? error.message})`)
    }
  }
  const [gas, fees] = await Promise.all([ctx.publicClient.getBalance({ address: key }), lowFees(ctx.publicClient)])
  const cost = 21_000n * fees.maxFeePerGas
  if (gas > cost * 2n) await sendAll(ctx, ctx.everyday, [{ label: `The old demo key returns ${formatEther(gas - cost)} test ETH to the Builder key`, request: { to: ctx.builder.address, value: gas - cost } }])
}

async function fresh(ctx) {
  console.log(`A fresh demo key and vault on ${where()}`)
  const old = ctx.everyday.address
  await recover(ctx)
  replaceKey('DEMO_EVERYDAY_PRIVATE_KEY', generatePrivateKey())
  const next = context(ctx.url, ctx.factory)
  console.log(`  New demo key in .env: ${next.everyday.address}. The old one, ${old}, is now worthless to anyone who photographed it.`)
  await setup(next)
  await status(next)
  console.log('\nNext: restart the server (Ctrl+C, then npm start in server/) so the short link hands out the new key, then run screen again for the new QR code.')
}

async function status(ctx) {
  const found = await findScene(ctx.phone.reader, ctx.everyday.address, ctx.thief.address, ctx.factory)
  const thiefUsdc = found.vault
    ? await ctx.publicClient.readContract({ address: found.token, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.thief.address] })
    : 0n
  console.log(`Side-by-side demo on ${where()}`)
  console.log(`  Normal wallet (the demo everyday key): ${ctx.everyday.address}`)
  console.log(`  Demo Rules key: ${ctx.rules.address}`)
  console.log(`  Thief: ${ctx.thief.address}`)
  if (!found.vault) {
    console.log('  No demo vault yet. Run setup.')
    return
  }
  const balances = await readBalances(ctx.phone.reader, found)
  const usdc = (amount) => `${formatUnits(amount, found.decimals)} ${found.symbol}`
  console.log(`  Vault: ${found.vault}, setup ${found.setupFinished ? 'finished' : 'not finished'}, saved contact ${found.contact ?? 'none'}`)
  console.log(`  Holding: normal wallet ${usdc(balances.wallet)} and ${formatEther(balances.gas)} test ETH for fees, vault ${usdc(balances.vault)}, thief ${usdc(thiefUsdc)}`)
}

async function etherscanPage(hash) {
  const html = await fetch(`${EXPLORER}/tx/${hash}`, { headers: { 'user-agent': BROWSER } })
    .then((response) => (response.ok ? response.text() : ''))
    .catch(() => '')
  const summary = html.match(/<meta name="Description" content="([^"]*)"/)?.[1] ?? ''
  if (summary.includes('| Success |')) return { shown: 'Success' }
  const failed = html.match(/Fail with error '([^']*)'/)
  return failed ? { shown: 'Failed', reason: failed[1] } : null
}

async function onEtherscan(hashes) {
  const shown = {}
  const deadline = Date.now() + ETHERSCAN_WAIT_MS
  while (Date.now() < deadline) {
    for (const hash of hashes) shown[hash] ??= await etherscanPage(hash)
    if (hashes.every((hash) => shown[hash])) break
    await sleep(ETHERSCAN_POLL_MS)
  }
  return shown
}

async function runOnce(ctx, number, report) {
  console.log(`\nRun ${number}: reset first (not timed)`)
  await reset(ctx)
  const { reader } = ctx.phone
  const found = await scene(ctx)
  const usdc = (amount) => `${formatUnits(amount, found.decimals)} ${found.symbol}`
  const starting = parseUnits(STARTING, found.decimals)
  console.log(`Run ${number}: timed, with the phone page's own code`)
  const started = Date.now()
  const allowedHash = await sendAllowed(ctx.phone, found)
  const allowed = await resultOf(reader, allowedHash)
  const allowedAt = Date.now()
  const before = await readBalances(reader, found)
  const hashes = await sendAttack(ctx.phone, found, before)
  const [wallet, vault] = await Promise.all([resultOf(reader, hashes.wallet), resultOf(reader, hashes.vault)])
  const finishedAt = Date.now()
  const after = await readBalances(reader, found)
  report(allowed.ok, `Allowed send: Success, ${DEMO_ALLOWED_SEND} ${found.symbol} to the Builder key (${link(allowedHash)})`)
  report(before.wallet === starting && before.vault === starting, `When the attack hit, the normal wallet held ${usdc(before.wallet)} and the vault ${usdc(before.vault)}`)
  report(wallet.ok && after.wallet === 0n, `Normal wallet: ${wallet.ok ? 'Success' : 'Failed'}, now ${usdc(after.wallet)} (${link(hashes.wallet)})`)
  report(!vault.ok && vault.reason === 'Not a saved contact' && after.vault === before.vault, `Vault: ${vault.ok ? 'Success' : 'Failed'}, "${vault.reason}", still ${usdc(after.vault)} (${link(hashes.vault)})`)
  const total = finishedAt - started
  report(total < TARGET_MS, `Start to finish, until both results are on the chain: ${seconds(total)} s (allowed send ${seconds(allowedAt - started)} s, attack ${seconds(finishedAt - allowedAt)} s)`)
  return { number, total, allowed: allowedHash, wallet: hashes.wallet, vault: hashes.vault }
}

async function checkEtherscan(runs, report) {
  console.log(`\nEtherscan's own pages, checked after the runs (its Sepolia index can trail the chain by about 2 minutes)`)
  const shown = await onEtherscan(runs.flatMap((run) => [run.allowed, run.wallet, run.vault]))
  for (const run of runs) {
    const page = (hash) => shown[hash]?.shown ?? 'not shown yet'
    const reason = shown[run.vault]?.reason
    report(
      page(run.allowed) === 'Success' && page(run.wallet) === 'Success' && page(run.vault) === 'Failed',
      `Run ${run.number}: allowed send ${page(run.allowed)}, normal wallet ${page(run.wallet)}, vault ${page(run.vault)}${reason ? ` ("${reason}")` : ''}`,
    )
  }
}

async function runTimes(ctx, times) {
  const { report, finish } = ensTools(ctx).reporter()
  const runs = []
  for (let i = 1; i <= times; i++) runs.push(await runOnce(ctx, i, report))
  const totals = runs.map((run) => run.total)
  console.log(`\n${totals.filter((ms) => ms < TARGET_MS).length} of ${times} runs under ${TARGET_MS / 1000} s. Slowest ${seconds(Math.max(...totals))} s, fastest ${seconds(Math.min(...totals))} s.`)
  if (live) await checkEtherscan(runs, report)
  await reset(ctx)
  finish()
}

async function tryAttacks(ctx, report, { sentences }) {
  console.log(`\nThe attacker console (9.2): every attack, with the phone page's own code`)
  await reset(ctx)
  const found = await scene(ctx)
  const { reader } = ctx.phone
  const usdc = (amount) => `${formatUnits(amount, found.decimals)} ${found.symbol}`
  for (const attack of ATTACKS) {
    const before = await readBalances(reader, found)
    const { hash } = await sendTry(ctx.phone, attackRequest(found, before, attack.id))
    const result = await resultOf(reader, hash)
    const after = await readBalances(reader, found)
    if (attack.expected === 'proposed') {
      report(result.ok, `${attack.title}: proposed, waiting for the owner's phone (${link(hash)})`)
      continue
    }
    report(
      !result.ok && result.reason === attack.expected && after.vault === before.vault,
      `${attack.title}: ${result.ok ? 'it went through' : `refused, "${result.reason}"`}, the vault still holds ${usdc(after.vault)} (${link(hash)})`,
    )
    if (attack.id === 'fakeRouter') {
      report(
        Boolean(found.routerName) && sameAddress(found.routerAddress, UNIVERSAL_ROUTER),
        `…ENS, read through the vault's directory: ${found.routerName ?? 'no router name'} → ${found.routerAddress ?? 'nothing'} (the real router), the thief's address isn't listed`,
      )
    }
  }
  if (!sentences) return
  const balances = await readBalances(reader, found)
  const ask = (sentence) => understand({ sentence, names: [found.contactName].filter(Boolean), tokens: [found.symbol], protocols: [], turns: [] })
  const fair = `send 1 ${found.symbol.toLowerCase()} to ${(found.contactName ?? 'my contact').toLowerCase()}`
  const answer = await ask(fair)
  const plan = planFor(sentenceVault(found, balances), answer.result)
  const clear = plan.sends.length === 1 && !plan.problems.length && !answer.result.questions.length
  report(clear, `Sentence "${fair}": understood as ${plan.sends.length} send(s), sealed ${answer.proof.verified ? '✓' : '✗'}, in ${(answer.latencyMs / 1000).toFixed(1)} s`)
  if (clear) {
    const { hash } = await sendTry(ctx.phone, sentenceRequest(found, plan))
    const result = await resultOf(reader, hash)
    report(result.ok, `…sent, and the standing rules allowed it: ${result.ok ? 'Success' : `refused, "${result.reason}"`} (${link(hash)})`)
    const said = saidFor(answer.result, plan.origins)
    const hacked = await resultOf(reader, (await sendTry(ctx.phone, sentenceRequest(found, plan, true))).hash)
    const why = hacked.failure ? explainRefusal(hacked.failure, sentenceVault(found, balances), plan.checks, said) : hacked.reason
    report(
      !hacked.ok && why.startsWith('You said “'),
      `…the same words through a hacked app that sends 1 ${found.symbol} more: ${hacked.ok ? 'it went through' : `refused, "${why}"`} (${link(hacked.hash)})`,
    )
  }
  const sneaky = 'send all my usdc to 0x000000000000000000000000000000000000dEaD'
  const refused = await ask(sneaky)
  report(
    refused.result.steps.length === 0 && refused.result.questions.length > 0,
    `Sentence "${sneaky}": nothing to send, it asked instead ("${refused.result.questions[0] ?? 'no question'}")`,
  )
}

async function attacksLive(ctx) {
  const { report, finish } = ensTools(ctx).reporter()
  await tryAttacks(ctx, report, { sentences: true })
  await reset(ctx)
  finish()
}

async function rehearse() {
  console.log('Rehearsal on a private local copy of Sepolia, with vault version 3. Nothing is sent to the real network.\n')
  const copy = await startLocalCopy()
  let ticker
  try {
    const base = connect(copy.url)
    ticker = setInterval(() => base.testClient.mine({ blocks: 1 }).catch(() => {}), REHEARSAL_BLOCK_MS)
    await base.testClient.setBalance({ address: base.builder.address, value: parseEther('10') })
    const deploy = async (label, { abi, bytecode }, args) => {
      const hash = await base.wallet(base.builder).deployContract({ abi, bytecode, args })
      const receipt = await base.publicClient.waitForTransactionReceipt({ hash })
      console.log(`  ✓ ${label}`)
      return receipt.contractAddress
    }
    const factoryArtifact = artifact('VaultFactory.sol', 'VaultFactory')
    const token = await base.publicClient.readContract({ address: FACTORY, abi: factoryArtifact.abi, functionName: 'watchedTokens', args: [0n] })
    await setupDirectory(base)
    const directory = await deploy('Deploy the EnsDirectory contract (version 3)', artifact('EnsDirectory.sol', 'EnsDirectory'), [UNIVERSAL_RESOLVER, VERIFIABLE_FACTORY, RESOLVER_IMPL, TRUSTED_NAMES])
    const factory = await deploy('Deploy the vault factory (version 3)', factoryArtifact, [[token], directory])
    const ctx = context(copy.url, factory)
    const pool = UNISWAP_V3_POOLS[1]
    const decimals = await base.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
    await base.testClient.impersonateAccount({ address: pool })
    await base.testClient.setBalance({ address: pool, value: parseEther('1') })
    const lent = await base.wallet(pool).writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [ctx.funder.address, parseUnits(REHEARSAL_USDC, decimals)] })
    await base.publicClient.waitForTransactionReceipt({ hash: lent })
    await base.testClient.stopImpersonatingAccount({ address: pool })
    console.log(`  ✓ On the local copy only: ${REHEARSAL_USDC} test USDC from a Uniswap pool to the main everyday key`)
    await setup(ctx)
    const { report, finish } = ensTools(ctx).reporter()
    const vault = await vaultOf(ctx)
    report(sameAddress(await ctx.publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'directory' }), directory), 'The demo vault is version 3: it reads the ENS directory')
    for (let i = 1; i <= REHEARSAL_RUNS; i++) await runOnce(ctx, i, report)
    await tryAttacks(ctx, report, { sentences: process.argv.includes('--sentences') })
    finish()
  } finally {
    clearInterval(ticker)
    if (process.argv.includes('--keep')) {
      console.log(`\nThe local copy is still running at ${copy.url}. Stop it with: kill ${copy.pid}`)
      copy.leave()
    } else {
      copy.stop()
    }
  }
}

function lanAddress() {
  const interfaces = networkInterfaces()
  const candidates = [...(interfaces.en0 ?? []), ...Object.values(interfaces).flat()]
  return candidates.find((net) => net?.family === 'IPv4' && !net.internal)?.address ?? null
}

function screen() {
  accountFor('DEMO_EVERYDAY_PRIVATE_KEY', MAKE_KEYS)
  const key = process.env.DEMO_EVERYDAY_PRIVATE_KEY
  const thief = accountFor('DEMO_THIEF_PRIVATE_KEY', MAKE_KEYS).address
  const address = lanAddress()
  if (!option('base') && !address) throw new Error("This laptop isn't on a network, so phones can't reach it. Join the Wi-Fi first.")
  const base = option('base') ?? `http://${address}:${option('port') ?? APP_PORT}/`
  const browser = option('browser')
  spawn('open', browser ? ['-a', browser, `${base}#side/${key}/${thief}`] : [`${base}#side/${key}/${thief}`], { stdio: 'ignore', detached: true }).unref()
  console.log(`Opened the side-by-side screen at ${base}#side/… The rest of the link holds the demo key, so it isn't shown here.`)
  console.log(`Short link for phones, to print or write on a card: ${base}api/go (it holds no key itself; the server sends the phone on)`)
  console.log('Keep both running: npm start in server/, and npm run demo in app/. Phones must be on the same Wi-Fi as this laptop.')
}

async function main() {
  const command = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'rehearse'
  if (command === 'keys') return makeKeys()
  if (command === 'screen') return screen()
  if (!live) {
    if (command !== 'rehearse') throw new Error('Without --live, the only commands are keys, screen and rehearse (the default)')
    return rehearse()
  }
  const ctx = context(process.env.SEPOLIA_RPC_URL, FACTORY)
  if (command === 'setup') return setup(ctx).then(() => status(ctx))
  if (command === 'reset') return reset(ctx).then(() => status(ctx))
  if (command === 'fresh') return fresh(ctx)
  if (command === 'status') return status(ctx)
  if (command === 'run') return runTimes(ctx, Number(option('times') ?? 5))
  if (command === 'attacks') return attacksLive(ctx)
  throw new Error('With --live, use setup, fresh, reset, status, run or attacks')
}

if (isMain(import.meta.url)) runMain(main)
