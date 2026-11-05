import { encodeFunctionData, getAddress, isAddress, parseEther, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  ALL_ROLES,
  ETH_COIN_TYPE,
  ETH_REGISTRY,
  NAME_ROLES,
  RESOLVER_IMPL,
  RESOLVER_SET_ADDRESS,
  RESOLVER_SET_TEXT,
  ROLE_REGISTRAR,
  ROLE_SET_PARENT,
  UNIVERSAL_RESOLVER,
  VERIFIABLE_FACTORY,
  admin,
  artifact,
  connect,
  dns,
  ensTools,
  factoryAbi,
  isMain,
  live,
  option,
  options,
  registryAbi,
  resolverAbi,
  runMain,
  startLocalCopy,
} from './ens.js'
import { TRUSTED_NAMES, setupDirectory } from './directory.js'

const DEFAULT_LABEL = 'verbatimalice'
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
const BUILDER_SETUP_ROLES = ROLE_REGISTRAR | ROLE_SET_PARENT | admin(ROLE_REGISTRAR | ROLE_SET_PARENT)
const vaultArtifact = () => artifact('VerbatimVault.sol', 'VerbatimVault')

function settings() {
  const label = option('label') ?? DEFAULT_LABEL
  const contacts = options('contact').map((entry) => {
    const [contactLabel, address] = entry.split('=')
    if (!contactLabel || !isAddress(address ?? '')) throw new Error(`Write contacts as --contact ravi=0x…, not "${entry}"`)
    return { label: contactLabel, address: getAddress(address) }
  })
  return { label, contacts }
}

export async function setupName(clients, { label, vault, contacts }) {
  const { builder } = clients
  const { read, send, deployResolver, deployRegistry, registerEthName } = ensTools(clients)
  const { abi } = vaultArtifact()
  const name = `${label}.eth`
  const [everydayKey, rulesKey] = await Promise.all([read(vault, abi, 'everydayKey'), read(vault, abi, 'rulesKey')])
  console.log(`Your name: ${name}, owned by the Rules key ${rulesKey}, for the vault ${vault}`)

  const records = [
    encodeFunctionData({ abi: resolverAbi, functionName: 'setAddress', args: [dns(name), ETH_COIN_TYPE, vault] }),
    ...contacts.map((contact) =>
      encodeFunctionData({ abi: resolverAbi, functionName: 'setAddress', args: [dns(`${contact.label}.${name}`), ETH_COIN_TYPE, contact.address] }),
    ),
  ]
  const resolverGrants = [
    { account: vault, roleBitmap: ALL_ROLES },
    { account: rulesKey, roleBitmap: RESOLVER_SET_ADDRESS },
    { account: builder.address, roleBitmap: admin(RESOLVER_SET_TEXT) },
  ]
  const { address: resolver } = await deployResolver('Create your resolver: the vault holds every role, your phone can set addresses', builder, vault, resolverGrants, records)
  if (await read(resolver, resolverAbi, 'hasRootRoles', [admin(RESOLVER_SET_TEXT), builder.address])) {
    const avatar = encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: ['0x', 'avatar', ''] })
    await send('Let the everyday key set your avatar, and nothing else', builder, { address: resolver, abi: resolverAbi, functionName: 'grantSetterRoles', args: [avatar, everydayKey] })
    await send("Remove the Builder key's last role on your resolver", builder, {
      address: resolver,
      abi: resolverAbi,
      functionName: 'revokeRootRoles',
      args: [admin(RESOLVER_SET_TEXT), builder.address],
    })
  }

  const registryGrants = [
    { account: rulesKey, roleBitmap: ALL_ROLES },
    { account: builder.address, roleBitmap: BUILDER_SETUP_ROLES },
  ]
  const { address: registry } = await deployRegistry('Create the registry for your contact names', builder, name, registryGrants)
  const expiry = await registerEthName(label, rulesKey, registry, resolver)
  if (await read(registry, registryAbi, 'hasRootRoles', [ROLE_REGISTRAR, builder.address])) {
    for (const contact of contacts) {
      if ((await read(registry, registryAbi, 'findOwner', [contact.label])) !== zeroAddress) continue
      await send(`Register ${contact.label}.${name} for your phone`, builder, {
        address: registry,
        abi: registryAbi,
        functionName: 'register',
        args: [contact.label, rulesKey, zeroAddress, resolver, NAME_ROLES, expiry],
      })
    }
    await send('Record where your registry sits under .eth', builder, { address: registry, abi: registryAbi, functionName: 'setParent', args: [ETH_REGISTRY, label] })
    await send("Remove the Builder key's roles on your registry", builder, {
      address: registry,
      abi: registryAbi,
      functionName: 'revokeRootRoles',
      args: [BUILDER_SETUP_ROLES, builder.address],
    })
  }
  return { name, resolver, registry, everydayKey, rulesKey }
}

