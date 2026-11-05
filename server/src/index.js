import { createServer } from 'node:http'
import { HOST, PORT, TOKENS } from './config.js'
import { quoteSwap, RequestError } from './uniswap.js'

const MAX_BODY_BYTES = 10_000

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

function hide(text) {
  return String(text).split(process.env.UNISWAP_API_KEY).join('[hidden]')
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
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
  response.end(JSON.stringify(body))
}

function log(request, body, outcome, started) {
  const time = new Date().toLocaleTimeString('en-GB')
  const what = body
    ? `quote ${body.amount ?? '?'} ${TOKENS[body.tokenIn] ?? '?'} → ${TOKENS[body.tokenOut] ?? '?'} for ${body.swapper ?? '?'}`
    : `${request.method} ${request.url}`
  console.log(hide(`${time} ${what}: ${outcome}, ${Date.now() - started} ms`))
}

const server = createServer(async (request, response) => {
  const started = Date.now()
  let body = null
  try {
    if (request.method !== 'POST' || request.url !== '/api/quote') throw new RequestError('Not found.', 404)
    if (!request.headers['content-type']?.startsWith('application/json')) throw new RequestError('Send JSON.', 415)
    body = await readJson(request)
    send(response, 200, await quoteSwap(body))
    log(request, body, 'ok', started)
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 500
    send(response, status, { error: status === 500 ? 'Something went wrong in the quote server.' : error.message })
    if (status === 500) console.error(hide(error.stack ?? error))
    else log(request, body, error.message, started)
  }
})

server.listen(PORT, HOST, () => console.log(`Quote server ready on http://${HOST}:${PORT}`))
