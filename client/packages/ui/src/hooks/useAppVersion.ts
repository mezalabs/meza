import { MEZA_VERSION } from '@meza/core';
import { useEffect, useState } from 'react';

export function useAppVersion(): string {
  const [version, setVersion] = useState(MEZA_VERSION);

  useEffect(() => {
    if (window.electronAPI?.app?.getVersion) {
      window.electronAPI.app
        .getVersion()
        .then((v) => {
          if (v) setVersion(v);
        })
        .catch(() => {
          // Fall back to MEZA_VERSION (already set)
        });
    }
  }, []);

  return version;
}
