package imaging

import (
	"fmt"

	"github.com/davidbyttow/govips/v2/vips"
)

const (
	maxPixelDimension    = 16384
	displayThumbSize     = 500
	displayThumbQuality  = 80
	microThumbSize       = 20
	microThumbQuality    = 60
)

// MaxDimension returns the maximum pixel dimension for a given upload purpose.
func MaxDimension(purpose string) int {
	switch purpose {
	case "server_emoji":
		return 128
	case "profile_avatar", "server_icon":
		return 512
	case "profile_banner":
		return 1920
	default: // chat_attachment
		return 2048
	}
}

// ProcessResult holds the output of image processing.
type ProcessResult struct {
	Thumbnail      []byte // display thumbnail (500px longest side, AR-preserved, WebP)
	MicroThumbnail []byte // micro thumbnail (~20px longest side, WebP)
	Width          int
	Height         int
}

// Process takes raw image bytes and an upload purpose, and produces two WebP
// thumbnails (display + micro) and resized dimensions.
//
// For animated GIFs, thumbnails are generated from the first frame.
// The original animated file is served as-is.
func Process(imageData []byte, purpose string) (*ProcessResult, error) {
	// Load image to check dimensions and detect animation.
	img, err := vips.NewImageFromBuffer(imageData)
	if err != nil {
		return nil, fmt.Errorf("load image: %w", err)
	}
	defer img.Close()

	// Decompression bomb protection.
	if img.Width() > maxPixelDimension || img.Height() > maxPixelDimension {
		return nil, fmt.Errorf("image dimensions %dx%d exceed maximum %dx%d",
			img.Width(), img.Height(), maxPixelDimension, maxPixelDimension)
	}

	isAnimated := img.Pages() > 1

	// For animated GIFs, we still want thumbnails from the first frame,
	// but we don't resize the original (it's served as-is).
	if isAnimated {
		return processAnimatedFirstFrame(imageData)
	}

	// Auto-rotate based on EXIF orientation.
	if err := img.AutoRotate(); err != nil {
		return nil, fmt.Errorf("auto-rotate: %w", err)
	}

	// Resize if exceeds max dimension for purpose.
	maxDim := MaxDimension(purpose)
	if img.Width() > maxDim || img.Height() > maxDim {
		scale := float64(maxDim) / float64(max(img.Width(), img.Height()))
		if err := img.Resize(scale, vips.KernelLanczos3); err != nil {
			return nil, fmt.Errorf("resize: %w", err)
		}
	}

	origWidth := img.Width()
	origHeight := img.Height()

	// Generate display and micro thumbnails.
	displayThumb, err := generateDisplayThumb(imageData)
	if err != nil {
		return nil, fmt.Errorf("display thumbnail: %w", err)
	}

	microThumb, err := generateMicroThumb(imageData)
	if err != nil {
		// Micro thumbnail is best-effort; don't fail the upload.
		microThumb = nil
	}

	return &ProcessResult{
		Thumbnail:      displayThumb,
		MicroThumbnail: microThumb,
		Width:          origWidth,
		Height:         origHeight,
	}, nil
}

// processAnimatedFirstFrame extracts the first frame of an animated image
// and generates thumbnails from it.
func processAnimatedFirstFrame(imageData []byte) (*ProcessResult, error) {
	// Load with page=0 to get only the first frame.
	params := vips.NewImportParams()
	params.Page.Set(0)
	params.NumPages.Set(1)
	firstFrame, err := vips.LoadImageFromBuffer(imageData, params)
	if err != nil {
		// If we can't extract the first frame, return no thumbnails (same as old behavior).
		return nil, nil
	}
	defer firstFrame.Close()

	if err := firstFrame.AutoRotate(); err != nil {
		return nil, nil
	}

	width := firstFrame.Width()
	height := firstFrame.Height()

	// Export first frame to a buffer we can reuse for thumbnail generation.
	frameData, _, err := firstFrame.ExportWebp(&vips.WebpExportParams{
		Quality:       90,
		StripMetadata: true,
	})
	if err != nil {
		return nil, nil
	}

	displayThumb, err := generateDisplayThumb(frameData)
	if err != nil {
		return nil, nil
	}

	microThumb, _ := generateMicroThumb(frameData)

	return &ProcessResult{
		Thumbnail:      displayThumb,
		MicroThumbnail: microThumb,
		Width:          width,
		Height:         height,
	}, nil
}

// generateDisplayThumb creates a 500px (longest side) aspect-ratio-preserving
// WebP thumbnail.
func generateDisplayThumb(imageData []byte) ([]byte, error) {
	thumbImg, err := vips.NewImageFromBuffer(imageData)
	if err != nil {
		return nil, fmt.Errorf("load for display thumb: %w", err)
	}
	defer thumbImg.Close()

	if err := thumbImg.AutoRotate(); err != nil {
		return nil, fmt.Errorf("display thumb auto-rotate: %w", err)
	}

	// Scale down to fit within displayThumbSize, preserving aspect ratio.
	longest := max(thumbImg.Width(), thumbImg.Height())
	if longest > displayThumbSize {
		scale := float64(displayThumbSize) / float64(longest)
		if err := thumbImg.Resize(scale, vips.KernelLanczos3); err != nil {
			return nil, fmt.Errorf("display thumb resize: %w", err)
		}
	}

	webp, _, err := thumbImg.ExportWebp(&vips.WebpExportParams{
		Quality:       displayThumbQuality,
		StripMetadata: true,
	})
	if err != nil {
		return nil, fmt.Errorf("export display thumb webp: %w", err)
	}
	return webp, nil
}

// generateMicroThumb creates a ~20px (longest side) aspect-ratio-preserving
// WebP micro thumbnail for use as an inline blurred placeholder.
func generateMicroThumb(imageData []byte) ([]byte, error) {
	microImg, err := vips.NewImageFromBuffer(imageData)
	if err != nil {
		return nil, fmt.Errorf("load for micro thumb: %w", err)
	}
	defer microImg.Close()

	if err := microImg.AutoRotate(); err != nil {
		return nil, fmt.Errorf("micro thumb auto-rotate: %w", err)
	}

	longest := max(microImg.Width(), microImg.Height())
	scale := float64(microThumbSize) / float64(longest)
	if err := microImg.Resize(scale, vips.KernelLanczos3); err != nil {
		return nil, fmt.Errorf("micro thumb resize: %w", err)
	}

	webp, _, err := microImg.ExportWebp(&vips.WebpExportParams{
		Quality:       microThumbQuality,
		StripMetadata: true,
	})
	if err != nil {
		return nil, fmt.Errorf("export micro thumb webp: %w", err)
	}
	return webp, nil
}
