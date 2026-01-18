// Autobase initialization, apply, open, and rebuild functions

import Autobase from 'autobase'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import fs from 'bare-fs'
import { randomBytes } from 'bare-crypto'
import { log, generateId } from './utils.mjs'
import {
    autobase, store, rpc, baseKey, currentList, addedStaticPeers,
    setAutobase, setStore, setSwarm, setDiscovery, setBaseKey,
    setCurrentList, setPeerCount, setAddedStaticPeers, knownWriters
} from './state.mjs'
import { storagePath } from './storage.mjs'
import { saveAutobaseKey, loadAutobaseKey, saveLocalWriterKey, loadLocalWriterKey } from './keys.mjs'
import { isTransientReplicationError, isStateMismatchError, retryWithBackoff, resetCorruptedState } from './errors.mjs'
import { setupChatSwarm, broadcastPeerCount, createReplicationSwarm } from './networking.mjs'
import { validateItem } from './items.mjs'
import {
    RPC_GET_KEY, SYNC_LIST,
    RPC_ADD_FROM_BACKEND, RPC_UPDATE_FROM_BACKEND, RPC_DELETE_FROM_BACKEND
} from '../../rpc-commands.mjs'

// Default list items for first-time users
const DEFAULT_LIST = [
    { text: 'Tap to mark as done', isDone: false, timeOfCompletion: 0 },
    { text: 'Double tap to add new', isDone: false, timeOfCompletion: 0 },
    { text: 'Slide right slowly to delete', isDone: false, timeOfCompletion: 0 },
]

// Send current list to frontend
export function syncListToFrontend() {
    if (!rpc) return
    try {
        const req = rpc.request(SYNC_LIST)
        req.send(JSON.stringify(currentList))
        log('Synced list to frontend:', currentList.length, 'items')
    } catch (e) {
        log('Failed to sync list to frontend:', e)
    }
}

// Store opener function for autobase
export function open(corestore) {
    const view = corestore.get({
        name: 'test',
        valueEncoding: 'json'
    })
    log('opening store...', view)
    return view
}

// Apply function for processing autobase nodes
export async function apply(nodes, view, host, initAutobaseFn) {
    log(`=== APPLY: Processing ${nodes.length} nodes ===`)
    log(`  View length before: ${view.length}`)
    log(`  Current list items: ${currentList.length}`)

    // Get a reference to current store for writer core operations
    const currentStore = store

    for (const { value } of nodes) {
        if (!value) continue

        // Handle writer membership updates coming from handshake
        if (value.type === 'add-writer' && typeof value.key === 'string') {
            try {
                const writerKey = Buffer.from(value.key, 'hex')
                await host.addWriter(writerKey, { indexer: false })
                log('Added writer from add-writer op:', value.key)

                // Ensure the writer's core is opened in the store
                if (currentStore) {
                    const writerCore = currentStore.get({ key: writerKey })
                    await writerCore.ready()
                    log('Writer core opened, length:', writerCore.length, 'key:', value.key.slice(0, 16) + '...')

                    // Listen for new data on this writer's core
                    writerCore.on('append', async () => {
                        log('Writer core append event, triggering update...')
                        try {
                            if (autobase) {
                                await retryWithBackoff(async () => {
                                    await autobase.update()
                                }, 'writerCore.append.update', 3, 100, initAutobaseFn)
                            }
                        } catch (e) {
                            log('Error updating on writer append:', e)
                            if (!isTransientReplicationError(e)) {
                                throw e
                            }
                        }
                    })
                }
            } catch (err) {
                log('Failed to add writer from add-writer op:', err)
            }
            // IMPORTANT: Append to view to maintain checkpoint sync
            await view.append({ type: 'add-writer', key: value.key })
            continue
        }

        if (value.type === 'add') {
            if (!validateItem(value.value)) {
                log('Invalid item schema in add operation:', value.value)
                continue
            }
            log('Applying add operation for item:', value.value.text)
            // Update in-memory list
            setCurrentList([value.value, ...currentList.filter(i => i.text !== value.value.text)])
            try {
                const addReq = rpc.request(RPC_ADD_FROM_BACKEND)
                addReq.send(JSON.stringify(value.value))
            } catch (e) {
                log('Failed to send add notification to frontend:', e)
            }
            await view.append(value)
            continue
        }

        if (value.type === 'delete') {
            if (!validateItem(value.value)) {
                log('Invalid item schema in delete operation:', value.value)
                continue
            }
            log('Applying delete operation for item:', value.value.text)
            setCurrentList(currentList.filter(i => i.text !== value.value.text))
            try {
                const deleteReq = rpc.request(RPC_DELETE_FROM_BACKEND)
                deleteReq.send(JSON.stringify(value.value))
            } catch (e) {
                log('Failed to send delete notification to frontend:', e)
            }
            await view.append(value)
            continue
        }

        if (value.type === 'update') {
            if (!validateItem(value.value)) {
                log('Invalid item schema in update operation:', value.value)
                continue
            }
            log('Applying update operation for item:', value.value.text)
            setCurrentList(currentList.map(i =>
                i.text === value.value.text ? value.value : i
            ))
            try {
                const updateReq = rpc.request(RPC_UPDATE_FROM_BACKEND)
                updateReq.send(JSON.stringify(value.value))
            } catch (e) {
                log('Failed to send update notification to frontend:', e)
            }
            await view.append(value)
            continue
        }

        if (value.type === 'list') {
            if (!Array.isArray(value.value)) {
                log('Invalid list operation payload, expected array:', value.value)
                continue
            }
            log('Applying list operation for items:', value.value.length)
            try {
                const updateReq = rpc.request(SYNC_LIST)
                updateReq.send(JSON.stringify(value.value))
            } catch (e) {
                log('Failed to send list sync to frontend:', e)
            }
            await view.append(value)
            continue
        }

        // All other values are appended to the view
        log(`  Applying unknown operation type: ${value.type}`)
        await view.append(value)
    }
    log(`=== APPLY COMPLETE: View length now: ${view.length}, List items: ${currentList.length} ===`)
}

