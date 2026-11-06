import { useEffect, useMemo, useState } from 'react'
import { planFor, understandSentence } from './ai.js'
import { nameOf } from './checks.js'
import { formatMoment } from './format.js'
import { Dots, Words } from './Motion.jsx'
import Proof from './Proof.jsx'
import WordTiles from './Tiles.jsx'
import { LeftOut, StepList } from './Words.jsx'
import { untraced } from './words.js'

const MAX_ANSWERS = 3

const SAMPLE_MS = 3000

const SAMPLE_OUT_MS = 400

const MINT_WORDS = /\b(draw|mint|nft|picture|image|paint)\w*/i

function samplesFor(vault) {
  const names = vault.contacts
    .filter((contact) => !contact.moved)
    .map((contact) => nameOf(vault, contact.address))
    .filter((name) => !name.startsWith('0x'))
  const [first, second] = [names[0] ?? 'mom.eth', names[1] ?? names[0] ?? 'alice.eth']
  return [
    `Swap 10 USDC for ETH at a fair price, send 2 USDC to ${first}, and nothing else.`,
    `Send 5 USDC to ${second}, and nothing else.`,
    'Swap half my USDC for ETH, and lose at most 1% on the price.',
    `Send 0.01 ETH to ${first}.`,
    'Swap 25 USDC for ETH at a fair price, and nothing else.',
  ]
}

function Sample({ samples }) {
  const [state, setState] = useState({ index: 0, leaving: false })
  useEffect(() => {
    const out = setTimeout(() => setState((s) => ({ ...s, leaving: true })), SAMPLE_MS - SAMPLE_OUT_MS)
    const next = setTimeout(() => setState((s) => ({ index: (s.index + 1) % samples.length, leaving: false })), SAMPLE_MS)
    return () => {
      clearTimeout(out)
      clearTimeout(next)
    }
  }, [state.index, samples.length])
  return (
    <span key={state.index} className={state.leaving ? 'sample out' : 'sample'} aria-hidden="true">
      <Words text={samples[state.index % samples.length]} step={28} />
    </span>
  )
}

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
    const lower = text.toLowerCase()
    const moved = vault.contacts
      .filter((contact) => contact.moved)
      .map((contact) => ({ contact, name: nameOf(vault, contact.address) }))
      .find(({ name }) => !name.startsWith('0x') && lower.includes(name.toLowerCase()))
    if (moved) {
      const error = moved.contact.ended
        ? `⚠ ${moved.name} ended at ${formatMoment(moved.contact.end.endsAt)}. Payments to it never happen until your phone renews it.`
        : `⚠ ${moved.name} now points to a new address, so sends to it are stopped. Approve the new address first, or put the name back.`
      setState({ status: 'error', turns: [], error })
      return
    }
    ask([])
  }

  const answerQuestions = () => {
    const turns = [...state.turns, { answer: reply.trim(), previous: state.answer.result }]
    setReply('')
    ask(turns)
  }

  const edit = () => setState({ status: 'idle', turns: [] })

  const samples = useMemo(() => samplesFor(vault), [vault])

  const { answer, plan } = state
  const thinking = state.status === 'thinking'
  const done = state.status === 'done'
  const questions = answer?.result.questions ?? []
  const leftOut = answer?.result.leftOut ?? []
  const traced = Boolean(answer) && untraced(answer.result) === 0
  const canUse = Boolean(plan) && !questions.length && !leftOut.length && traced && !plan.problems.length && plan.checks.length > 0
  const showTiles = Boolean(answer) && (done || (thinking && state.turns.length > 0))

  return (
    <>
      <section className="card say">
        {thinking && <div className="scan" aria-hidden="true"><span /></div>}
        <div className="say-head">
          <span className="eyebrow">In your own words</span>
          {done && (
            <span className="muted small">
              Read in {(answer.latencyMs / 1000).toFixed(1)} s{answer.paidBy === 'your 0G account' && ', paid by your 0G account'}
            </span>
          )}
        </div>
        {showTiles ? (
          <WordTiles key={`${answer.sentence ?? text}-${state.turns.length}`} sentence={answer.sentence ?? text.trim()} result={answer.result} />
        ) : (
          <div className="sentence-box">
            {!text && !thinking && <Sample samples={samples} />}
            <textarea
              className="sentence"
              rows={3}
              aria-label="Your request, in your own words"
              value={text}
              disabled={thinking || busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                e.preventDefault()
                if (text.trim() && !busy) start()
              }}
            />
          </div>
        )}
        {thinking && (
          <p className="reading">
            A sealed AI on 0G is reading your words <Dots />
            <span className="muted small">usually about 10 seconds, sometimes up to 40</span>
          </p>
        )}
        {!thinking && (
          <div className="send-row">
            {done ? (
              <button className="secondary" onClick={edit} disabled={busy}>Change my words</button>
            ) : (
              <button className="big" onClick={start} disabled={!text.trim() || busy}>Read my words</button>
            )}
          </div>
        )}
        {!done && MINT_WORDS.test(text) && (
          <p className="panel small">
            Want to draw a picture and mint it as an NFT? <a href="#mint">Open the Mint page</a>
          </p>
        )}
        {state.status === 'error' && <p className="panel warn">{state.error}</p>}
      </section>

      {done && (
        <section className="card">
          {answer.result.steps.length > 0 && (
            <>
              <h3>I understood</h3>
              <StepList result={answer.result} />
            </>
          )}
          <LeftOut result={answer.result} />
          {!traced && (
            <p className="panel warn small">
              Part of this couldn't be matched to your exact words, so it can't be used. Please write the request again.
            </p>
          )}
          {questions.length > 0 && (
            <div className="questions">
              <h3>A question first</h3>
              <ul>
                {questions.map((q, i) => <li key={i}>{q}</li>)}
              </ul>
              {state.turns.length < MAX_ANSWERS ? (
                <div className="row">
                  <input
                    placeholder="Your answer"
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && reply.trim() && !thinking && answerQuestions()}
                    disabled={thinking}
                  />
                  <button className="secondary" onClick={answerQuestions} disabled={!reply.trim() || thinking}>Answer</button>
                </div>
              ) : (
                <p className="muted small">Please write the whole request again, more clearly.</p>
              )}
            </div>
          )}
          {plan.problems.map((problem, i) => <p key={i} className="panel warn small">{problem}</p>)}
          <Proof proof={answer.proof} />
          <div className="actions">
            <button className="big" onClick={() => onUse({ sentence: answer.sentence ?? text.trim(), answer, plan })} disabled={!canUse || busy}>
              Use these checks
            </button>
          </div>
        </section>
      )}
    </>
  )
}
