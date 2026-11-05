import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { privateKeyToAccount } from 'viem/accounts'
import { HOST, PORT, TOKENS } from './config.js'
import { quoteSwap, RequestError } from './uniswap.js'
import { understand } from './understand.js'
import { preview } from './preview.js'
import { loadReceipt, receiptAddress, saveReceipt } from './receipts.js'
import { methodsOf, relay } from './rpc.js'
import { replay } from './replays.js'
import { admit, chargeRelay, isPublic } from './gate.js'

try {
  process.loadEnvFile(new URL('../../.env', import.meta.url))
} catch {
  console.error('No .env file found at the top of the project.')
  process.exit(1)
}

if (!process.env.UNISWAP_API_KEY) {
  console.error('UNISWAP_API_KEY is missing from .env.')
  process.exit(1)
}

const OPTIONAL = {
  ZG_ROUTER_API_KEY: 'the sealed AI (sentences and the live preview)',
  SEPOLIA_RPC_URL: 'the live preview and the demo pages',
  RECEIPTS_PRIVATE_KEY: 'receipts on 0G Storage',
}

for (const [name, feature] of Object.entries(OPTIONAL)) {
  if (!process.env[name]) console.log(`${name} is missing from .env, so ${feature} won't work.`)
}

const secrets = [process.env.UNISWAP_API_KEY, process.env.ZG_ROUTER_API_KEY, process.env.SEPOLIA_RPC_URL, process.env.SEPOLIA_RPC_URL?.split('/').pop(), process.env.RECEIPTS_PRIVATE_KEY, process.env.DEMO_EVERYDAY_PRIVATE_KEY, process.env.DEMO_THIEF_PRIVATE_KEY].filter(Boolean)

function hide(text) {
  return secrets.reduce((result, secret) => result.split(secret).join('[hidden]'), String(text))
}

function readJson(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new RequestError('The request is too big.', 413))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
      } catch {
        reject(new RequestError("The request isn't valid JSON."))
      }
    })
    request.on('error', reject)
  })
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body, (key, value) => (typeof value === 'bigint' ? value.toString() : value)))
}

const routes = {
  'POST /api/quote': {
    limit: 10_000,
    run: quoteSwap,
    describe: (body) => `quote ${body.amount ?? '?'} ${TOKENS[body.tokenIn] ?? '?'} → ${TOKENS[body.tokenOut] ?? '?'}`,
  },
  'POST /api/understand': {
    limit: 20_000,
    run: understand,
    describe: (body, result) => result
      ? `understand: ${result.result.steps.length} steps, ${result.result.questions.length} questions, sealed ${result.proof.verified ? '✓' : '✗'}, ${result.latencyMs} ms`
      : 'understand',
  },
  'POST /api/preview': {
    limit: 120_000,
    run: preview,
    describe: (body, result) => result
      ? `preview: ${result.facts.length} facts, ${result.verdict ? (result.verdict.matches ? 'matches' : `${result.verdict.differences.length} differences`) : 'no verdict'}${result.cached ? ' (cached)' : ''}`
      : 'preview',
  },
  'POST /api/receipt': {
    limit: 64_000,
    run: saveReceipt,
    describe: (body, result) => (result ? `receipt saved: ${result.root}` : 'receipt'),
  },
  'POST /api/rpc': {
    limit: 50_000,
    run: relay,
    quiet: (body) => !methodsOf(body).includes('eth_sendRawTransaction'),
    describe: (body) => `demo relay: ${methodsOf(body).join(', ')}`,
  },
  'POST /api/replay': {
    limit: 1_000,
    run: replay,
    describe: (body, result) => (result ? `replay ${body.name}: ${(result.totalMs / 1000).toFixed(1)} s, offline` : `replay ${body.name ?? '?'}`),
  },
}

function sessionOf(request) {
  const session = request.headers['x-0g-session']
  return typeof session === 'string' && /^[\x21-\x7e]{20,4096}$/.test(session) ? session : null
}

function routeOf(request) {
  const route = routes[`${request.method} ${request.url}`]
  if (route) return route
  const match = request.method === 'GET' && request.url.match(/^\/api\/receipt\/(0x[0-9a-fA-F]{64})$/)
  if (match) return { get: true, run: () => loadReceipt(match[1]), describe: () => `receipt read: ${match[1].slice(0, 10)}…` }
  return null
}

function lanAddress() {
  const interfaces = networkInterfaces()
  const candidates = [...(interfaces.en0 ?? []), ...Object.values(interfaces).flat()]
  return candidates.find((net) => net?.family === 'IPv4' && !net.internal)?.address ?? null
}

function goToDemo(response) {
  const key = process.env.DEMO_EVERYDAY_PRIVATE_KEY
  const thiefKey = process.env.DEMO_THIEF_PRIVATE_KEY
  if (!key || !thiefKey) {
    send(response, 503, { error: 'The demo keys are missing from .env. Run scripts/side-by-side.js keys.' })
    return
  }
  response.writeHead(302, { location: `/#attack/${key}/${privateKeyToAccount(thiefKey).address}`, 'cache-control': 'no-store' })
  response.end()
  console.log(`${new Date().toLocaleTimeString('en-GB')} short link: a phone opened the attacker page`)
}

const server = createServer(async (request, response) => {
  const started = Date.now()
  let body = null
  let route = null
  try {
    const outside = admit(request)
    if (request.method === 'GET' && request.url === '/api/go') return goToDemo(response)
    if (request.method === 'GET' && request.url === '/api/lan') return send(response, 200, { address: lanAddress() })
    route = routeOf(request)
    if (!route) throw new RequestError('Not found.', 404)
    if (!route.get) {
      if (!request.headers['content-type']?.startsWith('application/json')) throw new RequestError('Send JSON.', 415)
      body = await readJson(request, route.limit)
    }
    if (outside) chargeRelay(body)
    const result = await route.run(body ?? {}, { session: sessionOf(request) })
    send(response, 200, result)
    if (!route.quiet?.(body ?? {})) console.log(hide(`${new Date().toLocaleTimeString('en-GB')} ${route.describe(body ?? {}, result)}: ok, ${Date.now() - started} ms`))
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 500
    send(response, status, { error: status === 500 ? 'Something went wrong in the Verbatim server.' : error.message })
    const what = route ? route.describe(body ?? {}, null) : `${request.method} ${request.url}`
    if (status === 500) console.error(hide(`${what}: ${error.stack ?? error}`))
    else console.log(hide(`${new Date().toLocaleTimeString('en-GB')} ${what}: ${error.message}, ${Date.now() - started} ms`))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Verbatim server ready on http://${HOST}:${PORT}`)
  if (isPublic) console.log('Public mode is on: phones and the live link reach only the short link and the relay, with limits. The laptop keeps everything, with limits on the paid parts.')
  const payer = receiptAddress()
  if (payer) console.log(`Receipts are paid for by ${payer} on 0G's Galileo test network.`)
})
