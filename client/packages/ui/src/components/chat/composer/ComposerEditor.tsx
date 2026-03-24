import { useNodeViewFactory } from '@prosemirror-adapter/react';
import { closeAutocomplete as closeAcPlugin } from 'prosemirror-autocomplete';
import { baseKeymap } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { EditorState, Plugin, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChannelLinkNodeView } from './nodeviews/ChannelLinkNodeView.tsx';
import { CustomEmojiNodeView } from './nodeviews/CustomEmojiNodeView.tsx';
import { MentionNodeView } from './nodeviews/MentionNodeView.tsx';
import {
  type AutocompleteCallbacks,
  createAutocompletePlugins,
  type TriggerName,
} from './plugins/autocomplete.ts';
import {
  type ComposerEditorHandle,
  composerSchema,
  type WireFormatText,
} from './schema.ts';
import {
  deserializeText,
  serializeDoc,
  wireFormatLength,
} from './serialize.ts';

// ---------------------------------------------------------------------------
// Draft persistence: module-level Map (in-memory only, never persisted to disk)
// Drafts are plaintext outside the E2EE boundary — do NOT add localStorage.
// ---------------------------------------------------------------------------
const draftMap = new Map<string, string>();

// ---------------------------------------------------------------------------
// Max-length transaction filter plugin (uses wireFormatLength, not serializeDoc)
// ---------------------------------------------------------------------------
const MAX_LENGTH = 4000;

function maxLengthPlugin(): Plugin {
  return new Plugin({
    filterTransaction: (tr: Transaction) => {
      if (!tr.docChanged) return true;
      return wireFormatLength(tr.doc) <= MAX_LENGTH;
    },
  });
}

// ---------------------------------------------------------------------------
// Placeholder decoration plugin
// ---------------------------------------------------------------------------
function placeholderPlugin(textRef: { current: string }): Plugin {
  const emptyDoc = (state: EditorState) => {
    const { doc } = state;
    return (
      doc.childCount === 1 &&
      doc.firstChild?.isTextblock &&
      doc.firstChild.content.size === 0
    );
  };

  return new Plugin({
    props: {
      decorations(state: EditorState) {
        if (emptyDoc(state)) {
          return DecorationSet.create(state.doc, [
            Decoration.widget(1, () => {
              const span = document.createElement('span');
              span.className =
                'pointer-events-none text-text-subtle select-none';
              span.textContent = textRef.current;
              span.style.position = 'absolute';
              return span;
            }),
          ]);
        }
        return DecorationSet.empty;
      },
    },
  });
}

// ---------------------------------------------------------------------------
// ComposerEditor props
// ---------------------------------------------------------------------------
interface ComposerEditorProps {
  initialText?: string;
  onSend: (wireText: string) => void | Promise<void>;
  onCancel?: () => void;
  onTyping?: () => void;
  placeholder?: string;
  channelId: string;
  autoFocus?: boolean;
  onAutocompleteChange?: (state: AutocompleteState) => void;
  /** Called when the user presses arrow keys while autocomplete is open. */
  onAutocompleteArrow?: (direction: 'up' | 'down') => void;
  /** Called when the user presses Enter/Tab to confirm the autocomplete selection. */
  onAutocompleteSelect?: () => void;
}

// ---------------------------------------------------------------------------
// Autocomplete state
// ---------------------------------------------------------------------------
interface AutocompleteState {
  trigger: TriggerName | null;
  query: string;
  range: { from: number; to: number } | null;
}

// ---------------------------------------------------------------------------
// ComposerEditor
// ---------------------------------------------------------------------------
export const ComposerEditor = forwardRef<
  ComposerEditorHandle,
  ComposerEditorProps
