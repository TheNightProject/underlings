const TOKEN = new URLSearchParams(location.search).get('t');
const APP_NAME = document.querySelector('meta[name="application-name"]')?.getAttribute('content') ?? '';
const APP_FOLDER = document.querySelector('meta[name="app-folder"]')?.getAttribute('content') ?? '';
const VIEWS = {
  overview: 'viewOverview', 'needs-you': 'viewNeeds', agents: 'viewAgents', artifacts: 'viewArtifacts',
  'merge-requests': 'viewMergeRequests', 'review-queue': 'viewQueue', 'full-auto': 'viewFullAuto', 'review-runs': 'viewRuns',
  tickets: 'viewTickets', standup: 'viewStandup', calendar: 'viewCalendar', email: 'viewEmail', slack: 'viewSlack', qa: 'viewQa', watching: 'viewWatching', leaderboard: 'viewLeaderboard', settings: 'viewSettings',
  'whats-new': 'viewWhatsNew', game: 'viewGame', setup: 'viewSetup',
};
const ui = {
  agentFilter: 'active', agentSearch: '', queueFilter: 'pending', artifactSearch: '', showHidden: false, expanded: new Set(),
  mrSearch: '', mrScope: 'all', mrMood: 'all', mrRepo: '', mrPerson: '', peopleSearch: '',
  armed: null, busy: new Set(), editing: new Map(), cleanup: null, mrOpen: new Set(), hunkOpen: new Set(), file: null,
  mr: null, open: new Set(), drafts: new Map(), screens: new Map(), menu: null,
  tickets: { filter: 'all', search: '', data: null, error: null, reading: false, at: 0 }, ticket: null, watching: { filter: 'all' }, settings: { draft: null }, board: null, queueArchive: { page: 0 },
  bootVersion: Number(document.querySelector('meta[name="cc-ui"]')?.content) || null,
};
let state = null;
const broken = new Map();

const ICONS = {
  radar: '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/>',
  dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  open: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="m10 14 2-2 2 2"/><path d="M12 12v5"/>',
  eyeoff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  eyes: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  thumbsup: '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  crosshair: '<circle cx="12" cy="12" r="10"/><path d="M22 12h-4"/><path d="M6 12H2"/><path d="M12 6V2"/><path d="M12 22v-4"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  eraser: '<path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21"/><path d="m5.082 11.09 8.828 8.828"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  clipboard: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  'check-circle': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  'git-branch': '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  'git-pull-request': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
  'list-checks': '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  flask: '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>',
  square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  files: '<path d="M20 7h-3a2 2 0 0 1-2-2V2"/><path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z"/><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  'map-pin': '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  hash: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  'at-sign': '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  'mail-open': '<path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z"/><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  gamepad: '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
  shirt: '<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>',
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  award: '<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>',
  'scroll-text': '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
};

// The only innerHTML on the page: the shapes above are fixed, never text from GitLab or an agent.
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}
for (const holder of document.querySelectorAll('[data-icon]')) {
  if (holder.classList.length) holder.append(icon(holder.dataset.icon));
  else holder.replaceWith(icon(holder.dataset.icon));
}

