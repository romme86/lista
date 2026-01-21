import React, { useRef, useCallback, useMemo } from 'react'
import {
    Animated,
    Dimensions,
    TouchableOpacity,
    TextInput,
    PanResponder,
    View,
    StyleSheet,
} from 'react-native'
import type { ListEntry } from './_types'

const { width: SCREEN_WIDTH } = Dimensions.get('window')
const ITEM_HEIGHT = 60
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.2

type ListItemProps = {
    item: ListEntry
    index: number
    scrollY: Animated.Value
    totalItemHeight: number
    onToggleDone?: (index: number) => void
    onDelete?: (index: number) => void
    onInsert?: (index: number, text: string) => void
    isEditing: boolean
    editText: string
    setEditText: (text: string) => void
    onStartEdit: (index: number) => void
    onSubmitEdit: () => void
    onCancelEdit: () => void
}

export function ListItem({
    item,
    index,
    scrollY,
    totalItemHeight,
    onToggleDone,
    onDelete,
    isEditing,
    editText,
    setEditText,
    onStartEdit,
    onSubmitEdit,
    onCancelEdit,
}: ListItemProps) {
    const panX = useRef(new Animated.Value(0)).current
    const lastTapRef = useRef<number>(0)
    const isDeleting = useRef(false)

    React.useEffect(() => {
        panX.setValue(0)
        isDeleting.current = false
    }, [item.text, item.timeOfCompletion, panX])

    const handleSingleTap = useCallback(() => {
        if (onToggleDone) {
            onToggleDone(index)
        }
    }, [onToggleDone, index])

    const handleDoubleTap = useCallback(() => {
        onStartEdit(index)
    }, [onStartEdit, index])

    const handlePress = useCallback(() => {
        const now = Date.now()
        const DOUBLE_TAP_DELAY = 300

        if (lastTapRef.current && now - lastTapRef.current < DOUBLE_TAP_DELAY) {
            handleDoubleTap()
            lastTapRef.current = 0
        } else {
            lastTapRef.current = now
            setTimeout(() => {
                if (lastTapRef.current === now) {
                    handleSingleTap()
                }
            }, DOUBLE_TAP_DELAY)
        }
    }, [handleDoubleTap, handleSingleTap])

    const handleLongPress = useCallback(() => {
        if (onToggleDone) {
            onToggleDone(index)
        }
    }, [onToggleDone, index])

    const panResponder = useMemo(() => PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponderCapture: (_, gestureState) => {
            return Math.abs(gestureState.dx) > 5 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy)
        },
        onPanResponderGrant: () => {
            isDeleting.current = false
        },
        onPanResponderMove: (_, gestureState) => {
            if (gestureState.dx > 0 && !isDeleting.current) {
                panX.setValue(gestureState.dx)
            }
        },
        onPanResponderRelease: (_, gestureState) => {
            if (isDeleting.current) return

            if (gestureState.dx > SWIPE_THRESHOLD) {
                isDeleting.current = true
                Animated.timing(panX, {
                    toValue: SCREEN_WIDTH,
                    duration: 200,
                    useNativeDriver: true,
                }).start(() => {
                    if (onDelete) {
                        onDelete(index)
                    }
                })
            } else {
                Animated.spring(panX, {
                    toValue: 0,
                    useNativeDriver: true,
                    friction: 8,
                    tension: 100,
                }).start()
            }
        },
        onPanResponderTerminate: () => {
            if (!isDeleting.current) {
                Animated.spring(panX, {
                    toValue: 0,
                    useNativeDriver: true,
                    friction: 8,
                    tension: 100,
                }).start()
            }
        },
    }), [panX, onDelete, index])

    const inputRange = [
        (index - 2) * totalItemHeight,
        index * totalItemHeight,
        (index + 2) * totalItemHeight,
    ]

    const textScale = scrollY.interpolate({
        inputRange,
        outputRange: [1, 1.57, 1],
        extrapolate: 'clamp',
    })

    const opacity = scrollY.interpolate({
        inputRange,
        outputRange: [0.4, 1, 0.4],
        extrapolate: 'clamp',
    })

    const textStyle = [
        styles.text,
        item.isDone && styles.doneText,
        { transform: [{ scale: textScale }] }
    ]

    if (isEditing) {
        return (
            <Animated.View style={[styles.item, { opacity }]}>
                <TextInput
                    style={styles.editInput}
                    value={editText}
                    onChangeText={setEditText}
                    onSubmitEditing={onSubmitEdit}
                    onBlur={onCancelEdit}
                    placeholder="Enter new item..."
                    placeholderTextColor="#888"
                    autoFocus
                />
            </Animated.View>
        )
    }

    return (
        <View style={styles.itemWrapper}>
            <Animated.View
                style={[
                    styles.itemContainer,
                    { transform: [{ translateX: panX }] },
                ]}
                {...panResponder.panHandlers}
            >
                <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={handlePress}
                    onLongPress={handleLongPress}
                    delayLongPress={500}
                >
                    <Animated.View style={[styles.item, { opacity }]}>
                        <Animated.Text style={textStyle}>
                            {item.text}
                        </Animated.Text>
                    </Animated.View>
                </TouchableOpacity>
            </Animated.View>
        </View>
    )
}

const SPACING = 16

const styles = StyleSheet.create({
    itemWrapper: {
        overflow: 'hidden',
        marginBottom: SPACING,
    },
    itemContainer: {
        backgroundColor: '#fff',
        paddingLeft: 20,
    },
    item: {
        height: ITEM_HEIGHT,
        justifyContent: 'center',
        alignItems: 'flex-start',
        width: SCREEN_WIDTH - 40,
    },
    text: {
        fontSize: 14,
        color: '#222',
        fontWeight: '600',
        transformOrigin: 'left center',
    },
    doneText: {
        color: '#aaa',
        textDecorationLine: 'line-through',
    },
    editInput: {
        fontSize: 14,
        color: '#222',
        fontWeight: '600',
        width: '100%',
        padding: 0,
    },
})

export { ITEM_HEIGHT, SPACING }
