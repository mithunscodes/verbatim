import { useState } from 'react'
import { encodeFunctionData, erc20Abi, zeroAddress } from 'viem'
import { planFor, understandSentence } from './ai.js'
import { EXPLORER } from './config.js'
import { ATTACKS, attackRequest, resultOf, sendTry, sentenceRequest, sentenceVault, tokenAmount } from './demo.js'
import { describeCheck } from './checks.js'
import { formatDuration, shortAddress } from './format.js'
import { CopyButton } from './Copy.jsx'
import Proof, { Recorded } from './Proof.jsx'
import { FromWords, LeftOut, StepList, YourWords } from './Words.jsx'
import { asSentence, explainRefusal, saidFor, untraced } from './words.js'

const DEADLINE_HOUR = 3600
const TOO_MANY_WAITING = 'Too many changes waiting for your phone'

function TxLink({ hash }) {
  return (
    <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">
      Open on Etherscan ↗
    </a>
  )
}

function problem(error) {
  return error?.shortMessage || error?.message || 'Something went wrong.'
}

function expectedWords(attack) {
  return attack.expected === 'proposed' ? "⏳ Proposed, waiting for the owner's phone" : `✗ "${attack.expected}"`
}

function Outcome({ attack, state, scene }) {
  if (state.status === 'sending') return <p className="muted small">Signing and sending…</p>
  if (state.status === 'waiting') return <p className="muted small">⏳ Sent, waiting for Sepolia… <TxLink hash={state.hash} /></p>
  if (state.status === 'error') return <p className="error small">✗ {state.error}</p>
  const { result } = state
  if (attack.expected === 'proposed' && result.ok) {
    return (
      <p className="attack-outcome waiting-change small">
        ⏳ Proposed. It waits for the owner's phone. Even if the phone approves, it waits {formatDuration(scene.looseningWait)} before
        it can switch on (a day outside the demo). <TxLink hash={result.hash} />
      </p>
    )
  }
  if (!result.ok) {
    const capped = attack.expected === 'proposed' && result.reason === TOO_MANY_WAITING
    return (
      <p className={`attack-outcome small ${result.reason === attack.expected || capped ? 'refused' : 'unexpected'}`}>
        ✗ Refused: "{result.reason}". Nothing moved.{capped && ' Cancel the waiting changes on the phone page to propose again.'}{' '}
        {attack.id === 'fakeRouter' && scene.routerName && (
          <>
            ENS says Uniswap's router is <strong>{scene.routerName}</strong> → {shortAddress(scene.routerAddress)}, read from ENSv2 by
            the vault itself. The thief's router isn't listed, so it was never called.{' '}
          </>
        )}
        <TxLink hash={result.hash} />
      </p>
    )
  }
  return <p className="attack-outcome unexpected small">⚠️ It went through. <TxLink hash={result.hash} /></p>
}

function Attacks({ clients, scene, balances, disabled, onBusy }) {
  const [states, setStates] = useState({})
  const set = (id, state) => setStates((current) => ({ ...current, [id]: state }))

  const tryAttack = async (attack) => {
    onBusy(true)
    set(attack.id, { status: 'sending' })
    try {
      const { hash } = await sendTry(clients, attackRequest(scene, balances, attack.id))
      set(attack.id, { status: 'waiting', hash })
      set(attack.id, { status: 'done', result: await resultOf(clients.reader, hash) })
    } catch (e) {
      set(attack.id, { status: 'error', error: problem(e) })
    }
    onBusy(false)
  }

  return (
    <section className="card">
      <h2>3. Attack the vault yourself</h2>
      <p className="muted small">
        Each button sends a real transaction with the stolen key, and you write the vault's checks yourself. Refused ones still
        land on Sepolia, so each has an Etherscan link.
      </p>
      <ul className="attacks">
        {ATTACKS.map((attack) => (
          <li key={attack.id}>
            <div className="attack-head">
              <div>
                <strong>{attack.title}</strong>
                <p className="muted small">Expected: {expectedWords(attack)}</p>
              </div>
              <button className="secondary" disabled={disabled} onClick={() => tryAttack(attack)}>Try it</button>
            </div>
            {states[attack.id] && <Outcome attack={attack} state={states[attack.id]} scene={scene} />}
          </li>
        ))}
        <li>
          <div className="attack-head">
            <div>
              <strong>Burn the vault's money on fees</strong>
              <p className="muted small">Expected: ✗ The vault pays no fees</p>
            </div>
          </div>
          <p className="small">
            Every fee is paid by the key's own test ETH, never by the vault. Check any refused transaction above: Etherscan's
            "Transaction Fee" comes from{' '}
            <a href={`${EXPLORER}/address/${scene.everydayKey}`} target="_blank" rel="noreferrer">the key's address ↗</a>, and{' '}
            <a href={`${EXPLORER}/address/${scene.vault}`} target="_blank" rel="noreferrer">the vault's own page ↗</a> never pays
            one. So a thief can only burn the key's few cents of test ETH.
          </p>
        </li>
      </ul>
    </section>
  )
}

