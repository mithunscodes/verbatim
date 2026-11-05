import { useEffect, useRef, useState } from 'react'
import { reduced, Rolling } from './Motion.jsx'

const STACK = 7

const MAX_COINS = 35

const HOLD_MS = 1000

export function coinCount(amount, decimals) {
  if (amount <= 0n) return 0
  const whole = Number(amount / 10n ** BigInt(decimals))
  return Math.max(1, Math.min(MAX_COINS, whole))
}

export function Padlock() {
  return (
    <svg className="padlock" viewBox="0 0 40 48" width="34" height="41" aria-hidden="true">
      <path className="shackle" d="M11 22V14a9 9 0 0 1 18 0v8" />
      <rect className="lock-body" x="5" y="21" width="30" height="23" rx="3" />
      <circle className="lock-hole" cx="20" cy="31" r="3" />
      <path className="lock-hole" d="M20 33v5" />
    </svg>
  )
}

export function Typed({ text, delay = 0, speed = 24, className }) {
  const [count, setCount] = useState(() => (reduced() ? text.length : 0))
  useEffect(() => {
    if (reduced()) {
      setCount(text.length)
      return undefined
    }
    setCount(0)
    let typed = 0
    let timer
    const step = () => {
      typed += 1
      setCount(typed)
      if (typed < text.length) timer = setTimeout(step, speed)
    }
    timer = setTimeout(step, delay)
    return () => clearTimeout(timer)
  }, [text, delay, speed])
  const done = count >= text.length
  return (
    <span className={`typed${done ? ' done' : ''}${className ? ` ${className}` : ''}`} aria-label={text}>
      <span aria-hidden="true">{text.slice(0, count)}</span>
      <span className="ghost" aria-hidden="true">{text.slice(count)}</span>
    </span>
  )
}

export function Stamp({ children, tone = 'red', className = '', delay = 0 }) {
  return (
    <span className={`stamp ${tone} ${className}`} style={{ animationDelay: `${delay}ms` }}>
      {children}
    </span>
  )
}

export function MarkerRing({ delay = 0 }) {
  return (
    <svg className="marker-ring" viewBox="0 0 120 50" preserveAspectRatio="none" aria-hidden="true">
      <path
        d="M14 9C40 1 98 2 112 17c9 10-4 24-34 28-32 4-66 1-72-13C1 21 12 11 34 6"
        pathLength="1"
        style={{ animationDelay: `${delay}ms` }}
      />
    </svg>
  )
}

export function MarkerNote({ children, className = '' }) {
  return <p className={`marker-note ${className}`}>{children}</p>
}

export function Coins({ count, ref }) {
  const stacks = []
  for (let i = 0; i < count; i += STACK) stacks.push(Math.min(STACK, count - i))
  return (
    <div className="coins" ref={ref} aria-hidden="true">
      {stacks.map((size, s) => (
        <span key={s} className="stack">
          {Array.from({ length: size }, (_, c) => (
            <span key={c} className="coin" style={{ '--i': s * STACK + c }} />
          ))}
        </span>
      ))}
    </div>
  )
}

export function TargetCard({ label, address, href, amount, symbol, count, proof, marks, pileRef, cardRef, index, children }) {
  return (
    <article className="target" ref={cardRef} style={{ '--n': index }}>
      <span className="pin" aria-hidden="true" />
      <header>
        <h3>{label}</h3>
        <a className="addr" href={href} target="_blank" rel="noreferrer" title={address}>
          {address.slice(0, 6)}…{address.slice(-4)} ↗
        </a>
      </header>
      <div className="pile">
        <Coins count={count} ref={pileRef} />
        {marks?.bar && (
          <p key={marks.bar.key} className="bar" role="status">
            ✗ {marks.bar.text}
          </p>
        )}
      </div>
      <p className="sum">
        <span className="ringed">
          <Rolling value={amount} />
          <MarkerRing delay={700 + index * 150} />
        </span>
        <span className="unit">{symbol}</span>
      </p>
      {proof}
      {children}
      <Stamp className="target-stamp" delay={1000 + index * 180}>Target</Stamp>
      {marks?.stamp && (
        <Stamp key={marks.stamp.key} tone={marks.stamp.tone} className="verdict-stamp">
          {marks.stamp.text}
        </Stamp>
      )}
    </article>
  )
}

