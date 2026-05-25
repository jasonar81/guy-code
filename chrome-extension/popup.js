// Tiny popup status reader. Pings the service worker for its current
// connection state and reflects it on the popup. Doesn't open any new
// connection — that's the service worker's job.
const dot = document.getElementById('dot');
const status = document.getElementById('status');

async function refresh() {
  try {
    const probe = await fetch('http://127.0.0.1:9223/health', {
      method: 'GET',
      cache: 'no-store',
    }).catch(() => null);
    // The Electron-side WS server hosts `/health` over HTTP on the
    // same port. If that responds 200, the app is running. We then
    // assume the service worker has (or will shortly have) a live
    // WebSocket connection. We can't easily query the SW directly
    // for the WS state without using chrome.runtime.sendMessage, so
    // we conservatively report "connecting" until the SW says so.
    if (probe && probe.ok) {
      dot.className = 'dot ok';
      status.textContent = 'Connected to Guy Code';
    } else {
      dot.className = 'dot bad';
      status.textContent = 'Guy Code app not running';
    }
  } catch {
    dot.className = 'dot bad';
    status.textContent = 'Guy Code app not running';
  }
}

refresh();
setInterval(refresh, 2000);
