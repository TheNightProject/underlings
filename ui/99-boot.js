// A drag that starts inside and ends on the backdrop clicks the backdrop too, so only a press that began there closes.
function closeOnBackdrop(host, close) {
  let pressed = false;
  host.addEventListener('pointerdown', (e) => { pressed = e.target === host; });
  host.addEventListener('click', (e) => { if (pressed && e.target === host) slot(close); });
}

addEventListener('hashchange', () => { render(); slot('focusView'); });
document.addEventListener('click', guardLinks, true);
document.addEventListener('auxclick', guardLinks, true);
closeOnBackdrop(document.getElementById('sheet'), 'closeFile');
closeOnBackdrop(document.getElementById('drawer'), 'closeDrawer');
// The worker names a place to go, or offers this page a banner of its own; anything else is a change to read.
function onWorkerEvent(e) {
  const data = String(e.data ?? '');
  if (data.startsWith('goto:')) slot('goTo', data.slice('goto:'.length));
  else if (data.startsWith('attention:')) slot('onAttentionEvent', data);
  else refresh();
}

function openHashTarget() {
  if (location.hash.startsWith('#mr:')) slot('goTo', decodeURIComponent(location.hash.slice(1)));
}

new EventSource('/api/events?t=' + encodeURIComponent(TOKEN)).onmessage = onWorkerEvent;
setInterval(refresh, 30000);
refresh();
setTimeout(openHashTarget, 400);
slot('presenceStart');
