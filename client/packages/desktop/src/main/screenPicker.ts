import path from 'node:path';
import {
  BrowserWindow,
  type DesktopCapturerSource,
  desktopCapturer,
  ipcMain,
} from 'electron';

let pickerOpen = false;

/**
 * Opens the screen/window picker and returns the user's selection.
 * Called via IPC from the renderer BEFORE getDisplayMedia() — this avoids
 * the Windows deadlock where desktopCapturer.getSources() or opening a
 * BrowserWindow from inside setDisplayMediaRequestHandler freezes the app.
 */
export async function showScreenPicker(
  parent: BrowserWindow,
): Promise<DesktopCapturerSource | null> {
  if (pickerOpen) return null;
  pickerOpen = true;

  let sources: DesktopCapturerSource[];
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
    });
  } catch {
    pickerOpen = false;
    return null;
  }

  const serializedSources = sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.isEmpty()
      ? ''
      : s.thumbnail.toJPEG(80).toString('base64'),
  }));

  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent,
      modal: true,
      width: 680,
      height: 520,
      resizable: false,
      minimizable: false,
      maximizable: false,
      frame: false,
      backgroundColor: '#121212',
      show: false,
      webPreferences: {
        preload: path.join(import.meta.dirname, '../preload/picker.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    let resolved = false;

    const cleanup = () => {
      pickerOpen = false;
      ipcMain.removeHandler('picker:getSources');
      ipcMain.removeAllListeners('picker:select');
      ipcMain.removeAllListeners('picker:cancel');
    };

    ipcMain.handle('picker:getSources', () => serializedSources);

    ipcMain.once('picker:select', (_event, sourceId: string) => {
      if (_event.sender.id !== picker.webContents.id) return;
      resolved = true;
      cleanup();
      const selected = sources.find((s) => s.id === sourceId) ?? null;
      picker.close();
      resolve(selected);
    });

    ipcMain.once('picker:cancel', (_event) => {
      if (_event.sender.id !== picker.webContents.id) return;
      resolved = true;
      cleanup();
      picker.close();
      resolve(null);
    });

    picker.on('closed', () => {
      if (!resolved) {
        cleanup();
        resolve(null);
      }
    });

    picker.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(PICKER_HTML)}`,
    );
    picker.once('ready-to-show', () => picker.show());
  });
}

const PICKER_HTML = /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #121212;
    color: #e0e0e0;
    overflow: hidden;
    user-select: none;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    -webkit-app-region: drag;
  }
  .header h1 {
    font-size: 16px;
    font-weight: 600;
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 0 20px 12px;
  }
  .tab {
    padding: 6px 16px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: #999;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .tab:hover { background: #2a2a2a; color: #ccc; }
  .tab.active { background: #333; color: #fff; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
    padding: 0 20px 20px;
    overflow-y: auto;
    max-height: 360px;
  }
  .source {
    border: 2px solid transparent;
    border-radius: 8px;
    padding: 8px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    background: #222;
  }
  .source:hover { background: #2a2a2a; border-color: #555; }
  .source.selected { border-color: #5b8def; background: #1e2a3a; }
  .source img {
    width: 100%;
    aspect-ratio: 16/9;
    object-fit: contain;
    border-radius: 4px;
    background: #111;
  }
  .source .name {
    margin-top: 6px;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid #333;
  }
  .btn {
    padding: 8px 20px;
    border-radius: 6px;
    border: none;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-cancel { background: #333; color: #ccc; }
  .btn-cancel:hover { background: #444; }
  .btn-share { background: #5b8def; color: #fff; }
  .btn-share:hover { background: #4a7de0; }
  .btn-share:disabled { opacity: 0.5; cursor: not-allowed; }
  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 300px;
    color: #888;
    font-size: 14px;
  }
</style>
</head>
<body>
  <div class="header">
    <h1>Share your screen</h1>
  </div>
  <div class="tabs">
    <button class="tab active" data-type="screen">Screens</button>
    <button class="tab" data-type="window">Windows</button>
  </div>
  <div id="grid" class="grid">
    <div class="loading">Loading sources...</div>
  </div>
  <div class="footer">
    <button class="btn btn-cancel" id="cancelBtn">Cancel</button>
    <button class="btn btn-share" id="shareBtn" disabled>Share</button>
  </div>
<script>
  var allSources = [];
  var selectedId = null;
  var activeType = 'screen';

  function createSourceEl(s) {
    var div = document.createElement('div');
    div.className = 'source';
    div.dataset.id = s.id;

    var img = document.createElement('img');
    if (s.thumbnail) {
      img.src = 'data:image/jpeg;base64,' + s.thumbnail;
    } else {
      img.style.background = '#333';
    }
    img.alt = s.name;
    div.appendChild(img);

    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.name;
    div.appendChild(name);

    div.addEventListener('click', function() {
      var prev = document.querySelector('.source.selected');
      if (prev) prev.classList.remove('selected');
      div.classList.add('selected');
      selectedId = s.id;
      document.getElementById('shareBtn').disabled = false;
    });

    div.addEventListener('dblclick', function() {
      selectedId = s.id;
      window.pickerAPI.select(selectedId);
    });

    return div;
  }

  function render() {
    var grid = document.getElementById('grid');
    var filtered = allSources.filter(function(s) {
      return activeType === 'screen' ? s.id.startsWith('screen:') : s.id.startsWith('window:');
    });

    grid.innerHTML = '';

    if (filtered.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'loading';
      empty.textContent = 'No ' + activeType + 's available';
      grid.appendChild(empty);
      return;
    }

    filtered.forEach(function(s) {
      grid.appendChild(createSourceEl(s));
    });
  }

  document.querySelectorAll('.tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      activeType = tab.dataset.type;
      selectedId = null;
      document.getElementById('shareBtn').disabled = true;
      render();
    });
  });

  document.getElementById('cancelBtn').addEventListener('click', function() {
    window.pickerAPI.cancel();
  });

  document.getElementById('shareBtn').addEventListener('click', function() {
    if (selectedId) window.pickerAPI.select(selectedId);
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') window.pickerAPI.cancel();
  });

  window.pickerAPI.getSources().then(function(sources) {
    allSources = sources;
    render();
  });
</script>
</body>
</html>`;
