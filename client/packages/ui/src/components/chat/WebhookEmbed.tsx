import { memo, useState } from 'react';
import { MarkdownRenderer } from '../shared/MarkdownRenderer.tsx';

interface WebhookEmbedAuthorData {
  name: string;
  icon_url?: string;
  url?: string;
}

export interface WebhookEmbedFieldData {
  name: string;
  value: string;
  inline?: boolean;
}

export interface WebhookEmbedData {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  author?: WebhookEmbedAuthorData;
  fields?: WebhookEmbedFieldData[];
}

interface WebhookEmbedProps {
  embed: WebhookEmbedData;
  serverId: string | undefined;
}

function colorToHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

const MAX_VISIBLE_FIELDS = 6;

export const WebhookEmbed = memo(function WebhookEmbed({
  embed,
  serverId,
}: WebhookEmbedProps) {
  const [fieldsExpanded, setFieldsExpanded] = useState(false);

  const { author, description } = embed;
  const fields = embed.fields ?? [];
  const hasTitle = !!embed.title;
  const hasDescription = !!description;
  const hasFields = fields.length > 0;

  if (!hasTitle && !hasDescription && !hasFields && !author) return null;

  const borderColor =
    embed.color !== undefined ? colorToHex(embed.color) : undefined;

  const visibleFields =
    hasFields && !fieldsExpanded ? fields.slice(0, MAX_VISIBLE_FIELDS) : fields;
  const hiddenCount = fields.length - MAX_VISIBLE_FIELDS;

  return (
    <div
      className="mt-1 max-w-md rounded-lg border border-border bg-bg-secondary overflow-hidden"
      style={
        borderColor
          ? { borderLeftWidth: '3px', borderLeftColor: borderColor }
          : undefined
      }
    >
      <div className="px-3 py-2 flex flex-col gap-1">
        {/* Author row */}
        {author && (
          <div className="flex items-center gap-1.5">
            {author.icon_url && (
              <img
                src={author.icon_url}
                alt=""
                className="h-6 w-6 rounded-full"
                referrerPolicy="no-referrer"
                crossOrigin="anonymous"
              />
            )}
            {author.url?.startsWith('https://') ? (
              <a
                href={author.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-text hover:underline"
              >
                {author.name}
              </a>
            ) : (
              <span className="text-sm font-medium text-text">
                {author.name}
              </span>
            )}
          </div>
        )}

        {/* Title */}
        {hasTitle &&
          (embed.url?.startsWith('https://') ? (
            <a
              href={embed.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-accent hover:underline"
            >
              {embed.title}
            </a>
          ) : (
            <span className="text-sm font-semibold text-text">
              {embed.title}
            </span>
          ))}

        {/* Description (markdown) */}
        {hasDescription && (
          <div className="text-sm text-text-secondary">
            <MarkdownRenderer content={description} serverId={serverId} />
          </div>
        )}

        {/* Fields (plain text for performance) */}
        {hasFields && (
          <div
            className="grid gap-1 mt-1"
            style={{
              gridTemplateColumns: fields.some((f) => f.inline)
                ? 'repeat(auto-fill, minmax(150px, 1fr))'
                : '1fr',
            }}
          >
            {visibleFields.map((field, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: embed fields are static
              <div key={i} className={field.inline ? '' : 'col-span-full'}>
                <div className="text-xs font-semibold text-text-muted">
                  {field.name}
                </div>
                <div className="text-sm text-text-secondary">{field.value}</div>
              </div>
            ))}
          </div>
        )}
        {hiddenCount > 0 && !fieldsExpanded && (
          <button
            type="button"
            onClick={() => setFieldsExpanded(true)}
            className="text-xs text-accent hover:underline text-left"
          >
            Show {hiddenCount} more field{hiddenCount !== 1 ? 's' : ''}
          </button>
        )}
      </div>
    </div>
  );
});
