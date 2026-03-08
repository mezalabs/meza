package subjects

import "fmt"

// Delivery subjects — gateway subscribes, services publish.

func DeliverChannel(channelID string) string {
	return fmt.Sprintf("meza.deliver.channel.%s", channelID)
}

func DeliverChannelWildcard() string {
	return "meza.deliver.channel.>"
}

// Presence subjects.

func PresenceHeartbeat(userID string) string {
	return fmt.Sprintf("meza.presence.heartbeat.%s", userID)
}

func PresenceHeartbeatWildcard() string {
	return "meza.presence.heartbeat.>"
}

func PresenceUpdate(userID string) string {
	return fmt.Sprintf("meza.presence.update.%s", userID)
}

func PresenceUpdateWildcard() string {
	return "meza.presence.update.>"
}

// Server event subjects.

func ServerMember(serverID string) string {
	return fmt.Sprintf("meza.server.member.%s", serverID)
}

func ServerChannel(serverID string) string {
	return fmt.Sprintf("meza.server.channel.%s", serverID)
}

func ServerChannelWildcard() string {
	return "meza.server.channel.>"
}

// ServerChannelEvent privacy prefix.
// A 1-byte prefix on ServerChannel NATS messages avoids full protobuf
// deserialization in the gateway just to check the is_private flag.
// 0x00 = public channel event, 0x01 = private channel event with channelID.

// EncodeServerChannelEvent prepends a privacy hint byte to the event data.
// If privateChannelID is non-empty, the message is marked private and the
// channel ID (as a length-prefixed string) follows the hint byte.
func EncodeServerChannelEvent(data []byte, privateChannelID string) []byte {
	if privateChannelID == "" {
		// Public: 0x00 + original data
		result := make([]byte, 1+len(data))
		result[0] = 0x00
		copy(result[1:], data)
		return result
	}
	// Private: 0x01 + 1-byte channelID length + channelID + original data
	chIDBytes := []byte(privateChannelID)
	result := make([]byte, 1+1+len(chIDBytes)+len(data))
	result[0] = 0x01
	result[1] = byte(len(chIDBytes))
	copy(result[2:2+len(chIDBytes)], chIDBytes)
	copy(result[2+len(chIDBytes):], data)
	return result
}

// DecodeServerChannelEvent reads the privacy hint byte and returns the
// original event data and the private channel ID (empty if public).
func DecodeServerChannelEvent(raw []byte) (data []byte, privateChannelID string, err error) {
	if len(raw) < 1 {
		return nil, "", fmt.Errorf("empty server channel event payload")
	}
	if raw[0] == 0x00 {
		return raw[1:], "", nil
	}
	if raw[0] == 0x01 && len(raw) >= 2 {
		chIDLen := int(raw[1])
		if len(raw) >= 2+chIDLen {
			privateChannelID = string(raw[2 : 2+chIDLen])
			return raw[2+chIDLen:], privateChannelID, nil
		}
	}
	return nil, "", fmt.Errorf("unrecognized server channel event prefix: 0x%02x", raw[0])
}

func ServerMemberWildcard() string {
	return "meza.server.member.>"
}

func ServerRole(serverID string) string {
	return fmt.Sprintf("meza.server.role.%s", serverID)
}

func ServerRoleWildcard() string {
	return "meza.server.role.>"
}

func ServerEmoji(serverID string) string {
	return fmt.Sprintf("meza.server.emoji.%s", serverID)
}

func ServerEmojiWildcard() string {
	return "meza.server.emoji.>"
}

func ServerSoundboard(serverID string) string {
	return fmt.Sprintf("meza.server.soundboard.%s", serverID)
}

func ServerSoundboardWildcard() string {
	return "meza.server.soundboard.>"
}

func ServerChannelGroup(serverID string) string {
	return fmt.Sprintf("meza.server.channelgroup.%s", serverID)
}

func ServerChannelGroupWildcard() string {
	return "meza.server.channelgroup.>"
}

// User read state subjects — gateway delivers to user's own clients only.

func UserReadState(userID string) string {
	return fmt.Sprintf("meza.user.readstate.%s", userID)
}

func UserReadStateWildcard() string {
	return "meza.user.readstate.>"
}

// User subscription subjects — dual-purpose per-user channel:
//   - nil/empty payload: refresh signal — gateway debounces and re-queries
//     the user's channels/servers from the DB to update routing tables.
//   - non-empty payload: contains a serialized Event proto to forward directly
//     to the user's WebSocket clients (used for block/friend/DM events).

func UserSubscription(userID string) string {
	return fmt.Sprintf("meza.user.subscription.%s", userID)
}

// User recovery subjects — auth service publishes, notification service subscribes.
// Separate from UserSubscription because the notification service does NOT subscribe
// to UserSubscription — it subscribes to DeliverChannel/DeviceConnected/DeviceDisconnected.

func UserRecovery(userID string) string {
	return fmt.Sprintf("meza.user.recovery.%s", userID)
}

func UserRecoveryWildcard() string {
	return "meza.user.recovery.>"
}

// Device connectivity subjects — notification service subscribes,
// gateway publishes on WebSocket connect/disconnect.

func DeviceConnected(userID string) string {
	return fmt.Sprintf("meza.device.connected.%s", userID)
}

func DeviceDisconnected(userID string) string {
	return fmt.Sprintf("meza.device.disconnected.%s", userID)
}

func DeviceConnectedWildcard() string {
	return "meza.device.connected.>"
}

func DeviceDisconnectedWildcard() string {
	return "meza.device.disconnected.>"
}

// Embed fetch subject — embed worker subscribes, chat service publishes.

func EmbedFetch() string {
	return "meza.embed.fetch"
}
