import { useCallback, useEffect, useState } from 'react';

interface MediaDeviceList {
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  error: string | null;
  hasPermission: boolean;
  requestPermission: () => Promise<void>;
}

export function useMediaDevices(): MediaDeviceList {
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasPermission, setHasPermission] = useState(false);

  const enumerate = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'audioinput');
      const outputs = devices.filter((d) => d.kind === 'audiooutput');
      setAudioInputs(inputs);
      setAudioOutputs(outputs);
      // If labels are non-empty, permission was granted
      setHasPermission(inputs.some((d) => d.label !== ''));
      setError(null);
    } catch {
      setError('Failed to enumerate devices');
    }
  }, []);

  const requestPermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Stop all tracks immediately — we only needed permission
      for (const track of stream.getTracks()) {
        track.stop();
      }
      setHasPermission(true);
      setError(null);
      await enumerate();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setError('Microphone access denied');
      } else {
        setError('Failed to access microphone');
      }
    }
  }, [enumerate]);

  useEffect(() => {
    enumerate();

    const handler = () => enumerate();
    navigator.mediaDevices.addEventListener('devicechange', handler);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handler);
    };
  }, [enumerate]);

  return { audioInputs, audioOutputs, error, hasPermission, requestPermission };
}
