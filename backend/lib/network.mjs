import Hyperswarm from "hyperswarm";
import fs from "bare-fs";
import {apply, open, storagePath, peerKeysString, keyFilePath} from "../backend.mjs";
import {saveAutobaseKey} from "./key.mjs";
import {RPC_MESSAGE, RPC_GET_KEY, RPC_RESET, SYNC_LIST} from "../../rpc-commands.mjs";
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
    currentList,
    setAutobase,
    setAddedStaticPeers,
    setChatSwarm,
    setSwarm,
    setDiscovery,
    setPeerCount,
    setStore,
    setBaseKey
} from "./state.mjs"
import {rebuildListFromPersistedOps, syncListToFrontend} from "./item.mjs"

let _initPromise = null

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
        console.error('[WARNING] Not writable here, cannot add remote writer yet')
        return
    }

    console.error('[INFO] Adding remote writer via autobase:', remoteKeyHex)

    await autobase.append({
        type: 'add-writer',
        key: remoteKeyHex
    })
}

export async function setupHandshakeChannel (conn) {
    if (!autobase) {
        console.error('[WARNING] setupHandshakeChannel called before Autobase is initialized')
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
                console.error('[WARNING] Invalid JSON from peer (handshake, ignored):', line)
                continue
            }

            handleHandshakeMessage(msg)
        }
    })
}

export function setupChatSwarm (chatTopic) {
    if (!autobase) {
        console.error('[WARNING] setupChatSwarm called before Autobase is initialized')
        return
    }
    setChatSwarm(new Hyperswarm())
    console.error('[INFO] Setting up chat swarm with topic:', chatTopic.toString('hex'))
    chatSwarm.on('connection', (conn, info) => {
        console.error('[INFO] Handshake connection (chat swarm) with peer', info?.publicKey?.toString('hex'),'prioritized', info?.prioritized)
        conn.on('error', (err) => {
            console.error('[ERROR] Chat swarm connection error:', err)
        })
        setupHandshakeChannel(conn)
    })

    chatSwarm.on('error', (err) => {
        console.error('[ERROR] Chat swarm error:', err)
    })

    chatSwarm.join(chatTopic, { server: true, client: true })
    console.error('[INFO] Handshake chat swarm joined on topic:', chatTopic.toString('hex'))
}


async function tearDownAutobaseSwarmStore() {
    // 1. Clean up previous Autobase instance (if any)
    if (autobase) {
        try {
            autobase.removeAllListeners('append')
            if (typeof autobase.close === 'function') {
                console.error('[INFO] Closing previous Autobase instance...')
                await autobase.close()
            } else {
                console.error('[WARNING] Previous Autobase has no close() method, skipping close')
            }
        } catch (e) {
            console.error('[ERROR] Error while closing previous Autobase:', e)
        }
        setAutobase(null)
    }

    // 2. Tear down networking bound to old store
    if (discovery) {
        try {
            await discovery.destroy()
        } catch (e) {
            console.error('[ERROR] Error destroying discovery:', e)
        }
        setDiscovery(null)
    }
    if (chatSwarm) {
        try {
            await chatSwarm.destroy()
        } catch (e) {
            console.error('[ERROR] Error destroying chat swarm:', e)
        }
        setChatSwarm(null)
    }

    // 3. Close old store
    if (store) {
        try {
            await store.close()
        } catch (e) {
            console.error('[ERROR] Error closing Corestore:', e)
        }
    }
}

