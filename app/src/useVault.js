import { useCallback, useEffect, useRef, useState } from 'react'
import { getAddress } from 'viem'
import { AUTO_REFRESH_MS, chain } from './config.js'
import {
  getWallet,
  isSigning,
  readAccount,
  readChainId,
  readKeyType,
  readVault,
  requestAccount,
  switchToSepolia,
} from './chain.js'

function explain(error) {
  if (error?.code === 4001) return 'You cancelled in MetaMask.'
  if (error?.code === -32002) return 'MetaMask is already asking. Open MetaMask to answer it.'
  return error?.shortMessage || error?.message || 'Something went wrong.'
}

export function roleOf(account, vault) {
  if (!account || !vault) return null
  if (account === vault.everydayKey) return 'Everyday key'
  if (account === vault.rulesKey) return 'Rules key'
  return 'Not a key of this vault'
}

export function useVault() {
  const wallet = getWallet()
  const [account, setAccount] = useState(null)
  const [chainId, setChainId] = useState(null)
  const [vault, setVault] = useState(null)
  const [keyType, setKeyType] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const onSepolia = chainId === chain.id

  useEffect(() => {
    if (!wallet) return
    readAccount(wallet).then(setAccount).catch((e) => setError(explain(e)))
    readChainId(wallet).then(setChainId).catch((e) => setError(explain(e)))
    const onAccounts = (accounts) => setAccount(accounts.length ? getAddress(accounts[0]) : null)
    const onChain = (id) => setChainId(Number(id))
    wallet.on?.('accountsChanged', onAccounts)
    wallet.on?.('chainChanged', onChain)
    return () => {
      wallet.removeListener?.('accountsChanged', onAccounts)
      wallet.removeListener?.('chainChanged', onChain)
    }
  }, [wallet])

  const latest = useRef(0)
  const reading = useRef(false)

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!wallet || !onSepolia || !account) return
    if (silent && (reading.current || isSigning())) return
    const id = ++latest.current
    reading.current = true
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    try {
      const [nextVault, nextKeyType] = await Promise.all([readVault(wallet), readKeyType(wallet, account)])
      if (id !== latest.current) return
      setVault(nextVault)
      setKeyType(nextKeyType)
    } catch (e) {
      if (!silent && id === latest.current) setError(explain(e))
    } finally {
      if (id === latest.current) {
        reading.current = false
        if (!silent) setLoading(false)
      }
    }
  }, [wallet, onSepolia, account])

  useEffect(() => {
    setVault(null)
    setKeyType(null)
    if (account && onSepolia) refresh()
  }, [account, onSepolia, refresh])

  useEffect(() => {
    if (!account || !onSepolia) return
    const tick = () => {
      if (document.visibilityState === 'visible') refresh({ silent: true })
    }
    const timer = setInterval(tick, AUTO_REFRESH_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [account, onSepolia, refresh])

  const run = (action) => async () => {
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(explain(e))
    }
  }

  return {
    hasWallet: Boolean(wallet),
    account,
    onSepolia,
    vault,
    loading,
    error,
    role: roleOf(account, vault),
    smart: Boolean(keyType?.smart),
    delegate: keyType?.delegate ?? null,
    connect: run(async () => setAccount(await requestAccount(wallet))),
    switchNetwork: run(() => switchToSepolia(wallet)),
    refresh,
  }
}
