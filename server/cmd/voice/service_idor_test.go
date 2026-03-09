package main

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/testutil"
)

// TestJoinVoiceChannel_IDOR_NonMember verifies that a user who is NOT a member
// of the server cannot join a voice channel in that server. The handler uses
// GetChannelAndCheckMembership to enforce this.
func TestJoinVoiceChannel_IDOR_NonMember(t *testing.T) {
	client, cs, _, _ := setupVoiceTest(t)

	serverID := models.NewID()
	channelID := models.NewID()
	outsiderID := models.NewID()

	cs.addServer(&models.Server{ID: serverID, OwnerID: models.NewID()})
	cs.addChannel(&models.Channel{
		ID:       channelID,
		ServerID: serverID,
		Name:     "voice-chat",
		Type:     channelTypeVoice,
	})
	// outsiderID is NOT added as a member.

	_, err := client.JoinVoiceChannel(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.JoinVoiceChannelRequest{
		ChannelId: channelID,
	}))
	if err == nil {
		t.Fatal("expected error for non-member joining voice channel")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

// TestGetVoiceChannelState_IDOR_NonMember verifies that a user who is NOT a
// member of the server cannot view the voice channel state (participant list).
func TestGetVoiceChannelState_IDOR_NonMember(t *testing.T) {
	client, cs, _, _ := setupVoiceTest(t)

	serverID := models.NewID()
	channelID := models.NewID()
	outsiderID := models.NewID()

	cs.addServer(&models.Server{ID: serverID, OwnerID: models.NewID()})
	cs.addChannel(&models.Channel{
		ID:       channelID,
		ServerID: serverID,
		Name:     "voice-chat",
		Type:     channelTypeVoice,
	})
	// outsiderID is NOT added as a member.

	_, err := client.GetVoiceChannelState(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.GetVoiceChannelStateRequest{
		ChannelId: channelID,
	}))
	if err == nil {
		t.Fatal("expected error for non-member viewing voice channel state")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}