// Verify startup integrity - ensures the correct hypercore is loaded on restart
export async function verifyStartupIntegrity(savedLocalWriterKey, savedBaseKey) {
    log('=== STARTUP INTEGRITY CHECK ===')

    if (!autobase) {
        log('INTEGRITY CHECK: FAILED - autobase not initialized')
        return false
    }

    const checks = []

    // 1. Verify local writer key matches saved key (if we had one)
    if (savedLocalWriterKey) {
        const loadedLocalKeyHex = autobase.local?.key?.toString('hex')
        const savedLocalKeyHex = savedLocalWriterKey.toString('hex')
        const localKeyMatch = loadedLocalKeyHex === savedLocalKeyHex

        checks.push({
            name: 'Local writer key match',
            passed: localKeyMatch,
            expected: savedLocalKeyHex.slice(0, 16) + '...',
            actual: loadedLocalKeyHex?.slice(0, 16) + '...'
        })
    }

    // 2. Verify autobase key matches saved key (if we had one)
    if (savedBaseKey) {
        const loadedBaseKeyHex = autobase.key?.toString('hex')
        const savedBaseKeyHex = savedBaseKey.toString('hex')
        const baseKeyMatch = loadedBaseKeyHex === savedBaseKeyHex

        checks.push({
            name: 'Autobase key match',
            passed: baseKeyMatch,
            expected: savedBaseKeyHex.slice(0, 16) + '...',
            actual: loadedBaseKeyHex?.slice(0, 16) + '...'
        })
    }

    // 3. Verify local hypercore has data (if it's a restart)
    if (savedLocalWriterKey && autobase.local) {
        await autobase.local.ready()
        const hasData = autobase.local.length > 0

        checks.push({
            name: 'Local hypercore has persisted data',
            passed: hasData,
            expected: '> 0 entries',
            actual: `${autobase.local.length} entries`
        })
    }

    // 4. Verify storage path is accessible
    try {
        const storageExists = fs.existsSync(storagePath)
        checks.push({
            name: 'Storage path exists',
            passed: storageExists,
            expected: 'true',
            actual: String(storageExists)
        })
    } catch (e) {
        checks.push({
            name: 'Storage path exists',
            passed: false,
            expected: 'true',
            actual: `error: ${e.message}`
        })
    }

    // Log all checks
    let allPassed = true
    for (const check of checks) {
        const status = check.passed ? 'PASS' : 'FAIL'
        log(`  [${status}] ${check.name}: expected=${check.expected}, actual=${check.actual}`)
        if (!check.passed) allPassed = false
    }

    log(`=== INTEGRITY CHECK ${allPassed ? 'PASSED' : 'FAILED'} ===`)
    log(`Storage path: ${storagePath}`)
    log(`Autobase key: ${autobase.key?.toString('hex')}`)
    log(`Local writer key: ${autobase.local?.key?.toString('hex')}`)
    log(`Local writer length: ${autobase.local?.length}`)
    log(`Autobase writable: ${autobase.writable}`)

    return allPassed
}

