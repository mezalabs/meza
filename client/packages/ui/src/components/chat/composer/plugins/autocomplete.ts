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
  /** Arrow key navigation inside the popup. */
  onArrow: (direction: 'up' | 'down') => void;
  /** User pressed Enter/Tab to confirm the highlighted item. */
  onSelect: () => void;
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
          callbacks.onArrow('up');
          return true;
        case ActionKind.down:
          callbacks.onArrow('down');
          return true;
        case ActionKind.enter:
          callbacks.onSelect();
          return true;
        default:
          return false;
      }
    },
  });
}
