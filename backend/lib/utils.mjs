// Utility functions - no dependencies on other modules

import { randomBytes } from 'bare-crypto'

// Console logging (uses stderr to avoid mixing with stdout)
export function log(...args) {
    console.error(...args)
}

// Async delay utility
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// Generate unique ID for items
export function generateId() {
    return randomBytes(16).toString('hex')
}
