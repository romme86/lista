import { useEffect, useRef, useState, useCallback } from 'react'
import { Alert } from 'react-native'
import * as FileSystemExpo from 'expo-file-system'
import { toByteArray } from 'base64-js'
import { Worklet } from 'react-native-bare-kit'
import RPC from 'bare-rpc'
import b4a from 'b4a'
import backendBundleB64 from '../app.ios.bundle.mjs'
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
} from '../../rpc-commands.mjs'
import type { ListEntry } from '@/app/components/_types'

// Module-level singleton - persists across component remounts
let workletSingleton: Worklet | null = null
let workletStarted = false

type UseWorkletResult = {
    dataList: ListEntry[]
    setDataList: React.Dispatch<React.SetStateAction<ListEntry[]>>
    autobaseInviteKey: string
    peerCount: number
    isWorkletReady: boolean
    isJoining: boolean
    setIsJoining: React.Dispatch<React.SetStateAction<boolean>>
    isJoiningRef: React.MutableRefObject<boolean>
    sendRPC: (command: number, payload?: string) => void
}

export function useWorklet(): UseWorkletResult {
    const [dataList, setDataList] = useState<ListEntry[]>([])
    const [isWorkletReady, setIsWorkletReady] = useState(false)
    const [autobaseInviteKey, setAutobaseInviteKey] = useState('')
    const [peerCount, setPeerCount] = useState(0)
    const [isJoining, setIsJoining] = useState(false)

    const rpcRef = useRef<any>(null)
    const workletRef = useRef<Worklet | null>(null)
    const isJoiningRef = useRef(false)

    const sendRPC = useCallback((command: number, payload?: string) => {
        if (!rpcRef.current) {
            console.warn('RPC not ready, ignoring command', command)
            return
        }
        const req = rpcRef.current.request(command)
        if (payload !== undefined) {
            req.send(payload)
        }
    }, [])

    const startWorklet = useCallback(() => {
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
                if (reqFromBackend.data) {
                    console.log('data from bare', b4a.toString(reqFromBackend.data))
                    const listToSync = JSON.parse(b4a.toString(reqFromBackend.data))
                    setDataList(listToSync)
                }
            }
            if (reqFromBackend.command === RPC_DELETE_FROM_BACKEND) {
                console.log('RPC_DELETE_FROM_BACKEND')
                if (reqFromBackend.data) {
                    console.log('data from bare', b4a.toString(reqFromBackend.data))
                    const itemToDelete = JSON.parse(b4a.toString(reqFromBackend.data))
                    setDataList((prevList) => prevList.filter((item) => item.text !== itemToDelete.text))
                }
            }
            if (reqFromBackend.command === RPC_UPDATE_FROM_BACKEND) {
                console.log('RPC_UPDATE_FROM_BACKEND')
                if (reqFromBackend.data) {
                    console.log('data from bare', b4a.toString(reqFromBackend.data))
                    const itemToUpdate = JSON.parse(b4a.toString(reqFromBackend.data))
                    setDataList((prevList) => {
                        return prevList.map((item) =>
                            item.text === itemToUpdate.text ? { ...item, isDone: itemToUpdate.isDone, timeOfCompletion: itemToUpdate.timeOfCompletion } : item
                        )
                    })
                }
            }
            if (reqFromBackend.command === RPC_ADD_FROM_BACKEND) {
                console.log('RPC_ADD_FROM_BACKEND')
                if (reqFromBackend.data) {
                    console.log('data from bare', b4a.toString(reqFromBackend.data))
                    const itemToAdd = JSON.parse(b4a.toString(reqFromBackend.data))
                    setDataList((prevList) => [itemToAdd, ...prevList])
                }
            }
            if (reqFromBackend.command === RPC_GET_KEY) {
                console.log('RPC_GET_KEY')
                if (reqFromBackend.data) {
                    console.log('data from bare', b4a.toString(reqFromBackend.data))
                    const data = b4a.toString(reqFromBackend.data)
                    setAutobaseInviteKey(data)
                } else {
                    console.log('data from bare is null, empty or undefined')
                }
            }
        })

        setIsWorkletReady(true)
    }, [])

    useEffect(() => {
        if (!workletStarted) {
            workletStarted = true
            startWorklet()
        } else if (workletSingleton) {
            workletRef.current = workletSingleton
            setIsWorkletReady(true)
        }

        return () => {
            workletRef.current = null
            rpcRef.current = null
        }
    }, [startWorklet])

    return {
        dataList,
        setDataList,
        autobaseInviteKey,
        peerCount,
        isWorkletReady,
        isJoining,
        setIsJoining,
        isJoiningRef,
        sendRPC,
    }
}

export { RPC_UPDATE, RPC_DELETE, RPC_ADD, RPC_JOIN_KEY }
