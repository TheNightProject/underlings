import { message as gmailMessage, thread as gmailThread } from '../../lib/fixtures/gmail.mjs';
import { message as slackMessage } from '../../lib/fixtures/slack.mjs';

export const SLACK_ME = 'U0FRANK0001';
const MINUTE = 60_000;

const pick = (m, kind, reason) => ({ channel: m.channel, ts: m.ts, kind, reason });

export function slackWorld(epoch) {
  const tsAgo = (minutes) => ((epoch - minutes * MINUTE) / 1000).toFixed(6);
  const root = tsAgo(185);
  const pair = (who, name) => `${name} (ID: ${who}), Frank Foster (ID: ${SLACK_ME})`;
  const M = {
    deploy: slackMessage({ ts: tsAgo(38), place: '#platform', channel: 'C0PLATFORM1', from: 'U0VICTOR001', text: '<@U0FRANK0001|Frank Foster> could you look at the deploy &amp; the rollback before standup?' }),
    approve: slackMessage({ ts: tsAgo(22), place: '#eng', channel: 'C0ENG000001', from: 'U0SYBIL0001', text: '<@U0FRANK0001|Frank> please approve the retry policy change when you get a minute' }),
    plan: slackMessage({ ts: tsAgo(55), place: '#ops', channel: 'C0OPS000001', from: 'U0WALTER001', text: '<@U0FRANK0001> can you sanity check the migration plan? <https://example.com/migration|The plan> is in the doc.' }),
    morning: slackMessage({ ts: tsAgo(120), place: 'DM', channel: 'D0VICTOR001', from: SLACK_ME, text: 'Morning', participants: pair('U0VICTOR001', 'Victor Vale') }),
    minute: slackMessage({ ts: tsAgo(16), place: 'DM', channel: 'D0VICTOR001', from: 'U0VICTOR001', text: 'Have you got a minute for the budget? I need the numbers before the 2pm.', participants: pair('U0VICTOR001', 'Victor Vale') }),
    release: slackMessage({ ts: tsAgo(52), place: 'DM', channel: 'D0WENDY0001', from: 'U0WENDY0001', text: 'Is the release out?', participants: pair('U0WENDY0001', 'Wendy West') }),
    cacheRoot: slackMessage({ ts: root, place: '#infra', channel: 'C0INFRA0001', from: SLACK_ME, replies: 2, text: 'Who owns the cache?' }),
    cacheEarly: slackMessage({ ts: tsAgo(150), place: '#infra', channel: 'C0INFRA0001', from: 'U0WALTER001', thread: root, text: 'Not me' }),
    cacheTaken: slackMessage({ ts: tsAgo(12), place: '#infra', channel: 'C0INFRA0001', from: 'U0FELIX0001', thread: root, text: 'I can take it, is that ok? I have a day free on Thursday.' }),
    pipeline: slackMessage({ ts: tsAgo(30), place: '#platform', channel: 'C0PLATFORM1', from: 'B0GITLAB001', bot: 'GitLab', text: '<@U0FRANK0001> pipeline failed' }),
  };
  const found = {
    mention: [M.approve, M.pipeline, M.plan, M.deploy],
    dm: [M.minute, M.release, M.morning],
    thread: [M.cacheTaken, M.cacheEarly],
    own: [M.morning, M.cacheRoot],
  };
  const picks = [
    pick(M.deploy, 'mention', 'Victor wants you to look at the deploy and the rollback before standup.'),
    pick(M.approve, 'mention', 'Sybil needs your approval on the retry policy change.'),
    pick(M.plan, 'mention', 'Walter asks you to sanity check the migration plan.'),
    pick(M.minute, 'dm', 'Victor wants a minute about the budget before two.'),
    pick(M.release, 'dm', 'Wendy asks if the release is out.'),
    pick(M.cacheTaken, 'reply', 'Felix offers to take the cache and asks if that is ok.'),
  ];
  const conversations = {
    D0VICTOR001: [M.morning, M.minute],
    D0WENDY0001: [M.release],
    C0INFRA0001: [M.cacheRoot, M.cacheEarly, M.cacheTaken],
  };
  const replies = {
    D0VICTOR001: 'Yes, ring me in ten. I have last month\'s numbers open and the forecast is nearly done.',
    D0WENDY0001: 'Not yet, it goes out at three once the last pipeline is green. I will tell you the moment it does.',
    C0INFRA0001: 'Yes please, Thursday works. Start with the expiry, and ping me on the MR when it is up.',
    C0ENG000001: 'Looking at it now, I will approve it once the pipeline is green.',
    C0PLATFORM1: 'On it. I will check the rollback first and report back before standup.',
    C0OPS000001: 'Will do. I will read the plan this afternoon.',
  };
  return { found, picks, conversations, replies };
}

export function gmailWorld(epoch) {
  const iso = (minutes) => new Date(epoch - minutes * MINUTE).toISOString();
  const mail = (id, at, extra) => gmailThread(id, [gmailMessage(id, { at: iso(at), ...extra })]);
  const threads = [
    mail('a1b2c3d4e5f60001', 95, { from: 'victor@example.com', name: 'Victor Vale', subject: 'Budget for the offsite', snippet: 'Could you sign off the budget by Friday? The venue needs the deposit.' }),
    mail('a1b2c3d4e5f60002', 160, { from: 'wendy@example.org', name: 'Wendy West', subject: 'Re: Hiring panel &amp; dates', snippet: 'Frank, are you free to sit on the panel on the 19th?' }),
    mail('a1b2c3d4e5f60003', 300, { from: 'walter@example.com', name: 'Walter Wells', subject: 'Invitation: Roadmap review @ Thu 13 Nov', snippet: 'You have been invited to Roadmap review.' }),
    mail('a1b2c3d4e5f60004', 75, { from: 'sybil@example.com', name: 'Sybil Shaw', subject: 'Signing key rotation: sign-off needed', snippet: 'The rotation is staged. I need your OK before I run it tonight.' }),
    mail('a1b2c3d4e5f60005', 20, { from: 'noreply@gitlab.com', name: 'GitLab', subject: 'Pipeline failed', snippet: 'Your pipeline failed.' }),
  ];
  const picks = [
    { threadId: 'a1b2c3d4e5f60004', kind: 'asked', reason: 'Sybil needs your OK before tonight\'s signing key rotation.' },
    { threadId: 'a1b2c3d4e5f60001', kind: 'asked', reason: 'Victor wants the offsite budget signed off by Friday.' },
    { threadId: 'a1b2c3d4e5f60002', kind: 'waiting', reason: 'Wendy is waiting to hear if you can sit on the hiring panel.' },
    { threadId: 'a1b2c3d4e5f60003', kind: 'invite', reason: 'Walter invited you to the roadmap review on Thursday.' },
  ];
  return { threads, picks };
}
