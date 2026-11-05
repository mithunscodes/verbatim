import { RPC_BATCH_LIMIT, RPC_METHODS, RPC_TIMEOUT_MS } from './config.js'
import { RequestError } from './uniswap.js'

export function methodsOf(body) {
  return (Array.isArray(body) ? body : [body]).map((call) => call?.method)
}

export async function relay(body) {
  if (!process.env.SEPOLIA_RPC_URL) throw new RequestError("SEPOLIA_RPC_URL is missing from .env, so the demo pages can't reach Sepolia.", 503)
  const methods = methodsOf(body)
  if (methods.length === 0 || methods.length > RPC_BATCH_LIMIT) throw new RequestError(`Send between 1 and ${RPC_BATCH_LIMIT} calls at a time.`)
  const blocked = methods.find((method) => !RPC_METHODS.includes(method))
  if (blocked !== undefined) throw new RequestError(`${blocked} isn't allowed through the demo relay.`, 403)
  let response
  try {
    response = await fetch(process.env.SEPOLIA_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
  } catch {
    throw new RequestError("Couldn't reach Sepolia's node in time.", 504)
  }
  const answer = await response.json().catch(() => null)
  if (!answer) throw new RequestError(`Sepolia's node answered ${response.status} without a result.`, 502)
  return answer
}
