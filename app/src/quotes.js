import { useEffect, useRef, useState } from 'react'
import { QUOTE_DELAY_MS, QUOTE_REFRESH_MS } from './config.js'
import { formatAmount } from './format.js'

export const SERVER_DOWN = "The quote server isn't running. In Terminal, open the server folder and run npm start."

export function parseQuote(json) {
  return {
    ...json,
    amountIn: BigInt(json.amountIn),
    amountOut: BigInt(json.amountOut),
    minimumOut: BigInt(json.minimumOut),
    blockNumber: BigInt(json.blockNumber),
  }
}

export async function fetchQuote(ask, signal) {
  let response
  try {
    response = await fetch('/api/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...ask, amount: ask.amount.toString() }),
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

function keyOf(ask) {
  return ask ? [ask.swapper, ask.tokenIn, ask.tokenOut, ask.amount].join('|') : null
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
          const quote = await fetchQuote(now.ask, controller.signal)
          setState({ key, status: 'ready', quote })
        } catch (error) {
          if (controller.signal.aborted) return
          setState({ key, status: 'error', error: error.message })
        }
      }
      timer = setTimeout(load, QUOTE_REFRESH_MS)
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

function describeLeg(leg) {
  const protocols = [...new Set(leg.map((pool) => pool.protocol))].join(' and ')
  const tokens = [leg[0].tokenIn, ...leg.map((pool) => pool.tokenOut)].join(' → ')
  return `Uniswap ${protocols} pools, ${tokens}`
}

export function describeRoute(route) {
  if (route.length === 1) return describeLeg(route[0])
  return `${route.length} routes: ${route.map(describeLeg).join('; ')}`
}

export function compareToFair(amount, fair) {
  const basisPoints = ((amount - fair) * 10_000n) / fair
  if (basisPoints === 0n) return 'the same as the fair amount'
  const size = formatAmount(basisPoints < 0n ? -basisPoints : basisPoints, 2)
  return `${size}% ${basisPoints > 0n ? 'more' : 'less'} than the fair amount`
}
