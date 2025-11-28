// /* global Bare, BareKit */

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
    SYNC_LIST
} from '../rpc-commands.mjs'
import b4a from 'b4a'
import Autobase from 'autobase'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
const { IPC } = BareKit
import { randomBytes } from 'bare-crypto'

console.error('bare backend is rocking.')

const storagePath = join(URL.fileURLToPath(Bare.argv[0]), 'lista') || './data'
const peerKeysString = Bare.argv[1] || '' // Comma-separated peer keys
const baseKeyHex = Bare.argv[2] || '' // Optional Autobase key (to join an existing base)

// Initialize Corestore
// const store = new Corestore(storagePath)
let store 
// await store.ready()
// console.error('Corestore ready at:', storagePath)

// P2P state
let swarm = null
let autobase = null
let discovery = null
let currentTopic = null

// Handshake swarm for writer key exchange
let chatSwarm = null
let chatTopic = null
const knownWriters = new Set()
let addedStaticPeers = false

// RPC instance (assigned later, but referenced by helper fns)
let rpc = null




// Optional Autobase key from argv (initial base)
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


// Generate unique ID (used only for addItem)
function generateId () {
    return randomBytes(16).toString('hex')
}


// Replicate on connection (swarm is shared between bases)


// --- Handshake swarm for writer key exchange (desktop parity) ---

function sendHandshakeMessage (conn, msg) {
    const line = JSON.stringify(msg) + '\n'
    conn.write(line)
}

async function handleHandshakeMessage (msg) {
    if (!autobase) return
    if (!msg || msg.type !== 'writer-key') return

    const remoteKeyHex = msg.key
    if (!remoteKeyHex || typeof remoteKeyHex !== 'string') return

    if (knownWriters.has(remoteKeyHex)) return
    knownWriters.add(remoteKeyHex)

    // Only a writer can add other writers.
    if (!autobase.writable) {
        console.error('Not writable here, cannot add remote writer yet')
        return
    }

    console.error('Adding remote writer via autobase:', remoteKeyHex)

    await autobase.append({
        type: 'add-writer',
        key: remoteKeyHex
    })
}

async function setupHandshakeChannel (conn) {
    if (!autobase) {
        console.error('setupHandshakeChannel called before Autobase is initialized')
        return
    }

    // Send our writer key immediately
    await autobase.ready()
    const myWriterKeyHex = autobase.local.key.toString('hex')
    sendHandshakeMessage(conn, {
        type: 'writer-key',
        key: myWriterKeyHex
    })

    let buffer = ''
    conn.on('data', (chunk) => {
        buffer += chunk.toString()
        let idx
        while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 1)
            if (!line.trim()) continue

            // Fast-path: hypercore protocol frames and other binary garbage
            // are not going to start with '{', so just ignore them.
            if (line[0] !== '{') {
                // console.warn('non-JSON frame on handshake channel (ignored)')
                continue
            }

            let msg
            try {
                msg = JSON.parse(line)
            } catch (e) {
                console.warn('invalid JSON from peer (handshake, ignored):', line)
                continue
            }

            handleHandshakeMessage(msg)
        }
    })
}


function setupChatSwarm (chatTopic) {
    if (!autobase) {
        console.error('setupChatSwarm called before Autobase is initialized')
        return
    }
    chatSwarm = new Hyperswarm()
    console.error("setting up chat swarm with topic:", chatTopic.toString('hex'))
    chatSwarm.on('connection', (conn, info) => {
        console.error('Handshake connection (chat swarm) with peer', info?.peer)
        setupHandshakeChannel(conn)
    })

    chatSwarm.join(chatTopic, { server: true, client: true })
    console.error('Handshake chat swarm joined on topic:', chatTopic.toString('hex'))
}


