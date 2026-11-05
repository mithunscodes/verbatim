import { networkInterfaces } from 'node:os'
import { LAPTOP_LIMITS, LOOPBACK, OUTSIDE_LIMITS, PROXY_HEADERS, PUBLIC_ROUTES } from './config.js'
import { methodsOf } from './rpc.js'
import { RequestError } from './uniswap.js'

export const isPublic = process.env.VERBATIM_PUBLIC === 'on'

export const isOpen = process.env.VERBATIM_PUBLIC === 'open'

const windows = new Map()

export function routeName(request) {
  const path = request.url.split('?')[0]
  return request.method === 'GET' && path.startsWith('/api/receipt/') ? 'GET /api/receipt' : `${request.method} ${path}`
}

function laptopAddresses() {
  const own = new Set(LOOPBACK)
  for (const net of Object.values(networkInterfaces()).flat()) {
    if (!net?.address) continue
    own.add(net.address)
    own.add(`::ffff:${net.address}`)
  }
  return own
}

export function fromLaptop(request) {
  const chain = request.headers['x-forwarded-for']
  if (!LOOPBACK.includes(request.socket.remoteAddress) || !chain) return false
  if (PROXY_HEADERS.some((name) => name in request.headers)) return false
  const own = laptopAddresses()
  return chain.split(',').every((entry) => own.has(entry.trim()))
}

export function take(name, rule, amount = 1, now = Date.now()) {
  const span = rule.minutes * 60_000
  let window = windows.get(name)
  if (!window || now - window.started >= span) {
    window = { started: now, used: 0 }
    windows.set(name, window)
  }
  if (window.used + amount > rule.count) {
    const minutes = Math.max(1, Math.ceil((window.started + span - now) / 60_000))
    throw new RequestError(`Demo limit reached for this part of Verbatim. It resets in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 429)
  }
  window.used += amount
}

export function admit(request) {
  if (isOpen) {
    const name = routeName(request)
    if (LAPTOP_LIMITS[name]) take(`open ${name}`, LAPTOP_LIMITS[name])
    return false
  }
  if (!isPublic) return false
  const name = routeName(request)
  const outside = !fromLaptop(request)
  if (outside && !PUBLIC_ROUTES.includes(name)) throw new RequestError("This part of Verbatim runs only on the team's laptop.", 403)
  const limits = outside ? OUTSIDE_LIMITS : LAPTOP_LIMITS
  if (limits[name] && name !== 'POST /api/rpc') take(`${outside ? 'outside' : 'laptop'} ${name}`, limits[name])
  return outside
}

export function chargeRelay(body) {
  const methods = methodsOf(body)
  const sends = methods.filter((method) => method === 'eth_sendRawTransaction').length
  take('outside POST /api/rpc', OUTSIDE_LIMITS['POST /api/rpc'], Math.max(1, methods.length))
  if (sends > 0) take('outside eth_sendRawTransaction', OUTSIDE_LIMITS.eth_sendRawTransaction, sends)
}
