import { DemoMessage } from './DemoMessage';
import type { DemoMessage as DemoMessageType } from './types';

interface DemoMessageListProps {
  messages: DemoMessageType[];
  typingUser?: string;
}

export function DemoMessageList({
  messages,
  typingUser,
}: DemoMessageListProps) {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-2 py-4">
      <div className="mt-auto space-y-0.5">
        {messages.map((msg) => (
          <DemoMessage key={msg.id} message={msg} />
        ))}
      </div>
      {typingUser && (
        <div className="px-2 py-1.5 text-xs text-text-muted">
          <span className="font-medium">{typingUser}</span> is typing
          <span className="typing-dots ml-0.5">
            <span className="dot">.</span>
            <span className="dot">.</span>
            <span className="dot">.</span>
          </span>
        </div>
      )}
    </div>
  );
}
