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
        case ActionKind.up:
        case ActionKind.down:
        case ActionKind.enter:
          return true;
        default:
          return false;
      }
    },
  });
}
