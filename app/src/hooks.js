import { useEffect, useState } from 'react'
import { getWallet } from './chain.js'
import { sendContractTx, txError } from './rules.js'

export function useNow() {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)))
  useEffect(() => {
    const timer = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function useHashPage() {
  const read = () => {
    const { hash } = window.location
    if (hash === '#phone') return 'phone'
    if (hash.startsWith('#receipt/')) return `receipt:${hash.slice('#receipt/'.length)}`
    if (hash.startsWith('#attack/')) return `attack:${hash.slice('#attack/'.length)}`
    if (hash.startsWith('#side/')) return `side:${hash.slice('#side/'.length)}`
    return 'app'
  }
  const [page, setPage] = useState(read)
  useEffect(() => {
    const onHash = () => setPage(read())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return page
}

export function useTx(account, onDone) {
  const [tx, setTx] = useState({ status: 'idle' })
  const send = async (label, target, functionName, args) => {
    setTx({ status: 'signing', label })
    let ok = false
    try {
      const result = await sendContractTx(getWallet(), account, target, functionName, args)
      ok = result.ok
      setTx({ status: ok ? 'done' : 'failed', label, hash: result.hash })
    } catch (error) {
      setTx({ status: 'error', label, error: txError(error) })
    }
    await onDone()
    return ok
  }
  return { tx, send, busy: tx.status === 'signing' }
}
