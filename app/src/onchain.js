import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, keccak256, parseEventLogs } from 'viem'
import { chain, vaultAbi } from './config.js'

const CHECKS_TYPE = [
  {
    type: 'tuple[]',
    components: [
      { name: 'kind', type: 'uint8' },
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
]

const same = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase()

export function readerFor(wallet) {
  return createPublicClient({ chain, transport: custom(wallet) })
}

export function plainChecks(checks) {
  return checks.map((check) => ({ kind: Number(check.kind), token: check.token, to: check.to, amount: BigInt(check.amount) }))
}

export function checksFingerprint(checks) {
  return keccak256(encodeAbiParameters(CHECKS_TYPE, [plainChecks(checks)]))
}

export function sameCheckList(a, b) {
  const left = plainChecks(a)
  const right = plainChecks(b)
  return left.length === right.length && left.every((check, i) => (
    check.kind === right[i].kind
    && same(check.token, right[i].token)
    && same(check.to, right[i].to)
    && check.amount === right[i].amount
  ))
}

export async function checksOnChain(reader, { vault, hash, checks }) {
  const [tx, receipt] = await Promise.all([reader.getTransaction({ hash }), reader.getTransactionReceipt({ hash })])
  if (!same(tx.to, vault)) return { status: 'other', problem: "This transaction wasn't sent to this vault." }
  let call = null
  try {
    call = decodeFunctionData({ abi: vaultAbi, data: tx.input })
  } catch {
    call = null
  }
  if (call?.functionName !== 'run') return { status: 'other', problem: "This transaction isn't a request to the vault." }
  const carried = plainChecks(call.args[1])
  const fingerprint = checksFingerprint(carried)
  const found = { carried, fingerprint, matches: sameCheckList(carried, checks), blockNumber: receipt.blockNumber }
  if (receipt.status !== 'success') return { ...found, status: 'refused' }
  const ran = parseEventLogs({ abi: vaultAbi, eventName: 'Ran', logs: receipt.logs }).find((log) => same(log.address, vault))
  return { ...found, status: ran?.args.checksHash === fingerprint ? 'enforced' : 'unrecorded' }
}
