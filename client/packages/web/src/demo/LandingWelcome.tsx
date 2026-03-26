import { DemoMessage } from './DemoMessage.tsx';

export function LandingWelcome() {
  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col bg-bg-base">
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-0.5 py-4">
          <DemoMessage author="sbysb" timestamp="Today at 12:00 PM">
            Your group chat is someone else's business model.
          </DemoMessage>
          <DemoMessage author="sbysb" timestamp="Today at 12:01 PM">
            Your DMs train someone else's AI.
          </DemoMessage>
          <DemoMessage author="sbysb" timestamp="Today at 12:02 PM">
            Your voice calls route through someone else's servers.
          </DemoMessage>
          <DemoMessage author="sbysb" timestamp="Today at 12:05 PM">
            Meza is chat that shuts up and does its job.
          </DemoMessage>
          <DemoMessage author="sbysb" timestamp="Today at 12:06 PM">
            End-to-end encrypted. No tracking. No ads. No AI training. Open
            source. Your messages are yours.
          </DemoMessage>
        </div>
      </div>
    </div>
  );
}
