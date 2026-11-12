---
description: "Update a Jira ticket: edit its description or summary, add a comment, move its status or reassign it."
argument-hint: "[ticket key, or a description of what to update]"
disable-model-invocation: true
---

Update an existing Jira ticket.

Arguments: $ARGUMENTS (optional: a ticket key such as ABC-123, or a description of what to update).

## Steps

1. If a key was given, fetch that ticket. Otherwise ask the user which ticket to update.
2. Fetch the current ticket: `acli jira workitem view <KEY> --fields '*all' --json`, or an Atlassian MCP server's get-issue tool.
3. Show the user its current summary, status and description, and ask what they want to change:
   - **Add a comment:** draft a comment summarising progress or a decision, confirm it, then `acli jira workitem comment create --key <KEY> --body-file <file>`.
   - **Update the description:** open the existing description in the template's structure, apply the changes, confirm, then `acli jira workitem edit --key <KEY> --description-file <file> --yes`.
   - **Move its status:** find the statuses it can move to (the transitions in the ticket you fetched, an Atlassian MCP server's transitions call, or Underlings' Settings, Jira, Statuses). Ask the user to confirm one, then `acli jira workitem transition --key <KEY> --status "<status>" --yes`.
   - **Update the summary:** confirm the new wording, then `acli jira workitem edit --key <KEY> --summary "<summary>" --yes`.
   - **Reassign:** confirm who (an email, an account id or `@me`), then `acli jira workitem assign --key <KEY> --assignee "<who>" --yes`.
   - **Several:** handle each in turn.
4. When you change a description, keep its structure: the headings of Underlings' Settings, Jira, Ticket template if one is set, otherwise Problem, Change, Acceptance criteria and Notes. Write each section name as a line of its own, then its text, with list items starting `- `.
5. Confirm each change with the user before applying it.
6. Summarise every change made at the end.

Write in the language and by the writing rules the user has set in Underlings' Settings (Language, Writing rules).
