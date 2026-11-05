import { createPublicClient, getAddress, http, parseAbi, recoverMessageAddress } from 'viem'
import { SIGNATURE_TRIES, SIGNATURE_WAIT_MS, ZG_INFERENCE, ZG_MAINNET_RPC } from './config.js'

const inferenceAbi = parseAbi([
  'function getService(address provider) view returns ((address provider, string serviceType, string url, uint256 inputPrice, uint256 outputPrice, uint256 updatedAt, string model, string verifiability, string additionalInfo, address teeSignerAddress, bool teeSignerAcknowledged) service)',
])

const zeroG = createPublicClient({ transport: http(ZG_MAINNET_RPC, { timeout: 20_000 }) })

const services = new Map()

const PROVIDER_CACHE_MS = 10 * 60_000

export const PROOF_NOTE =
  "0G's Router passes the chat to sealed hardware in an encrypted form, and the signature covers that encrypted chat. It proves a genuine sealed model answered. Through the Router it can't tie this exact text to the signature."

function readInfo(text) {
  try {
    return JSON.parse(text || '{}')
  } catch {
    return {}
  }
}

export async function providerRecord(provider) {
  const address = getAddress(provider)
  const cached = services.get(address)
  if (cached && Date.now() - cached.at < PROVIDER_CACHE_MS) return cached.record
  const service = await zeroG.readContract({ address: ZG_INFERENCE, abi: inferenceAbi, functionName: 'getService', args: [address] })
  const info = readInfo(service.additionalInfo)
  const separated = (info.TargetSeparated ?? info.targetSeparated) === true && (info.ProviderType ?? 'decentralized') !== 'centralized'
  const target = info.TargetTeeAddress ?? info.targetTeeAddress
  const record = {
    provider: address,
    url: service.url,
    model: service.model,
    verifiability: service.verifiability,
    signerAcknowledged: service.teeSignerAcknowledged,
    signer: getAddress(separated && target ? target : service.teeSignerAddress),
    imageDigest: info.ImageDigest ?? null,
  }
  services.set(address, { at: Date.now(), record })
  return record
}

export async function fetchSignature(url, chatId, model) {
  for (let attempt = 1; attempt <= SIGNATURE_TRIES; attempt += 1) {
    const response = await fetch(`${url}/v1/proxy/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}`, {
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null)
    if (response?.ok) return response.json()
    if (attempt < SIGNATURE_TRIES) await new Promise((resolve) => setTimeout(resolve, SIGNATURE_WAIT_MS))
  }
  throw new Error('The provider has no signature for this answer yet')
}

export async function checkSignature({ text, signature }, expectedSigner) {
  const recovered = await recoverMessageAddress({ message: text, signature })
  return { recovered, valid: getAddress(recovered) === getAddress(expectedSigner) }
}

export async function proveAnswer({ provider, chatId }) {
  const base = { chatId, provider, note: PROOF_NOTE, checkedAt: new Date().toISOString() }
  try {
    const record = await providerRecord(provider)
    const sealed = record.verifiability === 'TeeML' && record.signerAcknowledged
    const signed = await fetchSignature(record.url, chatId, record.model)
    const { recovered, valid } = await checkSignature(signed, record.signer)
    return {
      ...base,
      verified: valid && sealed,
      model: record.model,
      verifiability: record.verifiability,
      signerAcknowledged: record.signerAcknowledged,
      registeredSigner: record.signer,
      recoveredSigner: recovered,
      imageDigest: record.imageDigest,
      signedText: signed.text,
      signature: signed.signature,
      registry: { chain: '0G mainnet', contract: ZG_INFERENCE },
      problem: valid ? (sealed ? null : 'The provider is not registered as sealed hardware (TeeML)') : 'The signature is not from the registered sealed signer',
    }
  } catch (error) {
    return { ...base, verified: false, problem: error.message }
  }
}
