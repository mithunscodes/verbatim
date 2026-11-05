import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  encodeFunctionData,
  isAddress,
  maxUint256,
  parseUnits,
  zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  chain,
  DEMO_ALLOWED_SEND,
  DEMO_ATTACK_GAS,
  DEMO_PRIORITY_FEE,
  DEMO_PROPOSED_LIMIT,
  DEMO_RPC_PATH,
  DIRECTORY_NAMES,
  directoryAbi,
  FACTORY,
  factoryAbi,
  FORCED_GAS,
  NICKNAMES,
  UNIVERSAL_ROUTER,
  vaultAbi,
} from './config.js'
import { CheckKind } from './checks.js'
import { formatAmount, shortAddress } from './format.js'
import { ChangeKind } from './rules.js'
import { divertedSwapTransaction, explainFailure, fairSwapTransaction, hackedExtra, newDeadline, sendActions, swapActions } from './run.js'

const KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/

const POLL_MS = 1_000

const RECEIPT_TIMEOUT_MS = 180_000

const MAX_BLOCKS_PER_SCAN = 20n

const ALL_BPS = 10_000n

const TERRIBLE_PRICE_BPS = 9_000n

const MAX_CONTACTS = 10n

export class Refused extends Error {}

async function demoFees(reader) {
  const { baseFeePerGas } = await reader.getBlock()
  return { maxPriorityFeePerGas: DEMO_PRIORITY_FEE, maxFeePerGas: (baseFeePerGas ?? 0n) * 2n + DEMO_PRIORITY_FEE }
}

export function readDemoLink(text) {
  const [key, thief] = (text ?? '').split('/')
  if (!KEY_PATTERN.test(key ?? '') || !isAddress(thief ?? '')) return null
  return { key, everydayKey: privateKeyToAccount(key).address, thief: getAddress(thief) }
}

export function demoLink(base, key, thief) {
  return `${base}#attack/${key}/${thief}`
}

export function demoRpcUrl() {
  return new URL(DEMO_RPC_PATH, window.location.origin).href
}

export function demoClients(url, key) {
  const transport = http(url, { timeout: 30_000 })
  const account = key ? privateKeyToAccount(key) : null
  return {
    account,
    reader: createPublicClient({ chain, transport, batch: { multicall: true }, pollingInterval: POLL_MS }),
    signer: account ? createWalletClient({ chain, transport, account }) : null,
  }
}

export function sameAddress(a, b) {
  return Boolean(a && b) && a.toLowerCase() === b.toLowerCase()
}

async function contactAt(reader, vault, index) {
  try {
    return await reader.readContract({ address: vault, abi: vaultAbi, functionName: 'contacts', args: [index] })
  } catch (error) {
    if (error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError)) return null
    throw error
  }
}

async function savedContacts(reader, vault) {
  const found = []
  for (let i = 0n; i < MAX_CONTACTS; i++) {
    const contact = await contactAt(reader, vault, i)
    if (!contact) break
    found.push(contact)
  }
  return found
}

export async function findScene(reader, everydayKey, thief, factory = FACTORY) {
  const vault = await reader.readContract({ address: factory, abi: factoryAbi, functionName: 'vaultOf', args: [everydayKey] })
  if (vault === zeroAddress) return { everydayKey, thief, vault: null }
  const [token, contacts, setupFinished, looseningWait, keyInVault] = await Promise.all([
    reader.readContract({ address: vault, abi: vaultAbi, functionName: 'watchedTokens', args: [0n] }),
    savedContacts(reader, vault),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: 'setupFinished' }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: 'looseningWait' }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: 'everydayKey' }),
  ])
  const contact = contacts[0] ?? null
  const [symbol, decimals, dailyLimit] = await Promise.all([
    reader.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    reader.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: 'dailyLimit', args: [token] }),
  ])
  const contactName = Object.entries(NICKNAMES).find(([known]) => sameAddress(known, contact))?.[1] ?? null
  const directory = await reader.readContract({ address: vault, abi: vaultAbi, functionName: 'directory' }).catch(() => null)
  const routerName = DIRECTORY_NAMES.find((name) => name.startsWith('router.'))
  const routerAddress = directory && routerName
    ? await reader.readContract({ address: directory, abi: directoryAbi, functionName: 'addressOf', args: [routerName] }).catch(() => null)
    : null
  const listed = routerAddress && routerAddress !== zeroAddress
  return {
    everydayKey, thief, vault, token, symbol, decimals, contact, contactName, setupFinished, looseningWait,
    keyInVault, contacts, dailyLimit, directory, routerName: listed ? routerName : null, routerAddress: listed ? routerAddress : null,
  }
}

