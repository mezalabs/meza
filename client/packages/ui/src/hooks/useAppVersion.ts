import { isCapacitor } from '@meza/core';
import { useEffect, useState } from 'react';

export function useAppVersion(): string {
  const [version, setVersion] = useState(
    `${__APP_VERSION__} (${__APP_BUILD_DATE__})`,
  );

  useEffect(() => {
    // Desktop: override with Electron semver from package.json
    if (window.electronAPI?.app?.getVersion) {
      window.electronAPI.app
        .getVersion()
        .then((v) => {
          if (v) setVersion(v);
        })
        .catch(() => {});
      return;
    }

    // Mobile: override with native app version from Capacitor
    if (isCapacitor()) {
      import('@capacitor/app')
        .then(({ App }) => App.getInfo())
        .then((info) => setVersion(info.version))
        .catch(() => {});
    }
  }, []);

  return version;
}
