import Hyperswarm from "hyperswarm";
import {apply, open, storagePath, peerKeysString} from "../backend.mjs";
import {RPC_MESSAGE, RPC_GET_KEY} from "../../rpc-commands.mjs";
import Corestore from "corestore";
import Autobase from "autobase";
import b4a from "b4a";
import { randomBytes } from "hypercore-crypto";
import {
    autobase,
    rpc,
    addedStaticPeers,
    chatSwarm,
    swarm,
    baseKey,
    store,
    discovery,
    knownWriters,
    peerCount,
    setAutobase,
    setAddedStaticPeers,
    setChatSwarm,
    setSwarm,
    setDiscovery,
    setPeerCount,
    DEFAULT_LIST,
    setStore,
    setBaseKey
} from "./state.mjs"
import { generateId } from "./util.mjs"

export function sendHandshakeMessage (conn, msg) {
    const line = JSON.stringify(msg) + '\n'
    conn.write(line)
}

export async function handleHandshakeMessage (msg) {
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

export async function setupHandshakeChannel (conn) {
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

export function setupChatSwarm (chatTopic) {
    if (!autobase) {
        console.error('setupChatSwarm called before Autobase is initialized')
        return
    }
    setChatSwarm(new Hyperswarm())
    console.error('setting up chat swarm with topic:', chatTopic.toString('hex'))
    chatSwarm.on('connection', (conn, info) => {
        console.error('Handshake connection (chat swarm) with peer', info?.peer, info?.publicKey?.toString('hex'), info?.topics, info?.prioritized)
        conn.on('error', (err) => {
            console.error('Chat swarm connection error:', err)
        })
        setupHandshakeChannel(conn)
    })

    chatSwarm.on('error', (err) => {
        console.error('Chat swarm error:', err)
    })

    chatSwarm.join(chatTopic, { server: true, client: true })
    console.error('Handshake chat swarm joined on topic:', chatTopic.toString('hex'))
}


async function tearDownAutobaseSwarmStore() {
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
        setAutobase(null)
    }

    // 2. Tear down networking bound to old store
    if (discovery) {
        try {
            await discovery.destroy()
        } catch (e) {
            console.error(e)
        }
        setDiscovery(null)
    }
    if (chatSwarm) {
        try {
            await chatSwarm.destroy()
        } catch (e) {
            console.error(e)
        }
        setChatSwarm(null)
    }

    // 3. Close old store
    if (store) {
        try {
            await store.close()
        } catch (e) {
            console.error('Error closing Corestore:', e)
        }
    }
}

export async function initAutobase (newBaseKey) {
    await tearDownAutobaseSwarmStore();

    // Use per-base storage path to avoid conflicts when joining different bases
    const keyPrefix = newBaseKey ? newBaseKey.toString('hex').slice(0, 8) : 'local'
    const baseStoragePath = `${storagePath}-${keyPrefix}`

    setStore(new Corestore(baseStoragePath))
    await store.ready()
    setBaseKey(newBaseKey || null)
    console.error(
        'initializing a new autobase with key:',
        baseKey ? baseKey.toString('hex') : '(new base)'
    )
    const autobaseOpts = { apply, open, valueEncoding: 'json' }
    setAutobase(new Autobase(store, baseKey, autobaseOpts))
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
    autobase.on('append', async () => {
        console.error('New data appended, updating view...')
    })
    // Seed DEFAULT_LIST if autobase is empty (apply() will update the UI)
    await ensureDefaultListIfEmpty()
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
        setAddedStaticPeers(true)
    }
    // Reset peer count on new base
    setPeerCount(0)
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
    setSwarm(new Hyperswarm())
    swarm.on('error', (err) => {
        console.error('Replication swarm error:', err)
    })
    swarm.on('connection', (conn) => {
        console.error('New peer connected (replication swarm)', b4a.from(conn.publicKey), conn.publicKey)
        conn.on('error', (err) => {
            console.error('Replication connection error:', err)
        })
        setPeerCount(peerCount+1)
        broadcastPeerCount()
        conn.on('close', () => {
            setPeerCount(Math.max(0, peerCount - 1))
            broadcastPeerCount()
        })
        if (autobase) {
            autobase.replicate(conn)
        } else {
            console.error('No Autobase yet to replicate with')
        }
    })
    setDiscovery(swarm.join(topic, { server: true, client: true }))
    await discovery.flushed()
    console.error('Joined replication swarm for current base')
    // Restart chat swarm with new topic
    if (chatSwarm) {
        try {
            await chatSwarm.destroy()
        } catch (e) {
            console.error('Error destroying previous chat swarm:', e)
        }
        setChatSwarm(null)
    }
    setupChatSwarm(baseKey != null ? baseKey : autobase.key)
}

export async function joinNewBase (baseKeyHexStr) {
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

function broadcastPeerCount () {
    if (!rpc) return
    try {
        const req = rpc.request(RPC_MESSAGE)
        req.send(JSON.stringify({ type: 'peer-count', count: peerCount }))
    } catch (e) {
        console.error('Failed to broadcast peer count', e)
    }
}

async function ensureDefaultListIfEmpty () {
    // Make sure indexing has run at least once
    await autobase.update()

    const viewLen = autobase.view?.length ?? 0
    const localLen = autobase.local?.length ?? 0

    // Empty = nothing in the applied output
    const isEmpty = viewLen === 0

    // Only the host/owner should seed defaults
    if (!isEmpty) return
    if (!autobase.writable) return

    console.error('Autobase view is empty, seeding DEFAULT_LIST...')

    for (const item of DEFAULT_LIST) {
        await autobase.append({
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
        })
    }

    // Apply what we just appended
    await autobase.update()
}