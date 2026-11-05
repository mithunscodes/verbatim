import { useState } from 'react'
import { planFor, understandSentence } from './ai.js'
import { describeStep } from './intent.js'
import Proof from './Proof.jsx'

const MAX_ANSWERS = 3

export default function Say({ vault, onUse, busy }) {
  const [text, setText] = useState('')
  const [reply, setReply] = useState('')
  const [state, setState] = useState({ status: 'idle', turns: [] })

  const ask = async (turns) => {
    setState((s) => ({ ...s, status: 'thinking', turns }))
    try {
      const answer = await understandSentence(vault, text.trim(), turns)
      setState({ status: 'done', turns, answer, plan: planFor(vault, answer.result) })
    } catch (error) {
      setState((s) => ({ ...s, status: 'error', error: error.message }))
    }
  }

  const start = () => {
    setReply('')
    ask([])
  }

  const answerQuestions = () => {
    const turns = [...state.turns, { answer: reply.trim(), previous: state.answer.result }]
    setReply('')
    ask(turns)
  }

  const { answer, plan } = state
  const thinking = state.status === 'thinking'
  const questions = answer?.result.questions ?? []
  const canUse = Boolean(plan) && !questions.length && !plan.problems.length && plan.checks.length > 0

  return (
    <section className="card">
      <h2>Say it in your own words</h2>
      <p className="muted small">
        A sealed AI on 0G turns your sentence into checks. It never picks addresses or prices: those come from your
        contacts and the fair price. Your vault enforces the checks.
      </p>
      <textarea
        className="sentence"
        rows={3}
        placeholder="Swap 10 USDC for ETH at a fair price, send 2 USDC to mom.eth, and nothing else."
        value={text}
        disabled={thinking || busy}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <button onClick={start} disabled={!text.trim() || thinking || busy}>Understand</button>
        {state.status === 'done' && <span className="muted small">Answered in {(answer.latencyMs / 1000).toFixed(1)} s</span>}
      </div>

      {thinking && <p className="muted">The sealed AI is reading it… usually about 10 seconds, sometimes up to 40.</p>}
      {state.status === 'error' && <p className="error">{state.error}</p>}

      {state.status === 'done' && (
        <>
          {answer.result.steps.length > 0 && (
            <>
              <h3>I understood</h3>
              <ul className="understood">
                {answer.result.steps.map((step, i) => <li key={i}>{describeStep(step)}</li>)}
                {answer.result.nothingElse && <li>Nothing else</li>}
                {answer.result.riskLimitPercent !== null && <li>You accept up to {answer.result.riskLimitPercent}% price impact</li>}
              </ul>
            </>
          )}
          {questions.length > 0 && (
            <div className="questions">
              <h3>A question first</h3>
              <ul>
                {questions.map((q, i) => <li key={i}>{q}</li>)}
              </ul>
              {state.turns.length < MAX_ANSWERS ? (
                <div className="row">
                  <input placeholder="Your answer" value={reply} onChange={(e) => setReply(e.target.value)} disabled={thinking} />
                  <button className="secondary" onClick={answerQuestions} disabled={!reply.trim() || thinking}>Answer</button>
                </div>
              ) : (
                <p className="muted small">Please write the whole request again, more clearly.</p>
              )}
            </div>
          )}
          {plan.problems.map((problem, i) => <p key={i} className="error small">{problem}</p>)}
          <Proof proof={answer.proof} />
          <button onClick={() => onUse({ sentence: text.trim(), answer, plan })} disabled={!canUse || busy}>Use these checks</button>
        </>
      )}
    </section>
  )
}
