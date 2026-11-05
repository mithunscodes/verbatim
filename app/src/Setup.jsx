import { useEffect, useState } from 'react'
import { parseUnits, zeroAddress } from 'viem'
import { checkEnsName, getWallet, normalName } from './chain.js'
import { DEMO_TIMINGS, PRICE_SOURCE, vaultAbi } from './config.js'
import { holdingOf } from './checks.js'
import { amountPattern, formatAmount, formatDuration, shortAddress } from './format.js'
import { Check } from './Motion.jsx'
import TxStatus from './TxStatus.jsx'

function Mark({ done }) {
  return done ? <Check size={26} /> : <span className="circle" />
}

function LimitStep({ title, note, holding, current, onSet, disabled }) {
  const [text, setText] = useState('')
  const trimmed = text.trim()
  const valid = amountPattern(holding.decimals).test(trimmed)
  return (
    <li className={current > 0n ? 'step is-done' : 'step'}>
      <div className="step-head">
        <span><Mark done={current > 0n} />{title}</span>
        <span className="muted small">Now: {formatAmount(current, holding.decimals)} {holding.symbol}</span>
      </div>
      <p className="muted small">{note}</p>
      <div className="row">
        <input inputMode="decimal" placeholder="0" value={text} onChange={(e) => setText(e.target.value)} />
        <span className="muted">{holding.symbol}</span>
        <button className="secondary" disabled={disabled || !valid} onClick={() => onSet(parseUnits(trimmed, holding.decimals))}>
          Set
        </button>
      </div>
    </li>
  )
}

