---
description: "Sweep your Jira tickets with current progress: add a comment to each and move its status where it has changed."
argument-hint: "[ticket keys]"
disable-model-invocation: true
---

Help update Jira tickets with current progress.

Arguments: $ARGUMENTS (optional ticket keys).

1. Work out which tickets need updating: the keys given, else the user's open tickets. The `list_tickets` tool of the `underlings` MCP server returns them with the statuses each can move to when it is connected. Otherwise search with `acli jira workitem search --jql 'assignee = currentUser() AND statusCategory != Done' --json`. Ask the user to confirm the list.
2. For each ticket:
   - Fetch its current details: `acli jira workitem view <KEY> --fields '*all' --json`.
   - Ask what progress has been made, or infer it from recent git activity, merge requests and the conversation.
   - Add a comment summarising the progress: `acli jira workitem comment create --key <KEY> --body-file <file>`.
   - If its status needs to change (To Do to In Progress, In Progress to Done), confirm with the user, then `acli jira workitem transition --key <KEY> --status "<status>" --yes`.
3. Give a summary of every update made.

Write in the language and by the writing rules the user has set in Underlings' Settings (Language, Writing rules).
