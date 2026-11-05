import {
  createPublicClient,
  createWalletClient,
  ENTITY_EVENTS_ABI,
  ExpirationTime,
  jsonToPayload,
  NoEntityFoundError,
} from '@arkiv-network/sdk'
import { addr, bytes32, key, u64 } from '@arkiv-network/sdk/attr'
import { tiramisu } from '@arkiv-network/sdk/chains'
import { eq, gt, lte } from '@arkiv-network/sdk/query'
import { custom, formatEther, formatGwei, formatUnits, getAddress, http, isAddressEqual, webSocket } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { EXPLORER, FACTORY } from '../../app/src/config.js'
import { attackRequest, demoClients, findScene, readBalances, refusalOf, sendTry } from '../../app/src/demo.js'

const ARKIV_ADDRESS = '0x4400000000000000000000000000000000000044'
const ARKIV_EXPLORER = 'https://tiramisu.explorer.arkiv.network'
const PROJECT = 'verbatim'
const RECORD_TYPE = 'refusal'
const TEST_MINUTES = 2
const SEPOLIA_CHAIN_ID = 11155111
const SEPOLIA_POLL_MS = 2_000
const MAX_REASON_CHARS = 100
const KEY_NAME = 'ARKIV_TEST_PRIVATE_KEY'
const CREATED_EVENT = ENTITY_EVENTS_ABI.find((item) => item.type === 'event' && item.name === 'EntityCreated')

const secrets = [
  process.env.ARKIV_TEST_PRIVATE_KEY,
  process.env.DEMO_EVERYDAY_PRIVATE_KEY,
  process.env.DEMO_THIEF_PRIVATE_KEY,
  process.env.ETHERSCAN_API_KEY,
  process.env.SEPOLIA_RPC_URL,
  process.env.SEPOLIA_RPC_URL?.split('/').pop(),
].filter(Boolean)
const redact = (text) => secrets.reduce((result, secret) => result.split(secret).join('[hidden]'), String(text))
const short = (error) => redact(error?.shortMessage ?? error?.message ?? error).split('\n')[0]

const reader = createPublicClient({ chain: tiramisu, transport: http(undefined, { retryCount: 0, timeout: 15_000 }) })
const socketReader = () => createPublicClient({ chain: tiramisu, transport: webSocket() })

const now = () => Date.now()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const seconds = (ms) => (ms / 1000).toFixed(2)
const glm = (wei) => `${formatEther(wei)} GLM`
const option = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at > 0 ? process.argv[at + 1] : undefined
}

function testAccount() {
  const value = process.env[KEY_NAME]
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? '')) throw new Error(`${KEY_NAME} is missing from .env`)
  return privateKeyToAccount(value)
}

function arkivWallet(account) {
  return createWalletClient({ account, chain: tiramisu, pollingInterval: 1_000, transport: http(undefined, { retryCount: 0, timeout: 30_000 }) })
}

function spread(values) {
  if (values.length === 0) return 'no samples'
  const sorted = [...values].sort((a, b) => a - b)
  const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]
  return `${sorted.length} samples: median ${seconds(at(0.5))} s, 90% within ${seconds(at(0.9))} s, fastest ${seconds(sorted[0])} s, slowest ${seconds(sorted.at(-1))} s`
}

function followHeads(client) {
  const heads = new Map()
  const stop = client.watchBlocks({
    onBlock: (block) => {
      if (!heads.has(block.number)) heads.set(block.number, { arrived: now(), timestamp: Number(block.timestamp) * 1000 })
    },
    onError: (error) => console.log(`  Block feed error: ${short(error)}`),
  })
  return { heads, stop }
}

async function waitFor(check, timeoutMs, stepMs = 250) {
  const until = now() + timeoutMs
  while (now() < until) {
    const value = await check()
    if (value) return value
    await sleep(stepMs)
  }
  return null
}

async function stillLive(entityKey) {
  try {
    await reader.getEntity(entityKey)
    return true
  } catch (error) {
    if (error instanceof NoEntityFoundError) return false
    throw error
  }
}

