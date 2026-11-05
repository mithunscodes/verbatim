import { hexToBytes, stringToHex } from 'viem'

const keys = new Map()
const pending = new Map()
const ROOT = /^0x[0-9a-fA-F]{64}$/
const LIST_LIMIT = 20

export const RECEIPTS_CHANGED = 'verbatim-receipts'

const listKey = (account) => `verbatim.receipts.${account.toLowerCase()}`

export function rememberedReceipts(account) {
  if (!account) return []
  try {
    const list = JSON.parse(localStorage.getItem(listKey(account)) ?? '[]')
    return Array.isArray(list) ? list.filter((item) => ROOT.test(item?.root ?? '')) : []
  } catch {
    return []
  }
}

export function rememberReceipt(account, entry) {
  if (!account || !ROOT.test(entry?.root ?? '')) return false
  try {
    const list = [entry, ...rememberedReceipts(account).filter((item) => item.root !== entry.root)].slice(0, LIST_LIMIT)
    localStorage.setItem(listKey(account), JSON.stringify(list))
    window.dispatchEvent(new Event(RECEIPTS_CHANGED))
    return true
  } catch {
    return false
  }
}

export function receiptMessage(account) {
  return [
    'Verbatim receipts',
    '',
    'Signing this makes the key that locks your receipts, so only you can read them.',
    "It can't move money or approve anything.",
    '',
    `Account: ${account}`,
  ].join('\n')
}

function toBase64(bytes) {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
}

export async function keyFromSignature(signature) {
  const digest = await crypto.subtle.digest('SHA-256', hexToBytes(signature))
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export function hasReceiptKey(account) {
  return keys.has(account)
}

export function receiptKey(wallet, account) {
  if (keys.has(account)) return Promise.resolve(keys.get(account))
  if (!pending.has(account)) {
    const request = wallet.request({ method: 'personal_sign', params: [stringToHex(receiptMessage(account)), account] })
      .then(keyFromSignature)
      .then((key) => {
        keys.set(account, key)
        return key
      })
      .finally(() => pending.delete(account))
    pending.set(account, request)
  }
  return pending.get(account)
}

const plain = (key, value) => (typeof value === 'bigint' ? value.toString() : value)

export async function sealReceipt(key, receipt) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(receipt, plain)))
  return { v: 1, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) }
}

export async function openReceipt(key, sealed) {
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.data))
  return JSON.parse(new TextDecoder().decode(data))
}

async function call(path, options) {
  const response = await fetch(path, options).catch(() => null)
  if (!response) throw new Error("The Verbatim server isn't running. Start it from server/ with npm start.")
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `The server answered ${response.status}.`)
  return body
}

export function storeReceipt(sealed) {
  return call('/api/receipt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sealed) })
}

export function fetchReceipt(root) {
  return call(`/api/receipt/${root}`)
}

export function buildReceipt({ vault, account, chainId, sentence, ai, checks, checksInWords, said, result }) {
  return {
    kind: 'verbatim-receipt',
    version: 2,
    createdAt: new Date().toISOString(),
    chainId,
    vault,
    signedBy: account,
    sentence,
    understoodAs: ai?.result ?? null,
    checks,
    checksInWords,
    checksFrom: said?.perCheck ?? null,
    transaction: {
      hash: result.hash,
      outcome: result.ok ? 'done' : 'refused',
      reason: result.ok ? null : result.reason ?? null,
    },
    sealedAi: ai?.proof
      ? {
          model: ai.proof.model ?? null,
          verified: ai.proof.verified,
          provider: ai.proof.provider ?? null,
          registeredSigner: ai.proof.registeredSigner ?? null,
          chatId: ai.proof.chatId ?? null,
          signedText: ai.proof.signedText ?? null,
          signature: ai.proof.signature ?? null,
          registry: ai.proof.registry ?? null,
        }
      : null,
  }
}
