import { app } from 'electron';

export function setAutoLaunch(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: enabled ? ['--hidden'] : [],
  });
}

export function getAutoLaunchEnabled(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}