async function liveAt(entityKey, blockNumber) {
  try {
    const page = await reader.select({ key: true }).where(eq('$key', key(entityKey))).atBlock(blockNumber).limit(1).fetch()
    return page.entities.length === 1 ? 'live' : 'gone'
  } catch (error) {
    return `unknown (${short(error)})`
  }
}

async function info() {
  const account = testAccount()
  const [chainId, head, timing, gasPrice, balance, liveCount] = await Promise.all([
    reader.getChainId(),
    reader.getBlockNumber({ cacheTime: 0 }),
    reader.getBlockTiming(),
    reader.getGasPrice(),
    reader.getBalance({ address: account.address }),
    reader.getEntityCount(),
  ])
  console.log(`Network: ${tiramisu.name}, chain ID ${chainId}`)
  console.log(`Latest block: ${head} (the node says ${timing.blockDuration} s a block)`)
  console.log(`Gas price: ${formatGwei(gasPrice)} gwei`)
  console.log(`Live Arkiv records on the whole network: ${liveCount}`)
  console.log(`Test address: ${account.address}`)
  console.log(`Test balance: ${glm(balance)}`)
}

async function watch() {
  const durationMs = Number(process.argv[3] ?? 120) * 1000
  const overHttp = process.argv.includes('--http')
  const socket = socketReader()
  const { heads, stop: stopHeads } = followHeads(socket)
  const events = []
  const stopEvents = (overHttp ? reader : socket).watchEntityEvents({
    onEvent: (event) => events.push({ ...event, arrived: now() }),
    onError: (error) => console.log(`  Event feed error: ${short(error)}`),
  })
  console.log(`Watching every Arkiv event on Tiramisu for ${durationMs / 1000} s, over ${overHttp ? 'HTTP (the SDK polls)' : 'a WebSocket (the node pushes)'}...`)
  await sleep(durationMs)
  stopEvents()
  stopHeads()
  const byType = Object.groupBy(events, (event) => event.type)
  console.log(`\nEvents: ${events.length} in ${heads.size} new blocks`)
  for (const [type, list] of Object.entries(byType)) console.log(`  ${type}: ${list.length}`)
  const writers = new Set(events.filter((event) => event.type === 'EntityCreated').map((event) => event.owner.toLowerCase()))
  console.log(`Different writers creating records: ${writers.size}`)
  const timed = events.filter((event) => heads.has(event.blockNumber))
  console.log(`Event arrival after the block's own timestamp: ${spread(timed.map((event) => event.arrived - heads.get(event.blockNumber).timestamp))}`)
  console.log(`Event arrival after the same block's new-head message: ${spread(timed.map((event) => event.arrived - heads.get(event.blockNumber).arrived))}`)
  const gaps = [...heads.values()].map((head) => head.timestamp).sort((a, b) => a - b).map((t, i, all) => (i ? t - all[i - 1] : null)).filter((gap) => gap !== null)
  console.log(`Time between blocks: ${spread(gaps)}`)
}

