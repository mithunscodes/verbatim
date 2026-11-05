import { useState } from 'react'
import { encodeFunctionData, erc20Abi, zeroAddress } from 'viem'
import { planFor, understandSentence } from './ai.js'
import { EXPLORER } from './config.js'
import { ATTACKS, attackRequest, resultOf, sendTry, sentenceRequest, sentenceVault, tokenAmount } from './demo.js'
import { formatDuration } from './format.js'
import { describeStep } from './intent.js'
import Proof, { Recorded } from './Proof.jsx'

const DEADLINE_HOUR = 3600

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
    return (
      <p className={`attack-outcome small ${result.reason === attack.expected ? 'refused' : 'unexpected'}`}>
        ✗ Refused: "{result.reason}". Nothing moved. <TxLink hash={result.hash} />
      </p>
    )
  }
  return <p className="attack-outcome unexpected small">⚠️ It went through. <TxLink hash={result.hash} /></p>
}

async function copy(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return true
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const ok = document.execCommand('copy')
  area.remove()
  return ok
}

function CopyButton({ label, text }) {
  const [copied, setCopied] = useState(null)
  const onCopy = async () => setCopied(await copy(text).catch(() => false))
  return (
    <span className="copy">
      <button className="secondary" onClick={onCopy}>{label}</button>
      {copied === true && <span className="pass small"> Copied</span>}
      {copied === false && <code className="copy-text">{text}</code>}
    </span>
  )
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

function Sentence({ clients, scene, balances, disabled, onBusy }) {
  const [text, setText] = useState('')
  const [state, setState] = useState({ status: 'idle' })
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
    setState({ status: 'sending', answer, plan })
    try {
      const { hash } = await sendTry(clients, sentenceRequest(scene, plan))
      setState({ status: 'waiting', answer, plan, hash })
      setState({ status: 'done', answer, plan, result: await resultOf(clients.reader, hash) })
    } catch (e) {
      setState({ status: 'error', answer, plan, error: problem(e) })
    }
    onBusy(false)
  }

  const { answer, plan } = state
  const steps = answer?.result.steps ?? []
  const questions = answer?.result.questions ?? []
  const onlySends = steps.every((step) => step.type === 'send')
  const canSend = Boolean(plan) && state.status === 'understood' && onlySends && !questions.length && !plan.problems.length && plan.sends.length > 0

  return (
    <section className="card">
      <h2>4. Say it in your own words</h2>
      <p className="muted small">
        A sealed AI on 0G turns your sentence into steps. It never picks addresses: those come from the saved contacts. Then the
        vault's standing rules still apply. Here, sentences can only send.
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
          {steps.length > 0 && (
            <>
              <h3>It understood</h3>
              <ul className="understood">
                {steps.map((step, i) => <li key={i}>{describeStep(step)}</li>)}
              </ul>
            </>
          )}
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
          {plan?.problems.map((p, i) => <p key={i} className="error small">{p}</p>)}
          <Proof proof={answer.proof} />
          {plan?.checks.length > 0 && (
            <p className="muted small">
              Checks: {plan.checks.map((check) => (check.kind === 0 ? `at most ${tokenAmount(scene, check.amount)} leaves` : `exactly ${tokenAmount(scene, check.amount)} to ${scene.contactName ?? 'the contact'}`)).join(', ')}
            </p>
          )}
          <button onClick={send} disabled={!canSend || disabled}>Send it</button>
        </>
      )}
      {state.status === 'sending' && <p className="muted small">Signing and sending…</p>}
      {state.status === 'waiting' && <p className="muted small">⏳ Sent, waiting for Sepolia… <TxLink hash={state.hash} /></p>}
      {state.status === 'done' && (
        <p className={`attack-outcome small ${state.result.ok ? 'done' : 'refused'}`}>
          {state.result.ok ? '✓ Done: the standing rules allowed it.' : `✗ Refused: "${state.result.reason}". Nothing moved.`}{' '}
          <TxLink hash={state.result.hash} />
        </p>
      )}
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
