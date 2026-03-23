import { useAuthStore, useMemberStore, useRoleStore } from '@meza/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveDisplayName } from '../../hooks/useDisplayName.ts';
import { roleColorHex } from '../../utils/color.ts';

interface MentionItem {
  type: 'user' | 'role' | 'everyone';
  id: string;
  displayName: string;
  insertText: string;
  color?: number;
}

interface MentionAutocompleteProps {
  query: string;
  serverId?: string;
  onSelect: (item: MentionItem) => void;
  onClose: () => void;
  position: { bottom: number; left: number };
}

const MAX_RESULTS = 10;
const EMPTY_MEMBERS: ReturnType<
  typeof useMemberStore.getState
>['byServer'][string] = [];
const EMPTY_ROLES: ReturnType<
  typeof useRoleStore.getState
>['byServer'][string] = [];

export function MentionAutocomplete({
  query,
  serverId,
  onSelect,
  onClose,
  position,
}: MentionAutocompleteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const members = useMemberStore((s) =>
    serverId ? (s.byServer[serverId] ?? EMPTY_MEMBERS) : EMPTY_MEMBERS,
  );

  const currentUserId = useAuthStore((s) => s.user?.id);

  const roles = useRoleStore((s) =>
    serverId ? (s.byServer[serverId] ?? EMPTY_ROLES) : EMPTY_ROLES,
  );

  const items = useMemo(() => {
    const lowerQuery = query.toLowerCase();
    const results: MentionItem[] = [];

    // Always show @everyone in autocomplete; the server silently strips it
    // if the sender lacks MentionEveryone permission.
    if (serverId && 'everyone'.startsWith(lowerQuery)) {
      results.push({
        type: 'everyone',
        id: '',
        displayName: 'everyone',
        insertText: '@everyone',
      });
    }

    // Show matching roles.
    for (const role of roles) {
      if (results.length >= MAX_RESULTS) break;
      if (role.name.toLowerCase().startsWith(lowerQuery) || !lowerQuery) {
        results.push({
          type: 'role',
          id: role.id,
          displayName: role.name,
          insertText: `<@&${role.id}>`,
          color: role.color,
        });
      }
    }

    // Filter members by nickname (which includes display name fallback).
    let matched = 0;
    for (const member of members) {
      if (matched >= MAX_RESULTS - results.length) break;
      if (member.userId === currentUserId) continue;
      const name =
        member.nickname || resolveDisplayName(member.userId, serverId);
      if (name.toLowerCase().startsWith(lowerQuery) || !lowerQuery) {
        // Find highest-positioned role color for this member
        let memberColor: number | undefined;
        for (const role of roles) {
          if (member.roleIds.includes(role.id) && role.color) {
            memberColor = role.color;
            break; // roles sorted by position desc
          }
        }
        results.push({
          type: 'user',
          id: member.userId,
          displayName: name,
          insertText: `<@${member.userId}>`,
          color: memberColor,
        });
        matched++;
      }
    }

    return results;
  }, [query, members, roles, currentUserId, serverId]);

  // Reset selection when query changes (which drives item changes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on query change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll selected item into view.
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Keyboard navigation: arrow keys only for highlighting.
  // Enter/Tab/Escape are handled by prosemirror-autocomplete plugin.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        // Let ProseMirror handle this — select the current item
        if (items.length > 0) {
          e.preventDefault();
          onSelect(items[selectedIndex]);
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [items, selectedIndex, onSelect]);

  if (items.length === 0) return null;

  return (
    <div
      className="absolute z-50 w-64 max-h-48 overflow-y-auto rounded-md border border-border bg-bg-elevated shadow-lg"
      style={{ bottom: position.bottom, left: position.left }}
      ref={listRef}
    >
      {items.map((item, i) => (
        <button
          key={
            item.type === 'everyone' ? '@everyone' : `${item.type}-${item.id}`
          }
          type="button"
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
            i === selectedIndex
              ? 'bg-accent/15 text-accent'
              : 'text-text hover:bg-bg-surface'
          }`}
          onMouseDown={(e) => {
            e.preventDefault(); // Don't steal focus from textarea.
            onSelect(item);
          }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          {item.type === 'everyone' ? (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/20 text-xs font-bold text-accent">
              @
            </span>
          ) : item.type === 'role' ? (
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold"
              style={
                item.color
                  ? {
                      backgroundColor: `${roleColorHex(item.color)}30`,
                      color: roleColorHex(item.color),
                    }
                  : undefined
              }
            >
              R
            </span>
          ) : (
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full bg-bg-surface text-xs font-medium text-text-muted"
              style={
                item.color ? { color: roleColorHex(item.color) } : undefined
              }
            >
              {item.displayName[0]?.toUpperCase() ?? '?'}
            </span>
          )}
          <span
            className="truncate"
            style={
              item.type !== 'everyone' && item.color && i !== selectedIndex
                ? { color: roleColorHex(item.color) }
                : undefined
            }
          >
            {item.type === 'everyone' ? '@everyone' : item.displayName}
          </span>
        </button>
      ))}
    </div>
  );
}
