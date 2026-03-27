import type {
  DragEndEvent,
  DragMoveEvent,
  DragStartEvent,
} from '@dnd-kit/core';
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DropPosition, PaneContent } from '@meza/core';
import { paneCount, siblingSwapZone } from '@meza/core';
import {
  computeDropZone,
  Pane,
  PaneSlot,
  TilingRenderer,
  useMobile,
  useTilingStore,
} from '@meza/ui';
import {
  Hash as HashIcon,
  SignIn as SignInIcon,
  Star as StarIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DemoSidebar } from './DemoSidebar.tsx';
import { LandingFeatures } from './LandingFeatures.tsx';
import { LandingGetStarted } from './LandingGetStarted.tsx';
import { LandingWelcome } from './LandingWelcome.tsx';
import type { DemoPaneId } from './types.ts';
import { demoPaneContent, demoPaneIdFromContent } from './types.ts';

const MAX_PANES = 8;

// --- Pane metadata for demo channels ---
function getDemoPaneMeta(content: PaneContent | undefined) {
  const id = demoPaneIdFromContent(content);
  switch (id) {
    case 'welcome':
      return {
        label: 'welcome',
        icon: <HashIcon size={14} weight="regular" />,
        serverName: 'Meza',
      };
    case 'features':
      return {
        label: 'features',
        icon: <StarIcon size={14} weight="fill" />,
        serverName: 'Meza',
      };
    case 'getStarted':
      return {
        label: 'Sign in',
        icon: <SignInIcon size={14} weight="regular" />,
        serverName: undefined,
      };
  }
}

function renderDemoContent(content: PaneContent | undefined) {
  const id = demoPaneIdFromContent(content);
  switch (id) {
    case 'welcome':
      return <LandingWelcome />;
    case 'features':
      return <LandingFeatures />;
    case 'getStarted':
      return <LandingGetStarted />;
  }
}

// --- DnD drag data types (matching real Shell) ---
type PaneDragData = { type: 'pane'; paneId: string };
type SidebarDragData = {
  type: 'sidebar';
  content: PaneContent;
  label: string;
};
type DemoDragData = PaneDragData | SidebarDragData;

function parseDragData(
  raw: Record<string, unknown> | undefined,
): DemoDragData | null {
  if (!raw) return null;
  if (raw.type === 'pane' && typeof raw.paneId === 'string') {
    return { type: 'pane', paneId: raw.paneId };
  }
  if (raw.type === 'sidebar' && raw.content) {
    return {
      type: 'sidebar',
      content: raw.content as PaneContent,
      label: String(raw.label ?? ''),
    };
  }
  return null;
}

