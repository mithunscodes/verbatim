import { useEffect, useMemo, useRef, useState } from 'react'
import { erc20Abi, WaitForTransactionReceiptTimeoutError } from 'viem'
import { DEMO_POLL_MS, EXPLORER, FACTORY } from './config.js'
import Console from './Console.jsx'
import {
  Bag,
  coinCount,
  ContactTag,
  fadeCoins,
  flyCoins,
  HoldButton,
  MarkerNote,
  Padlock,
  popLabel,
  shake,
  showCoins,
  Slip,
  strain,
  Tape,
  TargetCard,
  topCoins,
  Typed,
} from './CaseFile.jsx'
import {
  allowedAmount,
  allowedRequest,
  ATTACKS,
  attackRequest,
  demoClients,
  demoRpcUrl,
  findScene,
  readBalances,
  readDemoLink,
  requestWords,
  resultOf,
  sameAddress,
  sendAttack,
  sendTry,
  tokenAmount,
} from './demo.js'
import { formatAbout, formatAmount, formatDuration, shortAddress } from './format.js'
import { reduced } from './Motion.jsx'

const THIEF_NAME = 'you'

const TOO_MANY_WAITING = 'Too many changes waiting for your phone'

const SCROLL_SETTLE_MS = 500

const SCROLL_GAP = 12

const FEE_DIGITS = 3

const GAS_DIGITS = 4

const SLOW_SECONDS = 30

const RECEIPT_ROUNDS = 3

const FEW_COINS = 3

const FEW_COINS_FLIGHT = { duration: 1800, stagger: 140 }

const TOOLS = [
  { id: 'test', short: 'Test the key', rule: 'Money only goes to saved contacts, so this one is allowed' },
  { id: 'take', short: 'Take everything', rule: 'Money only goes to saved contacts' },
  ...ATTACKS,
]

const NO_MARKS = { wallet: {}, vault: {} }

function problem(error) {
  if (error instanceof WaitForTransactionReceiptTimeoutError) {
    return "Sepolia hasn't picked it up yet. It may still land: the tape's Etherscan link shows when it does."
  }
  return error?.shortMessage || error?.message || 'Something went wrong.'
}

