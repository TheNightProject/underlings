const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// What the routines API returns, trimmed to the fields the Scheduled view reads; every name and prompt is invented.
export function routinesWorld(epoch) {
  const at = (ms) => new Date(epoch + ms).toISOString();
  const run = (agoMs, status) => ({ fired_at: at(-agoMs), finished_at: at(-agoMs + 40_000), status: `ROUTINE_RUN_STATUS_${status}` });
  return [
    {
      id: 'trig_demo_burnup', name: 'Sprint burn-up: hourly history', cron_expression: '0 8-18 * * 1-5', enabled: true, next_run_at: at(27 * MINUTE),
      last_run: run(33 * MINUTE, 'SUCCEEDED'), derived_state: { prompt: 'You keep one dashboard data file current from the ticket tracker. Change nothing else.' },
    },
    {
      id: 'trig_demo_digest', name: 'Monday release digest', cron_expression: '30 8 * * 1', enabled: true, next_run_at: at(4 * 24 * HOUR + 3 * HOUR),
      last_run: run(5 * 24 * HOUR, 'SUCCEEDED'), derived_state: { prompt: 'You read last week\'s merged changes and write a short digest for the channel. Post nothing.' },
    },
    {
      id: 'trig_demo_audit', name: 'Weekly dependency audit', cron_expression: '15 7 * * 3', enabled: true, next_run_at: at(2 * 24 * HOUR + 9 * HOUR),
      last_run: run(5 * 24 * HOUR + 2 * HOUR, 'FAILED'), derived_state: { prompt: 'You check each service\'s lockfile for known advisories and list what needs a bump.' },
    },
    {
      id: 'trig_demo_timesheet', name: 'Friday timesheet fill', cron_expression: '7 13 * * 4,5', enabled: false, next_run_at: null,
      last_run: run(9 * 24 * HOUR, 'SUCCEEDED'), derived_state: { prompt: 'You fill in this week\'s timesheet from the calendar, skipping days already logged.' },
    },
  ];
}
