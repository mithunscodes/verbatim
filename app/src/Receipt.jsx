import { useEffect, useState } from 'react'
import { EXPLORER } from './config.js'
import { getWallet } from './chain.js'
import { describeCheck } from './checks.js'
import {
  buildReceipt,
  fetchReceipt,
  hasReceiptKey,
  openReceipt,
  RECEIPTS_CHANGED,
  receiptKey,
  rememberedReceipts,
  rememberReceipt,
  sealReceipt,
  storeReceipt,
} from './receipts.js'
import Proof from './Proof.jsx'
import ChainProof from './ChainProof.jsx'
import { FromWords, YourWords } from './Words.jsx'

function understoodOf(receipt) {
  const understood = receipt.understoodAs
  if (!understood) return null
  return Array.isArray(understood) ? { steps: understood } : understood
}

function describerFor(vault, receipt) {
  if (!vault || vault.address?.toLowerCase() !== receipt.vault?.toLowerCase()) return null
  return (check) => describeCheck(vault, check).text
}

function explainError(error) {
  if (error?.code === 4001) return 'You cancelled in MetaMask, so no receipt was saved.'
  return error?.message ?? 'Something went wrong.'
}

export function ReceiptBox({ input }) {
  const [state, setState] = useState({ status: 'idle' })
  const [round, setRound] = useState(0)

  useEffect(() => {
    let current = true
    const save = async () => {
      const wallet = getWallet()
      setState({ status: hasReceiptKey(input.account) ? 'saving' : 'signing' })
      const key = await receiptKey(wallet, input.account)
      if (!current) return
      setState({ status: 'saving' })
      const sealed = await sealReceipt(key, buildReceipt(input))
      const saved = await storeReceipt(sealed)
      rememberReceipt(input.account, {
        root: saved.root,
        hash: input.result.hash,
        outcome: input.result.ok ? 'done' : 'refused',
        vault: input.vault,
        savedAt: Date.now(),
      })
      if (current) setState({ status: 'done', ...saved })
    }
    save().catch((error) => current && setState({ status: 'error', error: explainError(error) }))
    return () => {
      current = false
    }
  }, [input.result.hash, round])

  return (
    <div className="receipt-box">
      {state.status === 'signing' && (
        <p className="muted small">MetaMask asks you to sign once, to make the key that locks your receipts. It can't move money.</p>
      )}
      {state.status === 'saving' && <p className="muted small">Saving a private receipt on 0G Storage… about 15 seconds.</p>}
      {state.status === 'done' && (
        <p className="small">
          🔒 Private receipt saved on 0G Storage: <a href={`#receipt/${state.root}`}>open it</a> ·{' '}
          <a href={state.explorer} target="_blank" rel="noreferrer">0G transaction</a>
        </p>
      )}
      {state.status === 'error' && (
        <p className="error small">
          Couldn't save the receipt: {state.error}{' '}
          <button className="link" onClick={() => setRound((n) => n + 1)}>Try again</button>
        </p>
      )}
    </div>
  )
}

