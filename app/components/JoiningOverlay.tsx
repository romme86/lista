import React from 'react'
import { View, Text, Modal, TouchableOpacity, ActivityIndicator } from 'react-native'
import { joiningStyles } from './_styles'

const P2P_MESSAGES = [
    "Connecting to the decentralized network...",
    "No servers, no middlemen - just you and your peers",
    "P2P means your data stays yours, always",
    "Building encrypted tunnels between devices...",
    "Syncing directly - no cloud required",
    "Your list, your network, your rules",
    "Peer-to-peer: the way the internet was meant to be",
    "End-to-end encrypted, naturally",
]

type JoiningOverlayProps = {
    visible: boolean
    currentMessageIndex: number
    onCancel: () => void
}

export function JoiningOverlay({
    visible,
    currentMessageIndex,
    onCancel,
}: JoiningOverlayProps) {
    return (
        <Modal
            visible={visible}
            transparent={true}
            animationType="fade"
        >
            <View style={joiningStyles.overlay}>
                <View style={joiningStyles.content}>
                    <ActivityIndicator size="large" color="#333" />
                    <Text style={joiningStyles.title}>Connecting to peer...</Text>
                    <Text style={joiningStyles.subtitle}>
                        Please keep the app open while we establish a secure connection.
                    </Text>
                    <Text style={joiningStyles.p2pMessage}>
                        {P2P_MESSAGES[currentMessageIndex]}
                    </Text>
                    <TouchableOpacity
                        style={joiningStyles.cancelButton}
                        onPress={onCancel}
                    >
                        <Text style={joiningStyles.cancelButtonText}>Cancel</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </Modal>
    )
}

export { P2P_MESSAGES }