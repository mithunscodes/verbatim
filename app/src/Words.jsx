import { describeStep } from './intent.js'
import { layoutWords, marksFor, quoteWords, wordsOf } from './words.js'

export function YourWords({ sentence, result }) {
  const { segments, elsewhere } = layoutWords(sentence, marksFor(result))
  const fromAnswers = elsewhere.filter((mark) => mark.kind !== 'left')
  return (
    <div className="your-words">
      <p className="said-sentence">
        {segments.map((segment, i) => (segment.mark ? (
          <mark key={i} className={`said ${segment.mark.kind}`}>
            {segment.text}
            <sup>{segment.mark.label}</sup>
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        )))}
      </p>
      {fromAnswers.length > 0 && (
        <p className="muted small">
          From your answers:{' '}
          {fromAnswers.map((mark, i) => (
            <mark key={i} className={`said ${mark.kind}`}>
              {mark.text}
              <sup>{mark.label}</sup>
            </mark>
          ))}
        </p>
      )}
    </div>
  )
}

export function StepList({ result }) {
  return (
    <ul className="understood said-list">
      {result.steps.map((step, i) => (
        <li key={i}>
          <span className="said-label">{i + 1}</span>
          <span>
            {describeStep(step)}
            {wordsOf(step).length
              ? <span className="from">you said {quoteWords(wordsOf(step))}</span>
              : <span className="from warn">⚠ not matched to your words</span>}
          </span>
        </li>
      ))}
      {result.riskLimitPercent !== null && result.riskLimitPercent !== undefined && (
        <li>
          <span className="said-label risk">%</span>
          <span>
            You accept up to {result.riskLimitPercent}% price impact
            {result.riskLimitWords && <span className="from">you said “{result.riskLimitWords}”</span>}
          </span>
        </li>
      )}
      {result.nothingElse && (
        <li>
          <span className="said-label else">✓</span>
          <span>
            Nothing else
            {result.nothingElseWords && <span className="from">you said “{result.nothingElseWords}”</span>}
          </span>
        </li>
      )}
    </ul>
  )
}

export function LeftOut({ result }) {
  const left = result?.leftOut ?? []
  if (!left.length) return null
  return (
    <div className="left-out">
      <p><strong>⚠ Not turned into checks:</strong> {quoteWords(left)}</p>
      <p className="small">
        Your vault can only enforce what it can check, so these words aren't part of your request yet. Answer the question,
        or write the request again without them.
      </p>
    </div>
  )
}

export function FromWords({ words }) {
  if (!words?.length) return null
  return <span className="from">you said {quoteWords(words)}</span>
}
