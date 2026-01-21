import React from 'react'
import { View, Text, Modal, TextInput, TouchableOpacity } from 'react-native'
import { dialogStyles } from './_styles'

type JoinDialogProps = {
    visible: boolean
    joinKeyInput: string
    setJoinKeyInput: (text: string) => void
    onSubmit: () => void
    onCancel: () => void
}

export function JoinDialog({
    visible,
    joinKeyInput,
    setJoinKeyInput,
    onSubmit,
    onCancel,
}: JoinDialogProps) {
    return (
        <Modal
            visible={visible}
            transparent={true}
            animationType="fade"
            onRequestClose={onCancel}
        >
            <View style={dialogStyles.overlay}>
                <View style={dialogStyles.dialog}>
                    <Text style={dialogStyles.title}>Join with Invite Key</Text>
                    <Text style={dialogStyles.subtitle}>Paste the invite key below</Text>

                    <TextInput
                        style={dialogStyles.input}
                        value={joinKeyInput}
                        onChangeText={setJoinKeyInput}
                        placeholder="Enter invite key..."
                        placeholderTextColor="#999"
                        multiline={true}
                        autoFocus={true}
                    />

                    <View style={dialogStyles.buttonContainer}>
                        <TouchableOpacity
                            style={[dialogStyles.button, dialogStyles.cancelButton]}
                            onPress={onCancel}
                        >
                            <Text style={dialogStyles.cancelButtonText}>Cancel</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[dialogStyles.button, dialogStyles.submitButton]}
                            onPress={onSubmit}
                        >
                            <Text style={dialogStyles.submitButtonText}>Join</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    )
}