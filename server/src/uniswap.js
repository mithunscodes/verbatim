import { getAddress, isAddress } from 'viem'
import {
  CHAIN_ID,
  PROTOCOLS,
  ROUTER_VERSION,
  SLIPPAGE_PERCENT,
  TOKENS,
  UNISWAP_API,
  UNISWAP_RETRIES,
  UNISWAP_TIMEOUT_MS,
} from './config.js'

const WHOLE_NUMBER = /^[1-9]\d{0,30}$/

export class RequestError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function readAddress(value, name) {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) throw new RequestError(`${name} isn't an address`)
  return getAddress(value)
}

function readToken(value, name) {
  const token = readAddress(value, name)
  if (!TOKENS[token]) throw new RequestError(`${name} must be USDC or ETH`)
  return token
}

function readAsk(body) {
  const swapper = readAddress(body?.swapper, 'swapper')
  const tokenIn = readToken(body?.tokenIn, 'tokenIn')
  const tokenOut = readToken(body?.tokenOut, 'tokenOut')
  if (tokenIn === tokenOut) throw new RequestError('tokenIn and tokenOut must be different')
  if (typeof body?.amount !== 'string' || !WHOLE_NUMBER.test(body.amount)) {
    throw new RequestError('amount must be a whole number of the smallest unit, sent as text')
  }
  return { swapper, tokenIn, tokenOut, amount: body.amount }
}

function uniswapError(status, json) {
  if (json?.errorCode === 'NoRouteFoundError') return 'Uniswap found no route for this amount.'
  if (status === 401 || status === 403) return 'Uniswap refused the API key. Check UNISWAP_API_KEY in .env.'
  if (status === 429) return 'Too many quotes too quickly. Wait a few seconds.'
  return `Uniswap said: ${json?.detail ?? json?.errorCode ?? `error ${status}`}`
}

async function callUniswap(path, body, retries = UNISWAP_RETRIES) {
  let response
  try {
    response = await fetch(UNISWAP_API + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.UNISWAP_API_KEY,
        'x-universal-router-version': ROUTER_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UNISWAP_TIMEOUT_MS),
    })
  } catch {
    throw new RequestError("Couldn't reach Uniswap. Check the internet connection.", 502)
  }
  const json = await response.json().catch(() => null)
  if (response.status >= 500 && retries > 0) return callUniswap(path, body, retries - 1)
  if (!response.ok) throw new RequestError(uniswapError(response.status, json), 502)
  return json
}

function checkQuote(ask, { routing, quote }) {
  if (routing !== 'CLASSIC') throw new RequestError(`Uniswap offered a ${routing} trade, which the vault can't use.`, 502)
  if (Number(quote.chainId) !== CHAIN_ID) throw new RequestError("Uniswap's quote is for another network.", 502)
  if (getAddress(quote.input.token) !== ask.tokenIn || quote.input.amount !== ask.amount) {
    throw new RequestError("Uniswap's quote doesn't take exactly the amount asked.", 502)
  }
  if (getAddress(quote.output.token) !== ask.tokenOut || getAddress(quote.output.recipient) !== ask.swapper) {
    throw new RequestError("Uniswap's quote doesn't pay the vault.", 502)
  }
  return quote
}

function symbolOf(token) {
  return BigInt(token.address) === 0n ? 'ETH' : token.symbol
}

function describeRoute(route) {
  return route.map((leg) => leg.map((pool) => ({
    protocol: pool.type.replace('-pool', ''),
    fee: pool.fee === undefined ? null : Number(pool.fee),
    tokenIn: symbolOf(pool.tokenIn),
    tokenOut: symbolOf(pool.tokenOut),
  })))
}

export async function quoteSwap(body) {
  const ask = readAsk(body)
  const response = await callUniswap('/quote', {
    swapper: ask.swapper,
    tokenIn: ask.tokenIn,
    tokenOut: ask.tokenOut,
    tokenInChainId: String(CHAIN_ID),
    tokenOutChainId: String(CHAIN_ID),
    amount: ask.amount,
    type: 'EXACT_INPUT',
    slippageTolerance: SLIPPAGE_PERCENT,
    protocols: PROTOCOLS,
  })
  const quote = checkQuote(ask, response)
  return {
    swapper: ask.swapper,
    tokenIn: ask.tokenIn,
    tokenOut: ask.tokenOut,
    amountIn: ask.amount,
    amountOut: quote.output.amount,
    minimumOut: quote.output.minimumAmount,
    blockNumber: quote.blockNumber,
    route: describeRoute(quote.route),
  }
}
