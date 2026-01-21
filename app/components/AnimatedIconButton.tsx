import React, { useRef } from 'react'
import { TouchableOpacity, Animated } from 'react-native'

type AnimatedIconButtonProps = {
    onPress: () => void
    children: React.ReactNode
    style?: any
}

export function AnimatedIconButton({ onPress, children, style }: AnimatedIconButtonProps) {
    const scaleAnim = useRef(new Animated.Value(1)).current

    const handlePressIn = () => {
        Animated.spring(scaleAnim, {
            toValue: 0.85,
            useNativeDriver: true,
            speed: 50,
            bounciness: 4,
        }).start()
    }

    const handlePressOut = () => {
        Animated.spring(scaleAnim, {
            toValue: 1,
            useNativeDriver: true,
            speed: 20,
            bounciness: 10,
        }).start()
    }

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
    )
}
