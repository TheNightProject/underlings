# The review engine

The app's internal library: GitLab, Jira, the agents, the review queue and full auto. The
worker loads `dist/engine.js`, every agent runs under `dist/agentrun.js`, every review agent
gets `dist/reviewserver.js` as its MCP server, and `dist/cli.js` is the command line that
agents and hooks call. Set up, build and test from the repo root, as
[The review engine](../README.md#the-review-engine) there says:

```
npm run setup && npm run build
node engine/dist/cli.js --help   # or link engine/dist/cli.js onto PATH
```

The command line does nothing interactive:

```
queue add --json         read queued comments from stdin
queue list [--json]      show what is waiting to be posted
queue done <pass>        a full-auto review agent saying it has finished
runs [<repoPath>!<iid>]  what each review agent printed, from the journal
changed <repoPath> <iid> exit 0 if the MR moved since last seen
gc [--finished] [--yes]  close review workspaces there is nothing left to do in
--once [--json]          print the MR list and exit
```

Needs `GITLAB_TOKEN` in the environment, and `claude` (Claude Code) for the agents. `acli`
is optional and powers the tickets.

Jira slows down under many `acli` processes at once, so at most three run and the rest queue. A
call someone is waiting on (your tickets, a ticket view or move, a standup) starts before one asked
for with `{ priority: 'background' }`, as the QA board's searches and the epic look-ups are. A
search may take 90 s and a view 30 s, counted from when its process starts, not while it queues.

## No repo list

There isn't one. On first run the engine asks GitLab which groups you can see, then which of
their repos have an open merge request, and polls those. A repo somebody adds tomorrow
turns up on its own. A filter in Settings narrows the set:

```
platform/*, !*/spikes/*      everything under platform, except the spikes
frontend                     a bare word matches anywhere in the path
```

Excludes win wherever they are written, so the order of the clauses never changes the
answer.

## The queue is the point

A review agent cannot post. It can only queue, into a flat file, and you are the only
thing that posts. A review launches an agent, the findings land in the queue with the
diff hunk they were written against, and posting one from the review queue is what sends
it to GitLab.

A review agent queues through `queue_findings`, on the MCP server `dist/reviewserver.js` that
every review agent is started with, or through `queue add --json` on stdin. Both read
the same items, rebuilt field by field by `queueInput`: `projectPath`, `projectId`, `iid`,
`webUrl`, `severity`, `body`, `diffHunk` and `position`, or for a reply on an open thread
`{"kind":"reply","replyTo":"<discussion id>","outcome":"fixed|not-fixed|disagree"}`, and
`createdBy`, `auto:<pass>` for a full-auto pass. Anything else, a verdict say, is refused. A
pass ends with `finish_review` or `queue done <pass>`. The prompts themselves, built in
or your own commands, are in `src/agentprompts.ts`; the app's README has them under
Agent prompts.

The queue survives everything: it is written by the agent's own process, not the app, so
quitting the app loses nothing, and concurrent writers take a lock so two agents finishing
together cannot clobber each other. The lock holds its writer's pid and a random token: a
waiter takes it over only once that pid has died or the lock is ten seconds old, and only if
it is still the same lock, and a writer lets go only of its own.

A finding still waiting when its merge request merges or closes can never be posted, so
`tidyQueue` asks GitLab about every queued MR missing from the open list (a merged answer
is kept for good, anything else is asked again at most hourly) and marks what is pending on
the merged and closed ones `expired`, with the reason. An item that carries a send claim or
an edit mark in `queue.json`, whichever worker set it, is left for the next round. A closed MR can be reopened, so once it is back in the open list, or
GitLab next says it is open, what expired on it is pending again; merged is final. Expired counts as settled everywhere: the Queue tab, the status line and
full auto all skip it.

`archiveQueue` moves settled items (posted, discarded, expired, never pending) out of
`queue.json` into `queue-archive.jsonl`, one object per line with `archivedAt` and `why`. The
archive is written in full and flushed before the queue is rewritten, so a crash or a full
disk in between can only leave an item in both, and `loadArchive` lists each once. An item
with a send claim is never archived, and a post claims its item under the lock first, so one
that expired meanwhile is refused rather than sent. Items on the test fixtures' paths (`acme/…`,
`a/b`, or a `gitlab.example` link) are test data: never asked about, expired and archived as
such. The worker drives both.

Under the test runner, or running a `*.test.*` file directly, the store refuses to write the
default state directory, and the test kit's reset refuses it whatever runs it, so a test that
forgets `UNDERLINGS_STATE_DIR` fails rather than writing its fixtures into your queue. That
is how twelve `acme/engine!621` findings reached the real one: the concurrent-writers test
drives the built `dist/cli.js`, and a build that did not read the state variable it was
handed wrote to the default directory instead.

The one exception is an author you have put in full auto, below.

## Full auto

For the people you pick, and only them, the review loop runs without you. The app's Full
auto view lists everyone authoring or reviewing an open merge request in the repos you
watch, leaving out you and the bots, with how many of theirs are asking you to review.
Anyone else can be added by username, at shadow. Pick a level for each:

