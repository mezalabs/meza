import {
  ChannelType,
  createServerFromTemplate,
  type Invite,
  type PaneId,
  type Server,
  type ServerTemplate,
  type TemplateChannel,
  type TemplateRole,
  useAuthStore,
  useChannelStore,
  VOICE_CHANNELS,
} from '@meza/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  const [step, setStep] = useState(0);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [channels, setChannels] = useState<TemplateChannel[]>([]);
  const [roles, setRoles] = useState<TemplateRole[]>([]);
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [rules, setRules] = useState('');
  const [voiceAvailable] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdServer, setCreatedServer] = useState<Server | null>(null);
  const [createdInvite, setCreatedInvite] = useState<Invite | null>(null);

  const displayName = useAuthStore((s) => s.user?.displayName);

  // Pre-fill name with display name
  useEffect(() => {
    if (displayName && !name) {
      setName(`${displayName}'s Server`);
    }
  }, [displayName, name]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTemplateSelect = useCallback(
    (template: ServerTemplate) => {
      setTemplateId(template.id);

      // Build channels from template + voice channels if available
      const templateChannels = [...template.channels];
      if (voiceAvailable) {
        const voiceChans = VOICE_CHANNELS[template.id];
        if (voiceChans) {
          for (const vc of voiceChans) {
            templateChannels.push({
              name: vc.name,
              type: ChannelType.VOICE,
              isDefault: false,
            });
          }
        }
      }

      setChannels(templateChannels);
      setRoles([...template.roles]);
      setStep(1);
    },
    [voiceAvailable],
  );

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
  }, [creating, name, iconUrl, channels, roles, welcomeMessage, rules]);

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
              voiceAvailable={voiceAvailable}
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