// Rebuild currentList by replaying all persisted operations from the local hypercore
export async function rebuildListFromPersistedOps() {
    if (!autobase || !autobase.local) {
        log('rebuildListFromPersistedOps: autobase or local core not available')
        return []
    }

    const rebuiltList = []
    const length = autobase.local.length

    log(`rebuildListFromPersistedOps: reading ${length} entries from local hypercore...`)

    for (let i = 0; i < length; i++) {
        try {
            const entry = await autobase.local.get(i)
            if (!entry) {
                log(`  entry ${i}: null/undefined`)
                continue
            }

            // Autobase stores entries in internal format
            let op = null

            if (entry.node && entry.node.value) {
                const valueObj = entry.node.value
                try {
                    const bytes = Object.values(valueObj)
                    const jsonStr = Buffer.from(bytes).toString('utf8')
                    op = JSON.parse(jsonStr)
                    log(`  entry ${i}: extracted op type=${op.type}`)
                } catch (parseErr) {
                    log(`  entry ${i}: failed to parse node.value: ${parseErr.message}`)
                    continue
                }
            } else if (Buffer.isBuffer(entry)) {
                try {
                    op = JSON.parse(entry.toString())
                    log(`  entry ${i}: parsed from buffer, type=${op.type}`)
                } catch (parseErr) {
                    log(`  entry ${i}: failed to parse buffer: ${parseErr.message}`)
                    continue
                }
            } else if (typeof entry === 'object' && entry.type) {
                op = entry
                log(`  entry ${i}: direct object, type=${op.type}`)
            } else {
                log(`  entry ${i}: unknown format, keys=${Object.keys(entry).join(',')}`)
                continue
            }

            if (!op || !op.type) {
                log(`  entry ${i}: no valid op extracted`)
                continue
            }

            // Skip add-writer operations (not list data)
            if (op.type === 'add-writer') {
                log(`  entry ${i}: skipped add-writer op`)
                continue
            }

            if (op.type === 'add' && op.value && validateItem(op.value)) {
                const filtered = rebuiltList.filter(item => item.text !== op.value.text)
                filtered.unshift(op.value)
                rebuiltList.length = 0
                rebuiltList.push(...filtered)
                log(`    -> added item: ${op.value.text}`)
            } else if (op.type === 'update' && op.value && validateItem(op.value)) {
                const idx = rebuiltList.findIndex(item => item.text === op.value.text)
                if (idx !== -1) {
                    rebuiltList[idx] = op.value
                    log(`    -> updated item: ${op.value.text}`)
                }
            } else if (op.type === 'delete' && op.value) {
                const idx = rebuiltList.findIndex(item => item.text === op.value.text)
                if (idx !== -1) {
                    rebuiltList.splice(idx, 1)
                    log(`    -> deleted item: ${op.value.text}`)
                }
            } else {
                log(`    -> skipped (type=${op.type}, hasValue=${!!op.value}, valid=${op.value ? validateItem(op.value) : 'N/A'})`)
            }
        } catch (e) {
            log(`rebuildListFromPersistedOps: error reading entry ${i}:`, e.message)
        }
    }

    log(`rebuildListFromPersistedOps: rebuilt list with ${rebuiltList.length} items`)
    return rebuiltList
}

