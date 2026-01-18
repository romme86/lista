// Networking - swarm setup, handshake, and replication

import Hyperswarm from 'hyperswarm'
import { log } from './utils.mjs'
import {
    autobase, store, rpc, peerCount, knownWriters, currentList,
    setChatSwarm, setPeerCount, setCurrentList
} from './state.mjs'
import { isStateMismatchError, isTransientReplicationError, retryWithBackoff } from './errors.mjs'
import { syncListToFrontend } from './autobase.mjs'
import {
    RPC_MESSAGE
} from '../../rpc-commands.mjs'

// Send handshake message over connection
export function sendHandshakeMessage(conn, msg) {
    const line = JSON.stringify(msg) + '\n'
    conn.write(line)
}

// Handle incoming handshake message
export async function handleHandshakeMessage(msg) {
    if (!autobase) return
    if (!msg || msg.type !== 'writer-key') return

    const remoteKeyHex = msg.key
    if (!remoteKeyHex || typeof remoteKeyHex !== 'string') return

    log(`=== RECEIVED WRITER KEY from peer: ${remoteKeyHex.slice(0, 16)}... ===`)
    log(`  Our writable status: ${autobase.writable}`)
    log(`  Known writers count: ${knownWriters.size}`)

    if (knownWriters.has(remoteKeyHex)) {
        log(`  Already known writer, skipping`)
        return
    }
    knownWriters.add(remoteKeyHex)
    log(`  Added to known writers set`)

    // Only a writer (host) can add other writers
    if (!autobase.writable) {
        log('  We are NOT writable (guest) - cannot add remote writer, waiting for host to add us')
        return
    }

    log(`  We ARE writable (host) - adding remote writer via autobase append...`)

    try {
        await autobase.append({
            type: 'add-writer',
            key: remoteKeyHex
        })
        log(`  SUCCESS: Added remote writer ${remoteKeyHex.slice(0, 16)}... to autobase`)
    } catch (e) {
        log(`  FAILED to add remote writer: ${e.message}`)
    }
}

