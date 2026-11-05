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
import { Check, Cross, Dots, Spinner, Words } from './Motion.jsx'
import Proof from './Proof.jsx'
import ChainProof from './ChainProof.jsx'
import WordTiles from './Tiles.jsx'
import { quoteWords } from './words.js'

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

function Lock({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
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
      const built = buildReceipt(input)
      const sealed = await sealReceipt(key, built)
      const saved = await storeReceipt(sealed)
      rememberReceipt(input.account, {
        root: saved.root,
        hash: input.result.hash,
        outcome: built.transaction.outcome,
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
        <p className="tx-status signing"><Spinner />MetaMask asks you to sign once, to make the key that locks your receipts. It can't move money.</p>
      )}
      {state.status === 'saving' && <p className="tx-status signing"><Spinner />Saving a private receipt on 0G Storage… about 15 seconds.</p>}
      {state.status === 'done' && (
        <p className="tx-status done">
          <Lock size={22} />
          <span>
            Private receipt saved on 0G Storage: <a href={`#receipt/${state.root}`} target="_blank" rel="noreferrer">open it</a> ·{' '}
            <a href={state.explorer} target="_blank" rel="noreferrer">0G transaction</a>
          </span>
        </p>
      )}
      {state.status === 'error' && (
        <p className="tx-status error">
          <span className="mark-bad"><Cross size={26} /></span>
          <span>
            Couldn't save the receipt: {state.error}{' '}
            <button className="link" onClick={() => setRound((n) => n + 1)}>Try again</button>
          </span>
        </p>
      )}
    </div>
  )
}

function OpenReceipt({ receipt, vault }) {
  const understood = understoodOf(receipt)
  const describe = describerFor(vault, receipt)
  const done = receipt.transaction.outcome === 'done'
  const failed = receipt.transaction.outcome === 'failed'
  const at = (ms) => ({ animationDelay: `${ms}ms` })
  return (
    <>
      <span className={done ? 'stamp big' : failed ? 'stamp big plain' : 'stamp big refused'} style={at(4000)}>
        {done ? 'WORD FOR WORD' : failed ? "DIDN'T GO THROUGH" : 'NEVER HAPPENED'}
      </span>
      <section className="vb-in said-block" style={at(1400)}>
        <h3>You said</h3>
        {understood ? <WordTiles sentence={receipt.sentence} result={understood} instant small delay={1500} /> : <p className="happened">{receipt.sentence}</p>}
      </section>
      <section className="vb-in" style={at(2000)}>
        <h3>{done ? 'Your vault enforced' : 'Your checks'}</h3>
        <ul className="ticket-checks">
          {receipt.checksInWords.map((line, i) => (
            <li key={i}>
              <span className="check-num">{i + 1}</span>
              <span>
                {line}
                {receipt.checksFrom?.[i]?.length > 0 && <span className="from">you said {quoteWords(receipt.checksFrom[i])}</span>}
              </span>
              {done && <Check size={24} ring={false} delay={2300 + i * 180} />}
            </li>
          ))}
        </ul>
      </section>
      <section className="vb-in" style={at(2500)}>
        <ChainProof vault={receipt.vault} hash={receipt.transaction.hash} checks={receipt.checks} outside={failed} describe={describe} />
      </section>
      <div className="tear"><span /><span /></div>
      <section>
        <h3 className="vb-in" style={at(3100)}>What happened</h3>
        <span className="happened">
          <Words text={done ? 'Done, exactly as you said.' : failed ? "It didn't go through, so nothing moved." : 'Refused, so it never happened.'} delay={3200} />
        </span>
        {!done && receipt.transaction.reason && <p className="vb-in" style={{ ...at(3600), margin: 0 }}>{receipt.transaction.reason}</p>}
        <p className="vb-in" style={{ ...at(3700), margin: 0 }}>
          <a href={`${EXPLORER}/tx/${receipt.transaction.hash}`} target="_blank" rel="noreferrer">See it on Etherscan</a>
        </p>
        {!done && !failed && <a className="go vb-in" style={at(3800)} href={`#proof/${receipt.transaction.hash}`} target="_blank" rel="noreferrer">Open the evidence page</a>}
      </section>
      {receipt.sealedAi && (
        <section className="vb-in" style={at(3800)}>
          <h3>Understood by</h3>
          <Proof proof={{ ...receipt.sealedAi, verifiability: 'TeeML', note: 'The signature and the signed text are stored in this receipt, so the check can be repeated later.' }} />
        </section>
      )}
      <div className="ticket-foot vb-in" style={at(3900)}>
        {receipt.sealedAi && <span>Understood by a sealed AI on 0G</span>}
        <span>Saved {new Date(receipt.createdAt).toLocaleString('en-GB')}</span>
      </div>
    </>
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
  const open = state.status === 'open'
  const head = open && receipt.transaction.outcome !== 'done' ? receipt.transaction.outcome : null
  return (
    <section className="receipt">
      <div className="printer"><span /></div>
      <div className="paper-slot">
        <div key={open ? 'open' : 'closed'} className="ticket">
          <div className={head ? `ticket-head ${head}` : 'ticket-head'}>
            <div className="card-head">
              <h2>Receipt</h2>
              <span className="pill ink"><Lock size={14} />Private</span>
            </div>
            <p>Stored on 0G Storage, encrypted. Only the key that made it can open it.</p>
            <p className="mono">{root}</p>
          </div>
          <div className="ticket-body">
            {state.status === 'loading' && <p className="reading">Fetching it from 0G Storage <Dots /></p>}
            {state.status === 'error' && <p className="panel warn">{state.error}</p>}
            {(state.status === 'locked' || state.status === 'opening') && (
              <div className="lock vb-in" style={{ animationDelay: '1200ms' }}>
                <span className="happened">This receipt is locked.</span>
                <button className="big" onClick={unlock} disabled={!account || state.status === 'opening'}>
                  {state.status === 'opening' ? 'Opening…' : 'Unlock with MetaMask'}
                </button>
                {!account && <p className="muted small">Connect MetaMask first.</p>}
                {state.error && <p className="panel warn small">{state.error}</p>}
              </div>
            )}
            {open && <OpenReceipt receipt={receipt} vault={vault} />}
          </div>
        </div>
      </div>
    </section>
  )
}

const PILLS = {
  done: ['ok', 'Done'],
  refused: ['bad', 'Refused'],
  failed: ['plain', 'Failed'],
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
        {shown.map((item, i) => (
          <li key={item.root} style={{ animationDelay: `${Math.min(i, 6) * 60}ms` }}>
            <span className={`pill ${PILLS[item.outcome]?.[0] ?? 'ok'}`}>{PILLS[item.outcome]?.[1] ?? 'Done'}</span>
            <a href={`#receipt/${item.root}`} target="_blank" rel="noreferrer">Open the receipt</a>
            <a href={`${EXPLORER}/tx/${item.hash}`} target="_blank" rel="noreferrer">Etherscan</a>
            <span className="when">{when(item.savedAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
