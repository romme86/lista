// Storage paths and file management

import fs from 'bare-fs'
import { join } from 'bare-path'
import Corestore from 'corestore'
import { log, sleep } from './utils.mjs'
import { setBaseKey } from './state.mjs'

// Storage paths - computed from base directory
let baseDir = null
export let storagePath = './data'
export let keyFilePath = './autobase-key.txt'
export let localWriterKeyFilePath = './local-writer-key.txt'
export let VERSION_MARKER_FILE = null

// Initialize storage paths from base directory
export function initStoragePaths(baseDirPath) {
    baseDir = baseDirPath
    storagePath = baseDir ? join(baseDir, 'lista') : './data'
    keyFilePath = baseDir ? join(baseDir, 'lista-autobase-key.txt') : './autobase-key.txt'
    localWriterKeyFilePath = baseDir ? join(baseDir, 'lista-local-writer-key.txt') : './local-writer-key.txt'
    VERSION_MARKER_FILE = baseDir ? join(baseDir, '.lista-storage-v2') : null

    log('Storage paths initialized:')
    log('  baseDir:', baseDir)
    log('  storagePath:', storagePath)
    log('  keyFilePath:', keyFilePath)
    log('  localWriterKeyFilePath:', localWriterKeyFilePath)
}

export function getBaseDir() {
    return baseDir
}

// Synchronous cleanup helper to delete corrupted storage
export function deleteStorageSync() {
    log('Performing synchronous storage cleanup...')
    try {
        if (fs.existsSync(keyFilePath)) {
            fs.unlinkSync(keyFilePath)
            log('Deleted autobase key file')
        }
    } catch (e) { log('Error deleting key file:', e) }

    try {
        if (fs.existsSync(localWriterKeyFilePath)) {
            fs.unlinkSync(localWriterKeyFilePath)
            log('Deleted local writer key file')
        }
    } catch (e) { log('Error deleting local writer key file:', e) }

    try {
        if (fs.existsSync(storagePath)) {
            const deleteFolderRecursive = (path) => {
                if (fs.existsSync(path)) {
                    const files = fs.readdirSync(path)
                    for (const file of files) {
                        const curPath = join(path, file)
                        const stat = fs.statSync(curPath)
                        if (stat.isDirectory()) {
                            deleteFolderRecursive(curPath)
                        } else {
                            fs.unlinkSync(curPath)
                        }
                    }
                    fs.rmdirSync(path)
                }
            }
            deleteFolderRecursive(storagePath)
            log('Deleted storage directory:', storagePath)
        }
    } catch (e) { log('Error deleting storage:', e) }
}

// Delete storage with retry logic and delays
export async function deleteStorageWithRetry(maxRetries = 3, initialDelayMs = 500) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const delayMs = initialDelayMs * attempt
        log(`deleteStorageWithRetry: attempt ${attempt}/${maxRetries}, waiting ${delayMs}ms before delete...`)

        await sleep(delayMs)

        try {
            deleteStorageSync()
            log(`deleteStorageWithRetry: SUCCESS on attempt ${attempt}`)
            return true
        } catch (e) {
            const errorStr = String(e)
            if (errorStr.includes('lock') || errorStr.includes('LOCK') || errorStr.includes('No locks available')) {
                log(`deleteStorageWithRetry: lock still held on attempt ${attempt}, will retry...`)
            } else {
                log(`deleteStorageWithRetry: error on attempt ${attempt}:`, e)
            }

            if (attempt === maxRetries) {
                log('deleteStorageWithRetry: FAILED after all retries')
                return false
            }
        }
    }
    return false
}

// Check for version marker to detect storage from old code versions
export function checkStorageVersion() {
    if (!VERSION_MARKER_FILE) return true

    // If version marker exists, storage is from current code version
    if (fs.existsSync(VERSION_MARKER_FILE)) {
        log('Storage version marker found, storage is compatible')
        return true
    }

    // If storage exists but no version marker, it's from old code with checkpoint bugs
    if (fs.existsSync(storagePath) || fs.existsSync(keyFilePath)) {
        log('=== DETECTED OLD STORAGE VERSION ===')
        log('Storage was created by older code with checkpoint bugs.')
        log('Cleaning up to ensure fresh, uncorrupted state...')

        // Clean up old storage
        deleteStorageSync()

        // CRITICAL: Also clear baseKey so the host creates a FRESH autobase as owner
        setBaseKey(null)
        log('Cleared baseKey - host will create fresh autobase as owner')

        // Create version marker for new storage
        try {
            fs.writeFileSync(VERSION_MARKER_FILE, `v2:${Date.now()}`)
            log('Created storage version marker')
        } catch (e) {
            log('Failed to create version marker:', e)
        }

        return false // Storage was cleaned
    }

    // No storage exists - create version marker for new installs
    try {
        fs.writeFileSync(VERSION_MARKER_FILE, `v2:${Date.now()}`)
        log('Created storage version marker for fresh install')
    } catch (e) {
        log('Failed to create version marker:', e)
    }

    return true
}

// Validate storage integrity before initializing
// loadLocalWriterKeyFn is passed to avoid circular dependency
export async function validateStorageIntegrity(notifyUserError, loadLocalWriterKeyFn) {
    log('=== VALIDATING STORAGE INTEGRITY ===')

    // First check storage version - clean up if from old buggy code
    checkStorageVersion()

    if (!fs.existsSync(storagePath)) {
        log('Storage does not exist, fresh start')
        return true
    }

    try {
        // Try to open the corestore and check basic integrity
        const testStore = new Corestore(storagePath)
        await testStore.ready()

        // Try to load the local writer key and access that core
        const savedLocalWriterKey = loadLocalWriterKeyFn ? loadLocalWriterKeyFn() : null
        if (savedLocalWriterKey) {
            const testCore = testStore.get({ key: savedLocalWriterKey })
            await testCore.ready()
            // Try to read first entry to verify data integrity
            if (testCore.length > 0) {
                await testCore.get(0)
            }
        }

        await testStore.close()
        log('Storage integrity check PASSED')
        return true
    } catch (e) {
        log('Storage integrity check FAILED:', e.message)

        // Notify user
        if (notifyUserError) {
            notifyUserError(
                'Data Corruption Detected',
                `The app detected corrupted data and will reset. Error: ${e.message}`
            )
        }

        // Clean up corrupted storage synchronously
        deleteStorageSync()

        return false
    }
}

// Create version marker file
export function createVersionMarker() {
    if (VERSION_MARKER_FILE) {
        try {
            fs.writeFileSync(VERSION_MARKER_FILE, `v2:${Date.now()}`)
        } catch (_e) {}
    }
}

// Write reset marker for incomplete reset
export function writeResetMarker(errorMessage) {
    try {
        const resetMarkerPath = baseDir ? join(baseDir, '.lista-reset-pending') : null
        if (resetMarkerPath) {
            fs.writeFileSync(resetMarkerPath, `reset-requested:${Date.now()}:${errorMessage}`)
            log('Reset marker written to:', resetMarkerPath)
            return true
        }
    } catch (e) {
        log('Failed to write reset marker:', e)
    }
    return false
}
