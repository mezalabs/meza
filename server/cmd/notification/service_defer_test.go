package main

import (
	"context"
	"errors"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/mezalabs/meza/internal/config"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/store"
)

// countingUserStore is a userResolver that records how many times the sender
// name was looked up, so tests can assert the lookup is deferred.
type countingUserStore struct {
	user  *models.User
	err   error
	calls int
}

func (s *countingUserStore) GetUserDisplayName(_ context.Context, _ string) (string, string, error) {
	s.calls++
	if s.err != nil {
		return "", "", s.err
	}
	if s.user == nil {
		return "", "", nil
	}
	return s.user.DisplayName, s.user.Username, nil
}

// fakeChatStore embeds the full ChatStorer interface (so it satisfies the type)
// but only implements GetServer — the single method the server-channel push
// path touches. Any other call panics, which is the desired signal in a test.
type fakeChatStore struct {
	store.ChatStorer
	server         *models.Server
	err            error
	getServerCalls int
}

func (f *fakeChatStore) GetServer(_ context.Context, _ string) (*models.Server, error) {
	f.getServerCalls++
	if f.err != nil {
		return nil, f.err
	}
	return f.server, nil
}

type fakeDeviceStore struct {
	store.DeviceStorer
	devices map[string][]*models.Device
}

func (f *fakeDeviceStore) GetPushEnabledDevicesForUsers(_ context.Context, _ []string) (map[string][]*models.Device, error) {
	return f.devices, nil
}

func (f *fakeDeviceStore) GetPushEnabledDevices(_ context.Context, userID string) ([]*models.Device, error) {
	return f.devices[userID], nil
}

type fakePrefStore struct {
	store.NotificationPreferenceStorer
	levels map[string]string
}

func (f *fakePrefStore) GetEffectiveLevelsForUsers(_ context.Context, _ []string, _, _ string) (map[string]string, error) {
	return f.levels, nil
}

// newDeferTestService wires a notificationService against miniredis and the
// fake stores above. cfg is empty so sendWebPush short-circuits (no VAPID key),
// letting the dispatch flow complete without a real push transport.
func newDeferTestService(t *testing.T, us userResolver, cs store.ChatStorer, ds store.DeviceStorer, ps store.NotificationPreferenceStorer) (*notificationService, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	s := &notificationService{
		deviceStore: ds,
		prefStore:   ps,
		chatStore:   cs,
		userStore:   us,
		rdb:         rdb,
		cfg:         &config.Config{},
	}
	return s, mr
}

// TestProcessServerNotifications_DefersNameLookups is the core regression guard
// for the perf fix: sender/server name lookups must not run when every
// recipient is online (no push is sent), and must run exactly once when an
// offline recipient exists.
func TestProcessServerNotifications_DefersNameLookups(t *testing.T) {
	const userID = "u1"
	device := &models.Device{ID: "d1", UserID: userID, Platform: "web", PushEndpoint: "https://push.example/x"}
	base := pushTrigger{
		Kind:        "message",
		ChannelID:   "c1",
		SenderID:    "u_sender",
		ServerID:    "s1",
		ChannelName: "general",
	}

	t.Run("all recipients online: no name lookups", func(t *testing.T) {
		us := &countingUserStore{user: &models.User{DisplayName: "Bob"}}
		cs := &fakeChatStore{server: &models.Server{Name: "Meza Devs"}}
		s, mr := newDeferTestService(t, us, cs,
			&fakeDeviceStore{devices: map[string][]*models.Device{userID: {device}}},
			&fakePrefStore{levels: map[string]string{userID: "all"}},
		)
		// Mark the device connected so it is filtered out as online.
		mr.SetAdd(connectedDevicesPrefix+userID, device.ID)

		s.processServerNotifications(context.Background(), []string{userID}, map[string]struct{}{}, false, base)

		if us.calls != 0 {
			t.Errorf("sender lookup ran %d times for an all-online channel, want 0", us.calls)
		}
		if cs.getServerCalls != 0 {
			t.Errorf("GetServer ran %d times for an all-online channel, want 0", cs.getServerCalls)
		}
	})

	t.Run("offline recipient: names resolved exactly once", func(t *testing.T) {
		us := &countingUserStore{user: &models.User{DisplayName: "Bob"}}
		cs := &fakeChatStore{server: &models.Server{Name: "Meza Devs"}}
		s, _ := newDeferTestService(t, us, cs,
			&fakeDeviceStore{devices: map[string][]*models.Device{userID: {device}}},
			&fakePrefStore{levels: map[string]string{userID: "all"}},
		)
		// Device is NOT in the connected set, so it counts as offline.

		s.processServerNotifications(context.Background(), []string{userID}, map[string]struct{}{}, false, base)

		if us.calls != 1 {
			t.Errorf("sender lookup ran %d times for one offline recipient, want 1", us.calls)
		}
		if cs.getServerCalls != 1 {
			t.Errorf("GetServer ran %d times for one offline recipient, want 1", cs.getServerCalls)
		}
	})
}

