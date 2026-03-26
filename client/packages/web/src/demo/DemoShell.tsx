import { useMobile } from '@meza/ui';
import { IconContext } from '@phosphor-icons/react';
import { useState } from 'react';

import { DemoSidebar } from './DemoSidebar.tsx';
import { LandingFeatures } from './LandingFeatures.tsx';
import { LandingGetStarted } from './LandingGetStarted.tsx';
import { LandingWelcome } from './LandingWelcome.tsx';
import type { DemoPaneId } from './types.ts';

function renderPane(paneId: DemoPaneId) {
  switch (paneId) {
    case 'welcome':
      return <LandingWelcome />;
    case 'features':
      return <LandingFeatures />;
    case 'getStarted':
      return <LandingGetStarted />;
  }
}

function DemoDesktopShell() {
  const [focusedSide, setFocusedSide] = useState<'left' | 'right'>('left');
  const [leftContent, setLeftContent] = useState<DemoPaneId>('welcome');
  const [rightContent, setRightContent] = useState<DemoPaneId>('features');

  const handleChannelSelect = (id: DemoPaneId) => {
    if (focusedSide === 'left') {
      setLeftContent(id);
    } else {
      setRightContent(id);
    }
  };

  const currentActive = focusedSide === 'left' ? leftContent : rightContent;

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <DemoSidebar
        activeChannel={currentActive}
        onChannelSelect={handleChannelSelect}
      />

      {/* Tiled content area: two panes side by side */}
      <div className="flex flex-1 min-h-0 min-w-0 flex-row">
        {/* Left pane */}
        <section
          className={`flex min-h-0 min-w-0 overflow-hidden ${focusedSide === 'left' ? 'ring-1 ring-accent/20' : ''}`}
          style={{ flex: 0.5 }}
          onClick={() => setFocusedSide('left')}
          onKeyDown={() => setFocusedSide('left')}
          aria-label="Left pane"
        >
          {renderPane(leftContent)}
        </section>

        {/* Resize handle (visual only, no store dependency) */}
        <div className="w-1.5 flex-shrink-0 cursor-col-resize select-none rounded-sm transition-colors hover:bg-accent/50" />

        {/* Right pane */}
        <section
          className={`flex min-h-0 min-w-0 overflow-hidden ${focusedSide === 'right' ? 'ring-1 ring-accent/20' : ''}`}
          style={{ flex: 0.5 }}
          onClick={() => setFocusedSide('right')}
          onKeyDown={() => setFocusedSide('right')}
          aria-label="Right pane"
        >
          {renderPane(rightContent)}
        </section>
      </div>
    </div>
  );
}

function DemoMobileShell() {
  const [activeChannel, setActiveChannel] = useState<DemoPaneId | null>(null);

  if (activeChannel) {
    return (
      <div className="flex flex-1 min-h-0 flex-col safe-top safe-bottom">
        {/* Back button */}
        <button
          type="button"
          onClick={() => setActiveChannel(null)}
          className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border bg-bg-surface px-3 text-sm text-text-muted hover:text-text transition-colors"
        >
          <span>← Back</span>
        </button>
        <div className="flex flex-1 min-h-0 min-w-0">
          {renderPane(activeChannel)}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 safe-top safe-bottom">
      <DemoSidebar activeChannel="welcome" onChannelSelect={setActiveChannel} />
    </div>
  );
}

export function DemoShell() {
  const isMobile = useMobile();

  return (
    <IconContext.Provider value={{ weight: 'fill' }}>
      <div
        className="flex flex-1 min-h-0 overflow-hidden"
        role="region"
        aria-label="Meza product demo"
      >
        {isMobile ? <DemoMobileShell /> : <DemoDesktopShell />}
      </div>
    </IconContext.Provider>
  );
}

export default DemoShell;
