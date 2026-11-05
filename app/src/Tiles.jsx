import { useEffect, useState } from 'react'
import { tileRef } from './Motion.jsx'
import { layoutWords, marksFor } from './words.js'

const TILTS = ['-3deg', '2.5deg', '-1.5deg', '3deg', '-2deg', '1.5deg', '-2.5deg', '2deg']

const SETTLE_MS = 700

function piecesOf(segments) {
  return segments.flatMap((segment) => {
    if (segment.mark) return [{ text: segment.text.trim(), mark: segment.mark }]
    return segment.text
      .split(/\s+/)
      .filter((word) => /[\p{L}\p{N}]/u.test(word))
      .map((word) => ({ text: word, mark: null }))
  })
}

function Tile({ piece, index, settled, broken, register, delay, still }) {
  const { mark } = piece
  const check = mark && mark.kind !== 'left'
  const isBroken = check && broken.includes(mark.label)
  const classes = ['tile']
  if (check && settled) classes.push('filled')
  if (isBroken) classes.push('broken')
  if (mark?.kind === 'left') classes.push('left')
  const wrap = isBroken ? 'tile-wrap shake' : 'tile-wrap'
  return (
    <span
      className={wrap}
      style={{ transform: `rotate(${settled && mark?.kind !== 'left' ? '0deg' : TILTS[index % TILTS.length]})`, transitionDelay: `${index * 70}ms` }}
    >
      <span className={still ? 'tile-burst still' : 'tile-burst'} style={{ animationDelay: `${delay + index * 70}ms` }}>
        <span className="tile-hover">
          <span
            ref={check && register ? tileRef(piece.text) : undefined}
            className={classes.join(' ')}
            style={{ transitionDelay: `${isBroken ? 0 : index * 70 + 150}ms` }}
            title={mark?.kind === 'left' ? 'Not turned into a check yet' : undefined}
          >
            {mark && settled && <span className="badge" style={{ animationDelay: `${isBroken ? 0 : index * 70 + 420}ms` }}>{mark.label}</span>}
            {piece.text}
          </span>
        </span>
      </span>
    </span>
  )
}

export default function WordTiles({ sentence, result, broken = [], register = false, instant = false, still = false, delay = 0, small = false }) {
  const [settled, setSettled] = useState(instant)
  useEffect(() => {
    if (instant) return undefined
    setSettled(false)
    const timer = setTimeout(() => setSettled(true), SETTLE_MS + delay)
    return () => clearTimeout(timer)
  }, [sentence, instant])
  const { segments, elsewhere } = layoutWords(sentence ?? '', marksFor(result))
  const pieces = piecesOf(segments)
  const extra = elsewhere.filter((mark) => mark.kind !== 'left').map((mark) => ({ text: mark.text, mark }))
  const shared = { settled, broken, register, delay, still }
  return (
    <>
      <p className={small ? 'tiles small' : 'tiles'} aria-label={sentence}>
        {pieces.map((piece, i) => <Tile key={`${i}-${piece.text}`} piece={piece} index={i} {...shared} />)}
      </p>
      {extra.length > 0 && (
        <div className="from-answers">
          <span className="eyebrow">From your answers:</span>
          <span className={small ? 'tiles small' : 'tiles'}>
            {extra.map((piece, i) => <Tile key={`a${i}-${piece.text}`} piece={piece} index={pieces.length + i} {...shared} />)}
          </span>
        </div>
      )}
    </>
  )
}
