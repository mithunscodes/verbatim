import { useEffect, useState } from 'react'
import { getWallet } from './chain.js'
import { SNAP_ID } from './config.js'

const REJECTED = 4001

function useSnap() {
  const [state, setState] = useState({ status: 'checking' })
  useEffect(() => {
    let current = true
    const wallet = getWallet()
    if (!wallet) return undefined
    wallet.request({ method: 'wallet_getSnaps' })
      .then((snaps) => current && setState({ status: snaps?.[SNAP_ID] ? 'installed' : 'missing' }))
      .catch(() => current && setState({ status: 'unsupported' }))
    return () => {
      current = false
    }
  }, [])
  const install = async () => {
    setState({ status: 'installing' })
    try {
      const result = await getWallet().request({ method: 'wallet_requestSnaps', params: { [SNAP_ID]: {} } })
      setState({ status: result?.[SNAP_ID] ? 'installed' : 'missing' })
    } catch (error) {
      setState({ status: 'missing', error: error?.code === REJECTED ? null : error?.message || "MetaMask couldn't add it." })
    }
  }
  return { ...state, install }
}

export default function SnapStep() {
  const snap = useSnap()
  if (snap.status === 'checking' || snap.status === 'unsupported') return null
  if (snap.status === 'installed') {
    return <p className="snap-step"><strong>✓ The Verbatim Snap is in your MetaMask.</strong> It shows your checks before you confirm.</p>
  }
  return (
    <div className="snap-step">
      <p>
        <strong>Add the Verbatim Snap to MetaMask.</strong> Before you confirm anything, MetaMask shows your checks, and
        warns you if your vault will refuse it.
      </p>
      <button className="secondary" onClick={snap.install} disabled={snap.status === 'installing'}>
        {snap.status === 'installing' ? 'Confirm in MetaMask…' : 'Add the Snap'}
      </button>
      {snap.error && <p className="panel warn small">{snap.error}</p>}
    </div>
  )
}