async function expiry() {
  const windowBlocks = BigInt(process.argv[3] ?? 90)
  const head = await reader.getBlockNumber({ cacheTime: 0 })
  const page = await reader
    .select({ key: true, owner: true, creator: true, expiresAt: true, createdAt: true, creationFlags: true })
    .where(gt('$expiresAt', u64(head)), lte('$expiresAt', u64(head + windowBlocks)))
    .atBlock(head)
    .limit(200)
    .fetch()
  const tracked = page.entities.sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : 1)).slice(0, 12)
  console.log(`Block ${head}: ${page.entities.length}${page.hasNextPage() ? '+' : ''} other builders' records expire in the next ${windowBlocks} blocks. Following ${tracked.length}.`)
  if (tracked.length === 0) return
  const watched = new Map(tracked.map((entity) => [entity.key, { entity, expiresAt: entity.expiresAt, events: [], goneAt: null }]))
  const socket = socketReader()
  const { heads, stop: stopHeads } = followHeads(socket)
  const stopEvents = socket.watchEntityEvents({
    onEvent: (event) => {
      const entry = watched.get(event.entityKey)
      if (!entry) return
      entry.events.push({ type: event.type, block: event.blockNumber, arrived: now() })
      if (event.type === 'ExpiryExtended') entry.expiresAt = event.expiresAt
    },
    onError: (error) => console.log(`  Event feed error: ${short(error)}`),
  })
  const last = () => [...watched.values()].reduce((max, entry) => (entry.expiresAt > max ? entry.expiresAt : max), 0n)
  const deadline = now() + Number(windowBlocks) * 2_000 + 90_000
  let checked = head
  while (now() < deadline) {
    const current = await reader.getBlockNumber({ cacheTime: 0 })
    if (current !== checked) {
      checked = current
      for (const [entityKey, entry] of watched) {
        if (entry.goneAt !== null || current < entry.expiresAt - 1n) continue
        if (!(await stillLive(entityKey))) entry.goneAt = { block: current, at: now() }
      }
      if (current > last() + 3n && [...watched.values()].every((entry) => entry.goneAt !== null)) break
    }
    await sleep(500)
  }
  stopEvents()
  stopHeads()
  const fromBlock = tracked[0].expiresAt - 2n
  const logs = await reader.getLogs({ address: ARKIV_ADDRESS, fromBlock, toBlock: last() + 2n })
  console.log('')
  for (const [entityKey, entry] of watched) {
    const mentions = logs.filter((log) => log.topics[1]?.toLowerCase() === entityKey.toLowerCase())
    const [before, at] = await Promise.all([liveAt(entityKey, entry.expiresAt - 1n), liveAt(entityKey, entry.expiresAt)])
    const expiryHead = heads.get(entry.expiresAt)
    const disappeared = entry.goneAt
      ? `gone when the head was ${entry.goneAt.block}${expiryHead ? `, ${seconds(entry.goneAt.at - expiryHead.arrived)} s after block ${entry.expiresAt} arrived` : ''}`
      : 'never seen gone'
    console.log(`${entityKey.slice(0, 10)}… expires at block ${entry.expiresAt}: ${disappeared}`)
    console.log(`  live events about it: ${entry.events.length ? entry.events.map((event) => `${event.type} (block ${event.block})`).join(', ') : 'none'}`)
    console.log(`  raw logs naming it around its expiry: ${mentions.length}`)
    console.log(`  search at block ${entry.expiresAt - 1n}: ${before}; at block ${entry.expiresAt}: ${at}`)
  }
}

function clip(text) {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text
}

function recordFor(refusal, lifetime) {
  return {
    payload: jsonToPayload({
      kind: RECORD_TYPE,
      chainId: SEPOLIA_CHAIN_ID,
      vault: refusal.vault,
      tx: refusal.hash,
      block: refusal.blockNumber.toString(),
      from: refusal.from,
      reason: refusal.reason,
      explorer: `${EXPLORER}/tx/${refusal.hash}`,
    }),
    contentType: 'application/json',
    attributes: {
      project: PROJECT,
      entity_type: RECORD_TYPE,
      vault: addr(refusal.vault),
      sepolia_tx: bytes32(refusal.hash),
      sepolia_block: u64(refusal.blockNumber),
      reason: clip(refusal.reason),
      seen_at: u64(refusal.seenAt),
    },
    expires: lifetime,
    flags: { readonly: true, permissionlessExtension: false },
  }
}

async function sepolia() {
  if (!process.env.SEPOLIA_RPC_URL) throw new Error('SEPOLIA_RPC_URL is missing from .env')
  const everyday = privateKeyToAccount(process.env.DEMO_EVERYDAY_PRIVATE_KEY)
  const thief = privateKeyToAccount(process.env.DEMO_THIEF_PRIVATE_KEY)
  const clients = demoClients(process.env.SEPOLIA_RPC_URL, process.env.DEMO_EVERYDAY_PRIVATE_KEY)
  const scene = await findScene(clients.reader, everyday.address, thief.address, FACTORY)
  if (!scene.vault) throw new Error('The demo vault was not found. Run the side-by-side setup first.')
  return { ...clients, scene }
}

