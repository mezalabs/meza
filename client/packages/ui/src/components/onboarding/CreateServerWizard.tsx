import {
  ChannelType,
  createServerFromTemplate,
  type Invite,
  type PaneId,
  type Server,
  type ServerTemplate,
  type TemplateChannel,
  type TemplateChannelGroup,
  type TemplateRole,
  useAuthStore,
  useChannelStore,
} from '@meza/core';
import { useCallback, useMemo, useState } from 'react';
import { useNavigationStore } from '../../stores/navigation.ts';
import { useTilingStore } from '../../stores/tiling.ts';
import { ChannelsStep } from './steps/ChannelsStep.tsx';
import { InviteStep } from './steps/InviteStep.tsx';
import { NameIconStep } from './steps/NameIconStep.tsx';
import { OnboardingStep } from './steps/OnboardingStep.tsx';
import { TemplateStep } from './steps/TemplateStep.tsx';

interface CreateServerWizardProps {
  paneId: PaneId;
}

const STEP_LABELS = [
  'Template',
  'Name & Icon',
  'Channels',
  'Onboarding',
  'Invite',
];

export function CreateServerWizard({ paneId }: CreateServerWizardProps) {
  const displayName = useAuthStore((s) => s.user?.displayName);

  const [step, setStep] = useState(0);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [name, setName] = useState(
    displayName ? `${displayName}'s Server` : '',
  );
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [channels, setChannels] = useState<TemplateChannel[]>([]);
  const [roles, setRoles] = useState<TemplateRole[]>([]);
  const [channelGroups, setChannelGroups] = useState<TemplateChannelGroup[]>(
    [],
  );
  const [everyonePermissions, setEveryonePermissions] = useState<
    bigint | undefined
  >(undefined);
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [rules, setRules] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdServer, setCreatedServer] = useState<Server | null>(null);
  const [createdInvite, setCreatedInvite] = useState<Invite | null>(null);

  const handleTemplateSelect = useCallback((template: ServerTemplate) => {
    setTemplateId(template.id);

    // Build channels from template + voice channels. Voice additions already
    // carry a groupName where applicable (Community).
    const templateChannels: TemplateChannel[] = [...template.channels];
    if (template.voiceChannels) {
      templateChannels.push(...template.voiceChannels);
    }

    setChannels(templateChannels);
    setRoles([...template.roles]);
    setChannelGroups([...template.channelGroups]);
    setEveryonePermissions(template.everyonePermissions);
    setStep(1);
  }, []);

  const handleCreate = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setError(null);

    const hasAtLeastOneText = channels.some((c) => c.type === ChannelType.TEXT);
    if (!hasAtLeastOneText) {
      setError('At least one text channel is required.');
      setCreating(false);
      return;
    }

    const onboardingEnabled =
      welcomeMessage.trim().length > 0 || rules.trim().length > 0;
    const rulesRequired = onboardingEnabled && rules.trim().length > 0;

    // Drop channel groups that no longer contain any channels (the user may
    // have removed every channel in a category during the Channels step).
    const usedGroupNames = new Set(
      channels.map((c) => c.groupName).filter((n): n is string => !!n),
    );
    const prunedGroups = channelGroups.filter((g) =>
      usedGroupNames.has(g.name),
    );

    try {
      const result = await createServerFromTemplate({
        name: name.trim(),
        iconUrl: iconUrl ?? undefined,
        channels: channels.map((ch) => ({
          name: ch.name,
          type: ch.type,
          isDefault: ch.isDefault,
          isPrivate: ch.isPrivate ?? false,
          roleNames: ch.roleNames,
          groupName: ch.groupName,
        })),
        roles: roles.map((r) => ({
          name: r.name,
          permissions: r.permissions,
          color: r.color,
          isSelfAssignable: r.isSelfAssignable,
        })),
        welcomeMessage: welcomeMessage.trim() || undefined,
        rules: rules.trim() || undefined,
        onboardingEnabled,
        rulesRequired,
        everyonePermissions,
        channelGroups: prunedGroups.map((g) => ({ name: g.name })),
      });

      if (result.server) {
        setCreatedServer(result.server);
        setCreatedInvite(result.invite ?? null);
        useNavigationStore.getState().selectServer(result.server.id);
        setStep(4);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create server');
    } finally {
      setCreating(false);
    }
  }, [
    creating,
    name,
    iconUrl,
    channels,
    roles,
    welcomeMessage,
    rules,
    everyonePermissions,
    channelGroups,
  ]);

  const handleDone = useCallback(() => {
    if (!createdServer) return;

    // Navigate to first default channel
    const serverChannels =
      useChannelStore.getState().byServer[createdServer.id] ?? [];
    const defaultChannel =
      serverChannels.find((c) => c.isDefault && c.type === ChannelType.TEXT) ??
      serverChannels.find((c) => c.type === ChannelType.TEXT);

    if (defaultChannel) {
      useTilingStore.getState().setPaneContent(paneId, {
        type: 'channel',
        channelId: defaultChannel.id,
      });
    } else {
      useTilingStore.getState().setPaneContent(paneId, { type: 'empty' });
    }
  }, [createdServer, paneId]);

  const handleSkipInvite = handleDone;

  const canGoNext = useMemo(() => {
    switch (step) {
      case 0:
        return templateId !== null;
      case 1:
        return name.trim().length > 0;
      case 2:
        return channels.some((c) => c.type === ChannelType.TEXT);
      case 3:
        return true;
      case 4:
        return true;
      default:
        return false;
    }
  }, [step, templateId, name, channels]);

  const handleNext = useCallback(() => {
    if (step === 3) {
      handleCreate();
    } else if (step < 4) {
      setStep((s) => s + 1);
    }
  }, [step, handleCreate]);

  const handlePrevious = useCallback(() => {
    if (step > 0 && step < 4) {
      setStep((s) => s - 1);
    }
  }, [step]);

  const handleSkip = useCallback(() => {
    if (step === 3) {
      // Skip onboarding, create with defaults
      setWelcomeMessage('');
      setRules('');
      handleCreate();
    } else if (step < 4) {
      setStep((s) => s + 1);
    }
  }, [step, handleCreate]);

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col items-center">
      <div className="flex w-full max-w-xl flex-1 flex-col px-6 py-8">
        {/* Step indicator */}
        <div className="mb-6 flex items-center justify-center gap-2">
          {STEP_LABELS.map((label, i) => (
            <div
              key={label}
              className={`h-2 w-2 rounded-full transition-colors ${
                i === step ? 'bg-accent' : 'bg-bg-surface'
              }`}
              title={label}
            />
          ))}
        </div>

        {/* Step content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {step === 0 && (
            <TemplateStep
              selectedId={templateId}
              onSelect={handleTemplateSelect}
            />
          )}
          {step === 1 && (
            <NameIconStep
              name={name}
              onNameChange={setName}
              onIconUrlChange={setIconUrl}
            />
          )}
          {step === 2 && (
            <ChannelsStep
              channels={channels}
              onChannelsChange={setChannels}
              channelGroups={channelGroups}
            />
          )}
          {step === 3 && (
            <OnboardingStep
              welcomeMessage={welcomeMessage}
              onWelcomeMessageChange={setWelcomeMessage}
              rules={rules}
              onRulesChange={setRules}
              channels={channels}
              onChannelsChange={setChannels}
            />
          )}
          {step === 4 && createdServer && (
            <InviteStep server={createdServer} invite={createdInvite} />
          )}
        </div>

        {/* Error */}
        {error && (
          <p className="mt-2 text-center text-xs text-error">{error}</p>
        )}

        {/* Navigation */}
        <div className="mt-6 flex items-center justify-between">
          <button
            type="button"
            onClick={handlePrevious}
            disabled={step === 0 || step === 4}
            className="rounded-lg px-5 py-3.5 text-sm text-text-muted hover:text-text disabled:invisible"
          >
            Previous
          </button>

          <div className="flex gap-2">
            {/* Skip button (steps 1-3, not template step, not invite step) */}
            {step > 0 && step < 4 && (
              <button
                type="button"
                onClick={handleSkip}
                className="rounded-lg px-5 py-3.5 text-sm text-text-muted hover:text-text"
              >
                Skip
              </button>
            )}

            {/* Next / Create / Done */}
            {step === 4 ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSkipInvite}
                  className="rounded-lg px-5 py-3.5 text-sm text-text-muted hover:text-text"
                >
                  Skip
                </button>
                <button
                  type="button"
                  onClick={handleDone}
                  className="rounded-lg bg-accent px-6 py-3.5 text-sm font-medium text-black hover:bg-accent-hover"
                >
                  Done
                </button>
              </div>
            ) : step === 3 ? (
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating || !canGoNext}
                className="rounded-lg bg-accent px-6 py-3.5 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
              >
                {creating ? 'Creating...' : 'Create Server'}
              </button>
            ) : step === 0 ? null : (
              <button
                type="button"
                onClick={handleNext}
                disabled={!canGoNext}
                className="rounded-lg bg-accent px-6 py-3.5 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