export async function checkName(clients, { label, vault, contacts }) {
  const { builder } = clients
  const { read, lookup, refusal, reporter } = ensTools(clients)
  const { abi } = vaultArtifact()
  const { report, finish } = reporter()
  const name = `${label}.eth`
  const [everydayKey, rulesKey] = await Promise.all([read(vault, abi, 'everydayKey'), read(vault, abi, 'rulesKey')])
  console.log(`Checks for ${name} on ${live ? 'Sepolia' : 'the local copy of Sepolia'}`)

  const owner = await read(ETH_REGISTRY, registryAbi, 'findOwner', [label])
  report(owner === rulesKey, `${name} is owned by the Rules key (${owner})`)
  const { resolver, record } = await lookup(name)
  const implementation = await read(VERIFIABLE_FACTORY, factoryAbi, 'verifyContract', [resolver]).catch(() => null)
  report(record === getAddress(vault) && implementation === RESOLVER_IMPL, `${name} → the vault ${record ?? 'nothing'}, from a genuine ENSv2 resolver: ${implementation === RESOLVER_IMPL}`)
  for (const contact of contacts) {
    const found = (await lookup(`${contact.label}.${name}`)).record
    report(found === contact.address, `${contact.label}.${name} → ${found ?? 'nothing'} (expected ${contact.address})`)
  }
  const registry = await read(ETH_REGISTRY, registryAbi, 'getSubregistry', [label])
  const builderLeft = (await read(resolver, resolverAbi, 'hasRootRoles', [admin(RESOLVER_SET_TEXT), builder.address]))
    || (await read(registry, registryAbi, 'hasRootRoles', [ROLE_REGISTRAR, builder.address]))
  report(!builderLeft, 'The Builder key kept no roles on your name')

  const contactName = dns(`${contacts[0]?.label ?? 'nobody'}.${name}`)
  const repoint = { address: resolver, abi: resolverAbi, functionName: 'setAddress', args: [contactName, ETH_COIN_TYPE, builder.address] }
  const byEveryday = await refusal(everydayKey, repoint)
  report(byEveryday !== null, `The everyday key can't repoint a contact (${byEveryday ?? 'it was allowed'})`)
  const byPhone = await refusal(rulesKey, repoint)
  report(byPhone === null, `Your phone can repoint a contact${byPhone ? ` (refused: ${byPhone})` : ''}`)
  const avatar = await refusal(everydayKey, { address: resolver, abi: resolverAbi, functionName: 'setText', args: [dns(name), 'avatar', 'https://example.com/me.png'] })
  report(avatar === null, `The everyday key can set your avatar${avatar ? ` (refused: ${avatar})` : ''}`)
  return { report, finish, resolver, everydayKey, rulesKey }
}

async function deployVault(clients, everydayKey, rulesKey) {
  const { publicClient, wallet, builder } = clients
  const deploy = async (label, { abi, bytecode }, args) => {
    console.log(`  ${label}`)
    const hash = await wallet(builder).deployContract({ abi, bytecode, args })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    console.log(`    done on the local copy, gas ${receipt.gasUsed}`)
    return receipt.contractAddress
  }
  const directory = await deploy('Deploy the EnsDirectory contract', artifact('EnsDirectory.sol', 'EnsDirectory'), [UNIVERSAL_RESOLVER, VERIFIABLE_FACTORY, RESOLVER_IMPL, TRUSTED_NAMES])
  return deploy('Deploy a vault that reads it', vaultArtifact(), [everydayKey, rulesKey, [USDC], directory])
}

