export type SoundType =
  | 'message'
  | 'dm'
  | 'mention'
  | 'voice-join'
  | 'voice-leave'
  | 'call-connect'
  | 'call-end'
  | 'stream-start'
  | 'stream-end'
  | 'stream-join'
  | 'stream-leave'
  | 'mute'
  | 'unmute';

const SOUND_FILES: Record<SoundType, string> = {
  message: '/sounds/message.wav',
  dm: '/sounds/dm.wav',
  mention: '/sounds/mention.wav',
  'voice-join': '/sounds/voice-join.wav',
  'voice-leave': '/sounds/voice-leave.wav',
  'call-connect': '/sounds/call-connect.wav',
  'call-end': '/sounds/call-end.wav',
  'stream-start': '/sounds/stream-start.wav',
  'stream-end': '/sounds/stream-end.wav',
  'stream-join': '/sounds/stream-join.wav',
  'stream-leave': '/sounds/stream-leave.wav',
  mute: '/sounds/mute.wav',
  unmute: '/sounds/unmute.wav',
};

const COOLDOWNS: Record<SoundType, number> = {
  message: 2000,
  dm: 0,
  mention: 2000,
  'voice-join': 2000,
  'voice-leave': 2000,
  'call-connect': 0,
  'call-end': 0,
  'stream-start': 0,
  'stream-end': 0,
  'stream-join': 2000,
  'stream-leave': 2000,
  mute: 0,
  unmute: 0,
};

class SoundManager {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private buffers = new Map<SoundType, AudioBuffer>();
  private rawData = new Map<SoundType, ArrayBuffer>();
  private lastPlayed = new Map<SoundType, number>();
  private prefetchPromise: Promise<void> | null = null;

  /** Fetch raw sound data without creating an AudioContext. */
  async prefetch(): Promise<void> {
    if (this.prefetchPromise) return this.prefetchPromise;
    this.prefetchPromise = this.doPrefetch();
    return this.prefetchPromise;
  }

  private async doPrefetch(): Promise<void> {
    const entries = Object.entries(SOUND_FILES) as [SoundType, string][];
    const results = await Promise.allSettled(
      entries.map(async ([type, url]) => {
        const response = await fetch(url);
        if (!response.ok) return;
        this.rawData.set(type, await response.arrayBuffer());
      }),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        console.warn(`[SoundManager] Failed to load sound: ${entries[i][0]}`);
      }
    }
  }

  /** Create AudioContext and decode prefetched data into AudioBuffers. */
  private async ensureContext(): Promise<boolean> {
    if (this.ctx && this.gain) return true;

    try {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    } catch (err) {
      console.warn('[SoundManager] Failed to create AudioContext:', err);
      return false;
    }

    // Decode any prefetched raw data into AudioBuffers
    for (const [type, raw] of this.rawData) {
      try {
        const buf = await this.ctx.decodeAudioData(raw.slice(0));
        this.buffers.set(type, buf);
      } catch {
        console.warn(`[SoundManager] Failed to decode sound: ${type}`);
      }
    }
    this.rawData.clear();
    return true;
  }

  /** Play a notification sound if cooldown has elapsed. */
  async play(type: SoundType): Promise<void> {
    if (!(await this.ensureContext())) return;

    // Cooldown check
    const cooldown = COOLDOWNS[type];
    if (cooldown > 0) {
      const last = this.lastPlayed.get(type) ?? 0;
      if (Date.now() - last < cooldown) return;
    }

    const buffer = this.buffers.get(type);
    if (!buffer) return;

    // Resume suspended AudioContext (browser autoplay policy)
    if (this.ctx!.state === 'suspended') {
      try {
        await this.ctx!.resume();
      } catch {
        return;
      }
    }

    const source = this.ctx!.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain!);
    source.start();
    this.lastPlayed.set(type, Date.now());
  }

  /** Play a sound ignoring cooldown (for settings preview). */
  async preview(type: SoundType): Promise<void> {
    if (!(await this.ensureContext())) return;

    const buffer = this.buffers.get(type);
    if (!buffer) return;

    if (this.ctx!.state === 'suspended') {
      try {
        await this.ctx!.resume();
      } catch {
        return;
      }
    }

    const source = this.ctx!.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain!);
    source.start();
  }

  /** Set notification sound volume (0.0 - 1.0). */
  setVolume(v: number): void {
    if (this.gain) {
      this.gain.gain.value = Math.max(0, Math.min(1, v));
    }
  }
}

export const soundManager = new SoundManager();
