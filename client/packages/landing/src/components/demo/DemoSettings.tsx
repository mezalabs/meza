import { useState } from 'react';
import type { DemoSettingsSection } from './types';

interface DemoSettingsProps {
  sections: DemoSettingsSection[];
}

function AppearanceContent() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-3 text-sm font-semibold text-text">Theme</h3>
        <div className="flex gap-3">
          <div className="flex flex-col items-center gap-1.5">
            <div className="h-12 w-20 rounded-md border-2 border-accent bg-bg-base" />
            <span className="text-xs text-accent">Dark</span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <div className="h-12 w-20 rounded-md border border-border bg-white" />
            <span className="text-xs text-text-subtle">Light</span>
          </div>
        </div>
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-text">Emoji Size</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-muted">Small</span>
          <div className="h-1.5 flex-1 rounded-full bg-bg-elevated">
            <div className="h-1.5 w-3/5 rounded-full bg-accent" />
          </div>
          <span className="text-xs text-text-muted">Large</span>
        </div>
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-text">Font Size</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-muted">12px</span>
          <div className="h-1.5 flex-1 rounded-full bg-bg-elevated">
            <div className="h-1.5 w-2/5 rounded-full bg-accent" />
          </div>
          <span className="text-xs text-text-muted">20px</span>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text">Compact Mode</h3>
            <p className="text-xs text-text-muted">
              Reduce spacing between messages
            </p>
          </div>
          <div className="h-5 w-9 rounded-full bg-bg-elevated p-0.5">
            <div className="h-4 w-4 rounded-full bg-text-subtle transition-transform" />
          </div>
        </div>
      </div>
    </div>
  );
}

function PlaceholderContent({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-text-subtle">
      {label} settings
    </div>
  );
}

export function DemoSettings({ sections }: DemoSettingsProps) {
  const [activeSection, setActiveSection] = useState('appearance');

  return (
    <div className="flex flex-1">
      {/* Settings sidebar */}
      <nav
        className="w-40 flex-shrink-0 border-r border-border bg-bg-overlay p-2"
        aria-label="Settings navigation"
      >
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => setActiveSection(section.id)}
            className={`flex w-full items-center rounded-md px-3 py-1.5 text-sm transition-colors ${
              section.id === activeSection
                ? 'bg-bg-elevated text-text'
                : 'text-text-muted hover:bg-bg-surface hover:text-text'
            }`}
          >
            {section.label}
          </button>
        ))}
      </nav>

      {/* Settings content */}
      <div className="flex-1 p-6">
        <h2 className="mb-6 text-lg font-semibold text-text">
          {sections.find((s) => s.id === activeSection)?.label}
        </h2>
        {activeSection === 'appearance' ? (
          <AppearanceContent />
        ) : (
          <PlaceholderContent
            label={sections.find((s) => s.id === activeSection)?.label ?? ''}
          />
        )}
      </div>
    </div>
  );
}
