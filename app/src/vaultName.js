import { useEffect, useState } from 'react'
import { DEMO_POLL_MS } from './config.js'
import { ask } from './Replays.jsx'

export const NAME_ACTIVE = ['waiting', 'running']
const MISSES_ALLOWED = 3
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function useVaultName(vault) {
  const wanted = vault?.directory && !vault.ensName && !vault.setupFinished ? vault.address : null
  const [job, setJob] = useState(null)
  useEffect(() => {
    setJob(null)
    if (!wanted) return undefined
    let current = true
    const run = async () => {
      let next = await ask('/api/name', { vault: wanted })
      let misses = 0
      if (current) setJob(next)
      while (current && NAME_ACTIVE.includes(next.status)) {
        await sleep(DEMO_POLL_MS)
        try {
          next = await ask(`/api/name/${next.id}`)
          misses = 0
        } catch (error) {
          if (error.status === 404 || ++misses > MISSES_ALLOWED) throw error
        }
        if (current) setJob(next)
      }
    }
    run().catch((error) => current && setJob({ status: 'failed', error: error.message, steps: [] }))
    return () => {
      current = false
    }
  }, [wanted])
  return wanted ? job : null
}
