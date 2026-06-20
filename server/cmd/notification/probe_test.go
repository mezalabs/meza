package main

import (
	"errors"
	"strings"
	"testing"
)

func TestClassifyProbeResult(t *testing.T) {
	var (
		errInvalidArgument = errors.New("INVALID_ARGUMENT: bogus token")
		errUnregistered    = errors.New("UNREGISTERED: token not registered")
		errMissingAuth     = errors.New("Request is missing required authentication credential")
		errUnauthenticated = errors.New("UNAUTHENTICATED: 401")
		errOther           = errors.New("network broken")
	)

	// Stand-ins for messaging.IsInvalidArgument / IsRegistrationTokenNotRegistered.
	// Each returns true only for its own sentinel.
	isInvalidArg := func(e error) bool { return errors.Is(e, errInvalidArgument) }
	isUnreg := func(e error) bool { return errors.Is(e, errUnregistered) }

	cases := []struct {
		name        string
		err         error
		wantOK      bool   // expect classifyProbeResult to return nil
		wantWrapped string // if !wantOK, the returned error must wrap or mention this
	}{
		{
			name:        "nil err is failure (FCM should never accept bogus token)",
			err:         nil,
			wantOK:      false,
			wantWrapped: "FCM accepted bogus probe token",
		},
		{
			name:   "INVALID_ARGUMENT means auth worked",
			err:    errInvalidArgument,
			wantOK: true,
		},
		{
			name:   "UNREGISTERED means auth worked",
			err:    errUnregistered,
			wantOK: true,
		},
		{
			name:        "missing auth credential is failure",
			err:         errMissingAuth,
			wantOK:      false,
			wantWrapped: "missing required authentication credential",
		},
		{
			name:        "UNAUTHENTICATED is failure",
			err:         errUnauthenticated,
			wantOK:      false,
			wantWrapped: "UNAUTHENTICATED",
		},
		{
			name:        "unrelated error is failure",
			err:         errOther,
			wantOK:      false,
			wantWrapped: "network broken",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyProbeResult(tc.err, isInvalidArg, isUnreg)
			if tc.wantOK {
				if got != nil {
					t.Fatalf("expected nil, got %v", got)
				}
				return
			}
			if got == nil {
				t.Fatalf("expected error, got nil")
			}
			if !strings.Contains(got.Error(), tc.wantWrapped) {
				t.Errorf("error %q does not contain %q", got.Error(), tc.wantWrapped)
			}
			if tc.err != nil && !errors.Is(got, tc.err) {
				t.Errorf("returned error does not wrap underlying err %v", tc.err)
			}
		})
	}
}
