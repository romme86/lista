
// Add item operation (backend creates the canonical item)
import {RPC_MESSAGE} from "../../rpc-commands.mjs";
import {generateId} from "./util.mjs";
import { autobase, store, rpc } from '../backend.mjs'
import {SYNC_LIST} from "../../app.android.js";

export async function addItem (text, listId) {
    if (!autobase) {
        console.error('addItem called before Autobase is initialized')
        return false
    }

    if (!autobase.writable) {
        console.error('addItem called but autobase is not writable yet - waiting to be added as writer')
        // Notify frontend about not being writable
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({ type: 'not-writable', message: 'Waiting to be added as a writer by the host...' }))
        } catch (e) {
            console.error('Failed to send not-writable message:', e)
        }
        return false
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

    // Get length before append to verify it increases
    const lengthBefore = autobase.local.length

    await autobase.append(op)

    // Flush to disk and verify persistence
    const persisted = await persistAndVerify(lengthBefore + 1, 'ADD')
    if (!persisted) {
        console.error('WARNING: Add operation may not have been persisted to disk!')
    }

    console.error('Added item:', text, '- persisted:', persisted)
    return persisted
}

// Update item operation: AUTONOMOUS, NO BACKEND MEMORY
export async function updateItem (item) {
    if (!autobase) {
        console.error('updateItem called before Autobase is initialized')
        return false
    }

    if (!autobase.writable) {
        console.error('updateItem called but autobase is not writable yet')
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({ type: 'not-writable', message: 'Waiting to be added as a writer by the host...' }))
        } catch (e) {
            console.error('Failed to send not-writable message:', e)
        }
        return false
    }

    console.error('command RPC_UPDATE updateItem item', item)

    const op = {
        type: 'update',
        value: item
    }

    // Get length before append to verify it increases
    const lengthBefore = autobase.local.length

    await autobase.append(op)

    // Flush to disk and verify persistence
    const persisted = await persistAndVerify(lengthBefore + 1, 'UPDATE')
    if (!persisted) {
        console.error('WARNING: Update operation may not have been persisted to disk!')
    }

    console.error('Updated item:', item.text, '- persisted:', persisted)
    return persisted
}

// Delete item operation: AUTONOMOUS, NO BACKEND MEMORY
export async function deleteItem (item) {
    if (!autobase) {
        console.error('deleteItem called before Autobase is initialized')
        return false
    }

    if (!autobase.writable) {
        console.error('deleteItem called but autobase is not writable yet')
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({ type: 'not-writable', message: 'Waiting to be added as a writer by the host...' }))
        } catch (e) {
            console.error('Failed to send not-writable message:', e)
        }
        return false
    }

    console.error('command RPC_DELETE deleteItem item', item)

    const op = {
        type: 'delete',
        value: item
    }

    // Get length before append to verify it increases
    const lengthBefore = autobase.local.length

    await autobase.append(op)

    // Flush to disk and verify persistence
    const persisted = await persistAndVerify(lengthBefore + 1, 'DELETE')
    if (!persisted) {
        console.error('WARNING: Delete operation may not have been persisted to disk!')
    }

    console.error('Deleted item:', item.text, '- persisted:', persisted)
    return persisted
}

// Simple inline schema validation matching the mobile ListEntry
export function validateItem (item) {
    if (typeof item !== 'object' || item === null) return false
    if (typeof item.text !== 'string') return false
    if (typeof item.isDone !== 'boolean') return false
    if (typeof item.timeOfCompletion !== 'number') return false
    return true
}

// Send current list to frontend
export function syncListToFrontend (currentList) {
    if (!rpc) return
    try {
        const req = rpc.request(SYNC_LIST)
        req.send(JSON.stringify(currentList))
        console.error('Synced list to frontend:', currentList.length, 'items')
    } catch (e) {
        console.error('Failed to sync list to frontend:', e)
    }
}

// Persist and verify that an operation was written to disk
// Returns true if flush succeeded and length is correct, false otherwise
async function persistAndVerify (expectedLength, operationType) {
    if (!autobase || !autobase.local || !store) {
        console.error(`persistAndVerify (${operationType}): autobase, local core, or store not available`)
        return false
    }

    try {
        // Force write to disk via Corestore - this flushes all cores to storage
        // Corestore.flush() ensures all pending writes are persisted
        if (typeof store.flush === 'function') {
            await store.flush()
        }

        const actualLength = autobase.local.length
        const keyHex = autobase.local.key.toString('hex').slice(0, 16)

        if (actualLength >= expectedLength) {
            console.error(`persistAndVerify (${operationType}): SUCCESS - flushed to disk, core ${keyHex}... length=${actualLength}`)
            return true
        } else {
            console.error(`persistAndVerify (${operationType}): LENGTH MISMATCH - core ${keyHex}... length=${actualLength}, expected >= ${expectedLength}`)
            return false
        }
    } catch (e) {
        console.error(`persistAndVerify (${operationType}): FLUSH FAILED -`, e.message)
        return false
    }
}