>(function ComposerEditor(
  {
    initialText,
    onSend,
    onCancel,
    onTyping,
    placeholder = 'Type a message\u2026',
    channelId,
    autoFocus,
    onAutocompleteChange,
    onAutocompleteArrow,
    onAutocompleteSelect,
  },
  ref,
) {
  const viewRef = useRef<EditorView | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const originalTextRef = useRef(initialText ?? '');
  const sendingRef = useRef(false);
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;

  // Stable refs for callbacks to avoid stale closures in EditorView
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const onAutocompleteChangeRef = useRef(onAutocompleteChange);
  onAutocompleteChangeRef.current = onAutocompleteChange;
  const onAutocompleteArrowRef = useRef(onAutocompleteArrow);
  onAutocompleteArrowRef.current = onAutocompleteArrow;
  const onAutocompleteSelectRef = useRef(onAutocompleteSelect);
  onAutocompleteSelectRef.current = onAutocompleteSelect;
  const [autocomplete, setAutocomplete] = useState<AutocompleteState>({
    trigger: null,
    query: '',
    range: null,
  });
  const autocompleteRangeRef = useRef<{ from: number; to: number } | null>(
    null,
  );

  const nodeViewFactory = useNodeViewFactory();

  // Stable nodeViews object
  const nodeViews = useMemo(
    () => ({
      mention: nodeViewFactory({ component: MentionNodeView, as: 'span' }),
      customEmoji: nodeViewFactory({
        component: CustomEmojiNodeView,
        as: 'span',
      }),
      channelLink: nodeViewFactory({
        component: ChannelLinkNodeView,
        as: 'span',
      }),
    }),
    [nodeViewFactory],
  );

  // Autocomplete callbacks (stable refs)
  const autocompleteCallbacks = useRef<AutocompleteCallbacks>({
    onOpen(trigger, query, range) {
      autocompleteRangeRef.current = range;
      const state = { trigger, query, range };
      setAutocomplete(state);
      onAutocompleteChangeRef.current?.(state);
    },
    onUpdate(trigger, query, range) {
      autocompleteRangeRef.current = range;
      const state = { trigger, query, range };
      setAutocomplete(state);
      onAutocompleteChangeRef.current?.(state);
    },
    onClose() {
      autocompleteRangeRef.current = null;
      const state: AutocompleteState = {
        trigger: null,
        query: '',
        range: null,
      };
      setAutocomplete(state);
      onAutocompleteChangeRef.current?.(state);
    },
  });

  // Create plugins once at module scope equivalent (via useMemo with [])
  const plugins = useMemo(() => {
    const acPlugins = createAutocompletePlugins(autocompleteCallbacks.current);
    const acArray = Array.isArray(acPlugins) ? acPlugins : [acPlugins];

    return [
      ...acArray,
      keymap({
        Enter: (_state, _dispatch, view) => {
          if (!view || sendingRef.current) return true;
          const wireText = serializeDoc(view.state.doc);
          if (wireText.trim() || false /* hasFiles checked by parent */) {
            handleSendRef.current(wireText);
          }
          return true;
        },
        'Shift-Enter': (state, dispatch) => {
          if (dispatch) {
            dispatch(state.tr.split(state.selection.$from.pos));
          }
          return true;
        },
        Escape: () => {
          onCancelRef.current?.();
          return true;
        },
      }),
      keymap({
        'Mod-z': undo,
        'Mod-y': redo,
        'Mod-Shift-z': redo,
      }),
      keymap(baseKeymap),
      history(),
      maxLengthPlugin(),
      placeholderPlugin(placeholderRef),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable send handler ref
  const handleSendRef = useRef<(wireText: string) => void>(() => {});
  handleSendRef.current = async (wireText: string) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    const view = viewRef.current;
    if (!view) {
      sendingRef.current = false;
      return;
    }
    const snapshotDoc = view.state.doc;
    try {
      await onSend(wireText as WireFormatText);
      // Only clear if user hasn't typed new content during async send
      if (view && !view.isDestroyed && view.state.doc.eq(snapshotDoc)) {
        const emptyDoc = composerSchema.nodes.doc.create(
          null,
          composerSchema.nodes.paragraph.create(),
        );
        const tr = view.state.tr.replaceWith(
          0,
          view.state.doc.content.size,
          emptyDoc.content,
        );
        view.dispatch(tr);
      }
      // Clear draft
      draftMap.delete(channelId);
    } finally {
      sendingRef.current = false;
    }
  };

  // Create the EditorView on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — only recreate view on channelId change; plugins/nodeViews/initialText are stable
  useEffect(() => {
    if (!containerRef.current) return;

    // Resolve initial doc: from initialText prop, or from draft map
    const text = initialText ?? draftMap.get(channelId) ?? '';
    const doc = text ? deserializeText(text, composerSchema) : undefined;

    const state = EditorState.create({
      schema: composerSchema,
      doc,
      plugins,
    });

    const view = new EditorView(containerRef.current, {
      state,
      nodeViews,
      dispatchTransaction(tr) {
        const newState = view.state.apply(tr);
        view.updateState(newState);

        // Fire typing indicator only for user input (not programmatic)
        if (
          tr.docChanged &&
          !tr.getMeta('history$') &&
          tr.getMeta('addToHistory') !== false
        ) {
          onTypingRef.current?.();
        }
      },
      // Intercept keys BEFORE plugins — this is the single source of truth
      // for Enter/Escape/Arrow when autocomplete is open.
      handleKeyDown(_view, event) {
        const ac = autocompleteRangeRef.current;
        if (!ac) return false; // No autocomplete open — let plugins handle it

        switch (event.key) {
          case 'ArrowUp':
            event.preventDefault();
            onAutocompleteArrowRef.current?.('up');
            return true;
          case 'ArrowDown':
            event.preventDefault();
            onAutocompleteArrowRef.current?.('down');
            return true;
          case 'Enter':
          case 'Tab':
            event.preventDefault();
            onAutocompleteSelectRef.current?.();
            return true;
          case 'Backspace': {
            // If the filter is empty (just the trigger char), delete
            // the trigger and close autocomplete in one keypress.
            const v = _view;
            if (!v || !ac) return false;
            const text = v.state.doc.textBetween(ac.from, ac.to);
            // text is e.g. "@" or "@sam" or ":" or ":ups"
            // If only the trigger char remains (length 1), delete it all
            if (text.length <= 1) {
              event.preventDefault();
              const tr = v.state.tr.delete(ac.from, ac.to).scrollIntoView();
              v.dispatch(tr);
              closeAcPlugin(v);
              autocompleteRangeRef.current = null;
              const closedState: AutocompleteState = {
                trigger: null,
                query: '',
                range: null,
              };
              setAutocomplete(closedState);
              onAutocompleteChangeRef.current?.(closedState);
              return true;
            }
            // Otherwise let ProseMirror handle normal backspace
            // (the plugin will update the filter via onUpdate)
            return false;
          }
          case 'Escape': {
            event.preventDefault();
            const v = _view;
            if (v) closeAcPlugin(v);
            autocompleteRangeRef.current = null;
            const closedState: AutocompleteState = {
              trigger: null,
              query: '',
              range: null,
            };
            setAutocomplete(closedState);
            onAutocompleteChangeRef.current?.(closedState);
            return true;
          }
          default:
            return false;
        }
      },
      handlePaste(view, event) {
        // Always extract plain text — never allow HTML parseDOM path
        // SECURITY: prevents HTML paste injection of fake mention nodes
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return false;
        const fragment = deserializeText(text, composerSchema);
        // Insert the parsed fragment content at the current selection
        const { from, to } = view.state.selection;
        const firstParagraph = fragment.firstChild;
        if (firstParagraph) {
          let tr = view.state.tr;
          // For single paragraph, insert inline content
          if (fragment.childCount === 1) {
            tr = tr.replaceWith(from, to, firstParagraph.content);
          } else {
            // Multi-paragraph: insert all
            tr = tr.replaceWith(from, to, fragment.content);
          }
          view.dispatch(tr.scrollIntoView());
        }
        return true; // Signal to ProseMirror that we handled the paste
      },
      attributes: {
        class:
          'flex-1 resize-none rounded-none border-none bg-transparent text-text focus:outline-none overflow-y-auto px-3 py-4',
        autocapitalize: 'sentences',
        autocorrect: 'on',
        spellcheck: 'true',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': placeholder,
      },
    });

    viewRef.current = view;

    // Auto-focus (skip on mobile to avoid keyboard popup)
    if (autoFocus) {
      view.focus();
    }

    return () => {
      // Flush draft on unmount
      if (view && !view.isDestroyed) {
        const wireText = serializeDoc(view.state.doc);
        if (wireText.trim()) {
          draftMap.set(channelId, wireText);
        } else {
          draftMap.delete(channelId);
        }
      }
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]); // Re-create view on channel switch

  // Imperative handle for parent components
  useImperativeHandle(
    ref,
    () => ({
      isDirty() {
        if (!viewRef.current) return false;
        const currentText = serializeDoc(viewRef.current.state.doc);
        return currentText !== originalTextRef.current;
      },
      insertText(text: string, { focus = true }: { focus?: boolean } = {}) {
        const view = viewRef.current;
        if (!view || view.isDestroyed) return;
        // If autocomplete is active, replace the trigger+query range instead of cursor
        const range = autocompleteRangeRef.current;
        const { from, to } = range ?? view.state.selection;
        const tr = view.state.tr.insertText(text, from, to);
        view.dispatch(tr.scrollIntoView());
        if (range) {
          closeAcPlugin(view);
          autocompleteRangeRef.current = null;
        }
        if (focus) view.focus();
      },
      insertMention(id: string, type: 'user' | 'role' | 'everyone') {
        const view = viewRef.current;
        const range = autocompleteRangeRef.current;
        if (!view || view.isDestroyed || !range) return;
        const node = composerSchema.nodes.mention.create({ id, type });
        const space = composerSchema.text(' ');
        const tr = view.state.tr
          .replaceWith(range.from, range.to, [node, space])
          .scrollIntoView();
        view.dispatch(tr);
        closeAcPlugin(view);
        autocompleteRangeRef.current = null;
        view.focus();
      },
      insertCustomEmoji(id: string, name: string, animated: boolean) {
        const view = viewRef.current;
        if (!view || view.isDestroyed) return;
        const range = autocompleteRangeRef.current;
        const { from, to } = range ?? view.state.selection;
        const node = composerSchema.nodes.customEmoji.create({
          id,
          name,
          animated,
        });
        const space = composerSchema.text(' ');
        const tr = view.state.tr
          .replaceWith(from, to, [node, space])
          .scrollIntoView();
        view.dispatch(tr);
        if (range) {
          closeAcPlugin(view);
          autocompleteRangeRef.current = null;
        }
        view.focus();
      },
      insertChannelLink(id: string) {
        const view = viewRef.current;
        const range = autocompleteRangeRef.current;
        if (!view || view.isDestroyed || !range) return;
        const node = composerSchema.nodes.channelLink.create({ id });
        const space = composerSchema.text(' ');
        const tr = view.state.tr
          .replaceWith(range.from, range.to, [node, space])
          .scrollIntoView();
        view.dispatch(tr);
        closeAcPlugin(view);
        autocompleteRangeRef.current = null;
        view.focus();
      },
      focus() {
        viewRef.current?.focus();
      },
      clear() {
        const view = viewRef.current;
        if (!view || view.isDestroyed) return;
        const emptyDoc = composerSchema.nodes.doc.create(
          null,
          composerSchema.nodes.paragraph.create(),
        );
        const tr = view.state.tr.replaceWith(
          0,
          view.state.doc.content.size,
          emptyDoc.content,
        );
        view.dispatch(tr);
      },
      send() {
        const view = viewRef.current;
        if (!view || view.isDestroyed || sendingRef.current) return;
        const wireText = serializeDoc(view.state.doc);
        if (wireText.trim()) {
          handleSendRef.current(wireText);
        }
      },
    }),
    [],
  );

  return (
    <div className="relative">
      {/* Autocomplete popups will be rendered here by the parent */}
      <div
        ref={containerRef}
        className="prosemirror-composer [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[1.5em]"
        data-autocomplete-trigger={autocomplete.trigger}
        data-autocomplete-query={autocomplete.query}
        data-autocomplete-from={autocomplete.range?.from}
        data-autocomplete-to={autocomplete.range?.to}
      />
    </div>
  );
});

// Re-export for parent use
export type { ComposerEditorProps, AutocompleteState };
