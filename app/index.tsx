import React, {useEffect, useRef, useState, useCallback} from 'react'
import {View, TouchableOpacity, Share, Modal, TextInput, Text, Alert, ActivityIndicator, Animated} from 'react-native'
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context'
import * as FileSystemExpo from 'expo-file-system';
import { toByteArray } from 'base64-js';
import {Worklet} from 'react-native-bare-kit'
// import bundle from './assets/backend.android.bundle.mjs'
// import backendBundleB64 from './assets/backend.android.bundle.mjs';
import backendBundleB64 from './app.ios.bundle.mjs';
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
    SYNC_LIST,
    RPC_REQUEST_SYNC
} from '../rpc-commands.mjs'
import InertialElasticList from './components/intertial_scroll'
import { styles, headerStyles, dialogStyles, joiningStyles } from './components/styles'

export type ListEntry = {
    text: string,
    isDone: boolean,
    timeOfCompletion: EpochTimeStamp,
}

type AnimatedIconButtonProps = {
    onPress: () => void;
    children: React.ReactNode;
    style?: any;
}

function AnimatedIconButton({ onPress, children, style }: AnimatedIconButtonProps) {
    const scaleAnim = useRef(new Animated.Value(1)).current;

    const handlePressIn = () => {
        Animated.spring(scaleAnim, {
            toValue: 0.85,
            useNativeDriver: true,
            speed: 50,
            bounciness: 4,
        }).start();
    };

    const handlePressOut = () => {
        Animated.spring(scaleAnim, {
            toValue: 1,
            useNativeDriver: true,
            speed: 20,
            bounciness: 10,
        }).start();
    };

    return (
        <TouchableOpacity
            onPress={onPress}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            activeOpacity={1}
            style={style}
        >
            <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
                {children}
            </Animated.View>
        </TouchableOpacity>
    );
}

let workletSingleton: Worklet | null = null
let workletStartPromise: Promise<void> | null = null

