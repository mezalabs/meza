import { ArrowLeftIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useMobile } from '../../hooks/useMobile.ts';
import { BansSection } from './BansSection.tsx';
import { DefaultPrivacySection } from './DefaultPrivacySection.tsx';
import { EmojisSection } from './EmojisSection.tsx';
import { OnboardingSection } from './OnboardingSection.tsx';
import { OverviewSection } from './OverviewSection.tsx';
import { RolesSection } from './RolesSection.tsx';
import { ServerBotsSection } from './ServerBotsSection.tsx';
import { SoundsSection } from './SoundsSection.tsx';
import { SystemMessagesSection } from './SystemMessagesSection.tsx';

const SERVER_SETTINGS_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'roles', label: 'Roles' },
  { id: 'privacy', label: 'Channel Privacy' },
  { id: 'emojis', label: 'Emojis' },
  { id: 'soundboard', label: 'Soundboard' },
  { id: 'bots', label: 'Bots' },
  { id: 'bans', label: 'Bans' },
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'system-messages', label: 'System Messages' },
] as const;

type SectionId = (typeof SERVER_SETTINGS_SECTIONS)[number]['id'];

interface ServerSettingsViewProps {
  serverId: string;
}

export function ServerSettingsView({ serverId }: ServerSettingsViewProps) {
  const isMobile = useMobile();
  const [activeSection, setActiveSection] = useState<SectionId | null>(
    isMobile ? null : 'overview',
  );

  const activeSectionLabel = SERVER_SETTINGS_SECTIONS.find(
    (s) => s.id === activeSection,
  )?.label;

  // Mobile: show nav list or content, not both
  if (isMobile) {
    if (activeSection) {
      return (
        <div className="flex flex-1 min-h-0 flex-col">
          <header className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border/40 px-2">
            <button
              type="button"
              onClick={() => setActiveSection(null)}
              className="p-2 text-text-muted hover:text-text transition-colors"
              aria-label="Back"
            >
              <ArrowLeftIcon size={20} aria-hidden="true" />
            </button>
            <h2 className="flex-1 truncate text-base font-semibold text-text">
              {activeSectionLabel}
            </h2>
          </header>
          <div className="flex-1 overflow-y-auto p-4">
            {renderServerSettingsContent(activeSection, serverId)}
          </div>
        </div>
      );
    }

    return (
      <nav
        className="flex flex-1 flex-col gap-1 overflow-y-auto p-3"
        aria-label="Server settings sections"
      >
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Server Settings
        </h2>
        {SERVER_SETTINGS_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="rounded-md px-3 py-2.5 text-left text-sm text-text-muted hover:bg-bg-surface hover:text-text transition-colors"
            onClick={() => setActiveSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
    );
  }

  // Desktop: side-by-side layout
  return (
    <div className="flex flex-1 min-h-0 min-w-0">
      {/* Settings nav sidebar */}
      <nav
        className="flex w-48 flex-shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-3"
        aria-label="Server settings sections"
      >
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Server Settings
        </h2>
        {SERVER_SETTINGS_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
              activeSection === s.id
                ? 'bg-accent-subtle text-text'
                : 'text-text-muted hover:bg-bg-surface hover:text-text'
            }`}
            onClick={() => setActiveSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {/* Settings content area */}
      <div className="flex-1 overflow-y-auto p-6">
        {renderServerSettingsContent(activeSection, serverId)}
      </div>
    </div>
  );
}

function renderServerSettingsContent(
  section: SectionId | null,
  serverId: string,
) {
  switch (section) {
    case 'overview':
      return <OverviewSection serverId={serverId} />;
    case 'roles':
      return <RolesSection serverId={serverId} />;
    case 'privacy':
      return <DefaultPrivacySection serverId={serverId} />;
    case 'emojis':
      return <EmojisSection serverId={serverId} />;
    case 'soundboard':
      return <SoundsSection serverId={serverId} />;
    case 'bots':
      return <ServerBotsSection serverId={serverId} />;
    case 'bans':
      return <BansSection serverId={serverId} />;
    case 'onboarding':
      return <OnboardingSection serverId={serverId} />;
    case 'system-messages':
      return <SystemMessagesSection serverId={serverId} />;
    default:
      return null;
  }
}
