import { randomUUID } from 'node:crypto'
import {
  BaseError,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
  WaitForTransactionReceiptTimeoutError,
  createPublicClient,
  createWalletClient,
  http,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { REPLAY_BUILDER_FLOOR, REPLAY_KEEP_MS, REPLAY_MAX_WAITING, REPLAY_POLL_MS, SEPOLIA_EXPLORER } from './config.js'
import { AAVE, BYBIT } from './replays.js'
import {
  HOOK,
  PRINT,
  prepareBybit,
  preparePrint,
  printInput,
  replayAccounts,
  resetAave,
  resetHook,
  runAave,
  runBybit,
  runHook,
  runPrint,
  topUpFees,
} from './sepolia-replays.js'
import { RequestError } from './uniswap.js'

const REPLAYS = {
  bybit: { ready: prepareBybit, run: runBybit, facts: BYBIT },
  aave: { ready: resetAave, run: runAave, facts: AAVE },
  hook: { ready: resetHook, run: runHook, facts: HOOK },
  print: { ready: preparePrint, run: runPrint, facts: PRINT, input: printInput },
}
const ACTIVE = ['waiting', 'preparing', 'running']
const jobs = new Map()
let line = Promise.resolve()
let order = 0
let clearing = null

const clock = () => new Date().toLocaleTimeString('en-GB')

function sepoliaContext() {
  if (!process.env.SEPOLIA_RPC_URL) throw new Error("SEPOLIA_RPC_URL is missing from .env, so the replays can't reach Sepolia.")
  if (!process.env.BUILDER_PRIVATE_KEY) throw new Error('BUILDER_PRIVATE_KEY is missing from .env. It pays for the live replays.')
  const transport = http(process.env.SEPOLIA_RPC_URL, { timeout: 60_000 })
  return {
    publicClient: createPublicClient({ chain: sepolia, transport, pollingInterval: REPLAY_POLL_MS }),
    wallet: (account) => createWalletClient({ account, chain: sepolia, transport }),
    builder: privateKeyToAccount(process.env.BUILDER_PRIVATE_KEY),
  }
}

function explain(error) {
  if (!(error instanceof BaseError)) return error.constructor === Error ? error.message : 'The replay failed on Sepolia. The server log has the details.'
  if (error.walk((cause) => cause instanceof InsufficientFundsError)) return 'A replay key ran out of test ETH for fees. Try again in a minute: the server tops it up first.'
  if (error.walk((cause) => cause instanceof WaitForTransactionReceiptTimeoutError)) return "Sepolia is very busy: a transaction hasn't landed after 9 minutes. Nothing is lost. Try again later."
  if (error.walk((cause) => cause instanceof HttpRequestError || cause instanceof TimeoutError)) return "Couldn't reach Sepolia's node. Check the internet connection, then try again."
  return 'The replay failed on Sepolia. The server log has the details.'
}

function view(job) {
  const ahead = job.status === 'waiting' ? [...jobs.values()].filter((other) => ACTIVE.includes(other.status) && other.order < job.order).length : 0
  return { id: job.id, name: job.name, status: job.status, ahead, clearing: job.status === 'waiting' ? clearing : null, facts: job.facts, result: job.result, error: job.error }
}

function prune(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (job.finished && now - job.finished > REPLAY_KEEP_MS) jobs.delete(id)
  }
}

async function work(job, replay, hide) {
  const note = (text) => console.log(hide(`${clock()} replay ${job.name}: ${text}`))
  const step = (label, receipt) => note(`${label} (${SEPOLIA_EXPLORER}/tx/${receipt.transactionHash})`)
  let ctx
  let accounts
  try {
    job.status = 'preparing'
    ctx = sepoliaContext()
    accounts = replayAccounts()
    const left = await ctx.publicClient.getBalance({ address: ctx.builder.address })
    if (left < REPLAY_BUILDER_FLOOR) {
      throw new Error('The replays are paused: the test ETH that pays for them is running low. The team tops it up from a faucet.')
    }
    await topUpFees(ctx, accounts, step)
    await replay.ready(ctx, accounts, step)
    job.status = 'running'
    job.result = await replay.run(ctx, accounts, job.input)
    job.status = 'done'
    note(`done on Sepolia in ${(job.result.ms / 1000).toFixed(1)} s`)
  } catch (error) {
    job.status = 'failed'
    job.error = explain(error)
    console.error(hide(`${clock()} replay ${job.name}: ${error.stack ?? error}`))
  } finally {
    job.finished = Date.now()
  }
  if (job.status !== 'done') return
  clearing = job.name
  try {
    await replay.ready(ctx, accounts, step)
    note('ready for the next run')
  } catch (error) {
    console.error(hide(`${clock()} replay ${job.name}, getting ready for the next run: ${error.stack ?? error}`))
  } finally {
    clearing = null
  }
}

export function startReplay(body, { hide = String } = {}) {
  const replay = REPLAYS[body?.name]
  if (!replay) throw new RequestError('Choose the bybit, aave, hook or print replay.')
  const input = replay.input ? replay.input(body) : null
  if (replay.input && !input) throw new RequestError('Make the image first: the print needs its 0G Storage root.')
  prune()
  const waiting = [...jobs.values()].filter((job) => job.status === 'waiting').length
  if (waiting >= REPLAY_MAX_WAITING) throw new RequestError('Sepolia replays are busy right now. Try again in a minute.', 429)
  const job = { id: randomUUID(), name: body.name, order: order++, status: 'waiting', facts: replay.facts, input }
  jobs.set(job.id, job)
  line = line.then(() => work(job, replay, hide))
  return view(job)
}

export function replayStatus(id) {
  const job = jobs.get(id)
  if (!job) throw new RequestError('This replay has expired. Run it again.', 404)
  return view(job)
}
