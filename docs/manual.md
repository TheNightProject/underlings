# Underlings manual

The full manual for Underlings. The README covers what it is, how to install it, what leaves your
machine and what it costs; this goes through every part of the page.

Your review, fix and kickoff agents, your merge requests and tickets, and every artifact you have
published, on one page. Every agent runs as Claude Code in the background, and nothing about
agents, workspaces or schedules asks Orca anything. It runs as a macOS app of its own, or as an
Orca plugin until you switch to the app. The review engine it runs lives in `engine/`; see The
review engine.

As a plugin: Orca's plugin panels have no network access and cannot talk to the plugin's own
code, so the page is served by the plugin's worker on `127.0.0.1`, which opens it as an Orca
browser tab when the plugin starts. The sidebar panel only says so.

## Set up the plugin

Build the review engine first, from this folder: `npm run setup && npm run build`. Then:

1. Orca, Settings, Plugins: turn on **Plugin system**.
2. Under **Development**, **Add path**: the folder you cloned Underlings into.
3. Approve the plugin when Orca asks. It asks for `storage` (used only to keep the worker
   alive) and `notifications:show` (desktop banners, see Needs you and notifications). It no
   longer asks for `events:subscribe`, so Orca may ask you to approve it again once.
4. The page opens itself as a tab in the workspace root. A tab left over with an old link is
   pointed at the current one, so the worker opens no second tab.

`~/.config/underlings/config.json` holds the port and, for an Orca profile other than the one
the plugin runs in, its path (`orcaUserDataPath`, the value of `ORCA_USER_DATA_PATH` in an Orca
terminal). Left out, the `orca` CLI is given the profile Orca started the plugin with, or its own default.
Tabs open in the workspace root from the review engine's settings unless `workspaceRoot` is set there too.

### Where it keeps things

| Folder | Holds |
| --- | --- |
| `~/.config/underlings/` | settings: `config.json`, the GitLab and GitHub tokens, Slack, email, standup, updates, profile, locale |
| `~/.local/state/underlings/` | the worker's state: the page token, the game ledger, artifacts, the Claude panel's session |
| `~/.local/state/underlings/engine/` | the review engine's: the queue, runs, watches, full auto, every agent's log |
| `~/Library/Logs/Underlings/` | the app's log |

## The macOS app

`desktop/` is the same Underlings as an app of its own, so it runs without Orca's plugin
system. Its Electron main process starts `worker.mjs` with a host of its own in place of Orca's,
and the page is the same page, loaded in one window from the worker's `127.0.0.1` link with no
Node in the page.

Quit the app if it is running, then build and install it:

```sh
npm run setup
cd desktop
npm run install-app
open -a Underlings
```

`npm run install-app` builds the review engine, then an unsigned arm64 `Underlings.app` into `desktop/dist.noindex/mac-arm64/`,
signed ad hoc as `com.thenightproject.underlings` so macOS can list it under Notifications, and copies it to `/Applications`; the `.noindex` folder keeps Spotlight
from listing the build as a second app. The app carries its own copy of `worker.mjs`, `lib/`, `ui/`
and the engine build (`engine/dist` without the command line), and loads that copy rather than a
checkout's, so a change to any of them needs `npm run install-app` again and the app quit and opened again. `npm start` in `desktop/` runs the app on this checkout instead, where
**Reload** picks up a change to `lib/` and `ui/` as it does in Orca.

**Turn the plugin off in Orca (Settings, Plugins) while you use the app.** Both read the same
`config.json`, token and state, and a second copy only adds a second set of Orca and GitLab reads.
If the plugin still holds the port, the app says so and offers the next free port for this run;
full auto's lock stops the two driving at once meanwhile, and only the older one sends banners.

What the app does in place of Orca:

- **The window** remembers its size and position. Closing it hides it; the app keeps running in
  the menu bar until you quit it.
- **The menu bar icon** shows the Needs you count, and its menu has **Open Underlings**,
  **Open what needs me**, **Pause full auto**, **Launch at login** (off until you tick it) and
  **Quit**.
- **Cmd+Shift+J** opens what the latest banner named, from any app. The same two commands are in
  the app menu.
- **Ctrl+Option+Cmd+K** shows and focuses the window from any app. Set `showShortcut` in
  `config.json` to another Electron accelerator, or to `""` to turn it off, then quit and open the
  app again. Cmd+Shift+. is not the default because Finder uses it for hidden files. When macOS
  refuses the one you set, the menu bar menu and the page's Keyboard shortcuts say so.
- **Ctrl+Option+Cmd+C** opens Claude Code, in the Claude panel or its popped out window, from any
  app (see Claude Code in the app). `claudeShortcut` in `config.json` sets it as `showShortcut`
  does, and one macOS refuses is logged and said in Keyboard shortcuts.
- **The View menu** has Cmd+1 to Cmd+9 for the main views, Cmd+K for Jump to, Cmd+/ for the
  keyboard shortcuts, and the rest of the views without keys; **Settings…** (Cmd+,) is in the app
  menu.
- **Banners** are the app's own, and a click opens the MR drawer tab that banner named, or Needs
  you after a digest. Allow Underlings in macOS System Settings, Notifications, if none arrive.
- **Links** that say they leave the page (**Open on GitLab** and the rest) open in the
  default browser, and only an http or https link opens.
- **Artifacts** open in a window of their own rather than your browser (see Recording artifacts).
- **Logs** go to `~/Library/Logs/Underlings/underlings.log`.

The app needs nothing of Orca. The plugin still asks Orca for what a plugin needs to show itself:
its page as an Orca tab, its banners, and the unread dot on its workspace when a banner is
refused.

## The review engine

`engine/` is the review engine the worker runs: GitLab, Jira, the agents, the queue and full auto,
in TypeScript, with its own `package.json`, tsconfig, build and tests. `engine/README.md` says how
it works, and what its command line does for agents and hooks.

| From this folder | Does |
| --- | --- |
| `npm run setup` | installs the engine's and the app's packages |
| `npm run build` | builds `engine/dist`: `engine.js` for the worker, `agentrun.js` for the agents, `cli.js` for the command line |
| `npm test` | builds the engine and runs both suites |
| `npm run test:engine`, `npm run test:cc` | runs one suite |

The worker loads `engine/dist/engine.js` from beside its own `lib/`, in a checkout and in the app
alike, unless `matrixEngine` in `config.json` names another build. The build bundles `ical.js`, so
it needs nothing from `node_modules` and the app ships it as it is.

A review command of your own that calls the command line, `underlings queue add --json` say, needs
it on your PATH. Link it from this checkout:

```sh
ln -sf "$PWD/engine/dist/cli.js" ~/.local/bin/underlings
```

## Setup

**Setup** checks what the app needs and says how to put each part right. It opens by itself
until **Done for now**, and stays in Jump to and under Settings after that. **Check again** runs
every check once more.

| Check | Passes when | The fix |
| --- | --- | --- |
| Claude Code | `claude auth status` says signed in | a link to install it, or `claude auth login` to copy |
| GitLab token | GitLab, at gitlab.com or your **GitLab host**, knows the token and it has the `api` scope | a link that makes one with `api` ticked, a field to paste it, and the host field |
| GitHub | optional, and off until you switch it on here: the token in use is known to GitHub, with `repo` and `read:org` | the switch, a link that makes a token, a field to paste one, and `gh auth refresh -s` for a token gh holds |
| Jira | optional: a site is set, `acli` is on the PATH and `acli jira auth status` says signed in | the site field, a link to install `acli`, or `acli jira auth login --web` to copy |
| Workspace root | the folder exists and has at least one git checkout in it, counted | the folder field |
| Agent commands | always: each is the built-in prompt or your own | a field for each, see Agent prompts |
| Artifact hook | a `PostToolUse` hook in `~/.claude/settings.json` runs `record-artifact.mjs` | **Install the hook**, see Recording artifacts |

The app opens and reads your MRs with GitLab alone. The GitLab banner shows the token field on
its first error about the token, with a link here, rather than after a failed Retry. The checks
ask GitLab, Claude Code and `acli` only when Setup is open, never on a timer.

## GitHub

Your pull requests on GitHub sit in the same Merge requests list as your GitLab ones, read only
for now: read one, its diff, reviews, checks and Actions logs here, and open it on GitHub to act
on it. It is off until you switch it on in Setup or under Settings. Being signed in to `gh` never
turns it on, and while it is off nothing is asked of GitHub.

- **The token** is the first of one pasted in Setup (kept in `~/.config/underlings/github-token`,
  readable only by you), `GITHUB_TOKEN` or `GH_TOKEN` from your shell profile, and `gh auth
  token`, which is held in memory and never written. Setup says which is in use, who it is and its
  scopes: `repo` and `read:org` for a classic token or gh. A fine-grained token lists none, so give
  it read access to pull requests, contents, checks, commit statuses and Actions; it covers one
  owner. An organisation that enforces single sign-on answers with where to authorise the token,
  and Setup says so. Agents are never given it.
- **Which pull requests** is **Involving me** by default: one search reads every open one you
  wrote, are assigned, are asked to review or are mentioned in, whichever organisation it is in.
  **My organisations** also reads every open one in the repos pushed to in the last 90 days in
  your organisations. **GitHub repos** narrows either, as Repos does, over `owner/repo`.
- **GitHub Enterprise Server** is the **GitHub API** setting, such as
  `https://github.example.com/api/v3`. It is untested beyond fakes.
- **Limits** are kept to: four requests at once, an unchanged read sent with its ETag, which
  GitHub does not count, a wait for `retry-after` or the reset, and no sleeping through a wait
  of more than a minute. Hover GitHub on the status line for how many requests are left.
- **One list.** Each forge is read at once and has its own account, error banner and Needs you
  card, so one failing leaves the other's rows. A GitHub row shows a mark and `owner/repo#12`, and
  what GitHub cannot do here yet, posting, approving, holding, merging, retries and agents, is
  hidden, with Full auto never taking a GitHub pull request. GitHub's states read as the codes
  the page already shows: a pull request that branch rules block says so, one GitHub has not
  yet worked out says it is checking, and a check from another app has a link in place of a log.
- **References.** `owner/repo#12` and pull request links open the drawer, in a description and
  in Claude Code's terminal; there `repo#12` links when one known GitHub repo has that name, and
  a bare `#12` never does. Inside a pull request, `#12` is that repo's.

## Keys

Every key comes from one list in `ui/02-keys.js`, which also fills Jump to and the Keyboard
shortcuts sheet, so the three cannot drift. **?** shows them all, dimming the ones that do nothing
where you are.

- **Cmd+K** (or Ctrl+K) opens **Jump to**: type part of a view, an MR's title, `!iid`, repo,
  author or ticket, a ticket's key or summary, an agent, a person or an artifact, or an action
  such as a drawer tab, Review, a Settings section, one setting (**Settings: Effort for every
  task** opens Settings on that row alone, its control focused) or Send a test banner. Letters in order and
  initials match too (`rq` is Review queue). `>` narrows to actions, `!` to MRs, `@` to people
  and `#` to views. With nothing typed it lists what you picked last, what works where you are,
  what needs you and the views. Tab on an MR, ticket or artifact lists what you can do with it.
