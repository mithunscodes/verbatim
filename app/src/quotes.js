import { useEffect, useRef, useState } from 'react'
import { zeroAddress } from 'viem'
import { QUOTE_DELAY_MS, QUOTE_REFRESH_MS } from './config.js'
import { formatAmount } from './format.js'
import { badRouteTransaction, drainTransaction } from './run.js'

export const SERVER_DOWN = "The quote server isn't running. In Terminal, open the server folder and run npm start."

export function parseQuote(json) {
  return {
    ...json,
    amountIn: BigInt(json.amountIn),
    amountOut: BigInt(json.amountOut),
    minimumOut: BigInt(json.minimumOut),
    blockNumber: BigInt(json.blockNumber),
    transaction: { ...json.transaction, value: BigInt(json.transaction.value) },
  }
}

export async function fetchQuote({ swapper, tokenIn, tokenOut, amount }, signal) {
  let response
  try {
    response = await fetch('/api/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ swapper, tokenIn, tokenOut, amount: amount.toString() }),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(SERVER_DOWN)
  }
  const json = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null
  if (!json) throw new Error(SERVER_DOWN)
  if (!response.ok) throw new Error(json.error)
  return parseQuote(json)
}

async function quoteFor(ask, signal) {
  const { tokenIn, amount, scenario } = ask
  if (scenario === 'badRoute') return { badRoute: true, transaction: badRouteTransaction({ from: tokenIn, amount }) }
  const quote = await fetchQuote(ask, signal)
  if (scenario === 'drain') return { ...quote, transaction: drainTransaction({ from: tokenIn, amount, balance: ask.balance }) }
  return quote
}

function keyOf(ask) {
  return ask ? [ask.swapper, ask.tokenIn, ask.tokenOut, ask.amount, ask.scenario, ask.balance].join('|') : null
}

export function useQuote(ask, paused) {
  const key = keyOf(ask)
  const [state, setState] = useState({ key: null, status: 'idle' })
  const latest = useRef({ ask, paused })
  latest.current = { ask, paused }

  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    let timer
    const load = async () => {
      const now = latest.current
      if (!now.paused && document.visibilityState === 'visible') {
        try {
          const quote = await quoteFor(now.ask, controller.signal)
          if (controller.signal.aborted) return
          setState({ key, status: 'ready', quote })
        } catch (error) {
          if (controller.signal.aborted) return
          setState({ key, status: 'error', error: error.message })
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(load, QUOTE_REFRESH_MS)
    }
    timer = setTimeout(load, QUOTE_DELAY_MS)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [key])

  if (!key) return { status: 'idle' }
  return state.key === key ? state : { status: 'loading' }
}

function describeLeg(leg, payingEth, gettingEth) {
  const protocols = [...new Set(leg.map((pool) => pool.protocol))].join(' and ')
  const tokens = [leg[0].tokenIn, ...leg.map((pool) => pool.tokenOut)]
  if (payingEth && tokens[0] === 'WETH') tokens.unshift('ETH')
  if (gettingEth && tokens.at(-1) === 'WETH') tokens.push('ETH')
  return `Uniswap ${protocols} pools, ${tokens.join(' → ')}`
}

export function describeRoute({ route, tokenIn, tokenOut }) {
  const legs = route.map((leg) => describeLeg(leg, tokenIn === zeroAddress, tokenOut === zeroAddress))
  return legs.length === 1 ? legs[0] : `${legs.length} routes: ${legs.join('; ')}`
}

export function compareToFair(amount, fair) {
  const basisPoints = ((amount - fair) * 10_000n) / fair
  if (basisPoints === 0n) return 'the same as the fair amount'
  const size = formatAmount(basisPoints < 0n ? -basisPoints : basisPoints, 2)
  return `${size}% ${basisPoints > 0n ? 'more' : 'less'} than the fair amount`
}
