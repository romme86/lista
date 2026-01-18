// Backend main entry point
// Initializes shared state, sets up RPC handlers, and starts autobase

import RPC from 'bare-rpc'
import URL from 'bare-url'
import b4a from 'b4a'
const { IPC } = BareKit

// RPC commands
import {
    RPC_UPDATE,
    RPC_ADD,
    RPC_DELETE,
    RPC_GET_KEY,
    RPC_JOIN_KEY,
    RPC_REQUEST_SYNC
} from '../rpc-commands.mjs'

// Import modules
import { log } from './lib/utils.mjs'
import {
    autobase, store, swarm, chatSwarm, discovery,
    setRpc, setBaseKey
} from './lib/state.mjs'
import { initStoragePaths, validateStorageIntegrity } from './lib/storage.mjs'
import { loadAutobaseKey, loadLocalWriterKey } from './lib/keys.mjs'
import { notifyUserError } from './lib/errors.mjs'
import { initAutobase, joinNewBase, syncListToFrontend } from './lib/autobase.mjs'
import { addItem, updateItem, deleteItem } from './lib/items.mjs'

log('=== BACKEND STARTED ===')
log('bare backend is rocking.')

// Base directory is passed as first argument from worklet.start()
// worklet.start('/app.bundle', bundleBytes, [baseDir])
const baseDir = Bare.argv[0] || null
log('Base directory from argv[0]:', baseDir)

// Initialize storage paths with base directory
initStoragePaths(baseDir)

// These arguments are not currently used but reserved for future use
const peerKeysString = Bare.argv[1] || '' // Comma-separated peer keys (unused)
const baseKeyHex = Bare.argv[2] || '' // Optional Autobase key (unused)

// Parse initial base key from argv or load from file
let initialBaseKey = null
if (baseKeyHex) {
    try {
        initialBaseKey = Buffer.from(baseKeyHex.trim(), 'hex')
        log('Using existing Autobase key from argv[2]:', baseKeyHex.trim())
    } catch (err) {
        log('Invalid base key hex, creating new base instead:', err.message)
        initialBaseKey = null
    }
}

// If no key from argv, try loading from file
if (!initialBaseKey) {
    initialBaseKey = loadAutobaseKey()
}

setBaseKey(initialBaseKey)

// Create RPC server
const rpc = new RPC(IPC, async (req, error) => {
    log('RPC request from frontend, command:', req.command)
    if (error) {
        log('got an error from react', error)
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
                log('command RPC_GET_KEY')
                if (!autobase) {
                    log('RPC_GET_KEY requested before Autobase is ready')
                    break
                }
                const keyReq = rpc.request(RPC_GET_KEY)
                keyReq.send(autobase.local.key.toString('hex'))
                break
            }
            case RPC_JOIN_KEY: {
                log('command RPC_JOIN_KEY')
                const data = JSON.parse(req.data.toString())
                log('Joining new base key from RPC:', data.key)
                await joinNewBase(data.key)
                break
            }
            case RPC_REQUEST_SYNC: {
                log('command RPC_REQUEST_SYNC - frontend requesting current list')
                syncListToFrontend()
                break
            }
        }
    } catch (err) {
        log('Error handling RPC request:', err)
    }
})

// Store RPC instance in shared state
setRpc(rpc)

// Global unhandled rejection handler for async errors
Bare.on('unhandledRejection', (error) => {
    log('Unhandled promise rejection:', error)
    // For serious errors, notify user to reinstall
    notifyUserError(
        'Application Error',
        'An unexpected error occurred. If this persists, please reinstall the app.'
    )
})

// Global uncaught exception handler for sync errors
Bare.on('uncaughtException', (error) => {
    log('Uncaught exception:', error)
    // For serious errors, notify user to reinstall
    notifyUserError(
        'Application Error',
        'An unexpected error occurred. If this persists, please reinstall the app.'
    )
})

// Initialize Autobase with initial key
await initAutobase(initialBaseKey).then(() => {
    log('Backend ready')
}).catch((err) => {
    log('initAutobase failed at startup:', err)
    notifyUserError(
        'Initialization Failed',
        'Failed to initialize the app. Please reinstall the app to resolve this issue.'
    )
})

// Backend ready
log('Backend ready')

// Cleanup on teardown
Bare.on('teardown', async () => {
    log('Backend shutting down...')
    try {
        if (swarm) await swarm.destroy()
    } catch (e) {
        log('Error destroying replication swarm:', e)
    }
    if (chatSwarm) {
        try {
            await chatSwarm.destroy()
        } catch (e) {
            log('Error destroying chat swarm:', e)
        }
    }
    if (discovery) {
        try {
            await discovery.destroy()
        } catch (e) {
            log('Error destroying discovery:', e)
        }
    }
    try {
        if (store) await store.close()
    } catch (e) {
        log('Error closing store:', e)
    }
    log('Backend shutdown complete')
})
