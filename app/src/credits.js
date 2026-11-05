import { ZG_ROUTER, ZG_SIGN_IN_ORIGINS } from './config.js'

export const ZG_SPENT = 'verbatim-zg-spent'

let session = null

export function canSignIn() {
  return typeof window !== 'undefined' && ZG_SIGN_IN_ORIGINS.includes(window.location.origin)
}

export function zeroGSession() {
  return session
}

export function closeZeroG() {
  session = null
}

function problemOf(json, status) {
  const error = typeof json.error === 'string' ? json.error : json.error?.message
  return error ?? json.message ?? `0G answered ${status}.`
}

async function router(path, { method = 'GET', body, cookie = false, token = session } = {}) {
  const response = await fetch(`${ZG_ROUTER}${path}`, {
    method,
    credentials: cookie ? 'include' : 'omit',
    headers: {
      'Content-Type': 'application/json',
      'HTTP-Referer': window.location.origin,
      'X-Title': 'Verbatim',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null)
  if (!response) throw new Error("Couldn't reach 0G. Check the internet connection.")
  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(problemOf(json, response.status))
  return json
}

export async function openZeroG(privyToken) {
  if (!privyToken) throw new Error("0G's sign-in didn't finish. Try again.")
  const { token } = await router('/auth/privy', { method: 'POST', body: { token: privyToken }, cookie: true, token: null })
  if (!token) throw new Error("0G didn't open a session. Try again.")
  session = token
}

export function readBalance() {
  return router('/account/balance')
}