async function api(path, payload) {
  const res = await fetch(path, {
    method: payload ? 'POST' : 'GET',
    headers: { 'x-cc-token': TOKEN, 'content-type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (res.ok) return res.json();
  const error = Object.assign(new Error(await res.text()), { status: res.status });
  if (error.status === 501) slot('onStaleEngine', error);
  throw error;
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'selected' || k === 'disabled') e[k] = Boolean(v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : String(kid));
  return e;
}

// Package files are called through here, so one that fails to load or throws costs only its own part of the page.
function slot(name, ...args) {
  const fn = window[name];
  if (typeof fn !== 'function') {
    broken.set(name, 'not loaded');
    return null;
  }
  try {
    return fn(...args);
  } catch (e) {
    broken.set(name, e.message);
    console.error(name, e);
    return null;
  }
}

const ago = (t) => {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 6e4);
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
};
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

const LOCALE_CYCLES = { 24: 'h23', 12: 'h12' };
const localeFormats = new Map();
const wallFormats = new Map();
const pageLocale = () => state?.locale ?? {};
const instantOf = (t) => (typeof t === 'number' ? t : Date.parse(t));

function dateFormat(options) {
  const { timeZone, region, clock } = pageLocale();
  const all = { timeZone: timeZone || undefined, ...(LOCALE_CYCLES[clock] ? { hourCycle: LOCALE_CYCLES[clock] } : {}), ...options };
  const key = (region || '') + '|' + JSON.stringify(all);
  if (!localeFormats.has(key)) localeFormats.set(key, builtFormat(region || undefined, all));
  return localeFormats.get(key);
}

// A 12 hour clock reads 2:05 pm, not 02:05 pm.
function builtFormat(region, options) {
  const format = new Intl.DateTimeFormat(region, options);
  const twelve = options.hour === '2-digit' && ['h11', 'h12'].includes(format.resolvedOptions().hourCycle);
  return twelve ? new Intl.DateTimeFormat(region, { ...options, hour: 'numeric' }) : format;
}

function formatted(t, options) {
  const at = instantOf(t);
  return Number.isFinite(at) ? dateFormat(options).format(at) : '';
}

const timeText = (t, seconds = false) => formatted(t, { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
const whenText = (t) => formatted(t, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dateText = (t) => formatted(t, { day: 'numeric', month: 'short' });
const fullText = (t) => formatted(t, { dateStyle: 'short', timeStyle: 'medium' });
// A day as written, not an instant, so no zone can move it to the day either side.
const dayText = (day, options) => formatted(day + 'T12:00:00Z', { ...options, timeZone: 'UTC' });
// The calendar's gutter is narrow, so a 12 hour clock names the hour alone, as 4 AM.
function hourText(hour) {
  const twelve = ['h11', 'h12'].includes(dateFormat({ hour: 'numeric', timeZone: 'UTC' }).resolvedOptions().hourCycle);
  return formatted(Date.UTC(2026, 0, 1, hour), twelve ? { hour: 'numeric', timeZone: 'UTC' } : { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}
const numberText = (n) => new Intl.NumberFormat(pageLocale().region || undefined).format(n);
const workDaysHere = () => pageLocale().hours?.workDays ?? [1, 2, 3, 4, 5];

function wallOf(t) {
  const zone = pageLocale().timeZone || undefined;
  if (!wallFormats.has(zone)) wallFormats.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const p = Object.fromEntries(wallFormats.get(zone).formatToParts(instantOf(t)).map((x) => [x.type, x.value]));
  return { day: p.year + '-' + p.month + '-' + p.day, minutes: Number(p.hour) * 60 + Number(p.minute), seconds: Number(p.second) };
}

const todayHere = () => wallOf(Date.now()).day;
const firstLine = (s) => String(s || '').split('\n').map((l) => l.replace(/[*#`>]/g, '').trim()).find(Boolean) || '';
const view = () => (Object.hasOwn(VIEWS, location.hash.slice(1)) ? location.hash.slice(1) : 'overview');

// Kept identical to the engine's KEY_PATTERN and lib/ticketkeys.mjs.
const TICKET_KEY_SOURCE = '[A-Z][A-Z0-9]+-[1-9]\\d*';
const TICKET_KEY = new RegExp('^' + TICKET_KEY_SOURCE + '$');
const JIRA_URL = new RegExp('https:\\/\\/[\\w-]+\\.atlassian\\.net\\/browse\\/(' + TICKET_KEY_SOURCE + ')');
const DEFAULT_GITLAB_HOST = 'https://gitlab.com';
const gitlabHost = () => state?.matrix?.gitlabHost || DEFAULT_GITLAB_HOST;
const DEFAULT_GITHUB_WEB = 'https://github.com';
const githubWeb = () => state?.matrix?.providers?.github?.web || DEFAULT_GITHUB_WEB;
const githubShown = () => Boolean(state?.matrix?.providers?.github?.on);
// A flag the worker leaves out is one the forge can do, so a GitLab row offers what it always has.
const forgeAllows = (key, cap) => state?.matrix?.providers?.[keyProvider(key) ?? 'gitlab']?.caps?.[cap] !== false;
const READ_ONLY_WHY = 'Reviewing, approving, merging and agents on GitHub pull requests come in a later version; open it on GitHub to act on it.';

function forgeMark(key) {
  if (keyProvider(key) !== 'github') return null;
  return el('span', { class: 'forge-mark', title: 'A GitHub pull request' }, icon('github'), el('span', { class: 'offscreen' }, 'GitHub'));
}

// A GitHub row names its owner too, as repo#12 alone could be any fork.
function rowRef(r) {
  return r.provider === 'github' ? el('span', { class: 'forge-ref' }, forgeMark(r.key), r.key) : r.repo + ' ' + refNumber(r);
}

function readOnlyNote(key) {
  return forgeAllows(key, 'post') ? null : el('span', { class: 'pill s-quiet read-only', title: READ_ONLY_WHY }, 'read only here');
}
const exampleKey = () => (state?.matrix?.defaultProject || state?.matrix?.jiraProjects?.[0] || 'ABC') + '-1234';
const ownProjects = () => state?.matrix?.jiraProjects ?? [];
const newTicketType = () => {
  const type = state?.matrix?.issueType || 'Task';
  return (/^[aeiou]/i.test(type) ? 'An ' : 'A ') + type;
};
const regExpText = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Each switch is named after the view it hides.
const FEATURE_NAMES = { tickets: 'Tickets', standup: 'Standup', qa: 'QA', calendar: 'The calendar', email: 'Email', slack: 'Slack', game: 'The game', leaderboard: 'The leaderboard', artifacts: 'Artifacts' };
const featureOn = (name) => state?.features?.[name] !== false;
const featureOf = (name) => (Object.hasOwn(FEATURE_NAMES, name) ? name : null);

const isNeed = (a) => a.state !== 'working' && (a.state !== 'done' || Boolean(slot('fixAgentWaits', a) || slot('kickoffAgentWaits', a)));
const agentClass = (a) => (a.state === 'working' ? 's-working' : isNeed(a) ? 's-need' : 's-done');

// A thread between other people can end on someone else too, so only one you wrote in is waiting on your answer.
const repliedToMe = (t, me) => t.awaitsYou && t.notes.some((n) => n.author === me);
// Full auto never takes a hand-back back, so a handed-back thread waits on you only until you answer it or it is resolved.
const awaitsMe = (t, me) => (t.handedBack && !t.resolved && t.notes.at(-1)?.author !== me) || repliedToMe(t, me);
// The worker marks each item by the engine's own rule; one it has not marked counts, as it always did.
const waitsToPost = (q) => q.status === 'pending' && q.waiting !== false;
const postedThreadId = (q) => (q.status === 'posted' && q.kind !== 'verdict' && (q.discussionId ?? q.replyTo)) || null;

// The page holds only the newest settled items across every MR, so the open drawer adds the rest of its MR's from its read.
function queuedFor(key) {
  const live = (state.matrix.queue ?? []).filter((q) => q.key === key);
  const ids = new Set(live.map((q) => q.id));
  const older = ui.mr?.key === key ? ui.mr.detail?.settled ?? [] : [];
  return [...live, ...older.filter((q) => !ids.has(q.id))];
}

const queueMark = (key) => (state.matrix.queue ?? []).filter((q) => q.key === key).map((q) => q.id + ':' + q.status + ':' + (q.discussionId ?? '')).join();

// A thread with several posted queue items is drawn once, with its finding or else its newest reply, since its controls have one id each.
function threadOwner(q, id) {
  const items = queuedFor(q.key).filter((x) => postedThreadId(x) === id);
  const at = (x) => Date.parse(x.postedAt ?? x.createdAt) || 0;
  return items.find((x) => x.kind === 'finding') ?? items.reduce((a, b) => (at(b) > at(a) ? b : a), q);
}

function derive() {
  const agents = state.agents;
  const m = state.matrix.available ? state.matrix : { queue: [], runs: [], autoPasses: [], autoLog: [], autoCounts: null, driver: null, fullAuto: [], roster: [], watches: [], verdicts: {}, inbox: { rows: [] } };
  const rows = m.inbox.rows;
  const pending = m.queue.filter(waitsToPost);
  const d = {
    agents,
    needing: agents.filter(isNeed),
    working: agents.filter((a) => a.state === 'working'),
    pending,
    pendingByMr: groupBy(pending, (q) => q.key),
    handedBack: m.autoPasses.filter((p) => p.handedBack.length),
    rows,
    asking: rows.filter((r) => r.flags.waitingOnYou),
    mine: rows.filter((r) => r.flags.mine),
    yours: rows.filter((r) => r.mood === 'awaitingYou' || r.mood === 'moved'),
    artifacts: state.artifacts.filter((a) => !a.hidden),
    m,
  };
  d.needs = state.attention ?? { cards: [], agents: [], system: [], count: 0 };
  return d;
}

function groupBy(list, keyOf) {
  const map = new Map();
  for (const item of list) {
    const k = keyOf(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function toggle(set, key) {
  if (!set.delete(key)) set.add(key);
  render();
}

function renderRail(d) {
  const counts = {
    needs: [d.needs.count ?? 0, 'hot'],
    working: [d.working.length, 'busy'],
    artifacts: [d.artifacts.length, ''],
    reviewing: [d.yours.length, d.yours.length ? 'hot' : ''],
    pending: [d.pending.length, d.pending.length ? 'hot' : ''],
    fullauto: [d.m.fullAuto.length, ''],
    runs: [d.m.runs.filter((r) => r.working).length, 'busy'],
    email: [d.needs.email?.length ?? 0, 'hot'],
    slack: [d.needs.slack?.length ?? 0, 'hot'],
    calendar: [slot('calendarChip') ?? '', ''],
  };
  for (const node of document.querySelectorAll('[data-count]')) {
    const [n, tone] = counts[node.dataset.count] ?? [0, ''];
    node.textContent = n || '';
    node.hidden = !n;
    node.className = 'count' + (n && tone ? ' ' + tone : '');
  }
  for (const a of document.querySelectorAll('.navlink')) {
    if (a.getAttribute('href') === '#' + view()) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
    const feature = featureOf(a.getAttribute('href').slice(1));
    a.hidden = Boolean(feature && !featureOn(feature));
  }
  const g = d.m.inbox ?? {};
  document.getElementById('health').replaceChildren(...[
    slot('matrixHealth', state.matrix),
    slot('railRebuild', state.matrix),
    el('span', { class: g.error ? 'off' : g.fetchedAt ? '' : 'idle' }, g.error ? 'GitLab: ' + g.error : g.fetchedAt ? 'GitLab ' + ago(g.fetchedAt) + (g.loading ? ', refreshing' : '') : 'GitLab loading'),
    githubHealth(d.m.providers?.github, g),
    el('span', { class: 'idle' }, 'Updated ' + timeText(state.generatedAt, true)),
    pageChanged() ? el('span', { class: 'off changed' }, 'The page has changed') : null,
    slot('versionCheck', state.version),
    slot('releaseFooter', state.release),
    reloadButton(),
  ].filter(Boolean));
}

// An error that already names GitHub is not named again.
const githubSays = (error) => (error.startsWith('GitHub') ? error : 'GitHub: ' + error);

function githubHealth(github, g) {
  if (!github?.on) return null;
  if (github.error) return el('span', { class: 'off' }, githubSays(github.error));
  const left = github.limits?.remaining;
  const title = left == null ? null : numberText(left) + ' requests left in GitHub\'s hour' + (github.limits.resetAt ? ', which starts again at ' + timeText(github.limits.resetAt) : '');
  return el('span', { class: g.fetchedAt ? '' : 'idle', title }, g.fetchedAt ? 'GitHub ' + ago(g.fetchedAt) : 'GitHub loading');
}

function reloadButton() {
  const stale = Boolean(state.version?.loaded && state.version.lib > state.version.loaded);
  const title = 'Re-read the code of ' + APP_NAME + ' without restarting its worker, then reload this page';
  return el('button', { class: stale || pageChanged() ? 'primary' : null, title, disabled: ui.busy.has('reload'), onclick: reloadCode },
    icon('rotate-ccw'), ui.busy.has('reload') ? 'Reloading…' : stale ? 'Reload new code' : 'Reload');
}

function pageChanged() {
  return Boolean(state?.version?.ui && ui.bootVersion && state.version.ui !== ui.bootVersion);
}

// The page is rebuilt from ui/ on every load, so new page code needs a page reload; an edit in progress keeps it waiting.
async function reloadCode() {
  ui.busy.add('reload');
  render();
  try {
    const { text, version } = await api('/api/reload', {});
    toast(text);
    if (version.ui !== ui.bootVersion && !ui.editing.size && !ui.drafts.size) location.reload();
  } catch (e) {
    toast(e.message, true);
  } finally {
    ui.busy.delete('reload');
    refresh();
  }
}

const VIEW_ICONS = {
  overview: 'dashboard', 'needs-you': 'bell', agents: 'bot', artifacts: 'sparkles', 'merge-requests': 'merge', 'review-queue': 'inbox',
  'full-auto': 'zap', 'review-runs': 'activity', tickets: 'ticket', standup: 'clipboard', calendar: 'calendar', email: 'mail', slack: 'hash', qa: 'flask', watching: 'eye', leaderboard: 'trophy', settings: 'settings',
  'whats-new': 'scroll-text', game: 'gamepad', setup: 'list-checks',
};

function header(title, sub, ...tools) {
  return el('div', { class: 'head' },
    el('div', { class: 'ttl' }, el('span', { class: 'badge' }, icon(VIEW_ICONS[view()])), el('div', {}, el('h1', {}, title), sub ? el('p', {}, sub) : null)),
    el('div', { class: 'toolbar' }, tools, slot('headerExtras', view()), el('button', { class: 'icon-only', title: 'Refresh now', 'aria-label': 'Refresh now', onclick: () => refresh() }, icon('refresh'))));
}

function button(label, iconName, onclick, primary) {
  return el('button', { class: primary ? 'primary' : null, onclick }, icon(iconName), label);
}

function searchBox(id, placeholder, value, onInput) {
  return el('label', { class: 'search' }, icon('search'),
    el('input', { type: 'search', id, placeholder, value, 'aria-label': placeholder, oninput: (e) => onInput(e.target.value) }));
}

const SECTION_ICONS = { 'Clean up': 'eraser', 'Needs you now': 'bell', 'Working now': 'bot', 'Latest artifacts': 'sparkles', 'Asking for your review': 'eyes', Yours: 'user', People: 'users', 'Latest pass per MR': 'zap', Activity: 'activity', 'Sent without you': 'send', QA: 'flask', 'Next up': 'calendar' };

function section(title, ...body) {
  return el('section', { class: 'section' }, el('h2', {}, SECTION_ICONS[title] ? icon(SECTION_ICONS[title]) : null, title), body);
}

function empty(text) {
  return el('p', { class: 'empty' }, icon('check'), text);
}

function banner(text, warn, ...extra) {
  return el('div', { class: 'banner' + (warn ? ' warn' : '') }, icon(warn ? 'alert' : 'info'), el('div', {}, text, extra));
}

function chips(options, current, onPick, idPrefix) {
  return el('div', { class: 'chips', role: 'group' }, options.map(([value, label]) =>
    el('button', { class: 'chip', id: idPrefix && idPrefix + value, 'aria-pressed': String(value === current), onclick: () => onPick(value) }, label)));
}

function metaLine(...parts) {
  const shown = parts.flat().filter((p) => p != null && p !== false && p !== '');
  return el('span', { class: 'meta' }, shown.flatMap((p, i) => (i ? [' · ', p] : [p])));
}

function matrixBanners(m) {
  if (!m.available) return slot('engineBanner', m);
  return [
    m.inbox.error ? slot('gitlabBanner', m.inbox.error) : null,
    m.providers?.github?.error ? slot('githubBanner', m.providers.github.error) : null,
    m.paused ? banner('Full auto is paused. Nothing sends or launches on its own until you resume it.', true, ' ', button('Resume', 'play', () => matrixAct('pause', {}, 'pause'))) : null,
  ];
}

function mrRef(key, label, tab) {
  return el('button', { type: 'button', class: 'ref', 'data-key': key, title: 'Open ' + key + ' here', onclick: () => slot('openMr', key, tab) }, label ?? key);
}

// One MR can be listed more than once on a page, so its title button carries no id and is found again by its key.
function listedRef(key) {
  return [...document.querySelectorAll('#main .ref')].find((ref) => ref.dataset.key === key) ?? null;
}

function ticketRef(key, status) {
  if (!key) return null;
  return el('button', { type: 'button', class: 'ticket-ref', 'data-ticket': key, title: 'Open ' + key + ' here', onclick: () => slot('openTicket', key) },
    key, status ? el('span', { class: 'ticket-status' }, status) : null);
}

function inPage(hash, setup) {
  return {
    href: hash,
    onclick: () => {
      setup?.();
      if (location.hash === hash) render();
    },
  };
}

// The one way off the page, and only from a button that says so: the link opens in your default browser.
function outside(url, label = 'Open on GitLab', primary = false) {
  if (!url) return null;
  return el('button', { type: 'button', class: primary ? 'primary' : null, title: 'Opens ' + url + ' in your browser', onclick: () => openOutside(url) }, icon('external'), label);
}

// The clipboard API is refused in some embedded browsers, where the older copy command still works.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = el('textarea', { class: 'offscreen', 'aria-hidden': 'true' }, text);
    document.body.append(box);
    box.select();
    const copied = document.execCommand('copy');
    box.remove();
    return copied;
  }
}

async function openOutside(url) {
  try {
    const { text } = await api('/api/open', { url });
    toast(text ?? 'Opened in your browser');
  } catch (e) {
    toast(e.message, true);
  }
}

// Remote text is never markup, so an anchor here is one this file did not make; it is caught before the browser follows it.
function guardLinks(e) {
  const a = e.target.closest?.('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  const plain = e.type === 'click' && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  if (href.startsWith('#') && plain) return;
  e.preventDefault();
  e.stopPropagation();
  if (!href.startsWith('#')) offerLink(a.href);
}

function offerLink(url) {
  const key = mrKeyOf(url);
  if (key) return slot('openMr', key);
  toast('That link leads out of ' + APP_NAME + '.', false, outside(url, 'Open in your browser'));
}

function mrKeyOf(url) {
  const key = keyFromUrl(url, gitlabHost()) ?? (githubShown() ? githubKeyFromUrl(url) : null);
  const known = state && (state.matrix.inbox?.rows ?? []).some((r) => r.key === key);
  return known ? key : null;
}

const MD_NEST = 4;
const MD_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MD_HEADING = /^ {0,3}#{1,6} +(.*)$/;
const MD_RULE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const MD_QUOTE = /^ {0,3}> ?/;
const MD_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +)(.*)$/;
// Spans are capped in length so a long body full of unmatched markers cannot stall the page.
const MD_INLINE = new RegExp([
  /`(?<code>[^`]+)`/,
  /(?<!\w)(?<b>\*\*|__)(?=\S)(?<strong>.{1,500}?)(?<=\S)\k<b>(?!\w)/,
  /<sub>(?<sub>.{1,500}?)<\/sub>/,
  /(?<tag><\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?>)/,
  /\[(?<label>[^[\]]+)\]\((?<dest>https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/,
  /(?<url>https?:\/\/[^\s<>`]*[^\s<>`.,:;!?'"*_)\]])/,
  /(?<!\w)(?<i>[*_])(?=[^\s*_])(?<em>.{1,500}?)(?<=[^\s*_])\k<i>(?!\w)/,
].map((r) => r.source).join('|'), 'gs');

// Review text is untrusted, so it is built from elements and text nodes only and any HTML in it stays as written.
function markdown(text, refs = null) {
  return el('div', { class: 'md' }, mdBlocks(String(text ?? '').split(/\r?\n/), 0, refs));
}

function mdBlocks(lines, depth, refs) {
  const blocks = [];
  let at = 0;
  while (at < lines.length) {
    if (!lines[at].trim()) {
      at += 1;
      continue;
    }
    const [node, next] = (mdReader(lines, at, depth) ?? mdParagraph)(lines, at, depth, refs);
    blocks.push(node);
    at = next;
  }
  return blocks;
}

// Quotes and lists nest, so past a few levels their lines are plain text, or a line of a thousand > would overflow the stack.
function mdReader(lines, at, depth) {
  const line = lines[at];
  if (MD_FENCE.test(line)) return mdFence;
  if (MD_HEADING.test(line)) return mdHeading;
  if (MD_RULE.test(line)) return mdRule;
  if (mdTableAt(lines, at)) return mdTable;
  if (depth >= MD_NEST) return null;
  if (MD_QUOTE.test(line)) return mdQuote;
  return MD_ITEM.test(line) ? mdList : null;
}

function mdParagraph(lines, at, depth, refs) {
  let end = at + 1;
  while (end < lines.length && lines[end].trim() && !mdReader(lines, end, depth)) end += 1;
  return [el('p', {}, mdInline(lines.slice(at, end).map((line) => line.trim()).join('\n'), refs)), end];
}

function mdFence(lines, at) {
  const fence = MD_FENCE.exec(lines[at])[1];
  const closes = (line) => line.trim().startsWith(fence) && !line.trim().replaceAll(fence[0], '');
  let end = at + 1;
  while (end < lines.length && !closes(lines[end])) end += 1;
  return [el('pre', {}, el('code', {}, lines.slice(at + 1, end).join('\n'))), end + 1];
}

function mdHeading(lines, at, depth, refs) {
  return [el('p', {}, el('strong', {}, mdInline(MD_HEADING.exec(lines[at])[1].trim(), refs))), at + 1];
}

function mdRule(lines, at) {
  return [el('hr'), at + 1];
}

// A pipe inside a cell is written \|, so only a bare one splits.
function mdCells(line) {
  return line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'));
}

function mdTableAt(lines, at) {
  const divider = lines[at + 1];
  if (!lines[at].includes('|') || !divider?.includes('-')) return false;
  const cells = mdCells(divider);
  return cells.length === mdCells(lines[at]).length && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function mdTable(lines, at, depth, refs) {
  const head = mdCells(lines[at]);
  let end = at + 2;
  while (end < lines.length && lines[end].includes('|')) end += 1;
  const row = (cells, tag) => el('tr', {}, head.map((_, i) => el(tag, {}, mdInline(cells[i] ?? '', refs))));
  const body = lines.slice(at + 2, end).map((line) => row(mdCells(line), 'td'));
  return [el('div', { class: 'md-table' }, el('table', {}, el('thead', {}, row(head, 'th')), el('tbody', {}, body))), end];
}

function mdQuote(lines, at, depth, refs) {
  let end = at;
  while (end < lines.length && lines[end].trim() && (MD_QUOTE.test(lines[end]) || !mdReader(lines, end, depth))) end += 1;
  const inner = lines.slice(at, end).map((line) => line.replace(MD_QUOTE, ''));
  return [el('blockquote', {}, mdBlocks(inner, depth + 1, refs)), end];
}

function mdItem(line) {
  const m = MD_ITEM.exec(line ?? '');
  return m && { indent: m[1].length, pad: m[1].length + m[2].length + m[3].length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), lines: [m[4]] };
}

// An item runs on over lines indented to its text, and over plain lines that start nothing else, as GitLab reads it.
function mdList(lines, at, depth, refs) {
  const { ordered, start } = mdItem(lines[at]);
  const items = [];
  const sibling = (item) => item?.ordered === ordered && (!items.length || item.indent < items.at(-1).pad);
  const inside = (line) => Boolean(line?.trim()) && line.length - line.trimStart().length >= items.at(-1).pad;
  let end = at;
  for (; end < lines.length; end += 1) {
    const line = lines[end];
    const item = mdItem(line);
    if (sibling(item)) items.push(item);
    else if (inside(line)) items.at(-1).lines.push(line.slice(items.at(-1).pad));
    else if (!line.trim() && (sibling(mdItem(lines[end + 1])) || inside(lines[end + 1]))) items.at(-1).lines.push('');
    else if (line.trim() && !mdReader(lines, end, depth)) items.at(-1).lines.push(line.trim());
    else break;
  }
  const list = el(ordered ? 'ol' : 'ul', { start: ordered ? start : null }, items.map((item) => el('li', {}, mdBlocks(item.lines, depth + 1, refs))));
  return [list, end];
}

// An HTML tag is matched only so that nothing inside it is read as a link or emphasis; it stays in the text as written.
function mdInline(text, refs) {
  const parts = [];
  const plain = (run) => (refs && run ? refs.text(run) : run);
  let at = 0;
  for (const m of text.matchAll(MD_INLINE)) {
    if (m.groups.tag) continue;
    parts.push(plain(text.slice(at, m.index)), mdSpan(m.groups, refs));
    at = m.index + m[0].length;
  }
  parts.push(plain(text.slice(at)));
  return parts.flat().filter((part) => part !== '');
}

function mdSpan({ code, strong, sub, label, dest, url, em }, refs) {
  if (code !== undefined) return el('code', {}, code);
  if (strong !== undefined) return el('strong', {}, mdInline(strong, refs));
  if (em !== undefined) return el('em', {}, mdInline(em, refs));
  if (sub !== undefined) return el('small', { class: 'md-sub' }, mdInline(sub, refs));
  return refs?.link(label ?? url, dest ?? url) ?? mdLink(dest ?? url, label);
}

function mdLink(url, label = url) {
  return el('button', { type: 'button', class: 'md-link', title: url, onclick: () => offerLink(url) }, label);
}

// Anything that writes to GitLab or Jira, or acts on an agent, takes two clicks, a stray one only arms it.
function guarded(id, label, iconName, confirmLabel, run, primary) {
  const armed = ui.armed === id;
  return el('button', {
    id: 'g-' + id,
    class: armed ? 'armed' : primary ? 'primary' : null,
    disabled: ui.busy.has(id),
    title: armed ? 'Click again to confirm' : null,
    onclick: () => {
      if (!armed) return arm(id);
      ui.armed = null;
      run();
    },
  }, icon(armed ? 'alert' : iconName), ui.busy.has(id) ? 'Working…' : armed ? confirmLabel : label);
}

let disarm;
function arm(id) {
  ui.armed = id;
  clearTimeout(disarm);
  disarm = setTimeout(() => { ui.armed = null; render(true); }, 4000);
  render(true);
}

async function busyAct(path, payload, busyId) {
  ui.busy.add(busyId);
  render();
  try {
    const answer = await api(path, payload);
    toast(answer.text, Boolean(answer.failed?.length));
    return answer;
  } catch (e) {
    if (e.status === 409) ui.armed = null;
    if (e.status === 501) toast(e.message, true, slot('rebuildButton'));
    else toast(e.message, true);
    return false;
  } finally {
    ui.busy.delete(busyId);
    refresh();
    if (ui.file) slot('loadFile');
    if (ui.mr) slot('loadMr');
    if (ui.ticket) slot('loadTicket');
  }
}

function matrixAct(name, payload, busyId) {
  return busyAct('/api/matrix/' + name, payload, busyId);
}

let toastTimer;
function toast(text, bad, ...extra) {
  const node = document.getElementById('toast');
  node.className = 'toast' + (bad ? ' bad' : '');
  node.replaceChildren(icon(bad ? 'alert' : 'check'), el('div', {}, el('span', {}, text), extra.length ? el('div', { class: 'actions' }, extra) : null));
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, bad || extra.length ? 9000 : 5000);
}

function renderView(d) {
  if (slot('meetingWindowOnly')) return [];
  const feature = featureOf(view());
  const nodes = feature && !featureOn(feature) ? featureOffView(feature) : [slot(VIEWS[view()], d)].flat(Infinity).filter(Boolean);
  const failed = [...broken].map(([name, why]) => name + ': ' + why).join('; ');
  return [failed ? banner('Part of this page did not load. ' + failed, true) : null, slot('releaseBanner'), ...nodes].filter(Boolean);
}

function featureOffView(feature) {
  return [
    header(FEATURE_NAMES[feature], 'Switched off, so nothing for it runs in the background.'),
    el('p', { class: 'empty' }, icon('circle'), FEATURE_NAMES[feature] + ' is off. ', el('a', { class: 'fix-link', ...inPage('#feature-settings') }, icon('settings'), 'Turn it on in Settings')),
  ];
}

function render(keepFocus) {
  if (!state) return;
  const active = document.activeElement;
  const focusId = keepFocus ? active?.id : null;
  const focusKey = keepFocus && !focusId && active?.classList.contains('ref') && active.closest('#main') ? active.dataset.key : null;
  const caret = focusId ? active.selectionStart : null;
  const overlay = ['sheet', 'drawer', 'agent-window'].find((id) => active?.closest('#' + id)) ?? null;
  broken.clear();
  const d = derive();
  renderRail(d);
  slot('renderGame');
  for (const group of document.querySelectorAll('.navgroup')) group.hidden = [...group.querySelectorAll('.navlink')].every((a) => a.hidden);
  const main = document.getElementById('main');
  const scroll = main.scrollTop;
  main.replaceChildren(...renderView(d));
  main.scrollTop = scroll;
  slot('renderDrawer', d);
  slot('renderSheet', d);
  slot('renderMessageModal');
  slot('renderClaudePanel');
  slot('renderAgentWindow');
  slot('renderCalendarEvent');
  slot('renderClaudeCode');
  slot('renderMeeting');
  slot('onAttention');
  if (focusId) {
    const node = findAgain(focusId, overlay);
    node?.focus({ preventScroll: true });
    if (node && caret != null) node.setSelectionRange(caret, caret);
  }
  if (focusKey) listedRef(focusKey)?.focus({ preventScroll: true });
  if (overlay === 'sheet' && ui.file && !document.getElementById('sheet').contains(document.activeElement)) document.querySelector('#sheet .sheet')?.focus({ preventScroll: true });
  if (overlay === 'drawer' && (ui.mr || ui.ticket) && !document.getElementById('drawer').contains(document.activeElement)) document.querySelector('#drawer .drawer')?.focus({ preventScroll: true });
  slot('markSelection');
}

// The drawer repeats ids from the row behind it, so focus is looked for in the part of the page it was in.
function findAgain(id, overlay) {
  if (!overlay) return document.getElementById(id);
  return [...document.getElementById(overlay).querySelectorAll('[id]')].find((n) => n.id === id) ?? null;
}

function dropSettledEdits(queue) {
  const pending = new Set(queue.filter((q) => q.status === 'pending').map((q) => q.id));
  for (const id of ui.editing.keys()) if (!pending.has(id)) ui.editing.delete(id);
}

async function act(path, payload) {
  try { await api(path, payload); } catch (e) { alertBanner(e.message); }
  refresh();
}

function alertBanner(message) {
  document.getElementById('main').prepend(banner(message, true));
}

let pending;
function refresh() {
  clearTimeout(pending);
  pending = setTimeout(async () => {
    try {
      const next = await api('/api/state');
      if (!next.agents) throw new Error('the worker is out of date, so restart ' + APP_NAME + '.');
      state = next;
      slot('openSetupOnFirstRun', next.setup);
      if (next.matrix.available) dropSettledEdits(next.matrix.queue);
      slot('rereadIfQueueMoved');
      render(true);
    } catch (e) {
      if (!slot('onStale', e)) alertBanner('Could not load: ' + e.message);
    }
  }, 150);
}