export async function readBalances(reader, scene) {
  const blockNumber = await reader.getBlockNumber({ cacheTime: 0 })
  const balanceOf = (account) =>
    reader.readContract({ address: scene.token, abi: erc20Abi, functionName: 'balanceOf', args: [account], blockNumber })
  const [wallet, vault, gas, thief] = await Promise.all([
    balanceOf(scene.everydayKey),
    balanceOf(scene.vault),
    reader.getBalance({ address: scene.everydayKey, blockNumber }),
    balanceOf(scene.thief),
  ])
  return { blockNumber, wallet, vault, gas, thief }
}

export function nameIn(scene, address) {
  if (!address) return 'nobody'
  if (sameAddress(address, scene.thief)) return scene.thiefName ?? 'the thief'
  if (sameAddress(address, scene.vault)) return 'the Verbatim vault'
  if (sameAddress(address, scene.everydayKey)) return 'the normal wallet'
  if (sameAddress(address, scene.contact)) return scene.contactName ? `${scene.contactName}, a saved contact` : 'a saved contact'
  return Object.entries(NICKNAMES).find(([known]) => sameAddress(known, address))?.[1] ?? shortAddress(address)
}

export function tokenAmount(scene, amount) {
  return `${formatAmount(amount, scene.decimals)} ${scene.symbol}`
}

export function allowedAmount(scene) {
  return parseUnits(DEMO_ALLOWED_SEND, scene.decimals)
}

function vaultRun(scene, to, amount) {
  return {
    address: scene.vault,
    abi: vaultAbi,
    functionName: 'run',
    args: [
      sendActions({ token: scene.token, amount, to }),
      [
        { kind: CheckKind.AtMostLeaves, token: scene.token, to: zeroAddress, amount },
        { kind: CheckKind.ExactlyTo, token: scene.token, to, amount },
      ],
      newDeadline(),
    ],
  }
}

export function allowedRequest(scene) {
  return vaultRun(scene, scene.contact, allowedAmount(scene))
}

export async function sendAllowed({ reader, signer }, scene) {
  const request = { ...vaultRun(scene, scene.contact, allowedAmount(scene)), account: signer.account }
  let gas
  try {
    gas = ((await reader.estimateContractGas(request)) * 12n) / 10n
  } catch (error) {
    const failure = explainFailure(error)
    if (failure.network) throw error
    throw new Refused(failure.reason)
  }
  return signer.writeContract({ ...request, gas, ...(await demoFees(reader)) })
}

export async function sendAttack({ reader, signer }, scene, balances) {
  const account = signer.account
  const steal = { address: scene.token, abi: erc20Abi, functionName: 'transfer', args: [scene.thief, balances.wallet], account }
  const [walletGas, nonce, fees] = await Promise.all([
    reader.estimateContractGas(steal),
    reader.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    demoFees(reader),
  ])
  const wallet = await signer.writeContract({ ...steal, gas: (walletGas * 12n) / 10n, nonce, ...fees })
  const vault = await signer.writeContract({
    ...vaultRun(scene, scene.thief, balances.vault),
    account,
    gas: FORCED_GAS,
    nonce: nonce + 1,
    ...fees,
  })
  return { wallet, vault, nonce }
}

