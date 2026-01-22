
// Add item operation (backend creates the canonical item)
import {RPC_MESSAGE} from "../../rpc-commands.mjs";
import {generateId} from "./util.mjs";
import {autobase, store, rpc, currentList} from './state.mjs'
import {SYNC_LIST} from "../../rpc-commands.mjs";

// --- WRITE SERIALIZATION (prevents concurrent autobase.append / flush races) ---
let _writeChain = Promise.resolve()

function enqueueWrite (fn) {
    // ensures writes run one-at-a-time even if RPC calls arrive concurrently
    _writeChain = _writeChain.then(fn, fn)
    return _writeChain
}

export async function addItem (text, listId) {
    if (!autobase) {
        console.error('[WARNING] addItem called before Autobase is initialized')
        return false
    }

    if (!autobase.writable) {
        console.error('[WARNING] addItem called but autobase is not writable yet - waiting to be added as writer')
        // Notify frontend about not being writable
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({ type: 'not-writable', message: 'Waiting to be added as a writer by the host...' }))
        } catch (e) {
            console.error('[ERROR] Failed to send not-writable message:', e)
        }
        return false
    }

    console.error('[INFO] Command RPC_ADD addItem text', text)

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

    return enqueueWrite(async () => {
        if (!autobase) return false
        if (autobase.closing) {
            console.error('[WARNING] Mutation requested while Autobase is closing; ignoring.')
            return false
        }
        // Get length before append to verify it increases
        // const lengthBefore = autobase.local.length

        await autobase.append(op)

        // Flush to disk and verify persistence
        // const persisted = await persistAndVerify(lengthBefore + 1, 'ADD')
        // if (!persisted) {
        //     console.error('[WARNING] Add operation may not have been persisted to disk!')
        // }

        console.error('[INFO] Added item:', text)
        return true
    })
}

// Update item operation: AUTONOMOUS, NO BACKEND MEMORY
export async function updateItem (item) {
    if (!autobase) {
        console.error('[WARNING] updateItem called before Autobase is initialized')
        return false
    }

    if (!autobase.writable) {
        console.error('[WARNING] updateItem called but autobase is not writable yet')
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({ type: 'not-writable', message: 'Waiting to be added as a writer by the host...' }))
        } catch (e) {
            console.error('[ERROR] Failed to send not-writable message:', e)
        }
        return false
    }

    console.error('[INFO] Command RPC_UPDATE updateItem item', item)

    const op = {
        type: 'update',
        value: item
    }

    return enqueueWrite(async () => {
        if (!autobase) return false
        if (autobase.closing) {
            console.error('[WARNING] Mutation requested while Autobase is closing; ignoring.')
            return false
        }
        const lengthBefore = autobase.local.length

        await autobase.append(op)

        // const persisted = await persistAndVerify(lengthBefore + 1, 'UPDATE')
        // if (!persisted) {
        //     console.error('[WARNING] Update operation may not have been persisted to disk!')
        // }

        console.error('[INFO] Updated item:', item.text)
        return true
    })
}

// Delete item operation: AUTONOMOUS, NO BACKEND MEMORY
export async function deleteItem (item) {
    if (!autobase) {
        console.error('[WARNING] deleteItem called before Autobase is initialized')
        return false
    }

    if (!autobase.writable) {
        console.error('[WARNING] deleteItem called but autobase is not writable yet')
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({ type: 'not-writable', message: 'Waiting to be added as a writer by the host...' }))
        } catch (e) {
            console.error('[ERROR] Failed to send not-writable message:', e)
        }
        return false
    }

    console.error('[INFO] Command RPC_DELETE deleteItem item', item)

    const op = {
        type: 'delete',
        value: item
    }

    return enqueueWrite(async () => {
        if (!autobase) return false
        if (autobase.closing) {
            console.error('[WARNING] Mutation requested while Autobase is closing; ignoring.')
            return false
        }
        const lengthBefore = autobase.local.length

        await autobase.append(op)

        // const persisted = await persistAndVerify(lengthBefore + 1, 'DELETE')
        // if (!persisted) {
        //     console.error('[WARNING] Delete operation may not have been persisted to disk!')
        // }

        console.error('[INFO] Deleted item:', item.text)
        return true
    })
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
    if (!rpc || !currentList) return
    try {
        const req = rpc.request(SYNC_LIST)
        req.send(JSON.stringify(currentList))
        console.error('[INFO] Synced list to frontend:', currentList.length, 'items')
    } catch (e) {
        console.error('[ERROR] Failed to sync list to frontend:', e)
    }
}

// Persist and verify that an operation was written to disk
// Returns true if flush succeeded and length is correct, false otherwise
async function persistAndVerify (expectedLength, operationType) {
    if (!autobase || !autobase.local || !store) {
        console.error(`[ERROR] persistAndVerify (${operationType}): autobase, local core, or store not available`)
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
            console.error(`[INFO] persistAndVerify (${operationType}): SUCCESS - flushed to disk, core ${keyHex}... length=${actualLength}`)
            return true
        } else {
            console.error(`[WARNING] persistAndVerify (${operationType}): LENGTH MISMATCH - core ${keyHex}... length=${actualLength}, expected >= ${expectedLength}`)
            return false
        }
    } catch (e) {
        console.error(`[ERROR] persistAndVerify (${operationType}): FLUSH FAILED -`, e.message)
        return false
    }
}

export async function rebuildListFromPersistedOps() {
    await autobase.update()
    if (!autobase || !autobase.view) {
        console.error('[WARNING] rebuildListFromPersistedOps: autobase or view not available')
        return []
    }

    const rebuiltList = []
    const view = autobase.view
    const length = view.length

    console.error(`[INFO] rebuildListFromPersistedOps: reading ${length} entries from merged view...`)

    for (let i = 0; i < length; i++) {
        try {
            const item = await view.get(i)
            if (!item) {
                console.error(`[WARNING] entry ${i}: null/undefined`)
                continue
            }

            if (item.text !== undefined && validateItem(item)) {
                rebuiltList.push(item)
                console.error(`[INFO] entry ${i}: "${item.text}"`)
            } else {
                console.error(`[WARNING] entry ${i}: unknown format`)
            }
        } catch (e) {
            console.error(`[ERROR] rebuildListFromPersistedOps: error reading entry ${i}:`, e.message)
        }
    }

    console.error(`[INFO] rebuildListFromPersistedOps: rebuilt list with ${rebuiltList.length} items`)
    return rebuiltList
}


