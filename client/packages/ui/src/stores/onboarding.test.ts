import { afterEach, describe, expect, it } from 'vitest';
import { selectIsDismissed, useOnboardingStore } from './onboarding.ts';

const initialState = useOnboardingStore.getState();

afterEach(() => {
  useOnboardingStore.setState(initialState, true);
});

describe('useOnboardingStore', () => {
  describe('load', () => {
    it('populates dismissedTips and sets loaded', () => {
      useOnboardingStore.getState().load(['sidebar-drag', 'resize']);
      const s = useOnboardingStore.getState();
      expect(s.loaded).toBe(true);
      expect(s.dismissedTips).toEqual({
        'sidebar-drag': true,
        resize: true,
      });
    });

    it('handles empty array', () => {
      useOnboardingStore.getState().load([]);
      const s = useOnboardingStore.getState();
      expect(s.loaded).toBe(true);
      expect(s.dismissedTips).toEqual({});
    });
  });

  describe('show', () => {
    it('sets activeTip when no tip is active', () => {
      useOnboardingStore.getState().load([]);
      useOnboardingStore.getState().show('sidebar-drag');
      expect(useOnboardingStore.getState().activeTip).toBe('sidebar-drag');
    });

    it('is a no-op when another tip is already active', () => {
      useOnboardingStore.getState().load([]);
      useOnboardingStore.getState().show('sidebar-drag');
      useOnboardingStore.getState().show('resize');
      expect(useOnboardingStore.getState().activeTip).toBe('sidebar-drag');
    });

    it('is a no-op when tip is dismissed', () => {
      useOnboardingStore.getState().load(['sidebar-drag']);
      useOnboardingStore.getState().show('sidebar-drag');
      expect(useOnboardingStore.getState().activeTip).toBeNull();
    });
  });

  describe('dismiss', () => {
    it('adds tip to dismissedTips and clears activeTip', () => {
      useOnboardingStore.getState().load([]);
      useOnboardingStore.getState().show('resize');
      expect(useOnboardingStore.getState().activeTip).toBe('resize');

      useOnboardingStore.getState().dismiss('resize');
      const s = useOnboardingStore.getState();
      expect(s.activeTip).toBeNull();
      expect(s.dismissedTips.resize).toBe(true);
    });

    it('prevents showing the same tip again', () => {
      useOnboardingStore.getState().load([]);
      useOnboardingStore.getState().dismiss('sidebar-drag');
      useOnboardingStore.getState().show('sidebar-drag');
      expect(useOnboardingStore.getState().activeTip).toBeNull();
    });
  });

  describe('hide', () => {
    it('clears activeTip without dismissing', () => {
      useOnboardingStore.getState().load([]);
      useOnboardingStore.getState().show('resize');
      useOnboardingStore.getState().hide();
      const s = useOnboardingStore.getState();
      expect(s.activeTip).toBeNull();
      expect(s.dismissedTips.resize).toBeUndefined();
    });
  });

  describe('reset', () => {
    it('clears all dismissed tips and active tip', () => {
      useOnboardingStore.getState().load(['sidebar-drag', 'resize']);
      useOnboardingStore.getState().show('header-drag');
      useOnboardingStore.getState().reset();
      const s = useOnboardingStore.getState();
      expect(s.dismissedTips).toEqual({});
      expect(s.activeTip).toBeNull();
      expect(s.loaded).toBe(true);
    });
  });

  describe('selectIsDismissed', () => {
    it('returns true for dismissed tips', () => {
      useOnboardingStore.getState().load(['sidebar-drag']);
      const selector = selectIsDismissed('sidebar-drag');
      expect(selector(useOnboardingStore.getState())).toBe(true);
    });

    it('returns false for non-dismissed tips', () => {
      useOnboardingStore.getState().load([]);
      const selector = selectIsDismissed('sidebar-drag');
      expect(selector(useOnboardingStore.getState())).toBe(false);
    });
  });
});