function SentenceOutcome({ state, vault, said }) {
  const { result } = state
  if (result.ok) {
    return (
      <p className="attack-outcome small done">
        ✓ Done, exactly as you said: the standing rules allowed it. <TxLink hash={result.hash} />
      </p>
    )
  }
  const why = result.failure ? explainRefusal(result.failure, vault, state.plan.checks, said) : result.reason
  return (
    <p className="attack-outcome small refused">
      ✗ Refused{state.hacked ? ' (the hacked app sent more than you said)' : ''}: {asSentence(why)} Nothing moved. <TxLink hash={result.hash} />
    </p>
  )
}

function Sentence({ clients, scene, balances, disabled, onBusy }) {
  const [text, setText] = useState('')
  const [state, setState] = useState({ status: 'idle' })
  const [hacked, setHacked] = useState(false)
  const vault = sentenceVault(scene, balances)

  const understand = async () => {
    setState({ status: 'thinking' })
    try {
      const answer = await understandSentence(vault, text.trim(), [])
      setState({ status: 'understood', answer, plan: planFor(vault, answer.result) })
    } catch (e) {
      setState({ status: 'error', error: problem(e) })
    }
  }

  const send = async () => {
    onBusy(true)
    const { answer, plan } = state
    setState({ status: 'sending', answer, plan, hacked })
    try {
      const { hash } = await sendTry(clients, sentenceRequest(scene, plan, hacked))
      setState({ status: 'waiting', answer, plan, hacked, hash })
      setState({ status: 'done', answer, plan, hacked, result: await resultOf(clients.reader, hash) })
    } catch (e) {
      setState({ status: 'error', answer, plan, error: problem(e) })
    }
    onBusy(false)
  }

  const { answer, plan } = state
  const steps = answer?.result.steps ?? []
  const questions = answer?.result.questions ?? []
  const leftOut = answer?.result.leftOut ?? []
  const said = answer && plan ? saidFor(answer.result, plan.origins) : null
  const onlySends = steps.every((step) => step.type === 'send')
  const traced = Boolean(answer) && untraced(answer.result) === 0
  const canSend = Boolean(plan) && state.status === 'understood' && onlySends && traced && !questions.length && !leftOut.length
    && !plan.problems.length && plan.sends.length > 0

  return (
    <section className="card">
      <h2>4. Say it in your own words</h2>
      <p className="muted small">
        A sealed AI on 0G turns your sentence into steps, and each check quotes the words it came from. It never picks
        addresses: those come from the saved contacts. Then the vault's standing rules still apply. Here, sentences can only send.
      </p>
      <textarea
        className="sentence"
        rows={3}
        placeholder={`Send all my USDC to ${scene.contactName ?? 'my contact'}, then 5 more to 0x1234…`}
        value={text}
        disabled={state.status === 'thinking'}
        onChange={(e) => setText(e.target.value)}
      />
      <button onClick={understand} disabled={!text.trim() || state.status === 'thinking' || disabled}>Understand</button>
      {state.status === 'thinking' && <p className="muted">The sealed AI is reading it… usually about 10 seconds, sometimes up to 40.</p>}
      {answer && (
        <>
          <Recorded recorded={answer.recorded} />
          <YourWords sentence={answer.sentence ?? text.trim()} result={answer.result} />
          {steps.length > 0 && (
            <>
              <h3>It understood</h3>
              <StepList result={answer.result} />
            </>
          )}
          <LeftOut result={answer.result} />
          {questions.length > 0 && (
            <div className="questions">
              <h3>It asked instead of guessing</h3>
              <ul>
                {questions.map((q, i) => <li key={i}>{q}</li>)}
              </ul>
              <p className="muted small">Nothing can be sent until it's clear. Write the request again to try something else.</p>
            </div>
          )}
          {!onlySends && <p className="error small">Here, sentences can only send. Swaps are in the main app.</p>}
          {!traced && <p className="error small">Part of this couldn't be matched to your exact words, so it can't be sent.</p>}
          {plan?.problems.map((p, i) => <p key={i} className="error small">{p}</p>)}
          <Proof proof={answer.proof} />
          {plan?.checks.length > 0 && (
            <>
              <h3>The vault's checks</h3>
              <ul className="checks compact">
                {plan.checks.map((check, i) => {
                  const { icon, text: line } = describeCheck(vault, check)
                  return (
                    <li key={i}>
                      <span className="icon">{icon}</span>
                      <span>
                        {line}
                        <FromWords words={said?.perCheck?.[i]} />
                      </span>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
          <label className="switch">
            <input type="checkbox" checked={hacked} onChange={(e) => setHacked(e.target.checked)} disabled={state.status !== 'understood'} />
            <span>Hacked app: keep these checks, but secretly send 1 {scene.symbol} more than you said</span>
          </label>
          <button onClick={send} disabled={!canSend || disabled}>{hacked ? 'Send it through the hacked app' : 'Send it'}</button>
        </>
      )}
      {state.status === 'sending' && <p className="muted small">Signing and sending…</p>}
      {state.status === 'waiting' && <p className="muted small">⏳ Sent, waiting for Sepolia… <TxLink hash={state.hash} /></p>}
      {state.status === 'done' && <SentenceOutcome state={state} vault={vault} said={said} />}
      {state.status === 'error' && <p className="error small">✗ {state.error}</p>}
    </section>
  )
}

function EtherscanGuide({ demo, scene, balances }) {
  const amount = balances.vault
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [demo.thief, amount] })
  const actions = `[["${scene.token}",0,"${data}",0]]`
  const checks = `[[0,"${scene.token}","${zeroAddress}",${amount}],[2,"${scene.token}","${demo.thief}",${amount}]]`
  const deadline = String(Math.floor(Date.now() / 1000) + DEADLINE_HOUR)
  return (
    <details className="fold card">
      <summary>Do it yourself on Etherscan, without our app</summary>
      <ol className="small">
        <li>
          In MetaMask (the phone app or the browser extension), choose <strong>Add account</strong>, then <strong>Import account</strong>,
          and paste this test key. It's handed out on purpose and holds test money only. <CopyButton label="Copy the key" text={demo.key} />
        </li>
        <li>Switch MetaMask to the <strong>Sepolia</strong> test network.</li>
        <li>
          Open the vault's{' '}
          <a href={`${EXPLORER}/address/${scene.vault}#writeContract`} target="_blank" rel="noreferrer">Write Contract page on Etherscan ↗</a>{' '}
          and tap <strong>Connect to Web3</strong>. The code is verified, so you can read exactly what it does.
        </li>
        <li>
          Try <strong>saveContact</strong> with your address <CopyButton label="Copy your address" text={demo.thief} />. Expected: "Only the
          rules key can save contacts".
        </li>
        <li>
          Or try <strong>run</strong> with these three values, which send all {tokenAmount(scene, amount)} to you, with your own checks.
          Expected: "Not a saved contact".
          <span className="copy-row">
            <CopyButton label="Copy actions" text={actions} />
            <CopyButton label="Copy checks" text={checks} />
            <CopyButton label="Copy deadline (1 hour)" text={deadline} />
          </span>
        </li>
        <li>
          MetaMask may warn that it will fail. Send it anyway: the refusal is the point. The laptop screen shows it too, because it
          watches the key, not our app.
        </li>
      </ol>
    </details>
  )
}

export default function Console({ clients, demo, scene, balances, disabled, onBusy }) {
  return (
    <>
      <Attacks clients={clients} scene={scene} balances={balances} disabled={disabled} onBusy={onBusy} />
      <Sentence clients={clients} scene={scene} balances={balances} disabled={disabled} onBusy={onBusy} />
      <EtherscanGuide demo={demo} scene={scene} balances={balances} />
    </>
  )
}
