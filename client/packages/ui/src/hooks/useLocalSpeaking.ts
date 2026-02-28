import { useTracks } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';

/**
 * Detects speaking state for the local participant using Web Audio API
 * (AnalyserNode) for near-instant feedback (~50ms) instead of LiveKit's
 * server-round-tripped ActiveSpeakersChanged event (~600-1500ms).
 */
export function useLocalSpeaking(threshold = 0.015): boolean {
  const tracks = useTracks([Track.Source.Microphone], {
    onlySubscribed: false,
  });
  const localTrack = tracks.find((t) => t.participant.isLocal);
  const mediaStreamTrack = localTrack?.publication?.track?.mediaStreamTrack;
  const isMuted = localTrack?.publication?.isMuted ?? true;

  const [speaking, setSpeaking] = useState(false);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!mediaStreamTrack || isMuted) {
      setSpeaking(false);
      return;
    }

    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    const stream = new MediaStream([mediaStreamTrack]);
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    const data = new Float32Array(analyser.fftSize);
    let wasSpeaking = false;
    // Consecutive silent frames required before we set speaking=false.
    // At ~60fps, 8 frames ≈ 130ms — prevents flickering on brief pauses.
    const silenceFrames = 8;
    let silentCount = 0;

    const poll = () => {
      analyser.getFloatTimeDomainData(data);

      // Compute RMS (root mean square) of the waveform
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        sum += data[i] * data[i];
      }
      const rms = Math.sqrt(sum / data.length);
      const nowSpeaking = rms > threshold;

      if (nowSpeaking) {
        silentCount = 0;
        if (!wasSpeaking) {
          wasSpeaking = true;
          setSpeaking(true);
        }
      } else {
        silentCount++;
        if (wasSpeaking && silentCount >= silenceFrames) {
          wasSpeaking = false;
          setSpeaking(false);
        }
      }

      rafRef.current = requestAnimationFrame(poll);
    };

    rafRef.current = requestAnimationFrame(poll);

    return () => {
      cancelAnimationFrame(rafRef.current);
      source.disconnect();
      ctx.close();
    };
  }, [mediaStreamTrack, isMuted, threshold]);

  return speaking;
}
