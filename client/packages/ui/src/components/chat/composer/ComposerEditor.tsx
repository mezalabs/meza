import {
  ProsemirrorAdapterProvider,
  useNodeViewFactory,
} from '@prosemirror-adapter/react';
import { baseKeymap } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { EditorState, type Plugin, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import {
  forwardRef,
  useCallback,
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
  return new (class {
    spec = {
      filterTransaction: (tr: Transaction) => {
        if (!tr.docChanged) return true;
        return wireFormatLength(tr.doc) <= MAX_LENGTH;
      },
    };
  })() as unknown as Plugin;
}

// ---------------------------------------------------------------------------
// Placeholder decoration plugin
// ---------------------------------------------------------------------------
function placeholderPlugin(text: string): Plugin {
  const emptyDoc = (state: EditorState) => {
    const { doc } = state;
    return (
      doc.childCount === 1 &&
      doc.firstChild?.isTextblock &&
      doc.firstChild.content.size === 0
    );
  };

  return new (class {
    spec = {
      props: {
        decorations(state: EditorState) {
          if (emptyDoc(state)) {
            return DecorationSet.create(state.doc, [
              Decoration.widget(1, () => {
                const span = document.createElement('span');
                span.className =
                  'pointer-events-none text-text-subtle select-none';
                span.textContent = text;
                span.style.position = 'absolute';
                return span;
              }),
            ]);
          }
          return DecorationSet.empty;
        },
      },
    };
  })() as unknown as Plugin;
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
  serverId?: string;
  autoFocus?: boolean;
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
    serverId,
    autoFocus,
  },
  ref,
) {
  const viewRef = useRef<EditorView | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);
  const originalTextRef = useRef(initialText ?? '');
  const sendingRef = useRef(false);

  // Stable refs for callbacks to avoid stale closures in EditorView
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const [autocomplete, setAutocomplete] = useState<AutocompleteState>({
    trigger: null,
    query: '',
    range: null,
  });

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
      setAutocomplete({ trigger, query, range });
    },
    onUpdate(trigger, query, range) {
      setAutocomplete({ trigger, query, range });
    },
    onClose() {
      setAutocomplete({ trigger: null, query: '', range: null });
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
          // If autocomplete is open, let it handle Enter
          // (autocomplete plugins are first and already consumed it if active)
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
      placeholderPlugin(placeholder),
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
      },
    });

    viewRef.current = view;

    // Auto-focus (skip on mobile to avoid keyboard popup)
    if (autoFocus) {
      view.focus();
    }

    return () => {
      // Flush draft on unmount
      const gen = generationRef.current;
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

  // Increment generation on channel switch to prevent stale draft writes
  useEffect(() => {
    generationRef.current++;
    return () => {
      generationRef.current++;
    };
  }, [channelId]);

  // Imperative handle for parent components
  useImperativeHandle(
    ref,
    () => ({
      isDirty() {
        if (!viewRef.current) return false;
        const currentText = serializeDoc(viewRef.current.state.doc);
        return currentText !== originalTextRef.current;
      },
      insertEmoji(text: string) {
        const view = viewRef.current;
        if (!view || view.isDestroyed) return;
        const { from, to } = view.state.selection;
        const tr = view.state.tr.insertText(text, from, to);
        view.dispatch(tr.scrollIntoView());
        view.focus();
      },
      insertText(text: string) {
        const view = viewRef.current;
        if (!view || view.isDestroyed) return;
        const { from, to } = view.state.selection;
        const tr = view.state.tr.insertText(text, from, to);
        view.dispatch(tr.scrollIntoView());
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
