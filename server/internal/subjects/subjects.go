package subjects

import (
	"fmt"
	"strings"
)

// idSanitizer replaces NATS metacharacters (., *, >) and spaces with
// underscores. Hoisted to package level so the Replacer is allocated once
// instead of on every call to sanitizeID (hot path on every NATS publish).
var idSanitizer = strings.NewReplacer(".", "_", "*", "_", ">", "_", " ", "_")

// sanitizeID replaces NATS metacharacters (., *, >) in IDs to prevent
// subject injection. ULIDs should never contain these, but this is defense-in-depth.
func sanitizeID(id string) string {
	return idSanitizer.Replace(id)
}

// Delivery subjects — gateway subscribes, services publish.

func DeliverChannel(channelID string) string {
	return fmt.Sprintf("meza.deliver.channel.%s", sanitizeID(channelID))
}

func DeliverChannelWildcard() string {
	return "meza.deliver.channel.>"
}

// Presence subjects.

func PresenceHeartbeat(userID string) string {
	return fmt.Sprintf("meza.presence.heartbeat.%s", sanitizeID(userID))
}

func PresenceHeartbeatWildcard() string {
	return "meza.presence.heartbeat.>"
}

func PresenceUpdate(userID string) string {
	return fmt.Sprintf("meza.presence.update.%s", sanitizeID(userID))
}

func PresenceUpdateWildcard() string {
	return "meza.presence.update.>"
}

// Server event subjects.

func ServerMember(serverID string) string {
	return fmt.Sprintf("meza.server.member.%s", sanitizeID(serverID))
}

func ServerChannel(serverID string) string {
	return fmt.Sprintf("meza.server.channel.%s", sanitizeID(serverID))
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

// Server metadata update subjects — broadcast when server name/icon/settings change.

func ServerMeta(serverID string) string {
	return fmt.Sprintf("meza.server.meta.%s", sanitizeID(serverID))
}

func ServerMetaWildcard() string {
	return "meza.server.meta.>"
}

func ServerRole(serverID string) string {
	return fmt.Sprintf("meza.server.role.%s", sanitizeID(serverID))
}

func ServerRoleWildcard() string {
	return "meza.server.role.>"
}

func ServerEmoji(serverID string) string {
	return fmt.Sprintf("meza.server.emoji.%s", sanitizeID(serverID))
}

func ServerEmojiWildcard() string {
	return "meza.server.emoji.>"
}

func ServerSoundboard(serverID string) string {
	return fmt.Sprintf("meza.server.soundboard.%s", sanitizeID(serverID))
}

func ServerSoundboardWildcard() string {
	return "meza.server.soundboard.>"
}

func ServerChannelGroup(serverID string) string {
	return fmt.Sprintf("meza.server.channelgroup.%s", sanitizeID(serverID))
}

func ServerChannelGroupWildcard() string {
	return "meza.server.channelgroup.>"
}

// User profile update subjects — gateway fans out to shared-server members.

func UserUpdate(userID string) string {
	return fmt.Sprintf("meza.user.update.%s", sanitizeID(userID))
}

func UserUpdateWildcard() string {
	return "meza.user.update.>"
}

// User read state subjects — gateway delivers to user's own clients only.

func UserReadState(userID string) string {
	return fmt.Sprintf("meza.user.readstate.%s", sanitizeID(userID))
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
	return fmt.Sprintf("meza.user.subscription.%s", sanitizeID(userID))
}

// User recovery subjects — auth service publishes, notification service subscribes.
// Separate from UserSubscription because the notification service does NOT subscribe
// to UserSubscription — it subscribes to DeliverChannel/DeviceConnected/DeviceDisconnected.

func UserRecovery(userID string) string {
	return fmt.Sprintf("meza.user.recovery.%s", sanitizeID(userID))
}

func UserRecoveryWildcard() string {
	return "meza.user.recovery.>"
}

// Device connectivity subjects — notification service subscribes,
// gateway publishes on WebSocket connect/disconnect.

func DeviceConnected(userID string) string {
	return fmt.Sprintf("meza.device.connected.%s", sanitizeID(userID))
}

func DeviceDisconnected(userID string) string {
	return fmt.Sprintf("meza.device.disconnected.%s", sanitizeID(userID))
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

// Internal key rotation subject — keys service publishes, chat service subscribes.

func InternalKeyRotation() string {
	return "meza.internal.keyrotation"
}

// Internal webhook reload subject — chat service publishes, webhook service subscribes.

func InternalWebhookReload() string {
	return "meza.internal.webhook.reload"
}
