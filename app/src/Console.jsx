import { encodeFunctionData, erc20Abi, zeroAddress } from 'viem'
import { EXPLORER } from './config.js'
import { tokenAmount } from './demo.js'
import { CopyButton } from './Copy.jsx'

const DEADLINE_HOUR = 3600

function EtherscanGuide({ demo, scene, balances }) {
  const amount = balances.vault
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [demo.thief, amount] })
  const actions = `[["${scene.token}",0,"${data}",0]]`
  const checks = `[[0,"${scene.token}","${zeroAddress}",${amount}],[2,"${scene.token}","${demo.thief}",${amount}]]`
  const deadline = String(Math.floor(Date.now() / 1000) + DEADLINE_HOUR)
  return (
    <details className="fold card">
      <summary>Do it yourself on Etherscan, without our app</summary>
      <ol className="small">
        <li>
          In MetaMask (the phone app or the browser extension), choose <strong>Add account</strong>, then <strong>Import account</strong>,
          and paste this test key. It's handed out on purpose and holds test money only. <CopyButton label="Copy the key" text={demo.key} />
        </li>
        <li>Switch MetaMask to the <strong>Sepolia</strong> test network.</li>
        <li>
          Open the vault's{' '}
          <a href={`${EXPLORER}/address/${scene.vault}#writeContract`} target="_blank" rel="noreferrer">Write Contract page on Etherscan ↗</a>{' '}
          and tap <strong>Connect to Web3</strong>. The code is verified, so you can read exactly what it does.
        </li>
        <li>
          Try <strong>saveContact</strong> with your address <CopyButton label="Copy your address" text={demo.thief} />. Expected: "Only the
          rules key can save contacts".
        </li>
        <li>
          Or try <strong>run</strong> with these three values, which send all {tokenAmount(scene, amount)} to you, with your own checks.
          Expected: "Not a saved contact".
          <span className="copy-row">
            <CopyButton label="Copy actions" text={actions} />
            <CopyButton label="Copy checks" text={checks} />
            <CopyButton label="Copy deadline (1 hour)" text={deadline} />
          </span>
        </li>
        <li>
          MetaMask may warn that it will fail. Send it anyway: the refusal is the point. The laptop screen shows it too, because it
          watches the key, not our app.
        </li>
      </ol>
    </details>
  )
}

export default function Console({ demo, scene, balances }) {
  return <EtherscanGuide demo={demo} scene={scene} balances={balances} />
}
