import React, {useEffect, useRef, useState} from 'react'
import {Platform, StyleSheet, View, TouchableOpacity, SafeAreaView, Share, Modal, TextInput, Text, Alert} from 'react-native'
import {documentDirectory} from 'expo-file-system'
import {Worklet} from 'react-native-bare-kit'
import bundle from './app.bundle.android.mjs'
import RPC from 'bare-rpc'
import b4a from 'b4a'
import { Ionicons } from '@expo/vector-icons';
import {
    RPC_MESSAGE,
    RPC_RESET,
    RPC_UPDATE,
    RPC_DELETE,
    RPC_ADD,
    RPC_GET_KEY,
    RPC_ADD_FROM_BACKEND,
    RPC_UPDATE_FROM_BACKEND,
    RPC_DELETE_FROM_BACKEND,
    RPC_JOIN_KEY,
    SYNC_LIST
} from '../rpc-commands.mjs'
import InertialElasticList from './components/intertial_scroll'

export type ListEntry = {
    text: string,
    isDone: boolean,
    timeOfCompletion: EpochTimeStamp,
}

export default function App() {
    const [dataList, setDataList] = useState<ListEntry[]>([
        { text: 'Tap to mark as done', isDone: false, timeOfCompletion: 0 },
        { text: 'Double tap to add new', isDone: false, timeOfCompletion: 0 },
        { text: 'Slide left to delete', isDone: false, timeOfCompletion: 0 },
        { text: 'Mozzarella', isDone: false, timeOfCompletion: 0 },
        { text: 'Tomato Sauce', isDone: false, timeOfCompletion: 0 },
        { text: 'Flour', isDone: false, timeOfCompletion: 0 },
        { text: 'Yeast', isDone: false, timeOfCompletion: 0 },
        { text: 'Salt', isDone: false, timeOfCompletion: 0 },
        { text: 'Basil', isDone: false, timeOfCompletion: 0 }
    ])

    const [pairingInvite, setPairingInvite] = useState('')
    const [isWorkletStarted, setIsWorkletStarted] = useState(false)
    const [autobaseInviteKey, setAutobaseInviteKey] = useState('')
    const rpcRef = useRef<any>(null)
    const workletRef = useRef<Worklet | null>(null)
    const [joinDialogVisible, setJoinDialogVisible] = useState(false)
    const [joinKeyInput, setJoinKeyInput] = useState('')
    const [peerCount, setPeerCount] = useState(0)

    useEffect(() => {
        if (!isWorkletStarted) {
            setIsWorkletStarted(true)
            startWorklet()
        }

        return () => {
            // Cleanup on unmount / reload
            if (workletRef.current && typeof (workletRef.current as any).stop === 'function') {
                try {
                    ;(workletRef.current as any).stop()
                } catch (e) {
                    console.warn('Error stopping worklet', e)
                }
            }
            workletRef.current = null
            rpcRef.current = null
        }
    }, [])

    const sendRPC = (command: number, payload?: string) => {
        if (!rpcRef.current) {
            console.warn('RPC not ready, ignoring command', command)
            return
        }
        const req = rpcRef.current.request(command)
        if (payload !== undefined) {
            req.send(payload)
        }
    }



    const startWorklet = () => {

        console.log('Starting worklet')
        const worklet = new Worklet()
        workletRef.current = worklet

        console.log('documentDirectory', documentDirectory, pairingInvite)
        const worklet_start = worklet.start('/app.bundle', bundle, [String(documentDirectory)])
        console.log('worklet_start', worklet_start)
        const { IPC } = worklet

        rpcRef.current = new RPC(IPC, (reqFromBackend) => {
            if (reqFromBackend.command === RPC_MESSAGE) {
                console.log('RPC MESSAGE req', reqFromBackend)
                if (reqFromBackend.data) {
                    const dataStr = b4a.toString(reqFromBackend.data)
                    console.log('data from bare', dataStr)
                    try {
                        const payload = JSON.parse(dataStr)
                        if (payload.type === 'peer-count') {
                            const count = typeof payload.count === 'number' ? payload.count : 0
                            setPeerCount(count)
                        } else {
                            console.log('RPC_MESSAGE payload (unhandled type):', payload)
                        }
                    } catch (e) {
                        console.warn('Invalid RPC_MESSAGE payload', dataStr)
                    }
                } else {
                    console.log('RPC_MESSAGE without data')
                }
            }
            if (reqFromBackend.command === RPC_RESET) {
                console.log('RPC RESET')
                setDataList(() => [])
            }
            if (reqFromBackend.command === SYNC_LIST) {
                console.log('SYNC_LIST')
                if(reqFromBackend.data) {
                    console.log('data from bare', b4a.toString(reqFromBackend.data))
                    const listToSync = JSON.parse(b4a.toString(reqFromBackend.data))
                    setDataList(() => listToSync)
                }

            }
            if (reqFromBackend.command === RPC_DELETE_FROM_BACKEND) {
                console.log('RPC_DELETE_FROM_BACKEND')
                if(reqFromBackend.data) {
                    console.log('data from bare', b4a.toString(reqFromBackend.data))
                    const itemToDelete = JSON.parse(b4a.toString(reqFromBackend.data))
                    setDataList((prevList) => prevList.filter((item) => item.text !== itemToDelete.text))
                }

            }
            if (reqFromBackend.command === RPC_UPDATE_FROM_BACKEND) {
                console.log('RPC_UPDATE_FROM_BACKEND')
                if(reqFromBackend.data) {
                    console.log('data from bare', b4a.toString(reqFromBackend.data))
                    const itemToUpdate = JSON.parse(b4a.toString(reqFromBackend.data))
                    setDataList((prevList) => {
                        const newList = prevList.map((item) =>
                            item.text === itemToUpdate.text ? { ...item, isDone: itemToUpdate.isDone, timeOfCompletion: itemToUpdate.timeOfCompletion } : item
                        )
                        return newList
                    })
                }
            }
            if (reqFromBackend.command === RPC_ADD_FROM_BACKEND) {
                console.log('RPC_ADD_FROM_BACKEND')
                if(reqFromBackend.data) {
                    console.log('data from bare', b4a.toString(reqFromBackend.data))
                    const itemToAdd = JSON.parse(b4a.toString(reqFromBackend.data))
                    setDataList((prevList) => [itemToAdd, ...prevList])
                }
            }
            if (reqFromBackend.command === RPC_GET_KEY) {
                console.log('RPC_GET_KEY', )
                if (reqFromBackend.data) {
                    console.log('data from bare', b4a.toString(reqFromBackend.data))
                    const data = b4a.toString(reqFromBackend.data)
                    setAutobaseInviteKey(data)
                } else {
                    console.log('data from bare is null, empty or undefined')
                }
            }
        })
        setIsWorkletStarted(true)
    }

    const handleToggleDone = (index: number) => {
        setDataList((prevList) => {
            const newList = [...prevList]
            const current = newList[index]

            if (!current) {
                return prevList
            }

            const updatedItem: ListEntry = {
                ...current,
                isDone: !current.isDone,
                timeOfCompletion: !current.isDone ? Date.now() : 0,
            }

            // Reorder: done items to bottom, undone to top
            newList.splice(index, 1)
            if (updatedItem.isDone) {
                newList.push(updatedItem)
            } else {
                newList.unshift(updatedItem)
            }

            console.log('sending RPC request update')

            if (rpcRef.current) {
                sendRPC(RPC_UPDATE, JSON.stringify({ item: updatedItem }))
            } else {
                console.warn('RPC not ready, ignoring UPDATE')
            }

            return newList
        })
    }

    const handleDelete = (index: number) => {
        const deletedItem = dataList[index];
        setDataList((prevList) => prevList.filter((_, i) => i !== index))
        sendRPC(RPC_DELETE, JSON.stringify({ item: deletedItem }))
    }

    const handleInsert = (index: number, text: string) => {
        if (!rpcRef.current) {
            console.warn('RPC not ready, ignoring ADD')
            return
        }

        sendRPC(RPC_ADD, JSON.stringify(text))
    }

    const handleShare = async () => {
        console.log('Share pressed');
        if (!autobaseInviteKey) {
            console.log('No invite key available to share');
            return;
        }

        try {
            const result = await Share.share({
                message: `Join my list! Use this key: ${autobaseInviteKey}`,
                title: 'Share Invite Key'
            });

            if (result.action === Share.sharedAction) {
                if (result.activityType) {
                    console.log('Shared with activity type:', result.activityType);
                } else {
                    console.log('Shared successfully');
                }
            } else if (result.action === Share.dismissedAction) {
                console.log('Share dismissed');
            }
        } catch (error) {
            console.error('Error sharing:', error);
        }
    };

    const handleJoin = () => {
        console.log('Join pressed');
        setJoinDialogVisible(true);
    };

    const handleJoinSubmit = () => {
        if (!joinKeyInput.trim()) {
            Alert.alert('Error', 'Please enter an invite key');
            return;
        }

        console.log('Submitting join key:', joinKeyInput);

        // Make RPC call to backend
        sendRPC(RPC_JOIN_KEY, JSON.stringify({ key: joinKeyInput }));

        // Close dialog and reset input
        setJoinDialogVisible(false);
        setJoinKeyInput('');
    };

    const handleJoinCancel = () => {
        setJoinDialogVisible(false);
        setJoinKeyInput('');
    };

    const peerCountLabel = peerCount > 99 ? '99+' : String(peerCount)

    return (
        <View style={styles.container}>
            <>
                <SafeAreaView style={styles_safe_area.safeArea}>
                    <View style={styles_safe_area.container}>
                        <View style={styles_safe_area.leftSection} />

                        <View style={styles_safe_area.rightSection}>
                            <View style={styles_safe_area.iconWithBadge}>
                                <TouchableOpacity
                                    style={styles_safe_area.iconButton}
                                    onPress={handleShare}
                                    activeOpacity={0.7}
                                >
                                    <Ionicons name="share-outline" size={24} color="#333" />
                                </TouchableOpacity>
                                {peerCount > 0 && (
                                    <View style={styles_safe_area.badge}>
                                        <Text style={styles_safe_area.badgeText}>{peerCountLabel}</Text>
                                    </View>
                                )}
                            </View>

                            <TouchableOpacity
                                style={styles_safe_area.iconButton}
                                onPress={handleJoin}
                                activeOpacity={0.7}
                            >
                                <Ionicons name="person-add-outline" size={24} color="#333" />
                            </TouchableOpacity>
                        </View>
                    </View>
                </SafeAreaView>
                <Modal
                    visible={joinDialogVisible}
                    transparent={true}
                    animationType="fade"
                    onRequestClose={handleJoinCancel}
                >
                    <View style={dialog_styles.overlay}>
                        <View style={dialog_styles.dialog}>
                            <Text style={dialog_styles.title}>Join with Invite Key</Text>
                            <Text style={dialog_styles.subtitle}>Paste the invite key below</Text>

                            <TextInput
                                style={dialog_styles.input}
                                value={joinKeyInput}
                                onChangeText={setJoinKeyInput}
                                placeholder="Enter invite key..."
                                placeholderTextColor="#999"
                                multiline={true}
                                autoFocus={true}
                            />

                            <View style={dialog_styles.buttonContainer}>
                                <TouchableOpacity
                                    style={[dialog_styles.button, dialog_styles.cancelButton]}
                                    onPress={handleJoinCancel}
                                >
                                    <Text style={dialog_styles.cancelButtonText}>Cancel</Text>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={[dialog_styles.button, dialog_styles.submitButton]}
                                    onPress={handleJoinSubmit}
                                >
                                    <Text style={dialog_styles.submitButtonText}>Join</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                </Modal>
                <InertialElasticList
                    data={dataList}
                    onToggleDone={handleToggleDone}
                    onDelete={handleDelete}
                    onInsert={handleInsert}
                />
            </>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
        padding: 20
    },
    input: {
        height: 20,
        borderColor: '#ccc',
        borderWidth: 0,
        marginBottom: 10,
        paddingHorizontal: 10,
        color: '#333'
    },
    dataItem: {
        padding: 10,
        backgroundColor: '#f0f0f0',
        marginVertical: 5,
        borderRadius: 5
    },
    itemText: {
        fontSize: 16,
        color: '#333'
    }
})

