// Error detection, retry logic, and reset functionality

import { log, sleep } from './utils.mjs'
import {
    autobase, store, swarm, chatSwarm, discovery, rpc, baseKey,
    setAutobase, setStore, setSwarm, setChatSwarm, setDiscovery,
    setBaseKey, setCurrentList, setPeerCount, setAddedStaticPeers,
    isResettingState, setIsResettingState, clearKnownWriters,
    transientErrorCount, setTransientErrorCount,
    lastTransientErrorTime, setLastTransientErrorTime,
    MAX_TRANSIENT_ERRORS
} from './state.mjs'
import {
    deleteStorageWithRetry, deleteStorageSync,
    createVersionMarker, writeResetMarker, VERSION_MARKER_FILE, getBaseDir
} from './storage.mjs'
import {
    RPC_MESSAGE
} from '../../rpc-commands.mjs'

// Send error notification to frontend
export function notifyUserError(title, message) {
    if (!rpc) return
    try {
        const req = rpc.request(RPC_MESSAGE)
        req.send(JSON.stringify({ type: 'error-notification', title, message }))
    } catch (e) {
        log('Failed to send error notification:', e)
    }
}

// Check if error is a transient replication error (retry-able)
export function isTransientReplicationError(error) {
    if (!error) return false
    const errorStr = String(error)
    // "Invalid checkout X for batch, length is Y" - replication not complete yet
    return errorStr.includes('Invalid checkout') && errorStr.includes('length is')
}

// Check if error is a Hypercore state corruption error (requires reset)
export function isStateMismatchError(error) {
    if (!error) return false
    const errorStr = String(error)
    const errorCode = error.code || ''

    // Don't treat transient replication errors as corruption
    if (isTransientReplicationError(error)) {
        return false
    }

    return (
        errorStr.includes('CORRUPTION') ||
        errorStr.includes('state mismatch') ||
        (errorCode === 'ERR_ASSERTION' && !errorStr.includes('Invalid checkout'))
    )
}

// Reset corrupted state and reinitialize
// initAutobaseFn is passed to avoid circular dependency
export async function resetCorruptedState(errorMessage, initAutobaseFn) {
    if (isResettingState) {
        log('Already resetting state, skipping...')
        return
    }
    setIsResettingState(true)

    log('=== RESETTING CORRUPTED STATE ===')
    log('Error that triggered reset:', errorMessage)

    // Notify user
    notifyUserError(
        'Data Reset Required',
        `The app encountered a data inconsistency and needs to reset. Your local data will be cleared. Error: ${errorMessage}`
    )

    try {
        // 1. Close all swarms first (stop network activity)
        log('Step 1: Closing network connections...')
        if (swarm) {
            try {
                await swarm.destroy()
                log('Replication swarm destroyed')
            } catch (e) { log('Error destroying swarm:', e) }
            setSwarm(null)
        }
        if (chatSwarm) {
            try {
                await chatSwarm.destroy()
                log('Chat swarm destroyed')
            } catch (e) { log('Error destroying chat swarm:', e) }
            setChatSwarm(null)
        }
        if (discovery) {
            try {
                await discovery.destroy()
                log('Discovery destroyed')
            } catch (e) { log('Error destroying discovery:', e) }
            setDiscovery(null)
        }

        // Small delay to let network close properly
        await sleep(100)

        // 2. Remove all listeners and close autobase
        log('Step 2: Closing autobase...')
        if (autobase) {
            try {
                // Remove listeners first
                autobase.removeAllListeners('append')
                if (autobase.view) {
                    try {
                        autobase.view.removeAllListeners('append')
                    } catch (e) { /* ignore */ }
                }

                // Close autobase (this should close its internal cores)
                if (typeof autobase.close === 'function') {
                    await autobase.close()
                    log('Autobase closed')
                }
            } catch (e) { log('Error closing autobase:', e) }
            setAutobase(null)
        }

        // 3. Close corestore (this releases the RocksDB lock)
        log('Step 3: Closing corestore...')
        if (store) {
            try {
                await store.close()
                log('Corestore closed')
            } catch (e) { log('Error closing store:', e) }
            setStore(null)
        }

        // 4. Delete stored keys and data with retry logic
        log('Step 4: Deleting storage with retry...')
        const deleted = await deleteStorageWithRetry(5, 300)

        if (!deleted) {
            // If deletion failed, mark for reset on next restart
            log('Storage deletion failed - marking for reset on next restart')
            writeResetMarker(errorMessage)

            notifyUserError(
                'Reset Incomplete',
                'Could not fully reset app data. Please close and restart the app to complete the reset.'
            )

            setIsResettingState(false)
            return
        }

        // 5. Reset in-memory state
        log('Step 5: Resetting in-memory state...')
        setBaseKey(null)
        setCurrentList([])
        setPeerCount(0)
        clearKnownWriters()
        setAddedStaticPeers(false)

        // 6. Reinitialize with fresh state
        log('Step 6: Reinitializing with fresh state...')
        if (initAutobaseFn) {
            await initAutobaseFn(null)
        }

        log('=== STATE RESET COMPLETE ===')

        notifyUserError(
            'Reset Complete',
            'App data has been reset successfully. You can continue using the app.'
        )
    } catch (e) {
        log('Error during state reset:', e)
        notifyUserError('Reset Failed', `Failed to reset app state: ${e.message}. Please restart the app.`)
    } finally {
        setIsResettingState(false)
    }
}

