import RPC from 'bare-rpc'
import URL from 'bare-url'
import { join } from 'bare-path'
import {
    RPC_RESET,
    RPC_MESSAGE,
    RPC_UPDATE,
    RPC_ADD,
    RPC_DELETE,
    RPC_GET_KEY,
    RPC_JOIN_KEY,
    RPC_ADD_FROM_BACKEND,
    RPC_UPDATE_FROM_BACKEND,
    RPC_DELETE_FROM_BACKEND,
    SYNC_LIST,
    RPC_REQUEST_SYNC
} from '../rpc-commands.mjs'
import b4a from 'b4a'
import Autobase from 'autobase'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import {syncListToFrontend, validateItem, addItem, updateItem, deleteItem} from './lib/item.mjs'
const { IPC } = BareKit
import { randomBytes } from 'bare-crypto'
import {loadAutobaseKey, loadLocalWriterKey, saveAutobaseKey, saveLocalWriterKey} from "./lib/key.mjs";
import {generateId} from "./lib/util.mjs";
import {setupChatSwarm} from "./lib/network.mjs";
console.error('bare backend is rocking.')
const argv0 = typeof Bare?.argv?.[0] === 'string' ? Bare.argv[0] : '';
let baseDir = '';
if (argv0) {
      try {
                baseDir = argv0.startsWith('file://') ? URL.fileURLToPath(argv0) : argv0;
          } catch {
            baseDir = '';
          }
    }
const storagePath = baseDir ? join(baseDir, 'lista') : './data';
const peerKeysString = Bare.argv[1] || '' // Comma-separated peer keys
const baseKeyHex = Bare.argv[2] || '' // Optional Autobase key (to join an existing base)
export let store
let swarm = null
export let autobase = null
let discovery = null
export let chatSwarm = null
const knownWriters = new Set()
let addedStaticPeers = false
let peerCount = 0
export let rpc = null
let currentList = []
const keyFilePath = baseDir ? join(baseDir, 'lista-autobase-key.txt') : './autobase-key.txt';
const localWriterKeyFilePath = baseDir ? join(baseDir, 'lista-local-writer-key.txt') : './local-writer-key.txt';
const DEFAULT_LIST = [
    { text: 'Tap to mark as done', isDone: false, timeOfCompletion: 0 },
    { text: 'Double tap to add new', isDone: false, timeOfCompletion: 0 },
    { text: 'Slide right slowly to delete', isDone: false, timeOfCompletion: 0 },
]

// Optional Autobase key from argv (initial base) or loaded from file
let baseKey = null
if (baseKeyHex) {
    try {
        baseKey = Buffer.from(baseKeyHex.trim(), 'hex')
        console.error('Using existing Autobase key from argv[2]:', baseKeyHex.trim())
    } catch (err) {
        console.error('Invalid base key hex, creating new base instead:', err.message)
        baseKey = null
    }
}

// If no key from argv, try loading from file (for restart persistence)
if (!baseKey) {
    baseKey = loadAutobaseKey(keyFilePath)
}

function broadcastPeerCount () {
    if (!rpc) return
    try {
        const req = rpc.request(RPC_MESSAGE)
        req.send(JSON.stringify({ type: 'peer-count', count: peerCount }))
    } catch (e) {
        console.error('Failed to broadcast peer count', e)
    }
}

