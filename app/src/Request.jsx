import { useEffect, useMemo, useRef, useState } from 'react'
import { parseUnits, zeroAddress } from 'viem'
import { DEMO_STRANGER, EXPLORER, QUOTE_REFRESH_MS, SHOWN_DIGITS, SWAP_SLIPPAGE_BPS } from './config.js'
import { getWallet } from './chain.js'
import {
  ALWAYS_ON,
  canSwap,
  CheckKind,
  classifyFailure,
  describeAction,
  describeCheck,
  describeExtra,
  describeFailure,
  describeOutcome,
  holdingOf,
  nameOf,
  rulesFor,
  sendChecks,
  swapChecks,
} from './checks.js'
import { amountPattern, formatAbout, formatAmount, shortAddress } from './format.js'
import { formSentence, previewKey } from './ai.js'
import Say from './Say.jsx'
import Preview from './Preview.jsx'
import { ReceiptBox } from './Receipt.jsx'
import ChainProof from './ChainProof.jsx'
import { brokenRule, Caught } from './Caught.jsx'
import { Check, Cross, Spinner, useFlight, Words } from './Motion.jsx'
import WordTiles from './Tiles.jsx'
import { explainRefusal, saidFor, UNFAIR_TRADE } from './words.js'
import { compareToFair, describeRoute, useQuote } from './quotes.js'
import {
  extraActions,
  hackedExtra,
  newDeadline,
  practiceRun,
  sendActions,
  signAndSend,
  swapActions,
  waitForResult,
} from './run.js'

const KIND_NAMES = ['AtMostLeaves', 'AtLeastArrives', 'ExactlyTo']

const KIND_LABELS = ['Leaves your vault', 'Arrives', 'Goes to']

const PRACTICE_DELAY_MS = 400

function keyOf(request) {
  return JSON.stringify({ checks: request.checks, actions: request.actions }, (k, x) => (typeof x === 'bigint' ? x.toString() : x))
}

function readAmount(text, decimals) {
  const trimmed = text.trim()
  if (!trimmed) return { error: null }
  if (!amountPattern(decimals).test(trimmed)) return { error: 'Type an amount like 10 or 0.5' }
  const amount = parseUnits(trimmed, decimals)
  if (amount === 0n) return { error: 'The amount must be more than 0' }
  return { amount }
}

function noPriceSource(vault) {
  const how = vault.setupFinished
    ? "Setup is finished, so adding one now needs a proposal, the phone's approval and a wait."
    : 'Add one on the phone page, in the setup step "Fair-price source".'
  return `This vault has no fair-price source, so swaps can't be checked. ${how}`
}

const SWAP_SCENARIOS = [
  ['honest', 'Nothing hidden (an honest app)'],
  ['badRoute', 'Bad route: a thin pool with a worse price'],
  ['drain', 'Hacked app: hides a drain of your other USDC inside the swap'],
  ['fee', 'Small extra: a 0.25% app fee'],
  ['tip', "Risky extra: a 0.1 USDC tip to an address you haven't saved"],
  ['borrowed', 'Never allowed: runs borrowed code in your vault'],
]

const SEND_TRICKS = [
  ['more', '1 USDC (or 0.001 ETH) extra to the same contact'],
  ['stranger', "A hidden extra payment to an address you haven't saved"],
  ['replace', 'Your contact swapped for a stranger, behind the screen'],
]

const SWAP_TRICKS = {
  badRoute: 'it swaps through a thin pool with a worse price',
  drain: 'it hides a drain of your other USDC inside the swap',
  fee: 'it adds a 0.25% app fee',
  tip: "it adds a 0.1 USDC tip to an address you haven't saved",
  borrowed: 'it runs borrowed code inside your vault',
}

const SEND_TRICK_WORDS = {
  more: 'it sends 1 USDC (or 0.001 ETH) more to the same contact',
  stranger: "it adds a hidden payment to an address you haven't saved",
  replace: 'it swaps your contact for a stranger, in the payment and in the check',
}

