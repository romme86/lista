
// Generate unique ID (used only for addItem)
export function generateId () {
    return randomBytes(16).toString('hex')
}