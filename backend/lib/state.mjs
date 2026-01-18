// Shared mutable state exports
// All modules import from here and use setters to modify state

// Core P2P instances
export let autobase = null
export let store = null
export let swarm = null
export let chatSwarm = null
export let discovery = null

// RPC instance
export let rpc = null

// Keys and topics
export let baseKey = null
export let currentTopic = null
export let chatTopic = null

// In-memory data
export let currentList = []
export let peerCount = 0

// Writer tracking
export const knownWriters = new Set()
export let addedStaticPeers = false

// State flags
export let isResettingState = false

// Transient error tracking
export let transientErrorCount = 0
export let lastTransientErrorTime = 0
export const MAX_TRANSIENT_ERRORS = 10

// Setters for mutable state
export function setAutobase(val) { autobase = val }
export function setStore(val) { store = val }
export function setSwarm(val) { swarm = val }
export function setChatSwarm(val) { chatSwarm = val }
export function setDiscovery(val) { discovery = val }
export function setRpc(val) { rpc = val }
export function setBaseKey(val) { baseKey = val }
export function setCurrentTopic(val) { currentTopic = val }
export function setChatTopic(val) { chatTopic = val }
export function setCurrentList(val) { currentList = val }
export function setPeerCount(val) { peerCount = val }
export function setAddedStaticPeers(val) { addedStaticPeers = val }
export function setIsResettingState(val) { isResettingState = val }
export function setTransientErrorCount(val) { transientErrorCount = val }
export function setLastTransientErrorTime(val) { lastTransientErrorTime = val }

// Helper to clear known writers
export function clearKnownWriters() { knownWriters.clear() }
