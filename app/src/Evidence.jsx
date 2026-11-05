import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { createPublicClient, decodeFunctionData, erc20Abi, http, zeroAddress } from 'viem'
import { getWallet } from './chain.js'
import { CheckKind, describeCheck } from './checks.js'
import { chain, DEMO_RPC_PATH, EXPLORER, PRINTS, vaultAbi } from './config.js'
import { formatAmount, shortAddress } from './format.js'
import { etherscanLine, plainSteps, VerifyIt } from './Caught.jsx'
import { Check, Cross, Dots, Words } from './Motion.jsx'
import { checksOnChain, readerFor } from './onchain.js'
import { explainFailure, PASSED_REASON } from './run.js'

const KIND_NAMES = ['AtMostLeaves', 'AtLeastArrives', 'ExactlyTo']

const MAX_CONTACTS = 40

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

function relayReader() {
  return createPublicClient({ chain, transport: http(new URL(DEMO_RPC_PATH, window.location.origin).href, { timeout: 30_000 }) })
}

function problemOf(error) {
  return error?.shortMessage || error?.message || 'Something went wrong.'
}

async function contactsOf(reader, address) {
  const contacts = []
  for (let i = 0; i < MAX_CONTACTS; i++) {
    try {
      contacts.push(await reader.readContract({ address, abi: vaultAbi, functionName: 'contacts', args: [BigInt(i)] }))
    } catch {
      break
    }
  }
  const names = {}
  await Promise.all(contacts.map(async (contact) => {
    const name = await reader.readContract({ address, abi: vaultAbi, functionName: 'nameOf', args: [contact] }).catch(() => '')
    if (name) names[contact] = name
  }))
  return { contacts: contacts.map((contact) => ({ address: contact })), names }
}

async function holdingFor(reader, token) {
  if (token === zeroAddress) return { token, symbol: 'ETH', decimals: 18 }
  if (token === PRINTS) return { token, symbol: 'Verbatim Print', decimals: 0 }
  const [symbol, decimals] = await Promise.all([
    reader.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => shortAddress(token)),
    reader.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
  ])
  return { token, symbol, decimals: Number(decimals) }
}

function balanceAt(reader, token, account, blockNumber) {
  if (token === zeroAddress) return reader.getBalance({ address: account, blockNumber })
  return reader.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account], blockNumber })
}

function rawFailure(failure) {
  if (failure?.checkNumber) return `CheckFailed(${failure.checkNumber}, "${failure.check}", ${failure.expected}, ${failure.actual})`
  return failure?.reason ? `"${failure.reason}"` : null
}

async function gather(reader, hash) {
  const [tx, receipt] = await Promise.all([reader.getTransaction({ hash }), reader.getTransactionReceipt({ hash })])
  let call
  try {
    call = decodeFunctionData({ abi: vaultAbi, data: tx.input })
  } catch {
    call = null
  }
  if (call?.functionName !== 'run') throw new Error("This transaction isn't a request to a Verbatim vault.")
  const [actions, checks, deadline] = call.args
  const address = tx.to
  const tokens = [...new Set(checks.map((check) => check.token))]
  const [block, people, holdings] = await Promise.all([
    reader.getBlock({ blockNumber: receipt.blockNumber }),
    contactsOf(reader, address),
    Promise.all(tokens.map((token) => holdingFor(reader, token))),
  ])
  const vault = { address, holdings, ...people }
  const moves = await Promise.all(holdings.map(async (holding) => {
    const [before, after] = await Promise.all([
      balanceAt(reader, holding.token, address, receipt.blockNumber - 1n),
      balanceAt(reader, holding.token, address, receipt.blockNumber),
    ])
    return { holding, before, after }
  }))
  const refused = receipt.status !== 'success'
  let failure = null
  if (refused) {
    try {
      await reader.simulateContract({ address, abi: vaultAbi, functionName: 'run', args: [actions, checks, deadline], account: tx.from, blockNumber: receipt.blockNumber - 1n })
      failure = { outside: true, reason: PASSED_REASON }
    } catch (error) {
      failure = explainFailure(error)
    }
  }
  const record = refused ? null : await checksOnChain(reader, { vault: address, hash, checks }).catch(() => null)
  return { tx, receipt, block, vault, actions, checks, moves, refused, failure, record }
}

function useEvidence(hash) {
  const [state, setState] = useState({ status: 'loading' })
  useEffect(() => {
    let current = true
    setState({ status: 'loading' })
    const wallet = getWallet()
    gather(relayReader(), hash)
      .catch((error) => (wallet ? gather(readerFor(wallet), hash) : Promise.reject(error)))
      .then((found) => current && setState({ status: 'done', ...found }))
      .catch((error) => current && setState({ status: 'error', error: problemOf(error) }))
    return () => {
      current = false
    }
  }, [hash])
  return state
}

function useQr(text) {
  const [image, setImage] = useState(null)
  useEffect(() => {
    let current = true
    QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 360 }).then((url) => current && setImage(url)).catch(() => {})
    return () => {
      current = false
    }
  }, [text])
  return image
}