async function refusalFrom(sepoliaReader, hash, seenAt = now()) {
  const [tx, receipt] = await Promise.all([sepoliaReader.getTransaction({ hash }), sepoliaReader.getTransactionReceipt({ hash })])
  if (receipt.status === 'success') return null
  const reason = receipt.gasUsed >= tx.gas ? 'It ran out of gas.' : await refusalOf(sepoliaReader, tx, receipt.blockNumber)
  return { hash, vault: getAddress(tx.to), from: getAddress(tx.from), blockNumber: receipt.blockNumber, reason, seenAt }
}

async function pastRefusalHashes(vault, count) {
  if (!process.env.ETHERSCAN_API_KEY) throw new Error('ETHERSCAN_API_KEY is missing from .env')
  const url = new URL('https://api.etherscan.io/v2/api')
  url.search = new URLSearchParams({
    chainid: String(SEPOLIA_CHAIN_ID),
    module: 'account',
    action: 'txlist',
    address: vault,
    sort: 'desc',
    page: '1',
    offset: '100',
    apikey: process.env.ETHERSCAN_API_KEY,
  }).toString()
  const body = await (await fetch(url)).json()
  if (body.status !== '1') throw new Error(`Etherscan: ${body.message} ${typeof body.result === 'string' ? redact(body.result) : ''}`)
  return body.result
    .filter((tx) => tx.isError === '1' && tx.to && isAddressEqual(tx.to, vault))
    .slice(0, count)
    .map((tx) => tx.hash)
}

async function refusals() {
  const count = Number(process.argv[3] ?? 5)
  const { reader: sepoliaReader, scene } = await sepolia()
  console.log(`Demo vault: ${scene.vault}`)
  const hashes = await pastRefusalHashes(scene.vault, count)
  console.log(`Its last ${hashes.length} refused transactions, as the watcher would record them:`)
  for (const hash of hashes) {
    const refusal = await refusalFrom(sepoliaReader, hash)
    const record = recordFor(refusal, ExpirationTime.fromMinutes(TEST_MINUTES))
    console.log(`  block ${refusal.blockNumber}: "${refusal.reason}" (${EXPLORER}/tx/${hash})`)
    console.log(`    payload ${record.payload.length} bytes, ${Object.keys(record.attributes).length} attributes`)
  }
}

async function estimateGasFor(account, parameters, from) {
  let captured = null
  const stop = new Error('Dry run: stopped before signing')
  const transport = custom({
    async request({ method, params }) {
      if (method === 'eth_sendRawTransaction' || method === 'eth_sendTransaction') throw new Error('Dry run: sending is blocked')
      if (method === 'eth_estimateGas') {
        captured = params[0]
        throw stop
      }
      return reader.request({ method, params })
    },
  }, { retryCount: 0 })
  const wallet = createWalletClient({ account, chain: tiramisu, transport })
  try {
    await wallet.createEntity(parameters)
  } catch (error) {
    if (!captured) throw error
  }
  const call = { from: from ?? account.address, to: captured.to, data: captured.data, value: captured.value ?? '0x0' }
  const gas = BigInt(await reader.request({ method: 'eth_estimateGas', params: [call] }))
  return { gas, bytes: (captured.data.length - 2) / 2 }
}

async function estimate() {
  const account = testAccount()
  const from = option('from')
  const { reader: sepoliaReader, scene } = await sepolia()
  const [hash] = process.argv[3]?.startsWith('0x') ? [process.argv[3]] : await pastRefusalHashes(scene.vault, 1)
  const refusal = await refusalFrom(sepoliaReader, hash)
  const gasPrice = await reader.getGasPrice()
  console.log(`Refusal used: "${refusal.reason}" (${EXPLORER}/tx/${hash})`)
  console.log(`Estimated from ${from ?? `the test address ${account.address}`}, at today's gas price of ${formatGwei(gasPrice)} gwei. Nothing is sent.`)
  const lifetimes = [
    ['2 minutes', ExpirationTime.fromMinutes(2)],
    ['1 day', ExpirationTime.fromDays(1)],
    ['30 days', ExpirationTime.fromDays(30)],
    ['1 year', ExpirationTime.fromDays(365)],
  ]
  for (const [label, lifetime] of lifetimes) {
    try {
      const { gas, bytes } = await estimateGasFor(account, recordFor(refusal, lifetime), from)
      console.log(`  ${label}: ${gas} gas, ${bytes} bytes sent, about ${glm(gas * gasPrice)}`)
    } catch (error) {
      console.log(`  ${label}: estimate failed (${short(error)})`)
    }
  }
}

