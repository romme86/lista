import { StyleSheet } from 'react-native'

export const styles = StyleSheet.create({
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

export const headerStyles = StyleSheet.create({
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
    orangeBadge: {
        backgroundColor: '#ff9500',
        width: 10,
        height: 10,
        minWidth: 10,
    },
    pearBadge: {
        position: 'absolute',
        top: -2,
        right: 0,
        alignItems: 'center',
    },
    pearStalk: {
        width: 2,
        height: 5,
        backgroundColor: '#8B4513',
        borderRadius: 1,
        marginBottom: -1,
    },
    pearTop: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: '#34c759',
        marginBottom: -3,
        zIndex: 1,
    },
    pearBottom: {
        minWidth: 16,
        height: 16,
        borderRadius: 8,
        backgroundColor: '#34c759',
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 4,
    },
    pearBadgeText: {
        color: '#fff',
        fontSize: 9,
        fontWeight: '700',
    },
})

export const dialogStyles = StyleSheet.create({
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
})

export const joiningStyles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(255, 255, 255, 0.95)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 40,
    },
    content: {
        alignItems: 'center',
        maxWidth: 300,
    },
    title: {
        fontSize: 20,
        fontWeight: '600',
        color: '#333',
        marginTop: 24,
        marginBottom: 12,
        textAlign: 'center',
    },
    subtitle: {
        fontSize: 14,
        color: '#666',
        textAlign: 'center',
        marginBottom: 32,
        lineHeight: 20,
    },
    p2pMessage: {
        fontSize: 14,
        color: '#888',
        textAlign: 'center',
        fontStyle: 'italic',
        minHeight: 40,
    },
    cancelButton: {
        marginTop: 32,
        paddingVertical: 12,
        paddingHorizontal: 32,
        borderRadius: 8,
        backgroundColor: '#f0f0f0',
    },
    cancelButtonText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#666',
    },
})
