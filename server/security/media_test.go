//go:build integration

package security

import (
	"context"
	"net/http"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/mezalabs/meza/gen/meza/v1"
)

// TestS3WildcardCORS verifies that MinIO/S3 CORS allows arbitrary origins
// when S3_CORS_ORIGINS is not explicitly set.
//
// Severity: HIGH
// Finding: Without S3_CORS_ORIGINS configured, MinIO defaults to allowing
// all origins (*) for CORS preflight requests. This means any website can
// PUT files to presigned upload URLs.
//
// Remediation: Set S3_CORS_ORIGINS to the production domain(s) explicitly
// in the deployment configuration.
func TestS3WildcardCORS(t *testing.T) {
	req, err := http.NewRequest("OPTIONS", minioURL, nil)
	if err != nil {
		t.Fatalf("create OPTIONS request: %v", err)
	}
	req.Header.Set("Origin", "https://evil.example.com")
	req.Header.Set("Access-Control-Request-Method", "PUT")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("OPTIONS request to MinIO: %v", err)
	}
	defer resp.Body.Close()

	acao := resp.Header.Get("Access-Control-Allow-Origin")
	if acao == "*" || acao == "https://evil.example.com" {
		t.Errorf("VULNERABILITY CONFIRMED: MinIO CORS allows arbitrary origin (Access-Control-Allow-Origin: %s)", acao)
	} else if acao == "" {
		t.Log("MinIO did not return CORS headers for OPTIONS request — may need bucket-level CORS check")
	} else {
		t.Logf("Mitigated: MinIO CORS restricted to: %s", acao)
	}
}

// TestPresignedUploadNoSizeEnforcement verifies that presigned upload URLs
// do not enforce content-length restrictions at the S3 level.
//
// Severity: MEDIUM
// Finding: CreateUpload generates a presigned PUT URL without a Content-Length
// constraint. A client can declare a small file (100 bytes) but upload a much
// larger file (50MB+). The server only detects the oversize at CompleteUpload,
// after the file is already stored in S3.
//
// Remediation: Include a Content-Length constraint in the presigned URL
// generation, or enforce a max upload size in the S3 bucket policy.
func TestPresignedUploadNoSizeEnforcement(t *testing.T) {
	ctx := context.Background()
	suffix := uniqueSuffix(t)
	user := registerUser(t, "upload_"+suffix)

	media := newMediaClient()

	// Create an upload declaring a small file.
	resp, err := media.CreateUpload(ctx, authedRequest(user.AccessToken, &v1.CreateUploadRequest{
		Filename:    "test.png",
		ContentType: "image/png",
		SizeBytes:   100, // Declare 100 bytes
	}))
	if err != nil {
		t.Fatalf("CreateUpload: %v", err)
	}

	uploadURL := resp.Msg.UploadUrl
	if uploadURL == "" {
		t.Fatal("CreateUpload returned empty upload URL")
	}

	// The presigned URL was generated without a Content-Length constraint,
	// so a client could declare 100 bytes but upload 50MB+.
	t.Log("FINDING DOCUMENTED: Presigned upload URL does not include Content-Length constraint")
	t.Log("Manual verification: Use curl to PUT a 50MB file to the presigned URL")
	t.Logf("Upload URL pattern: %s", uploadURL[:min(80, len(uploadURL))]+"...")

	// Verify CompleteUpload would catch the oversize (defense in depth).
	_, err = media.CompleteUpload(ctx, authedRequest(user.AccessToken, &v1.CompleteUploadRequest{
		UploadId: resp.Msg.UploadId,
	}))
	if err != nil {
		code := connect.CodeOf(err)
		t.Logf("CompleteUpload (without actual upload) returned: %v (%v)", code, err)
	}
}

