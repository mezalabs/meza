interface WelcomeStepProps {
  serverName: string;
  iconUrl: string;
  welcomeMessage: string;
}

export function WelcomeStep({
  serverName,
  iconUrl,
  welcomeMessage,
}: WelcomeStepProps) {
  return (
    <div className="flex flex-col items-center text-center">
      {/* Server icon */}
      <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-2xl bg-accent text-3xl font-bold text-black">
        {iconUrl ? (
          <img
            src={iconUrl}
            alt={serverName}
            className="h-full w-full rounded-2xl object-cover"
          />
        ) : (
          serverName.charAt(0).toUpperCase()
        )}
      </div>

      <h2 className="mb-2 text-2xl font-semibold text-text">
        Welcome to {serverName}
      </h2>

      {welcomeMessage && (
        <p className="mt-4 max-w-md whitespace-pre-wrap text-sm text-text-muted">
          {welcomeMessage}
        </p>
      )}
    </div>
  );
}
