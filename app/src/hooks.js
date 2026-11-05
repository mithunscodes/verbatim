import { useEffect, useState } from 'react'
import { getWallet } from './chain.js'
import { sendVaultTx, txError } from './rules.js'

export function useNow() {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)))
  useEffect(() => {
    const timer = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function useHashPage() {
  const read = () => (window.location.hash === '#phone' ? 'phone' : 'app')
  const [page, setPage] = useState(read)
  useEffect(() => {
    const onHash = () => setPage(read())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return page
}

export function useVaultTx(account, onDone) {
  const [tx, setTx] = useState({ status: 'idle' })
  const send = async (label, functionName, args) => {
    setTx({ status: 'signing', label })
    try {
      const { hash, ok } = await sendVaultTx(getWallet(), account, functionName, args)
      setTx({ status: ok ? 'done' : 'failed', label, hash })
    } catch (error) {
      setTx({ status: 'error', label, error: txError(error) })
    }
    onDone()
  }
  return { tx, send, busy: tx.status === 'signing' }
}
