package main

import (
	"context"
	"errors"
	"fmt"

	"firebase.google.com/go/v4/messaging"
)

// probeFCMAuth sends a deliberately-invalid registration token and inspects
// the response to confirm the SDK's auth layer is working. A reachable FCM
// will reject the token with INVALID_ARGUMENT or UNREGISTERED — both prove
// the bearer token was attached. Any other outcome (no error, missing-credential
// errors, 401s) means the SDK is sending unauthenticated and we must not start.
func probeFCMAuth(ctx context.Context, client *messaging.Client) error {
	_, err := client.Send(ctx, &messaging.Message{
		Token: "STARTUP_PROBE_INVALID",
		Notification: &messaging.Notification{
			Title: "probe",
			Body:  "probe",
		},
	})
	return classifyProbeResult(err, messaging.IsInvalidArgument, messaging.IsRegistrationTokenNotRegistered)
}

// classifyProbeResult returns nil if err indicates the auth layer worked
// (i.e. one of authOK matchers returned true), otherwise an error describing
// why the probe failed. A nil err is itself a failure: FCM should never accept
// the bogus token.
func classifyProbeResult(err error, authOK ...func(error) bool) error {
	if err == nil {
		return errors.New("FCM accepted bogus probe token; expected an error")
	}
	for _, ok := range authOK {
		if ok(err) {
			return nil
		}
	}
	return fmt.Errorf("FCM probe auth failed: %w", err)
}
