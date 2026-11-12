import type { JiraSettings } from './settings.js';

export const TEAM_STATUSES = [
  'To Do', 'Triaged', 'Ready for Dev', 'In Design', 'In Progress', 'Blocked', 'Peer Review', 'Design QA', 'QA',
  'Release Ready', 'Ready to Ship - Staging', 'Ready to Ship - Live', 'Done', 'Not Required',
];

export const TEAM_JIRA: JiraSettings = {
  projects: 'ABC',
  defaultProject: 'ABC',
  statuses: TEAM_STATUSES.join(', '),
  doneStatuses: 'Done, Not Required',
  issueType: 'Task',
  ticketTemplate: ['# Problem', '# Fix', '# Acceptance criteria', 'Problem and Fix are a short paragraph each. Acceptance criteria is two to four lines, each starting "- ".'].join('\n'),
};
