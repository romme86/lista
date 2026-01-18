import Hyperswarm from "hyperswarm";
import {autobase, chatSwarm} from "../backend.mjs";

export function sendHandshakeMessage (conn, msg) {
    const line = JSON.stringify(msg) + '\n'
    conn.write(line)
}

export async function handleHandshakeMessage (msg) {
    if (!autobase) return
    if (!msg || msg.type !== 'writer-key') return

    const remoteKeyHex = msg.key
    if (!remoteKeyHex || typeof remoteKeyHex !== 'string') return

    if (knownWriters.has(remoteKeyHex)) return
    knownWriters.add(remoteKeyHex)

    // Only a writer can add other writers.
    if (!autobase.writable) {
        console.error('Not writable here, cannot add remote writer yet')
        return
    }

    console.error('Adding remote writer via autobase:', remoteKeyHex)

    await autobase.append({
        type: 'add-writer',
        key: remoteKeyHex
    })
}

export async function setupHandshakeChannel (conn) {
    if (!autobase) {
        console.error('setupHandshakeChannel called before Autobase is initialized')
        return
    }

    // Send our writer key immediately
    await autobase.ready()
    const myWriterKeyHex = autobase.local.key.toString('hex')
    sendHandshakeMessage(conn, {
        type: 'writer-key',
        key: myWriterKeyHex
    })

    let buffer = ''
    conn.on('data', (chunk) => {
        buffer += chunk.toString()
        let idx
        while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 1)
            if (!line.trim()) continue

            // Fast-path: hypercore protocol frames and other binary garbage
            // are not going to start with '{', so just ignore them.
            if (line[0] !== '{') {
                continue
            }

            let msg
            try {
                msg = JSON.parse(line)
            } catch (e) {
                console.warn('invalid JSON from peer (handshake, ignored):', line)
                continue
            }

            handleHandshakeMessage(msg)
        }
    })
}

export function setupChatSwarm (chatTopic) {
    if (!autobase) {
        console.error('setupChatSwarm called before Autobase is initialized')
        return
    }
    chatSwarm = new Hyperswarm()
    console.error('setting up chat swarm with topic:', chatTopic.toString('hex'))
    chatSwarm.on('connection', (conn, info) => {
        console.error('Handshake connection (chat swarm) with peer', info?.peer, info?.publicKey?.toString('hex'), info?.topics, info?.prioritized)
        conn.on('error', (err) => {
            console.error('Chat swarm connection error:', err)
        })
        setupHandshakeChannel(conn)
    })

    chatSwarm.on('error', (err) => {
        console.error('Chat swarm error:', err)
    })

    chatSwarm.join(chatTopic, { server: true, client: true })
    console.error('Handshake chat swarm joined on topic:', chatTopic.toString('hex'))
}