async function initAutobase (newBaseKey) {
    // 1. Clean up previous Autobase instance (if any)
    if (autobase) {
        try {
            autobase.removeAllListeners('append')
            if (typeof autobase.close === 'function') {
                console.error('Closing previous Autobase instance...')
                await autobase.close()
            } else {
                console.error('Previous Autobase has no close() method, skipping close')
            }
        } catch (e) {
            console.error('Error while closing previous Autobase:', e)
        }
        autobase = null
    }

    // 2. Tear down networking bound to old store
    if (discovery) {
        try { await discovery.destroy() } catch (e) { console.error(e) }
        discovery = null
    }
    if (chatSwarm) {
        try { await chatSwarm.destroy() } catch (e) { console.error(e) }
        chatSwarm = null
    }

    // 3. Close old store
    if (store) {
        try {
            await store.close()
        } catch (e) {
            console.error('Error closing Corestore:', e)
        }
    }

    // 4. Create fresh Corestore
    store = new Corestore(storagePath)
    await store.ready()

    baseKey = newBaseKey || null
    console.error(
        'initializing a new autobase with key:',
        baseKey ? baseKey.toString('hex') : '(new base)'
    )

    // Try to load existing local writer for persistence
    let localInput = null
    const savedLocalWriterKey = loadLocalWriterKey(localWriterKeyFilePath)
    if (savedLocalWriterKey) {
        try {
            localInput = store.get({ key: savedLocalWriterKey })
            await localInput.ready()
            console.error('Loaded existing local writer from corestore:', savedLocalWriterKey.toString('hex'))
            console.error('  -> Local writer core length:', localInput.length)
        } catch (e) {
            console.error('Failed to load local writer, will create new one:', e)
            localInput = null
        }
    }

    // Create Autobase with localInput if we have one
    const autobaseOpts = { apply, open, valueEncoding: 'json' }
    if (localInput) {
        autobaseOpts.localInput = localInput
    }
    autobase = new Autobase(store, baseKey, autobaseOpts)

    console.error('Calling autobase.ready()...')
    await autobase.ready()
    console.error(
        'autobase.ready() resolved. Autobase ready, writable?',
        autobase.writable,
        ' key:',
        autobase.key?.toString('hex'),
        ' local writer key:',
        autobase.local?.key?.toString('hex')
    )

    // === STARTUP VERIFICATION ===
    // Verify that the loaded hypercore matches what we expect
    await verifyStartupIntegrity(savedLocalWriterKey, baseKey)

    // Save both keys for persistence across restarts
    if (autobase.key) {
        saveAutobaseKey(autobase.key, keyFilePath)
    }
    if (autobase.local?.key) {
        saveLocalWriterKey(autobase.local.key, localWriterKeyFilePath)
    }

    if (autobase) {
        const req = rpc.request(RPC_GET_KEY)
        req.send(autobase.key?.toString('hex'))
    }

    // Reset in-memory list for fresh base
    currentList = []

    // Update the autobase to process any pending operations
    try {
        await autobase.update()
        console.error('Autobase update() completed')

        // IMPORTANT: Rebuild currentList by replaying ALL persisted operations
        // apply() only handles NEW operations, so we need to replay history on restart
        currentList = await rebuildListFromPersistedOps()
        console.error('Rebuilt currentList from persisted ops:', currentList.length, 'items')

        // If autobase is truly empty (first run), initialize with default list items
        if (currentList.length === 0 && autobase.local.length === 0 && autobase.writable) {
            console.error('Autobase is empty (first run), initializing with default list items...')
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
                await autobase.append(op)
                console.error('Added default item:', item.text)
            }
            // Rebuild list again after adding defaults
            currentList = await rebuildListFromPersistedOps()
            console.error('Default items added, currentList now has', currentList.length, 'items')
        }

        // Sync the rebuilt list to the frontend
        syncListToFrontend()
    } catch (e) {
        console.error('Error updating autobase:', e)
        // Still sync (empty list) so frontend knows we're ready
        syncListToFrontend()
    }

    // Re-attach the append listener to the *new* instance
    autobase.on('append', async () => {
        console.error('New data appended, updating view...')
        try {
            await autobase.update()
            // Sync the updated list to frontend
            syncListToFrontend()
        } catch (e) {
            console.error('Error updating on append:', e)
        }
    })

    // Listen for view updates (triggered by replication)
    autobase.view.on('append', () => {
        console.error('View updated, syncing to frontend...')
        syncListToFrontend()
    })

    // Add static peers only once
    if (!addedStaticPeers && peerKeysString) {
        const peerKeys = peerKeysString.split(',').filter(k => k.trim())
        for (const keyHex of peerKeys) {
            try {
                const peerKey = Buffer.from(keyHex.trim(), 'hex')
                const peerCore = store.get({ key: peerKey })
                await peerCore.ready()
                await autobase.addInput(peerCore)
                console.error('Added peer writer from argv[1]:', keyHex.trim())
            } catch (err) {
                console.error('Failed to add peer from argv[1]:', keyHex, err.message)
            }
        }
        addedStaticPeers = true
    }

    // Reset peer count on new base
    peerCount = 0
    broadcastPeerCount()

    // --- Update replication swarm topic for this base ---
    const firstLocalAutobaseKey = randomBytes(32)
    const topic = autobase.key || firstLocalAutobaseKey
    console.error('Discovery topic (replication swarm):', topic.toString('hex'))

    // Switch discovery to new topic
    if (discovery) {
        try {
            await discovery.destroy()
        } catch (e) {
            console.error('Error destroying previous discovery:', e)
        }
    }

    swarm = new Hyperswarm()
    swarm.on('error', (err) => {
        console.error('Replication swarm error:', err)
    })

    swarm.on('connection', (conn) => {
        console.error('New peer connected (replication swarm)', b4a.from(conn.publicKey), conn.publicKey)
        conn.on('error', (err) => {
            console.error('Replication connection error:', err)
        })
        peerCount++
        broadcastPeerCount()

        conn.on('close', () => {
            peerCount = Math.max(0, peerCount - 1)
            broadcastPeerCount()
        })


        if (autobase) {
            autobase.replicate(conn)
        } else {
            console.error('No Autobase yet to replicate with')
        }
    })

    discovery = swarm.join(topic, { server: true, client: true })
    await discovery.flushed()
    console.error('Joined replication swarm for current base')

    // Restart chat swarm with new topic
    if (chatSwarm) {
        try {
            await chatSwarm.destroy()
        } catch (e) {
            console.error('Error destroying previous chat swarm:', e)
        }
        chatSwarm = null
    }
    setupChatSwarm(baseKey != null ? baseKey : autobase.key)
}