function EnsNameStep({ vault, disabled, onSet }) {
  const [text, setText] = useState('')
  const [check, setCheck] = useState({ name: null, status: 'idle' })
  const name = text.trim() ? normalName(text) : null
  useEffect(() => {
    if (!name) return undefined
    let current = true
    setCheck({ name, status: 'reading' })
    const timer = setTimeout(() => {
      checkEnsName(getWallet(), vault, name)
        .then((result) => current && setCheck({ name, status: 'done', ...result }))
        .catch(() => current && setCheck({ name, status: 'failed' }))
    }, 400)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [name, vault])
  const result = check.name === name ? check : { status: 'reading' }
  const message = !text.trim() ? null
    : !name ? "That isn't a valid ENS name"
    : result.status === 'reading' ? `Reading ${name}…`
    : result.status === 'failed' ? "Couldn't read this name. Try again."
    : !result.resolver ? 'This name has no genuine ENS resolver'
    : !result.canWrite ? "Your vault can't write to this name yet. Set the name up for this vault first (to-do.md, step J2)."
    : `Your vault will write your rules, pending changes and contacts to ${name}.`
  const ready = result.status === 'done' && result.canWrite
  return (
    <li className={vault.ensName ? 'step is-done' : 'step'}>
      <div className="step-head">
        <span><Mark done={Boolean(vault.ensName)} />Your ENS name (recommended, first)</span>
        <span className="muted small">{vault.ensName ? `Now: ${vault.ensName}` : 'Not set'}</span>
      </div>
      <p className="muted small">
        Your rules then live in ENS, where anyone can check them, and only your vault can change them. Set it before the
        other steps, so they're written there too.
      </p>
      {!vault.ensName && (
        <div className="row">
          <input className="address" placeholder="yourname.eth" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="secondary" disabled={disabled || !ready} onClick={() => onSet(name)}>Set</button>
        </div>
      )}
      {message && !vault.ensName && <p className={ready ? 'panel ok small' : 'panel warn small'}>{message}</p>}
    </li>
  )
}

export default function Setup({ vault, isRules, tx, send, busy }) {
  const target = { address: vault.address, abi: vaultAbi }
  const usdc = vault.holdings.find((h) => h.token !== zeroAddress)
  const eth = holdingOf(vault, zeroAddress)
  const disabled = !isRules || busy
  const demoSet =
    vault.looseningWait === DEMO_TIMINGS.looseningWait &&
    vault.newContactPeriod === DEMO_TIMINGS.newContactPeriod &&
    vault.allowanceMinAge === DEMO_TIMINGS.allowanceMinAge
  const priceSet = vault.priceSource.toLowerCase() === PRICE_SOURCE.toLowerCase()
  const hasPrice = vault.priceSource !== zeroAddress

  const setDemoTimings = async () => {
    if (!(await send('Demo wait (1 of 3)', target, 'setLooseningWait', [DEMO_TIMINGS.looseningWait]))) return
    if (!(await send('Demo new-contact time (2 of 3)', target, 'setNewContactPeriod', [DEMO_TIMINGS.newContactPeriod]))) return
    await send('Demo allowance age (3 of 3)', target, 'setAllowanceMinAge', [DEMO_TIMINGS.allowanceMinAge])
  }

  return (
    <section className="card">
      <h2>Set up your vault</h2>
      <p className="muted small">
        Until setup is finished, nothing can be sent. Each step is one confirm in MetaMask. Leave its "Added protection" switch off.
      </p>
      <TxStatus tx={tx} />
      <ol className="steps">
        {vault.directory && (
          <EnsNameStep vault={vault} disabled={disabled} onSet={(name) => send(`Your ENS name: ${name}`, target, 'setEnsName', [name])} />
        )}
        {usdc && (
          <LimitStep
            title={`Daily limit for ${usdc.symbol} (needed)`}
            note={`Nothing can leave without a limit. For the demo: 100.`}
            holding={usdc}
            current={usdc.dailyLimit}
            disabled={disabled}
            onSet={(amount) => send(`Daily limit ${formatAmount(amount, usdc.decimals)} ${usdc.symbol}`, target, 'setDailyLimit', [usdc.token, amount])}
          />
        )}
        <LimitStep
          title="Daily limit for ETH (optional)"
          note="Without it, no ETH can leave. For the demo: 0.01."
          holding={eth}
          current={eth.dailyLimit}
          disabled={disabled}
          onSet={(amount) => send(`Daily limit ${formatAmount(amount, eth.decimals)} ETH`, target, 'setDailyLimit', [zeroAddress, amount])}
        />
        {usdc && (
          <LimitStep
            title={`Limit for a new contact's first ${formatDuration(vault.newContactPeriod)} (optional)`}
            note="Without it, a brand-new contact can't receive anything at first. For the demo: 50."
            holding={usdc}
            current={usdc.newContactLimit}
            disabled={disabled}
            onSet={(amount) => send(`New-contact limit ${formatAmount(amount, usdc.decimals)} ${usdc.symbol}`, target, 'setNewContactLimit', [usdc.token, amount])}
          />
        )}
        <li className={hasPrice ? 'step is-done' : 'step'}>
          <div className="step-head">
            <span><Mark done={hasPrice} />Fair-price source (needed, for swaps)</span>
            <span className="muted small mono">{shortAddress(PRICE_SOURCE)}</span>
          </div>
          <p className="muted small">
            Every swap is checked against a fair price. Adding one after setup needs a proposal and a wait.
          </p>
          <button className="secondary" disabled={disabled || priceSet} onClick={() => send('Price source', target, 'setPriceSource', [PRICE_SOURCE])}>
            Use Verbatim's price reader
          </button>
        </li>
        <li className={demoSet ? 'step is-done' : 'step'}>
          <div className="step-head">
            <span><Mark done={demoSet} />Short demo waiting times (optional)</span>
            <span className="muted small">Now: {formatDuration(vault.looseningWait)} wait</span>
          </div>
          <p className="muted small">
            A {formatDuration(DEMO_TIMINGS.looseningWait)} wait instead of a day, new contacts for {formatDuration(DEMO_TIMINGS.newContactPeriod)}, and
            allowances for contacts older than {formatDuration(DEMO_TIMINGS.allowanceMinAge)}. Three confirms.
          </p>
          <button className="secondary" disabled={disabled || demoSet} onClick={setDemoTimings}>Use demo times</button>
        </li>
        <li className="step">
          <div className="step-head">
            <span><Mark done={false} />Finish setup (needed, last)</span>
          </div>
          <p className="muted small">
            After this, your phone can only tighten rules straight away. Loosening them needs a proposal, your approval
            and a wait.
          </p>
          <button className="big" disabled={disabled || (usdc && usdc.dailyLimit === 0n) || !hasPrice} onClick={() => send('Finish setup', target, 'finishSetup', [])}>
            Finish setup
          </button>
        </li>
      </ol>
    </section>
  )
}
