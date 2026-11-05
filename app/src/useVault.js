import { useCallback, useEffect, useState } from 'react'
import { getAddress } from 'viem'
import { chain } from './config.js'
import {
  getWallet,
  readAccount,
  readChainId,
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

  const refresh = useCallback(async () => {
    if (!wallet || !onSepolia) return
    setLoading(true)
    setError(null)
    try {
      setVault(await readVault(wallet))
    } catch (e) {
      setError(explain(e))
    } finally {
      setLoading(false)
    }
  }, [wallet, onSepolia])

  useEffect(() => {
    setVault(null)
    if (account && onSepolia) refresh()
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
    connect: run(async () => setAccount(await requestAccount(wallet))),
    switchNetwork: run(() => switchToSepolia(wallet)),
    refresh,
  }
}