async function joinNewBase (baseKeyHexStr) {
    if (!baseKeyHexStr || typeof baseKeyHexStr !== 'string') {
        console.error('joinNewBase: invalid baseKey', baseKeyHexStr)
        return
    }

    try {
        const newKey = Buffer.from(baseKeyHexStr.trim(), 'hex')
        if (newKey.length !== 32) {
            console.error('joinNewBase: baseKey must be 32 bytes, got', newKey.length)
            return
        }
        console.error('Joining new Autobase key at runtime:', baseKeyHexStr.trim())
        await initAutobase(newKey).then(() => {
            console.error('Backend ready')
        }).catch((err) => {
            console.error('initAutobase failed at startup:', err)
        })
    } catch (e) {
        console.error('joinNewBase failed:', e)
    }
}

// Create RPC server
rpc = new RPC(IPC, async (req, error) => {
    console.error('got a request from react', req)
    if (error) {
        console.error('got an error from react', error)
    }
    try {
        switch (req.command) {
            case RPC_ADD: {
                const text = JSON.parse(b4a.toString(req.data))
                await addItem(text)
                break
            }
            case RPC_UPDATE: {
                const data = JSON.parse(req.data.toString())
                await updateItem(data.item)
                break
            }
            case RPC_DELETE: {
                const data = JSON.parse(req.data.toString())
                await deleteItem(data.item)
                break
            }
            case RPC_GET_KEY: {
                console.error('command RPC_GET_KEY')
                if (!autobase) {
                    console.error('RPC_GET_KEY requested before Autobase is ready')
                    break
                }
                const keyReq = rpc.request(RPC_GET_KEY)
                keyReq.send(autobase.local.key.toString('hex'))
                break
            }
            case RPC_JOIN_KEY: {
                console.error('command RPC_JOIN_KEY')
                const data = JSON.parse(req.data.toString())
                console.error('Joining new base key from RPC:', data.key)
                await joinNewBase(data.key)
                break
            }
            case RPC_REQUEST_SYNC: {
                console.error('command RPC_REQUEST_SYNC - frontend requesting current list')
                syncListToFrontend()
                break
            }
        }
    } catch (err) {
        console.error('Error handling RPC request:', err)
    }
})

