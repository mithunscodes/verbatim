import { useEffect, useState } from 'react'
import { previewTransaction } from './ai.js'
import { Check, Dots } from './Motion.jsx'
import Proof from './Proof.jsx'

const PREVIEW_DELAY_MS = 800

export default function Preview({ vault, sentence, actions, previewKey }) {
  const [state, setState] = useState({ status: 'idle' })
  const [round, setRound] = useState(0)

  useEffect(() => {
    if (!actions?.length || !sentence) return undefined
    let current = true
    setState({ status: 'reading' })
    const timer = setTimeout(() => {
      previewTransaction(vault, sentence, actions)
        .then((result) => current && setState({ status: 'done', ...result }))
        .catch((error) => current && setState({ status: 'error', error: error.message }))
    }, PREVIEW_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [previewKey, round])

  if (state.status === 'idle') return null
  const { verdict } = state
  return (
    <div className="preview">
      <h3>Live preview, checked by the sealed AI</h3>
      {state.status === 'reading' && <p className="reading">Reading what this transaction would really do <Dots /></p>}
      {state.status === 'error' && <p className="panel warn small">Couldn't preview it: {state.error}</p>}
      {state.status === 'done' && (
        <>
          {verdict ? (
            verdict.matches ? (
              <p className="pass"><Check size={26} />This matches what you said.</p>
            ) : (
              <div className="mismatch">
                <p className="extra-title"><span className="level-dot risky" /><strong>This doesn't match what you said</strong></p>
                <ul>
                  {verdict.differences.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              </div>
            )
          ) : (
            <p className="muted small">{state.problem ?? "The sealed AI didn't answer."} Here is what the simulation saw.</p>
          )}
          <Proof proof={state.proof} />
          <details className="fold">
            <summary>Details</summary>
            {verdict?.lines.length > 0 && (
              <ul className="muted small">
                {verdict.lines.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            )}
            <p className="muted small">What the simulation saw:</p>
            <ul className="muted small">
              {state.facts.map((fact, i) => <li key={i}>{fact}</li>)}
            </ul>
            <p className="muted small">
              A preview is only a warning: clever attacks can behave nicely in a preview. Your vault's checks on the real result
              are the guarantee.
            </p>
          </details>
        </>
      )}
      {state.status !== 'reading' && (
        <button className="link small" onClick={() => setRound((n) => n + 1)}>Check again</button>
      )}
    </div>
  )
}