function HackedRibbon({ demo, swapping, sending }) {
  const trick = swapping ? SWAP_TRICKS[demo.scenario] : sending ? SEND_TRICK_WORDS[demo.sendTrick] : 'it changes what your next request sends'
  return (
    <p className="hacked-ribbon" role="status">
      <strong>Demo: this app is now hacked.</strong> Behind the screen, {trick}. The screen looks exactly the same.
    </p>
  )
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

function hackedSend(vault, demo, send, i) {
  if (!demo.hacked || i > 0) return sendActions(send)
  const { decimals } = holdingOf(vault, send.token)
  if (demo.sendTrick === 'stranger') {
    return [...sendActions(send), ...sendActions({ token: send.token, amount: hackedExtra(send.token, decimals), to: DEMO_STRANGER })]
  }
  if (demo.sendTrick === 'replace') return sendActions({ ...send, to: DEMO_STRANGER })
  return sendActions({ ...send, amount: send.amount + hackedExtra(send.token, decimals) })
}

function rewrittenChecks(checks, demo, send) {
  if (!demo.hacked || demo.sendTrick !== 'replace' || !send) return null
  return checks.map((check) => (Number(check.kind) === CheckKind.ExactlyTo && same(check.token, send.token) && same(check.to, send.to)
    ? { ...check, to: DEMO_STRANGER }
    : check))
}

function scenarioProblem(vault, form, demo, amount) {
  if (demo.scenario === 'honest') return null
  if (form.from === zeroAddress) return 'This demo works for USDC → ETH only.'
  if (demo.scenario === 'drain' && amount >= holdingOf(vault, form.from).amount) {
    return "The hacked app has nothing extra to take, because you're swapping your whole balance."
  }
  return null
}

function swapAskFor(vault, form, demo, intent) {
  if (intent) {
    const [swap, more] = intent.plan.swaps
    if (!swap || more || !vault.fairPrice) return null
    const balance = demo.scenario === 'drain' ? holdingOf(vault, swap.from).amount : null
    return { swapper: vault.address, tokenIn: swap.from, tokenOut: swap.to, amount: swap.amount, scenario: demo.scenario, balance }
  }
  if (form.mode !== 'swap' || !vault.fairPrice || !canSwap(vault, form.from, form.swapTo)) return null
  const { amount } = readAmount(form.amount, holdingOf(vault, form.from).decimals)
  if (!amount || scenarioProblem(vault, form, demo, amount)) return null
  const balance = demo.scenario === 'drain' ? holdingOf(vault, form.from).amount : null
  return { swapper: vault.address, tokenIn: form.from, tokenOut: form.swapTo, amount, scenario: demo.scenario, balance }
}

function withAdded(request, added) {
  const check = added && request.checks?.[added.index]
  if (!check || check.kind !== CheckKind.AtMostLeaves || check.token !== added.token) return request
  const checks = request.checks.map((c, i) => (i === added.index ? { ...c, amount: added.total } : c))
  return { ...request, checks, added }
}

function buildRequest(vault, form, demo, quote, added, intent) {
  return withAdded(intent ? intentRequest(vault, intent, demo, quote) : baseRequest(vault, form, demo, quote), added)
}

function intentRequest(vault, intent, demo, quote) {
  const { plan } = intent
  const { checks, origins } = plan
  if (plan.swaps.length > 1) return { error: 'One swap per request, for now. Please split your request.' }
  const [swap] = plan.swaps
  if (swap && demo.scenario !== 'honest' && (swap.from === zeroAddress || demo.scenario === 'drain' && swap.amount >= holdingOf(vault, swap.from).amount)) {
    return { checks, origins, error: 'This demo needs a swap from USDC, and something else left to take.' }
  }
  const sends = plan.sends.flatMap((send, i) => hackedSend(vault, demo, { token: send.token, amount: send.amount, to: send.to }, i))
  const rewritten = rewrittenChecks(checks, demo, plan.sends[0])
  const signed = rewritten ?? checks
  const shown = rewritten ? checks : null
  if (!swap) return { checks: signed, shown, origins, actions: sends, swap: null }
  if (!quote) return { checks: signed, shown, origins, swap }
  const extras = extraActions(demo.scenario, { from: swap.from, decimals: holdingOf(vault, swap.from).decimals })
  return {
    checks: signed,
    shown,
    origins,
    swap,
    note: quote.note ?? null,
    actions: [...swapActions({ from: swap.from, amount: swap.amount, transaction: quote.transaction }), ...extras, ...sends],
  }
}

function baseRequest(vault, form, demo, quote) {
  if (form.mode === 'send') {
    if (!vault.contacts.length) return { error: 'No saved contacts yet. Your phone saves them.' }
    const { decimals } = holdingOf(vault, form.token)
    const { amount, error } = readAmount(form.amount, decimals)
    if (!amount) return { error }
    const send = { token: form.token, amount, to: form.to }
    const checks = sendChecks(send)
    const rewritten = rewrittenChecks(checks, demo, send)
    return {
      checks: rewritten ?? checks,
      shown: rewritten ? checks : null,
      actions: hackedSend(vault, demo, send, 0),
      swap: null,
    }
  }
  if (vault.priceSource === zeroAddress) return { error: noPriceSource(vault) }
  if (!vault.fairPrice) return { error: "There's no fair price right now, so swaps can't be checked." }
  if (!canSwap(vault, form.from, form.swapTo)) return { error: 'Swaps work between ETH and USDC only, for now.' }
  const { amount, error } = readAmount(form.amount, holdingOf(vault, form.from).decimals)
  if (!amount) return { error }
  const problem = scenarioProblem(vault, form, demo, amount)
  if (problem) return { error: problem }
  const swap = swapChecks(vault, { from: form.from, to: form.swapTo, amount })
  const shape = { expected: swap.expected, to: form.swapTo }
  if (!quote) return { ...swap, swap: shape }
  const extras = extraActions(demo.scenario, { from: form.from, decimals: holdingOf(vault, form.from).decimals })
  return {
    ...swap,
    swap: shape,
    note: quote.note ?? null,
    actions: [...swapActions({ from: form.from, amount, transaction: quote.transaction }), ...extras],
  }
}

function brokenWords(vault, failure, request, result) {
  if (!failure || !result || brokenRule(vault, request.actions, request.checks, failure)) return []
  if (failure.checkNumber) return (request.origins?.[failure.checkNumber - 1] ?? []).map((i) => String(i + 1))
  if (failure.reason === UNFAIR_TRADE) return result.steps.flatMap((step, i) => (step.type === 'swap' ? [String(i + 1)] : []))
  return result.nothingElseWords ? ['✓'] : []
}

function failedCheck(failure, check, i) {
  if (!failure) return false
  if (failure.checkNumber) return failure.checkNumber === i + 1
  return failure.reason === UNFAIR_TRADE && check.kind === CheckKind.AtLeastArrives
}

function TxLink({ hash }) {
  return (
    <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">
      See it on Etherscan ({shortAddress(hash)})
    </a>
  )
}

function TokenSelect({ vault, value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {vault.holdings.map((holding) => (
        <option key={holding.token} value={holding.token}>{holding.symbol}</option>
      ))}
    </select>
  )
}

function QuoteLine({ quote, fair, out }) {
  if (quote.status === 'loading') return <p>Asking Uniswap for a quote…</p>
  if (quote.status === 'error') return <p className="error">Uniswap quote: {quote.error}</p>
  if (quote.status !== 'ready') return null
  if (quote.quote.badRoute) {
    return (
      <p className="error">
        Bad route (demo): the app ignores Uniswap's quote and swaps through a thin Uniswap v3 pool
        (USDC → ETH, 0.01% fee) whose price is worse.
      </p>
    )
  }
  const { amountOut, blockNumber } = quote.quote
  return (
    <p>
      Uniswap's quote: about {formatAbout(amountOut, out.decimals, SHOWN_DIGITS)} {out.symbol},{' '}
      {compareToFair(amountOut, fair)}, through {describeRoute(quote.quote)}. Quoted at block{' '}
      {blockNumber.toLocaleString('en-US')}, refreshed every {QUOTE_REFRESH_MS / 1000} seconds.
    </p>
  )
}

function SwapNote({ vault, swap, quote }) {
  const out = holdingOf(vault, swap.to)
  return (
    <div className="swap-note">
      <p>
        At the fair price you'd get about <strong>{formatAbout(swap.expected, out.decimals, SHOWN_DIGITS)} {out.symbol}</strong>.
        The check allows {formatAmount(SWAP_SLIPPAGE_BPS, 2)}% less.
      </p>
      <QuoteLine quote={quote} fair={swap.expected} out={out} />
    </div>
  )
}

function QuoteTile({ words, delay }) {
  const ref = useFlight(words, delay)
  return <span ref={ref} className="quote-tile">{words[0]}</span>
}

function CheckCard({ index, number, label, text, words, failed, detail, kept, note }) {
  const base = 220 + index * 130
  return (
    <div className="check-slot" style={{ animationDelay: `${base}ms` }}>
      <div className={`check-card${failed ? ' failed' : ''}${kept ? ' kept' : ''}`}>
        <div className="check-top">
          <span className="check-label"><span className="check-num">{number}</span>{label}</span>
          {kept && (
            <span className="stamp" style={{ animationDelay: `${index * 160}ms` }}>
              <Check size={16} ring={false} delay={index * 160 + 300} />
              Kept
            </span>
          )}
          {failed && <span className="stamp refused">Doesn't fit</span>}
        </div>
        {words.length > 0 && (
          <div className={failed ? 'quote-tiles shake' : 'quote-tiles'}>
            {words.map((piece, i) => <QuoteTile key={piece} words={[piece]} delay={base + 160 + i * 90} />)}
          </div>
        )}
        <div className="check-text" style={{ animationDelay: `${base + 650}ms` }}>{text}</div>
        {detail && <p className="check-detail">{detail}</p>}
        {note && <div className="check-said" style={{ animationDelay: `${base + 800}ms` }}>{note}</div>}
      </div>
    </div>
  )
}

function ChecksList({ vault, request, failure, quote, said, kept }) {
  const [open, setOpen] = useState(false)
  const rules = rulesFor(vault, request.checks)
  const rule = brokenRule(vault, request.actions, request.checks, failure)
  const otherFailed = Boolean(failure) && !failure.checkNumber && failure.reason !== UNFAIR_TRADE && !rule
  return (
    <section className="checks-area">
      <div className="checks-head">
        <h2>{said ? 'Your words, as checks' : 'Your checks'}</h2>
      </div>
      <div className="check-grid">
        {request.checks.map((check, i) => {
          const failed = failedCheck(failure, check, i)
          return (
            <CheckCard
              key={i}
              index={i}
              number={i + 1}
              label={KIND_LABELS[check.kind]}
              text={describeCheck(vault, check).text}
              words={said?.perCheck?.[i] ?? []}
              failed={failed}
              detail={failed && failure.checkNumber ? describeFailure(vault, check, failure.actual) : failed ? failure.reason : null}
              kept={kept}
            />
          )
        })}
        <CheckCard
          index={request.checks.length}
          number="✓"
          label="Everything else"
          text="Your account stays exactly as it is"
          words={said?.nothingElse ? [said.nothingElse] : []}
          failed={otherFailed}
          detail={otherFailed ? failure.reason : null}
          kept={kept}
          note="Always on"
        />
      </div>
      {rule && <p className="panel warn small"><strong>⚠ {failure.reason}.</strong> {rule}.</p>}
      {request.added && <AddedNote vault={vault} added={request.added} />}
      {request.swap && <SwapNote vault={vault} swap={request.swap} quote={quote} />}
      <div className="more-checks">
        <button className="toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className={open ? 'chevron open' : 'chevron'} />
          Plus {ALWAYS_ON.length} checks that are always on{rules.length ? ', and your rules' : ''}
        </button>
        {open && (
          <>
            <ul className="chips">
              {ALWAYS_ON.map((line) => <li key={line}>{line}</li>)}
            </ul>
            {rules.length > 0 && (
              <ul className="chips rules">
                {rules.map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}
          </>
        )}
        <details className="fold raw">
          <summary>What the vault receives</summary>
          <h3>Checks</h3>
          <ol>
            {request.checks.map((check, i) => (
              <li key={i}>
                <code>
                  {KIND_NAMES[check.kind]} · token {check.token} · to {check.to} · amount {check.amount.toString()}
                </code>
              </li>
            ))}
          </ol>
          {request.actions && (
            <>
              <h3>Actions</h3>
              <ol>
                {request.actions.map((action, i) => (
                  <li key={i}><code>{describeAction(vault, action)}</code></li>
                ))}
              </ol>
            </>
          )}
        </details>
      </div>
    </section>
  )
}

function Practice({ practice, vault, checks, said }) {
  if (practice.status === 'running') {
    return <p className="practice running"><Spinner /><span>Practice run…</span></p>
  }
  if (practice.status === 'pass') {
    return <p className="practice pass"><Check size={32} /><span>Practice run: every check passes</span></p>
  }
  if (practice.status === 'fail') {
    return <p className="practice fail"><span className="mark-bad"><Cross size={32} /></span><span>Practice run: your vault would refuse this.</span></p>
  }
  return null
}

function ExtraOffer({ vault, request, failure, busy, onAdd, onCancel }) {
  const extra = classifyFailure(vault, request, failure)
  if (!extra) return null
  const { title, text, question } = describeExtra(vault, extra, request.note)
  return (
    <div className={`extra ${extra.level}`}>
      <p className="extra-title"><span className={`level-dot ${extra.level}`} /><strong>{title}</strong></p>
      <p>{text}</p>
      {question && (
        <>
          <p>{question}</p>
          <div className="row">
            <button onClick={onCancel} disabled={busy}>Cancel</button>
            <button className="secondary" onClick={() => onAdd(extra)} disabled={busy}>Add to my request</button>
          </div>
        </>
      )}
    </div>
  )
}

function AddedNote({ vault, added }) {
  const holding = holdingOf(vault, added.token)
  const amount = `${formatAmount(added.extra, holding.decimals, holding.decimals)} ${holding.symbol}`
  return (
    <p className="panel ok small">
      You added {amount}{added.note ? ` (${added.note})` : ''} to check {added.index + 1}. If the app takes more, your
      vault refuses it.
    </p>
  )
}

function Result({ result, vault, receipt, said, actions, onReset }) {
  if (result.status === 'signing') {
    return <p className="panel line"><Spinner />Confirm in MetaMask. Leave its "Added protection" switch off.</p>
  }
  if (result.status === 'pending') {
    return (
      <div className="panel">
        <p className="panel-line"><Spinner />Sent. Waiting for the network… <TxLink hash={result.hash} /></p>
        <div className="progress"><span /></div>
      </div>
    )
  }
  if (result.status === 'error') {
    return <p className="panel warn">{result.error}</p>
  }
  if (result.status !== 'done') return null
  const outside = !result.ok && Boolean(result.failure?.outside)
  const smartRoute = outside && Boolean(result.failure.smartRoute)
  return (
    <>
      {result.ok ? (
        <section className="banner done">
          <div className="banner-head">
            <Check size={56} delay={200} />
            <h2><Words text="Done, exactly as you said." delay={300} /></h2>
          </div>
          {result.moved && (
            <ul className="outcomes">
              {result.checks.map((check, i) => (
                <li key={i} className="word" style={{ animationDelay: `${900 + i * 120}ms` }}>
                  <Check size={22} ring={false} delay={1000 + i * 120} />
                  <span>{describeCheck(vault, check).text}: {describeOutcome(vault, check, result.moved[i])}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : outside ? (
        <section className="banner failed">
          <div className="banner-head">
            <span className="mark-bad"><Cross size={56} delay={200} /></span>
            <h2><Words text="It didn't go through." delay={300} /></h2>
          </div>
          <p className="lead-in">{result.failure.reason}</p>
          <p className="muted">
            Nothing left your vault. Only the network fee was paid.
            {smartRoute && ' Leave "Added protection" off and send again. If MetaMask turned your key into a smart account, the steps to switch it back are at the top of the page.'}
          </p>
        </section>
      ) : (
        <section className="banner never">
          <div className="banner-head">
            <span className="mark-bad"><Cross size={56} delay={200} /></span>
            <h2><Words text="This never happens." delay={300} step={110} /></h2>
          </div>
          <p className="lead-in">Your vault refused it. {explainRefusal(result.failure, vault, result.checks, said, actions)}</p>
          <p className="muted">Nothing left your vault, only the network fee.</p>
        </section>
      )}
      {!result.ok && !outside && (
        <>
          <Caught vault={vault} source="chain" hash={result.hash} actions={actions} checks={result.checks} failure={result.failure} said={said} />
        </>
      )}
      <section className="card after">
        {!smartRoute && <ChainProof vault={vault.address} hash={result.hash} checks={result.checks} outside={outside} describe={(check) => describeCheck(vault, check).text} />}
        <p>
          <TxLink hash={result.hash} />
          {!smartRoute && <> · <a href={`#proof/${result.hash}`} target="_blank" rel="noreferrer">Open the evidence page</a></>}
        </p>
        {receipt && <ReceiptBox input={receipt} />}
        <div className="actions">
          <button className="secondary" onClick={onReset}>New request</button>
        </div>
      </section>
    </>
  )
}

export default function Request({ vault, role, blocked, onDone }) {
  const wallet = getWallet()
  const usdc = vault.holdings.find((h) => h.token !== zeroAddress)?.token ?? zeroAddress
  const [form, setForm] = useState({
    mode: 'send',
    amount: '',
    token: usdc,
    to: vault.contacts[0]?.address ?? '',
    from: usdc,
    swapTo: zeroAddress,
  })
  const [demo, setDemo] = useState({ hacked: false, scenario: 'honest', forced: false, sendTrick: 'more' })
  const [practice, setPractice] = useState({ status: 'idle' })
  const [result, setResult] = useState({ status: 'idle' })
  const [practiceRound, setPracticeRound] = useState(0)
  const [added, setAdded] = useState(null)
  const [intent, setIntent] = useState(null)

  const set = (field) => (value) => setForm((f) => ({ ...f, [field]: value }))
  const hackApp = (e) => setDemo(e.target.checked
    ? { hacked: true, forced: true, scenario: 'drain', sendTrick: 'more' }
    : { hacked: false, forced: false, scenario: 'honest', sendTrick: 'more' })
  const busy = result.status === 'signing' || result.status === 'pending'
  const finished = result.status === 'done'
  const quote = useQuote(swapAskFor(vault, form, demo, intent), busy || finished)
  const readyQuote = quote.status === 'ready' ? quote.quote : null
  const request = useMemo(
    () => buildRequest(vault, form, demo, readyQuote, added, intent),
    [vault, form, demo, readyQuote, added, intent],
  )
  const sentence = intent ? intent.sentence : form.amount.trim() ? formSentence(vault, form) : ''
  const said = useMemo(() => (intent ? saidFor(intent.answer.result, request.origins) : null), [intent, request.origins])
  const previewId = useMemo(() => previewKey(sentence, request.actions, demo), [sentence, request.actions, demo])
  const requestKey = useMemo(() => keyOf(request), [request])
  const latest = useRef({ vault, request })
  latest.current = { vault, request }

  useEffect(() => {
    setResult({ status: 'idle' })
    setAdded(null)
  }, [form, demo, intent])

  useEffect(() => {
    if (!request.actions) {
      setPractice({ status: 'idle' })
      return
    }
    let current = true
    setPractice({ status: 'running' })
    const timer = setTimeout(async () => {
      const now = latest.current
      const outcome = await practiceRun(wallet, now.vault, { ...now.request, deadline: newDeadline() })
      if (!current) return
      setPractice(outcome.pass ? { status: 'pass' } : { status: 'fail', failure: outcome.failure })
    }, PRACTICE_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [wallet, requestKey, practiceRound])

  const isEveryday = role === 'Everyday key'
  const practiceDone = practice.status === 'pass' || practice.status === 'fail'
  const allowed = practice.status === 'pass' || (practice.status === 'fail' && demo.forced)
  const canSend = Boolean(request.actions) && isEveryday && allowed && !busy && !finished && !blocked
  const refusal = finished && !result.ok && !result.failure?.outside ? result.failure : null
  const failure = refusal ?? (practice.status === 'fail' && !finished ? practice.failure : null)
  const broken = intent ? brokenWords(vault, failure, request, intent.answer.result) : []

  const send = async () => {
    const run = { ...request, deadline: newDeadline() }
    const forced = practice.status !== 'pass'
    setResult({ status: 'signing' })
    let hash
    try {
      hash = await signAndSend(wallet, vault, run, forced)
    } catch (error) {
      setResult({
        status: 'error',
        error: error?.code === 4001 || error?.cause?.code === 4001
          ? 'You cancelled in MetaMask. Nothing was sent.'
          : error?.shortMessage || error?.message || 'Something went wrong.',
      })
      onDone()
      return
    }
    setResult({ status: 'pending', hash })
    try {
      const outcome = await waitForResult(wallet, vault, run, hash)
      setResult({
        status: 'done',
        hash,
        ok: outcome.ok,
        failure: outcome.failure,
        moved: outcome.moved,
        checks: run.checks,
        said,
        receipt: {
          vault: vault.address,
          account: vault.everydayKey,
          chainId: 11155111,
          sentence: sentence || 'A request made with the form',
          ai: intent ? { result: intent.answer.result, proof: intent.answer.proof } : null,
          checks: run.checks,
          checksInWords: run.checks.map((check) => describeCheck(vault, check).text),
          said,
          result: { hash, ok: outcome.ok, outside: Boolean(outcome.failure?.outside), reason: outcome.ok ? null : explainRefusal(outcome.failure, vault, run.checks, said, run.actions) },
        },
      })
    } catch (error) {
      setResult({ status: 'error', error: error?.shortMessage || error?.message || 'Something went wrong.' })
    }
    onDone()
  }

  const swapping = intent ? intent.plan.swaps.length > 0 : form.mode === 'swap'
  const sending = intent ? intent.plan.sends.length > 0 && intent.plan.swaps.length === 0 : form.mode === 'send'

  return (
    <>
      {demo.forced && <HackedRibbon demo={demo} swapping={swapping} sending={sending} />}
      <div className="flow" hidden={Boolean(intent)}>
        <Say vault={vault} busy={busy} onUse={(chosen) => setIntent(chosen)} />
      </div>

      {intent ? (
        <section className="card say still">
          <div className="say-head">
            <span className="eyebrow">From your sentence</span>
            <button className="secondary compact" onClick={() => setIntent(null)} disabled={busy}>Change my request</button>
          </div>
          <WordTiles sentence={intent.sentence} result={intent.answer.result} broken={broken} register instant still />
          {request.error && <p className="panel warn">{request.error}</p>}
        </section>
      ) : (
      <section className="card form-card">
        <div className="card-head">
          <span className="eyebrow">Or fill it in</span>
        </div>
        <div className="tabs">
          {['send', 'swap'].map((mode) => (
            <button
              key={mode}
              className={form.mode === mode ? 'tab active' : 'tab'}
              onClick={() => set('mode')(mode)}
              disabled={busy}
            >
              {mode === 'send' ? 'Send' : 'Swap'}
            </button>
          ))}
        </div>

        <div className="form">
          <label>
            <span>{form.mode === 'send' ? 'Send' : 'Swap'}</span>
            <input
              inputMode="decimal"
              placeholder="0"
              value={form.amount}
              disabled={busy}
              onChange={(e) => set('amount')(e.target.value)}
            />
          </label>

          {form.mode === 'send' ? (
            <>
              <TokenSelect vault={vault} value={form.token} onChange={set('token')} />
              <label>
                <span>to</span>
                <select value={form.to} onChange={(e) => set('to')(e.target.value)}>
                  {vault.contacts.map((contact) => (
                    <option key={contact.address} value={contact.address}>
                      {nameOf(vault, contact.address)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <>
              <TokenSelect vault={vault} value={form.from} onChange={set('from')} />
              <label>
                <span>for</span>
                <TokenSelect vault={vault} value={form.swapTo} onChange={set('swapTo')} />
              </label>
            </>
          )}
        </div>

        {request.error && <p className="panel warn">{request.error}</p>}
      </section>
      )}

      {request.checks && (
        <ChecksList
          vault={vault}
          request={request.shown ? { ...request, checks: request.shown } : request}
          failure={failure}
          quote={quote}
          said={said}
          kept={finished && result.ok}
        />
      )}

      {request.actions && practice.status === 'fail' && !finished && (
        <Caught vault={vault} source="practice" actions={request.actions} checks={request.checks} failure={practice.failure} said={said} />
      )}

      {request.actions && (
        <section className="card action">
          <Practice practice={practice} vault={vault} checks={request.checks} said={said} />
          <Preview vault={vault} sentence={sentence} actions={request.actions} previewKey={previewId} />
          {practice.status === 'fail' && !finished && !demo.forced && (
            <ExtraOffer
              vault={vault}
              request={request}
              failure={practice.failure}
              busy={busy}
              onAdd={(extra) => setAdded({ ...extra, note: request.note })}
              onCancel={() => set('amount')('')}
            />
          )}
          {!isEveryday && practiceDone && (
            <p className="muted">Switch MetaMask to the Everyday key to send.</p>
          )}
          {!finished && (
            <div className="send-row">
              <button className="big" onClick={send} disabled={!canSend}>
                {practice.status === 'fail' && demo.forced ? 'Send anyway (demo)' : 'Sign and send'}
              </button>
            </div>
          )}
        </section>
      )}

      {request.actions && (
        <Result
          result={result}
          vault={vault}
          receipt={result.receipt}
          said={result.said}
          actions={request.actions}
          onReset={() => {
            setResult({ status: 'idle' })
            setPracticeRound((n) => n + 1)
          }}
        />
      )}

      <details className="card demo">
        <summary>Demo switches</summary>
        <label className="switch">
          <input type="checkbox" checked={demo.forced} onChange={hackApp} disabled={busy} />
          <span>
            <strong>Hacked app: send it anyway</strong>
            <span className="from">
              The app secretly changes what it sends, then sends it anyway, so you can watch your vault refuse it on Sepolia.
            </span>
          </span>
        </label>
        {demo.forced && swapping && (
          <label className="scenario">
            <span>What the hacked app hides in the swap (USDC → ETH only)</span>
            <select
              value={demo.scenario}
              disabled={busy}
              onChange={(e) => setDemo((d) => ({ ...d, scenario: e.target.value }))}
            >
              {SWAP_SCENARIOS.filter(([value]) => value !== 'honest').map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        )}
        {demo.forced && sending && (
          <label className="scenario">
            <span>What the hacked app does to the send</span>
            <select
              value={demo.sendTrick}
              disabled={busy}
              onChange={(e) => setDemo((d) => ({ ...d, sendTrick: e.target.value }))}
            >
              {SEND_TRICKS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        )}
      </details>
    </>
  )
}