async function refusal(reader, tx, blockNumber) {
  let call
  try {
    call = decodeFunctionData({ abi: vaultAbi, data: tx.input })
  } catch {
    return { reason: 'The network cancelled it.' }
  }
  try {
    await reader.simulateContract({
      address: tx.to,
      abi: vaultAbi,
      functionName: call.functionName,
      args: call.args,
      account: tx.from,
      blockNumber: blockNumber - 1n,
    })
  } catch (error) {
    return explainFailure(error)
  }
  return { reason: 'It failed, but replaying it gave no reason.' }
}

export async function refusalOf(reader, tx, blockNumber) {
  return (await refusal(reader, tx, blockNumber)).reason
}

function failureOf(reader, tx, receipt) {
  if (receipt.gasUsed >= tx.gas) return { reason: 'It ran out of gas.' }
  return refusal(reader, tx, receipt.blockNumber)
}

export async function resultOf(reader, hash) {
  const receipt = await reader.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS, pollingInterval: POLL_MS })
  const paid = { blockNumber: receipt.blockNumber, fee: receipt.gasUsed * receipt.effectiveGasPrice, payer: receipt.from }
  if (receipt.status === 'success') return { ok: true, hash, ...paid }
  const tx = await reader.getTransaction({ hash })
  const failure = await failureOf(reader, tx, receipt)
  return { ok: false, hash, ...paid, reason: failure.reason, failure }
}

export const ATTACKS = [
  { id: 'steal', short: 'Send it all to me', title: 'Send everything to my address', expected: 'Not a saved contact', rule: 'Money only goes to saved contacts' },
  { id: 'permission', short: 'Blank cheque', title: 'Give my address unlimited spending permission', expected: 'Permission for an untrusted contract', rule: 'No spending permission for untrusted contracts' },
  { id: 'takeover', short: 'Bybit takeover', title: 'Bybit-style takeover: run borrowed code in the vault', expected: 'Borrowed code would run in your account', rule: 'No borrowed code runs in the vault' },
  { id: 'swapToMe', short: 'Swap to me', title: 'Swap everything, and send the output to me', expected: 'Unfair trade', rule: 'A swap must pay the vault a fair price' },
  { id: 'badPrice', short: 'Rigged price', title: 'Swap everything at a terrible price (the vault gets 10%)', expected: 'Unfair trade', rule: 'A swap must pay the vault a fair price' },
  { id: 'fakeRouter', short: 'Fake Uniswap', title: 'Swap everything through my fake Uniswap router', expected: 'Not a trusted contract', rule: 'Only trusted contracts can be called' },
  { id: 'addContact', short: 'Add myself', title: 'Add my address to the saved contacts', expected: 'Only the rules key can save contacts', rule: 'Only the rules key can save contacts' },
  { id: 'loosen', short: 'Raise the limit', title: `Raise the daily limit to ${Number(DEMO_PROPOSED_LIMIT).toLocaleString('en-US')} USDC`, expected: 'proposed', rule: "Looser rules wait for the owner's phone" },
]

function runRequest(scene, actions, checks = []) {
  return { address: scene.vault, abi: vaultAbi, functionName: 'run', args: [actions, checks, newDeadline()] }
}

function atMostLeaves(scene, amount) {
  return [{ kind: CheckKind.AtMostLeaves, token: scene.token, to: zeroAddress, amount }]
}

function divertedSwap(scene, amount, bps) {
  const transaction = divertedSwapTransaction({ from: scene.token, amount, to: scene.thief, bps })
  return runRequest(scene, swapActions({ from: scene.token, amount, transaction }), atMostLeaves(scene, amount))
}

function fakeRouterSwap(scene, amount) {
  const actions = swapActions({ from: scene.token, amount, transaction: fairSwapTransaction({ from: scene.token, amount }) })
  const diverted = actions.map((action) => (sameAddress(action.target, UNIVERSAL_ROUTER) ? { ...action, target: scene.thief } : action))
  return runRequest(scene, diverted, atMostLeaves(scene, amount))
}

