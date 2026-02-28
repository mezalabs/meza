import {
  createSound,
  deleteSound,
  getMediaURL,
  listServerSounds,
  listUserSounds,
  UploadPurpose,
  updateSound,
  uploadFile,
  useAuthStore,
  useSoundStore,
} from '@meza/core';
import { useEffect, useRef, useState } from 'react';

const EMPTY_SOUNDS: never[] = [];
const MAX_SERVER_SOUNDS = 12;
const MAX_PERSONAL_SOUNDS = 6;
const NAME_REGEX = /^[a-zA-Z0-9 _-]{2,32}$/;

interface SoundsSectionProps {
  serverId?: string;
}

export function SoundsSection({ serverId }: SoundsSectionProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const sounds = useSoundStore((s) =>
    serverId ? (s.byServer[serverId] ?? EMPTY_SOUNDS) : s.personal,
  );
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const maxSounds = serverId ? MAX_SERVER_SOUNDS : MAX_PERSONAL_SOUNDS;
  const label = serverId ? 'Server Sounds' : 'My Sounds';

  useEffect(() => {
    if (!isAuthenticated) return;
    if (serverId) {
      listServerSounds(serverId).catch(() => {});
    } else {
      listUserSounds().catch(() => {});
    }
  }, [serverId, isAuthenticated]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = '';

    const baseName = file.name
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9 _-]/g, '_')
      .slice(0, 32);
    if (!NAME_REGEX.test(baseName)) {
      setUploadError(
        'Invalid sound name. Use 2-32 letters, numbers, spaces, underscores, or hyphens.',
      );
      return;
    }

    setUploadError('');
    setIsUploading(true);
    try {
      const { attachmentId } = await uploadFile(file, UploadPurpose.SOUNDBOARD);
      await createSound(baseName, attachmentId, serverId);
    } catch {
      setUploadError('Failed to upload sound');
    } finally {
      setIsUploading(false);
    }
  }

  async function handleDelete(soundId: string) {
    setIsDeleting(true);
    try {
      await deleteSound(soundId);
      useSoundStore.getState().removeSound(soundId, serverId);
      setDeleteConfirmId(null);
    } catch {
      // Error handled
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleRename(soundId: string) {
    const trimmed = editName.trim();
    if (!NAME_REGEX.test(trimmed)) {
      setEditError(
        'Name must be 2-32 letters, numbers, spaces, underscores, or hyphens.',
      );
      return;
    }
    setEditError('');
    try {
      await updateSound(soundId, trimmed);
      setEditingId(null);
    } catch {
      setEditError('Failed to rename sound');
    }
  }

  const atLimit = sounds.length >= maxSounds;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text">{label}</h2>
          <p className="text-sm text-text-muted">
            {sounds.length}/{maxSounds} sounds used
          </p>
        </div>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".mp3,.ogg,.oga,.wav,.webm"
            className="hidden"
            onChange={handleUpload}
            disabled={isUploading || atLimit}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading || atLimit}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent/80 disabled:opacity-50"
          >
            {isUploading ? 'Uploading...' : 'Upload Sound'}
          </button>
        </div>
      </div>

      {uploadError && <p className="mb-3 text-xs text-error">{uploadError}</p>}

      {sounds.length === 0 && (
        <p className="text-sm text-text-muted">
          No sounds yet. Upload one to get started!
        </p>
      )}

      <div className="flex flex-col gap-2">
        {sounds.map((sound) => {
          const attachmentId = sound.audioUrl.replace('/media/', '');
          return (
            <div
              key={sound.id}
              className="flex items-center justify-between rounded-lg border border-border bg-bg-surface p-3"
            >
              <div className="flex items-center gap-3">
                {/* biome-ignore lint/a11y/useMediaCaption: soundboard audio does not need captions */}
                <audio
                  src={getMediaURL(attachmentId)}
                  preload="none"
                  controls
                  className="h-8"
                />
                {editingId === sound.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-40 rounded-md border border-border bg-bg-surface px-2 py-1 text-sm text-text focus:border-accent focus:outline-none"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(sound.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => handleRename(sound.id)}
                      className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-black hover:bg-accent/80"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="rounded-md px-2 py-1 text-xs text-text-muted hover:text-text"
                    >
                      Cancel
                    </button>
                    {editError && (
                      <span className="text-xs text-error">{editError}</span>
                    )}
                  </div>
                ) : (
                  <span className="text-sm font-medium text-text">
                    {sound.name}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {editingId !== sound.id && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(sound.id);
                      setEditName(sound.name);
                      setEditError('');
                    }}
                    className="rounded-md px-2 py-1 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
                  >
                    Rename
                  </button>
                )}
                {deleteConfirmId === sound.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={isDeleting}
                      onClick={() => handleDelete(sound.id)}
                      className="rounded-md bg-error px-2 py-1 text-sm font-medium text-white hover:bg-error/80 disabled:opacity-50"
                    >
                      {isDeleting ? 'Deleting...' : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      disabled={isDeleting}
                      onClick={() => setDeleteConfirmId(null)}
                      className="rounded-md px-2 py-1 text-sm text-text-muted hover:text-text"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setDeleteConfirmId(sound.id)}
                    className="rounded-md px-2 py-1 text-sm text-error hover:bg-error/10"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
