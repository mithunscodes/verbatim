import { Indexer, MemData } from '@0gfoundation/0g-storage-ts-sdk'
import { JsonRpcProvider, Wallet } from 'ethers'
import { GALILEO_EXPLORER, GALILEO_RPC, MAX_RECEIPT_BYTES, ZG_INDEXER } from './config.js'
import { RequestError } from './uniswap.js'

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const ROOT = /^0x[0-9a-fA-F]{64}$/

const indexer = new Indexer(ZG_INDEXER)

function signer() {
  if (!process.env.RECEIPTS_PRIVATE_KEY) {
    throw new RequestError('Receipts are not set up: RECEIPTS_PRIVATE_KEY is missing from .env. Run: node --env-file=../.env scripts/receipts.js key', 503)
  }
  return new Wallet(process.env.RECEIPTS_PRIVATE_KEY, new JsonRpcProvider(GALILEO_RPC))
}

export function receiptAddress() {
  return process.env.RECEIPTS_PRIVATE_KEY ? new Wallet(process.env.RECEIPTS_PRIVATE_KEY).address : null
}

function readSealed(body) {
  const { v, iv, data } = body ?? {}
  if (v !== 1) throw new RequestError('Unknown receipt version')
  if (typeof iv !== 'string' || !BASE64.test(iv) || iv.length > 32) throw new RequestError("The receipt's iv isn't valid")
  if (typeof data !== 'string' || !BASE64.test(data)) throw new RequestError("The receipt's data isn't valid")
  const bytes = new TextEncoder().encode(JSON.stringify({ v, iv, data }))
  if (bytes.length > MAX_RECEIPT_BYTES) throw new RequestError('The receipt is too big', 413)
  return bytes
}

export async function saveReceipt(body) {
  const bytes = readSealed(body)
  const file = new MemData(bytes)
  const [, treeError] = await file.merkleTree()
  if (treeError) throw new Error(`Couldn't prepare the receipt: ${treeError.message ?? treeError}`)
  const [result, error] = await indexer.upload(file, GALILEO_RPC, signer())
  if (error) throw new Error(`0G Storage upload failed: ${error.message ?? error}`)
  const root = result.rootHash ?? result.rootHashes?.[0]
  const txHash = result.txHash ?? result.txHashes?.[0]
  return { root, txHash, explorer: `${GALILEO_EXPLORER}/tx/${txHash}` }
}

export async function loadReceipt(root) {
  if (!ROOT.test(root)) throw new RequestError("That isn't a receipt link")
  const [blob, error] = await indexer.downloadToBlob(root)
  if (error) throw new RequestError(`Couldn't fetch that receipt from 0G Storage: ${error.message ?? error}`, 404)
  const text = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer())).replace(/\0+$/, '')
  try {
    return JSON.parse(text)
  } catch {
    throw new RequestError("That file on 0G Storage isn't a Verbatim receipt", 422)
  }
}