export function Sack() {
  return (
    <svg viewBox="0 0 56 56" width="52" height="52" aria-hidden="true">
      <path className="sack" d="M21 21c-9 6-14 14-13 22 1 7 8 10 20 10s19-3 20-10c1-8-4-16-13-22z" />
      <path className="sack-neck" d="M21 21l-3-8c4 2 7 1 10-2 3 3 6 4 10 2l-3 8z" />
      <path className="sack-rope" d="M19 21h18" />
      <text className="sack-mark" x="28" y="44" textAnchor="middle">$</text>
    </svg>
  )
}

export function Bag({ ref, amount, symbol, address, href }) {
  return (
    <div className="bag-row">
      <span className="bag" ref={ref}>
        <Sack />
      </span>
      <div className="bag-who">
        <MarkerNote className="small">Your bag</MarkerNote>
        <a className="addr" href={href} target="_blank" rel="noreferrer" title={address}>
          {address.slice(0, 6)}…{address.slice(-4)} ↗
        </a>
      </div>
      <p className="bag-sum">
        <Rolling value={amount} />
        <span className="unit">{symbol}</span>
      </p>
    </div>
  )
}

export function ContactTag({ ref, children, href }) {
  return (
    <a className="tag" ref={ref} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

export function Slip({ heading, rows, from, to, nonce }) {
  return (
    <div className="slip">
      <p className="slip-head">
        <span>{heading}</span>
        {nonce !== undefined && <span className="nonce">nonce {nonce}</span>}
      </p>
      <dl>
        {rows.map(([label, value, tone], i) => (
          <div key={label} className={tone}>
            <dt>{label}</dt>
            <dd>
              <Typed text={value} delay={i * 140} speed={10} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="slip-foot">
        from <a href={from.href} target="_blank" rel="noreferrer">{from.text} ↗</a> → to{' '}
        <a href={to.href} target="_blank" rel="noreferrer">{to.text} ↗</a>
      </p>
    </div>
  )
}

export function HoldButton({ onFire, disabled, children, ms = HOLD_MS }) {
  const [holding, setHolding] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const start = () => {
    if (disabled || timer.current) return
    setHolding(true)
    timer.current = setTimeout(() => {
      timer.current = null
      setHolding(false)
      onFire()
    }, ms)
  }
  const stop = () => {
    clearTimeout(timer.current)
    timer.current = null
    setHolding(false)
  }
  const isPress = (e) => e.key === ' ' || e.key === 'Enter'
  return (
    <button
      type="button"
      className={`send hold${holding ? ' holding' : ''}`}
      disabled={disabled}
      style={{ '--hold': `${ms}ms` }}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (!isPress(e)) return
        e.preventDefault()
        if (!e.repeat) start()
      }}
      onKeyUp={(e) => isPress(e) && stop()}
    >
      <span className="fill" aria-hidden="true" />
      <span className="label">{children}</span>
    </button>
  )
}

export function Tape({ groups }) {
  return (
    <section className="tape" aria-live="polite">
      <h2>
        The tape <span>every line opens on Etherscan</span>
      </h2>
      <ol>
        {groups.map((group) => (
          <li key={group.id} className="tape-group">
            <p className="tape-title">
              <span>{group.title}</span>
              <time>{group.time}</time>
            </p>
            <ul>
              {group.lines.map((line, i) => (
                <li key={i} className={line.tone}>
                  {line.href ? (
                    <a href={line.href} target="_blank" rel="noreferrer">
                      {line.text} <span className="out">↗</span>
                    </a>
                  ) : (
                    line.text
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  )
}

function center(el) {
  const box = el.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
}

export function topCoins(pile, count) {
  if (!pile) return []
  return [...pile.querySelectorAll('.coin')].reverse().slice(0, count)
}

export function showCoins(coins) {
  requestAnimationFrame(() => requestAnimationFrame(() => coins.forEach((coin) => (coin.style.visibility = ''))))
}

export function flyCoins(layer, coins, target, { stagger = 55, duration = 820 } = {}) {
  if (!layer || !target || !coins.length || reduced() || typeof layer.animate !== 'function') return Promise.resolve()
  const end = center(target)
  target.classList.add('catching')
  const flights = coins.map((source, i) => {
    const box = source.getBoundingClientRect()
    const coin = document.createElement('span')
    coin.className = 'coin flying'
    coin.style.left = `${box.left}px`
    coin.style.top = `${box.top}px`
    layer.appendChild(coin)
    source.style.visibility = 'hidden'
    const dx = end.x - (box.left + box.width / 2)
    const dy = end.y - (box.top + box.height / 2)
    const lift = Math.min(170, 95 + Math.abs(dx) * 0.35)
    const flight = coin.animate(
      [
        { transform: 'translate(0px, 0px) rotate(0deg) scale(1)', opacity: 1 },
        { transform: `translate(${dx * 0.45}px, ${Math.min(0, dy) * 0.5 - lift}px) rotate(200deg) scale(1.2)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${dx}px, ${dy}px) rotate(380deg) scale(0.55)`, opacity: 0.3 },
      ],
      { duration, delay: i * stagger, easing: 'cubic-bezier(.45,.05,.4,1)', fill: 'both' },
    )
    return flight.finished.catch(() => null).then(() => coin.remove())
  })
  return Promise.all(flights).then(() => {
    target.classList.remove('catching')
    bump(target)
  })
}

export function popLabel(layer, target, text, tone) {
  if (!layer || !target || reduced() || typeof layer.animate !== 'function') return
  const at = center(target)
  const label = document.createElement('span')
  label.className = `pop ${tone}`
  label.textContent = text
  label.style.left = `${at.x}px`
  label.style.top = `${at.y}px`
  layer.appendChild(label)
  label
    .animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.6)', opacity: 0 },
        { transform: 'translate(-50%, -110%) scale(1.1)', opacity: 1, offset: 0.25 },
        { transform: 'translate(-50%, -160%) scale(1)', opacity: 1, offset: 0.75 },
        { transform: 'translate(-50%, -200%) scale(1)', opacity: 0 },
      ],
      { duration: 1800, easing: 'ease-out' },
    )
    .finished.catch(() => null)
    .then(() => label.remove())
}

export function fadeCoins(coins) {
  if (!coins.length || reduced()) return Promise.resolve()
  return Promise.all(
    coins.map((coin, i) =>
      coin
        .animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-12px)' }], { duration: 500, delay: i * 30, fill: 'forwards' })
        .finished.catch(() => null),
    ),
  )
}

export function strain(pile, toward) {
  if (!pile || reduced() || typeof pile.animate !== 'function') return Promise.resolve()
  const from = center(pile)
  const to = toward ? center(toward) : { x: from.x, y: from.y + 100 }
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1
  const ux = (to.x - from.x) / length
  const uy = (to.y - from.y) / length
  const pull = (d, turn) => `translate(${ux * d}px, ${uy * d}px) rotate(${turn}deg)`
  return pile
    .animate(
      [
        { transform: pull(0, 0) },
        { transform: pull(7, 2), offset: 0.18 },
        { transform: pull(4, -1), offset: 0.3 },
        { transform: pull(11, 3), offset: 0.5 },
        { transform: pull(8, -2), offset: 0.62 },
        { transform: pull(13, 2), offset: 0.78 },
        { transform: pull(0, 0) },
      ],
      { duration: 1000, easing: 'ease-in-out' },
    )
    .finished.catch(() => null)
}

export function shake(el) {
  if (!el || reduced() || typeof el.animate !== 'function') return
  el.animate(
    [
      { translate: '0 0' },
      { translate: '-4px 2px' },
      { translate: '3px -1px' },
      { translate: '-2px 1px' },
      { translate: '0 0' },
    ],
    { duration: 320, easing: 'ease-out' },
  )
}

export function bump(el) {
  if (!el || reduced() || typeof el.animate !== 'function') return
  el.animate([{ scale: '1' }, { scale: '1.18' }, { scale: '0.94' }, { scale: '1' }], { duration: 420, easing: 'ease-out' })
}