// TestNotifyOfflineDevices_FanOutAndThrottle guards the DM push delivery fix:
// a single notification must reach every offline device (not just the first),
// while still debouncing repeat messages and skipping online devices. The
// device order here mirrors the production bug — an old web subscription sorts
// ahead of the user's phone, 2xx's silently against a closed browser, and under
// the previous per-device throttle break starved the iOS device of any push.
func TestNotifyOfflineDevices_FanOutAndThrottle(t *testing.T) {
	const userID = "u_dm"
	newDevices := func() []*models.Device {
		return []*models.Device{
			{ID: "d_web", UserID: userID, Platform: "web", PushEndpoint: "https://push.example/x"},
			{ID: "d_ios", UserID: userID, Platform: "ios", PushToken: "tok"},
		}
	}
	trigger := pushTrigger{Kind: "dm", ChannelID: "c_dm"}

	record := func(s *notificationService, got *[]string) {
		s.pushSender = func(_ context.Context, d *models.Device, _ pushTrigger) error {
			*got = append(*got, d.ID)
			return nil
		}
	}

	t.Run("fans out to every offline device, not just the first", func(t *testing.T) {
		ds := &fakeDeviceStore{devices: map[string][]*models.Device{userID: newDevices()}}
		s, _ := newDeferTestService(t, nil, nil, ds, nil)
		var got []string
		record(s, &got)

		s.notifyOfflineDevices(context.Background(), userID, trigger)

		if len(got) != 2 || got[0] != "d_web" || got[1] != "d_ios" {
			t.Fatalf("dispatched to %v, want [d_web d_ios]; a dormant first device must not starve the rest", got)
		}
	})

	t.Run("debounces repeat messages for the same conversation", func(t *testing.T) {
		ds := &fakeDeviceStore{devices: map[string][]*models.Device{userID: newDevices()}}
		s, _ := newDeferTestService(t, nil, nil, ds, nil)
		var got []string
		record(s, &got)

		s.notifyOfflineDevices(context.Background(), userID, trigger)
		got = nil
		s.notifyOfflineDevices(context.Background(), userID, trigger)

		if len(got) != 0 {
			t.Fatalf("second call within the throttle window dispatched to %v, want none", got)
		}
	})

	t.Run("skips devices connected over websocket", func(t *testing.T) {
		ds := &fakeDeviceStore{devices: map[string][]*models.Device{userID: newDevices()}}
		s, mr := newDeferTestService(t, nil, nil, ds, nil)
		mr.SetAdd(connectedDevicesPrefix+userID, "d_web") // web is online
		var got []string
		record(s, &got)

		s.notifyOfflineDevices(context.Background(), userID, trigger)

		if len(got) != 1 || got[0] != "d_ios" {
			t.Fatalf("dispatched to %v, want only [d_ios] (web is online)", got)
		}
	})
}

// TestResolveChannelEventContext covers name composition and graceful
// degradation of the deferred resolver.
func TestResolveChannelEventContext(t *testing.T) {
	t.Run("both resolve", func(t *testing.T) {
		s, _ := newDeferTestService(t,
			&countingUserStore{user: &models.User{DisplayName: "Bob"}},
			&fakeChatStore{server: &models.Server{Name: "Meza Devs"}}, nil, nil)
		sender, server := s.resolveChannelEventContext(context.Background(), "u_sender", "s1")
		if sender != "Bob" || server != "Meza Devs" {
			t.Errorf("got (%q, %q), want (Bob, Meza Devs)", sender, server)
		}
	})

	t.Run("server lookup failure degrades to empty server name", func(t *testing.T) {
		s, _ := newDeferTestService(t,
			&countingUserStore{user: &models.User{DisplayName: "Bob"}},
			&fakeChatStore{err: errors.New("db down")}, nil, nil)
		sender, server := s.resolveChannelEventContext(context.Background(), "u_sender", "s1")
		if sender != "Bob" || server != "" {
			t.Errorf("got (%q, %q), want (Bob, \"\")", sender, server)
		}
	})

	t.Run("empty serverID skips server lookup", func(t *testing.T) {
		cs := &fakeChatStore{server: &models.Server{Name: "Meza Devs"}}
		s, _ := newDeferTestService(t,
			&countingUserStore{user: &models.User{DisplayName: "Bob"}}, cs, nil, nil)
		sender, server := s.resolveChannelEventContext(context.Background(), "u_sender", "")
		if sender != "Bob" || server != "" {
			t.Errorf("got (%q, %q), want (Bob, \"\")", sender, server)
		}
		if cs.getServerCalls != 0 {
			t.Errorf("GetServer ran %d times for empty serverID, want 0", cs.getServerCalls)
		}
	})
}