async function showRecord(client, entityKey, writer) {
  const page = await client
    .select({ key: true, creator: true, owner: true, expiresAt: true, creationFlags: true, contentType: true, payload: true, attributes: true })
    .where(eq('$key', key(entityKey)))
    .createdBy(writer)
    .limit(1)
    .fetch()
  const entity = page.entities[0]
  if (!entity || !entity.creationFlags.readonly) return null
  if (entity.attributes.project?.value !== PROJECT || entity.attributes.entity_type?.value !== RECORD_TYPE) return null
  return { entity, body: JSON.parse(entity.toText()) }
}

function listen(socket, writer, onRecord) {
  const seen = new Map()
  const stopSdk = socket.watchEntityEvents({
    onEntityCreated: (event) => {
      if (!isAddressEqual(event.owner, writer)) return
      const arrived = now()
      seen.set(event.entityKey, { ...seen.get(event.entityKey), sdkEvent: arrived, block: event.blockNumber })
      showRecord(reader, event.entityKey, writer)
        .then((shown) => {
          seen.set(event.entityKey, { ...seen.get(event.entityKey), shown: now(), record: shown })
          if (shown) onRecord?.(event.entityKey, shown)
        })
        .catch((error) => console.log(`  Listener could not read ${event.entityKey}: ${short(error)}`))
    },
    onError: (error) => console.log(`  Listener event error: ${short(error)}`),
  })
  const stopFiltered = socket.watchEvent({
    address: ARKIV_ADDRESS,
    event: CREATED_EVENT,
    args: { owner: writer },
    onLogs: (logs) => {
      for (const log of logs) seen.set(log.args.entityKey, { ...seen.get(log.args.entityKey), filteredEvent: now() })
    },
    onError: (error) => console.log(`  Filtered listener error: ${short(error)}`),
  })
  return { seen, stop: () => { stopSdk(); stopFiltered() } }
}

async function writeRecord(wallet, refusal, lifetime) {
  const existing = await reader
    .select({ key: true })
    .where(eq('project', PROJECT), eq('entity_type', RECORD_TYPE), eq('sepolia_tx', bytes32(refusal.hash)))
    .createdBy(wallet.account.address)
    .limit(1)
    .fetch()
  if (existing.entities.length) return { duplicate: existing.entities[0].key }
  const sentAt = now()
  const created = await wallet.createEntity(recordFor(refusal, lifetime))
  const confirmedAt = now()
  const receipt = await reader.getTransactionReceipt({ hash: created.txHash })
  return { ...created, sentAt, confirmedAt, receipt, fee: receipt.gasUsed * receipt.effectiveGasPrice }
}

async function needsGlm(account) {
  const balance = await reader.getBalance({ address: account.address })
  if (balance === 0n) throw new Error(`No test GLM yet on ${account.address}. Claim it first (to-do.md step O).`)
  return balance
}

