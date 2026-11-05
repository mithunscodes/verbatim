import { useCallback, useEffect, useState } from 'react'
import { PrivyProvider, usePrivy } from '@privy-io/react-auth'
import { ZG_PRIVY_APP_ID } from './config.js'
import { Rolling } from './Motion.jsx'
import { closeZeroG, openZeroG, readBalance, zeroGSession, ZG_SPENT } from './credits.js'

const PRIVY_CONFIG = {
  loginMethods: ['email', 'google', 'wallet'],
  embeddedWallets: { ethereum: { createOnLogin: 'off' } },
}

const REFRESH_AFTER_MS = [3000, 10000]

function usd(micro) {
  return `$${(Number(micro ?? 0) / 1e6).toFixed(4)}`
}

function Account() {
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy()
  const [state, setState] = useState({ status: 'idle' })
  const [round, setRound] = useState(0)

  const refresh = useCallback(async () => {
    if (!zeroGSession()) return
    try {
      setState({ status: 'open', balance: await readBalance() })
    } catch (error) {
      setState({ status: 'error', error: error.message })
    }
  }, [])

  useEffect(() => {
    if (!ready) return undefined
    if (!authenticated) {
      closeZeroG()
      setState({ status: 'idle' })
      return undefined
    }
    let current = true
    const open = async () => {
      if (!zeroGSession()) await openZeroG(await getAccessToken())
      const balance = await readBalance()
      if (current) setState({ status: 'open', balance })
    }
    setState({ status: 'opening' })
    open().catch((error) => current && setState({ status: 'error', error: error.message }))
    return () => {
      current = false
    }
  }, [ready, authenticated, round])

  useEffect(() => {
    const timers = []
    const spent = () => REFRESH_AFTER_MS.forEach((ms) => timers.push(setTimeout(refresh, ms)))
    window.addEventListener(ZG_SPENT, spent)
    return () => {
      window.removeEventListener(ZG_SPENT, spent)
      timers.forEach(clearTimeout)
    }
  }, [refresh])

  const signOut = async () => {
    closeZeroG()
    setState({ status: 'idle' })
    await logout()
  }

  const retry = () => {
    closeZeroG()
    setRound((n) => n + 1)
  }

  return (
    <section className="card">
      <div className="card-head">
        <span className="eyebrow">Who pays for the sealed AI</span>
        {authenticated && <button className="secondary compact" onClick={signOut}>Sign out of 0G</button>}
      </div>
      {!ready && <p className="muted small">Loading 0G sign-in…</p>}
      {ready && !authenticated && (
        <>
          <p>Verbatim pays for the sealed AI that reads your words. Sign in with 0G to pay with your own 0G credits instead.</p>
          <div className="actions">
            <button onClick={login}>Sign in with 0G</button>
          </div>
        </>
      )}
      {authenticated && state.status === 'opening' && <p className="muted small">Connecting to your 0G account…</p>}
      {authenticated && state.status === 'open' && (
        <>
          <p>Your 0G account pays for each sealed AI read: your sentence and the live preview.</p>
          <p className="credits">
            Free credits <strong><Rolling value={usd(state.balance.credit_balance)} /></strong>
          </p>
        </>
      )}
      {authenticated && state.status === 'error' && (
        <p className="panel warn small">
          {state.error} <button className="link" onClick={retry}>Try again</button>
        </p>
      )}
    </section>
  )
}

export default function ZeroG() {
  return (
    <PrivyProvider appId={ZG_PRIVY_APP_ID} config={PRIVY_CONFIG}>
      <Account />
    </PrivyProvider>
  )
}
