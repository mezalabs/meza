import type { TemplateChannel } from '@meza/core';
import { ChannelType } from '@meza/core';

interface OnboardingStepProps {
  welcomeMessage: string;
  onWelcomeMessageChange: (msg: string) => void;
  rules: string;
  onRulesChange: (rules: string) => void;
  channels: TemplateChannel[];
  onChannelsChange: (channels: TemplateChannel[]) => void;
}

export function OnboardingStep({
  welcomeMessage,
  onWelcomeMessageChange,
  rules,
  onRulesChange,
  channels,
  onChannelsChange,
}: OnboardingStepProps) {
  const textChannels = channels.filter((c) => c.type === ChannelType.TEXT);

  const toggleDefault = (index: number) => {
    const updated = channels.map((ch, i) => {
      if (i !== index) return ch;
      return { ...ch, isDefault: !ch.isDefault };
    });
    onChannelsChange(updated);
  };

  const ruleLines = rules ? rules.split('\n').filter(Boolean).length : 0;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-text">Set up onboarding</h2>
        <p className="mt-1 text-sm text-text-muted">
          Configure what new members see when they join. All of this is
          optional.
        </p>
      </div>

      {/* Welcome message */}
      <div>
        <label
          htmlFor="welcome-message"
          className="mb-1 block text-sm font-medium text-text"
        >
          Welcome message
        </label>
        <textarea
          id="welcome-message"
          value={welcomeMessage}
          onChange={(e) => onWelcomeMessageChange(e.target.value)}
          maxLength={5000}
          rows={3}
          placeholder="Welcome to the server! Here's what you need to know..."
          className="w-full resize-none border border-border bg-bg-base text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <p className="mt-1 text-right text-xs text-text-muted">
          {welcomeMessage.length}/5000
        </p>
      </div>

      {/* Rules */}
      <div>
        <label
          htmlFor="rules"
          className="mb-1 block text-sm font-medium text-text"
        >
          Rules{' '}
          <span className="font-normal text-text-muted">
            (one per line, max 25)
          </span>
        </label>
        <textarea
          id="rules"
          value={rules}
          onChange={(e) => {
            const lines = e.target.value.split('\n');
            if (lines.length <= 25) {
              onRulesChange(e.target.value);
            }
          }}
          rows={4}
          placeholder={'Be respectful\nNo spam\nHave fun'}
          className="w-full resize-none border border-border bg-bg-base text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <p className="mt-1 text-right text-xs text-text-muted">
          {ruleLines}/25 rules
        </p>
      </div>

      {/* Default channels */}
      {textChannels.length > 1 && (
        <div>
          <p className="mb-2 text-sm font-medium text-text">Default channels</p>
          <p className="mb-2 text-xs text-text-muted">
            New members will automatically have access to default channels.
          </p>
          <div className="space-y-1">
            {channels.map((ch, i) => {
              if (ch.type !== ChannelType.TEXT) return null;
              return (
                <label
                  key={`${ch.name}-${i}`}
                  className="flex items-center gap-2 rounded-lg bg-bg-surface px-3 py-2 text-sm text-text cursor-pointer hover:bg-bg-elevated"
                >
                  <input
                    type="checkbox"
                    checked={ch.isDefault}
                    onChange={() => toggleDefault(i)}
                    className="accent-accent"
                  />
                  <span className="text-text-muted">#</span>
                  {ch.name}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