export function ReceiptPage({ root, account, vault }) {
  const [state, setState] = useState({ status: 'loading' })

  useEffect(() => {
    let current = true
    fetchReceipt(root)
      .then((sealed) => current && setState({ status: 'locked', sealed }))
      .catch((error) => current && setState({ status: 'error', error: error.message }))
    return () => {
      current = false
    }
  }, [root])

  const unlock = async () => {
    try {
      const key = await receiptKey(getWallet(), account)
      setState((s) => ({ ...s, status: 'opening' }))
      const receipt = await openReceipt(key, state.sealed)
      setState({ status: 'open', receipt })
      rememberReceipt(account, {
        root,
        hash: receipt.transaction.hash,
        outcome: receipt.transaction.outcome,
        vault: receipt.vault,
        savedAt: Date.parse(receipt.createdAt) || Date.now(),
      })
    } catch (error) {
      setState((s) => ({
        ...s,
        status: 'locked',
        error: error?.code === 4001 ? 'You cancelled in MetaMask.' : "This receipt can't be opened with this key. Switch MetaMask to the key that made it.",
      }))
    }
  }

  const { receipt } = state
  const understood = receipt ? understoodOf(receipt) : null
  const describe = receipt ? describerFor(vault, receipt) : null
  return (
    <section className="card">
      <h2>Private receipt</h2>
      <p className="muted small">Stored on 0G Storage, encrypted. Only the key that made it can open it.</p>
      <p className="muted small mono">{root}</p>
      {state.status === 'loading' && <p className="muted">Fetching it from 0G Storage…</p>}
      {state.status === 'error' && <p className="error">{state.error}</p>}
      {(state.status === 'locked' || state.status === 'opening') && (
        <>
          <button onClick={unlock} disabled={!account || state.status === 'opening'}>Unlock with MetaMask</button>
          {!account && <p className="muted small">Connect MetaMask first.</p>}
          {state.error && <p className="error small">{state.error}</p>}
        </>
      )}
      {state.status === 'open' && (
        <>
          <h3>You said</h3>
          {understood ? <YourWords sentence={receipt.sentence} result={understood} /> : <p>{receipt.sentence}</p>}
          <h3>{receipt.transaction.outcome === 'done' ? 'Your vault enforced' : 'Your checks'}</h3>
          <ul className="receipt-checks">
            {receipt.checksInWords.map((line, i) => (
              <li key={i}>
                {line}
                <FromWords words={receipt.checksFrom?.[i]} />
              </li>
            ))}
          </ul>
          <ChainProof
            vault={receipt.vault}
            hash={receipt.transaction.hash}
            checks={receipt.checks}
            describe={describe}
          />
          <h3>What happened</h3>
          <p>
            {receipt.transaction.outcome === 'done' ? '✅ Done, exactly as you said' : `❌ Refused, so it never happened${receipt.transaction.reason ? `: ${receipt.transaction.reason}` : ''}`}
            {' · '}
            <a href={`${EXPLORER}/tx/${receipt.transaction.hash}`} target="_blank" rel="noreferrer">See it on Etherscan</a>
          </p>
          {receipt.sealedAi && (
            <>
              <h3>Understood by</h3>
              <Proof proof={{ ...receipt.sealedAi, verifiability: 'TeeML', note: 'The signature and the signed text are stored in this receipt, so the check can be repeated later.' }} />
            </>
          )}
          <p className="muted small">Saved {new Date(receipt.createdAt).toLocaleString('en-GB')}</p>
        </>
      )}
    </section>
  )
}

function when(savedAt) {
  return new Date(savedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function RecentReceipts({ account, current }) {
  const [list, setList] = useState(() => rememberedReceipts(account))

  useEffect(() => {
    const read = () => setList(rememberedReceipts(account))
    read()
    window.addEventListener(RECEIPTS_CHANGED, read)
    window.addEventListener('storage', read)
    return () => {
      window.removeEventListener(RECEIPTS_CHANGED, read)
      window.removeEventListener('storage', read)
    }
  }, [account])

  const shown = list.filter((item) => item.root !== current)
  if (!shown.length) return null
  return (
    <section className="card">
      <h2>{current ? 'Your other receipts' : 'Your receipts'}</h2>
      <p className="muted small">
        Links to your private receipts on 0G Storage, kept in this browser only. Each one opens with the key that made it.
      </p>
      <ul className="receipt-list">
        {shown.map((item) => (
          <li key={item.root}>
            <a href={`#receipt/${item.root}`}>{item.outcome === 'refused' ? '❌ Refused' : '✅ Done'} · {when(item.savedAt)}</a>
            {' · '}
            <a href={`${EXPLORER}/tx/${item.hash}`} target="_blank" rel="noreferrer">Etherscan</a>
          </li>
        ))}
      </ul>
    </section>
  )
}
