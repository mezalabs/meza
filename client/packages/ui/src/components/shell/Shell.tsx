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
import {
  LOBBY_SERVER_ID,
  paneCount,
  siblingSwapZone,
  useAuthStore,
  useServerStore,
} from '@meza/core';
import { IconContext } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useKeybinds } from '../../hooks/useKeybinds.ts';
import {
  MAX_PANES,
  useSimpleMode,
  useTilingStore,
} from '../../stores/tiling.ts';
import { ImageViewer } from '../chat/ImageViewer.tsx';
import { PersistentVoiceConnection } from '../voice/PersistentVoiceConnection.tsx';
import { ContentArea } from './ContentArea.tsx';
import { computeDropZone } from './computeDropZone.ts';
import { ShortcutHelpOverlay } from './ShortcutHelpOverlay.tsx';
import { Sidebar } from './Sidebar.tsx';

// --- Type-safe drag data parsing ---
type PaneDragData = { type: 'pane'; paneId: string };
type SidebarDragData = {
  type: 'sidebar';
  content: PaneContent;
  label: string;
};
type MezaDragData = PaneDragData | SidebarDragData;

function parseDragData(
  raw: Record<string, unknown> | undefined,
): MezaDragData | null {
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

const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 420;
const SIDEBAR_STORAGE_KEY = 'meza:sidebarWidth';
function readStoredWidth(): number {
  const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
  if (stored) {
    const n = Number(stored);
    if (n >= SIDEBAR_MIN && n <= SIDEBAR_MAX) return n;
  }
  return SIDEBAR_MIN;
}

export function Shell() {
  const [helpOpen, setHelpOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredWidth);
  const rafId = useRef(0);

  useKeybinds({
    onShowShortcuts: useCallback(() => setHelpOpen(true), []),
  });

  // Auto-open Get Started pane for newly registered users with no servers
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const servers = useServerStore((s) => s.servers);

  useEffect(() => {
    // Only trigger for authenticated users
    if (!isAuthenticated) return;

    // Check if dismissed this session
    if (sessionStorage.getItem('meza:getStartedDismissed') === 'true') return;

    // Check if user only has the Lobby server (or no servers)
    const serverIds = Object.keys(servers);
    const hasNonLobbyServer = serverIds.some((id) => id !== LOBBY_SERVER_ID);
    if (hasNonLobbyServer) return;

    // Open Get Started pane
    const { focusedPaneId, setPaneContent } = useTilingStore.getState();
    setPaneContent(focusedPaneId, { type: 'getStarted' });
  }, [isAuthenticated, servers]);

  const handleSidebarResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);

      const onPointerMove = (moveEvent: PointerEvent) => {
        cancelAnimationFrame(rafId.current);
        rafId.current = requestAnimationFrame(() => {
          const w = Math.round(
            Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, moveEvent.clientX)),
          );
          setSidebarWidth(w);
        });
      };

      const onPointerUp = () => {
        cancelAnimationFrame(rafId.current);
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', onPointerUp);
        // Persist on release
        setSidebarWidth((w) => {
          localStorage.setItem(SIDEBAR_STORAGE_KEY, String(w));
          return w;
        });
      };

      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', onPointerUp);
    },
    [],
  );

  const handleSidebarResizeReset = useCallback(() => {
    setSidebarWidth(SIDEBAR_MIN);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(SIDEBAR_MIN));
  }, []);

  // --- DnD orchestration (wraps both Sidebar and ContentArea) ---
  const swapPanes = useTilingStore((s) => s.swapPanes);
  const movePaneAction = useTilingStore((s) => s.movePane);
  const setPaneContent = useTilingStore((s) => s.setPaneContent);
  const focusPaneDnd = useTilingStore((s) => s.focusPane);
  const splitAtPane = useTilingStore((s) => s.splitAtPane);
  const paneCountInTree = useTilingStore((s) => paneCount(s.root));
  const simpleMode = useSimpleMode();

  const [activeDragPaneId, setActiveDragPaneId] = useState<string | null>(null);
  const [sidebarDrag, setSidebarDrag] = useState<SidebarDragData | null>(null);
  const [overPaneId, setOverPaneId] = useState<string | null>(null);
  const [activeDropZone, setActiveDropZone] = useState<DropPosition | null>(
    null,
  );
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const zoneRef = useRef<DropPosition | null>(null);
  const dragRafId = useRef(0);

  const swapOnly = simpleMode || paneCountInTree >= MAX_PANES;

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
      // Track pointer position immediately (cheap, no state update)
      const activation = event.activatorEvent as PointerEvent | undefined;
      if (activation && event.delta) {
        lastPointerRef.current = {
          x: activation.clientX + event.delta.x,
          y: activation.clientY + event.delta.y,
        };
      }
      const targetPaneId = event.over?.data.current?.paneId;

      // Throttle state updates to animation frames
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
          focusPaneDnd(targetPaneId);
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
      focusPaneDnd,
      splitAtPane,
      clearDragState,
    ],
  );

  const handleDragCancel = useCallback(() => {
    clearDragState();
  }, [clearDragState]);

  return (
    <IconContext.Provider value={{ weight: 'fill' }}>
      <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-bg-base">
        <div className="flex min-h-0 flex-1">
          <DndContext
            sensors={sensors}
            collisionDetection={pointerWithin}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <PersistentVoiceConnection>
              <Sidebar style={{ width: sidebarWidth }} />
              <ContentArea
                resizeHandle={
                  <hr
                    onPointerDown={handleSidebarResize}
                    onDoubleClick={handleSidebarResizeReset}
                    className="absolute left-0 top-0 bottom-0 h-auto w-1.5 z-10 cursor-col-resize select-none border-none bg-transparent transition-colors hover:bg-white/10"
                    aria-orientation="vertical"
                    aria-valuenow={sidebarWidth}
                    aria-valuemin={SIDEBAR_MIN}
                    aria-valuemax={SIDEBAR_MAX}
                    aria-label="Resize sidebar"
                  />
                }
                activeDragPaneId={activeDragPaneId}
                sidebarDragContent={sidebarDrag?.content ?? null}
                sidebarDragLabel={sidebarDrag?.label ?? null}
                overPaneId={overPaneId}
                activeDropZone={activeDropZone}
              />
            </PersistentVoiceConnection>
          </DndContext>
        </div>
        <ShortcutHelpOverlay open={helpOpen} onOpenChange={setHelpOpen} />
        <ImageViewer />
      </div>
    </IconContext.Provider>
  );
}