async function initAutobase (newBaseKey) {
    // 1. Clean up previous Autobase instance (if any)
    if (autobase) {
        try {
            autobase.removeAllListeners('append')
            if (typeof autobase.close === 'function') {
                console.error('Closing previous Autobase instance...')
                await autobase.close()
                // store = new Corestore(storagePath)
                // await store.ready()
                // console.error('Recreated Corestore after closing previous Autobase')
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

    autobase = new Autobase(store, baseKey, { apply, open, valueEncoding: 'json' })

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
    if (autobase) {
        const req = rpc.request(RPC_GET_KEY)
        req.send(autobase.key?.toString('hex'))
    }
    // Re-attach the append listener to the *new* instance
    autobase.on('append', async () => {
        console.error('New data appended, rebuilding view...')
        // await rebuildView()
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

    // Rebuild view from the new base
    // await rebuildView()
    
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
    swarm.on('connection', (conn) => {
        console.error('New peer connected (replication swarm)', b4a.from(conn.publicKey), conn.publicKey)
        if (autobase) {
            autobase.replicate(conn)
        } else {
            console.error('No Autobase yet to replicate with')
        }
    })
    
    discovery = swarm.join(topic, { server: true, client: true })
    await discovery.flushed()
    console.error('Joined replication swarm for current base')
    discovery = swarm.join(topic, { server: true, client: true })
    await discovery.flushed()

    // Restart chat swarm with new topic
    if (chatSwarm) {
        try {
            await chatSwarm.destroy()
        } catch (e) {
            console.error('Error destroying previous chat swarm:', e)
        }
        chatSwarm = null
    }
    setupChatSwarm(baseKey != null? baseKey : autobase.key)
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
        await initAutobase(newKey)
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
                // FRONTEND NOW SENDS: { item: <full item> }
                await updateItem(data.item)
                break
            }
            case RPC_DELETE: {
                const data = JSON.parse(req.data.toString())
                // FRONTEND SENDS: { item: <full item> }
                await deleteItem(data.item)
                break
            }
            case RPC_GET_KEY: {
                // Send our writer key back to UI (same key used in handshake)
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
        }
    } catch (err) {
        console.error('Error handling RPC request:', err)
    }
})

// Initialize Autobase for the initial baseKey (from argv or new)
await initAutobase(baseKey)

// send the autobase key to react (for joining/sharing)


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
            const updateReq = rpc.request(RPC_UPDATE_FROM_BACKEND)
            updateReq.send(JSON.stringify(value.value))
            continue
        }

        if (value.type === 'list') {
            if (!validateItem(value.value)) {
                console.error('Invalid item schema in list operation:', value.value)
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

// Simple inline schema validation matching the mobile ListEntry
function validateItem (item) {
    if (typeof item !== 'object' || item === null) return false
    if (typeof item.text !== 'string') return false
    if (typeof item.isDone !== 'boolean') return false
    if (typeof item.timeOfCompletion !== 'number') return false
    return true
}


// Add item operation (backend creates the canonical item)
async function addItem (text, listId) {
    if (!autobase) {
        console.error('addItem called before Autobase is initialized')
        return
    }

    console.error('command RPC_ADD addItem text', text)

    const item = {
        id: generateId(),                    // extra metadata, frontend can ignore
        text,
        isDone: false,
        listId: listId || null,
        timeOfCompletion: 0,
        updatedAt: Date.now(),
        timestamp: Date.now(),
    }

    const op = {
        type: 'add',
        value: item
    }

    await autobase.append(op)
    console.error('Added item:', text)
}

// Update item operation: AUTONOMOUS, NO BACKEND MEMORY
async function updateItem (item) {
    if (!autobase) {
        console.error('updateItem called before Autobase is initialized')
        return
    }

    console.error('command RPC_UPDATE updateItem item', item)

    const op = {
        type: 'update',
        value: item
    }

    await autobase.append(op)
    console.error('Updated item:', item.text)
}

// Delete item operation: AUTONOMOUS, NO BACKEND MEMORY
async function deleteItem (item) {
    if (!autobase) {
        console.error('deleteItem called before Autobase is initialized')
        return
    }

    console.error('command RPC_DELETE deleteItem item', item)

    const op = {
        type: 'delete',
        value: item
    }

    await autobase.append(op)
    console.error('Deleted item:', item.text)
}