// Initialize Autobase
export async function initAutobase(newBaseKey, peerKeysString = '') {
    // Create a bound reference to this function for callbacks
    const initAutobaseFn = (key) => initAutobase(key, peerKeysString)

    // 1. Clean up previous Autobase instance (if any)
    if (autobase) {
        try {
            autobase.removeAllListeners('append')
            if (typeof autobase.close === 'function') {
                log('Closing previous Autobase instance...')
                await autobase.close()
            } else {
                log('Previous Autobase has no close() method, skipping close')
            }
        } catch (e) {
            log('Error while closing previous Autobase:', e)
        }
        setAutobase(null)
    }

    // 2. Tear down networking bound to old store
    const { discovery, chatSwarm } = await import('./state.mjs')
    if (discovery) {
        try { await discovery.destroy() } catch (e) { log(e) }
        setDiscovery(null)
    }
    if (chatSwarm) {
        try { await chatSwarm.destroy() } catch (e) { log(e) }
    }

    // 3. Close old store
    if (store) {
        try {
            await store.close()
        } catch (e) {
            log('Error closing Corestore:', e)
        }
    }

    // 4. Create fresh Corestore
    const newStore = new Corestore(storagePath)
    await newStore.ready()
    setStore(newStore)

    // Determine if we're joining a DIFFERENT base than before
    const savedBaseKey = loadAutobaseKey()
    const isJoiningDifferentBase = newBaseKey && savedBaseKey &&
        newBaseKey.toString('hex') !== savedBaseKey.toString('hex')

    setBaseKey(newBaseKey || null)
    log(
        'initializing a new autobase with key:',
        newBaseKey ? newBaseKey.toString('hex') : '(new base)',
        'isJoiningDifferentBase:', isJoiningDifferentBase
    )

    // Try to load existing local writer for persistence
    let localInput = null
    const savedLocalWriterKey = loadLocalWriterKey()

    if (isJoiningDifferentBase) {
        log('Joining different base - creating fresh local writer (old items will be discarded)')
        localInput = null
    } else if (savedLocalWriterKey) {
        try {
            localInput = newStore.get({ key: savedLocalWriterKey })
            await localInput.ready()
            log('Loaded existing local writer from corestore:', savedLocalWriterKey.toString('hex'))
            log('  -> Local writer core length:', localInput.length)
        } catch (e) {
            log('Failed to load local writer, will create new one:', e)
            localInput = null
        }
    }

    // Create Autobase with localInput if we have one
    const autobaseOpts = {
        apply: (nodes, view, host) => apply(nodes, view, host, initAutobaseFn),
        open,
        valueEncoding: 'json'
    }
    if (localInput) {
        autobaseOpts.localInput = localInput
    }
    const newAutobase = new Autobase(newStore, newBaseKey, autobaseOpts)
    setAutobase(newAutobase)

    log('Calling autobase.ready()...')
    await newAutobase.ready()

    // Determine role
    const isHost = newAutobase.writable
    const autobaseKeyHex = newAutobase.key?.toString('hex')
    const localWriterKeyHex = newAutobase.local?.key?.toString('hex')
    const isOwner = autobaseKeyHex === localWriterKeyHex

    log('=== AUTOBASE INITIALIZATION COMPLETE ===')
    log(`  Role: ${isHost ? 'HOST (writable)' : 'GUEST (waiting to be added as writer)'}`)
    log(`  Autobase key: ${autobaseKeyHex}`)
    log(`  Local writer key: ${localWriterKeyHex}`)
    log(`  Is owner (keys match): ${isOwner}`)
    log(`  Writable: ${newAutobase.writable}`)

    if (!isHost) {
        log(`  NOTE: This device is a GUEST - it will request to be added as a writer by the host`)

        try {
            const bootstrapCore = newStore.get({ key: newAutobase.key })
            await bootstrapCore.ready()
            log(`  Bootstrap core opened, length: ${bootstrapCore.length}`)

            if (typeof newAutobase.addInput === 'function') {
                await newAutobase.addInput(bootstrapCore)
                log(`  Added bootstrap core as input to autobase`)
            }
        } catch (e) {
            log(`  Error setting up bootstrap core input: ${e.message}`)
        }
    } else {
        log(`  NOTE: This device is the HOST - it can add other writers`)
    }

    // Startup verification
    if (!isJoiningDifferentBase) {
        await verifyStartupIntegrity(savedLocalWriterKey, newBaseKey)
    }

    // Save keys for persistence
    if (newAutobase.key) {
        saveAutobaseKey(newAutobase.key)
    }
    if (newAutobase.local?.key) {
        saveLocalWriterKey(newAutobase.local.key)
    }

    if (newAutobase && rpc) {
        const req = rpc.request(RPC_GET_KEY)
        req.send(newAutobase.key?.toString('hex'))
    }

    // Reset in-memory list for fresh base
    setCurrentList([])

    // Update autobase to process pending operations
    try {
        await newAutobase.update()
        log('Autobase update() completed')

        if (isJoiningDifferentBase) {
            log('Joined different base - list will be populated via replication')
        } else {
            const rebuiltList = await rebuildListFromPersistedOps()
            setCurrentList(rebuiltList)
            log('Rebuilt currentList from persisted ops:', rebuiltList.length, 'items')

            // Initialize with default list if empty
            if (rebuiltList.length === 0 && newAutobase.local.length === 0 && newAutobase.writable) {
                log('Autobase is empty (first run), initializing with default list items...')
                for (const item of DEFAULT_LIST) {
                    const op = {
                        type: 'add',
                        value: {
                            id: generateId(),
                            text: item.text,
                            isDone: item.isDone,
                            listId: null,
                            timeOfCompletion: item.timeOfCompletion,
                            updatedAt: Date.now(),
                            timestamp: Date.now(),
                        }
                    }
                    await newAutobase.append(op)
                    log('Added default item:', item.text)
                }
                const newList = await rebuildListFromPersistedOps()
                setCurrentList(newList)
                log('Default items added, currentList now has', newList.length, 'items')
            }
        }

        syncListToFrontend()
    } catch (e) {
        log('Error updating autobase:', e)
        syncListToFrontend()
    }

    // Re-attach the append listener
    newAutobase.on('append', async () => {
        log('=== AUTOBASE APPEND EVENT (new data detected) ===')
        log(`  Local core length: ${newAutobase.local?.length}`)
        log(`  View length: ${newAutobase.view?.length}`)
        log(`  Writable: ${newAutobase.writable}`)
        try {
            log('  Calling autobase.update() to process new data...')
            await retryWithBackoff(async () => {
                await newAutobase.update()
            }, 'autobase.append.update', 3, 100, initAutobaseFn)
            log(`  Update complete. View length now: ${newAutobase.view?.length}`)
            syncListToFrontend()
        } catch (e) {
            log('Error updating on append:', e)
            if (!isTransientReplicationError(e)) {
                throw e
            }
        }
    })

    // Listen for view updates
    try {
        newAutobase.view.on('append', () => {
            log('View updated, syncing to frontend...')
            syncListToFrontend()
        })
    } catch (e) {
        log('Error setting up view listener:', e)
        if (isStateMismatchError(e)) {
            resetCorruptedState(e.message || String(e), initAutobaseFn)
            return
        }
    }

    // Add static peers only once
    if (!addedStaticPeers && peerKeysString) {
        const peerKeys = peerKeysString.split(',').filter(k => k.trim())
        for (const keyHex of peerKeys) {
            try {
                const peerKey = Buffer.from(keyHex.trim(), 'hex')
                const peerCore = newStore.get({ key: peerKey })
                await peerCore.ready()
                await newAutobase.addInput(peerCore)
                log('Added peer writer from argv[1]:', keyHex.trim())
            } catch (err) {
                log('Failed to add peer from argv[1]:', keyHex, err.message)
            }
        }
        setAddedStaticPeers(true)
    }

    // Reset peer count on new base
    setPeerCount(0)
    broadcastPeerCount()

    // Setup replication swarm
    const firstLocalAutobaseKey = randomBytes(32)
    const topic = newAutobase.key || firstLocalAutobaseKey
    log('Discovery topic (replication swarm):', topic.toString('hex'))

    // Get current discovery ref and destroy it
    const { discovery: currentDiscovery } = await import('./state.mjs')
    if (currentDiscovery) {
        try {
            await currentDiscovery.destroy()
        } catch (e) {
            log('Error destroying previous discovery:', e)
        }
    }

    const resetFn = (msg, initFn) => resetCorruptedState(msg, initFn)
    const swarm = createReplicationSwarm(resetFn, initAutobaseFn)
    setSwarm(swarm)

    const newDiscovery = swarm.join(topic, { server: true, client: true })
    await newDiscovery.flushed()
    setDiscovery(newDiscovery)
    log('Joined replication swarm for current base')

    // Restart chat swarm
    const { chatSwarm: currentChatSwarm } = await import('./state.mjs')
    if (currentChatSwarm) {
        try {
            await currentChatSwarm.destroy()
        } catch (e) {
            log('Error destroying previous chat swarm:', e)
        }
    }
    setupChatSwarm(newBaseKey != null ? newBaseKey : newAutobase.key)
}

// Join a new base at runtime
export async function joinNewBase(baseKeyHexStr, peerKeysString = '') {
    if (!baseKeyHexStr || typeof baseKeyHexStr !== 'string') {
        log('joinNewBase: invalid baseKey', baseKeyHexStr)
        return
    }

    try {
        const newKey = Buffer.from(baseKeyHexStr.trim(), 'hex')
        if (newKey.length !== 32) {
            log('joinNewBase: baseKey must be 32 bytes, got', newKey.length)
            return
        }
        log('Joining new Autobase key at runtime:', baseKeyHexStr.trim())
        await initAutobase(newKey, peerKeysString).then(() => {
            log('Backend ready')
        }).catch((err) => {
            log('initAutobase failed at startup:', err)
        })
    } catch (e) {
        log('joinNewBase failed:', e)
    }
}
