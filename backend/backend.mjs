import RPC from 'bare-rpc'
import URL from 'bare-url'
import { join } from 'bare-path'
import {
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
import {syncListToFrontend, validateItem, addItem, updateItem, deleteItem} from './lib/item.mjs'
const { IPC } = BareKit
import {loadAutobaseKey, saveAutobaseKey} from "./lib/key.mjs";
import {initAutobase, joinNewBase} from "./lib/network.mjs";
import {
    autobase,
    store,
    swarm,
    chatSwarm,
    discovery,
    rpc,
    currentList,
    baseKey,
    setRpc,
    setCurrentList, setBaseKey
} from "./lib/state.mjs";
import fs from "bare-fs";

const INSTANCE_ID = Math.random().toString(36).slice(2, 8)
console.error('[INFO] BACKEND INSTANCE:', INSTANCE_ID)

const argv0 = typeof Bare?.argv?.[0] === 'string' ? Bare.argv[0] : '';
let baseDir = '';
if (argv0) {
      try {
                baseDir = argv0.startsWith('file://') ? URL.fileURLToPath(argv0) : argv0;
          } catch {
            baseDir = '';
          }
    }
export const storagePath = baseDir ? join(baseDir, 'lista') : './data';
export const peerKeysString = Bare.argv[1] || '' // Comma-separated peer keys
const baseKeyHex = Bare.argv[2] || '' // Optional Autobase key (to join an existing base)
export const keyFilePath = baseDir ? join(baseDir, 'lista-autobase-key.txt') : './autobase-key.txt';
const localWriterKeyFilePath = baseDir ? join(baseDir, 'lista-local-writer-key.txt') : './local-writer-key.txt';

const LOCK_PATH = baseDir ? join(baseDir, 'lista.lock') : './lista.lock'

// Stagger lock acquisition with random delay to detect duplicate instances
const lockDelay = Math.floor(Math.random() * 500) + 100 // 100-600ms
console.error(`[INFO] [${INSTANCE_ID}] Waiting ${lockDelay}ms before acquiring lock...`)
await new Promise(resolve => setTimeout(resolve, lockDelay))

let lockFd = null
try {
    // 'wx' => create exclusively, fail if exists
    lockFd = fs.openSync(LOCK_PATH, 'wx')
    fs.writeSync(lockFd, INSTANCE_ID + '\n')
    console.error(`[INFO] [${INSTANCE_ID}] Acquired lock:`, LOCK_PATH)
} catch (e) {
    // Check who owns the lock
    try {
        const owner = fs.readFileSync(LOCK_PATH, 'utf-8').trim()
        console.error(`[WARNING] [${INSTANCE_ID}] Lock owned by instance: ${owner}`)
    } catch {}
    console.error(`[ERROR] [${INSTANCE_ID}] Another backend instance is already running (lock exists):`, LOCK_PATH)
    // Hard-exit this backend instance so it can't touch storage
    throw e
}

// Optional Autobase key from argv (initial base) or loaded from file
if (baseKeyHex) {
    try {
        setBaseKey(Buffer.from(baseKeyHex.trim(), 'hex'))
        console.error('[INFO] Using existing Autobase key from argv[2]:', baseKeyHex.trim())
    } catch (err) {
        console.error('[ERROR] Invalid base key hex, creating new base instead:', err.message)
        setBaseKey(null)
    }
}

// If no key from argv, try loading from file (for restart persistence)
if (!baseKey) {
    setBaseKey(loadAutobaseKey(keyFilePath))
}

// Create RPC server
let rpcGenerated = new RPC(IPC, async (req, error) => {
    console.error('[INFO] Got a request from react', req)
    if (error) {
        console.error('[ERROR] Got an error from react', error)
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
                console.error('[INFO] Command RPC_GET_KEY')
                if (!autobase) {
                    console.error('[WARNING] RPC_GET_KEY requested before Autobase is ready')
                    break
                }
                const keyReq = rpc.request(RPC_GET_KEY)
                keyReq.send(autobase.local.key.toString('hex'))
                break
            }
            case RPC_JOIN_KEY: {
                console.error('[INFO] Command RPC_JOIN_KEY')
                const data = JSON.parse(req.data.toString())
                console.error('[INFO] Joining new base key from RPC:', data.key)
                await joinNewBase(data.key)
                break
            }
            case RPC_REQUEST_SYNC: {
                console.error('[INFO] Command RPC_REQUEST_SYNC - frontend requesting current list')
                syncListToFrontend()
                break
            }
        }
    } catch (err) {
        console.error('[ERROR] Error handling RPC request:', err)
    }
})
setRpc(rpcGenerated)

