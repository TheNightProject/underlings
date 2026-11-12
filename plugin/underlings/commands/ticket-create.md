---
description: "Create a Jira ticket from a template: problem, change and acceptance criteria, or your own template from Underlings' settings."
argument-hint: "[a brief title or description to pre-fill]"
disable-model-invocation: true
---

Create a new Jira ticket.

Arguments: $ARGUMENTS (optional, a brief title or description to pre-fill).

## Steps

1. If an argument was given, use it as the initial summary. Otherwise ask the user for a one-line summary.
2. Work out where it goes, from Underlings' Settings, Jira:
   - **Project:** Default project. If it is blank, use the project of the ticket under discussion, or ask.
   - **Issue type:** New ticket type (Task if blank). Ask only if the user's wording suggests a bug or a story.
3. Ask the user for what the template needs, or infer it from the conversation when it is obvious. For acceptance criteria, prompt for at least two or three.
4. Build the description from the template:
   - If Underlings' Settings, Jira, Ticket template is set, use its headings, in that order. Lines in it that start with `#` are the headings; the other lines are guidance for what to write under them.
   - Otherwise use this one:

     ```
     Problem
     What is wrong or missing, and for whom.

     Change
     What will be different once this is done.

     Acceptance criteria
     - A requirement that can be checked.
     - Another.

     Notes
     Constraints, dependencies, testing notes. Write "none" if there are none.
     ```

   Write each section name as a line of its own, then its text, with list items starting `- `. `acli` sends plain text as typed. Through an Atlassian MCP server, Markdown headings are fine.
5. Show the user the full ticket (project, type, summary, description) and ask for confirmation before creating anything.
6. Create it. With `acli`, put the description in a file and run `acli jira workitem create --project <KEY> --type <type> --summary "<summary>" --description-file <file> --json`. With an Atlassian MCP server, use its create-issue tool.
7. Return the created key and its link, `https://<your Jira site>/browse/<KEY>`, taking the site from Underlings' Settings, Jira site.

Write the ticket in the language and by the writing rules the user has set in Underlings' Settings (Language, Writing rules).
