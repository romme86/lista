// Item operations - addItem, updateItem, deleteItem, validateItem

import { log, generateId } from './utils.mjs'
import { autobase, store, rpc } from './state.mjs'
import {
    RPC_MESSAGE
} from '../../rpc-commands.mjs'

// Simple inline schema validation matching the mobile ListEntry
export function validateItem(item) {
    if (typeof item !== 'object' || item === null) return false
    if (typeof item.text !== 'string') return false
    if (typeof item.isDone !== 'boolean') return false
    if (typeof item.timeOfCompletion !== 'number') return false
    return true
}

// Check if autobase is in a valid state for operations
export function isAutobaseReady() {
    if (!autobase) {
        log('isAutobaseReady: autobase is null')
        return false
    }
    if (!autobase.local) {
        log('isAutobaseReady: autobase.local is null')
        return false
    }
    if (autobase.closing || autobase.closed) {
        log('isAutobaseReady: autobase is closing/closed')
        return false
    }
    return true
}

// Persist and verify that an operation was written to disk
export async function persistAndVerify(expectedLength, operationType) {
    if (!autobase || !autobase.local || !store) {
        log(`persistAndVerify (${operationType}): autobase, local core, or store not available`)
        return false
    }

    try {
        // Force write to disk via Corestore - this flushes all cores to storage
        if (typeof store.flush === 'function') {
            await store.flush()
        }

        const actualLength = autobase.local.length
        const keyHex = autobase.local.key.toString('hex').slice(0, 16)

        if (actualLength >= expectedLength) {
            log(`persistAndVerify (${operationType}): SUCCESS - flushed to disk, core ${keyHex}... length=${actualLength}`)
            return true
        } else {
            log(`persistAndVerify (${operationType}): LENGTH MISMATCH - core ${keyHex}... length=${actualLength}, expected >= ${expectedLength}`)
            return false
        }
    } catch (e) {
        log(`persistAndVerify (${operationType}): FLUSH FAILED -`, e.message)
        return false
    }
}

// Add item operation (backend creates the canonical item)
export async function addItem(text, listId = null) {
    if (!isAutobaseReady()) {
        log('addItem called but autobase is not ready')
        return false
    }

    if (!autobase.writable) {
        log('addItem called but autobase is not writable yet - waiting to be added as writer')
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({ type: 'not-writable', message: 'Waiting to be added as a writer by the host...' }))
        } catch (e) {
            log('Failed to send not-writable message:', e)
        }
        return false
    }

    log('command RPC_ADD addItem text', text)

    const item = {
        id: generateId(),
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

    try {
        await autobase.ready()

        if (!isAutobaseReady() || !autobase.writable) {
            log('addItem: autobase state changed during ready(), aborting')
            return false
        }

        const lengthBefore = autobase.local.length
        await autobase.append(op)

        const persisted = await persistAndVerify(lengthBefore + 1, 'ADD')
        if (!persisted) {
            log('WARNING: Add operation may not have been persisted to disk!')
        }

        log('Added item:', text, '- persisted:', persisted)
        return persisted
    } catch (e) {
        log('addItem failed:', e)
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({
                type: 'operation-failed',
                message: `Failed to add item: ${e.message}. Please try again.`
            }))
        } catch (err) {
            log('Failed to send operation-failed message:', err)
        }
        return false
    }
}

// Update item operation
export async function updateItem(item) {
    if (!isAutobaseReady()) {
        log('updateItem called but autobase is not ready')
        return false
    }

    if (!autobase.writable) {
        log('updateItem called but autobase is not writable yet')
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({ type: 'not-writable', message: 'Waiting to be added as a writer by the host...' }))
        } catch (e) {
            log('Failed to send not-writable message:', e)
        }
        return false
    }

    log('command RPC_UPDATE updateItem item', item)

    const op = {
        type: 'update',
        value: item
    }

    try {
        await autobase.ready()

        if (!isAutobaseReady() || !autobase.writable) {
            log('updateItem: autobase state changed during ready(), aborting')
            return false
        }

        const lengthBefore = autobase.local.length
        await autobase.append(op)

        const persisted = await persistAndVerify(lengthBefore + 1, 'UPDATE')
        if (!persisted) {
            log('WARNING: Update operation may not have been persisted to disk!')
        }

        log('Updated item:', item.text, '- persisted:', persisted)
        return persisted
    } catch (e) {
        log('updateItem failed:', e)
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({
                type: 'operation-failed',
                message: `Failed to update item: ${e.message}. Please try again.`
            }))
        } catch (err) {
            log('Failed to send operation-failed message:', err)
        }
        return false
    }
}

// Delete item operation
export async function deleteItem(item) {
    if (!isAutobaseReady()) {
        log('deleteItem called but autobase is not ready')
        return false
    }

    if (!autobase.writable) {
        log('deleteItem called but autobase is not writable yet')
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({ type: 'not-writable', message: 'Waiting to be added as a writer by the host...' }))
        } catch (e) {
            log('Failed to send not-writable message:', e)
        }
        return false
    }

    log('command RPC_DELETE deleteItem item', item)

    const op = {
        type: 'delete',
        value: item
    }

    try {
        await autobase.ready()

        if (!isAutobaseReady() || !autobase.writable) {
            log('deleteItem: autobase state changed during ready(), aborting')
            return false
        }

        const lengthBefore = autobase.local.length
        await autobase.append(op)

        const persisted = await persistAndVerify(lengthBefore + 1, 'DELETE')
        if (!persisted) {
            log('WARNING: Delete operation may not have been persisted to disk!')
        }

        log('Deleted item:', item.text, '- persisted:', persisted)
        return persisted
    } catch (e) {
        log('deleteItem failed:', e)
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({
                type: 'operation-failed',
                message: `Failed to delete item: ${e.message}. Please try again.`
            }))
        } catch (err) {
            log('Failed to send operation-failed message:', err)
        }
        return false
    }
}
