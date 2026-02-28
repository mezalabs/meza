package s3

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/cors"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Client wraps a minio.Client and binds it to a specific bucket.
type Client struct {
	client *minio.Client
	bucket string
}

// NewClient creates a new S3 client using the given endpoint and credentials.
// The endpoint can be a bare host:port (e.g. "localhost:9000") or a URL
// (e.g. "http://localhost:9000"). When a URL is provided, the scheme
// determines the Secure setting and the host:port is extracted automatically.
func NewClient(endpoint, accessKey, secretKey, bucket string, useSSL bool) (*Client, error) {
	if strings.HasPrefix(endpoint, "http://") || strings.HasPrefix(endpoint, "https://") {
		u, err := url.Parse(endpoint)
		if err != nil {
			return nil, fmt.Errorf("s3: invalid endpoint URL %q: %w", endpoint, err)
		}
		endpoint = u.Host
		useSSL = u.Scheme == "https"
	}

	mc, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("s3: failed to create minio client: %w", err)
	}

	return &Client{
		client: mc,
		bucket: bucket,
	}, nil
}

// EnsureBucket checks whether the configured bucket exists and creates it if it
// does not. The bucket is created in the us-east-1 region.
func (c *Client) EnsureBucket(ctx context.Context) error {
	exists, err := c.client.BucketExists(ctx, c.bucket)
	if err != nil {
		return fmt.Errorf("s3: failed to check bucket existence: %w", err)
	}
	if exists {
		return nil
	}

	if err := c.client.MakeBucket(ctx, c.bucket, minio.MakeBucketOptions{
		Region: "us-east-1",
	}); err != nil {
		return fmt.Errorf("s3: failed to create bucket %q: %w", c.bucket, err)
	}

	return nil
}

// SetCORS configures the CORS rules on the bucket, allowing the specified
// origins to perform upload and download operations.
func (c *Client) SetCORS(ctx context.Context, origins []string) error {
	corsConfig := &cors.Config{
		CORSRules: []cors.Rule{
			{
				AllowedOrigin: origins,
				AllowedMethod: []string{
					http.MethodPut,
					http.MethodGet,
					http.MethodHead,
				},
				AllowedHeader: []string{
					"Content-Type",
					"Content-Length",
					"Authorization",
				},
				MaxAgeSeconds: 3600,
			},
		},
	}

	if err := c.client.SetBucketCors(ctx, c.bucket, corsConfig); err != nil {
		return fmt.Errorf("s3: failed to set CORS on bucket %q: %w", c.bucket, err)
	}

	return nil
}

// GeneratePresignedPUT returns a presigned URL that allows an HTTP PUT of an
// object with the given key. The Content-Type header is included in the
// signature so the uploader must send a matching value.
func (c *Client) GeneratePresignedPUT(ctx context.Context, objectKey, contentType string, expiry time.Duration) (string, error) {
	headers := make(http.Header)
	headers.Set("Content-Type", contentType)

	u, err := c.client.PresignHeader(ctx, http.MethodPut, c.bucket, objectKey, expiry, nil, headers)
	if err != nil {
		return "", fmt.Errorf("s3: failed to generate presigned PUT for %q: %w", objectKey, err)
	}

	return u.String(), nil
}

// GeneratePresignedGET returns a presigned URL that allows an HTTP GET of the
// object. When inline is true, the Content-Disposition header is set to "inline"
// (suitable for images/videos rendered in <img>/<video> tags). When false, it is
// set to "attachment" which forces a download (safer for PDFs, ZIPs, etc.).
func (c *Client) GeneratePresignedGET(ctx context.Context, objectKey, filename string, expiry time.Duration, inline bool) (string, error) {
	reqParams := make(url.Values)
	// Sanitize filename for Content-Disposition: strip quotes and backslashes to
	// prevent header injection.
	safe := strings.NewReplacer(`"`, "", `\`, "", "\r", "", "\n", "").Replace(filename)
	disposition := "attachment"
	if inline {
		disposition = "inline"
	}
	reqParams.Set("response-content-disposition", fmt.Sprintf(`%s; filename="%s"`, disposition, safe))
	reqParams.Set("response-content-type-options", "nosniff")

	u, err := c.client.PresignedGetObject(ctx, c.bucket, objectKey, expiry, reqParams)
	if err != nil {
		return "", fmt.Errorf("s3: failed to generate presigned GET for %q: %w", objectKey, err)
	}

	return u.String(), nil
}

// GetObjectRange downloads a byte range of the object at the given key. This is
// useful for fetching just the first 512 bytes for content-type sniffing without
// loading an entire large file into memory.
func (c *Client) GetObjectRange(ctx context.Context, objectKey string, offset, length int64) ([]byte, error) {
	opts := minio.GetObjectOptions{}
	if err := opts.SetRange(offset, offset+length-1); err != nil {
		return nil, fmt.Errorf("s3: invalid range: %w", err)
	}

	obj, err := c.client.GetObject(ctx, c.bucket, objectKey, opts)
	if err != nil {
		return nil, fmt.Errorf("s3: failed to get object range %q: %w", objectKey, err)
	}
	defer obj.Close()

	data, err := io.ReadAll(obj)
	if err != nil {
		return nil, fmt.Errorf("s3: failed to read object range %q: %w", objectKey, err)
	}

	return data, nil
}

// GetObject downloads the entire object at the given key and returns its
// contents as a byte slice.
func (c *Client) GetObject(ctx context.Context, objectKey string) ([]byte, error) {
	obj, err := c.client.GetObject(ctx, c.bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("s3: failed to get object %q: %w", objectKey, err)
	}
	defer obj.Close()

	data, err := io.ReadAll(obj)
	if err != nil {
		return nil, fmt.Errorf("s3: failed to read object %q: %w", objectKey, err)
	}

	return data, nil
}

// PutObject uploads data to the given object key with the specified content
// type.
func (c *Client) PutObject(ctx context.Context, objectKey string, data []byte, contentType string) error {
	reader := bytes.NewReader(data)

	_, err := c.client.PutObject(ctx, c.bucket, objectKey, reader, int64(len(data)), minio.PutObjectOptions{
		ContentType: contentType,
	})
	if err != nil {
		return fmt.Errorf("s3: failed to put object %q: %w", objectKey, err)
	}

	return nil
}

// StatObject returns the size in bytes of an S3 object.
func (c *Client) StatObject(ctx context.Context, objectKey string) (int64, error) {
	info, err := c.client.StatObject(ctx, c.bucket, objectKey, minio.StatObjectOptions{})
	if err != nil {
		return 0, fmt.Errorf("stat object %s: %w", objectKey, err)
	}
	return info.Size, nil
}

// DeleteObject removes the object at the given key from the bucket.
func (c *Client) DeleteObject(ctx context.Context, objectKey string) error {
	if err := c.client.RemoveObject(ctx, c.bucket, objectKey, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("s3: failed to delete object %q: %w", objectKey, err)
	}

	return nil
}