export async function initAutobase (newBaseKey) {
    if (_initPromise) {
        console.error('[WARNING] initAutobase already running — returning existing init promise')
        return _initPromise
    }

    _initPromise = (async () => {


        await tearDownAutobaseSwarmStore();

        // Use per-base storage path to avoid conflicts when joining different bases
        const keyPrefix = newBaseKey ? newBaseKey.toString('hex').slice(0, 8) : 'local'
        const baseStoragePath = `${storagePath}-${keyPrefix}`

        setStore(new Corestore(baseStoragePath))
        await store.ready()
        setBaseKey(newBaseKey || null)
        console.error(
            '[INFO] Initializing a new autobase with key:',
            baseKey ? baseKey.toString('hex') : '(new base)'
        )
        const autobaseOpts = { apply, open, valueEncoding: 'json' }
        setAutobase(new Autobase(store, baseKey, autobaseOpts))
        console.error('[INFO] Calling autobase.ready()...')
        try{
            await autobase.ready()
        } catch(e){
            const msg = String(e?.stack || e?.message || e)
            if (msg.includes("reading 'signers'") || msg.includes('autobase/lib/store.js')) {
                console.error('[ERROR] Autobase appears corrupted. Wiping local state and recreating a new base...')
                rmrfSafe(keyFilePath)
                rmrfSafe(baseStoragePath)
                // Clear the promise so recursive call can start fresh
                _initPromise = null
                return initAutobase(null)
            }
            throw e;
        }
        console.error(
            '[INFO] autobase.ready() resolved. Autobase ready, writable?',
            autobase.writable,
            ' key:',
            autobase.key?.toString('hex'),
        )

        // Save the autobase key for persistence across restarts
        // Only save if we're the creator (writable) - guests should rejoin manually
        if (autobase.key && autobase.writable) {
            saveAutobaseKey(autobase.key, keyFilePath)
        }

        if (autobase) {
            const req = rpc.request(RPC_GET_KEY)
            req.send(autobase.key?.toString('hex'))
        }
        autobase.on('append', async () => {
            console.error('[INFO] New data appended, updating view...')
        })
        // Load existing items from view and sync to frontend
        await autobase.update()
        const rebuiltList = await rebuildListFromPersistedOps()
        syncListToFrontend(rebuiltList)
        // Add static peers only once
        if (!addedStaticPeers && peerKeysString) {
            const peerKeys = peerKeysString.split(',').filter(k => k.trim())
            for (const keyHex of peerKeys) {
                try {
                    const peerKey = Buffer.from(keyHex.trim(), 'hex')
                    const peerCore = store.get({ key: peerKey })
                    await peerCore.ready()
                    await autobase.addInput(peerCore)
                    console.error('[INFO] Added peer writer from argv[1]:', keyHex.trim())
                } catch (err) {
                    console.error('[ERROR] Failed to add peer from argv[1]:', keyHex, err.message)
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
        console.error('[INFO] Discovery topic (replication swarm):', topic.toString('hex'))
        // Switch discovery to new topic
        if (discovery) {
            try {
                await discovery.destroy()
            } catch (e) {
                console.error('[ERROR] Error destroying previous discovery:', e)
            }
        }
        setSwarm(new Hyperswarm())
        swarm.on('error', (err) => {
            console.error('[ERROR] Replication swarm error:', err)
        })
        swarm.on('connection', (conn) => {
            console.error('[INFO] New peer connected (replication swarm)', b4a.from(conn.publicKey).toString('hex'))
            conn.on('error', (err) => {
                console.error('[ERROR] Replication connection error:', err)
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
                console.error('[WARNING] No Autobase yet to replicate with')
            }
        })
        setDiscovery(swarm.join(topic, { server: true, client: true }))
        await discovery.flushed()
        console.error('[INFO] Joined replication swarm for current base')
        // Restart chat swarm with new topic
        if (chatSwarm) {
            try {
                await chatSwarm.destroy()
            } catch (e) {
                console.error('[ERROR] Error destroying previous chat swarm:', e)
            }
            setChatSwarm(null)
        }
        setupChatSwarm(baseKey != null ? baseKey : autobase.key)
    })()

    try {
        return await _initPromise
    } finally {
        _initPromise = null
    }
}

let _joinPromise = null

export async function joinNewBase (baseKeyHexStr) {

    if (_joinPromise) {
        console.error('[WARNING] joinNewBase already running — returning existing join promise')
        return _joinPromise
    }

    _joinPromise = (async () => {

        if (!baseKeyHexStr || typeof baseKeyHexStr !== 'string') {
            console.error('[ERROR] joinNewBase: invalid baseKey', baseKeyHexStr)
            return
        }

        // Save current list to restore on failure
        const previousList = [...currentList]

        try {
            const newKey = Buffer.from(baseKeyHexStr.trim(), 'hex')
            if (newKey.length !== 32) {
                console.error('[ERROR] joinNewBase: baseKey must be 32 bytes, got', newKey.length)
                return
            }
            console.error('[INFO] Joining new Autobase key at runtime:', baseKeyHexStr.trim())
            // Clear frontend list before joining new base
            if (rpc) {
                const resetReq = rpc.request(RPC_RESET)
                resetReq.send('')
            }
            await initAutobase(newKey)
            console.error('[INFO] Autobase ready 320')
        } catch (e) {
            console.error('[ERROR] joinNewBase failed:', e)
            // Restore previous list on failure
            if (rpc && previousList.length > 0) {
                const syncReq = rpc.request(SYNC_LIST)
                syncReq.send(JSON.stringify(previousList))
            }
        }
    })()

    try {
        return await _joinPromise
    } finally {
        _joinPromise = null
    }

}

function broadcastPeerCount () {
    if (!rpc) return
    try {
        const req = rpc.request(RPC_MESSAGE)
        req.send(JSON.stringify({ type: 'peer-count', count: peerCount }))
    } catch (e) {
        console.error('[ERROR] Failed to broadcast peer count', e)
    }
}

function rmrfSafe (p) {
    try {
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
    } catch (e) {
        console.error('[ERROR] rmrfSafe failed for', p, e)
    }
}
