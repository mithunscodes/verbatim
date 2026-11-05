import { hexToBytes, stringToHex } from 'viem'

const keys = new Map()

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

export async function receiptKey(wallet, account) {
  if (!keys.has(account)) {
    const signature = await wallet.request({ method: 'personal_sign', params: [stringToHex(receiptMessage(account)), account] })
    keys.set(account, await keyFromSignature(signature))
  }
  return keys.get(account)
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

export function buildReceipt({ vault, account, chainId, sentence, ai, checks, checksInWords, result }) {
  return {
    kind: 'verbatim-receipt',
    version: 1,
    createdAt: new Date().toISOString(),
    chainId,
    vault,
    signedBy: account,
    sentence,
    understoodAs: ai?.steps ?? null,
    checks,
    checksInWords,
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