async function landed(reader, hash) {
  for (let round = 1; ; round++) {
    try {
      return await resultOf(reader, hash)
    } catch (error) {
      if (!(error instanceof WaitForTransactionReceiptTimeoutError) || round >= RECEIPT_ROUNDS) throw error
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clock() {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function shortHash(hash) {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}

const addressUrl = (address) => `${EXPLORER}/address/${address}`
const readUrl = (address) => `${EXPLORER}/address/${address}#readContract`
const codeUrl = (address) => `${EXPLORER}/address/${address}#code`
const txUrl = (hash) => `${EXPLORER}/tx/${hash}`
const blockUrl = (number) => `${EXPLORER}/block/${number}`
const holdingUrl = (scene, address) => `${EXPLORER}/token/${scene.token}?a=${address}`

function contactLabel(scene, address) {
  return sameAddress(address, scene.contact) && scene.contactName ? scene.contactName : shortAddress(address)
}

function walletRequest(scene, balances) {
  return { address: scene.token, abi: erc20Abi, functionName: 'transfer', args: [scene.thief, balances.wallet] }
}

function expectedWords(tool) {
  return tool.expected === 'proposed' ? "⏳ proposed, then it waits for the owner's phone" : `✗ refused: "${tool.expected}"`
}

function checksWords(scene, request, checks) {
  if (checks === null) return sameAddress(request.address, scene.token) ? 'none: a normal wallet has no checks' : 'none: this call moves no money'
  return checks.length ? checks.join('; ') : 'none written'
}

function slip(scene, heading, request, expect, rule, nonce) {
  const words = requestWords(scene, request)
  const to = sameAddress(request.address, scene.token) ? scene.symbol : 'vault'
  return {
    heading,
    nonce,
    rows: [
      ['call', words.call],
      ['does', words.what],
      ['checks', checksWords(scene, request, words.checks)],
      ['expect', expect, expect.startsWith('✓') ? 'go' : 'stop'],
      ['rule', rule],
    ],
    from: { text: `${shortAddress(scene.everydayKey)} (the key)`, href: addressUrl(scene.everydayKey) },
    to: { text: `${to} ${shortAddress(request.address)}`, href: addressUrl(request.address) },
  }
}

function slipsFor(tool, scene, balances, nonce) {
  const next = (step) => (nonce === null ? undefined : nonce + step)
  if (tool.id === 'test') {
    const expect = `✓ goes through: ${scene.contactName ?? 'the contact'} is saved`
    return [slip(scene, 'Transaction slip', allowedRequest(scene), expect, tool.rule, next(0))]
  }
  if (tool.id === 'take') {
    const steal = ATTACKS.find((attack) => attack.id === 'steal')
    return [
      slip(scene, '1 of 2 · normal wallet', walletRequest(scene, balances), '✓ goes through: no rules to stop it', 'none', next(0)),
      slip(scene, '2 of 2 · vault', attackRequest(scene, balances, 'steal'), expectedWords(steal), steal.rule, next(1)),
    ]
  }
  return [slip(scene, 'Transaction slip', attackRequest(scene, balances, tool.id), expectedWords(tool), tool.rule, next(0))]
}

function openingLines(scene, balances) {
  const same = sameAddress(scene.keyInVault, scene.everydayKey)
  const contacts = scene.contacts.length ? scene.contacts.map((c) => `${contactLabel(scene, c)} ${shortAddress(c)}`).join(', ') : 'none'
  return [
    { text: `the key: ${shortAddress(scene.everydayKey)}, the normal wallet itself`, href: addressUrl(scene.everydayKey) },
    { text: `read at block ${balances.blockNumber}`, href: blockUrl(balances.blockNumber) },
    { text: `factory.vaultOf(key) = ${shortAddress(scene.vault)}`, href: readUrl(FACTORY) },
    {
      text: `vault.everydayKey() = ${shortAddress(scene.keyInVault)} ${same ? '✓ the same key' : '✗ a different key'}`,
      href: readUrl(scene.vault),
      tone: same ? 'ok' : 'no',
    },
    { text: `normal wallet holds ${tokenAmount(scene, balances.wallet)}`, href: holdingUrl(scene, scene.everydayKey) },
    { text: `vault holds ${tokenAmount(scene, balances.vault)}`, href: holdingUrl(scene, scene.vault) },
    { text: `vault rule, saved contacts: ${contacts}`, href: readUrl(scene.vault) },
    { text: `vault rule, daily limit: ${tokenAmount(scene, scene.dailyLimit)}`, href: readUrl(scene.vault) },
    { text: "vault's code is verified", href: codeUrl(scene.vault) },
    { text: `your address: ${shortAddress(scene.thief)}`, href: addressUrl(scene.thief) },
    { text: `test ETH for fees: ${formatAmount(balances.gas, 18, GAS_DIGITS)} ETH, on the key`, href: addressUrl(scene.everydayKey) },
  ]
}

function sentLines(label, nonce, hash) {
  return [
    { text: `${label}signed on this phone · nonce ${nonce}` },
    { text: `${label}sent ${shortHash(hash)}, waiting for Sepolia…`, href: txUrl(hash) },
  ]
}

function resultLines(scene, label, nonce, result) {
  const payer = sameAddress(result.payer, scene.everydayKey) ? 'the key' : shortAddress(result.payer)
  return [
    { text: `${label}signed on this phone · nonce ${nonce}` },
    { text: `${label}sent ${shortHash(result.hash)}`, href: txUrl(result.hash) },
    {
      text: `${label}block ${result.blockNumber} · ${result.ok ? '✓ went through' : `✗ refused: "${result.reason}"`}`,
      href: blockUrl(result.blockNumber),
      tone: result.ok ? 'ok' : 'no',
    },
    { text: `${label}fee ${formatAbout(result.fee, 18, FEE_DIGITS)} ETH, paid by ${payer}`, href: txUrl(result.hash) },
  ]
}

function moveLines(scene, before, after) {
  const row = (name, address, side) => ({
    text: `${name}: ${formatAmount(before[side], scene.decimals)} → ${formatAmount(after[side], scene.decimals)} ${scene.symbol}`,
    href: holdingUrl(scene, address),
    tone: before[side] === after[side] ? undefined : 'moved',
  })
  return [row('normal wallet', scene.everydayKey, 'wallet'), row('vault', scene.vault, 'vault'), row('your bag', scene.thief, 'thief')]
}

function routerLine(scene) {
  if (!scene.routerName) return []
  return [{
    text: `the vault read ENS: ${scene.routerName} → ${shortAddress(scene.routerAddress)}. Your router isn't listed`,
    href: readUrl(scene.directory),
  }]
}

function verdictFor(tool, scene, result, before) {
  if (tool.id === 'test') {
    if (!result.ok) return { tone: 'no', mark: 'Refused.', text: `The vault refused it: "${result.reason}".` }
    return {
      tone: 'go',
      mark: 'The key works.',
      text: `${tokenAmount(scene, allowedAmount(scene))} went from the vault to ${scene.contactName ?? 'the saved contact'}.`,
    }
  }
  if (tool.expected === 'proposed' && result.ok) {
    return {
      tone: 'wait',
      mark: "Waits for the owner's phone.",
      text: `Proposed only. Even if the phone approves, it waits ${formatDuration(scene.looseningWait)} before it can switch on.`,
    }
  }
  if (!result.ok) {
    const capped = tool.expected === 'proposed' && result.reason === TOO_MANY_WAITING
    const expected = result.reason === tool.expected || capped
    return {
      tone: expected ? 'no' : 'odd',
      mark: 'Never happened.',
      text: `"${result.reason}". Nothing moved.${expected ? '' : ' A different rule stopped it.'}${capped ? ' Cancel the waiting changes on the phone page to propose again.' : ''}`,
    }
  }
  return { tone: 'odd', mark: 'It went through.', text: `Not what we expected. Before: ${tokenAmount(scene, before.vault)} in the vault.` }
}

function nextTool(id, done) {
  const start = TOOLS.findIndex((tool) => tool.id === id)
  for (let step = 1; step <= TOOLS.length; step++) {
    const tool = TOOLS[(start + step) % TOOLS.length]
    if (!done.has(tool.id)) return tool.id
  }
  return id
}

function useScene(clients, demo, hold) {
  const [scene, setScene] = useState(null)
  const [balances, setBalances] = useState(null)
  const [nonce, setNonce] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    if (!clients) return undefined
    let stopped = false
    let timer
    let found = null
    const tick = async () => {
      try {
        if (!found?.vault || !found.setupFinished || !found.contact) {
          found = { ...(await findScene(clients.reader, demo.everydayKey, demo.thief)), thiefName: THIEF_NAME }
          if (!stopped) setScene(found)
        }
        if (found.vault && !hold.current) {
          const [read, next] = await Promise.all([
            readBalances(clients.reader, found),
            clients.reader.getTransactionCount({ address: demo.everydayKey, blockTag: 'pending' }),
          ])
          if (!stopped && !hold.current) {
            setBalances(read)
            setNonce(next)
          }
        }
        if (!stopped) setError(null)
      } catch (e) {
        if (!stopped) setError(problem(e))
      }
      if (!stopped) timer = setTimeout(tick, DEMO_POLL_MS * 2)
    }
    tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [clients, demo, hold])
  return { scene, balances, setBalances, nonce, setNonce, error }
}

function Story() {
  return (
    <header className="story">
      <span className="brand">Verbatim</span>
      <MarkerNote>You're the attacker</MarkerNote>
      <h1>You have the owner's key.</h1>
      <p>This phone signs with it. Our server only passes it on.</p>
      <p>The big screen is the owner, watching both accounts.</p>
      <p className="fine">Sepolia, the test network. Test money only.</p>
    </header>
  )
}

function KeyStrip({ demo, open, error }) {
  return (
    <section className={`key-strip${open ? ' open' : ''}`}>
      <Padlock />
      <div className="key-text">
        <p className="label">The owner's key</p>
        <a className="key" href={addressUrl(demo.everydayKey)} target="_blank" rel="noreferrer">
          <Typed text={demo.everydayKey} delay={300} />
        </a>
        <p className="scan-text">
          {error ? `Can't reach Sepolia right now: ${error}` : open ? 'Read from Sepolia: it opens two accounts.' : 'Reading Sepolia: what does this key open?'}
        </p>
      </div>
      {!open && !error && <span className="scan" aria-hidden="true" />}
    </section>
  )
}

function Elapsed({ since }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  return (
    <>
      <p className="elapsed">{seconds} s</p>
      {seconds >= SLOW_SECONDS && <p className="slow">Sepolia is busy right now. It can take a few minutes, and nothing is lost.</p>}
    </>
  )
}

function Status({ run, last }) {
  if (run) {
    return (
      <div className="status running" role="status">
        <p>{run.text}</p>
        {run.since && <Elapsed key={run.since} since={run.since} />}
        {run.hashes?.map((hash) => (
          <a key={hash} href={txUrl(hash)} target="_blank" rel="noreferrer">{shortHash(hash)} ↗</a>
        ))}
      </div>
    )
  }
  if (!last) return null
  return (
    <div key={last.key} className={`status done ${last.tone}`} role="status">
      <p className="status-title">{last.title}</p>
      {last.lines.map((line, i) => (
        <div key={i} className="verdict-line">
          <MarkerNote className="small">{line.mark}</MarkerNote>
          <p>
            {line.text}{' '}
            {line.hash && <a href={txUrl(line.hash)} target="_blank" rel="noreferrer">Etherscan ↗</a>}
          </p>
        </div>
      ))}
      {last.took !== undefined && <p className="took">Both results in {Math.round(last.took / 1000)} s.</p>}
    </div>
  )
}

export default function Attack({ link }) {
  const demo = useMemo(() => readDemoLink(link), [link])
  const clients = useMemo(() => (demo ? demoClients(demoRpcUrl(), demo.key) : null), [demo])
  const hold = useRef(false)
  const { scene, balances, setBalances, nonce, setNonce, error } = useScene(clients, demo, hold)
  const [selected, setSelected] = useState('test')
  const [run, setRun] = useState(null)
  const [last, setLast] = useState(null)
  const [results, setResults] = useState({})
  const [marks, setMarks] = useState(NO_MARKS)
  const [taps, setTaps] = useState([])
  const [opening, setOpening] = useState(null)
  const done = useRef(new Set())
  const shown = useRef(null)
  const queue = useRef(Promise.resolve())
  const layer = useRef(null)
  const targets = useRef(null)
  const walletPile = useRef(null)
  const vaultPile = useRef(null)
  const vaultCard = useRef(null)
  const bag = useRef(null)
  const tag = useRef(null)

  const ready = Boolean(scene?.vault && scene.setupFinished && balances)

  useEffect(() => {
    if (ready && !opening) setOpening({ time: clock(), lines: openingLines(scene, balances) })
  }, [ready, opening, scene, balances])

  useEffect(() => {
    if (balances && !hold.current) shown.current = balances
  }, [balances])

  const tool = TOOLS.find((t) => t.id === selected)
  const slips = useMemo(() => (ready ? slipsFor(tool, scene, balances, nonce) : []), [ready, tool, scene, balances, nonce])

  if (!demo) {
    return (
      <main className="case">
        <section className="sheet notice">
          <h2>This link doesn't hold a key</h2>
          <p>Scan the QR code on the Verbatim screen again.</p>
        </section>
      </main>
    )
  }

  const busy = Boolean(run)
  const noGas = ready && balances.gas === 0n
  const decimals = scene?.decimals ?? 6
  const amount = (value) => formatAmount(value, decimals)
  const same = ready && sameAddress(scene.keyInVault, scene.everydayKey)

  const blocked = (() => {
    if (!ready || noGas) return true
    if (tool.id === 'test') return !scene.contact || balances.vault < allowedAmount(scene)
    if (tool.id === 'take') return balances.wallet === 0n
    return false
  })()

  const addTap = (group) => setTaps((current) => [group, ...current])
  const editTap = (id, lines) => setTaps((current) => current.map((group) => (group.id === id ? { ...group, lines } : group)))

  const lookAtTargets = async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const box = targets.current?.getBoundingClientRect()
    if (!box || (box.top >= 0 && box.top < window.innerHeight / 3)) return
    window.scrollTo({ top: window.scrollY + box.top - SCROLL_GAP, behavior: reduced() ? 'auto' : 'smooth' })
    await wait(reduced() ? 0 : SCROLL_SETTLE_MS)
  }

  const play = (side, result) => {
    const step = queue.current.then(async () => {
      const before = shown.current
      const after = await readBalances(clients.reader, scene)
      await lookAtTargets()
      const pile = side === 'wallet' ? walletPile.current : vaultPile.current
      const lost = coinCount(before[side], decimals) - coinCount(after[side], decimals)
      if (result.ok && after[side] < before[side]) {
        const coins = topCoins(pile, Math.max(1, lost))
        const toBag = after.thief > before.thief
        const target = toBag ? bag.current : tag.current
        await (target ? flyCoins(layer.current, coins, target, coins.length <= FEW_COINS ? FEW_COINS_FLIGHT : undefined) : fadeCoins(coins))
        popLabel(layer.current, target, `+${formatAmount(before[side] - after[side], decimals)} ${scene.symbol}`, toBag ? 'take' : 'pay')
      } else if (!result.ok && side === 'vault') {
        await strain(pile, bag.current)
      }
      shown.current = after
      setBalances(after)
      showCoins([...(walletPile.current?.querySelectorAll('.coin') ?? []), ...(vaultPile.current?.querySelectorAll('.coin') ?? [])])
      return { before, after }
    })
    queue.current = step.catch(() => null)
    return step
  }

  const markVault = (result, verdict, stamp) => {
    const key = Date.now()
    if (!result.ok) {
      setMarks((current) => ({ ...current, vault: { bar: { key, text: result.reason }, stamp: { key, text: 'Never happened', tone: 'blue' } } }))
      shake(vaultCard.current)
      return
    }
    setMarks((current) => ({ ...current, vault: { note: verdict.mark, ...(stamp ? { stamp: { key, ...stamp } } : {}) } }))
  }

  const finish = (id, outcome) => {
    done.current.add(id)
    setResults((current) => ({ ...current, [id]: outcome }))
    setSelected(nextTool(id, done.current))
  }

  const single = async (current, id) => {
    const request = current.id === 'test' ? allowedRequest(scene) : attackRequest(scene, shown.current, current.id)
    const sent = await sendTry(clients, request)
    addTap({ id, title: current.short, time: clock(), lines: sentLines('', sent.nonce, sent.hash) })
    setNonce(sent.nonce + 1)
    setRun({ text: `Sent · nonce ${sent.nonce}. Waiting for Sepolia…`, hashes: [sent.hash], since: Date.now() })
    const result = await landed(clients.reader, sent.hash)
    const { before, after } = await play('vault', result)
    const verdict = verdictFor(current, scene, result, before)
    const odd = result.ok && current.id !== 'test' && current.expected !== 'proposed'
    markVault(result, verdict, odd ? { text: 'It went through', tone: 'red' } : verdict.tone === 'wait' ? { text: 'Waits for owner', tone: 'ink' } : null)
    const extra = current.id === 'fakeRouter' && !result.ok ? routerLine(scene) : []
    editTap(id, [...resultLines(scene, '', sent.nonce, result), ...extra, ...moveLines(scene, before, after)])
    setLast({ key: id, title: current.short, tone: verdict.tone, lines: [{ ...verdict, hash: result.hash }] })
    finish(current.id, verdict.tone)
  }

  const take = async (current, id, started) => {
    const before = shown.current
    const sent = await sendAttack(clients, scene, before)
    const lines = [...sentLines('wallet · ', sent.nonce, sent.wallet), ...sentLines('vault · ', sent.nonce + 1, sent.vault)]
    addTap({ id, title: current.short, time: clock(), lines })
    setNonce(sent.nonce + 2)
    setRun({ text: `Sent both · nonce ${sent.nonce} and ${sent.nonce + 1}. Waiting for Sepolia…`, hashes: [sent.wallet, sent.vault], since: Date.now() })
    const settled = {}
    const track = async (side) => {
      const result = await landed(clients.reader, sent[side])
      settled[side] = { result, ...(await play(side, result)) }
      if (side === 'wallet' && result.ok) {
        const empty = settled.wallet.after.wallet === 0n
        setMarks((m) => ({ ...m, wallet: { stamp: { key: Date.now(), text: empty ? 'Emptied' : 'Sent', tone: 'red' } } }))
      }
      if (side === 'vault') {
        const verdict = verdictFor(ATTACKS.find((a) => a.id === 'steal'), scene, result, settled.vault.before)
        markVault(result, verdict, result.ok ? { text: 'It went through', tone: 'red' } : null)
      }
    }
    await Promise.all([track('wallet'), track('vault')])
    const took = Date.now() - started
    const wallet = settled.wallet.result
    const vault = settled.vault.result
    const vaultVerdict = verdictFor(ATTACKS.find((a) => a.id === 'steal'), scene, vault, before)
    editTap(id, [
      ...resultLines(scene, 'wallet · ', sent.nonce, wallet),
      ...resultLines(scene, 'vault · ', sent.nonce + 1, vault),
      ...moveLines(scene, before, shown.current),
      { text: `both results in ${Math.round(took / 1000)} s` },
    ])
    setLast({
      key: id,
      title: current.short,
      tone: wallet.ok && !vault.ok ? 'no' : 'odd',
      took,
      lines: [
        {
          mark: wallet.ok ? 'Wallet emptied.' : 'Wallet refused.',
          text: wallet.ok ? `${tokenAmount(scene, before.wallet)} went to you.` : `It failed: ${wallet.reason}`,
          hash: wallet.hash,
        },
        { mark: `Vault: ${vaultVerdict.mark.toLowerCase()}`, text: vaultVerdict.text, hash: vault.hash },
      ],
    })
    finish(current.id, vault.ok ? 'odd' : 'no')
  }

  const fire = async () => {
    if (busy || blocked) return
    const current = tool
    const id = `${current.id}-${Date.now()}`
    const started = Date.now()
    hold.current = true
    setLast(null)
    setMarks(NO_MARKS)
    setRun({ text: current.id === 'take' ? 'Signing both on this phone…' : 'Signing on this phone…' })
    await lookAtTargets()
    try {
      const fresh = await readBalances(clients.reader, scene)
      shown.current = fresh
      setBalances(fresh)
      if (current.id === 'take') await take(current, id, started)
      else await single(current, id)
    } catch (e) {
      const slow = e instanceof WaitForTransactionReceiptTimeoutError
      setLast({ key: id, title: current.short, tone: slow ? 'wait' : 'odd', lines: [{ mark: slow ? 'Still waiting.' : 'Something broke.', text: problem(e) }] })
    }
    hold.current = false
    setRun(null)
  }

  const contacts = scene?.contacts ?? []

  return (
    <main className="case">
      <div className="flight-layer" ref={layer} aria-hidden="true" />
      <Story />
      <KeyStrip demo={demo} open={ready} error={error} />

      {scene && !scene.vault && <p className="warn-line">This key has no Verbatim vault yet. Ask the team to run the demo setup.</p>}
      {scene?.vault && !scene.setupFinished && <p className="warn-line">The vault isn't set up yet. Ask the team to run the demo setup.</p>}
      {noGas && <p className="warn-line">This key has no test ETH for fees. Ask the team to reset the demo.</p>}

      {ready && (
        <>
          <section className="targets" ref={targets}>
            <div className="target-row">
              <TargetCard
                label="Normal wallet"
                address={scene.everydayKey}
                href={addressUrl(scene.everydayKey)}
                amount={amount(balances.wallet)}
                symbol={scene.symbol}
                count={coinCount(balances.wallet, decimals)}
                index={0}
                pileRef={walletPile}
                marks={marks.wallet}
                proof={
                  <p className="proof">
                    <a href={addressUrl(scene.everydayKey)} target="_blank" rel="noreferrer">the key's own address ✓</a>
                  </p>
                }
              >
                <p className="rules-none">No rules. The key can send anything.</p>
              </TargetCard>
              <TargetCard
                label="Verbatim vault"
                address={scene.vault}
                href={addressUrl(scene.vault)}
                amount={amount(balances.vault)}
                symbol={scene.symbol}
                count={coinCount(balances.vault, decimals)}
                index={1}
                pileRef={vaultPile}
                cardRef={vaultCard}
                marks={marks.vault}
                proof={
                  <p className={`proof${same ? '' : ' bad'}`}>
                    <a href={readUrl(scene.vault)} target="_blank" rel="noreferrer">
                      everydayKey() = {shortAddress(scene.keyInVault)} {same ? '✓' : '✗'}
                    </a>
                  </p>
                }
              >
                <div className="rules">
                  <p className="rule-label">Pays only</p>
                  <div className="tags">
                    {contacts.map((contact, i) => (
                      <ContactTag key={contact} ref={i === 0 ? tag : undefined} href={addressUrl(contact)}>
                        {contactLabel(scene, contact)}
                      </ContactTag>
                    ))}
                  </div>
                  <p className="rule-label">
                    Daily limit{' '}
                    <a href={readUrl(scene.vault)} target="_blank" rel="noreferrer">{tokenAmount(scene, scene.dailyLimit)}</a>
                  </p>
                  <p className="rule-label">
                    <a href={codeUrl(scene.vault)} target="_blank" rel="noreferrer">Verified code ↗</a>
                  </p>
                </div>
                {marks.vault.note && <MarkerNote className="small card-note">{marks.vault.note}</MarkerNote>}
              </TargetCard>
            </div>
            <Bag ref={bag} amount={amount(balances.thief)} symbol={scene.symbol} address={scene.thief} href={addressUrl(scene.thief)} />
            <Status run={run} last={last} />
          </section>

          <section className="tools">
            <h2>Your tools</h2>
            <div className="tool-row" role="tablist">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={t.id === selected}
                  className={`tool${t.id === selected ? ' on' : ''}${results[t.id] ? ` tried ${results[t.id]}` : ''}`}
                  disabled={busy}
                  onClick={() => setSelected(t.id)}
                >
                  {t.short}
                </button>
              ))}
            </div>
          </section>

          <section className="send-area">
            {slips.map((s) => (
              <Slip key={`${selected}-${s.heading}`} {...s} />
            ))}
            {tool.id === 'take' ? (
              <HoldButton onFire={fire} disabled={busy || blocked}>{busy ? 'Sending…' : 'Hold to send both'}</HoldButton>
            ) : (
              <button type="button" className="send" disabled={busy || blocked} onClick={fire}>
                <span className="label">{busy ? 'Sending…' : 'Send it'}</span>
              </button>
            )}
            {tool.id === 'take' && balances.wallet === 0n && !busy && (
              <p className="warn-line">The normal wallet is already empty. Ask the team to reset the demo.</p>
            )}
            {tool.id === 'test' && !blocked && (
              <p className="fine">A small send the vault allows, to prove the key is real.</p>
            )}
          </section>

          <Tape groups={[...taps, ...(opening ? [{ id: 'opening', title: 'What the key opens', ...opening }] : [])]} />

          <section className="below">
            <Console demo={demo} scene={scene} balances={balances} />
          </section>
        </>
      )}
    </main>
  )
}
