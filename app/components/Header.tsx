import React from 'react'
import { View, Text, Animated } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { AnimatedIconButton } from './AnimatedIconButton'
import { headerStyles } from './_styles'

type HeaderProps = {
    autobaseInviteKey: string
    peerCount: number
    blinkAnim: Animated.Value
    onDeleteAll: () => void
    onShare: () => void
    onJoin: () => void
}

export function Header({
    autobaseInviteKey,
    peerCount,
    blinkAnim,
    onDeleteAll,
    onShare,
    onJoin,
}: HeaderProps) {
    const peerCountLabel = peerCount > 99 ? '99+' : String(peerCount)

    return (
        <SafeAreaView style={headerStyles.safeArea} edges={['top']}>
            <View style={headerStyles.container}>
                <View style={headerStyles.leftSection}>
                    <AnimatedIconButton
                        style={headerStyles.iconButton}
                        onPress={onDeleteAll}
                    >
                        <Ionicons name="trash-outline" size={24} color="#333" />
                    </AnimatedIconButton>
                </View>

                <View style={headerStyles.rightSection}>
                    <View style={headerStyles.iconWithBadge}>
                        <AnimatedIconButton
                            style={headerStyles.iconButton}
                            onPress={onShare}
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
                        onPress={onJoin}
                    >
                        <Ionicons name="person-add-outline" size={24} color="#333" />
                    </AnimatedIconButton>
                </View>
            </View>
        </SafeAreaView>
    )
}