async function write() {
  const account = testAccount()
  const wallet = arkivWallet(account)
  const before = await needsGlm(account)
  const { reader: sepoliaReader, scene } = await sepolia()
  const [hash] = process.argv[3]?.startsWith('0x') ? [process.argv[3]] : await pastRefusalHashes(scene.vault, 1)
  const refusal = await refusalFrom(sepoliaReader, hash)
  if (!refusal) throw new Error(`${hash} was not refused`)
  console.log(`Writing a refusal record that expires in ${TEST_MINUTES} minutes: "${refusal.reason}" (${EXPLORER}/tx/${hash})`)
  const socket = socketReader()
  const { heads, stop: stopHeads } = followHeads(socket)
  const listener = listen(socket, account.address)
  const otherEvents = []
  const stopAll = socket.watchEntityEvents({ onEvent: (event) => otherEvents.push({ ...event, arrived: now() }) })
  await sleep(2_000)
  const written = await writeRecord(wallet, refusal, ExpirationTime.fromMinutes(TEST_MINUTES))
  if (written.duplicate) {
    console.log(`Already recorded as ${written.duplicate}. The watcher never writes the same refusal twice.`)
    listener.stop()
    stopAll()
    stopHeads()
    return
  }
  const after = await reader.getBalance({ address: account.address })
  console.log(`Written: ${ARKIV_EXPLORER}/entity/${written.entityKey}`)
  console.log(`  transaction ${ARKIV_EXPLORER}/tx/${written.txHash}, block ${written.receipt.blockNumber}, expires at block ${written.expiresAt}`)
  console.log(`  ${seconds(written.confirmedAt - written.sentAt)} s from sending to the receipt`)
  console.log(`  cost: ${written.receipt.gasUsed} gas = ${glm(written.fee)} (balance went from ${glm(before)} to ${glm(after)})`)
  const heard = await waitFor(() => listener.seen.get(written.entityKey)?.shown && listener.seen.get(written.entityKey), 30_000)
  const head = heads.get(written.receipt.blockNumber)
  if (heard) {
    console.log(`  SDK live event (WebSocket): ${seconds(heard.sdkEvent - written.sentAt)} s after sending${head ? `, ${seconds(heard.sdkEvent - head.arrived)} s after its block arrived` : ''}`)
    if (heard.filteredEvent) console.log(`  Filtered event (only our writer, filtered by the node): ${seconds(heard.filteredEvent - written.sentAt)} s after sending`)
    console.log(`  Listener read it back and checked it: ${seconds(heard.shown - written.sentAt)} s after sending`)
    console.log(`  Read back: creator ${heard.record.entity.creator}, readonly ${heard.record.entity.creationFlags.readonly}, reason "${heard.record.body.reason}"`)
  } else {
    console.log('  The listener did not hear it within 30 s')
  }
  const search = await reader
    .select({ key: true })
    .where(eq('project', PROJECT), eq('entity_type', RECORD_TYPE), eq('vault', addr(refusal.vault)))
    .createdBy(account.address)
    .limit(50)
    .fetch()
  console.log(`  Search "refusals for this vault, by our watcher": ${search.entities.length} found, ours ${search.entities.some((entity) => entity.key === written.entityKey) ? 'included' : 'MISSING'}`)
  if (process.argv.includes('--no-wait')) {
    listener.stop()
    stopAll()
    stopHeads()
    return
  }
  console.log(`\nWaiting for it to expire at block ${written.expiresAt}...`)
  const gone = await waitFor(async () => {
    const current = await reader.getBlockNumber({ cacheTime: 0 })
    if (current < written.expiresAt - 1n) return null
    return (await stillLive(written.entityKey)) ? null : { block: current, at: now() }
  }, TEST_MINUTES * 60_000 + 90_000, 1_000)
  await sleep(6_000)
  listener.stop()
  stopAll()
  stopHeads()
  const aboutIt = otherEvents.filter((event) => event.entityKey === written.entityKey)
  const expiryHead = heads.get(written.expiresAt)
  console.log(gone ? `Gone when the head was block ${gone.block}${expiryHead ? `, ${seconds(gone.at - expiryHead.arrived)} s after block ${written.expiresAt} arrived` : ''}` : 'Still live after the wait')
  console.log(`Live events about it: ${aboutIt.map((event) => `${event.type} (block ${event.blockNumber})`).join(', ')}`)
  const logs = await reader.getLogs({ address: ARKIV_ADDRESS, fromBlock: written.expiresAt - 2n, toBlock: written.expiresAt + 2n })
  console.log(`Raw logs naming it around its expiry: ${logs.filter((log) => log.topics[1]?.toLowerCase() === written.entityKey.toLowerCase()).length}`)
  const [lastLive, atExpiry] = await Promise.all([liveAt(written.entityKey, written.expiresAt - 1n), liveAt(written.entityKey, written.expiresAt)])
  console.log(`Search at block ${written.expiresAt - 1n}: ${lastLive}; at block ${written.expiresAt}: ${atExpiry}`)
}

