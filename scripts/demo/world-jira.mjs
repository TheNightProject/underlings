const ME = 'Frank Foster';
const epic = (key, summary) => ({ key, summary });
const ticket = (key, summary, status, extra = {}) => ({ key, summary, status, assignee: ME, ...extra });

export function jiraWorld() {
  return {
    me: ME,
    done: ['Done', 'Not Required'],
    epics: [epic('ABC-100', 'Token service'), epic('ABC-120', 'Offline mode'), epic('ABC-130', 'Platform hardening')],
    tickets: [
      ticket('ABC-101', 'Cache the token lookup', 'Peer Review', { epic: 'ABC-100' }),
      ticket('ABC-102', 'Retry the upload', 'In Progress', { epic: 'ABC-100' }),
      ticket('ABC-103', 'Show the empty state', 'Peer Review'),
      ticket('ABC-104', 'Move the settings page', 'In Progress'),
      ticket('ABC-105', 'Add a dry run flag', 'Peer Review'),
      ticket('ABC-106', 'Fix the login redirect', 'QA', { daysInQa: 1 }),
      ticket('ABC-112', 'Paginate the audit endpoint', 'Peer Review', { epic: 'ABC-130' }),
      ticket('ABC-113', 'Rate limit by tenant', 'In Progress', { epic: 'ABC-130' }),
      ticket('ABC-114', 'Offline queue for uploads', 'Blocked', { epic: 'ABC-120' }),
      ticket('ABC-116', 'Dark mode for the dashboard', 'In Progress'),
      ticket('ABC-117', 'Colourise the help output', 'To Do'),
      ticket('ABC-118', 'Add an SSO session timeout', 'To Do', { epic: 'ABC-130' }),
      ticket('ABC-119', 'Document the retry policy', 'To Do', { epic: 'ABC-100' }),
      ticket('ABC-121', 'Fix the flaky upload test', 'To Do'),
      ticket('ABC-110', 'Export the audit log', 'QA', { assignee: 'Ivan Irving', daysInQa: 0 }),
      ticket('ABC-111', 'Rotate the signing key', 'QA', { assignee: 'Rupert Reed', daysInQa: 2 }),
      ticket('ABC-115', 'Speed up the cold start', 'QA', { assignee: 'Rupert Reed', daysInQa: 3 }),
      ticket('ABC-122', 'Trim the onboarding emails', 'QA', { assignee: 'Trent Tate', daysInQa: 5 }),
      ticket('ABC-123', 'Fix the timezone in reports', 'QA', { assignee: 'Ivan Irving', daysInQa: 6 }),
      ticket('ABC-124', 'Cache the avatar lookups', 'QA', { assignee: null, daysInQa: 9 }),
      ticket('ABC-125', 'Upgrade the build image', 'QA', { assignee: 'Trent Tate', daysInQa: 12 }),
    ],
  };
}
