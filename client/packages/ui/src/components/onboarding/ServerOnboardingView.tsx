import {
  acknowledgeRules,
  ChannelType,
  completeOnboarding,
  getServer,
  listChannels,
  listRoles,
  useChannelStore,
  useRoleStore,
  useServerStore,
} from '@meza/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTilingStore } from '../../stores/tiling.ts';
import { ChannelsStep } from './ChannelsStep.tsx';
import { RolesStep } from './RolesStep.tsx';
import { RulesStep } from './RulesStep.tsx';
import { WelcomeStep } from './WelcomeStep.tsx';

interface ServerOnboardingViewProps {
  serverId: string;
  readOnly?: boolean;
}

type StepType = 'welcome' | 'rules' | 'channels' | 'roles';

const EMPTY_CHANNELS: never[] = [];
const EMPTY_ROLES: never[] = [];

export function ServerOnboardingView({
  serverId,
  readOnly = false,
}: ServerOnboardingViewProps) {
  const server = useServerStore((s) => s.servers[serverId]);
  const channels = useChannelStore(
    (s) => s.byServer[serverId] ?? EMPTY_CHANNELS,
  );
  const roles = useRoleStore((s) => s.byServer[serverId] ?? EMPTY_ROLES);

  const [currentStep, setCurrentStep] = useState(0);
  const [rulesAcknowledged, setRulesAcknowledged] = useState(false);
  const [selectedChannelIds, setSelectedChannelIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(
    new Set(),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch server data on mount
  useEffect(() => {
    getServer(serverId);
    listChannels(serverId);
    listRoles(serverId);
  }, [serverId]);

  // Non-private channels for the channels step
  const selectableChannels = useMemo(
    () => channels.filter((c) => !c.isPrivate && c.type === ChannelType.TEXT),
    [channels],
  );

  // Self-assignable roles for the roles step
  const selfAssignableRoles = useMemo(
    () => roles.filter((r) => r.isSelfAssignable),
    [roles],
  );

  // Pre-select default channels when data loads
  useEffect(() => {
    if (readOnly) return;
    const defaults = new Set<string>();
    for (const ch of selectableChannels) {
      if (ch.isDefault) defaults.add(ch.id);
    }
    if (defaults.size > 0) setSelectedChannelIds(defaults);
  }, [selectableChannels, readOnly]);

  // Build dynamic steps based on server config
  const steps = useMemo<StepType[]>(() => {
    const result: StepType[] = [];
    if (server?.welcomeMessage) result.push('welcome');
    if (server?.rules) result.push('rules');
    if (selectableChannels.length > 0) result.push('channels');
    if (selfAssignableRoles.length > 0) result.push('roles');
    // If nothing is configured, at least show welcome
    if (result.length === 0) result.push('welcome');
    return result;
  }, [server, selectableChannels, selfAssignableRoles]);

  const currentStepType = steps[currentStep] ?? 'welcome';
  const isLastStep = currentStep === steps.length - 1;

  const handleNext = useCallback(() => {
    if (!isLastStep) {
      setCurrentStep((s) => s + 1);
    }
  }, [isLastStep]);

  const handlePrevious = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep((s) => s - 1);
    }
  }, [currentStep]);

  const handleAcknowledgeRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await acknowledgeRules(serverId);
      setRulesAcknowledged(true);
      handleNext();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to acknowledge rules',
      );
    } finally {
      setLoading(false);
    }
  }, [serverId, handleNext]);

  const handleComplete = useCallback(async () => {
    if (readOnly) {
      // Close the pane
      const { focusedPaneId, setPaneContent } = useTilingStore.getState();
      setPaneContent(focusedPaneId, { type: 'empty' });
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await completeOnboarding(
        serverId,
        [...selectedChannelIds],
        [...selectedRoleIds],
      );

      // Navigate to first default channel or first available channel
      const chs = useChannelStore.getState().byServer[serverId] ?? [];
      const defaultChannel =
        chs.find((c) => c.isDefault && !c.isPrivate) ??
        chs.find((c) => !c.isPrivate && c.type === ChannelType.TEXT);

      const { focusedPaneId, setPaneContent } = useTilingStore.getState();
      if (defaultChannel) {
        setPaneContent(focusedPaneId, {
          type: 'channel',
          channelId: defaultChannel.id,
        });
      } else {
        setPaneContent(focusedPaneId, { type: 'empty' });
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to complete onboarding',
      );
    } finally {
      setLoading(false);
    }
  }, [serverId, selectedChannelIds, selectedRoleIds, readOnly]);

  if (!server) {
    return (
      <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center">
        <div className="text-text-muted text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col items-center">
      <div className="flex w-full max-w-xl flex-1 flex-col px-6 py-8">
        {/* Step indicator */}
        {steps.length > 1 && (
          <div className="mb-6 flex items-center justify-center gap-2">
            {steps.map((_, i) => (
              <div
                key={steps[i]}
                className={`h-2 w-2 rounded-full transition-colors ${
                  i === currentStep ? 'bg-accent' : 'bg-bg-surface'
                }`}
              />
            ))}
          </div>
        )}

        {/* Step content */}
        <div className="flex-1 overflow-y-auto">
          {currentStepType === 'welcome' && (
            <WelcomeStep
              serverName={server.name}
              iconUrl={server.iconUrl}
              welcomeMessage={server.welcomeMessage}
            />
          )}
          {currentStepType === 'rules' && (
            <RulesStep
              rules={server.rules}
              readOnly={readOnly}
              acknowledged={rulesAcknowledged}
              onAcknowledge={handleAcknowledgeRules}
              loading={loading}
            />
          )}
          {currentStepType === 'channels' && (
            <ChannelsStep
              channels={selectableChannels}
              selectedIds={selectedChannelIds}
              onSelectionChange={setSelectedChannelIds}
              readOnly={readOnly}
            />
          )}
          {currentStepType === 'roles' && (
            <RolesStep
              roles={selfAssignableRoles}
              selectedIds={selectedRoleIds}
              onSelectionChange={setSelectedRoleIds}
              readOnly={readOnly}
            />
          )}
        </div>

        {/* Error display */}
        {error && (
          <p className="mt-2 text-center text-xs text-error">{error}</p>
        )}

        {/* Navigation */}
        <div className="mt-6 flex items-center justify-between">
          <button
            type="button"
            onClick={handlePrevious}
            disabled={currentStep === 0}
            className="rounded-lg px-5 py-3.5 text-sm text-text-muted hover:text-text disabled:invisible"
          >
            Previous
          </button>

          {currentStepType === 'rules' && !readOnly ? (
            // Rules step has its own CTA
            <div />
          ) : isLastStep ? (
            <button
              type="button"
              onClick={handleComplete}
              disabled={loading}
              className="rounded-lg bg-accent px-6 py-3.5 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
            >
              {loading ? 'Completing...' : readOnly ? 'Close' : 'Complete'}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleNext}
              className="rounded-lg bg-accent px-6 py-3.5 text-sm font-medium text-black hover:bg-accent-hover"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
