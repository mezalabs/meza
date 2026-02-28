import { SERVER_TEMPLATES, type ServerTemplate } from '@meza/core';
import { resolveIcon } from '../../../utils/icons.ts';

interface TemplateStepProps {
  selectedId: string | null;
  onSelect: (template: ServerTemplate) => void;
}

export function TemplateStep({ selectedId, onSelect }: TemplateStepProps) {
  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-text">
          What kind of server?
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          Pick a template to get started. You can customize everything later.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {SERVER_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => onSelect(template)}
            className={`flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors ${
              selectedId === template.id
                ? 'border-accent bg-bg-elevated'
                : 'border-border bg-bg-surface hover:border-accent/50 hover:bg-bg-elevated'
            }`}
          >
            {(() => {
              const Icon = resolveIcon(template.icon);
              return Icon ? <Icon size={24} aria-hidden="true" /> : null;
            })()}
            <span className="text-sm font-medium text-text">
              {template.name}
            </span>
            <span className="text-xs text-text-muted">
              {template.description}
            </span>
            <span className="text-xs text-text-muted">
              {template.channels.length} channel
              {template.channels.length !== 1 ? 's' : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
