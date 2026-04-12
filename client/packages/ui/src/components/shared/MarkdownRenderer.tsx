import { getMediaURL, useAuthStore, useEmojiStore } from '@meza/core';
import {
  Children,
  type ComponentPropsWithoutRef,
  isValidElement,
  memo,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { MentionBadge } from '../chat/MentionBadge.tsx';
import { EMOJI_BASE_SIZE_PX } from './emojiConstants.ts';
import { MEZA_SANITIZE_SCHEMA } from './markdownSanitizeSchema.ts';
import { remarkMezaEmoji } from './remarkMezaEmoji.ts';
import { remarkMezaMention } from './remarkMezaMention.ts';
import { remarkMezaSpoiler } from './remarkMezaSpoiler.ts';
import { remarkUnicodeEmoji } from './remarkUnicodeEmoji.ts';
import { TwemojiImg } from './TwemojiImg.tsx';

type MarkdownVariant = 'message' | 'full';

/** Elements disallowed per variant. */
const DISALLOWED_ELEMENTS: Record<MarkdownVariant, string[]> = {
  message: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'],
  full: [],
};

interface MarkdownRendererProps {
  content: string;
  serverId?: string;
  className?: string;
  variant?: MarkdownVariant;
}

/** Recursively extract text content from React children. */
function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node) return '';
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node))
    return extractText((node.props as { children?: ReactNode }).children);
  // Children.toArray handles iterables
  return Children.toArray(node).map(extractText).join('');
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  serverId,
  className,
  variant = 'message',
}: MarkdownRendererProps) {
  const serverEmojis = useEmojiStore((s) =>
    serverId ? s.byServer[serverId] : undefined,
  );
  const personalEmojis = useEmojiStore((s) => s.personal);
  const emojiScale = useAuthStore((s) => s.user?.emojiScale ?? 1);
  const [emojiRetries, setEmojiRetries] = useState<Record<string, number>>({});

  const handleEmojiError = useCallback((id: string) => {
    setEmojiRetries((prev) => ({
      ...prev,
      [id]: (prev[id] ?? 0) + 1,
    }));
  }, []);

  const remarkPlugins = useMemo(
    () => [
      remarkGfm,
      remarkBreaks,
      remarkMezaEmoji,
      remarkMezaMention,
      remarkMezaSpoiler,
      remarkUnicodeEmoji,
    ],
    [],
  );

  const rehypePlugins = useMemo(() => {
    // biome-ignore lint/suspicious/noExplicitAny: rehype plugin typing requires mutable tuple
    const plugins: any[] = [
      [rehypeSanitize, MEZA_SANITIZE_SCHEMA],
      [rehypeHighlight, { detect: true, ignoreMissing: true }],
    ];
    return plugins;
  }, []);

  const components = useMemo(
    () => ({
      // Links open in new tab
      a: ({ href, children, ...props }: ComponentPropsWithoutRef<'a'>) => (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
          {...props}
        >
          {children}
        </a>
      ),

      // Convert images to links (prevent tracking pixels, bypass media proxy)
      img: ({ alt, src }: ComponentPropsWithoutRef<'img'>) => (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          {alt || src}
        </a>
      ),

      // Headings as styled divs (not semantic h1-h6 inside messages)
      h1: ({ children }: ComponentPropsWithoutRef<'h1'>) => (
        <div className="text-lg font-bold text-text mt-2 mb-1">{children}</div>
      ),
      h2: ({ children }: ComponentPropsWithoutRef<'h2'>) => (
        <div className="text-base font-bold text-text mt-2 mb-1">
          {children}
        </div>
      ),
      h3: ({ children }: ComponentPropsWithoutRef<'h3'>) => (
        <div className="text-sm font-bold text-text mt-1.5 mb-0.5">
          {children}
        </div>
      ),
      h4: ({ children }: ComponentPropsWithoutRef<'h4'>) => (
        <div className="text-sm font-semibold text-text mt-1 mb-0.5">
          {children}
        </div>
      ),
      h5: ({ children }: ComponentPropsWithoutRef<'h5'>) => (
        <div className="text-sm font-semibold text-text-muted mt-1 mb-0.5">
          {children}
        </div>
      ),
      h6: ({ children }: ComponentPropsWithoutRef<'h6'>) => (
        <div className="text-sm font-medium text-text-muted mt-1 mb-0.5">
          {children}
        </div>
      ),

      // Code blocks with max-height and copy button
      pre: ({ children }: ComponentPropsWithoutRef<'pre'>) => (
        <CodeBlock>{children}</CodeBlock>
      ),

      // Inline code
      code: ({
        children,
        className,
        ...props
      }: ComponentPropsWithoutRef<'code'>) => {
        // If inside a <pre> (code block), className will have language-* class
        // The parent <pre> handler (CodeBlock) handles the block styling
        if (className) {
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        }
        return (
          <code
            className="rounded bg-bg-elevated px-1 py-0.5 font-mono text-[0.85em]"
            {...props}
          >
            {children}
          </code>
        );
      },

      // Tables with horizontal scroll
      table: ({ children }: ComponentPropsWithoutRef<'table'>) => (
        <div className="my-1 max-w-full overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            {children}
          </table>
        </div>
      ),
      th: ({ children, style }: ComponentPropsWithoutRef<'th'>) => (
        <th
          className="border border-border bg-bg-surface px-2 py-1 text-left text-xs font-semibold text-text"
          style={style}
        >
          {children}
        </th>
      ),
      td: ({ children, style }: ComponentPropsWithoutRef<'td'>) => (
        <td className="border border-border px-2 py-1 text-sm" style={style}>
          {children}
        </td>
      ),

      // Blockquotes
      blockquote: ({ children }: ComponentPropsWithoutRef<'blockquote'>) => (
        <blockquote className="border-l-2 border-accent-muted pl-3 italic text-text-muted my-1">
          {children}
        </blockquote>
      ),

      // Lists
      ul: ({ children }: ComponentPropsWithoutRef<'ul'>) => (
        <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>
      ),
      ol: ({ children }: ComponentPropsWithoutRef<'ol'>) => (
        <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>
      ),
      li: ({
        children,
        className,
        ...props
      }: ComponentPropsWithoutRef<'li'>) => {
        // Task list items get a special class from remark-gfm
        const isTask = className?.includes('task-list-item');
        return (
          <li
            className={isTask ? 'list-none -ml-4 flex items-start gap-1.5' : ''}
            {...props}
          >
            {children}
          </li>
        );
      },

      // Horizontal rules
      hr: () => <hr className="my-2 border-border" />,

      // Paragraphs
      p: ({ children }: ComponentPropsWithoutRef<'p'>) => (
        <p className="my-0.5">{children}</p>
      ),

      // Custom Meza emoji elements
      'meza-emoji': ({
        emojiId,
        emojiName,
        animated: _animated,
      }: {
        emojiId: string;
        emojiName: string;
        animated: boolean;
      }) => {
        const emoji =
          serverEmojis?.find((e) => e.id === emojiId) ??
          personalEmojis?.find((e) => e.id === emojiId);
        const retryCount = emojiRetries[emojiId] ?? 0;
        if (!emoji || retryCount >= 2) {
          return <span>:{emojiName}:</span>;
        }
        const attachmentId = emoji.imageUrl.replace('/media/', '');
        const url =
          getMediaURL(attachmentId) +
          (retryCount > 0 ? `&_r=${retryCount}` : '');
        const size = EMOJI_BASE_SIZE_PX * emojiScale;
        return (
          <img
            src={url}
            alt={`:${emojiName}:`}
            title={`:${emojiName}:`}
            className="inline-block align-text-bottom"
            style={{ width: size, height: size }}
            loading="lazy"
            onError={() => handleEmojiError(emojiId)}
          />
        );
      },
      // Native Unicode emoji → Twemoji SVG
      'meza-unicode-emoji': ({
        children,
      }: ComponentPropsWithoutRef<'span'>) => {
        const size = EMOJI_BASE_SIZE_PX * emojiScale;
        // Extract the raw emoji string — children may be a string, an array,
        // or nested React elements depending on the react-markdown version.
        const emoji = extractText(children);
        return <TwemojiImg emoji={emoji} size={size} />;
      },
      // Custom Meza mention elements
      'meza-mention': ({
        mentionType,
        mentionId,
      }: {
        mentionType: 'user' | 'role' | 'everyone';
        mentionId: string;
      }) => {
        return (
          <MentionBadge
            type={mentionType}
            userId={mentionId || undefined}
            serverId={serverId}
          />
        );
      },
      // Spoiler text — click to reveal/hide
      'meza-spoiler': SpoilerText,
    }),
    [
      serverEmojis,
      personalEmojis,
      emojiScale,
      emojiRetries,
      handleEmojiError,
      serverId,
    ],
  );

  const disallowed = DISALLOWED_ELEMENTS[variant];

  return (
    <div className={`markdown-body text-base text-text ${className ?? ''}`}>
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        disallowedElements={disallowed.length > 0 ? disallowed : undefined}
        unwrapDisallowed
      >
        {content}
      </Markdown>
    </div>
  );
});

/** Fenced code block with max-height scroll and copy button. */
function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    // Extract text content from children
    const codeEl = children as React.ReactElement<{ children: string }>;
    const text =
      typeof codeEl?.props?.children === 'string' ? codeEl.props.children : '';
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="group/code relative my-1">
      <pre className="max-h-[400px] overflow-auto rounded-md bg-bg-elevated p-3 font-mono text-[0.8125rem] leading-relaxed">
        {children}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 rounded bg-bg-surface/80 px-1.5 py-0.5 text-xs text-text-muted opacity-0 transition-opacity hover:text-text group-hover/code:opacity-100"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

/** Inline spoiler text with click-to-toggle reveal. */
function SpoilerText({ children }: { children: React.ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <button
      type="button"
      className={`spoiler ${revealed ? 'spoiler-revealed' : ''}`}
      onClick={() => setRevealed((r) => !r)}
      aria-label={revealed ? undefined : 'Spoiler — click to reveal'}
      aria-expanded={revealed}
    >
      <span aria-hidden={!revealed}>{children}</span>
    </button>
  );
}