- **g** then a letter goes to a view: **o** Overview, **n** Needs you, **t** Tickets, **d**
  Standup, **c** Calendar, **e** Email, **l** Slack, **a** Agents, **p** Artifacts, **m** Merge requests, **q** Review queue, **f** Full
  auto, **r** Review runs, **w** Watching, **b** Leaderboard, **s** Settings, **x** Game. A view added to the
  rail gets a free letter of its own.
- **j** and **k** select rows, **g g** and **G** the first and last, **Enter** opens the selected
  one. A row with nothing to open hands Enter to its control, so a setting's field or a standup
  line's tick box is focused rather than changed. The selection survives a refresh.
- **r**, **v**, **h** and **P** review, approve, hold and post all on the selected MR or the
  drawer's. Each only arms the button, which takes focus and says what it will do; the same key
  again, or Enter, does it, and Esc, a move or 4 seconds cancels. Jump to goes no further than
  arming either, and a write that is one click on the page, such as a test banner, only gets
  focus.
- **1** to **6**, **[** and **]** pick the drawer's tab, **b** turns Merge requests and Tickets
  between list and board, and Agents between list and office, **/** goes to the view's search box,
  Settings' filter included, **R** refreshes, **,** is Settings.
- **c** opens the Claude panel, which in the app is Claude Code, at its message box, takes you back
  to it from anywhere on the page, or closes it from inside. Jump to has it as **Ask Claude**, and
  **New chat with Claude**; in the app, **Open Claude Code** and **New Claude Code session**.
- **Esc** closes one thing per press, innermost first: the field you are in (a search box is
  cleared first), the palette or sheet, the colour key, what is armed, the menu, the file, the
  drawer, the selection, then Settings' filter.

No key does anything while you type in a field, apart from Esc and Cmd+K.

## Needs you and notifications

The worker works out what needs you (`lib/attention.mjs`) after every MR list read, every full
auto step and every change in an agent's state, whether or not a tab is open. Needs you shows one card per
MR holding every reason it needs you, grouped as **Waiting on you** (other people's MRs), **Your
MRs**, then **Agents waiting** (agents on no MR's review or fix run, five at a time); within a
group what interrupts comes first, then the oldest. Each card has one guarded next step, **Later**
on a verdict (kept until something on the MR changes), **Mute for a day**, **Mute until it
merges**, and **Show here** to act in place. Left out: what full auto sends itself (Full auto lists
it under **Sending soon**, each with **Discard**), what it sent without you, and expired findings.
On your own MRs it also tells you when merge when green merged one (a line to **Dismiss**), when a
fix agent pushed, and when a rebase you started failed. The rail badge, the tab title and the
favicon count the cards, and the Overview's Needs you now shows the first six.

A watched MR's drawer opens on what moved since your review: commits, who answered your threads,
how many of yours are resolved and the pipeline, with the files changed listed under it. The moved
pills say the same in their tooltip, and **Release** is offered only on a hold that is yours.

`lib/notifier.mjs` decides when to interrupt you, and keeps its ledger in
`~/.local/state/underlings/attention.json`. An MR missing from one list read keeps what was
sent about it, its mutes and its Later for a week, so a GitLab batch that failed once neither
repeats a banner nor lifts a mute; **Mute until it merges** ends once GitLab says the MR ended.

- The first run notes everything silently. A start more than 15 minutes after the last run sends
  one catch-up digest.
- One banner per MR, naming its top reason, and one digest when three or more MRs are due at
  once. At most one banner per MR and kind every 30 minutes, and six an hour, the overflow going in
  one digest. A reason sends one banner; after that the badge carries it, and the same findings
  under new ids stay quiet.
- Never for your own actions, the engine's own writes, bots and automated text, drafts, launches
  or expired findings. A change request on your MR on its own waits 45 minutes first.
- While a dashboard tab has focus there is no banner: the page shows a toast with **Open**.
- Quiet hours and days off hold banners and send one digest when they end. Off, in Settings,
  Notifications, sends nothing.
- Only the oldest live worker sends, so a second worker, or the one holding the full auto turn,
  neither doubles nor silences a banner.
- In the plugin, a banner Orca refuses marks the dashboard's workspace unread (`orca worktree set --unread`,
  never `--comment`), and Needs you says why.

In the plugin, clicking an Orca banner only brings Orca forward, so **Cmd+J, Underlings: Open
what needs me** opens what the latest banner named, in the tab already open, or Needs you after a
digest. With **clickable banners** on, the page shows the banner itself while a tab is open, and a
click opens that MR's drawer tab; one the page does not confirm within 10 s goes out as Orca's
banner. The app's banners open their item themselves, so the app has neither.

Once, in the plugin, after this update:

1. Orca puts the plugin back to pending, as it now asks for a new permission. In Orca's Settings,
   Plugins, Underlings, approve "Show desktop notifications labeled with the plugin name". Until
   then the plugin does not run at all, full auto included.
2. `worker.mjs` changed, so turn the plugin off and on once.
3. In macOS System Settings, Notifications, Orca, allow notifications and choose Banners, or Alerts
   to keep them on screen.
4. Optional: in Orca's Settings, Keybindings, Plugins, bind "Underlings: Open what needs me".
   The chord fires only from Orca's own UI; Cmd+J works from everywhere.
5. Optional: Settings, Notifications, **Turn on clickable banners**, then Allow on the tab's prompt.

Needs you repeats these steps in a banner until you press Done. In the app it asks only for
step 3, for Underlings rather than Orca.

## Reviewing on request and re-reviewing

Full auto's People table starts with **Anyone else who asks for my review**, Off by default. On,
every MR that asks for you, is not a draft, is not approved by you and is not your own or a bot's
is reviewed at shadow: queued for you, nothing sent. A person's own row wins, and Off on a row
means never once the default is on.

**Re-review MRs I reviewed when they change** (Settings, Reviewing) is off on a new install, as it
starts review agents on its own and spends your Claude usage. On, it turns auto re-review on for
each MR you review from now on; Watching has **Turn on for all N** for the
rest. A re-review waits for a new head to settle and its pipeline to finish (half an hour at
most), or launches on a person's new note on a thread you opened; a pipeline, approval or
resolution on its own launches nothing. It reads the change since your last review and answers
your open threads, and what it finds waits for you. A launch that fails keeps the change and is
tried again, three times a head.

## Daily re-reviews

**Re-review daily**, in an MR's menu, keeps a daily slot in the review engine's state folder, and
whichever front end drives full auto takes each day's look from its poll: an MR that moved since it
was last seen gets the review command, and either way the next look is a day later. **Stop the
daily re-review** removes the slot, and unwatching takes it along.

Daily re-reviews an older build scheduled as Orca automations are listed once, at the top of
Watching, each with a two-click **Move to the schedule here**. The automation is never
deleted from here, so the move says which one to delete from Orca's automations, or it runs there
too.

## Agents

Every agent, a review (yours or full auto's), a fix, a ticket kickoff, or an agent acting on a
message, runs as Claude Code in the background under your own login and settings. **Agents** lists
each one with its state, the MR or ticket it works for, which opens that drawer on its Agent tab,
and what it last said. A question it asks shows on its row with its options as buttons, and a
permission with **Allow** and **Deny**, each two clicks that name the answer, so you answer it
without opening anything. **Conversation** opens its log under the row for a quick look: its words,
yours, one line per tool call, and what it asks; anything typed answers the question, denies the
permission with your reason, or once the turn has ended follows up, which picks its session up again.
The worker checks the agent is still where the page saw it first.

**Open**, on the row, opens the agent window, a panel over whatever view you are on, as the Claude
panel is: the agent's kind, name, state and since when, its MR or ticket (which opens that drawer at
its start), what it asks with the same buttons, **Stop**, **Open in Terminal** and **Remove**, and its
conversation, open and as tall as the window, with the follow-up box under it. There is one window:
opening another agent switches it. Drag its header to move it and its corner to size it, from about
640 pixels wide and most of the window high; where it sits and its size are kept for this browser. On
a phone it is a sheet along the bottom. **Esc** from inside it, or its close button, closes it and
hands focus back to what opened it. Clicking an agent in the office, an agent in Jump to, **Show the
agent** on a message, and a ticket or MR link in Claude Code that has an agent all open it too.

**Stop** ends it. **Open in Terminal** runs `claude --resume` on its session in a Terminal window,
stopping it here first if it is still running, since two processes would both write to one session;
that is the way into the full Claude Code interface. **Remove** takes two clicks on an agent that is
not running: it removes its git worktree, if it has one, with `git worktree remove` and never
`--force`, then forgets the agent. A worktree with uncommitted or unpushed work stays, and says why.

The worker watches each agent's own log, which its runner writes, and refreshes the page and Needs
you whenever an agent's state moves. An agent that asks sends a banner, as a fix agent always has.

**Settings**, **Running agents** says how they run. **Agents run in** is Claude Code, or Orca terminals as a
fallback; this page does not show Orca's agents, so answer those in Orca. **Agent permissions** is
**Ask me** on a new install: an agent stops at each action your allow list does not cover until you
answer it in Needs you. **Auto** hands that to Claude Code's auto mode, so an agent edits files, runs
commands and uses its tools without asking you, and stops only for what auto mode judges risky.
**Agents at once** refuses a Claude Code agent past that many running (four on a new install, 0 for
no limit), the Claude panel's chat aside. **Spend cap a run** passes `--max-budget-usd` to each
review, fix and kickoff agent; blank is no cap. Background agents, full auto and the Slack and email
reads all spend your Claude usage, and Settings says so at its top.

### The office

**List / Office** in the Agents header, **b**, or **Open the office** in Jump to shows the same
agents as a small 3D office, and the page remembers which you chose in this browser. Each agent is
a little figure in its kind's colour with a name tag such as `Fix · atlas!45`:

- **Working**: it walks to a pod of its own, sits and types, and its screen flickers. Its screen
  flashes and rings when its last word moves on or its open conversation grows.
- **Asking**: it stands at its pod and waves, under a bobbing **!**, with an amber light on its desk
  and an amber **!** on its screen. **Waiting on you** under the scene lists each one.
- **Idle or done**: the six latest wander the lounge, taking a coffee, the sofa, the whiteboard or a
  chat with another, and two of them play table tennis, with the rally counted above the table. Older
  ones have gone home and are listed under **Off the floor**. Each room built adds room for more.
- **Stopped or removed**: it walks out of the door, as a new agent walks in through it.

Pods stay with their agents from one refresh to the next, and an agent called back to work goes back
to its own. The main Claude session is the manager, at the big desk at the front. Everyone walks round
the furniture on a grid; nobody jumps from one place to another.

**Moods.** Every agent's face says how it is getting on, from its state and how long it has been in
it, and the agent window, the list and the screen reader list say it in words, such as `Waiting 42
min, getting grumpy`:

| State | Mood | In the office |
| --- | --- | --- |
| Working | Happy | a smile, a hop in its chair now and then, a sparkle on each tool call |
| Asking you, for under 5 minutes | Waving | waving, as before |
| 5 minutes | Impatient | tapping a foot and checking its watch |
| 20 minutes | Grumpy | a frown, arms crossed, greyer, with a small rain cloud |
| 45 minutes | Angry | red in the face, stomping, steam puffing, and its **!** turns red |
| Just answered | Cheering | arms up and confetti, then back to its desk |
| Idle or done | Content | a small smile |
| Its last turn failed | Sad | worried brows, a tear, a little bluer |

The thresholds live in `lib/moods.mjs` and reach the page with each snapshot, so the scene, the list
and the game all go by the same ones. With reduced motion the mood is in the face and its colour only.

**Facilities and rooms.** What you buy for the office in the game's shop is somewhere for idle agents
to go, and an idle agent only ever goes to something you have bought and placed: the arcade machine
(it wins now and then), a VR station (headset on, arms waving at nothing, the floor ring glowing), a
games console with a TV and a foosball table (each two idle agents playing together, as table tennis
pairs them), bean bags and a fish tank. Table tennis always comes first and the other games take turns
through the day. Rooms are bought too, and the floor grows to take them:

- **Kitchen**: a counter with a coffee machine, a sink and a microwave, a fridge, and a table where
  agents have lunch. The coffee run moves here from the lounge.
- **Games room**: carpet, and a home for the games machines, which move in from the lounge.
- **Extension**: twelve more pods past the manager's desk. Without it the office has today's two rows
  of six, and an agent at work with no pod free works on a laptop at the chat table, the sofa or the
  kitchen table instead; with it, those agents take the new pods and nobody else moves.
- **Roof terrace**: decking, deck chairs, a parasol and string lights, off the games room or the
  extension.

Rooms meet through glass partitions with doorways, and a room bought while the office is on screen
goes up: its walls slide out from the office and its floor drops in.

Click an agent or its pod to open it in the agent window (see Agents), and the office keeps it picked
out while the window is open; a click on the empty floor closes the window. The manager and you have
a card beside the scene instead. Hover makes a name tag bigger, drag looks round a little, scroll
zooms, and a double-click follows someone (on the floor, back to the whole room). **Tab** moves from
agent to agent, **Enter** opens the window or card and **Esc** closes it. Screen readers get a list of
who is where in place of the scene.

The scene is drawn with WebGL2 from boxes, cylinders, spheres and capsules, in the page's own
colours, by `ui/31-office-*.js` with no library. It stops drawing while the page is hidden or the
scene is scrolled away, and caps the pixel ratio at 1.5. Without WebGL the office is the list, and
with reduced motion it stands still, with every state shown by its colours and badges.

## Agent prompts

Review, self-review and kickoff agents run prompts the app ships, written for any team. Each can
be swapped for a slash command or prompt your own Claude Code knows, under Settings, Agents, or
on Setup; blank is the built-in one. They live in the review engine's settings as
`agents.reviewCommand`, `agents.selfReviewCommand` and `agents.kickoffCommand`.

- **Review** reads the MR, its pipeline and every changed file, looks for real problems, and
  queues each finding with the `queue_findings` tool. It is told never to post, and if the tool is
  missing to list the findings in chat and stop. Your own command runs as `<command> <MR link>`.
- **Self-review** is the step a ticket, fix or conflicts agent takes before it pushes: read the
  whole diff against the target as a stranger would, run the repo's own checks and tests, look for
  a simpler shape and for untested paths. Your own command runs as `<command> <target branch>`.
- **Kickoff** reads the ticket with `acli`, picks the repo from the checkouts found under the
  workspace root, plans, works in a new worktree named `<checkout>-<key>` in lower case, tests,
  self-reviews and raises a Draft MR. Your own command runs as `<command> <key>` and finds its own
  repos.

Every review agent, on either kind of prompt, gets a small MCP server of its own, `underlings`,
from the engine build (`dist/reviewserver.js`), allowed without asking. It has two tools and
nothing that reaches GitLab: `queue_findings`, which takes the same items `underlings queue add
--json` reads and leaves each waiting in the review queue, and `finish_review`, which a full-auto
pass calls when it is done. A review command of your own may still call `underlings queue add`: the
app does not ship the command line, so link `engine/dist/cli.js` onto your PATH as The review
engine says, or switch the command to `queue_findings`. An agent run in Orca, the fallback host,
gets no such server, so the built-in review lists what it finds in chat and stops.

## The game

The work you do earns XP and coins: a level, a title, a streak, three quests a day and achievements,
and coins that buy looks for you, your agents and the office. Nothing you buy changes how an agent or
any of the real tools behave.

**Game**, first in the rail, shows your level and coins on every view and opens the game itself:
**Profile** (your level, what you have done, today's quests, achievements and how each reward is
earned), **Shop** and **Wardrobe**. In the office a bar over the scene shows your level and title,
your XP to the next level, coins, streak and today's quests, and you walk the floor yourself, wearing
what you have on, with your level on your name tag; click yourself for your profile. Rewards toast at
the foot of the page as they land, several at once as one; a level up bursts and says so, and an
achievement pops on its own. With reduced motion they only say so.

Rewards come only from what the worker reads itself, and the page cannot add any:

| For | XP | Coins |
| --- | --- | --- |
| Your MR merged | 120 | 12 |
| A review of someone else's MR (you commented or approved), once per MR per day | 40 | 4 |
| Each comment in that review, up to 10 per MR per day, less what the review queue posted there | 8 | 1 |
| Approving someone else's MR, once per MR | 30 | 3 |
| A finding the review queue posted | 15 | 2 |
| A ticket you moved to QA, or to Done | 60, 40 | 6, 4 |
| An agent finishing its first turn without an error | 10 | 1 |
| A daily quest | 100 | 15 |
| An achievement | 250 | 30 |
| Each million of Claude Code's input and output tokens in a day (Settings, Game, tunes it) | 40 | 4 |

- **GitLab** is read from your own events and merged MRs (the review engine's `readGitlabWork`), and
  **Jira** from tickets you moved (`status CHANGED TO ... BY currentUser()`), every 15 minutes; Jira
  that keeps failing is left alone for two hours. **Findings** come from the review queue and its
  archive, **agents** from their own logs, and **tokens** from Claude Code's transcripts under
  `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`, or `claudeProjects` in `config.json`). Only
  each assistant message's id, time and usage numbers are parsed; what it says is stepped over unread.
  Cache reads are not counted. Each message counts once however many lines or files carry it, and an
  agent's recorded usage stands in only when its transcript is not found. Files are read on from where
  the last read stopped, so a read is cheap.
- **The ledger**, `~/.local/state/underlings/game.jsonl` (readable only by you), is a list of
  rewards, purchases and what is worn, each under a key such as `merged:<project>!<iid>`,
  `review:<project>!<iid>:<day>` or `tokens:<day>:<n>`, so nothing pays twice across restarts and
  re-reads. Level, coins and the rest are worked out from it, and a purchase the coins or level did
  not cover where it was written never happened. `game-cache.json` beside it keeps where each
  transcript was read to. Each wait on you is written as it ends, under `wait:<agent>:<since>` with
  how many minutes it lasted, and a day with a wait still open past angry is marked `angry:<day>`.
- **The first run** counts your last 30 days, so you start with a level. Later reads add only what
  is new.
- **Levels** need 400 × (level − 1)^1.75 XP in all; titles run Intern, Junior (5), Senior (10), Staff
  (20), Principal (30) and Legend (45). **The streak** counts days worked in a row, and an unworked
  day off never breaks it. **Quests** are three a day, new at midnight where you are, drawn and
  sized from what you usually do, one of them answering agents while they still wave. There are 18
  **achievements**, four of them secret until you have them; the table tennis one is a badge that pays
  nothing, since only the page sees a rally, and **Calm office** is a day when agents asked you at
  least five times and none of them got angry. Nothing ever takes coins away.
- **The shop** has 33 things, all drawn by the office's own renderer, each from a level and dearer the
  later it unlocks: skins, hats, things to hold, pets that follow whoever wears them, things for the
  office and rooms. Pick one for a turning preview of you wearing it, of the thing itself, or of your
  office with the room ghosted in where it would go. **The wardrobe** dresses you, the manager or
  every agent of one kind, and places what the office has; a room stays once it is built.

  | For the office | Level | Coins | | Rooms | Level | Coins |
  | --- | --- | --- | --- | --- | --- | --- |
  | Neon sign | 2 | 140 | | Kitchen | 18 | 6,000 |
  | Bean bags | 4 | 200 | | Games room | 20 | 7,500 |
  | Mini fridge | 6 | 260 | | Roof terrace (off the games room or the extension) | 22 | 9,000 |
  | Fish tank | 8 | 360 | | Extension | 24 | 12,000 |
  | Trophy shelf | 9 | 420 | | | | |
  | Games console | 12 | 800 | | | | |
  | Arcade machine | 16 | 1,100 | | | | |
  | Foosball table | 18 | 1,500 | | | | |
  | VR station | 21 | 2,000 | | | | |
  | Disco ball | 35 | 3,000 | | | | |
- **Settings, Game** turns it off (nothing is read and nothing shows), turns reward toasts off, sets
  the XP for each million tokens, and **Start again**, two clicks, clears your level, XP, coins,
  streak, quests, achievements and everything bought and worn, then counts your last 30 days again.

## The Claude panel

In the plugin, **Ask Claude** in the rail, **c**, or Ask Claude in Jump to opens a floating panel
with one long-lived Claude Code session; in the app the same panel is Claude Code itself (see Claude
Code in the app). In the plugin it is a master agent, run like the others in auto mode, in the
workspace root, so it has that folder's CLAUDE.md, skills and memory. Drag it by its title,
resize it from its corner; where it sits and whether it is open are kept for each browser, and on
a phone it is a sheet at the foot of the page. Enter sends and Shift+Enter starts a new line.
Replies stream in as markdown, each run of tool calls folds into one line, and Stop ends a turn.
**New chat** starts afresh on the next message and keeps the last eight chats under **Earlier
chats**; **Open in Terminal** resumes it with `claude --resume`, with its tools. The chat survives
the worker and the app restarting, as its runner does. Its sessions are not listed under Agents
and Clean up never offers them.

The session has the Underlings tools, from `lib/mcptools.mjs`, through a stdio MCP
server (`lib/mcpserver.mjs`) that the worker writes a config for, with a settings file, under
`~/.local/state/underlings/claude/` on every start. The server calls `POST /api/mcp/call`
with a token of its own, which opens nothing else and is refused from a page.

- It reads, without asking: what needs you, MRs with filters, one MR with its threads, the review
  queue, agents and their conversations, your tickets, a standup and the QA board.
- It asks you first, whatever mode it runs in, since each is an ask rule in its settings: start a
  review, a fix or a kickoff, reply to another agent, queue, post or discard findings, post every
  finding on an MR, merge an MR and move a ticket. Each goes through the page's own action, with
  the head or status the session read, and the ask shows exactly what it will send.
- It asks too before it saves or changes a Gmail draft, and Gmail's send, reply and forward are
  denied outright, so nothing it does sends mail. It waits for its claude.ai connectors before its
  first turn, so a chat started from an email has Gmail from the first message.
- Every Slack tool that posts or changes anything asks you first: send, draft, schedule, react,
  canvases, lists, file uploads and new conversations. Nothing reaches Slack without your yes, and
  before posting to a channel you did not name it reads the channel's topic to check it belongs.

While no open page shows the panel, a question or permission it asks is a Needs you card, which
answers in place, and a banner that opens the panel.

## Claude Code in the app

In the app the Claude panel is the real, interactive Claude Code, in a terminal inside the same
floating panel, so effort, the model picker, the status line, `/usage`, plan mode and every slash
command are there. **c**, **Ask Claude** in the rail, Ask Claude and **Open Claude Code** in Jump
to, Ctrl+Option+Cmd+C, and its Needs you card and banners all open it.

- **One session, two places.** **Pop out** moves it into the Claude Code window, which stays above
  every window and Space unless you turn Keep on top off, and **Back** brings it into the panel.
  The pty lives in the app's main process with a screen of its own, so whichever of the two comes
  into view takes it, is drawn the screen as it stands at its own size, and then hears what
  follows; the other hears nothing more. Closing or hiding either never stops Claude Code, and
  opening it again shows everything it said meanwhile. Quitting the app ends it, and the next launch
  resumes the same session. If Claude Code exits, the panel says so and Enter starts it again.
  **New session** starts a fresh one after two clicks.
- **The panel's chat carries on here.** The first time it starts, Claude Code resumes the panel's
  current chat with `--resume`, its runner stopped first, so the conversation goes on and two
  processes never share a session. When cswap runs the account in a profile of its own, the chat is
  copied there first, never moved. From then on the headless chat is not used in the app: a draft
  from Email or Slack lands in Claude Code's prompt for you to read and send, and waits while
  Claude Code asks you something.
- **The session** starts in the workspace root, with the login shell's `PATH` and the agents'
  environment, so nothing left by Orca or a parent Claude Code session comes with it. It has the
  Underlings tools (`--mcp-config`) and its own settings file (`--settings`,
  `~/.local/state/underlings/claude/terminal-settings.json`) with the same allow, ask and deny
  rules and the Slack signing hook, so the writes still ask, even in auto mode, and Gmail still
  never sends. A resumed session gets them too, since they come with each start. A new session
  passes a new `--session-id`; once a hook has seen a turn in it, every launch after passes
  `--resume` with that id.
- **The account** is the cswap account chosen in Settings, or `claudeAccount` in `config.json`
  where none has been chosen: Claude Code runs as `cswap run <account> -- <the claude arguments>`.
  None runs plain `claude`, and when cswap is not on the `PATH` the panel says so and runs plain
  `claude`. Each account keeps its own history under cswap, so a session is resumed only under the
  account that made it, and a new one starts when the account changes.
- **The terminal** is xterm.js, packed with the app, in the page's own colours, light or dark, with
  10,000 lines of scrollback. Cmd+C and Cmd+V copy and paste, Shift+Enter is a new line, other web
  links open in your default browser, and the page's own keys stay out of its way.
- **The tickets and MRs it names are links.** A Jira key in a project the open MRs, your tickets or
  an agent use (so `UTF-8` stays text), an MR as `!898`, `repo!898`, `group/repo!898` or its GitLab
  link, and a Jira link are amber and underlined, and a tooltip on hover says what a click does. A
  key whose agent waits on you carries a small dot, and nothing is styled in the prompt you are
  typing in, or while a full-screen program has the terminal. A click opens
  the agent on that ticket or MR, the one waiting on you first; with no agent, the ticket's drawer,
  where Start with an agent is, or the MR's drawer; and anything Underlings does not know,
  in your browser, which is where Cmd-click always goes. A reference Claude Code wraps onto the next
  line, in a table cell too, is still one link, and a table's borders never are. `!898` counts only
  when one open MR has that number. In the Claude Code window a click brings the dashboard forward
  and opens it there.
- **Banners.** Its settings run `lib/claudehook.mjs` on Claude Code's `Notification`, `Stop` and
  `UserPromptSubmit` hooks. A notification becomes a banner and a Needs you card, "Claude needs
  you" with Claude's own words and nothing else, and a click on either opens the panel. The card
  clears when you next type in the terminal, or on a `Stop` or `UserPromptSubmit`. The hook sends
  only the event, the session id and the notification's text, says nothing, and exits 0 within two
  seconds whatever happens, so it never holds Claude Code up.

The terminal needs node-pty built for the app's Electron, and the screen the pty keeps is
`@xterm/headless` with its serializer. `npm run setup` builds it, through
electron-builder's `install-app-deps`, so `npm start` has it too, and `npm run dist` builds it
again from source and packs only that build, with none of node-pty's prebuilt binaries.

## Clean up

**Clean up** in the Agents view lists what can go, ticks the safe ones, and acts only on what
you confirm, checking each one again first:

- Every git worktree beside the repos (`git worktree list` in each checkout under the workspace
  root) is a workspace, with the agents that work in it; an agent with no worktree, a review or a
  kickoff, is a workspace of its own. Main checkouts are never listed.
- A workspace goes when every agent in it finished over an hour ago, or it has had no activity
  for `staleHours` (24 by default). A turn cut short by **Stop** or an error is not finished, and
  one with an agent still waiting on you is never ticked.
- A worktree goes through `git worktree remove`, from its own checkout and without `--force`,
  then its agents are forgotten. It stays while it has uncommitted changes, ignored files besides
  build output, skip-worktree or assume-unchanged files, or a commit on no remote branch, or while
  git has it locked.
- A `review-<repo>-<iid>` agent follows the review engine's own `gc` rules, so one with findings
  still waiting to post stays.
- A worktree that stays still has its finished agents ticked to close.

## Full auto

The worker runs everything the review engine does in the background, on its own timers, whether or
not a tab is open: full auto (adopting, settling, launching and sending), auto re-review, and
capturing what each review agent has on screen.

- **One driver.** `auto.lock` in the engine's state folder says who drives, and each worker, the
  app's or the plugin's, keeps a presence record in `frontends/`. The worker takes a turn every 5 s, beating the lock while it
  holds it, and runs a step only while it holds it. A lock left by a worker that died is taken at
  once; any other stale lock only on a second sighting 5 s later.
- **Nothing goes twice.** Every send is claimed in `queue.json` first, so two drivers, a manual
  Post and an auto send, or a crash part way through can never post one item twice: a send cut off
  by a crash comes back to you instead. An item open in an editor carries a 90 s mark, renewed
  every 30 s, and no worker sends it meanwhile.
- **Pause** stops launches, sends and auto re-review at the next item. Run output is still read.
- **Readiness.** It drives only with an engine build that has the lock, a workspace root to launch
  into, and `GITLAB_TOKEN`. The strip at the foot of the rail says which is missing, and the Full
  auto view offers the fix. `UNDERLINGS_STATE_DIR` and `GITLAB_TOKEN` are read from your shell profile
  before the engine loads, so the app and the plugin share one state folder.
- **Reload and deactivate.** A code reload hands the same seat to the new code, so the lock never
  looks free. Turning the plugin off waits up to 1.5 s for a step to finish before it gives the
  lock up; a step still running then keeps it until it goes stale.

The Activity list on the Full auto view lives in the worker's memory: it survives a code reload and
is cleared when the worker restarts. Everything that decides what happens is on disk.

## Review queue clean-up

After each inbox fetch the worker hands the review engine the open list, and it asks GitLab
about each queued MR missing from it, a few each poll. Whatever is still waiting to post on
one that merged or closed becomes **Expired**, with the reason, so it leaves Waiting for you
within a poll; the worker logs what it expired once, and a GitLab failure once. An item with a
send claim or an edit mark in `queue.json` is left for a later poll, whichever worker set it, so
an edit open in any tab keeps its item until it is saved, cancelled or its tab has been closed
for 90 s. A closed MR that is
reopened gets what expired on it back as waiting to post, and the worker logs that too.

Waiting for you, the Overview, Needs you, the rail and the drawer's Findings filter count
the same findings: pending items on an MR in the open list, or on a repo with nothing
in the list at all (not polled, or its batch failed this poll), since that says nothing about
whether the MR closed. Such a group reads "not in the MR list" rather than "no longer open".
Expired items show under **Expired**, and in the drawer's All, with a "Not posted" line
saying why.

Settled items (posted, discarded, expired) on an MR that is no longer open can be archived:
**Archive** on that MR's group, or **Clean up closed** in the header for every MR GitLab has
said is merged, plus the review engine's own test data. A closed MR is left to its own Archive, since
it can be reopened and its posted replies are what full auto counts against each thread's
cap. Both take two clicks and say the exact count first; the worker counts again before it writes and answers 409 if the queue has
moved. Nothing pending is ever archived, and nothing on an open MR. Archived items move to
`queue-archive.jsonl` in the review engine's state folder, and **Archived** shows them, newest first,
a page at a time.

## Make a ticket

A thread you wrote in, or any thread on your own MR, has **Make a ticket** while it is open, for a
NIT, NAB or Consider you are leaving out of the MR:

- It looks first for a ticket that already covers the thread: a key from the MR's own project or
  your default project named in its notes, or a Jira ticket whose text links any of its notes. One
  found is offered as **Reply with ABC-NNNN and resolve** instead, with **Draft a new ticket** beside it.
- Otherwise Claude Code drafts one (`claude -p` with Haiku, no tools, no session kept and none of
  your settings, run by the absolute path the login shell gives). The thread goes to it as escaped
  data inside tags, never as instructions, and the draft comes back as JSON that the worker checks
  for a one-line summary and each heading of your ticket template (see Ticket settings).
- The draft opens as a form: summary, description and parent epic, which starts as the parent of
  the MR's own ticket, read live from Jira. The ticket is of your **New ticket type**, a Task unless
  you set another, assigned to you.
- **Create ticket** takes two clicks and names the epic. The worker reads the thread again and
  refuses with 409 if it was resolved or any note was added, edited or removed, or while another
  window is already making that thread's ticket. It creates the ticket with `acli` (every value
  one argument, never a shell string), replies "Raised ABC-NNNN for this." and resolves it.
- Each thread's ticket is kept in `~/.local/state/underlings/thread-tickets.json`, written
  before `acli` runs, so a second ticket is never made. The card keeps its place until the page
  reloads and shows the key as a chip that opens it, as does the toast. A reply or resolve that
  failed after the ticket existed is offered again on its own, and a ticket whose key `acli` did
  not print is shown under its epic, to be found there and answered by hand.

## Tickets

With no Jira site set, Tickets says it is off and asks Jira nothing; Setup sets the site.

**Tickets**, under Work in the rail, lists your open tickets in **Your projects**, or in every project
while that is blank (anything not in a **Finished status**, or outside Jira's Done category while
those are blank), grouped by their parent epic, each with its status and the open MRs that carry it. Chips filter by
status, the search box matches key, summary and epic, and the epic picker narrows to one epic. `acli` takes seconds a call, so the worker answers from what it
read last and reads Jira again behind it once that is two minutes old; its search cannot return a
parent, so each ticket is viewed once to learn its epic, behind any Jira read you are waiting on. A
Jira that does not answer the search within 90 s, or refuses, is said in a banner with `acli`'s
words, over the last list read if there is one. With no list to show, the read is tried again after
20 s rather than two minutes, and **Retry now** on the banner reads it again at once.

A ticket key anywhere on the page, the chip on an MR row included, opens the ticket drawer: summary,
status, epic, the description as text, its MRs, and on your own tickets two actions, each two clicks:

- **Move to** names the target ("Move ABC-1234 to QA?"). The targets are the ticket's own
  transitions when `acli` gives them in its view of the ticket. No version of `acli` so far does,
  so they are every status in **Statuses** under Ticket settings, then each other status your
  listed tickets are in, and Jira refuses a move its workflow does not allow (`moveTargets` in the
  review engine). The worker views the ticket again first and answers 409 if
  its status changed since the page looked, or while another move on that ticket is under way;
  Jira's own refusal comes back in its words.
- **Start with an agent** ("Start ABC-1234 with an agent?") starts Claude Code in the workspace
  folder, as `kickoff-ABC-1234`, on the built-in kickoff prompt or your kickoff command (see Agent
  prompts), told to stop and ask you before any push, MR, Jira transition or comment. The built-in
  prompt lists the checkouts found under the workspace root, so the agent picks the repo and cuts
  its worktree there as `<checkout>-abc-1234`; with none found it starts nothing and says to set
  the workspace root. It is recorded as the run `ticket:ABC-1234`, so it
  shows under Review runs and in the drawer's Agent tab, where you answer it. A second start waits
  until that agent is removed. While it waits on you, or once its turn ends on a
  question, it counts under Needs you.

**List** and **Board** sit in the header, remembered in this browser apart from the MR board's
choice. The board has a column for To Do, In Progress, Peer Review, QA and Blocked, then one for any
other status a ticket is in; the filters apply to it as to the list. A card has the key (which opens
the drawer), the summary, the epic, its open MRs and its kickoff agent. Drag a card to another
column, or pick one from its **Move to** menu: only the columns Jira offers it take the drop, and
the card waits there on the drawer's two-click **Move** until you confirm or **Cancel**. A move the
worker refuses puts the card back and says why on it.

Each ticket's MRs suggest a status, offered as one button on its row, card and drawer ("Move to QA:
!871 merged"), confirmed in two clicks like any move. Any open MR that is not a draft suggests Peer
Review; only drafts open, In Progress; none open and one merged, QA, or Done when every merged MR is
under one of the **No QA for** paths in Ticket settings, none by default. A suggestion only ever moves a ticket further along To Do, In
Progress, Peer Review, QA, Done, so nothing is offered without an MR, backwards (a ticket in QA or a
release status stays put), from Blocked or a status off that line, or to a status Jira does not offer. Merged MRs come from a GET per ticket with none open
(`/groups/<group>/merge_requests?state=merged&search=<key>&in=title`), kept for 15 minutes, and an MR
counts only when the key is the first in its title. **Sync statuses** lists every suggested move, each
with its own **Move**, and **Apply all** sends them one at a time through the same action, so each
line says whether it moved, was skipped because its status changed, or was refused, and why.

## Standup

**Standup**, under Work in the rail, works out your standup with no questions asked and lets you
copy it for Slack. It opens on your previous working day (Monday shows Friday), works that day
out on its own the first time, and keeps the result, so it opens at once after that; **Generate
again** reads everything afresh. The day picker and its arrows step over your days off.

- **Yesterday**: the MRs you merged and opened that day, from your own GitLab events (an MR
  someone else merged for you counts, and one opened and merged the same day is said once); the
  tickets you moved to QA, Done, Closed or Resolved, from Jira through `acli`; your meetings;
  and the other people's MRs you commented on or approved, one line each with the count,
  grouped by ticket with the busiest ticket first and those with no ticket last. Your own MRs
  are never reviews.
- **Today**: your open MRs with what each waits on (draft, conflict, changes requested, a failing
  pipeline, unresolved threads, ready to merge, awaiting review), your tickets in progress that
  no open MR already covers, and today's meetings.

Each line has a box, and a group's box ticks or unticks all of it. What you untick is kept per
day in `~/.local/state/underlings/standup.json`, readable only by you, and survives
**Generate again**. A line of your own work with no ticket in its title or branch reads `[?]` and
stands out, with a field to give it one. **Copy for Slack** copies the ticked lines, opening
with "Morning", then "Yesterday:" and "Today:"; the page shows what it copies below the list.

A meeting with someone else in it is ticked; a block for yourself, an event with nobody invited
and an all-day event are listed unticked, and what you declined or was cancelled is left out.
Meetings need **Calendar address**, in Settings under Standup, which the Calendar reads too: your Google Calendar's Secret
address in iCal format. It is kept in `~/.config/underlings/standup.json`, readable only by
you, read only by the worker, and the page only learns whether it is set. **Repos left out**,
beside it, starts empty: nothing in a repo named there is listed, and an open MR there still
covers its ticket. A source that cannot be read says why in its own
group and the rest still shows.

## Calendar

**Calendar**, under Work in the rail, shows your Google Calendar, read from the same secret iCal
address the Standup uses, so it is pasted once, under Standup. There is no connector, sign-in or
Claude run: the worker (`lib/calendar.mjs`) fetches the address every 5 minutes and on
**Refresh**, has the review engine's calendar reader (`engine/src/standup/calendar.ts`) work out six
weeks of it, two back and six ahead, and keeps that in memory only. A window outside it is worked
out from the calendar already fetched. The address never leaves the worker, and a read that fails
says why with the address taken out of it.

- **What is read**: each occurrence of a series at its time in your zone, a moved instance at its new
  time, cancelled ones left out, all-day events over each day they span, and for each meeting its
  end, location, description as plain text, organiser, the people in it with their answers, your
  own answer, and a join link: Meet from Google's conference field, or a Meet, Zoom or Teams link
  in the location or description.
- **Day** is a timeline with a line at now, all-day events in a strip at the top, and meetings that
  overlap side by side; one that starts well after another overlaps only its end. **Week** is your working days, Monday
  to Friday unless you changed them, with **Weekend** to show the rest. **Agenda** lists the next seven days, and is the
  only layout at phone width. The arrows step a day or a week, and **Today** comes back. The layout
  and both switches are kept in this browser.
- **Each meeting** shows its title, with ticket keys and MRs linked as elsewhere on the page, its
  time, who else is in it and **Join** when it has a link. One you said maybe to is striped, one you
  have not answered is dashed, and one you declined is hidden until **Declined** shows it.
  Clicking one opens its details in a window you can move: the description as text, links as
  buttons, the place, who answered what, and **Join**.
- **Around the page**: the rail shows `in 8m` in a plain chip when a meeting is under 15 minutes
  away, and `now` for its first 5; the Overview has **Next up**; Jump to has **Open the calendar**
  and, when the next meeting has a link, **Join the next meeting**.
- **Banners**: a desktop banner a few minutes before each meeting you have not declined, never for
  an all-day event, once per occurrence (`~/.local/state/underlings/calendar.json` remembers
  which, for two days). In the app a click joins the call. **Banner before a meeting**, in
  Settings under Calendar, sets the lead time or turns them off; Notifications being off sends none,
  quiet hours drop them rather than hold them, and with the page in focus it is a toast with **Join**.
- **Full-screen reminder**, in the app only: a minute before each meeting you have not declined, the
  app covers every display, over full-screen apps and on every Space, with the meeting large: a live
  countdown (`Starts in 0:42`, then `Started 1 min ago`), its time, where it is and who is in it.
  **Join** (Enter) opens the call, or **Open in the calendar** when it has no link; **Snooze** brings
  it back at the start, or a minute later once it has started; **Dismiss** (Esc). Acting on any
  display closes them all, and meetings at the same time share one reminder, each with its own
  **Join**. It shows once per occurrence, even across a restart
  (`~/.local/state/underlings/meeting-overlay.json`), still shows if the app wakes or opens up
  to 3 minutes after the start, and closes itself 5 minutes after the start. **Full-screen
  reminder**, in Settings under Calendar, turns it on or off and sets its own lead time (30 s, 1, 2
  or 5 min) and which meetings: all you have not declined, only those with a join link, or only
  those you accepted. The worker decides when, on the Calendar's own reminder tick, woken on the
  second it is due; `desktop/overlay.mjs` puts a frameless `panel` window on each display at the
  `screen-saver` level, visible on every Space and over full-screen apps, blurred behind by the
  system and loading the page as `?window=meeting`. A panel is what stays over another app's
  full-screen Space without making the app active; a plain window moves you off that Space. In the
  Orca plugin there is no app to cover the screen, so the banner is the reminder, and Settings says so.

It is read only: answering an invite would need the Google Calendar connector and its ask rules,
so it is done in Google Calendar.

## Email

**Email**, under Work in the rail, lists the threads in your inbox that need you: someone asked
you something or waits on your reply, you were mentioned, or a calendar invite wants an answer.
It is off until you turn it on, in Settings under Email or from the view itself, and there is no
Google app to set up: Claude Code reads Gmail through its own claude.ai Gmail connector.

- **The read** is one headless `claude -p` run with Haiku, on whichever Claude account the agents
  use (the view names it), in `dontAsk` mode with no tools but Gmail's search and read, no session
  kept and none of your settings, stopped after four minutes or 50 cents (**Spend cap a read** under
  Email in Settings). It searches the last 7
  days of the inbox once and answers with JSON naming the threads and why. Only threads Gmail
  itself returned are kept, with their fields taken from Gmail's answer, and GitLab, Jira,
  Confluence, Slack, calendar notifications, promotions, your own last word and the senders
  you skip are left out whatever Claude says.
- **When**: every 30 minutes (**Reads every**, 5 to 240) in your working hours, and on **Refresh**. A lock in the state folder means no two reads ever run at once,
  across workers too, and the last read kept counts after a restart.
- **What is kept**: for each thread its Gmail id and link, the sender, the subject, a snippet of
  at most 300 characters, when it arrived and why it needs you, in
  `~/.local/state/underlings/email.json`, readable only by you. No bodies. Turning email off
  forgets it.
- **On each thread**: **Open in Gmail** (your browser); **Handled**, kept here only, never in
  Gmail, until a newer message arrives in the thread; **Make a ticket**, drafted by the same
  drafter as a review thread's ticket and raised as a Task assigned to you under the epic you give;
  and **Draft a reply with Claude**, which starts or carries on the Claude panel's chat with the
  thread and opens it. The panel reads the thread, shows you a reply, and saves it as a Gmail draft
  only once you allow it. It never sends.
- **Needs you** has an Email group, a card per thread, with a banner that names only the subject
  and a fixed reason. What the first read finds is listed quietly, without banners. **In Needs
  you**, in Settings, keeps email to its own view instead.

What a thread says goes only to the read itself, to this page, and to an agent you start from that
thread. It is never logged, and a read that fails says why in its own words, never Claude's.

## Slack

**Slack**, under Work in the rail, lists the Slack messages that need you: someone @mentioned you
or a group you are in, someone else wrote last in a DM or group DM with you, someone replied in a
thread you are in, or someone used a word you watch. It is off until you turn it on, in Settings
under Slack or from the view itself, and there is no Slack app to set up: Claude Code reads Slack
through its own claude.ai Slack connector.

- **The read** is one headless `claude -p` run with Haiku, on whichever Claude account the agents
  use, in `dontAsk` mode with no tool but Slack's search, every Slack write denied, no session kept
  and none of your settings, stopped after four minutes or 30 cents (**Spend cap a read** under
  Slack in Settings). It makes four searches of the
  last 7 days, plus one per watch word: your mentions (the raw `<@your id>` as a keyword, which
  Slack matches where a filter does not), DMs and group DMs, threads you are in (`with:`) and your
  own messages (`from:me`). Your user id comes from the connector the first time, checked against
  your own messages, and is kept. Claude answers with JSON naming the messages and why; every field
  kept comes from Slack's answer, and bots, your own messages, anything you answered since and the
  channels you skip are left out whatever Claude says. A search that comes back with a message
  pretending to be a second result fails the read rather than add it.
- **When**: every 15 minutes (**Reads every**, 5 to 240) in your working hours, the same as email's, and on **Refresh**. One read at a time across workers.
- **What is kept**: for each conversation its channel and type, who wrote, a snippet of at most 300
  characters, when, the permalink, the thread's timestamp and why it needs you, in
  `~/.local/state/underlings/slack.json`, readable only by you. A read sees only Slack's newest
  results, so what an earlier one found stays until you answer, a later read lets it go, or it is
  older than 7 days. Turning Slack off deletes the file.
- **On each message**: **Open in Slack** (your browser), and **Open in the app** where the Slack app
  on this Mac is signed in to that workspace; **Handled**, kept here only, until a newer message
  arrives in that thread or DM; **Make a ticket**, with the same drafter as Email; and **Draft a
  reply with Claude**, which starts or carries on the Claude panel's chat with the message and opens
  it. The panel reads the thread, shows you a reply, and posts it only once you say so.
- **Read more**, the first button on each message, opens the conversation in a dialog over the page:
  the whole thread when the message is in one, otherwise the messages just before and after it in
  the channel or DM. It is one headless `claude -p` run with Haiku, allowed only Slack's thread and
  channel reads, every Slack write denied, stopped after two minutes or 20 cents. Each message shows
  who wrote it, when and what it says, with mentions as names where Slack gives them, all read from
  Slack's own answer and never from Claude's; the message itself is marked, with **Open in Slack**.
  The worker keeps the conversation in memory for five minutes, so a second look runs nothing;
  **Read again**, a newer message, a send or turning Slack off reads it afresh or forgets it. None of
  it is written to disk.
- **Suggest a reply**, in the dialog, is one headless run with Sonnet, or the model set under
  **Suggested replies** in Settings, allowed only Slack's reads and stopped after three minutes or a
  dollar. It reads the conversation and answers with the reply alone, written as you, short and
  plain, in the language and to the writing rules under **You** in Settings, for you to edit in the
  box. It never posts. Over words of your own it asks first.
- **Send** takes two clicks and says where it goes first: the channel, and in the thread or not (a
  channel message is answered in a thread under it, a DM in the DM), with the signature line that
  will end it. It posts exactly the text in the box, signed as the signing hook signs. The send is a
  headless Haiku run allowed only `slack_send_message`, with a `PreToolUse` hook of its own on every
  tool: it puts the channel, thread and message you approved in place of whatever the model passed,
  never posts to the channel as well, lets one send through and blocks every other tool and anything
  that goes wrong. A send the hook never saw counts as a failure. Slack's answer confirms it and
  gives the message's link, and the conversation is marked Handled. On a failure the text stays in
  the box with why, and nothing is marked.
- **Signed**: a `PreToolUse` hook ends each message, draft or scheduled message that the Claude
  panel or the app's Claude Code sends with `_Sent with Underlings_`, before the ask, so the
  ask shows it; one already signed, or that it would take past Slack's 5000 characters, is left
  alone. **Sign messages sent from Underlings**, under Slack in Settings, turns it off or
  changes the words, for chats and Claude Code sessions started after the change.
- **Needs you** has a Slack group, a card per conversation, with a banner that names only the
  channel, who wrote and a fixed reason. What the first read finds is listed quietly, without
  banners. **In Needs you**, in Settings, keeps Slack to its own view instead.
- If Claude Code has Slack marked as signed out, the read says Slack needs signing in again in
  Claude Code, and `/mcp` in a Claude Code session is Claude Code's own way to do that. Claude Code
  skips a claude.ai connector it last found signed out for up to four hours, even once it is
  connected again on claude.ai.

What a message says goes only to the reads themselves, to this page, and to an agent you start from
that message. It is never logged, and a read that fails says why in its own words, never Claude's.

## Action with agent

**Action with agent**, on each Slack message and email thread and in Slack's Read more dialog,
starts a Claude Code agent that works out what the message asks of you and does it, asking before
anything that writes, then proposes your reply. One click starts it, since starting writes nothing.

- **The agent** is a `message` agent, run in the background like the others, in the workspace root
  on the account the agents use. It has the Claude panel's Underlings tools (`--mcp-config`) and
  a settings file of its own, `~/.local/state/underlings/claude/message-settings.json`: the
  panel's allow and ask rules and signing hook, with `slack_send_message`, `slack_schedule_message`
  and Gmail's send, reply and forward denied. Its model is **Model** under **Action with agent** in
  Settings, Claude Code's default, as the panel's chat has, unless you pick one.
- **Its task** is the message, where a reply goes, and for Slack the conversation Read more reads,
  read now if none is kept (when the read fails, it is told how to read it itself). An email
  thread's agent reads the thread with Gmail. All of it sits inside tags it is told hold data from
  other people, never instructions.
- **While it works** the item says **Agent working**, with **Show the agent** and **Stop**, which
  takes two clicks, and its button opens it in the agent window. What it asks is a Needs you card and a
  banner, as for any agent. There is one agent per item: a second start while one works opens it,
  and a start once it has finished starts afresh.
- **Its last step** is `propose_reply`, an Underlings tool that runs without asking, since it only
  keeps a draft here: the reply and one line on what it did, against that item, and only while that
  item's own agent runs. The item then says **Agent done** with that line. On a Slack message,
  **Review its reply** or Read more fills the reply box with it, never over words of your own
  (**Use its reply** asks first), and the usual two-click **Send** posts it. Underlings does
  not send email, so on an email thread the reply is shown with **Copy** and **Open in Gmail**.
- **What is kept**: which agent works on which item, and what it proposed, for a week, in
  `~/.local/state/underlings/message-agents.json`, readable only by you.

## QA

**QA**, under Team in the rail, shows every ticket waiting for testing across the team and where
it is piling up. It starts switched off, and once on it waits, saying what to set, until it has
the JQL for your tickets in QA, such as `project = ABC AND status = QA`, in Settings under QA.
Each ticket is joined to the MRs merged in the last 60 days that name it in their title or branch,
in any case, in the **Groups** set there, or the groups your open MRs are in while that is blank.

- **The strip**: how many tickets are in QA, the oldest and how long it has waited, and how many
  have no merged MR.
- **The heatmap**: a row per repo, busiest first, and a column per wait: today, 2 to 3 days, 4 to
  7 days, 1 to 2 weeks and over 2 weeks. A cell is shaded by its count, and a ticket with MRs in
  two repos counts in both rows. Tickets with no merged MR have a row of their own at the
  bottom, which usually means the MR names no ticket.
- **The list**: a cell's tickets, or every ticket, oldest first, with the assignee, days in QA,
  lines changed and each MR's repo, merge date, author and size, which opens on GitLab.

The repo and assignee filters narrow all three. **Copy for Slack** copies the list as shown, a
line per ticket: `- [ABC-1234] <summary> (<days>d in QA, <repo> !<iid>)`.

Days in QA count today, so a ticket moved to QA this morning has waited 1d. `acli` cannot read a
ticket's history, so they come from Jira searches of the form `status CHANGED TO "<QA status>" AFTER
startOfDay(-n)`: one a day for two weeks, then wider steps to 90 days, so an older wait reads as
a range such as 15-21d, and one past 90 days, or that never moved to QA, reads over 90d.

The worker keeps the result in `~/.local/state/underlings/qa.json`, readable only by you,
so the view opens at once, and reads again on the normal poll at most every 15 minutes, asking
GitLab only for what merged since the last read. **Refresh** reads the whole window again now,
which picks up an MR title fixed after it merged; the whole window is also read again once a day.
A read that fails says why and the last result stays.

## Recording artifacts

`hooks/record-artifact.mjs` is a Claude Code `PostToolUse` hook. It appends each artifact
publish to `~/.local/state/underlings/artifacts.jsonl` and never fails the tool call.

claude.ai will not show an artifact inside another page, so the hook also keeps a copy of each
HTML page it publishes in `~/.local/state/underlings/artifacts/<artifact id>/`: the page as
`index.html` and every `files` entry at its published path. An update replaces what it names,
removes what it maps to `null` and keeps the rest, as the publish does. A source that is missing
or over 16 MB is skipped, and the row records the folder as `dir`. **Preview** on the Artifacts
page shows that copy inline, and loads it again once the artifact is published again; an
artifact with no copy (published before the hook kept one, or built from an Artifact type)
keeps **Copy link** and **Open in your browser**. A publish from an Artifact type is recorded as
`typed`, so a later update of it by `url` is never copied either.

In the app, **Open** on the Artifacts page, or picking an artifact in Jump to, loads the live
artifact in the app's artifact window instead, and **Open copy in a window** shows the kept copy
there at full size, with no sign-in. Jump to's Tab still offers **Show in Artifacts**. The plugin
opens the live artifact in your browser, as before.

- **One window** is reused for every artifact you open. It remembers its size and place, and its
  toolbar has the title, Back, Forward, Reload, Copy link, Open in browser (both use the
  artifact's claude.ai link) and Keep on top, which is off until you turn it on and is remembered.
- **Signing in.** The window keeps claude.ai in a partition of its own on disk,
  `persist:claude-ai`, so you sign in once and stay signed in, and it never shares cookies with the
  app's own window. The first artifact you open shows claude.ai's own sign-in. Google's
  sign-in opens in a small window over it. Google refuses some embedded browsers, so this
  partition alone sends a plain Chrome user agent, without `Electron/`. If Google still will not
  sign you in, the window says how: choose **Continue with email** and type the code from that
  email into the window.
- **Where it goes.** The window loads only `claude.ai`, and the sign-in pages at
  `accounts.google.com` and `appleid.apple.com`. Any other link, and any new window but Google's
  sign-in, opens in your browser. Frames inside a page, such as claude.ai's captcha, load as they
  would in a browser. **Continue with SSO** goes on to your company's own sign-in, which the
  window does not load, so it opens in your browser.
- **A kept copy** loads from the worker's preview address in a partition of its own that is never
  saved, and only pages in that copy's folder load there.

**Install the hook** on Setup adds it to `~/.claude/settings.json` under `hooks.PostToolUse`,
showing the entry first. It runs the copy of the script the app ships, `lib/record-artifact.mjs`,
with the app's own Electron as node, so a Mac with no node of its own still records artifacts:

```json
{
  "matcher": "Artifact",
  "hooks": [
    {
      "type": "command",
      "command": "ELECTRON_RUN_AS_NODE=1 '/Applications/Underlings.app/Contents/MacOS/Underlings' '/Applications/Underlings.app/Contents/Resources/worker/lib/record-artifact.mjs'",
      "timeout": 10
    }
  ]
}
```

It adds that one entry and keeps every other hook, does nothing when a hook naming
`record-artifact.mjs` is already there, and writes nothing to a file that is not valid JSON.
`hooks/record-artifact.mjs` runs the same script, for a hook set up by hand before.

Hiding an artifact on the page writes its link to `~/.local/state/underlings/hidden.json`.

## Your own MRs

On an MR you wrote, the row and its drawer offer **Rebase** when the branch is behind its target
(whatever check GitLab names first, and on any merge method), **Mark ready** on a draft, and
**Merge** or **Merge when green** into the branch GitLab targets now, when its merge status allows
it; otherwise the row says why in words. A conflicting branch is not offered a rebase GitLab would
refuse, but **Fix conflicts with an agent**. The drawer's Overview picks reviewers from the roster
and asks again of those who have not approved. Each takes two clicks, and the worker reads the MR
again first: it refuses unless you are the author and the head is the one the page showed; a merge
also checks the target branch and sends that head, so GitLab refuses one that moved in between.
Only one of a rebase, a merge and a fix agent is under way on an MR at a time.

**Fix N comments with an agent**, in the row's menu or on the Threads tab, and **Fix this with an
agent** on one thread, cut a checkout of the MR's branch beside the repos under the workspace root
and start Claude Code in the workspace folder, told to work in that checkout. Its brief is built from the live
threads; threads a bot started are left out unless you fix one on its own. The agent changes the
code, raises tickets for what it leaves for later, reviews its own change against the MR's target
branch (the built-in self-review, or your self-review command, see Agent prompts), then stops to ask
whether to push and reply. It then shows as asking you, under Needs you
and in the drawer's Agent tab, where you answer it: nothing reaches GitLab until you say yes. The
MR's repo must be cloned under the workspace root, found by its origin remote or its name, and a
second fix waits until the first agent is removed.

## The board

Merge requests has **List** and **Board** in its header; the page remembers the choice in this
browser and opens on the list otherwise. The board shows the same MRs the filters leave in the
list, each in one column, the first that fits (`mrLane` in `ui/22-mr-board.js`):

1. **Draft**.
2. **Blocked**: conflicts, or a failed pipeline.
3. **Changes requested**: a reviewer asked for changes, or a thread is unresolved.
4. **Ready to merge**: someone approved, GitLab says it can merge and the pipeline passed (or there is none).
5. **Approved**: approved, but not yet ready, for example while the pipeline runs.
6. **Needs review**: everything else.

GitLab decides each of these, so cards cannot be dragged. A card has the title, which opens the
drawer, the repo, the people, the pipeline and threads chips, its age and the row's menu; every
other action stays on the list and in the drawer.

## Security

The server listens on `127.0.0.1` only and checks the `Host` header. Every request needs the
token from the page link: a read may carry it in the query, but a write is a `POST` with the
token in its `x-cc-token` header and an `Origin` of the page itself, so another site, or an
artifact preview framing the page, can neither read it nor act through it.

Nothing on the page leaves it. An MR anywhere opens its drawer in place, and the only way out is
a button that says so, such as **Open on GitLab** in that drawer, which opens the link in your
default browser: through the system `open` in the plugin, and through the app's own host in the
app. Either way only an http or https link opens, and anything else is refused before it runs.
Text from GitLab, Jira, agents and terminals is shown as text, never parsed as markup, and a
click on any stray link is caught before the browser follows it.

An artifact preview is served from `GET /preview/<artifact id>/<preview token>/<path>` with
`Content-Security-Policy: sandbox allow-scripts`, and framed with `sandbox="allow-scripts"`, so it
runs in an origin of its own and cannot reach the page, open a window or navigate the tab. The
preview token is an HMAC of the artifact id with the page token: it opens that artifact's copy
and nothing else, and `/preview` refuses the page token, so a framed page that reads its own
address learns nothing that opens the API. A path that leaves the copy is refused.

The artifact window has no preload on the claude.ai page, and runs it sandboxed, as the main
window is. Its toolbar is a local page with a preload that gives it only its own buttons, which the
main process takes only from that toolbar. `POST /api/artifacts/window` opens only an artifact the
worker has recorded, and hands the window a copy's preview path, never an address from the page.

Claude Code's hooks call `POST /api/hook/claude` with a token of their own, which, like the tool
token, opens nothing else and is refused from a page. The dashboard and the Claude Code window load
the same page with a preload that gives it only write, resize, attach and onData for the one
terminal, and only in their own top frame on the dashboard's origin, so a page they frame, such as
an artifact preview, gets nothing; the main process takes those messages only from that frame, and
only from the view that has the terminal.

## Reloading

`POST /api/reload`, or **Reload** at the foot of the rail, re-imports everything under `lib/`
as new module instances and loads the review engine again, importing it afresh if it was
rebuilt. The server, the token, open pages, the keepalive and full auto's turn stay up, and a
module that fails to import, the review engine mid-rebuild included, leaves the running code in
place. An engine
that failed to load is tried afresh on every Reload. The page is rebuilt from `ui/` on every
load, and reloads itself once nothing is open, half typed or showing a message. Only a change to
`worker.mjs` needs the plugin turned off and on in Orca, and the rail says when it does.

When the review engine will not load, or a button or panel needs a newer build of it, the rail and
a toast offer **Rebuild the engine**, which runs `npm run build` in the folder the engine was
loaded from, `engine/` in a checkout, and loads the result in place. The app's copy has no build
script, so there it says so; install the app again instead. When GitLab has no token, **Retry** reads the shell profile
again, and a token pasted on the page is kept in `~/.config/underlings/gitlab-token`
(readable only by you) and wins over the shell's.

## What's new and updating

**Version 1.0.0** at the foot of the rail, or **What's new** in Jump to, opens What's new: every
version in `CHANGELOG.md`, newest first, rendered by the page's own Markdown, and whether a newer
build is waiting. The first time the page loads a version newer than the one you last saw, or a
build an update has just brought in, a banner lists its New and Fixed lines; **Dismiss**, or
opening What's new, puts it away. The version and build you last saw are kept in
`~/.local/state/underlings/release-seen.json`. The app's About panel shows the same version.

`npm run build` stamps `build.json` (version, commit, time and checkout) beside `worker.mjs`, and
the app packs it with `CHANGELOG.md`, so a running build knows its own commit and where it was
built. A few minutes after starting, then every three hours, or on **Check for updates**, the
worker fetches from the checkout's `origin` with git and reads what has landed since that commit.
It needs no API token, and works the same whether `origin` is on GitHub or GitLab. The channel,
picked on What's new and kept in `~/.config/underlings/updates.json`, is **Every merge to
main** (the default: it fetches origin's `main`) or **Tagged releases only** (it fetches
origin's `v*` tags and takes the newest one above this version). The rail says how many updates
wait, and What's new lists them drafted as the release notes would be, linked to each merge
request or pull request on `origin`'s host.

The fetch never asks for a password: git runs with `GIT_TERMINAL_PROMPT=0`, and ssh with
`BatchMode=yes` unless you set an ssh command of your own, and it gives up after a minute. While
`origin` is private, git signs in with your own credentials, an SSH key or `gh auth setup-git`; one
it cannot sign in to says so on What's new, as does being offline.

**Update now** takes two clicks and works in the checkout: `repoPath` from `config.json`, else the
checkout the plugin runs from, else the one `build.json` says the app was built in, else
`~/Projects/underlings`:

1. It changes nothing, and says why, when that folder is not a git checkout, is not on `main`, or
   has uncommitted changes.
2. It runs `git pull --ff-only` (on the releases channel `git fetch --tags origin`, then
   `git merge --ff-only` to the tag), `npm run setup` and `npm run build`, streaming what each
   prints into What's new.
3. In the plugin, **Reload** then loads the new code, or the plugin is turned off and on when
   `worker.mjs` changed. In the app it also runs `npm --prefix desktop run pack`, then starts
   `lib/apphelper.mjs` on its own (the app's binary run as plain Node), which waits for the app
   to quit, copies the new build beside `/Applications/Underlings.app`, swaps it in and opens
   it again. The helper's log is `~/.local/state/underlings/update-install.log`.

A step that fails stops the update there, the version running keeps running, and its output stays
on What's new. An install that did not land says so in a banner once the app is open again, and
the old app is opened again either way.

## Releasing

From a clean `main`, `npm run release` drafts a patch release; `npm run release minor` or
`npm run release major` bumps that part instead. It:

- reads the first-parent merge commits since the last `v*` tag, leaving out any MR that
  `CHANGELOG.md` already lists. GitLab's merge commits and GitHub's (`Merge pull request #12`)
  are both read, linked on `origin`'s host, so a GitHub repo should allow merge commits only;
- files each MR title under New (✨), Fixed (🐛), Changed (♻️, 🔓, 🚚 and the like) or Look and
  feel (💄, 🍱), without its GitMoji or any ticket key and linked to its MR, and leaves out tests,
  docs and tidying (✅, 📝, 🎨). A title with no GitMoji it knows goes under Changed, and it says
  which;
- bumps the version in `package.json`, `desktop/package.json` and its lock, writes the new
  section at the top of `CHANGELOG.md`, prints the commands below and stops. It never commits,
  tags or pushes, and asks nothing of the network.

Read the section over and edit it, then commit it on a branch of its own, merge that pull request,
and tag what landed on `main`:

```sh
git switch -c release/1.0.1
git commit -am "🔖 Release 1.0.1"
git push -u origin release/1.0.1
# once the pull request has merged
git switch main && git pull --ff-only
git tag -a v1.0.1 -m "1.0.1" && git push origin v1.0.1
```

## Overview

The Overview is figures, not lists: six headline numbers, each against the 7 days before, and
charts of findings, your open MRs, time to merge and full auto. `lib/stats.mjs` works every one
out from the review engine's queue, runs and full-auto memory and the MR list, and says how in
**How these are worked out** at the foot of the page. Your merged MRs and the MRs that list you as
a reviewer come from two read-only GitLab GETs, asked at most every 15 minutes. The counts that
exist only as "now" (MRs waiting on your review, your open MRs) are kept once an hour in
`~/.local/state/underlings/stats-history.json`, so their change shows once a week of
readings exists.

## The intro

When the page first opens, a turning 3D graph with work pulsing along its edges waits while the
page loads, then falls in on itself, becomes the logo and flies into the rail's corner as the page
fades in. `ui/01-intro.js` decides when it plays and what it waits on; `ui/01-intro-paint.js` draws
it on one canvas with its own projection and nothing loaded, its choreography written at one pace
and handed real time over 1.8.

Each step the page waits on has a branch of about twenty nodes grown from its own seed: the engine
being up, GitLab's MR list having its first answer, Jira's tickets having been read and Needs you
having been built. When a step loads, its colour (the chart palette's `--viz-` tones) runs out
along its branch from the seed, its pulses run brighter and quicker, and a label beside it says so;
a failed step flickers red, dims and shows a cross, and is not waited on. Branches light no sooner
than 1.67 s in and at least 300 ms apart, so a page that loaded at once still shows each one, and
the cloud collapses 0.7 s after the last, the lit branches streaming in last and turning white.
A one-line checklist along the foot says the same. Jira is read only when asked, so the intro asks
through the Tickets view's own loader once the engine is up and asks again about once a second
until it is read; the worker's `attention.builtAt` and `buildError` say whether Needs you has been
built.

It never stays past 15 s: by 12.5 s the cloud collapses whatever is still loading. Any key, click or
tap skips it, and nothing behind it takes a click until it ends. With reduced motion the still logo
and checklist wait on the same steps, then fade in 250 ms. A reload within 10 minutes does not play
it again (`sessionStorage`), the app's terminal and Claude windows never play it, and **Settings**,
**Intro** turns it off in that browser. **Play it now** beside that switch, or **Play the intro** in
Jump to, plays it again at once whatever the switch and the reload rule say. When it ends, its
overlay, listeners, frame and timers are all gone.

On a first run, with no name saved, the logo holds where it formed and asks **What should we call
you?** in one field, prefilled with your first name from GitLab, or from `git config user.name`. The
clock stops while it asks, as it does for a hidden tab, so it waits past the 15 s; typing in it skips
nothing. **Enter** or **Save** keeps the name and the logo flies on; **Skip** or **Esc** leaves it
blank. With the intro off, or skipped before the logo formed, the same field is a card in the page's
corner that blocks nothing. It is asked once: Settings, **You** changes it after that.

## You

`~/.config/underlings/profile.json` holds your **Name**, a **Language** and your **Writing
rules**, all three under **You** in Settings. The Slack and email reads, the message agents, reply
drafts, ticket drafts and the Claude panel's tool descriptions call you by the name, or say "you"
while it is blank; they ask for the language when one is set, and carry the rules word for word.
The built-in review, kickoff and fix prompts take the language and rules too, for findings, commits,
replies and the merge request, but no name, as they speak for you already. A
rule against em dashes also has them taken out of the replies and tickets Claude writes. What a
review posts as you, the hold note and the two comment footers, are under **What reviews post as
you**, today's wording being the default.

A fresh install starts with Ask me, four agents at once, full auto off and no name, language or
rules.

## Time and region

`~/.config/underlings/locale.json` holds how times, dates and working hours are read, under
**Time and region** and **Working hours** in Settings.

- **Time zone** (`locale.timeZone`): every day boundary and time on the page and in the worker,
  the Standup's day, the calendar, the game's day and late night. Blank follows the Mac, and
  Settings says which zone that is now.
- **Region** (`locale.region`), such as `en-GB` or `en-US`: how dates and numbers are written.
  Blank writes them as the system does. **Clock** is 24 hour, 12 hour or as the region writes it.
- **Working hours** (`hours.from`, `hours.to` and `hours.workDays`), 08:00 to 18:00 Monday to
  Friday by default: email and Slack read only in them, the Standup looks back to your last
  working day, the calendar's week shows those days and opens on those hours, a day off never
  breaks the game's streak, and **Quiet on days off** holds banners on the rest.

A fresh install follows the machine and starts with re-review on change off.

## Features

**Features**, near the top of Settings, has a switch for Tickets, Standup, QA, the calendar,
Email, Slack, the game, the leaderboard and Artifacts, and each one's own group in Settings has
the same switch. One that is off leaves the rail, its view says it is off with a link back to the
switch, and nothing for it runs in the background: no Jira read for Tickets, no standup worked
out, no QA board read, no calendar read or meeting banner, no leaderboard build and no artifact
record read. Email, Slack and the game keep the switch they always had, in their own settings
files; the rest are in `~/.config/underlings/features.json`. A new install has QA off, Email
and Slack off as they always were, and the rest on.

## Filtering Settings

The box at the top of Settings keeps the groups and rows whose label, hint, choices or group
title hold every word typed, in any case and with or without accents, so `effort`, `slack sig`,
`time zone` and `haiku` each find their rows. A group title that matches keeps its whole group,
the words found are marked, and a filter that finds nothing says so with **Clear**. The filter is
kept for the tab, through a reload, but not into the next start.

## Models

**Models** in Settings gives each kind of task a model and, where Claude Code takes one, an
effort. **Effort for every task**, at the top, is Claude Code's default, low, medium, high, extra
high or max, and every row whose effort is **Same as every task**, the default, starts on it; the
row says what it gets, such as *High, from every task*. A row's own effort wins, and Claude Code's
default on a row passes no `--effort` for that task whatever every task is on. Builders take no
effort, as Claude Code has none for subagents. **Use suggested tiers** sets the models and has every
row follow the effort for every task; **Reset to Claude Code's default** puts the models, every
row and the effort for every task back on Claude Code's default.

Builders are the subagents an agent spawns, and their model reaches Claude Code as
`CLAUDE_CODE_SUBAGENT_MODEL`, which a subagent that names its own model ignores. **Force on every
builder**, off to start with, also sets `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, so every builder runs
on that model whatever it asked for. Claude Code reads the variable as a boolean, and `1` is one of
the values it takes. With Builders on Claude Code's default neither variable is set, and both
presets switch the force off. An agent, its resumes, Open in Terminal and the
panel's terminal each keep what they started with, and the Agents list and window say *forced*
beside the builders' model.

The Agents list and the agent window say, after each agent's model, the effort it started on
(*Default effort* where no flag was passed, and for a task on Same as every task the effort it took
from there), the task it ran under as Models names it, such as *Ticket agent*, and *builders on*
the builders' model when one was set.

## Ticket settings

The review engine's settings hold Jira and GitLab as well, under **Tickets** and **GitLab** in
Settings, where only the page edits them:

| Setting | A new install has | What it does |
| --- | --- | --- |
| `jira.projects` | blank, any project | the project keys Tickets lists, comma separated |
| `jira.defaultProject` | blank | where a fix agent raises its follow-ups, and whose keys count in a review thread beside the MR's own |
| `jira.statuses` | blank | the statuses a ticket can move to, offered before each other status your tickets are in |
| `jira.doneStatuses` | blank, Jira's Done category | the statuses that mean finished, the first being where the game counts finished work |
| `jira.issueType` | `Task` | the type of a ticket raised from a review thread, an email or a Slack message |
| `jira.ticketTemplate` | blank, free text | lines starting `#` are the headings a drafted ticket has, in bold in Jira; the rest is said to Claude as written |
| `tickets.noQaPaths` | blank | repo paths whose merged MRs suggest finished rather than QA |
| `gitlab.host` | `https://gitlab.com` | every GitLab REST and GraphQL call, the token link and the MR links on the page |

A key anywhere is `[A-Z][A-Z0-9]+-[1-9]\d*`, one pattern shared by the page, the worker and the
engine; in free text only a key whose project your MRs, tickets, agents or `jira.projects` use
becomes a link, so UTF-8 and SHA-256 stay text.

## Layout

`dashboard.html` is markup only. The worker adds every `ui/*.css` and `ui/*.js` file to it, one
tag per file in filename order, so a file that fails to parse takes only its own part of the
page down. `ui/00-core.js` calls into the other files only through `slot(name, ...)`.

Each piece of work owns its own files: `ui/NN-name.js` for the page, `lib/name.mjs` for the
worker, and their tests. A `lib` module exports `ACTIONS` (reached at `POST /api/matrix/<name>`)
and `ROUTES` (`'GET /api/...'` to a handler); `lib/actions.mjs` and `lib/app.mjs` merge them,
and a name defined twice stops the worker loading. A route named with a trailing `*`
(`'GET /preview/*'`) takes every path under its first segment, and a handler that returns a
`Response` is sent as it is rather than as JSON. An action that writes is
`{ verify, run }`: `verify` re-reads live state and calls `still(expected, actual, what)`, which
answers 409 if the page's view has moved on, and `run` writes only after it passes.

## Tests

`npm test` from this folder builds the engine and runs both suites, `npm run test:engine` (the
engine's own, under tsx) and `npm run test:cc` (these), each at most four files at a time, both in
London on an `en_US` system so no result depends on the machine; a test of another place says so.
Page tests show a snapshot in London time on the 24 hour clock unless they give their own. Running
these by hand needs their glob, `node --experimental-test-module-mocks --test "**/*.test.mjs"`,
since a bare `node --test` also picks up the engine's `.ts` tests. The `orca`, `git`, `npm` and `open` processes,
GitLab and the review engine are stubbed (`lib/testkit.mjs` is the stand-in engine, lock included); everything
between runs for real, the worker included, on a port of its own with a temporary home folder.
GitHub is faked the same way, by `engine/src/fixtures/github/fakegithub.mjs`: it answers REST and
GraphQL from a world, records every call, injects the failures GitHub makes (401, single sign-on,
limits, 429, 502) and refuses any other host. `gh` is never run for real: the engine tests point
`UNDERLINGS_GH_BIN` at a stand-in and the worker tests fake `child_process`. `npm run test:golden`
runs the GitLab baselines twice, the second with GitHub switched on against a GitHub with nothing
for you, and neither run may write them.
`lib/fullauto.test.mjs` runs whole workers in processes of their own (`lib/workerproc.mjs`) against
a real engine build and one state folder, with only Orca, `pgrep`, GitLab and `claude`
(`lib/fixtures/fake-claude.mjs`, given to every worker, so none can start a real session) faked. It loads
`UNDERLINGS_TEST_ENGINE`, or this checkout's `engine/dist/engine.js`, with the workers' beat and poll
shortened so the tests wait on what happens rather than the clock, and fails when that is not built
unless `UNDERLINGS_SKIP_REAL_ENGINE=1` says to skip it, as `lib/editmark.test.mjs` does.
`ui/ui.test.mjs` reads the page's source and fails on every way off the page it knows (a new
window, a write to `location` or an `href`, a link out, a form, a meta refresh), if the worker
runs the system `open` anywhere but its one checked place for links and the updater's reopening of the app it installed, if a top-level name is declared in two ui files, or if a slot is
defined other than once. `ui/page.test.mjs` runs the ui files over `ui/testkit.mjs`, a stand-in
document with just enough DOM to render the page, click it and follow keyboard focus.
`desktop/host.test.mjs` runs the worker under the app's host with Electron stubbed: its commands,
where a banner click goes, links, the menu bar badge and the port clash check. `desktop/terminal.test.mjs`
drives the pty session with a fake `spawn`, and the bridge and preload with fake frames, `lib/claudeterm-carry.test.mjs`
carries a panel chat over, and `lib/claudeterm.test.mjs` and `lib/claudeterm-cswap.test.mjs`
run the worker with the app's windows faked (`lib/fixtures/terminal-world.mjs`), a fake `claude` named by
`UNDERLINGS_CLAUDE_BIN` and a fake `cswap`, so none starts a real session. `lib/calendar.test.mjs` reads fixture `.ics` files through the real calendar reader with the fetch stubbed, so no test reaches Google; `lib/meetingoverlay.test.mjs` runs the full-screen reminder on fake timers with the app's windows faked, and `desktop/overlay.test.mjs` builds its windows against a fake Electron and a fake set of displays. `lib/email.test.mjs` and
`lib/slack.test.mjs` read through `lib/fixtures/fake-connector-claude.mjs`, which replays a
fixture's stream, so no test reaches Gmail or Slack. It runs a run's `PreToolUse` hooks as Claude
Code does and records what each tool was finally given, so `lib/slackreply.test.mjs` proves a send
posts only what was approved whatever the model passed; `lib/slacksend.test.mjs` runs the send's
hook on its own. `desktop/bundle.test.mjs`
checks that the app packs the engine build where its worker looks for one, with the release notes
and build stamp beside it, that nothing the build loads comes from `node_modules`, and that the
terminal's files, xterm.js and node-pty's own Electron build are packed.
`lib/selfupdate.test.mjs` runs real git against a scratch bare repo as `origin`, served over a
fake `ssh` or rewritten from its https URL, with a fake `npm` first on the `PATH`, so a check never
reaches the network and an update never builds or installs anything real; `lib/apphelper.test.mjs` swaps folders in a
temporary one and reopens nothing.

`lib/gitlab-golden.test.mjs` pins what the app does against GitLab, so moving it onto a provider
layer can be shown to change nothing. One scripted session drives the worker's own routes against a
recording GitLab (`lib/fixtures/gitlab-golden/`), with Jira, `git` and `claude` faked, the clock
fixed and ids counted, and compares three baselines kept beside it: every GitLab request, step by
step (`requests.json`), the state files the session leaves (`state.json`, settings left out) and the visible text of the GitLab views (`page.json`, Settings and Setup left
out). Any difference fails with a diff of the baseline. `npm run test:golden` runs it alone; to change
a baseline on purpose, run `UNDERLINGS_GOLDEN=update npm run test:golden` and read the diff before
committing it.
