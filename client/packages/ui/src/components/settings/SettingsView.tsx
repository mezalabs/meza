import { gatewayDisconnect, logout } from '@meza/core';
import { ArrowLeftIcon, SignOutIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useAppVersion } from '../../hooks/useAppVersion.ts';
import { useMobile } from '../../hooks/useMobile.ts';
import { AccountSection } from './AccountSection.tsx';
import { AppearanceSection } from './AppearanceSection.tsx';
import { BotsSection } from './BotsSection.tsx';
import { DevicesSection } from './DevicesSection.tsx';
import { EmojisSection } from './EmojisSection.tsx';
import { KeybindsSection } from './KeybindsSection.tsx';
import { NotificationsSection } from './NotificationsSection.tsx';
import { PrivacySection } from './PrivacySection.tsx';
import { SecuritySection } from './SecuritySection.tsx';
import { SoundsSection } from './SoundsSection.tsx';
import { StreamingSection } from './StreamingSection.tsx';
import { VoiceAudioSection } from './VoiceAudioSection.tsx';

const SETTINGS_SECTIONS = [
  { id: 'account', label: 'Account & Profile' },
  { id: 'security', label: 'Security' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'keybinds', label: 'Keybinds' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'devices', label: 'Devices' },
  { id: 'voice', label: 'Voice & Audio' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'emojis', label: 'My Emojis' },
  { id: 'soundboard', label: 'Soundboard' },
  { id: 'bots', label: 'My Bots' },
] as const;

type SectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

interface SettingsViewProps {
  section?: string;
}

export function SettingsView({ section }: SettingsViewProps) {
  const isMobile = useMobile();
  const [activeSection, setActiveSection] = useState<SectionId | null>(
    isMobile ? null : (section as SectionId) || 'account',
  );
  const [copied, setCopied] = useState(false);
  const version = useAppVersion();

  const activeSectionLabel = SETTINGS_SECTIONS.find(
    (s) => s.id === activeSection,
  )?.label;

  const handleCopyVersion = () => {
    navigator.clipboard?.writeText(`v${version}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

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
            {renderSettingsContent(activeSection)}
          </div>
        </div>
      );
    }

    return (
      <nav
        className="flex flex-1 flex-col gap-1 overflow-y-auto p-3"
        aria-label="Settings sections"
      >
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Settings
        </h2>
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="rounded-md px-3 py-2.5 text-left text-sm text-text-muted hover:bg-bg-surface hover:text-text transition-colors"
            onClick={() => setActiveSection(s.id)}
          >
            {s.label}
          </button>
        ))}
        <div className="mt-auto flex flex-col gap-1">
          <button
            type="button"
            className="px-3 py-1 text-xs text-text-subtle hover:text-text-muted transition-colors"
            onClick={handleCopyVersion}
            aria-label={`Version ${version}. Click to copy.`}
          >
            {copied ? 'Copied!' : `v${version}`}
          </button>
          <button
            type="button"
            className="flex items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm text-text-muted hover:bg-bg-surface hover:text-danger transition-colors"
            onClick={() => {
              gatewayDisconnect();
              logout();
            }}
            aria-label="Log out"
          >
            <SignOutIcon size={14} aria-hidden="true" />
            Log Out
          </button>
        </div>
      </nav>
    );
  }

  // Desktop: side-by-side layout
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
        <div className="mt-auto flex flex-col gap-1">
          <button
            type="button"
            className="px-2 py-1 text-xs text-text-subtle hover:text-text-muted transition-colors"
            onClick={handleCopyVersion}
            aria-label={`Version ${version}. Click to copy.`}
          >
            {copied ? 'Copied!' : `v${version}`}
          </button>
          <button
            type="button"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text-muted hover:bg-bg-surface hover:text-danger transition-colors"
            onClick={() => {
              gatewayDisconnect();
              logout();
            }}
            aria-label="Log out"
          >
            <SignOutIcon size={14} aria-hidden="true" />
            Log Out
          </button>
        </div>
      </nav>

      {/* Settings content area */}
      <div className="flex-1 overflow-y-auto p-6">
        {renderSettingsContent(activeSection)}
      </div>
    </div>
  );
}

function renderSettingsContent(section: SectionId | null) {
  switch (section) {
    case 'account':
      return <AccountSection />;
    case 'security':
      return <SecuritySection />;
    case 'appearance':
      return <AppearanceSection />;
    case 'keybinds':
      return <KeybindsSection />;
    case 'notifications':
      return <NotificationsSection />;
    case 'privacy':
      return <PrivacySection />;
    case 'devices':
      return <DevicesSection />;
    case 'voice':
      return <VoiceAudioSection />;
    case 'streaming':
      return <StreamingSection />;
    case 'emojis':
      return <EmojisSection />;
    case 'soundboard':
      return <SoundsSection />;
    case 'bots':
      return <BotsSection />;
    default:
      return null;
  }
}
