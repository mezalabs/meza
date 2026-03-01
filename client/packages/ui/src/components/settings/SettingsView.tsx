import { gatewayDisconnect, logout } from '@meza/core';
import { SignOutIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { AccountSection } from './AccountSection.tsx';
import { AppearanceSection } from './AppearanceSection.tsx';
import { DevicesSection } from './DevicesSection.tsx';
import { EmojisSection } from './EmojisSection.tsx';
import { NotificationsSection } from './NotificationsSection.tsx';
import { PrivacySection } from './PrivacySection.tsx';
import { SoundsSection } from './SoundsSection.tsx';
import { StreamingSection } from './StreamingSection.tsx';
import { VoiceAudioSection } from './VoiceAudioSection.tsx';

const SETTINGS_SECTIONS = [
  { id: 'account', label: 'Account & Profile' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'devices', label: 'Devices' },
  { id: 'voice', label: 'Voice & Audio' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'emojis', label: 'My Emojis' },
  { id: 'soundboard', label: 'Soundboard' },
] as const;

type SectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

interface SettingsViewProps {
  section?: string;
}

export function SettingsView({ section }: SettingsViewProps) {
  const [activeSection, setActiveSection] = useState<SectionId>(
    (section as SectionId) || 'account',
  );

  return (
    <div className="flex flex-1 min-h-0 min-w-0">
      {/* Settings nav sidebar */}
      <nav
        className="flex w-48 flex-shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-3"
        aria-label="Settings sections"
      >
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Settings
        </h2>
        {SETTINGS_SECTIONS.map((s) => (
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
        <button
          type="button"
          className="mt-auto flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text-muted hover:bg-bg-surface hover:text-danger transition-colors"
          onClick={() => {
            gatewayDisconnect();
            logout();
          }}
          aria-label="Log out"
        >
          <SignOutIcon size={14} aria-hidden="true" />
          Log Out
        </button>
      </nav>

      {/* Settings content area */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeSection === 'account' && <AccountSection />}
        {activeSection === 'appearance' && <AppearanceSection />}
        {activeSection === 'notifications' && <NotificationsSection />}
        {activeSection === 'privacy' && <PrivacySection />}
        {activeSection === 'devices' && <DevicesSection />}
        {activeSection === 'voice' && <VoiceAudioSection />}
        {activeSection === 'streaming' && <StreamingSection />}
        {activeSection === 'emojis' && <EmojisSection />}
        {activeSection === 'soundboard' && <SoundsSection />}
      </div>
    </div>
  );
}
