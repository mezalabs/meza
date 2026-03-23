import {
  ActionKind,
  type AutocompleteAction,
  autocomplete,
} from 'prosemirror-autocomplete';

export type TriggerName = 'mention' | 'channel' | 'emoji' | 'slash';

export interface AutocompleteCallbacks {
  onOpen: (
    trigger: TriggerName,
    query: string,
    range: { from: number; to: number },
  ) => void;
  onUpdate: (
    trigger: TriggerName,
    query: string,
    range: { from: number; to: number },
  ) => void;
  onClose: (trigger: TriggerName) => void;
}

export function createAutocompletePlugins(callbacks: AutocompleteCallbacks) {
  return autocomplete({
    triggers: [
      { name: 'mention', trigger: '@' },
      { name: 'channel', trigger: '#' },
      { name: 'emoji', trigger: ':', cancelOnFirstSpace: true },
      { name: 'slash', trigger: '/' },
    ],
    reducer(action: AutocompleteAction) {
      if (action.view.composing) return false;

      const triggerName = (action.type?.name ?? 'mention') as TriggerName;
      const query = action.filter ?? '';
      const range = action.range;

      switch (action.kind) {
        case ActionKind.open:
          callbacks.onOpen(triggerName, query, range);
          return true;
        case ActionKind.filter:
          callbacks.onUpdate(triggerName, query, range);
          return true;
        case ActionKind.close:
          callbacks.onClose(triggerName);
          return true;
        // Arrow/Enter/Escape are handled by EditorView.handleKeyDown
        // which fires BEFORE plugin handleKeyDown. Return false so the
        // plugin doesn't also try to handle them.
        default:
          return false;
      }
    },
  });
}