export function attackRequest(scene, balances, id) {
  const tokenCall = (functionName, args) => encodeFunctionData({ abi: erc20Abi, functionName, args })
  if (id === 'steal') return vaultRun(scene, scene.thief, balances.vault)
  if (id === 'permission') {
    return runRequest(scene, [{ target: scene.token, value: 0n, data: tokenCall('approve', [scene.thief, maxUint256]), operation: 0 }])
  }
  if (id === 'takeover') {
    return runRequest(scene, [{ target: scene.thief, value: 0n, data: tokenCall('transfer', [scene.thief, 0n]), operation: 1 }])
  }
  if (id === 'swapToMe') return divertedSwap(scene, balances.vault, ALL_BPS)
  if (id === 'badPrice') return divertedSwap(scene, balances.vault, TERRIBLE_PRICE_BPS)
  if (id === 'fakeRouter') return fakeRouterSwap(scene, balances.vault)
  if (id === 'addContact') return { address: scene.vault, abi: vaultAbi, functionName: 'saveContact', args: [scene.thief] }
  if (id === 'loosen') {
    return {
      address: scene.vault,
      abi: vaultAbi,
      functionName: 'propose',
      args: [ChangeKind.DailyLimit, zeroAddress, scene.token, parseUnits(DEMO_PROPOSED_LIMIT, scene.decimals)],
    }
  }
  throw new Error(`Unknown attack: ${id}`)
}

export function sentenceVault(scene, balances) {
  return {
    holdings: [{ token: scene.token, symbol: scene.symbol, decimals: scene.decimals, amount: balances.vault }],
    contacts: scene.contact ? [{ address: scene.contact, nickname: scene.contactName }] : [],
    names: {},
    fairPrice: null,
  }
}

export function sentenceRequest(scene, plan, hacked = false) {
  const actions = plan.sends.flatMap((send, i) => {
    const amount = hacked && i === 0 ? send.amount + hackedExtra(send.token, scene.decimals) : send.amount
    return sendActions({ ...send, amount })
  })
  return runRequest(scene, actions, plan.checks)
}

export async function sendTry({ reader, signer }, request) {
  const account = signer.account
  let gas = DEMO_ATTACK_GAS
  let predicted = null
  try {
    gas = ((await reader.estimateContractGas({ ...request, account })) * 12n) / 10n
  } catch (error) {
    const failure = explainFailure(error)
    if (failure.network) throw error
    predicted = failure.reason
  }
  const [nonce, fees] = await Promise.all([
    reader.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    demoFees(reader),
  ])
  const hash = await signer.writeContract({ ...request, account, gas, nonce, ...fees })
  return { hash, predicted, nonce }
}

export function checkWords(scene, check) {
  const amount = tokenAmount(scene, check.amount)
  if (check.kind === CheckKind.AtMostLeaves) return `at most ${amount} leaves`
  if (check.kind === CheckKind.AtLeastArrives) return `at least ${amount} arrives`
  return `exactly ${amount} to ${nameIn(scene, check.to)}`
}

export function requestWords(scene, request) {
  if (sameAddress(request.address, scene.token)) {
    const [to, amount] = request.args
    return { call: `${scene.symbol}.${request.functionName}`, what: sent(scene, to, amount).what, checks: null }
  }
  const checks = request.functionName === 'run' ? request.args[1].map((check) => checkWords(scene, check)) : null
  return { call: `vault.${request.functionName}`, what: vaultWords(scene, request.functionName, request.args).what, checks }
}

function sent(scene, to, amount) {
  const words = `${tokenAmount(scene, amount)} to ${nameIn(scene, to)}`
  return { to, amount, what: `send ${words}`, done: `Sent ${words}` }
}