// Initialize Autobase for the initial baseKey (from argv or new)
await initAutobase(baseKey).then(() => {
    console.error('Backend ready')
}).catch((err) => {
    console.error('initAutobase failed at startup:', err)
})

// Backend ready
console.error('Backend ready')

// Cleanup on teardown
Bare.on('teardown', async () => {
    console.error('Backend shutting down...')
    try {
        await swarm.destroy()
    } catch (e) {
        console.error('Error destroying replication swarm:', e)
    }
    if (chatSwarm) {
        try {
            await chatSwarm.destroy()
        } catch (e) {
            console.error('Error destroying chat swarm:', e)
        }
    }
    if (discovery) {
        try {
            await discovery.destroy()
        } catch (e) {
            console.error('Error destroying discovery:', e)
        }
    }
    try {
        await store.close()
    } catch (e) {
        console.error('Error closing store:', e)
    }
    console.error('Backend shutdown complete')
})

function open (store) {
    const view = store.get({
        name: 'test',
        valueEncoding: 'json'
    })
    console.error('opening store...', view)
    return view
}

async function apply (nodes, view, host) {
    console.error('apply started')
    for (const { value } of nodes) {
        if (!value) continue

        // Handle writer membership updates coming from handshake
        if (value.type === 'add-writer' && typeof value.key === 'string') {
            try {
                const writerKey = Buffer.from(value.key, 'hex')
                await host.addWriter(writerKey, { indexer: false })
                console.error('Added writer from add-writer op:', value.key)
            } catch (err) {
                console.error('Failed to add writer from add-writer op:', err)
            }
            continue
        }

        if (value.type === 'add') {
            if (!validateItem(value.value)) {
                console.error('Invalid item schema in add operation:', value.value)
                continue
            }
            console.error('Applying add operation for item:', value.value)
            // Update in-memory list
            currentList = [value.value, ...currentList.filter(i => i.text !== value.value.text)]
            const addReq = rpc.request(RPC_ADD_FROM_BACKEND)
            addReq.send(JSON.stringify(value.value))
            continue
        }

        if (value.type === 'delete') {
            if (!validateItem(value.value)) {
                console.error('Invalid item schema in delete operation:', value.value)
                continue
            }
            console.error('Applying delete operation for item:', value.value)
            // Update in-memory list
            currentList = currentList.filter(i => i.text !== value.value.text)
            const deleteReq = rpc.request(RPC_DELETE_FROM_BACKEND)
            deleteReq.send(JSON.stringify(value.value))
            continue
        }

        if (value.type === 'update') {
            if (!validateItem(value.value)) {
                console.error('Invalid item schema in update operation:', value.value)
                continue
            }
            console.error('Applying update operation for item:', value.value)
            // Update in-memory list
            currentList = currentList.map(i =>
                i.text === value.value.text ? value.value : i
            )
            const updateReq = rpc.request(RPC_UPDATE_FROM_BACKEND)
            updateReq.send(JSON.stringify(value.value))
            continue
        }

        if (value.type === 'list') {
            if (!Array.isArray(value.value)) {
                console.error('Invalid list operation payload, expected array:', value.value)
                continue
            }
            console.error('Applying list operation for items:', value.value)
            const updateReq = rpc.request(SYNC_LIST)
            updateReq.send(JSON.stringify(value.value))
            continue
        }

        // All other values are appended to the view (for future use)
        await view.append(value)
    }
}

