import { beforeEach, describe, expect, it } from 'vitest';
import type { VoiceChannelParticipant } from './voiceParticipants.ts';
import { useVoiceParticipantsStore } from './voiceParticipants.ts';

const participant = (
  userId: string,
  overrides?: Partial<VoiceChannelParticipant>,
): VoiceChannelParticipant => ({
  userId,
  isMuted: false,
  isDeafened: false,
  isStreamingVideo: false,
  isEncrypted: false,
  ...overrides,
});

beforeEach(() => {
  useVoiceParticipantsStore.setState({ byChannel: {} });
});

describe('voiceParticipants store', () => {
  describe('setParticipants', () => {
    it('replaces the participant list for a channel', () => {
      const list = [participant('u1'), participant('u2')];
      useVoiceParticipantsStore.getState().setParticipants('ch1', list);

      expect(useVoiceParticipantsStore.getState().byChannel.ch1).toHaveLength(
        2,
      );
    });

    it('overwrites previous participants', () => {
      useVoiceParticipantsStore
        .getState()
        .setParticipants('ch1', [participant('u1')]);
      useVoiceParticipantsStore
        .getState()
        .setParticipants('ch1', [participant('u2')]);

      const list = useVoiceParticipantsStore.getState().byChannel.ch1;
      expect(list).toHaveLength(1);
      expect(list?.[0].userId).toBe('u2');
    });
  });

  describe('upsertParticipant', () => {
    it('adds a participant to an empty channel', () => {
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u1'));

      const list = useVoiceParticipantsStore.getState().byChannel.ch1;
      expect(list).toHaveLength(1);
      expect(list?.[0].userId).toBe('u1');
    });

    it('updates an existing participant by userId', () => {
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u1'));
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u1', { isMuted: true }));

      const list = useVoiceParticipantsStore.getState().byChannel.ch1;
      expect(list).toHaveLength(1);
      expect(list?.[0].isMuted).toBe(true);
    });

    it('appends a new participant to an existing channel', () => {
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u1'));
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u2'));

      expect(useVoiceParticipantsStore.getState().byChannel.ch1).toHaveLength(
        2,
      );
    });
  });

  describe('updateParticipant', () => {
    it('patches an existing participant', () => {
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u1'));
      useVoiceParticipantsStore
        .getState()
        .updateParticipant('ch1', 'u1', { isEncrypted: true });

      const p = useVoiceParticipantsStore.getState().byChannel.ch1?.[0];
      expect(p.isEncrypted).toBe(true);
      // Other fields unchanged
      expect(p.isMuted).toBe(false);
    });

    it('is a no-op when participant does not exist', () => {
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u1'));
      useVoiceParticipantsStore
        .getState()
        .updateParticipant('ch1', 'unknown', { isEncrypted: true });

      const p = useVoiceParticipantsStore.getState().byChannel.ch1?.[0];
      expect(p.isEncrypted).toBe(false);
    });

    it('is a no-op when channel does not exist', () => {
      useVoiceParticipantsStore
        .getState()
        .updateParticipant('nonexistent', 'u1', { isEncrypted: true });

      expect(
        useVoiceParticipantsStore.getState().byChannel.nonexistent,
      ).toBeUndefined();
    });
  });

  describe('removeParticipant', () => {
    it('removes a participant by userId', () => {
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u1'));
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u2'));
      useVoiceParticipantsStore.getState().removeParticipant('ch1', 'u1');

      const list = useVoiceParticipantsStore.getState().byChannel.ch1;
      expect(list).toHaveLength(1);
      expect(list?.[0].userId).toBe('u2');
    });

    it('is a no-op for unknown userId', () => {
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u1'));
      useVoiceParticipantsStore.getState().removeParticipant('ch1', 'unknown');

      expect(useVoiceParticipantsStore.getState().byChannel.ch1).toHaveLength(
        1,
      );
    });
  });

  describe('isEncrypted preservation', () => {
    it('setParticipants does not carry over isEncrypted from previous state by itself', () => {
      // isEncrypted must be explicitly passed when calling setParticipants
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u1', { isEncrypted: true }));

      useVoiceParticipantsStore
        .getState()
        .setParticipants('ch1', [participant('u1', { isEncrypted: false })]);

      const p = useVoiceParticipantsStore.getState().byChannel.ch1?.[0];
      expect(p.isEncrypted).toBe(false);
    });

    it('updateParticipant can toggle isEncrypted without affecting other fields', () => {
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant(
          'ch1',
          participant('u1', { isMuted: true, isDeafened: true }),
        );
      useVoiceParticipantsStore
        .getState()
        .updateParticipant('ch1', 'u1', { isEncrypted: true });

      const p = useVoiceParticipantsStore.getState().byChannel.ch1?.[0];
      expect(p.isEncrypted).toBe(true);
      expect(p.isMuted).toBe(true);
      expect(p.isDeafened).toBe(true);
    });

    it('upsertParticipant replaces isEncrypted when updating', () => {
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u1', { isEncrypted: true }));
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u1', { isEncrypted: false }));

      const p = useVoiceParticipantsStore.getState().byChannel.ch1?.[0];
      expect(p.isEncrypted).toBe(false);
    });
  });

  describe('clearChannel / clearAll', () => {
    it('clearChannel removes a single channel', () => {
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u1'));
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch2', participant('u2'));
      useVoiceParticipantsStore.getState().clearChannel('ch1');

      expect(
        useVoiceParticipantsStore.getState().byChannel.ch1,
      ).toBeUndefined();
      expect(useVoiceParticipantsStore.getState().byChannel.ch2).toHaveLength(
        1,
      );
    });

    it('clearAll removes all channels', () => {
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch1', participant('u1'));
      useVoiceParticipantsStore
        .getState()
        .upsertParticipant('ch2', participant('u2'));
      useVoiceParticipantsStore.getState().clearAll();

      expect(useVoiceParticipantsStore.getState().byChannel).toEqual({});
    });
  });
});
