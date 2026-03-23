import { useAuthStore, useMemberStore, useRoleStore } from '@meza/core';
import { useEffect, useMemo, useRef } from 'react';
import { resolveDisplayName } from '../../hooks/useDisplayName.ts';
import { roleColorHex } from '../../utils/color.ts';

export interface MentionItem {
  type: 'user' | 'role' | 'everyone';
  id: string;
  displayName: string;
  insertText: string;
  color?: number;
}

interface MentionAutocompleteProps {
  query: string;
  serverId?: string;
  /** Controlled highlight index (driven by prosemirror-autocomplete arrow keys). */
  selectedIndex: number;
  onSelect: (item: MentionItem) => void;
  position: { bottom: number; left: number };
  /** Optional ref to expose the current items array to the parent. */
  itemsRef?: React.MutableRefObject<MentionItem[]>;
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
  selectedIndex,
  onSelect,
  position,
  itemsRef,
}: MentionAutocompleteProps) {
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

    if (serverId && 'everyone'.startsWith(lowerQuery)) {
      results.push({
        type: 'everyone',
        id: '',
        displayName: 'everyone',
        insertText: '@everyone',
      });
    }

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

    let matched = 0;
    for (const member of members) {
      if (matched >= MAX_RESULTS - results.length) break;
      if (member.userId === currentUserId) continue;
      const name =
        member.nickname || resolveDisplayName(member.userId, serverId);
      if (name.toLowerCase().startsWith(lowerQuery) || !lowerQuery) {
        let memberColor: number | undefined;
        for (const role of roles) {
          if (member.roleIds.includes(role.id) && role.color) {
            memberColor = role.color;
            break;
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

  // Expose items to parent for Enter-key selection
  if (itemsRef) itemsRef.current = items;

  // Clamp selectedIndex to valid range
  const clampedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));

  // Scroll selected item into view.
  useEffect(() => {
    const el = listRef.current?.children[clampedIndex] as HTMLElement;
    el?.scrollIntoView({ block: 'nearest' });
  }, [clampedIndex]);

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
            i === clampedIndex
              ? 'bg-accent/15 text-accent'
              : 'text-text hover:bg-bg-surface'
          }`}
          onMouseDown={(e) => {
            e.preventDefault(); // Don't steal focus from editor.
            onSelect(item);
          }}
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
              item.type !== 'everyone' && item.color && i !== clampedIndex
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