function Row({ n, claim, bad, children, link, linkText, hint, delay }) {
  return (
    <li className={bad ? 'evidence-row bad' : 'evidence-row'} style={{ animationDelay: `${delay}ms` }}>
      <div className="evidence-claim">
        <span className="check-num">{n}</span>
        <strong>{claim}</strong>
      </div>
      <div className="evidence-proof">
        {children}
        {hint && <p className="muted small">{hint}</p>}
        <a className="go" href={link} target="_blank" rel="noreferrer">{linkText} ↗</a>
      </div>
    </li>
  )
}

function checkRaw(check) {
  const to = Number(check.kind) === CheckKind.ExactlyTo ? ` · to ${shortAddress(check.to)}` : ''
  return `${KIND_NAMES[Number(check.kind)]} · token ${shortAddress(check.token)}${to} · amount ${check.amount}`
}

function Found({ hash, found }) {
  const { tx, receipt, block, vault, actions, checks, moves, refused, failure, record } = found
  const steps = plainSteps(vault, actions, checks)
  const flagged = steps.filter((step) => step.flag)
  const txLink = `${EXPLORER}/tx/${hash}`
  const when = new Date(Number(block.timestamp) * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const failed = failure?.checkNumber ? checks[failure.checkNumber - 1] : null
  const failedHolding = failed ? vault.holdings.find((h) => h.token === failed.token) : null
  const anyMoved = moves.some((move) => move.before !== move.after)
  const line = refused ? etherscanLine(failure) : null
  const tried = (flagged.length ? flagged : steps).map((step) => step.text)
  const allowed = failed ? [describeCheck(vault, failed).text] : checks.map((check) => describeCheck(vault, check).text)
  const verdict = refused
    ? failed
      ? `Fail. The vault measured ${formatAmount(failure.actual, failedHolding?.decimals ?? 18, failedHolding?.decimals ?? 18)} ${failedHolding?.symbol ?? ''}.`
      : `Fail. ${failure?.reason ?? 'The vault refused it.'}`
    : 'Success. Every check held.'
  const balances = moves.map(({ holding, before, after }) => `${holding.symbol} ${formatAmount(before, holding.decimals)} → ${formatAmount(after, holding.decimals)}${before === after ? ', unchanged' : ''}`)
  return (
    <>
      <section className={refused ? 'banner never' : 'banner done'}>
        <div className="banner-head">
          {refused ? <span className="mark-bad"><Cross size={56} delay={200} /></span> : <Check size={56} delay={200} />}
          <h2><Words text={refused ? 'Stopped on Sepolia.' : 'Done on Sepolia, within your checks.'} delay={300} /></h2>
        </div>
        <ul className="story">
          <li style={{ animationDelay: '500ms' }}>
            <span className="story-label">{refused ? 'The app tried to' : 'The app asked to'}</span>
            <span className="story-text">{tried.map((text) => <span key={text}>{text}</span>)}</span>
          </li>
          <li style={{ animationDelay: '650ms' }}>
            <span className="story-label">Your words allowed</span>
            <span className="story-text">{allowed.map((text) => <span key={text}>{text}</span>)}</span>
          </li>
          <li style={{ animationDelay: '800ms' }}>
            <span className="story-label">Sepolia's verdict</span>
            <span className="story-text"><span>{verdict}</span></span>
          </li>
          <li style={{ animationDelay: '950ms' }}>
            <span className="story-label">{refused && !anyMoved ? 'Nothing moved' : 'What moved'}</span>
            <span className="story-text">{balances.map((text) => <span key={text}>{text}</span>)}</span>
          </li>
        </ul>
        <div className="story-check">
          <a className="go big-go" href={txLink} target="_blank" rel="noreferrer">Check it on Etherscan ↗</a>
          <p>
            {line
              ? <>Look for the red <strong>Fail</strong> line at the top: <code className="quote-code">{line}</code></>
              : refused
                ? failure?.outside
                  ? <>Look for the red <strong>Fail</strong> line at the top. It shows why it failed.</>
                  : <>Look for the red <strong>Fail</strong> line at the top, with the vault's own reason.</>
                : <>Status says <strong>Success</strong>, and the vault's balances changed only as your checks allow.</>}
            {failedHolding && <> {failedHolding.symbol} has {failedHolding.decimals} decimals, so that's {formatAmount(failure.expected, failedHolding.decimals, failedHolding.decimals)} allowed and {formatAmount(failure.actual, failedHolding.decimals, failedHolding.decimals)} measured.</>}
          </p>
        </div>
        <p className="muted mono full small">Transaction {hash} · block {receipt.blockNumber.toLocaleString('en-US')} · {when}</p>
      </section>

      <details className="fold more-proof">
        <summary>More proof, for developers: raw values, a Foundry replay and the vault's code</summary>
        <ol className="evidence-rows">
          <Row
            n={1}
            claim="The app asked the vault to"
            bad={flagged.length > 0}
            link={txLink}
            linkText="See the input on Etherscan"
            hint={'On Etherscan, click "Decode Input Data": this is the "actions" list, sent by the key ' + shortAddress(tx.from) + '.'}
            delay={0}
          >
            <ol className="plain-steps">
              {steps.map((step, i) => (
                <li key={i} className={step.flag ? 'flag' : undefined}>
                  <span>{step.text}</span>
                  {step.flag && <span className="pill bad">{step.label ?? 'Not in your words'}</span>}
                  {step.raw && <code className="quote-code">{step.raw}</code>}
                </li>
              ))}
            </ol>
          </Row>
          <Row
            n={2}
            claim="Your words allowed"
            link={txLink}
            linkText="See the checks on Etherscan"
            hint={'The same "Decode Input Data" view: this is the "checks" list.'}
            delay={0}
          >
            <ul className="evidence-list">
              {checks.map((check, i) => (
                <li key={i} className={failed === check ? 'broken' : undefined}>
                  <span className="check-num">{i + 1}</span>
                  <span>
                    {describeCheck(vault, check).text}
                    <code className="quote-code">{checkRaw(check)}</code>
                  </span>
                </li>
              ))}
            </ul>
          </Row>
          <Row
            n={3}
            claim="The vault's verdict"
            bad={refused}
            link={txLink}
            linkText="See the status on Etherscan"
            hint={refused ? 'The vault replayed at the block before, through Sepolia, gives this error.' : 'The vault recorded the run with a fingerprint of exactly these checks.'}
            delay={0}
          >
            {refused
              ? rawFailure(failure) && <code className="quote-code">{rawFailure(failure)}</code>
              : record?.fingerprint && <code className="quote-code">Ran · checks fingerprint {shortAddress(record.fingerprint)}</code>}
          </Row>
          <Row
            n={4}
            claim={refused ? 'Nothing moved' : 'What moved'}
            link={`${EXPLORER}/address/${vault.address}`}
            linkText="See the vault on Etherscan"
            hint={`The vault's own balances, read at the block before (${(receipt.blockNumber - 1n).toLocaleString('en-US')}) and at this block.`}
            delay={0}
          >
            <ul className="evidence-list">
              {moves.map(({ holding, before, after }) => (
                <li key={holding.token}>
                  <span>
                    <span className="row">
                      {holding.symbol}: {formatAmount(before, holding.decimals, holding.decimals)} → {formatAmount(after, holding.decimals, holding.decimals)}
                      {before === after && <span className="pill ok">unchanged</span>}
                    </span>
                    <code className="quote-code">{before.toString()} → {after.toString()}</code>
                  </span>
                </li>
              ))}
            </ul>
          </Row>
        </ol>
        {refused && !failure?.outside && <VerifyIt vault={vault} hash={hash} failure={failure} checks={checks} />}
      </details>
    </>
  )
}

function usePhoneLink() {
  const local = LOCAL_HOSTS.includes(window.location.hostname)
  const [state, setState] = useState(local ? { status: 'reading' } : { status: 'done', link: window.location.href })
  useEffect(() => {
    if (!local) return undefined
    let current = true
    fetch('/api/lan')
      .then((response) => response.json())
      .then(({ address }) => {
        if (!current) return
        if (!address) return setState({ status: 'none' })
        const { protocol, port, pathname, hash } = window.location
        setState({ status: 'done', link: `${protocol}//${address}${port ? `:${port}` : ''}${pathname}${hash}`, address: `${address}${port ? `:${port}` : ''}` })
      })
      .catch(() => current && setState({ status: 'none' }))
    return () => {
      current = false
    }
  }, [])
  return state
}

export default function Evidence({ hash }) {
  const state = useEvidence(hash)
  const phone = usePhoneLink()
  const qr = useQr(phone.link || window.location.href)
  return (
    <main className="page">
      <header className="top">
        <div className="top-left">
          <a className="brand" href="#">Verbatim</a>
          <span className="pill plain">Evidence</span>
        </div>
      </header>
      <header className="side-head">
        <div>
          <h1 className="evidence-title"><Words text="Don't trust our screen. Check Sepolia's." step={80} /></h1>
          <p className="lead">One transaction, read straight from Sepolia: what the app sent, against what your words allowed.</p>
          {phone.status === 'none' && (
            <p className="panel warn small">The QR code needs the laptop's Wi-Fi address, and the Verbatim server didn't give one. Check that the server is running and the laptop is on Wi-Fi.</p>
          )}
        </div>
        {phone.status === 'done' && (
          <figure className="qr evidence-qr">
            {qr && <img src={qr} alt="QR code that opens this evidence page" />}
            <figcaption>
              Open this on your own phone
              {phone.address && <><br />same Wi-Fi · <strong className="mono">{phone.address}</strong></>}
            </figcaption>
          </figure>
        )}
      </header>
      {state.status === 'loading' && <p className="reading">Reading the transaction from Sepolia <Dots /></p>}
      {state.status === 'error' && <p className="panel warn">Couldn't read this transaction from Sepolia: {state.error}</p>}
      {state.status === 'done' && <Found hash={hash} found={state} />}
    </main>
  )
}
