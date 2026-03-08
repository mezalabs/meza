import { UploadPurpose, uploadFile } from '@meza/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImageCropperProps } from '../components/shared/ImageCropper.tsx';
import {
  isAnimatedImage,
  prepareImageForCropper,
  validateImageFile,
} from '../utils/image-utils.ts';

type PipelineState = 'idle' | 'preparing' | 'cropping' | 'uploading';

interface UseImageCropUploadOptions {
  purpose: UploadPurpose;
  aspectRatio: number;
  cropShape: 'round' | 'rect';
  onUploadComplete: (mediaUrl: string) => void | Promise<void>;
}

interface UseImageCropUploadReturn {
  openFileDialog: () => void;
  cropperProps: Omit<ImageCropperProps, 'onOpenChange'> | null;
  uploadProgress: number | null;
  state: PipelineState;
  error: string | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function useImageCropUpload({
  purpose,
  aspectRatio,
  cropShape,
  onUploadComplete,
}: UseImageCropUploadOptions): UseImageCropUploadReturn {
  // Use ref to avoid stale closures and unnecessary callback re-creation
  const onUploadCompleteRef = useRef(onUploadComplete);
  onUploadCompleteRef.current = onUploadComplete;
  const [state, setState] = useState<PipelineState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [cropperImageSrc, setCropperImageSrc] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cancelTokenRef = useRef({ canceled: false });
  const objectUrlsRef = useRef(new Set<string>());

  function trackObjectUrl(url: string): string {
    objectUrlsRef.current.add(url);
    return url;
  }

  function revokeObjectUrl(url: string) {
    if (objectUrlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      objectUrlsRef.current.delete(url);
    }
  }

  function revokeAllObjectUrls() {
    for (const url of objectUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    objectUrlsRef.current.clear();
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelTokenRef.current.canceled = true;
      revokeAllObjectUrls();
    };
  }, []);

  const resetPipeline = useCallback(() => {
    cancelTokenRef.current.canceled = true;
    cancelTokenRef.current = { canceled: false };
    revokeAllObjectUrls();
    setState('idle');
    setError(null);
    setUploadProgress(null);
    setCropperImageSrc(null);
  }, []);

  const onFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset the input so re-selecting the same file works
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (!file) return;

      // Cancel any in-flight pipeline
      cancelTokenRef.current.canceled = true;
      cancelTokenRef.current = { canceled: false };
      revokeAllObjectUrls();
      const token = cancelTokenRef.current;

      setError(null);
      setState('preparing');

      try {
        await validateImageFile(file);
        if (token.canceled) return;

        // Check if animated — skip crop dialog, upload directly
        const animated = await isAnimatedImage(file);
        if (token.canceled) return;

        if (animated) {
          setState('uploading');
          setUploadProgress(0);
          const result = await uploadFile(file, purpose, setUploadProgress);
          if (token.canceled) return;
          const mediaUrl = `/media/${result.attachmentId}`;
          await onUploadCompleteRef.current(mediaUrl);
          if (token.canceled) return;
          setState('idle');
          setUploadProgress(null);
          return;
        }

        // Prepare image for cropper (pre-scale if needed)
        const imageSrc = await prepareImageForCropper(file);
        if (token.canceled) {
          URL.revokeObjectURL(imageSrc);
          return;
        }
        trackObjectUrl(imageSrc);
        setCropperImageSrc(imageSrc);
        setState('cropping');
      } catch (err) {
        if (token.canceled) return;
        setError(err instanceof Error ? err.message : 'Failed to prepare image');
        setState('idle');
      }
    },
    [purpose],
  );

  const handleCrop = useCallback(
    async (croppedFile: File) => {
      if (state !== 'cropping') return;
      const token = cancelTokenRef.current;

      setState('uploading');
      setUploadProgress(0);

      // Clean up cropper image
      if (cropperImageSrc) {
        revokeObjectUrl(cropperImageSrc);
        setCropperImageSrc(null);
      }

      try {
        const result = await uploadFile(croppedFile, purpose, setUploadProgress);
        if (token.canceled) return;

        const mediaUrl = `/media/${result.attachmentId}`;
        await onUploadComplete(mediaUrl);
        if (token.canceled) return;

        setState('idle');
        setUploadProgress(null);
      } catch (err) {
        if (token.canceled) return;
        setError(err instanceof Error ? err.message : 'Failed to upload image');
        setState('idle');
        setUploadProgress(null);
      }
    },
    [state, cropperImageSrc, purpose],
  );

  const handleCropCancel = useCallback(() => {
    resetPipeline();
  }, [resetPipeline]);

  const openFileDialog = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const cropperProps: UseImageCropUploadReturn['cropperProps'] =
    state === 'cropping' && cropperImageSrc
      ? {
          open: true,
          imageSrc: cropperImageSrc,
          aspectRatio,
          cropShape,
          onCrop: handleCrop,
          onCancel: handleCropCancel,
        }
      : null;

  return {
    openFileDialog,
    cropperProps,
    uploadProgress,
    state,
    error,
    fileInputRef,
    onFileChange,
  };
}
