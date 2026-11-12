---
name: standup
description: "Write standup notes for yesterday and today from the progress log, finished tickets, merge request reviews, open work and the calendar."
argument-hint: "[day, such as yesterday, friday or 2026-03-01]"
disable-model-invocation: true
---

Generate standup notes.

Arguments: $ARGUMENTS (a day to look up, such as `yesterday`, `friday` or `2026-03-01`; blank means yesterday, or the last working day).

Work in the user's time zone, which is Underlings' Settings, Time and region, or the machine's if none is set. If the `underlings` MCP server's `standup` tool is connected, start from what it returns for the day, then fill the gaps below.

## 1. Yesterday: what was done

1. **Pick the day or days** from the arguments.
2. **Read the progress log** for that day from `.underlings/progress/YYYY-MM/YYYY-MM-DD.md` in the folder you run Claude Code from (the one `/underlings:log-progress` writes). If there is none, fall back to git history for that day.
3. **Check the tickets the user finished** that day and relate them too. Through `acli`: `acli jira workitem search --jql 'assignee = currentUser() AND status CHANGED TO ("<finished statuses>") DURING ("<day> 00:00", "<day> 23:59")' --json`. The finished statuses are Underlings' Settings, Jira, Finished statuses (blank means Done). If a finished ticket is not in the progress log, surface it and flag it rather than inventing detail for it.
4. **Count the reviews the user did on other people's merge requests.** Reviewing is a real part of the day and leaves no trace in their own git history, so it is invisible unless asked for.
   - GitLab: the events API on the host in Underlings' Settings, GitLab host (gitlab.com if blank), with `$GITLAB_TOKEN`: `GET /api/v4/events?after=<day-1>&before=<day+1>&per_page=100`. `after` and `before` are exclusive, so bracket the day either side.
   - Group `action_name: "commented on"` events whose `note.noteable_type` is `MergeRequest` by `project_id` and `note.noteable_iid`, counting comments per merge request. Collect `action_name: "approved"` events with `target_type: "MergeRequest"` separately: an approval is a different act from a comment. Union the two sets, so an approval with no comments still counts.
   - GitHub: `gh search prs --reviewed-by @me --updated <day>` and read each one's reviews, if `gh` is signed in.
   - Resolve each project to a repository name and fetch each merge request's title and state, so its line says what it was about.

   These stay inside the Yesterday block as a contiguous run at the end, after the meeting lines, each reviewed merge request on its own line. Group the lines by ticket: ticketed ones first, ones with no ticket as a block at the end. Sort the ticket groups by total comments, busiest first, and the lines within a group the same way. Shape: repository, `!iid`, comment count, `approved` where it applies, then a short description. Tag each `[Review - <KEY>]` using the merge request's own ticket from its title or branch, and `[Review - NoTicket]` where it has none.

## 2. Today: gather context, then ask

5. **Pull the user's current open work** to seed the Today section, so you do not ask cold:
   - In-progress tickets assigned to them: `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, limited to Underlings' Settings, Jira, Your projects when that is set.
   - Open merge requests they authored, across all repositories: GitLab `GET /api/v4/merge_requests?scope=created_by_me&state=opened&per_page=20`, or GitHub `gh search prs --author @me --state open`. For each note the repository, number, title, draft flag and the ticket key from its title or branch, and where useful its review and approval state, so the bullet can say the real next action: awaiting review, changes requested or ready to merge.
6. **Ask what the user is doing today** with the AskUserQuestion tool (multi-select), seeding the options from step 5: one per open merge request ("Chase review on `!<iid>` (<KEY>)"), one per active ticket ("Continue <KEY>"), and always room for free text through "Other".
7. **Build the Today bullets** from the answers and the context. For a merge request, phrase the actual next action tied to its ticket: "chasing review on", "working through merge of", "addressing review feedback on", "ready to merge". Not a generic "work on".

## 3. Meetings: ask

8. **Ask about meetings**, seeding from the user's calendar.
   - A calendar tool is usually deferred and not callable until loaded. Load it first: search for it with ToolSearch (for example `select:mcp__claude_ai_Google_Calendar__list_events`, or a keyword search for "calendar list events"). Skipping this is why a run silently fails to read the calendar.
   - List yesterday's and today's events on the primary calendar, bounded by day, in the user's time zone, ordered by start time. Drop personal or noise events. If no calendar is connected, or the call genuinely fails after trying, say so ("couldn't reach the calendar") and then ask. Do not pretend there is none.
   - Ask two things with AskUserQuestion (multi-select, with free text): which meetings they had yesterday and the key decision or outcome of each, and which they have today.
9. **Turn the meetings into `[Meeting: <short name>]` bullets**: yesterday's as decisions or outcomes, today's as scheduled. Drop any with nothing standup-worthy.

## 4. Format the notes

Use the user's own format if they gave one. Otherwise:

```
Hello
Yesterday:
- [ABC-1234] <what was done, one short line>
- [Meeting: <short name>] <decision or outcome, one short line>
- [Review - ABC-1234] <repo> !<iid>, <n> comments: <what it was about>
- [Review - NoTicket] <repo> !<iid>, <n> comments, approved: <what it was about>
Today:
- [ABC-1234] <the plan, one short line>
- [Meeting: <short name>] <meeting scheduled today>
```

On a day with no reviews, the review run is simply absent.

**Be brief.** One short line per bullet, aiming for 12 words or fewer. No parentheticals, no sub-clauses, no methodology or rationale: just what was done or planned. Group related work into a single bullet.

**Attribution is required.** Tag every bullet at the start of the line with a ticket (`[ABC-1234]`), a meeting (`[Meeting: <short name>]`) or, for reviews, `[Review - <KEY>]` or `[Review - NoTicket]`. Take the ticket from the progress log's Tickets section, the commit-message prefixes or the merge request's title. If a bullet maps to no ticket or meeting, tag it `[?]` and ask the user which it belongs to before finalising.

Write in the language and by the writing rules the user has set in Underlings' Settings (Language, Writing rules).