// Setup handshake channel on connection
export async function setupHandshakeChannel(conn) {
    if (!autobase) {
        log('setupHandshakeChannel called before Autobase is initialized')
        return
    }

    // Send our writer key immediately
    await autobase.ready()
    const myWriterKeyHex = autobase.local.key.toString('hex')
    log(`=== SENDING OUR WRITER KEY to peer: ${myWriterKeyHex.slice(0, 16)}... ===`)
    log(`  We are writable (host): ${autobase.writable}`)
    sendHandshakeMessage(conn, {
        type: 'writer-key',
        key: myWriterKeyHex
    })
    log(`  Writer key sent via handshake channel`)

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

// Setup chat swarm for handshake/writer key exchange
export function setupChatSwarm(topic) {
    if (!autobase) {
        log('setupChatSwarm called before Autobase is initialized')
        return null
    }
    const chatSwarm = new Hyperswarm()
    log('setting up chat swarm with topic:', topic.toString('hex'))
    chatSwarm.on('connection', (conn, info) => {
        log('Handshake connection (chat swarm) with peer', info?.peer, info?.publicKey?.toString('hex'), info?.topics, info?.prioritized)
        conn.on('error', (err) => {
            log('Chat swarm connection error:', err)
        })
        setupHandshakeChannel(conn)
    })

    chatSwarm.on('error', (err) => {
        log('Chat swarm error:', err)
    })

    chatSwarm.join(topic, { server: true, client: true })
    log('Handshake chat swarm joined on topic:', topic.toString('hex'))

    setChatSwarm(chatSwarm)
    return chatSwarm
}

// Broadcast peer count to frontend
export function broadcastPeerCount() {
    if (!rpc) return
    try {
        const req = rpc.request(RPC_MESSAGE)
        req.send(JSON.stringify({ type: 'peer-count', count: peerCount }))
    } catch (e) {
        log('Failed to broadcast peer count', e)
    }
}

// Handle replication swarm connection
export async function handleReplicationConnection(conn, resetCorruptedStateFn, initAutobaseFn) {
    const peerIdShort = conn.publicKey ? conn.publicKey.toString('hex').slice(0, 12) : 'unknown'
    try {
        log(`=== NEW PEER CONNECTED (replication) peer=${peerIdShort}... ===`)
        log(`  Local autobase key: ${autobase?.key?.toString('hex')?.slice(0, 16)}...`)
        log(`  Local writer key: ${autobase?.local?.key?.toString('hex')?.slice(0, 16)}...`)
        log(`  Local writable: ${autobase?.writable}`)

        conn.on('error', (err) => {
            log(`[PEER ${peerIdShort}] Replication connection error:`, err)
            if (isStateMismatchError(err)) {
                resetCorruptedStateFn(err.message || String(err), initAutobaseFn)
            }
        })
        setPeerCount(peerCount + 1)
        broadcastPeerCount()

        conn.on('close', () => {
            log(`[PEER ${peerIdShort}] Connection closed`)
            setPeerCount(Math.max(0, peerCount - 1))
            broadcastPeerCount()
        })

        // Guard: check if store is valid and not closed before replicating
        if (autobase && store && !store.closed) {
            try {
                // Use store.replicate() which handles ALL cores including ones added later
                const replicationStream = store.replicate(conn)

                replicationStream.on('error', (err) => {
                    log(`[PEER ${peerIdShort}] Replication stream error:`, err)
                    if (isStateMismatchError(err)) {
                        resetCorruptedStateFn(err.message || String(err), initAutobaseFn)
                    }
                })

                log(`[PEER ${peerIdShort}] Corestore replication set up successfully`)

                // CRITICAL: For guests, explicitly download the bootstrap core (host's data)
                // and trigger updates when data arrives
                if (!autobase.writable && autobase.key) {
                    log(`[PEER ${peerIdShort}] We are GUEST - setting up bootstrap core sync...`)

                    // Get the bootstrap core (this is the host's writer core)
                    const bootstrapCore = store.get({ key: autobase.key })
                    await bootstrapCore.ready()
                    log(`[PEER ${peerIdShort}] Bootstrap core ready, length: ${bootstrapCore.length}`)

                    // Download all data from the bootstrap core
                    if (bootstrapCore.length > 0) {
                        log(`[PEER ${peerIdShort}] Downloading ${bootstrapCore.length} blocks from bootstrap...`)
                        await bootstrapCore.download({ start: 0, end: bootstrapCore.length }).done()
                        log(`[PEER ${peerIdShort}] Bootstrap download complete`)
                    }

                    // Listen for new data on the bootstrap core
                    bootstrapCore.on('append', async () => {
                        log(`[PEER ${peerIdShort}] Bootstrap core received new data, length: ${bootstrapCore.length}`)
                        // Download the new data
                        await bootstrapCore.download({ start: 0, end: bootstrapCore.length }).done()
                        // Trigger autobase update to process the new data
                        if (autobase && !autobase.closed) {
                            try {
                                log(`[PEER ${peerIdShort}] Triggering autobase update after bootstrap sync...`)
                                await autobase.update()
                                log(`[PEER ${peerIdShort}] Autobase update complete, view length: ${autobase.view?.length}`)
                                syncListToFrontend()
                            } catch (e) {
                                log(`[PEER ${peerIdShort}] Error updating autobase:`, e.message)
                            }
                        }
                    })

                    // Trigger initial update after connection
                    setTimeout(async () => {
                        if (autobase && !autobase.closed) {
                            try {
                                log(`[PEER ${peerIdShort}] Delayed autobase update for initial sync...`)
                                await autobase.update()
                                log(`[PEER ${peerIdShort}] Initial sync complete, view length: ${autobase.view?.length}, list items: ${currentList.length}`)
                                syncListToFrontend()
                            } catch (e) {
                                log(`[PEER ${peerIdShort}] Error in delayed update:`, e.message)
                            }
                        }
                    }, 1000)
                }
            } catch (replErr) {
                log(`[PEER ${peerIdShort}] Failed to set up replication:`, replErr.message)
            }
        } else {
            log(`[PEER ${peerIdShort}] Skipping replication - store not ready or closed`)
        }
    } catch (e) {
        log(`[PEER ${peerIdShort}] Error in swarm connection handler:`, e)
        if (isStateMismatchError(e)) {
            resetCorruptedStateFn(e.message || String(e), initAutobaseFn)
        }
    }
}

// Create and setup replication swarm
export function createReplicationSwarm(resetCorruptedStateFn, initAutobaseFn) {
    const swarm = new Hyperswarm()
    swarm.on('error', (err) => {
        log('Replication swarm error:', err)
    })

    swarm.on('connection', async (conn) => {
        await handleReplicationConnection(conn, resetCorruptedStateFn, initAutobaseFn)
    })

    return swarm
}