// Initialize Autobase for the initial baseKey (from argv or new)
await initAutobase(baseKey).then(() => {
    console.error('[INFO] Autobase ready 123')
}).catch((err) => {
    console.error('[ERROR] initAutobase failed at startup:', err)
    throw err
})

// Backend ready


// Cleanup on teardown
Bare.on('teardown', async () => {
    console.error('[INFO] Backend shutting down...')
    if (swarm) {
        swarm.removeAllListeners('connection')
        try {
            await swarm.destroy()
        } catch (e) {
            console.error('[ERROR] Error destroying replication swarm:', e)
        }
    }
    if (autobase) {
        try {
            await autobase.close()
        } catch (e) {
            console.error('[ERROR] Error closing autobase:', e)
        }
    }
    if (chatSwarm) {
        try {
            await chatSwarm.destroy()
        } catch (e) {
            console.error('[ERROR] Error destroying chat swarm:', e)
        }
    }
    if (discovery) {
        try {
            await discovery.destroy()
        } catch (e) {
            console.error('[ERROR] Error destroying discovery:', e)
        }
    }
    if(store){
        try {
            await store.flush()
            await store.close()
        } catch (e) {
            console.error('[ERROR] Error closing store:', e)
        }
    }
    try {
        if (lockFd) fs.closeSync(lockFd)
        fs.rmSync(LOCK_PATH, { force: true })
    } catch (e) {
        console.error('[ERROR] Error releasing lock:', e)
    }
    console.error('[INFO] Backend shutdown complete')
})

export function open (store) {
    const view = store.get({
        name: 'test',
        valueEncoding: 'json'
    })
    console.error('[INFO] Opening store...', view)
    return view
}

export async function apply (nodes, view, host) {
    console.error('[INFO] Apply started')
    for (const { value } of nodes) {
        if (!value) continue

        // Handle writer membership updates coming from handshake
        if (value.type === 'add-writer' && typeof value.key === 'string') {
            try {
                const writerKey = Buffer.from(value.key, 'hex')
                await host.addWriter(writerKey, { indexer: false })
                console.error('[INFO] Added writer from add-writer op:', value.key)

                // If we just became writable (our key was added), save the base key
                if (autobase && autobase.local) {
                    const ourKeyHex = autobase.local.key.toString('hex')
                    if (value.key === ourKeyHex && autobase.writable) {
                        saveAutobaseKey(autobase.key, keyFilePath)
                        console.error('[INFO] We became writable! Saved autobase key for persistence.')
                    }
                }
            } catch (err) {
                console.error('[ERROR] Failed to add writer from add-writer op:', err)
            }
            continue
        }

        if (value.type === 'add') {
            if (!validateItem(value.value)) {
                console.error('[WARNING] Invalid item schema in add operation:', value.value)
                continue
            }
            console.error('[INFO] Applying add operation for item:', value.value)
            // Persist item to view
            await view.append(value.value)
            // Update in-memory list
            setCurrentList([value.value, ...currentList.filter(i => i.text !== value.value.text)])
            const addReq = rpc.request(RPC_ADD_FROM_BACKEND)
            addReq.send(JSON.stringify(value.value))
            continue
        }

        if (value.type === 'delete') {
            if (!validateItem(value.value)) {
                console.error('[WARNING] Invalid item schema in delete operation:', value.value)
                continue
            }
            console.error('[INFO] Applying delete operation for item:', value.value)
            // Update in-memory list
            setCurrentList(currentList.filter(i => i.text !== value.value.text))
            const deleteReq = rpc.request(RPC_DELETE_FROM_BACKEND)
            deleteReq.send(JSON.stringify(value.value))
            continue
        }

        if (value.type === 'update') {
            if (!validateItem(value.value)) {
                console.error('[WARNING] Invalid item schema in update operation:', value.value)
                continue
            }
            console.error('[INFO] Applying update operation for item:', value.value)
            // Update in-memory list
            setCurrentList(currentList.map(i =>
                i.text === value.value.text ? value.value : i
            ))
            const updateReq = rpc.request(RPC_UPDATE_FROM_BACKEND)
            updateReq.send(JSON.stringify(value.value))
            continue
        }

        if (value.type === 'list') {
            if (!Array.isArray(value.value)) {
                console.error('[WARNING] Invalid list operation payload, expected array:', value.value)
                continue
            }
            console.error('[INFO] Applying list operation for items:', value.value)
            const updateReq = rpc.request(SYNC_LIST)
            updateReq.send(JSON.stringify(value.value))
            continue
        }

        // All other values are appended to the view (for future use)
        await view.append(value)
    }
}
