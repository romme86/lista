// Generate unique ID (used only for addItem)
import {randomBytes} from "bare-crypto";

export function generateId () {
    return randomBytes(16).toString('hex')
}