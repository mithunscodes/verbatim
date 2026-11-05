import { useEffect, useState } from 'react'
import { EXPLORER } from './config.js'
import { getWallet } from './chain.js'
import { buildReceipt, fetchReceipt, hasReceiptKey, openReceipt, receiptKey, sealReceipt, storeReceipt } from './receipts.js'
import Proof from './Proof.jsx'

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

export function ReceiptPage({ root, account }) {
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
    } catch (error) {
      setState((s) => ({
        ...s,
        status: 'locked',
        error: error?.code === 4001 ? 'You cancelled in MetaMask.' : "This receipt can't be opened with this key. Switch MetaMask to the key that made it.",
      }))
    }
  }

  const { receipt } = state
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
          <p>{receipt.sentence}</p>
          <h3>Your vault enforced</h3>
          <ul>
            {receipt.checksInWords.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
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