// Soft reinitialize autobase - try reinit first, if that fails do full cleanup
// initAutobaseFn is passed to avoid circular dependency
export async function softReinitAutobase(initAutobaseFn) {
    log('=== SOFT REINITIALIZE AUTOBASE ===')

    // Save current baseKey before closing
    const currentBaseKey = autobase?.key ? Buffer.from(autobase.key) : baseKey

    if (!currentBaseKey) {
        log('No baseKey available for soft reinit, skipping')
        return false
    }

    try {
        // First try: just reinitialize with the same baseKey
        if (initAutobaseFn) {
            await initAutobaseFn(currentBaseKey)
        }
        log('Soft reinitialize completed successfully')
        return true
    } catch (e) {
        log('Soft reinitialize failed:', e)

        // If reinit failed, the storage is likely corrupted
        // Do a full cleanup and start fresh
        if (isTransientReplicationError(e) || String(e).includes('Invalid checkout')) {
            log('Detected checkpoint corruption, doing full storage cleanup...')

            // Close everything
            if (autobase) {
                try { autobase.removeAllListeners('append') } catch (_e) {}
                try { if (autobase.close) await autobase.close() } catch (_e) {}
                setAutobase(null)
            }
            if (store) {
                try { await store.close() } catch (_e) {}
                setStore(null)
            }

            // Delete corrupted storage
            await sleep(200)
            deleteStorageSync()

            // Recreate version marker
            createVersionMarker()

            // Reinitialize fresh (will create new autobase without the old baseKey)
            try {
                if (initAutobaseFn) {
                    await initAutobaseFn(null)
                }
                log('Full cleanup and reinit completed')

                // Notify user
                notifyUserError(
                    'Data Reset',
                    'The app had to reset due to data corruption. Your data will sync from connected peers.'
                )
                return true
            } catch (e2) {
                log('Full cleanup reinit also failed:', e2)
                return false
            }
        }

        return false
    }
}

// Retry an async operation with exponential backoff
// If view is broken (checkout error persists), tries soft reinit
export async function retryWithBackoff(operation, operationName, maxRetries = 3, initialDelayMs = 100, initAutobaseFn = null) {
    let lastError = null
    let softReinitAttempted = false

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation()
        } catch (e) {
            lastError = e

            if (isTransientReplicationError(e)) {
                const delayMs = initialDelayMs * Math.pow(2, attempt - 1)
                log(`${operationName}: view error on attempt ${attempt}/${maxRetries}, waiting ${delayMs}ms...`)
                log(`  Error: ${e.message || e}`)
                await sleep(delayMs)

                // After 2 failed attempts, try soft reinit to recreate the view
                if (attempt >= 2 && !softReinitAttempted && initAutobaseFn) {
                    log(`${operationName}: attempting soft reinitialize to fix broken view...`)
                    softReinitAttempted = true
                    const reinitSuccess = await softReinitAutobase(initAutobaseFn)
                    if (reinitSuccess) {
                        log(`${operationName}: soft reinit succeeded, retrying operation...`)
                        // Give it a moment to stabilize
                        await sleep(500)
                    }
                }
            } else {
                // Non-transient error, don't retry
                throw e
            }
        }
    }

    // All retries failed - if we haven't tried soft reinit yet, try it as last resort
    if (!softReinitAttempted && initAutobaseFn) {
        log(`${operationName}: final attempt - trying soft reinitialize...`)
        const reinitSuccess = await softReinitAutobase(initAutobaseFn)
        if (reinitSuccess) {
            await sleep(500)
            try {
                return await operation()
            } catch (e) {
                log(`${operationName}: operation still failed after soft reinit:`, e.message)
                lastError = e
            }
        }
    }

    log(`${operationName}: FAILED after ${maxRetries} retries and soft reinit`)
    throw lastError
}

// Handle transient errors for global error handlers
// Returns true if error was handled, false if it needs further action
export async function handleTransientError(error, initAutobaseFn, resetCorruptedStateFn) {
    const now = Date.now()
    if (now - lastTransientErrorTime > 30000) {
        setTransientErrorCount(0)
    }
    setTransientErrorCount(transientErrorCount + 1)
    setLastTransientErrorTime(now)

    log(`View/replication error (count: ${transientErrorCount}/${MAX_TRANSIENT_ERRORS})`)

    // After 5 errors, try soft reinit; after 10, do full reset
    if (transientErrorCount === 5) {
        log('Multiple view errors, attempting soft reinitialize...')
        await softReinitAutobase(initAutobaseFn)
    } else if (transientErrorCount >= MAX_TRANSIENT_ERRORS) {
        log('Too many errors even after soft reinit, initiating full reset...')
        setTransientErrorCount(0)
        await resetCorruptedStateFn(error.message || String(error), initAutobaseFn)
    }
    return true
}