```
off                          nothing automatic
shadow                       does everything, sends nothing: start here
comments                     posts reviews, replies and re-reviews
comments + verdict           also approves or requests changes
```

Each change saves as you make it, to the `fullAuto` setting in `state.json`
(`username:level`, comma separated), so it can still be edited by hand. Anyone already in full auto stays listed after their last merge request
closes.

It acts only on their merge requests where you are a requested reviewer, never on a
draft, and never on one you have approved. A new merge request, a new commit, or a reply
on a thread you opened launches the usual review agent. A re-review reads the change since
the last pass and answers each of your open threads fixed, not fixed or disagree. A thread
is resolved only when the agent says fixed **and** its own file changed since it was
written.

Everything still goes through the queue first, marked as auto, and sends after a hold
window, two minutes by default. Until then it is an ordinary queued item: you can discard
it or rewrite it, and nothing sends while you are rewriting. Pause stops every auto send
and launch at once, and resuming starts every window again.

The guardrails are in code, not in the prompt:

- at most 8 comments, findings and replies together, per merge request per pass, and 3
  auto replies per thread; anything past that is handed back to you
- never a reply to a bot, or to a reply that says it is automated, so two reviewers'
  agents cannot talk to each other; the author disagreeing twice on a thread hands it back
- a push while a review runs, or inside the hold window, drops what it found and reviews
  the new head instead
- an agent can only queue findings and replies, tagged with its pass. It cannot queue a
  verdict, mark anything auto, or touch the mode, the level or the caps

At `verdict`, a pass that found anything CRITICAL or MAJOR requests changes. Otherwise it
queues an approval that goes only if every gate holds when it is due: a green pipeline,
none of your threads open, nothing blocking found, the head still the commit that pass
reviewed, not a draft, under 600 changed lines, nothing on the **Never auto approve**
list (`**/migrations/**`, `helm/**`, `**/auth/**`, `.gitlab-ci*` by default), no change
request you placed by hand, and nothing from the pass handed back to you. Any gate failing
leaves the approval in your queue with the reason. Unapproving on a new commit is left to
GitLab.

The usual trailer says you read a comment before it went, which is not true of anything
sent automatically, so auto sends carry no trailer. **Auto footer** in settings, off by
default, adds one saying it went unread.

### Who drives it

Full auto, auto re-review and capturing what each review agent has on screen run in one
place at a time: the worker, in the app or in the Orca plugin, whether or not its page is
open. A lock in the state folder decides which: `auto.lock`, beaten every 5 s and taken over
at once from a worker that died, or else only once it is 30 s stale and still the same on a
second look 5 s later. Each worker says it is there in `frontends/`. Every send claims its
item in `queue.json` first, so two workers never post the same thing, and an item caught
part way by a crash comes back to you with the reason rather than going twice. An open edit
marks its item, and nothing sends it while the mark lasts.

An auto re-review fires when a watched MR moves, a commit, the pipeline, a note, an approval
or a resolution, except where the move is something the review engine posted itself. Each
change fires it once, and pause stops it too.

## Leaderboard

The leaderboard counts who opened merge requests and who reviewed them, over the last
fortnight, across whatever your repo filter matches. It is built only when you ask,
because it reads a few hundred events.

Reviewing is counted as merge requests engaged with rather than comments left, so
somebody who says one useful thing is not beaten by somebody who says ten small ones, and
each merge request counts once however you engaged: commenting on one and then approving
it is one review, not two. Comments on your own merge requests and approvals of your own
work do not score.

Totals are weighted, `opened/reviewed/comments/approved` in settings, `3/3/0.5/1` by
default. Raising the work and reviewing somebody else's are worth the same, because both
take a merge request's worth of attention. A comment is a fraction, since it already
earned its merge request a review point and this only exists so depth counts for
something. An approval is worth less than a review because it can be one click. The
weights in use are printed above the table, so a total is never a number nobody can
account for.

**All four are absolute counts, so volume wins whatever the weights say.** Somebody
raising a hundred small merge requests outscores somebody reviewing thirty carefully
under every weighting, which is worth knowing before anyone treats this as a measure of
anything. There is a test holding that claim honest. Sorting by any one column is usually
a better question than the total. Service accounts are left out by a deliberately narrow
name test.

Building it takes the better part of a minute and shows all four stages as it goes,
reading merge requests, paging the busy repos, reading reviews, counting, with running
totals and elapsed time, so a slow build is never mistaken for a stuck one.

Where a repo had more activity than one page could hold, the board says so: those numbers
are a floor, not a total.

## Posting

An agent reports one path and one line. GitLab builds its line code from both sides of
the diff, so an unchanged line needs its old number as well as its new one, a deleted
line has no new number at all, and `old_path` is wanted either way. A position missing
any of that is refused with `line code can't be blank`, which does not say which half
was absent.

