import { memo } from 'react';
import { MarkdownRenderer } from '../shared/MarkdownRenderer.tsx';

export interface WebhookEmbedData {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: WebhookEmbedFieldData[];
}

interface WebhookEmbedFieldData {
  name: string;
  value: string;
  inline?: boolean;
}

interface WebhookEmbedProps {
  embed: WebhookEmbedData;
  serverId: string | undefined;
}

function colorToHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export const WebhookEmbed = memo(function WebhookEmbed({
  embed,
  serverId,
}: WebhookEmbedProps) {
  const hasTitle = !!embed.title;
  const hasDescription = !!embed.description;
  const hasFields = embed.fields && embed.fields.length > 0;

  if (!hasTitle && !hasDescription && !hasFields) return null;

  const borderColor = embed.color ? colorToHex(embed.color) : undefined;

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
        {hasTitle &&
          (embed.url ? (
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
        {hasDescription && (
          <div className="text-sm text-text-secondary">
            <MarkdownRenderer
              content={embed.description as string}
              serverId={serverId}
            />
          </div>
        )}
        {hasFields && (
          <div
            className="grid gap-1 mt-1"
            style={{
              gridTemplateColumns: embed.fields?.some((f) => f.inline)
                ? 'repeat(auto-fill, minmax(150px, 1fr))'
                : '1fr',
            }}
          >
            {embed.fields?.map((field, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: embed fields are static
              <div key={i} className={field.inline ? '' : 'col-span-full'}>
                <div className="text-xs font-semibold text-text-muted">
                  {field.name}
                </div>
                <div className="text-sm text-text-secondary">
                  <MarkdownRenderer content={field.value} serverId={serverId} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