// Rebuild currentList by replaying all persisted operations from the local hypercore
// This is called on startup to reconstruct state from disk
async function rebuildListFromPersistedOps () {
    if (!autobase || !autobase.local) {
        console.error('rebuildListFromPersistedOps: autobase or local core not available')
        return []
    }

    const rebuiltList = []
    const length = autobase.local.length

    console.error(`rebuildListFromPersistedOps: reading ${length} entries from local hypercore...`)

    for (let i = 0; i < length; i++) {
        try {
            const entry = await autobase.local.get(i)
            if (!entry) {
                console.error(`  entry ${i}: null/undefined`)
                continue
            }

            // Autobase stores entries in internal format:
            // { version, node: { heads, batch, value }, checkpoint, digest, optimistic, trace }
            // The actual user data is in entry.node.value as a byte array object {"0":123,"1":34,...}
            let op = null

            if (entry.node && entry.node.value) {
                // Extract the byte array from entry.node.value
                const valueObj = entry.node.value
                try {
                    // Convert byte array object {"0":123,"1":34,...} to Buffer then to string
                    const bytes = Object.values(valueObj)
                    const jsonStr = Buffer.from(bytes).toString('utf8')
                    op = JSON.parse(jsonStr)
                    console.error(`  entry ${i}: extracted op type=${op.type}`)
                } catch (parseErr) {
                    console.error(`  entry ${i}: failed to parse node.value: ${parseErr.message}`)
                    continue
                }
            } else if (Buffer.isBuffer(entry)) {
                // Fallback: direct buffer
                try {
                    op = JSON.parse(entry.toString())
                    console.error(`  entry ${i}: parsed from buffer, type=${op.type}`)
                } catch (parseErr) {
                    console.error(`  entry ${i}: failed to parse buffer: ${parseErr.message}`)
                    continue
                }
            } else if (typeof entry === 'object' && entry.type) {
                // Fallback: direct object with type property
                op = entry
                console.error(`  entry ${i}: direct object, type=${op.type}`)
            } else {
                console.error(`  entry ${i}: unknown format, keys=${Object.keys(entry).join(',')}`)
                continue
            }

            if (!op || !op.type) {
                console.error(`  entry ${i}: no valid op extracted`)
                continue
            }

            // Skip add-writer operations (not list data)
            if (op.type === 'add-writer') {
                console.error(`  entry ${i}: skipped add-writer op`)
                continue
            }

            if (op.type === 'add' && op.value && validateItem(op.value)) {
                // Add: insert at front, remove duplicates by text
                const filtered = rebuiltList.filter(item => item.text !== op.value.text)
                filtered.unshift(op.value)
                rebuiltList.length = 0
                rebuiltList.push(...filtered)
                console.error(`    -> added item: ${op.value.text}`)
            } else if (op.type === 'update' && op.value && validateItem(op.value)) {
                // Update: replace matching item
                const idx = rebuiltList.findIndex(item => item.text === op.value.text)
                if (idx !== -1) {
                    rebuiltList[idx] = op.value
                    console.error(`    -> updated item: ${op.value.text}`)
                }
            } else if (op.type === 'delete' && op.value) {
                // Delete: remove matching item
                const idx = rebuiltList.findIndex(item => item.text === op.value.text)
                if (idx !== -1) {
                    rebuiltList.splice(idx, 1)
                    console.error(`    -> deleted item: ${op.value.text}`)
                }
            } else {
                console.error(`    -> skipped (type=${op.type}, hasValue=${!!op.value}, valid=${op.value ? validateItem(op.value) : 'N/A'})`)
            }
        } catch (e) {
            console.error(`rebuildListFromPersistedOps: error reading entry ${i}:`, e.message)
        }
    }

    console.error(`rebuildListFromPersistedOps: rebuilt list with ${rebuiltList.length} items`)
    return rebuiltList
}
