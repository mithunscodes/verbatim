import { useEffect, useState } from 'react'
import { EXPLORER } from './config.js'
import { getWallet } from './chain.js'
import { shortAddress } from './format.js'
import { checksOnChain, readerFor } from './onchain.js'

const KIND_NAMES = ['AtMostLeaves', 'AtLeastArrives', 'ExactlyTo']

function problemOf(error) {
  return error?.shortMessage || error?.message || 'Something went wrong.'
}

function wordsFor(describe, check) {
  try {
    return describe?.(check) ?? null
  } catch {
    return null
  }
}

function Carried({ carried, describe }) {
  return (
    <ol className="small">
      {carried.map((check, i) => (
        <li key={i}>
          {wordsFor(describe, check) ?? <code>{KIND_NAMES[check.kind]} · token {check.token} · to {check.to} · amount {check.amount.toString()}</code>}
        </li>
      ))}
    </ol>
  )
}

export default function ChainProof({ vault, hash, checks, describe }) {
  const [state, setState] = useState({ status: 'checking' })

  useEffect(() => {
    let current = true
    const wallet = getWallet()
    if (!wallet) {
      setState({ status: 'error', error: 'MetaMask is needed to read Sepolia.' })
      return undefined
    }
    setState({ status: 'checking' })
    checksOnChain(readerFor(wallet), { vault, hash, checks })
      .then((found) => current && setState({ status: 'done', ...found }))
      .catch((error) => current && setState({ status: 'error', error: problemOf(error) }))
    return () => {
      current = false
    }
  }, [vault, hash])

  if (state.status === 'checking') return <p className="chain-proof muted small">Checking it against Sepolia…</p>
  if (state.status === 'error') return <p className="chain-proof error small">Couldn't check it against Sepolia: {state.error}</p>
  if (state.status === 'other') return <p className="chain-proof error small">{state.problem}</p>
  const count = `${state.carried.length} check${state.carried.length === 1 ? '' : 's'}`
  if (!state.matches) {
    return (
      <div className="chain-proof bad small">
        <p>✗ Sepolia shows different checks from the ones you approved. This is what the transaction carried:</p>
        <Carried carried={state.carried} describe={describe} />
      </div>
    )
  }
  const record = <a href={`${EXPLORER}/tx/${hash}#eventlog`} target="_blank" rel="noreferrer">its own record of the run</a>
  if (state.status === 'enforced') {
    return (
      <p className="chain-proof ok small">
        ✓ Checked on Sepolia, not just in this app: the vault enforced exactly these {count}. The fingerprint of the checks in the
        transaction, <span className="mono">{shortAddress(state.fingerprint)}</span>, matches {record}.
      </p>
    )
  }
  if (state.status === 'refused') {
    return (
      <p className="chain-proof ok small">
        ✓ Checked on Sepolia, not just in this app: the transaction carried exactly these {count}, and the vault refused it, so
        nothing moved.
      </p>
    )
  }
  return (
    <p className="chain-proof bad small">
      ⚠ The transaction went through, but the vault's record of the run doesn't match these checks.
    </p>
  )
}
