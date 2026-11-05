import { zeroAddress } from 'viem'
import { SHOWN_DIGITS, SWAP_SLIPPAGE_BPS, UNIVERSAL_ROUTER } from './config.js'
import { canSwap, expectedArrival, holdingOf, nameOf } from './checks.js'
import { planFromSteps } from './intent.js'
import { zeroGSession, ZG_SPENT } from './credits.js'

const SHORT_ADDRESS = /^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/

async function post(path, body) {
  const session = zeroGSession()
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(session ? { 'x-0g-session': session } : {}) },
    body: JSON.stringify(body, (key, value) => (typeof value === 'bigint' ? value.toString() : value)),
  }).catch(() => null)
  if (!response) throw new Error("The Verbatim server isn't running. Start it from server/ with npm start.")
  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(json.error ?? `The server answered ${response.status}.`)
  if (session) window.dispatchEvent(new Event(ZG_SPENT))
  return json
}

function namedContacts(vault) {
  return vault.contacts
    .filter((contact) => !contact.moved)
    .map((contact) => ({ address: contact.address, name: nameOf(vault, contact.address) }))
    .filter((contact) => !SHORT_ADDRESS.test(contact.name))
}

export function contextFor(vault) {
  return {
    holdings: vault.holdings,
    contacts: namedContacts(vault),
    fairValue: (from, amount, to) => (vault.fairPrice && canSwap(vault, from, to) ? expectedArrival(vault, from, amount) : null),
    deposits: {},
    slippageBps: SWAP_SLIPPAGE_BPS,
    shownDigits: SHOWN_DIGITS,
  }
}

export function planFor(vault, result) {
  return planFromSteps(contextFor(vault), result)
}

export function understandSentence(vault, sentence, turns) {
  return post('/api/understand', {
    sentence,
    names: namedContacts(vault).map((contact) => contact.name),
    tokens: vault.holdings.map((holding) => holding.symbol),
    protocols: [],
    turns,
  })
}

export function formSentence(vault, form) {
  if (form.mode === 'send') {
    const holding = holdingOf(vault, form.token)
    return `Send ${form.amount.trim()} ${holding?.symbol ?? ''} to ${nameOf(vault, form.to)}`
  }
  return `Swap ${form.amount.trim()} ${holdingOf(vault, form.from)?.symbol ?? ''} for ${holdingOf(vault, form.swapTo)?.symbol ?? ''}`
}

export function previewKey(sentence, actions, demo) {
  const shape = (actions ?? []).map((a) => [a.target, a.target === UNIVERSAL_ROUTER ? a.data.slice(0, 10) : a.data, String(a.value), a.operation])
  return JSON.stringify([sentence, shape, demo.scenario, demo.hacked])
}

export function previewTransaction(vault, sentence, actions) {
  const contacts = Object.fromEntries(namedContacts(vault).map((c) => [c.address, c.name]))
  const known = Object.fromEntries(Object.entries(vault.names ?? {}).filter(([address]) => !contacts[address] && address !== vault.address))
  return post('/api/preview', {
    sentence,
    vault: vault.address,
    actions: actions.map((a) => ({ target: a.target, value: String(a.value), data: a.data, operation: a.operation })),
    tokens: vault.holdings.filter((h) => h.token !== zeroAddress).map(({ token, symbol, decimals }) => ({ token, symbol, decimals })),
    contacts,
    known,
  })
}