const styles_safe_area = StyleSheet.create({
    safeArea: {
        backgroundColor: '#fff',
    },
    container: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        backgroundColor: '#fff',
        paddingHorizontal: 16,
        paddingVertical: 12,
        height: 60,
    },
    leftSection: {
        flex: 1,
    },
    rightSection: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
    },
    iconButton: {
        padding: 8,
    },
    iconWithBadge: {
        position: 'relative',
        justifyContent: 'center',
        alignItems: 'center',
    },
    badge: {
        position: 'absolute',
        top: 4,
        right: 2,
        minWidth: 16,
        height: 16,
        borderRadius: 999,
        backgroundColor: '#ff3b30',
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 3,
    },
    badgeText: {
        color: '#fff',
        fontSize: 10,
        fontWeight: '600',
    },
});


const dialog_styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    dialog: {
        backgroundColor: '#fff',
        borderRadius: 12,
        padding: 24,
        width: '100%',
        maxWidth: 400,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 5,
    },
    title: {
        fontSize: 20,
        fontWeight: '600',
        color: '#333',
        marginBottom: 8,
    },
    subtitle: {
        fontSize: 14,
        color: '#666',
        marginBottom: 20,
    },
    input: {
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 8,
        padding: 12,
        fontSize: 14,
        color: '#333',
        minHeight: 80,
        textAlignVertical: 'top',
        marginBottom: 20,
    },
    buttonContainer: {
        flexDirection: 'row',
        gap: 12,
    },
    button: {
        flex: 1,
        paddingVertical: 12,
        paddingHorizontal: 20,
        borderRadius: 8,
        alignItems: 'center',
    },
    cancelButton: {
        backgroundColor: '#f0f0f0',
    },
    submitButton: {
        backgroundColor: '#333',
    },
    cancelButtonText: {
        color: '#333',
        fontSize: 16,
        fontWeight: '600',
    },
    submitButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '600',
    },
});