async function endToEnd() {
  const account = testAccount()
  const wallet = arkivWallet(account)
  await needsGlm(account)
  const { reader: sepoliaReader, signer, scene } = await sepolia()
  const timeline = {}
  const socket = socketReader()
  const listener = listen(socket, account.address, (entityKey, shown) => {
    if (shown.body.tx === timeline.hash) timeline.listenerShown = { at: now(), entityKey, reason: shown.body.reason }
  })
  let scanned = await sepoliaReader.getBlockNumber({ cacheTime: 0 })
  let running = true
  const watcher = (async () => {
    while (running) {
      const latest = await sepoliaReader.getBlockNumber({ cacheTime: 0 }).catch(() => scanned)
      for (let n = scanned + 1n; n <= latest; n++) {
        const block = await sepoliaReader.getBlock({ blockNumber: n, includeTransactions: true })
        for (const tx of block.transactions.filter((item) => item.to && isAddressEqual(item.to, scene.vault))) {
          const seenAt = now()
          const refusal = await refusalFrom(sepoliaReader, tx.hash, seenAt)
          if (!refusal) continue
          if (tx.hash === timeline.hash) timeline.watcherSaw = { at: seenAt, block: n, blockTime: Number(block.timestamp) * 1000, reason: refusal.reason }
          console.log(`  Watcher: block ${n} has a refusal, "${refusal.reason}". Writing it to Arkiv...`)
          const written = await writeRecord(wallet, refusal, ExpirationTime.fromMinutes(TEST_MINUTES))
          if (tx.hash === timeline.hash && !written.duplicate) timeline.written = { at: written.confirmedAt, entityKey: written.entityKey, txHash: written.txHash, fee: written.fee }
          console.log(`  Watcher: ${written.duplicate ? 'already recorded' : `recorded, ${ARKIV_EXPLORER}/entity/${written.entityKey}`}`)
        }
        scanned = n
      }
      await sleep(SEPOLIA_POLL_MS)
    }
  })().catch((error) => {
    timeline.failed = short(error)
  })
  await sleep(2_000)
  const balances = await readBalances(sepoliaReader, scene)
  console.log(`The demo vault holds ${formatUnits(balances.vault, scene.decimals)} ${scene.symbol}. Sending one refused attack ("send everything to my address") with the phone page's code...`)
  timeline.sentAt = now()
  const { hash } = await sendTry({ reader: sepoliaReader, signer }, attackRequest(scene, balances, 'steal'))
  timeline.hash = hash
  console.log(`  Attack sent: ${EXPLORER}/tx/${hash}`)
  await waitFor(() => timeline.listenerShown || timeline.failed, 180_000, 250)
  running = false
  await watcher
  listener.stop()
  if (timeline.failed) console.log(`  Watcher stopped: ${timeline.failed}`)
  const heard = timeline.written ? listener.seen.get(timeline.written.entityKey) : null
  const at = (time) => (time ? `${seconds(time - timeline.sentAt)} s` : 'not reached')
  console.log('\nTimeline, from the moment the attack was sent:')
  console.log(`  Sepolia block ${timeline.watcherSaw?.block ?? '?'} (its timestamp): ${at(timeline.watcherSaw?.blockTime)}`)
  console.log(`  Watcher saw the refusal: ${at(timeline.watcherSaw?.at)} ("${timeline.watcherSaw?.reason ?? '?'}")`)
  console.log(`  Arkiv record confirmed: ${at(timeline.written?.at)}${timeline.written ? ` (${glm(timeline.written.fee)})` : ''}`)
  console.log(`  Listener got the live event: ${at(heard?.sdkEvent)}`)
  console.log(`  Listener showed the checked record: ${at(timeline.listenerShown?.at)}`)
  if (timeline.written) console.log(`  Record: ${ARKIV_EXPLORER}/entity/${timeline.written.entityKey}`)
}

const commands = { info, watch, expiry, estimate, refusals, write, e2e: endToEnd }
const command = commands[process.argv[2]]
if (!command) {
  console.log('Usage: node --env-file=../.env experiments/arkiv.js info | watch [seconds] [--http] | expiry [blocks] | estimate [tx] [--from address] | refusals [count] | write [tx] [--no-wait] | e2e')
  process.exit(1)
}
command()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(redact(error.stack ?? error))
    process.exit(1)
  })
