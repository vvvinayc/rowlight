// Thin bar under the top bar when a new version is available / downloading / ready.

import React, { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../shared/types';
import { api, unwrap } from '../api';

export function UpdateBar() {
  const [s, setS] = useState<UpdateStatus | null>(null);
  const [hidden, setHidden] = useState<string | null>(null); // dismissed for this version
  useEffect(() => {
    unwrap(api.update.status()).then(setS).catch(() => {});
    return api.on('update:status', setS);
  }, []);
  if (!s || !['available', 'downloading', 'downloaded'].includes(s.state)) return null;
  if (hidden === `${s.state}:${s.version}`) return null;
  return (
    <div className={'update-bar ' + s.state}>
      {s.state === 'available' && (
        <>
          <span>⬆ <b>Rowlight {s.version}</b> is available (you have {s.currentVersion}).</span>
          <button className="primary" onClick={() => api.update.download()}>Download</button>
        </>
      )}
      {s.state === 'downloading' && (
        <>
          <span>⬇ Downloading Rowlight {s.version}… {s.percent ?? 0}%</span>
          <span className="update-progress"><span style={{ width: `${s.percent ?? 0}%` }} /></span>
        </>
      )}
      {s.state === 'downloaded' && (
        <>
          <span>✓ <b>Rowlight {s.version}</b> is ready. It installs when you close Rowlight, or now:</span>
          <button className="primary" onClick={() => api.update.install()}>Restart &amp; update</button>
        </>
      )}
      <button className="link" onClick={() => api.update.openReleases()}>What's new</button>
      <span className="spacer" />
      {s.state !== 'downloading' && <button className="link" onClick={() => setHidden(`${s.state}:${s.version}`)}>Later</button>}
    </div>
  );
}
