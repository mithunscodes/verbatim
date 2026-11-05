import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const BOUNCY = 'linear(0, 0.03, 0.11, 0.221, 0.35, 0.485, 0.616, 0.738, 0.844, 0.933, 1.004, 1.057, 1.093, 1.115, 1.125, 1.125, 1.118, 1.106, 1.091, 1.074, 1.057, 1.041, 1.026, 1.014, 1.004, 0.996, 0.99, 0.987, 0.985, 0.984, 0.985, 0.986, 0.988, 0.99, 0.992, 0.994, 0.996, 0.997, 0.999, 1, 1.001, 1.001, 1.002, 1.002, 1)'

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

const tiles = new Map()

function reduced() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export function normalWords(text) {
  return String(text ?? '').toLowerCase().replace(/[“”"]/g, '').replace(/\s+/g, ' ').trim()
}

export function tileRef(text) {
  const key = normalWords(text)
  return (el) => {
    if (!el) return undefined
    tiles.set(key, el)
    return () => {
      if (tiles.get(key) === el) tiles.delete(key)
    }
  }
}

function sourceFor(words) {
  for (const piece of words ?? []) {
    const el = tiles.get(normalWords(piece))
    if (el && el.isConnected && el.getBoundingClientRect().width > 0) return el
  }
  return null
}

export function useFlight(words, delay = 0) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || reduced() || typeof el.animate !== 'function') return
    const source = sourceFor(words)
    if (!source) return
    const a = source.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    if (!b.width || !b.height) return
    const dx = a.left + a.width / 2 - (b.left + b.width / 2)
    const dy = a.top + a.height / 2 - (b.top + b.height / 2)
    const scale = Math.min(1.25, Math.max(0.6, a.height / b.height))
    const frames = [
      { transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(-6deg)`, opacity: 0 },
      { opacity: 1, offset: 0.12 },
      { transform: 'translate(0px, 0px) scale(1) rotate(0deg)', opacity: 1 },
    ]
    const timing = { duration: 1000, delay, fill: 'backwards' }
    let flight
    try {
      flight = el.animate(frames, { ...timing, easing: BOUNCY })
    } catch {
      flight = el.animate(frames, { ...timing, easing: 'cubic-bezier(.34,1.56,.64,1)' })
    }
    return () => flight.cancel()
  }, [])
  return ref
}

export function Words({ text, delay = 0, step = 80 }) {
  const words = String(text).split(' ').filter(Boolean)
  return words.map((word, i) => (
    <span key={i}>
      <span className="word" style={{ animationDelay: `${delay + i * step}ms` }}>{word}</span>
      {i < words.length - 1 ? ' ' : ''}
    </span>
  ))
}

export function Check({ size = 28, delay = 0, ring = true }) {
  return (
    <svg className="drawn" width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      {ring && <circle className="ring" cx="14" cy="14" r="12" style={{ animationDelay: `${delay}ms` }} />}
      <path className="tick" d="M8.5 14.5l3.5 3.5 7.5-8" style={{ animationDelay: `${delay + (ring ? 650 : 0)}ms` }} />
    </svg>
  )
}

export function Cross({ size = 28, delay = 0, ring = true }) {
  return (
    <svg className="drawn" width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      {ring && <circle className="ring" cx="14" cy="14" r="12" style={{ animationDelay: `${delay}ms` }} />}
      <path className="cross" d="M10 10l8 8M18 10l-8 8" style={{ animationDelay: `${delay + (ring ? 650 : 0)}ms` }} />
    </svg>
  )
}

export function Spinner({ size = 22 }) {
  return (
    <svg className="spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3a9 9 0 1 1-9 9" />
    </svg>
  )
}

export function Dots() {
  return (
    <span className="dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

export function Rolling({ value }) {
  const text = String(value)
  const [shown, setShown] = useState(null)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(text))
    return () => cancelAnimationFrame(id)
  }, [text])
  const chars = text.split('')
  return (
    <span className="odo" aria-label={text} role="img">
      {chars.map((ch, i) => {
        const key = chars.length - i
        if (!DIGITS.includes(ch)) return <span key={`s${key}`} className="odo-sep" aria-hidden="true">{ch}</span>
        const digit = shown === null ? 0 : Number(shown.split('')[i] ?? ch)
        const at = Number.isNaN(digit) ? Number(ch) : digit
        return (
          <span key={`d${key}`} className="odo-col" aria-hidden="true">
            <span className="odo-strip" style={{ transform: `translateY(calc(${-at} * 1.12em))` }}>
              {DIGITS.map((d) => <span key={d}>{d}</span>)}
            </span>
          </span>
        )
      })}
    </span>
  )
}
