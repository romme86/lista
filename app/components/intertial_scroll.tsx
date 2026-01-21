import React, { useRef, useState, useCallback } from 'react'
import {
    Animated,
    Dimensions,
    StyleSheet,
    FlatListProps,
    TouchableOpacity,
    TextInput,
    View,
} from 'react-native'
import type { ListEntry } from './_types'
import { ListItem, ITEM_HEIGHT, SPACING } from './ListItem'

const { height: SCREEN_HEIGHT } = Dimensions.get('window')
const TOTAL_ITEM_HEIGHT = ITEM_HEIGHT + SPACING

const getItemKey = (item: ListEntry, index: number): string => {
    return `${item.text}-${item.timeOfCompletion}-${index}`
}

type Props = {
    data: ListEntry[]
    onToggleDone?: (index: number) => void
    onDelete?: (index: number) => void
    onUpdate?: (index: number, text: string) => void
    onInsert?: (index: number, text: string) => void
}

export default function InertialElasticList({
    data,
    onToggleDone,
    onDelete,
    onInsert,
}: Props) {
    const scrollY = useRef(new Animated.Value(0)).current
    const [isAddingItem, setIsAddingItem] = useState(false)
    const [editText, setEditText] = useState('')
    const listLastTap = useRef<number>(0)
    const isSubmittingRef = useRef(false)

    const handleListDoubleTap = useCallback(() => {
        setIsAddingItem(true)
        setEditText('')
    }, [])

    const handleListPress = useCallback(() => {
        const now = Date.now()
        const DOUBLE_TAP_DELAY = 300

        if (listLastTap.current && now - listLastTap.current < DOUBLE_TAP_DELAY) {
            handleListDoubleTap()
            listLastTap.current = 0
        } else {
            listLastTap.current = now
        }
    }, [handleListDoubleTap])

    const handleStartEdit = useCallback(() => {
        setIsAddingItem(true)
        setEditText('')
    }, [])

    const handleSubmitEdit = useCallback(() => {
        if (editText.trim()) {
            isSubmittingRef.current = true
            if (onInsert) {
                onInsert(0, editText)
            }
            setIsAddingItem(false)
            setEditText('')
            setTimeout(() => {
                isSubmittingRef.current = false
            }, 100)
        }
    }, [editText, onInsert])

    const handleCancelEdit = useCallback(() => {
        if (isSubmittingRef.current) return
        setIsAddingItem(false)
        setEditText('')
    }, [])

    const renderItem: FlatListProps<ListEntry>['renderItem'] = useCallback(({ item, index }: { item: ListEntry; index: number }) => {
        return (
            <ListItem
                item={item}
                index={index}
                scrollY={scrollY}
                totalItemHeight={TOTAL_ITEM_HEIGHT}
                onToggleDone={onToggleDone}
                onDelete={onDelete}
                onInsert={onInsert}
                isEditing={false}
                editText=""
                setEditText={() => {}}
                onStartEdit={handleStartEdit}
                onSubmitEdit={handleSubmitEdit}
                onCancelEdit={handleCancelEdit}
            />
        )
    }, [scrollY, onToggleDone, onDelete, onInsert, handleStartEdit, handleSubmitEdit, handleCancelEdit])

    const keyExtractor = useCallback((item: ListEntry, index: number) => {
        return getItemKey(item, index)
    }, [])

    return (
        <View style={styles.container}>
            {isAddingItem && (
                <View style={styles.topInputContainer}>
                    <TextInput
                        style={styles.topInput}
                        value={editText}
                        onChangeText={setEditText}
                        onSubmitEditing={handleSubmitEdit}
                        onBlur={handleCancelEdit}
                        placeholder="Enter new item..."
                        placeholderTextColor="#888"
                        autoFocus
                    />
                </View>
            )}
            <TouchableOpacity
                style={styles.container}
                activeOpacity={1}
                onPress={handleListPress}
            >
                <Animated.FlatList
                    data={data}
                    keyExtractor={keyExtractor}
                    renderItem={renderItem}
                    showsVerticalScrollIndicator={false}
                    decelerationRate="fast"
                    bounces={true}
                    overScrollMode="always"
                    onScroll={Animated.event(
                        [{ nativeEvent: { contentOffset: { y: scrollY } } }],
                        { useNativeDriver: true }
                    )}
                    scrollEventThrottle={16}
                    contentContainerStyle={{
                        paddingVertical: SCREEN_HEIGHT / 3,
                    }}
                />
            </TouchableOpacity>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    topInputContainer: {
        paddingHorizontal: 20,
        paddingVertical: 16,
        backgroundColor: '#fff',
    },
    topInput: {
        fontSize: 16,
        color: '#222',
        fontWeight: '600',
    },
})