function runWords(scene, actions) {
  const action = actions[0]
  if (!action) return { what: 'run nothing', done: 'Ran nothing' }
  if (action.operation !== 0) return { what: 'run borrowed code in the vault, like the Bybit attack', done: 'Ran borrowed code' }
  const fake = actions.find((a) => sameAddress(a.target, scene.thief) && a.data && a.data !== '0x')
  if (fake && sameAddress(action.target, scene.token)) {
    const [, amount] = decodeFunctionData({ abi: erc20Abi, data: action.data }).args
    return { what: `swap ${tokenAmount(scene, amount)} through the thief's fake Uniswap router`, done: `Swapped ${tokenAmount(scene, amount)} through the thief's fake router` }
  }
  const router = actions.find((a) => sameAddress(a.target, UNIVERSAL_ROUTER))
  if (router && sameAddress(action.target, scene.token)) {
    const [, amount] = decodeFunctionData({ abi: erc20Abi, data: action.data }).args
    return { what: `swap ${tokenAmount(scene, amount)} through Uniswap`, done: `Swapped ${tokenAmount(scene, amount)} through Uniswap` }
  }
  if (sameAddress(action.target, scene.token)) {
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: action.data })
    if (functionName === 'transfer') return sent(scene, args[0], args[1])
    if (functionName === 'approve') {
      return { what: `give ${nameIn(scene, args[0])} permission to spend ${scene.symbol}`, done: `Gave ${nameIn(scene, args[0])} permission to spend ${scene.symbol}` }
    }
  }
  return { what: `call ${nameIn(scene, action.target)}`, done: `Called ${nameIn(scene, action.target)}` }
}

function vaultWords(scene, functionName, args) {
  if (functionName === 'run') return runWords(scene, args[0])
  if (functionName === 'saveContact') {
    return { what: `save ${nameIn(scene, args[0])} as a contact`, done: `Saved ${nameIn(scene, args[0])} as a contact` }
  }
  if (functionName === 'propose' && Number(args[0]) === ChangeKind.DailyLimit && sameAddress(args[2], scene.token)) {
    const words = `a daily limit of ${tokenAmount(scene, args[3])}`
    return { what: `propose ${words}`, done: `Proposed ${words}. It waits for the owner's phone`, waiting: true }
  }
  return { what: `call ${functionName}`, done: `Called ${functionName}` }
}

function sentBy(scene, tx) {
  try {
    if (sameAddress(tx.to, scene.token)) {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.input })
      if (functionName === 'transfer') return sent(scene, args[0], args[1])
      return { what: `call ${functionName} on ${scene.symbol}`, done: `Called ${functionName} on ${scene.symbol}` }
    }
    if (sameAddress(tx.to, scene.vault)) {
      const { functionName, args } = decodeFunctionData({ abi: vaultAbi, data: tx.input })
      return vaultWords(scene, functionName, args)
    }
  } catch {
    return { what: 'make an unknown call', done: 'Made an unknown call' }
  }
  return { what: `send a transaction to ${nameIn(scene, tx.to)}`, done: `Sent a transaction to ${nameIn(scene, tx.to)}` }
}

export function describeTx(scene, tx) {
  return { hash: tx.hash, side: sameAddress(tx.to, scene.vault) ? 'vault' : 'wallet', ...sentBy(scene, tx) }
}

export function nextScan(scanned, latest) {
  if (latest <= scanned) return null
  const from = latest - scanned > MAX_BLOCKS_PER_SCAN ? latest - MAX_BLOCKS_PER_SCAN + 1n : scanned + 1n
  return { from, to: latest }
}

export async function findTxs(reader, scene, { from, to }) {
  const numbers = []
  for (let n = from; n <= to; n++) numbers.push(n)
  const blocks = await Promise.all(numbers.map((blockNumber) => reader.getBlock({ blockNumber, includeTransactions: true })))
  const sent = blocks.flatMap((block) => block.transactions.filter((tx) => sameAddress(tx.from, scene.everydayKey)))
  return Promise.all(sent.map(async (tx) => {
    const receipt = await reader.getTransactionReceipt({ hash: tx.hash })
    const entry = { ...describeTx(scene, tx), blockNumber: receipt.blockNumber, ok: receipt.status === 'success' }
    return entry.ok ? entry : { ...entry, reason: (await failureOf(reader, tx, receipt)).reason }
  }))
}
