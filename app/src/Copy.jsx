import { useState } from 'react'

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

export function CopyButton({ label, text }) {
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
