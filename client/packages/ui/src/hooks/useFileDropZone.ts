import { useCallback, useEffect, useRef, useState } from 'react';
import { extractDroppedFiles } from '../utils/attachmentFiles.ts';

/**
 * Does this drag carry OS files (as opposed to an internal pointer drag like
 * @dnd-kit pane tiling, which never populates DataTransfer)? Files appear in
 * `dataTransfer.types` as the literal string "Files". `Array.from` normalizes
 * Firefox's DOMStringList.
 */
function dragHasFiles(e: React.DragEvent): boolean {
  const types = e.dataTransfer?.types;
  return types ? Array.from(types).includes('Files') : false;
}

export interface FileDropZone {
  isDragging: boolean;
  dropHandlers: {
    onDragEnter: React.DragEventHandler;
    onDragOver: React.DragEventHandler;
    onDragLeave: React.DragEventHandler;
    onDrop: React.DragEventHandler;
  };
}

interface UseFileDropZoneOptions {
  onFiles: (files: File[]) => void;
  /** Called when a dropped payload contained only folders. */
  onFolderRejected?: () => void;
  /** When true, the overlay never shows and drops are ignored. */
  disabled?: boolean;
}

/**
 * Native HTML5 file-drop handling for a region, with the usual footguns handled:
 * a depth counter so crossing child elements doesn't flicker the overlay, a
 * window-level reset so a drag that leaves the window can't leave the overlay
 * stuck, and a strict "Files only" gate so internal pointer drags are ignored.
 *
 * Touch devices never fire HTML5 file-drag, so this self-disables on mobile
 * without any viewport branching.
 */
export function useFileDropZone(opts: UseFileDropZoneOptions): FileDropZone {
  const { onFiles, onFolderRejected, disabled } = opts;
  const [isDragging, setIsDragging] = useState(false);
  const depth = useRef(0);

  // Refs so the stable handlers below always see the latest callbacks/flags.
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  const onFolderRejectedRef = useRef(onFolderRejected);
  onFolderRejectedRef.current = onFolderRejected;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    const reset = () => {
      depth.current = 0;
      setIsDragging(false);
    };
    // `dragend`/`drop` cover in-window endings; a drag dragged OUT of the window
    // fires `dragleave` with a null relatedTarget and no matching `dragend`.
    const onWindowDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) reset();
    };
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    window.addEventListener('dragleave', onWindowDragLeave);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
      window.removeEventListener('dragleave', onWindowDragLeave);
    };
  }, []);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (disabledRef.current || !dragHasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setIsDragging(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (disabledRef.current || !dragHasFiles(e)) return;
    e.preventDefault();
    // Must be set on every dragover tick (it resets each tick) for the copy cursor.
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (disabledRef.current || !dragHasFiles(e)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setIsDragging(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation(); // in-zone drop must not reach the window reset/guard
    depth.current = 0;
    setIsDragging(false);
    if (disabledRef.current) return;
    const { files, hadFolder } = extractDroppedFiles(e.dataTransfer);
    if (files.length > 0) onFilesRef.current(files);
    else if (hadFolder) onFolderRejectedRef.current?.();
  }, []);

  return {
    isDragging: isDragging && !disabled,
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