So the position is completed at post time from the merge request's own diff rather than
asked of whoever wrote the comment. Where the line is in neither side, usually because
the file moved on since the review, the comment still posts with the location in its
body rather than being lost to a failed anchor.

## Housekeeping

`gc` lists review agents with nothing left to do, and `--yes` removes them. It will not
touch one that is still live, one with findings still queued, or a workspace with a branch,
because a branch is somebody's work. The app's Clean up also lists the git worktrees beside
the repos.

## State

`~/.local/state/underlings/engine/`, or `UNDERLINGS_STATE_DIR`: `queue.json`, `state.json` (watches and settings), `runs.json`
(what each agent printed), `agents/` (each Claude Code agent's log), `repos.json` (the discovered repo cache), `auto.json` (full
auto's passes, and the threads it has handed back), `auto.lock` and `frontends/` (who
drives full auto). All plain JSON and hand-editable. `queue-archive.jsonl` holds what was
archived out of the queue, and is only ever appended to.

## Where agents run

Every agent, a review, a fix or a ticket kickoff, runs as
Claude Code in the background: `claude -p` with stream-json both ways, started in the
workspace root, where the workspace `CLAUDE.md`, settings and commands are, under your
own login and settings. A fix or a ticket also gets a plain git worktree cut beside the repos,
and its prompt names it. Each repo's checkout is found under the workspace root by its `origin`
remote, or by a folder of its name, so nothing is configured by hand; a ticket's worktree is
`<prefix>-<key>` with the key as it is, in lower case, such as `eng-abc-1234`. The same one-agent rules hold as before: one review agent per MR, and
a second fix or kickoff waits until the last one's agent has been removed.

Each one is a detached runner (`dist/agentrun.js`) that owns its `claude` process, so it
outlives the worker that started it. Its folder, `agents/<session id>/` in the state
folder, holds `agent.json` (its name, what kind of agent it is, the MR or ticket it works for
and its worktree), `events.jsonl` (everything claude streamed, and what was sent to it) and
`input.jsonl`, which anything can append to; the runner sends what it has not sent yet. A
turn running reads as working, an AskUserQuestion as waiting with its options, and a tool
asking permission as blocked: nothing is approved for you, so a permission your settings
would ask about waits until you allow or deny it. Once a turn ends with nothing left to send,
the process exits and the agent reads as done; a follow-up starts it again with `--resume`,
and an answer to a question whose process has gone reaches the session as a message.

Under the test runner, starting an agent without `UNDERLINGS_CLAUDE_BIN` pointing at a fake is
refused, as writing the default state folder is.

### Permissions

Agents run in Claude Code's auto mode, so an action it judges safe goes ahead and only a risky one
asks you. `"agentPermissions": "ask"` in the settings of `state.json` starts new agents without it,
so every action your allow list does not cover asks. An agent keeps the mode it started with.

### Orca, as a fallback

`"agentHost": "orca"` in the settings of `state.json` runs agents in Orca terminals again, as
they ran before, until headless agents have proved themselves. It is not a row in Settings.
Orca is asked nothing unless it is set: no terminal list, no workspace
list, no launch. With it set, Orca's agents and Claude Code's are listed together, and each
call goes to the host that started the agent. An agent started in Orca reads as gone once the
setting is back to `claude`, so let it finish first.

## Scheduled re-reviews

Re-review daily, in the app, keeps a daily slot on the watch in `state.json`. Whichever
worker holds the full auto turn looks at each slot that is due from
its poll: an MR that moved since it was last seen gets the review command, as Orca's daily
automation did, and either way its next look is a day later. Pause stops it, an MR with an
agent on it waits, and an author in full auto is left to full auto.

A watch that an older build scheduled as an Orca automation keeps its name in `automation`
until it is moved onto the schedule, which the app offers. The automation itself
stays in Orca until you delete it there; `changed`, its precheck, still works.

## Standup

`buildStandup` works out a day's standup for the app: the MRs you merged, opened
and reviewed, from your GitLab events; the tickets you moved and the ones in progress, from
Jira through `acli`; and your meetings, from a calendar's iCal address, with repeating
meetings expanded by `ical.js` and every time in your zone. A source that fails fails only
its own group. The build bundles `ical.js` into a chunk of its own, loaded only when a calendar is
read, so `dist` needs nothing from `node_modules` and the app ships it as it is. Run from source
without `npm install`, only the meetings fail, and they say what to run.

## QA

`buildQaBoard` lists the tickets a JQL search finds, `project = ABC AND status = QA` unless told
otherwise, with their assignees and how many days each has been in QA, counting today. `acli`
cannot read a ticket's history, so the days come from one search per boundary, `status CHANGED
TO "QA" AFTER startOfDay(-n)`, a day at a time for two weeks and then 21, 28, 42, 60 and 90 days.
Each ticket is joined to the MRs merged in your GitLab group in the last 60 days that name it in
their title or branch, read from GitLab's GraphQL API a week at a time with their diff sizes.
Handed the previous result, it asks only for what merged since, and reads the whole window again
once a day or when told to.

##END
