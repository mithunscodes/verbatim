import { useEffect, useState } from 'react'
import { EXPLORER } from './config.js'
import { getWallet } from './chain.js'
import { shortAddress } from './format.js'
import { Check, Cross, Spinner } from './Motion.jsx'
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

function Bad({ children }) {
  return (
    <div className="chain-proof bad">
      <span className="mark-bad"><Cross size={28} /></span>
      <div>{children}</div>
    </div>
  )
}

export default function ChainProof({ vault, hash, checks, outside, describe }) {
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

  if (state.status === 'checking') {
    return <p className="chain-proof checking"><Spinner />Checking it against Sepolia…</p>
  }
  if (state.status === 'error') return <Bad>Couldn't check it against Sepolia: {state.error}</Bad>
  if (state.status === 'other') return <Bad>{state.problem}</Bad>
  const count = `${state.carried.length} check${state.carried.length === 1 ? '' : 's'}`
  if (!state.matches) {
    return (
      <Bad>
        <strong>Sepolia shows different checks from the ones you approved.</strong>
        This is what the transaction carried:
        <Carried carried={state.carried} describe={describe} />
      </Bad>
    )
  }
  const record = <a href={`${EXPLORER}/tx/${hash}#eventlog`} target="_blank" rel="noreferrer">its own record of the run</a>
  if (state.status === 'enforced') {
    return (
      <div className="chain-proof ok">
        <Check size={30} />
        <div>
          <strong>Checked on Sepolia, not just in this app</strong>
          The vault enforced exactly these {count}. The fingerprint of the checks in the transaction,{' '}
          <span className="mono">{shortAddress(state.fingerprint)}</span>, matches {record}.
        </div>
      </div>
    )
  }
  if (state.status === 'refused') {
    return (
      <div className="chain-proof ok">
        <Check size={30} />
        <div>
          <strong>Checked on Sepolia, not just in this app</strong>
          {outside
            ? `The transaction carried exactly these ${count}. It failed outside them, so nothing moved.`
            : `The transaction carried exactly these ${count}, and the vault refused it, so nothing moved.`}
        </div>
      </div>
    )
  }
  return <Bad>The transaction went through, but the vault's record of the run doesn't match these checks.</Bad>
}
