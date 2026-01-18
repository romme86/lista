// Key management - save/load autobase and writer keys

import fs from 'bare-fs'
import { log } from './utils.mjs'
import { keyFilePath, localWriterKeyFilePath } from './storage.mjs'

// Save autobase key to file for persistence across restarts
export function saveAutobaseKey(key) {
    try {
        const keyHex = key.toString('hex')
        fs.writeFileSync(keyFilePath, keyHex)
        log('Saved autobase key to file:', keyHex)
    } catch (e) {
        log('Failed to save autobase key:', e)
    }
}

// Load autobase key from file if it exists
export function loadAutobaseKey() {
    try {
        if (fs.existsSync(keyFilePath)) {
            const keyHex = fs.readFileSync(keyFilePath, 'utf8').trim()
            if (keyHex && keyHex.length === 64) {
                log('Loaded autobase key from file:', keyHex)
                return Buffer.from(keyHex, 'hex')
            }
        }
    } catch (e) {
        log('Failed to load autobase key:', e)
    }
    return null
}

// Save local writer key to file for persistence
export function saveLocalWriterKey(key) {
    try {
        const keyHex = key.toString('hex')
        fs.writeFileSync(localWriterKeyFilePath, keyHex)
        log('Saved local writer key to file:', keyHex)
    } catch (e) {
        log('Failed to save local writer key:', e)
    }
}

// Load local writer key from file if it exists
export function loadLocalWriterKey() {
    try {
        if (fs.existsSync(localWriterKeyFilePath)) {
            const keyHex = fs.readFileSync(localWriterKeyFilePath, 'utf8').trim()
            if (keyHex && keyHex.length === 64) {
                log('Loaded local writer key from file:', keyHex)
                return Buffer.from(keyHex, 'hex')
            }
        }
    } catch (e) {
        log('Failed to load local writer key:', e)
    }
    return null
}
