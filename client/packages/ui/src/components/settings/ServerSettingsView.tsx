import { useState } from 'react';
import { BansSection } from './BansSection.tsx';
import { DefaultPrivacySection } from './DefaultPrivacySection.tsx';
import { EmojisSection } from './EmojisSection.tsx';
import { OnboardingSection } from './OnboardingSection.tsx';
import { RolesSection } from './RolesSection.tsx';
import { SoundsSection } from './SoundsSection.tsx';

const SERVER_SETTINGS_SECTIONS = [
  { id: 'roles', label: 'Roles' },
  { id: 'privacy', label: 'Channel Privacy' },
  { id: 'emojis', label: 'Emojis' },
  { id: 'soundboard', label: 'Soundboard' },
  { id: 'bans', label: 'Bans' },
  { id: 'onboarding', label: 'Onboarding' },
] as const;

type SectionId = (typeof SERVER_SETTINGS_SECTIONS)[number]['id'];

interface ServerSettingsViewProps {
  serverId: string;
}

export function ServerSettingsView({ serverId }: ServerSettingsViewProps) {
  const [activeSection, setActiveSection] = useState<SectionId>('roles');

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
        {activeSection === 'roles' && <RolesSection serverId={serverId} />}
        {activeSection === 'privacy' && (
          <DefaultPrivacySection serverId={serverId} />
        )}
        {activeSection === 'emojis' && <EmojisSection serverId={serverId} />}
        {activeSection === 'soundboard' && (
          <SoundsSection serverId={serverId} />
        )}
        {activeSection === 'bans' && <BansSection serverId={serverId} />}
        {activeSection === 'onboarding' && (
          <OnboardingSection serverId={serverId} />
        )}
      </div>
    </div>
  );
}
