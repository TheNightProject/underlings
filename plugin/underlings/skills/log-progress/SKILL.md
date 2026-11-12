---
name: log-progress
description: "Log the day's progress autonomously and idempotently from commits, merge requests, tickets and the conversation, into a daily file. Safe to run on a loop; never asks a question."
argument-hint: "[a note to add, such as 'met the platform team about auth']"
disable-model-invocation: true
---

Log progress for the day, autonomously and idempotently. It is designed to be run repeatedly (for example `/loop /underlings:log-progress`) without ever stopping to ask a question. Entries are stored under `.underlings/progress/` in the folder you run Claude Code from, which for Underlings' agents is the workspace root.

Arguments: $ARGUMENTS (optional, a manual note).

- If an argument was given, append it under **Notes** as `HH:MM - <note>` and stop. Do not run the gather.
- If it is empty, run the full autonomous gather below.

## Hard rules

- **Never prompt the user.** This completes end to end with no questions, no AskUserQuestion, no "anything else to add?". The notes the user would otherwise be asked for come from the current conversation: read it instead of asking.
- **Merge, never duplicate.** Always read today's file first and add only what is not already there. This runs in a loop, so a run with nothing new is valid and common: say so and exit.
- **Best effort, never block.** If a source fails (a token, the network, a tool that is not connected), record what you could and move on. Do not stop the run over one dead source.
- **Terse output.** Print only the delta this run added. Do not dump the whole file on every iteration.

## Steps

1. **Set up.** `TODAY=$(date +%F)`, `NOW=$(date +%H:%M)`. The target file is `.underlings/progress/$(date +%Y-%m)/$TODAY.md`. Create the monthly folder if it is missing. Read the target file first if it exists: it is the baseline for dedup.

2. **Commits across every checkout** under the current folder, by the user, on all branches, since midnight:

   ```bash
   me=$(git config --global user.email)
   for d in ./*/; do
     [ -e "${d}.git" ] || continue
     git -C "$d" log --all --since="$(date +%F) 00:00" --author="$me" \
       --pretty=format:"%h %s" 2>/dev/null | sed "s#^#$(basename "$d"): #"
   done
   ```

   Dedup by short SHA against the existing **Commits** section.

3. **Merge requests and pull requests the user opened today.** Use the forge's REST API with the token in your environment, because a CLI may not be signed in. For GitLab, on the host in Underlings' Settings, GitLab host (`https://gitlab.com` if blank), shown here as `$GITLAB_HOST`:

   ```bash
   curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
     "$GITLAB_HOST/api/v4/merge_requests?scope=created_by_me&updated_after=${TODAY}T00:00:00Z&per_page=50" \
     | jq -r '.[] | "\(.references.full) - \(.title) [\(.state)]"'
   ```

   For GitHub, `gh search prs --author @me --updated ">=$TODAY"` if `gh` is signed in. For each, capture the number, repository, title, **state** (`opened` is in flight, `merged` landed today, `closed`) and the ticket key from its title. Dedup by number. If an already-logged one changed state, update its line (opened to merged, say). This is the canonical record of merge requests: a standup reads it back rather than asking again.

4. **Ticket changes.** Through `acli`, or an Atlassian MCP server if one is connected:

   ```bash
   acli jira workitem search --json --jql 'updated >= startOfDay() AND (assignee = currentUser() OR reporter = currentUser()) ORDER BY updated DESC'
   ```

   Add `project in (...)` from Underlings' Settings, Jira, Your projects when that is set. For each: `KEY - summary - status`, marking a transition if the status changed today (for example `-> In Review`). Also fold in any ticket key referenced in today's commits or merge requests even if it is not assigned to the user. Dedup by key and update the line if the status moved since it was logged. If no tracker is available this run, skip silently.

5. **Information from context.** Scan the current conversation for work that will not appear in git, the forge or the tracker: design decisions, debugging outcomes, reviews given, meetings, blockers, things figured out. Log each as `HH:MM - <concise note>` under **Notes**, only where it is not already captured (judge by meaning, not by exact string). Keep `[Meeting: ...]` and `[PTO]` markers where relevant.

6. **Merge into the canonical structure.** Keep these headings and add only new items, keeping lines stable and grouped:

   ```
   # YYYY-MM-DD
   > optional one-line day banner (only if clearly true, such as PTO or a half day)
   ## Commits        - `sha - repo - subject` (or "None authored by me." if empty all day)
   ## Merge Requests - `!iid - repo - title - state (KEY)` (omit the section if none)
   ## Tickets        - `KEY - summary - status` (note transitions)
   ## Notes          - `HH:MM - <note>`
   ## Summary        - regenerate every run: a brief natural-language summary of the day so far
   ```

   Write the merged file, merging into existing sections. Do not overwrite prior content.

7. **Report the delta only.** One terse line of what changed, such as `logged 14:32 - +2 commits, +1 MR (api!108 -> merged), ABC-1352 -> In Review, +1 note`, or `logged 14:32 - nothing new since 14:17`.