async function rehearse() {
  console.log('Rehearsal on a private local copy of Sepolia. Nothing is sent to the real network.\n')
  const copy = await startLocalCopy()
  try {
    const clients = connect(copy.url)
    const { publicClient, testClient } = clients
    const { send, refusal } = ensTools(clients)
    const { abi } = vaultArtifact()
    await testClient.setBalance({ address: clients.builder.address, value: parseEther('10') })
    await setupDirectory(clients)

    console.log('\nA practice vault, with throwaway keys made for this rehearsal only')
    const everyday = privateKeyToAccount(generatePrivateKey())
    const phone = privateKeyToAccount(generatePrivateKey())
    const ravi = privateKeyToAccount(generatePrivateKey()).address
    const thief = privateKeyToAccount(generatePrivateKey()).address
    for (const account of [everyday, phone]) await testClient.setBalance({ address: account.address, value: parseEther('1') })
    const vault = await deployVault(clients, everyday.address, phone.address)
    await testClient.setBalance({ address: vault, value: parseEther('1') })

    const { label } = settings()
    const contacts = [{ label: 'ravi', address: ravi }]
    console.log('')
    await setupName(clients, { label, vault, contacts })
    const raviName = `ravi.${label}.eth`

    console.log('\nYour phone sets up the vault')
    const target = { address: vault, abi }
    await send(`Save ${raviName} as a contact (its address is pinned)`, phone, { ...target, functionName: 'saveContactName', args: [raviName] })
    await send('Daily limit: 1 ETH', phone, { ...target, functionName: 'setDailyLimit', args: [zeroAddress, parseEther('1')] })
    await send('New-contact limit: 0.02 ETH', phone, { ...target, functionName: 'setNewContactLimit', args: [zeroAddress, parseEther('0.02')] })
    await send('Finish setup', phone, { ...target, functionName: 'finishSetup' })

    const payment = (to, amount) => ({
      ...target,
      functionName: 'run',
      args: [
        [{ target: to, value: amount, data: '0x', operation: 0 }],
        [{ kind: 0, token: zeroAddress, to: zeroAddress, amount }],
        BigInt(Math.floor(Date.now() / 1000) + 3600) * 2n,
      ],
    })
    console.log('\nYour everyday key pays Ravi')
    await send(`Pay 0.01 ETH to ${raviName}`, everyday, payment(ravi, parseEther('0.01')))

    console.log('')
    const { report, finish, resolver } = await checkName(clients, { label, vault, contacts })
    report((await publicClient.getBalance({ address: ravi })) === parseEther('0.01'), `${raviName} received 0.01 ETH from the vault`)
    report((await clients.publicClient.readContract({ ...target, functionName: 'nameOf', args: [ravi] })) === raviName, `The vault pinned ${raviName} to ${ravi}`)
    const stranger = await refusal(everyday, payment(thief, parseEther('0.01')))
    report(stranger === 'Not a saved contact', `A payment to an unsaved address is refused (${stranger ?? 'it was allowed'})`)
    await send(`Your phone points ${raviName} to a different address`, phone, { address: resolver, abi: resolverAbi, functionName: 'setAddress', args: [dns(raviName), ETH_COIN_TYPE, thief] })
    const moved = await refusal(everyday, payment(ravi, parseEther('0.01')))
    report(moved === "This contact's address changed", `After ${raviName} is pointed elsewhere, payments to it are refused (${moved ?? 'it was allowed'})`)
    const toThief = await refusal(everyday, payment(thief, parseEther('0.01')))
    report(toThief === 'Not a saved contact', `…and so are payments to its new address, until re-approved (${toThief ?? 'it was allowed'})`)
    finish()
    if (process.argv.includes('--keep')) {
      console.log(`\nThe local copy is still running at ${copy.url}, with this vault: ${vault}`)
      console.log(`Stop it with: kill ${copy.pid}`)
      copy.leave()
      return
    }
    copy.stop()
  } catch (error) {
    copy.stop()
    throw error
  }
}

async function main() {
  const command = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'rehearse'
  if (!live) {
    if (command !== 'rehearse') throw new Error('Without --live, the only command is rehearse (the default)')
    return rehearse()
  }
  if (!['setup', 'check'].includes(command)) throw new Error('With --live, use setup or check')
  const vault = option('vault')
  if (!vault || !isAddress(vault)) throw new Error('Add --vault 0x… (the vault this name is for)')
  const clients = connect(process.env.SEPOLIA_RPC_URL)
  const { label, contacts } = settings()
  if (command === 'setup') {
    const { name } = await setupName(clients, { label, vault: getAddress(vault), contacts })
    console.log(`\nDone. Now, with your phone (the Rules key), in the app or on Etherscan:`)
    for (const contact of contacts) console.log(`- saveContactName("${contact.label}.${name}")`)
    return
  }
  const { finish } = await checkName(clients, { label, vault: getAddress(vault), contacts })
  finish()
}

if (isMain(import.meta.url)) runMain(main)