function DemoDesktopShell() {
  const root = useTilingStore((s) => s.root);
  const panes = useTilingStore((s) => s.panes);
  const focusedPaneId = useTilingStore((s) => s.focusedPaneId);
  const focusPane = useTilingStore((s) => s.focusPane);
  const closePane = useTilingStore((s) => s.closePane);
  const swapPanes = useTilingStore((s) => s.swapPanes);
  const movePaneAction = useTilingStore((s) => s.movePane);
  const setPaneContent = useTilingStore((s) => s.setPaneContent);
  const splitAtPane = useTilingStore((s) => s.splitAtPane);
  const paneCountValue = paneCount(root);

  // --- DnD state ---
  const [activeDragPaneId, setActiveDragPaneId] = useState<string | null>(null);
  const [, setSidebarDrag] = useState<SidebarDragData | null>(null);
  const [overPaneId, setOverPaneId] = useState<string | null>(null);
  const [activeDropZone, setActiveDropZone] = useState<DropPosition | null>(
    null,
  );
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const zoneRef = useRef<DropPosition | null>(null);
  const dragRafId = useRef(0);
  const swapOnly = paneCountValue >= MAX_PANES;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const computeZoneForTarget = useCallback(
    (targetPaneId: string) => {
      const el = document.querySelector(`[data-pane-id="${targetPaneId}"]`);
      if (!el || !lastPointerRef.current) return 'center' as DropPosition;
      const rect = el.getBoundingClientRect();
      return computeDropZone(
        lastPointerRef.current.x,
        lastPointerRef.current.y,
        rect,
        swapOnly,
        zoneRef.current,
      );
    },
    [swapOnly],
  );

  const setZone = useCallback((zone: DropPosition | null) => {
    zoneRef.current = zone;
    setActiveDropZone(zone);
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = parseDragData(event.active.data.current);
    if (!data) return;
    if (data.type === 'pane') {
      setActiveDragPaneId(data.paneId);
    } else {
      setSidebarDrag(data);
    }
  }, []);

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const activation = event.activatorEvent as PointerEvent | undefined;
      if (activation && event.delta) {
        lastPointerRef.current = {
          x: activation.clientX + event.delta.x,
          y: activation.clientY + event.delta.y,
        };
      }
      const targetPaneId = event.over?.data.current?.paneId;
      cancelAnimationFrame(dragRafId.current);
      dragRafId.current = requestAnimationFrame(() => {
        if (typeof targetPaneId !== 'string') {
          setOverPaneId(null);
          setZone(null);
          return;
        }
        setOverPaneId(targetPaneId);
        setZone(computeZoneForTarget(targetPaneId));
      });
    },
    [computeZoneForTarget, setZone],
  );

  const clearDragState = useCallback(() => {
    cancelAnimationFrame(dragRafId.current);
    setActiveDragPaneId(null);
    setSidebarDrag(null);
    setOverPaneId(null);
    setZone(null);
    lastPointerRef.current = null;
  }, [setZone]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const data = parseDragData(event.active.data.current);
      const targetPaneId =
        typeof event.over?.data.current?.paneId === 'string'
          ? event.over.data.current.paneId
          : undefined;
      const zone = zoneRef.current;

      if (data?.type === 'pane') {
        if (targetPaneId && data.paneId !== targetPaneId && zone) {
          const currentRoot = useTilingStore.getState().root;
          const siblingZone = siblingSwapZone(
            currentRoot,
            data.paneId,
            targetPaneId,
          );
          if (zone === 'center' || zone === siblingZone) {
            swapPanes(data.paneId, targetPaneId);
          } else {
            movePaneAction(data.paneId, targetPaneId, zone);
          }
        }
      } else if (data?.type === 'sidebar' && targetPaneId && zone) {
        if (zone === 'center') {
          setPaneContent(targetPaneId, data.content);
          focusPane(targetPaneId);
        } else {
          splitAtPane(targetPaneId, data.content, zone);
        }
      }

      clearDragState();
    },
    [
      swapPanes,
      movePaneAction,
      setPaneContent,
      focusPane,
      splitAtPane,
      clearDragState,
    ],
  );

  // Resolve the active sidebar channel from focused pane's content
  const focusedContent = panes[focusedPaneId];
  const activeSidebarChannel = demoPaneIdFromContent(focusedContent);
  const isDMActive = activeSidebarChannel === 'getStarted';

  // Sidebar channel click: set focused pane content
  const handleChannelSelect = useCallback(
    (id: DemoPaneId) => {
      setPaneContent(focusedPaneId, demoPaneContent(id));
    },
    [focusedPaneId, setPaneContent],
  );

  // DM icon click: open sign-in pane
  const handleDMClick = useCallback(() => {
    setPaneContent(focusedPaneId, demoPaneContent('getStarted'));
  }, [focusedPaneId, setPaneContent]);

  const renderPane = useCallback(
    (paneId: string) => {
      const content = panes[paneId];
      const meta = getDemoPaneMeta(content);
      const isActiveDragSource = activeDragPaneId === paneId;
      const showDropZone =
        overPaneId === paneId && activeDropZone && !isActiveDragSource;
      const showClose = paneCountValue > 1;

      return (
        <PaneSlot paneId={paneId} isDragging={isActiveDragSource}>
          <Pane
            label={meta.label}
            icon={meta.icon}
            serverName={meta.serverName}
            focused={paneId === focusedPaneId}
            showClose={showClose}
            onClose={() => closePane(paneId)}
            onFocus={() => focusPane(paneId)}
            paneId={paneId}
            isDragSource={isActiveDragSource}
            dropZone={showDropZone ? activeDropZone : null}
          >
            {renderDemoContent(content)}
          </Pane>
        </PaneSlot>
      );
    },
    [
      panes,
      focusedPaneId,
      activeDragPaneId,
      overPaneId,
      activeDropZone,
      paneCountValue,
      closePane,
      focusPane,
    ],
  );

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={clearDragState}
      >
        <DemoSidebar
          activeChannel={activeSidebarChannel}
          onChannelSelect={handleChannelSelect}
          isDMActive={isDMActive}
          onDMClick={handleDMClick}
        />
        <div className="relative flex flex-1 min-h-0 min-w-0">
          <TilingRenderer node={root} renderPane={renderPane} />
        </div>
      </DndContext>
    </div>
  );
}

function DemoMobileShell() {
  const panes = useTilingStore((s) => s.panes);
  const focusedPaneId = useTilingStore((s) => s.focusedPaneId);
  const setPaneContent = useTilingStore((s) => s.setPaneContent);
  const [showContent, setShowContent] = useState(false);

  const handleChannelSelect = useCallback(
    (id: DemoPaneId) => {
      setPaneContent(focusedPaneId, demoPaneContent(id));
      setShowContent(true);
    },
    [focusedPaneId, setPaneContent],
  );

  const activeSidebarChannel = demoPaneIdFromContent(panes[focusedPaneId]);
  const isDMActive = activeSidebarChannel === 'getStarted';

  const handleDMClick = useCallback(() => {
    setPaneContent(focusedPaneId, demoPaneContent('getStarted'));
    setShowContent(true);
  }, [focusedPaneId, setPaneContent]);

  if (showContent) {
    return (
      <div className="flex flex-1 min-h-0 flex-col safe-top safe-bottom">
        <button
          type="button"
          onClick={() => setShowContent(false)}
          className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border bg-bg-surface px-3 text-sm text-text-muted hover:text-text transition-colors"
        >
          <span>← Back</span>
        </button>
        <div className="flex flex-1 min-h-0 min-w-0">
          {renderDemoContent(panes[focusedPaneId])}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 safe-top safe-bottom">
      <DemoSidebar
        activeChannel={activeSidebarChannel}
        onChannelSelect={handleChannelSelect}
        isDMActive={isDMActive}
        onDMClick={handleDMClick}
      />
    </div>
  );
}

/** Seed the tiling store with demo layout, clean up on unmount. */
function useDemoTilingSetup() {
  useEffect(() => {
    const store = useTilingStore.getState();
    // Seed a two-pane horizontal split
    const pane1 = 'demo-pane-1';
    const pane2 = 'demo-pane-2';
    useTilingStore.setState({
      root: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'pane', id: pane1 },
        second: { type: 'pane', id: pane2 },
      },
      panes: {
        [pane1]: demoPaneContent('welcome'),
        [pane2]: demoPaneContent('features'),
      },
      focusedPaneId: pane1,
    });
    return () => {
      store.resetLayout();
    };
  }, []);
}

export function DemoShell() {
  const isMobile = useMobile();
  useDemoTilingSetup();

  return isMobile ? <DemoMobileShell /> : <DemoDesktopShell />;
}

export default DemoShell;
