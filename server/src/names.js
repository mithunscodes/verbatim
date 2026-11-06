import { randomUUID } from 'node:crypto'
import {
  BaseError,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
  WaitForTransactionReceiptTimeoutError,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { NAME_MAX_WAITING, NAME_PREFIX, REPLAY_BUILDER_FLOOR, REPLAY_KEEP_MS, REPLAY_POLL_MS, VAULT_FACTORY } from './config.js'
import { inBuilderLine } from './replay-jobs.js'
import { RequestError } from './uniswap.js'
import { ETH_REGISTRAR, ETH_REGISTRY, ensTools, registrarAbi, registryAbi } from '../scripts/ens.js'
import { setupName } from '../scripts/yourname.js'

const vaultAbi = parseAbi(['function everydayKey() view returns (address)', 'function rulesKey() view returns (address)'])
const factoryAbi = parseAbi(['function vaultOf(address everydayKey) view returns (address)'])
const ACTIVE = ['waiting', 'running']
const MAX_NUMBER = 10_000
const jobs = new Map()

const clock = () => new Date().toLocaleTimeString('en-GB')

function sepoliaContext() {
  if (!process.env.SEPOLIA_RPC_URL) throw new RequestError("SEPOLIA_RPC_URL is missing from .env, so names can't be made.", 503)
  if (!process.env.BUILDER_PRIVATE_KEY) throw new RequestError('BUILDER_PRIVATE_KEY is missing from .env. It pays for making names.', 503)
  const transport = http(process.env.SEPOLIA_RPC_URL, { timeout: 60_000 })
  return {
    publicClient: createPublicClient({ chain: sepolia, transport, pollingInterval: REPLAY_POLL_MS }),
    testClient: null,
    wallet: (account) => createWalletClient({ account, chain: sepolia, transport }),
    builder: privateKeyToAccount(process.env.BUILDER_PRIVATE_KEY),
  }
}

function explain(error) {
  if (!(error instanceof BaseError)) return error.constructor === Error ? error.message : 'Making the name failed on Sepolia. The server log has the details.'
  if (error.walk((cause) => cause instanceof InsufficientFundsError)) return 'The Builder key ran out of test ETH. The team tops it up from a faucet.'
  if (error.walk((cause) => cause instanceof WaitForTransactionReceiptTimeoutError)) return "Sepolia is very busy: a transaction hasn't landed. Try again later."
  if (error.walk((cause) => cause instanceof HttpRequestError || cause instanceof TimeoutError)) return "Couldn't reach Sepolia's node. Check the internet connection, then try again."
  return 'Making the name failed on Sepolia. The server log has the details.'
}

function view(job) {
  return { id: job.id, name: job.name, status: job.status, steps: job.steps, result: job.result, error: job.error }
}

function prune(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (job.finished && now - job.finished > REPLAY_KEEP_MS) jobs.delete(id)
  }
}

async function scan(ctx, vault, rulesKey) {
  const { read, lookup } = ensTools(ctx)
  for (let n = 1; n <= MAX_NUMBER; n++) {
    const label = `${NAME_PREFIX}${n}`
    if (await read(ETH_REGISTRAR, registrarAbi, 'isAvailable', [label])) return { free: label }
    if (getAddress(await read(ETH_REGISTRY, registryAbi, 'findOwner', [label])) !== getAddress(rulesKey)) continue
    const { record } = await lookup(`${label}.eth`).catch(() => ({ record: null }))
    if (record && getAddress(record) === vault) return { own: label }
  }
  throw new Error(`Every name from ${NAME_PREFIX}1 to ${NAME_PREFIX}${MAX_NUMBER} is taken.`)
}

async function work(job, ctx, rulesKey, hide) {
  const note = (text) => console.log(hide(`${clock()} name for ${job.vault}: ${text}`))
  try {
    job.status = 'running'
    if ((await ctx.publicClient.getBalance({ address: ctx.builder.address })) < REPLAY_BUILDER_FLOOR) {
      throw new Error('Making names is paused: the test ETH that pays for it is running low. The team tops it up from a faucet.')
    }
    const label = job.retry ?? await scan(ctx, job.vault, rulesKey).then(({ free, own }) => own ?? free)
    job.name = `${label}.eth`
    const onStep = (text, tx = null) => job.steps.push({ label: text, tx })
    const { name, resolver, registry } = await setupName({ ...ctx, onStep }, { label, vault: job.vault, contacts: [] })
    job.result = { name, resolver, registry }
    job.status = 'done'
    note(`${name} done on Sepolia with ${job.steps.filter((step) => step.tx).length} transactions`)
  } catch (error) {
    job.status = 'failed'
    job.error = explain(error)
    console.error(hide(`${clock()} name for ${job.vault}: ${error.stack ?? error}`))
  } finally {
    job.finished = Date.now()
  }
}

export async function startName(body, { hide = String } = {}) {
  if (!isAddress(body?.vault ?? '')) throw new RequestError("That isn't a vault address.")
  const vault = getAddress(body.vault)
  prune()
  const same = [...jobs.values()].find((job) => job.vault === vault && (ACTIVE.includes(job.status) || job.status === 'done'))
  if (same) return view(same)
  if ([...jobs.values()].filter((job) => ACTIVE.includes(job.status)).length >= NAME_MAX_WAITING) {
    throw new RequestError('Names are busy right now. Try again in a minute.', 429)
  }
  const ctx = sepoliaContext()
  const { read, hasCode, predictResolver } = ensTools(ctx)
  const [everydayKey, rulesKey] = await Promise.all([read(vault, vaultAbi, 'everydayKey'), read(vault, vaultAbi, 'rulesKey')])
    .catch(() => { throw new RequestError("That isn't a Verbatim vault.") })
  if (getAddress(await read(VAULT_FACTORY, factoryAbi, 'vaultOf', [everydayKey])) !== vault) {
    throw new RequestError("That vault wasn't made by Verbatim's factory.")
  }
  const { own } = await scan(ctx, vault, rulesKey)
  if (own) return { id: null, name: `${own}.eth`, status: 'done', steps: [] }
  const failed = [...jobs.values()].reverse().find((job) => job.vault === vault && job.status === 'failed' && job.name)
  const retry = failed ? failed.name.slice(0, -'.eth'.length) : null
  if (!retry && await hasCode(await predictResolver(vault))) throw new RequestError('This vault already has a different name.', 409)
  const job = { id: randomUUID(), name: retry ? `${retry}.eth` : null, retry, vault, status: 'waiting', steps: [] }
  jobs.set(job.id, job)
  inBuilderLine(() => work(job, ctx, rulesKey, hide))
  return view(job)
}

export function nameStatus(id) {
  const job = jobs.get(id)
  if (!job) throw new RequestError('This name job has expired. Start it again.', 404)
  return view(job)
}
