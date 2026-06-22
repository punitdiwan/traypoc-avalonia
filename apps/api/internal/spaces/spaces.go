package spaces

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"golang.org/x/image/draw"
)

const thumbWidth = 480

type Config struct {
	Key    string
	Secret string
	Bucket string
	Region string
}

func (c Config) IsConfigured() bool {
	return c.Key != "" && c.Secret != "" && c.Bucket != "" && c.Region != ""
}

type Client struct {
	mc     *minio.Client
	bucket string
	region string
}

func NewClient(cfg Config) (*Client, error) {
	endpoint := fmt.Sprintf("%s.digitaloceanspaces.com", cfg.Region)
	mc, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.Key, cfg.Secret, ""),
		Secure: true,
	})
	if err != nil {
		return nil, err
	}
	return &Client{mc: mc, bucket: cfg.Bucket, region: cfg.Region}, nil
}

// GenerateThumbnail downloads the PNG at screenshotURL, scales it to 480px
// wide, re-uploads as JPEG, and returns the public thumbnail URL.
// The bucket must have a public-read policy (consistent with how the desktop
// uploads full-res PNGs with ObjectCannedACLPublicRead).
func (c *Client) GenerateThumbnail(ctx context.Context, screenshotURL string) (string, error) {
	resp, err := http.Get(screenshotURL)
	if err != nil {
		return "", fmt.Errorf("download screenshot: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download screenshot: HTTP %d", resp.StatusCode)
	}

	src, _, err := image.Decode(resp.Body)
	if err != nil {
		return "", fmt.Errorf("decode image: %w", err)
	}

	thumb := scale(src, thumbWidth)

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: 80}); err != nil {
		return "", fmt.Errorf("encode thumbnail: %w", err)
	}

	key := c.urlToKey(screenshotURL)
	thumbKey := strings.TrimSuffix(key, ".png") + "_thumb.jpg"

	data := bytes.NewReader(buf.Bytes())
	_, err = c.mc.PutObject(ctx, c.bucket, thumbKey, data, int64(buf.Len()), minio.PutObjectOptions{
		ContentType: "image/jpeg",
	})
	if err != nil {
		return "", fmt.Errorf("upload thumbnail: %w", err)
	}

	return fmt.Sprintf("https://%s.%s.digitaloceanspaces.com/%s", c.bucket, c.region, thumbKey), nil
}

// PutBytes uploads raw bytes (e.g. a call recording) under key with public-read
// ACL and returns the public URL. Used by the recorder bot.
func (c *Client) PutBytes(ctx context.Context, key, contentType string, b []byte) (string, error) {
	_, err := c.mc.PutObject(ctx, c.bucket, key, bytes.NewReader(b), int64(len(b)), minio.PutObjectOptions{
		ContentType: contentType,
		UserMetadata: map[string]string{
			"x-amz-acl": "public-read",
		},
	})
	if err != nil {
		return "", fmt.Errorf("upload object: %w", err)
	}
	return fmt.Sprintf("https://%s.%s.digitaloceanspaces.com/%s", c.bucket, c.region, key), nil
}

// PresignPut returns a short-lived presigned PUT URL for key, plus the public
// URL the object will have once uploaded. The desktop uploads straight to the
// PUT URL, so it never needs the Spaces credentials. "x-amz-acl: public-read"
// is part of the signature, so uploaded objects stay publicly readable
// (consistent with the previous direct-upload behavior).
func (c *Client) PresignPut(ctx context.Context, key, contentType string, expiry time.Duration) (putURL, publicURL string, err error) {
	headers := http.Header{}
	headers.Set("x-amz-acl", "public-read")
	if contentType != "" {
		headers.Set("Content-Type", contentType)
	}
	u, err := c.mc.PresignHeader(ctx, http.MethodPut, c.bucket, key, expiry, url.Values{}, headers)
	if err != nil {
		return "", "", err
	}
	publicURL = fmt.Sprintf("https://%s.%s.digitaloceanspaces.com/%s", c.bucket, c.region, key)
	return u.String(), publicURL, nil
}

// DeleteByURL removes the object identified by a public Spaces URL. URLs that
// don't belong to this bucket are ignored.
func (c *Client) DeleteByURL(ctx context.Context, fileURL string) error {
	key := c.urlToKey(fileURL)
	if key == "" || key == fileURL {
		return nil
	}
	return c.mc.RemoveObject(ctx, c.bucket, key, minio.RemoveObjectOptions{})
}

func (c *Client) urlToKey(url string) string {
	prefix := fmt.Sprintf("https://%s.%s.digitaloceanspaces.com/", c.bucket, c.region)
	return strings.TrimPrefix(url, prefix)
}

func scale(src image.Image, targetWidth int) image.Image {
	bounds := src.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if w == 0 {
		return src
	}
	targetH := h * targetWidth / w
	dst := image.NewRGBA(image.Rect(0, 0, targetWidth, targetH))
	draw.BiLinear.Scale(dst, dst.Bounds(), src, bounds, draw.Over, nil)
	return dst
}
