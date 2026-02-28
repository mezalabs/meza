import path from 'node:path';
import { app, type BrowserWindow } from 'electron';

const PROTOCOL = 'meza';

export function setupDeepLinks(win: BrowserWindow): void {
  // Register protocol handler
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  // macOS: open-url event
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(win, url);
  });

  // Windows/Linux: second-instance event (handled in index.ts)
  // Deep link URL is in the last argument of commandLine

  // Cold start: check process.argv for deep link URL
  const deepLinkArg = process.argv.find((arg) =>
    arg.startsWith(`${PROTOCOL}://`),
  );
  if (deepLinkArg) {
    // Delay until renderer is ready
    win.webContents.once('did-finish-load', () => {
      handleDeepLink(win, deepLinkArg);
    });
  }
}

export function handleDeepLink(win: BrowserWindow, url: string): void {
  win.webContents.send('deep-link:navigate', url);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function extractDeepLinkFromArgs(args: string[]): string | undefined {
  return args.find((arg) => arg.startsWith(`${PROTOCOL}://`));
}
