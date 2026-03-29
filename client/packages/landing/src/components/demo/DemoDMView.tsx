import { DemoAvatar } from './DemoAvatar';
import { DemoComposer } from './DemoComposer';
import { DemoMessageList } from './DemoMessageList';
import type { DemoMessage as DemoMessageType, DemoUser } from './types';

interface DemoDMViewProps {
  recipient: DemoUser;
  messages: DemoMessageType[];
}

export function DemoDMView({ recipient, messages }: DemoDMViewProps) {
  return (
    <div className="flex flex-1 flex-col">
      {/* DM header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <DemoAvatar
          name={recipient.name}
          color={recipient.avatarColor}
          avatarUrl={recipient.avatarUrl}
          size="sm"
        />
        <span className="text-sm font-semibold text-text">
          {recipient.name}
        </span>
        <span className="h-2 w-2 rounded-full bg-success" />
      </div>

      <DemoMessageList messages={messages} />
      <DemoComposer channelName={recipient.name} />
    </div>
  );
}
