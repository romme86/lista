import React, { useEffect, useRef, useState, useCallback } from 'react'
import { View, Share, Alert, Animated } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useWorklet, RPC_UPDATE, RPC_DELETE, RPC_ADD, RPC_JOIN_KEY } from './hooks/_useWorklet'
import { Header } from './components/Header'
import { JoinDialog } from './components/JoinDialog'
import { JoiningOverlay, P2P_MESSAGES } from './components/JoiningOverlay'
import InertialElasticList from './components/intertial_scroll'
import { styles } from './components/_styles'
import type { ListEntry } from './components/_types'

const DEFAULT_INSTRUCTIONS: ListEntry[] = [
    { text: 'Double tap to add new', isDone: false, timeOfCompletion: 0 },
    { text: 'Tap to mark as done', isDone: false, timeOfCompletion: 0 },
    { text: 'Slide right slowly to delete', isDone: false, timeOfCompletion: 0 },
]

export default function App() {
    const {
        dataList,
        setDataList,
        autobaseInviteKey,
        peerCount,
        isJoining,
        setIsJoining,
        isJoiningRef,
        sendRPC,
    } = useWorklet()

    const [joinDialogVisible, setJoinDialogVisible] = useState(false)
    const [joinKeyInput, setJoinKeyInput] = useState('')
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
    }, [autobaseInviteKey, blinkAnim])

    // Rotate P2P messages while joining
    useEffect(() => {
        if (!isJoining) return
        const interval = setInterval(() => {
            setCurrentP2PMessage((prev) => (prev + 1) % P2P_MESSAGES.length)
        }, 3000)
        return () => clearInterval(interval)
    }, [isJoining])

    const handleToggleDone = useCallback((index: number) => {
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

            newList.splice(index, 1)
            if (updatedItem.isDone) {
                newList.push(updatedItem)
            } else {
                newList.unshift(updatedItem)
            }

            sendRPC(RPC_UPDATE, JSON.stringify({ item: updatedItem }))
            return newList
        })
    }, [sendRPC, setDataList])

    const handleDelete = useCallback((index: number) => {
        const deletedItem = dataList[index]
        setDataList((prevList) => prevList.filter((_, i) => i !== index))
        sendRPC(RPC_DELETE, JSON.stringify({ item: deletedItem }))
    }, [dataList, sendRPC, setDataList])

    const handleInsert = useCallback((_index: number, text: string) => {
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
    }, [dataList, sendRPC])

    const handleShare = useCallback(async () => {
        if (!autobaseInviteKey) {
            Alert.alert('Connection in progress', 'Invite key is not available yet. Please wait a moment and try again.')
            return
        }

        try {
            await Share.share({
                message: autobaseInviteKey,
                title: 'Share Invite Key'
            })
        } catch (error) {
            console.error('Error sharing:', error)
        }
    }, [autobaseInviteKey])

    const handleJoin = useCallback(() => {
        setJoinDialogVisible(true)
    }, [])

    const handleJoinSubmit = useCallback(() => {
        if (!joinKeyInput.trim()) {
            Alert.alert('Error', 'Please enter an invite key')
            return
        }

        setIsJoining(true)
        setCurrentP2PMessage(0)
        isJoiningRef.current = true

        sendRPC(RPC_JOIN_KEY, JSON.stringify({ key: joinKeyInput }))

        setJoinDialogVisible(false)
        setJoinKeyInput('')
    }, [joinKeyInput, sendRPC, setIsJoining, isJoiningRef])

    const handleJoinCancel = useCallback(() => {
        setJoinDialogVisible(false)
        setJoinKeyInput('')
    }, [])

    const handleJoiningCancel = useCallback(() => {
        setIsJoining(false)
        isJoiningRef.current = false
    }, [setIsJoining, isJoiningRef])

    const handleDeleteAll = useCallback(() => {
        Alert.alert(
            'Delete All Items',
            'Are you sure you want to delete all items? This cannot be undone.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete All',
                    style: 'destructive',
                    onPress: () => {
                        dataList.forEach((item) => {
                            sendRPC(RPC_DELETE, JSON.stringify({ item }))
                        })
                        setDataList([])
                    },
                },
            ]
        )
    }, [dataList, sendRPC, setDataList])

    return (
        <SafeAreaProvider>
            <View style={styles.container}>
                <Header
                    autobaseInviteKey={autobaseInviteKey}
                    peerCount={peerCount}
                    blinkAnim={blinkAnim}
                    onDeleteAll={handleDeleteAll}
                    onShare={handleShare}
                    onJoin={handleJoin}
                />
                <JoinDialog
                    visible={joinDialogVisible}
                    joinKeyInput={joinKeyInput}
                    setJoinKeyInput={setJoinKeyInput}
                    onSubmit={handleJoinSubmit}
                    onCancel={handleJoinCancel}
                />
                <JoiningOverlay
                    visible={isJoining}
                    currentMessageIndex={currentP2PMessage}
                    onCancel={handleJoiningCancel}
                />
                <InertialElasticList
                    data={dataList.length === 0 ? DEFAULT_INSTRUCTIONS : dataList}
                    onToggleDone={dataList.length === 0 ? () => {} : handleToggleDone}
                    onDelete={dataList.length === 0 ? () => {} : handleDelete}
                    onInsert={handleInsert}
                />
            </View>
        </SafeAreaProvider>
    )
}

export type { ListEntry }