export default function App() {
    // List state is initialized empty - backend will send persisted data (including defaults on first run)
    const [dataList, setDataList] = useState<ListEntry[]>([])

    const [pairingInvite, setPairingInvite] = useState('')
    const [isWorkletStarted, setIsWorkletStarted] = useState(false)
    const [autobaseInviteKey, setAutobaseInviteKey] = useState('')
    const rpcRef = useRef<any>(null)
    const workletRef = useRef<Worklet | null>(null)
    const isJoiningRef = useRef(false)
    const [joinDialogVisible, setJoinDialogVisible] = useState(false)
    const [joinKeyInput, setJoinKeyInput] = useState('')
    const [peerCount, setPeerCount] = useState(0)
    const [isJoining, setIsJoining] = useState(false)
    const [currentP2PMessage, setCurrentP2PMessage] = useState(0)
    const blinkAnim = useRef(new Animated.Value(1)).current

    // Blinking animation when key is not ready
    useEffect(() => {
        if (!autobaseInviteKey) {
            const blink = Animated.loop(
                Animated.sequence([
                    Animated.timing(blinkAnim, {
                        toValue: 0.3,
                        duration: 500,
                        useNativeDriver: true,
                    }),
                    Animated.timing(blinkAnim, {
                        toValue: 1,
                        duration: 500,
                        useNativeDriver: true,
                    }),
                ])
            )
            blink.start()
            return () => blink.stop()
        } else {
            blinkAnim.setValue(1)
        }
    }, [autobaseInviteKey])

    const p2pMessages = [
        "🌐 Connecting to the decentralized network...",
        "🔐 No servers, no middlemen - just you and your peers",
        "🚀 P2P means your data stays yours, always",
        "🔗 Building encrypted tunnels between devices...",
        "✨ Syncing directly - no cloud required",
        "🌍 Your list, your network, your rules",
        "⚡ Peer-to-peer: the way the internet was meant to be",
        "🛡️ End-to-end encrypted, naturally",
    ]

    // Rotate P2P messages while joining
    useEffect(() => {
        if (!isJoining) return
        const interval = setInterval(() => {
            setCurrentP2PMessage((prev) => (prev + 1) % p2pMessages.length)
        }, 3000)
        return () => clearInterval(interval)
    }, [isJoining])

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
            if (workletSingleton && typeof (workletSingleton as any).stop === 'function') {
                try { (workletSingleton as any).stop() } catch (e) {}
            }
            workletSingleton = null
            workletStartPromise = null
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
        if (workletStartPromise) return workletStartPromise
        workletStartPromise = (async () => {
            console.log('Starting worklet (singleton)')
            const worklet = new Worklet()
            workletSingleton = worklet
            workletRef.current = worklet

            const bundleBytes = toByteArray(backendBundleB64)

            const baseDir =
                FileSystemExpo.Paths.document.uri ??
                FileSystemExpo.Paths.cache.uri ??
                ''

            worklet.start('/app.bundle', bundleBytes, [String(baseDir)])

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
                                // If we're joining and got a peer, we're connected!
                                if (isJoiningRef.current && count > 0) {
                                    isJoiningRef.current = false
                                    setIsJoining(false)
                                    Alert.alert('Success!', 'Connected to peer successfully. Your lists are now synced.')
                                }
                            } else if (payload.type === 'not-writable') {
                                Alert.alert('Please wait', payload.message || 'You are not yet authorized to modify the list. Please wait a moment.')
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
                        // Backend is the source of truth - display whatever it sends
                        setDataList(listToSync)
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
        })()
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

        // Delete default entries only if they exist
        const defaultTexts = [
            'Tap to mark as done',
            'Double tap to add new',
            'Slide right slowly to delete'
        ]
        const defaultEntries = dataList.filter(item => defaultTexts.includes(item.text))
        if (defaultEntries.length > 0) {
            for (const entry of defaultEntries) {
                sendRPC(RPC_DELETE, JSON.stringify({ item: entry }))
            }
        }

        sendRPC(RPC_ADD, JSON.stringify(text))
    }

    const handleShare = async () => {
        console.log('Share pressed, key:', autobaseInviteKey);
        if (!autobaseInviteKey) {
            Alert.alert('Connection in progress', 'Invite key is not available yet. Please wait a moment and try again.');
            return;
        }

        try {
            const result = await Share.share({
                message: `${autobaseInviteKey}`,
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

        // Show joining overlay
        setIsJoining(true);
        setCurrentP2PMessage(0);
        isJoiningRef.current = true;

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

    const handleDeleteAll = () => {
        Alert.alert(
            'Delete All Items',
            'Are you sure you want to delete all items? This cannot be undone.',
            [
                {
                    text: 'Cancel',
                    style: 'cancel',
                },
                {
                    text: 'Delete All',
                    style: 'destructive',
                    onPress: () => {
                        // Delete each item via RPC
                        dataList.forEach((item) => {
                            sendRPC(RPC_DELETE, JSON.stringify({ item }));
                        });
                        setDataList([]);
                    },
                },
            ]
        );
    };

    const peerCountLabel = peerCount > 99 ? '99+' : String(peerCount)

    return (
        <SafeAreaProvider>
            <View style={styles.container}>
                <SafeAreaView style={headerStyles.safeArea} edges={['top']}>
                    <View style={headerStyles.container}>
                        <View style={headerStyles.leftSection}>
                            <AnimatedIconButton
                                style={headerStyles.iconButton}
                                onPress={handleDeleteAll}
                            >
                                <Ionicons name="trash-outline" size={24} color="#333" />
                            </AnimatedIconButton>
                        </View>

                        <View style={headerStyles.rightSection}>
                            <View style={headerStyles.iconWithBadge}>
                                <AnimatedIconButton
                                    style={headerStyles.iconButton}
                                    onPress={handleShare}
                                >
                                    <Ionicons name="share-outline" size={24} color="#333" />
                                </AnimatedIconButton>
                                {!autobaseInviteKey ? (
                                    <Animated.View style={[headerStyles.badge, headerStyles.orangeBadge, { opacity: blinkAnim }]} />
                                ) : peerCount > 0 ? (
                                    <View style={headerStyles.pearBadge}>
                                        <View style={headerStyles.pearStalk} />
                                        <View style={headerStyles.pearTop} />
                                        <View style={headerStyles.pearBottom}>
                                            <Text style={headerStyles.pearBadgeText}>{peerCountLabel}</Text>
                                        </View>
                                    </View>
                                ) : null}
                            </View>

                            <AnimatedIconButton
                                style={headerStyles.iconButton}
                                onPress={handleJoin}
                            >
                                <Ionicons name="person-add-outline" size={24} color="#333" />
                            </AnimatedIconButton>
                        </View>
                    </View>
                </SafeAreaView>
                <Modal
                    visible={joinDialogVisible}
                    transparent={true}
                    animationType="fade"
                    onRequestClose={handleJoinCancel}
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
                                    onPress={handleJoinCancel}
                                >
                                    <Text style={dialogStyles.cancelButtonText}>Cancel</Text>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={[dialogStyles.button, dialogStyles.submitButton]}
                                    onPress={handleJoinSubmit}
                                >
                                    <Text style={dialogStyles.submitButtonText}>Join</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                </Modal>
                <Modal
                    visible={isJoining}
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
                                {p2pMessages[currentP2PMessage]}
                            </Text>
                            <TouchableOpacity
                                style={joiningStyles.cancelButton}
                                onPress={() => {
                                    setIsJoining(false);
                                    isJoiningRef.current = false;
                                }}
                            >
                                <Text style={joiningStyles.cancelButtonText}>Cancel</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </Modal>
                <InertialElasticList
                    data={dataList}
                    onToggleDone={handleToggleDone}
                    onDelete={handleDelete}
                    onInsert={handleInsert}
                />
            </View>
        </SafeAreaProvider>
    )
}
