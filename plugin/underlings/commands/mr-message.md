---
description: "Write the chat post asking the team to review one or more merge requests or pull requests."
argument-hint: "<MR or PR links, plus any notes on order or dependencies>"
---

Generate the chat post asking the team to review one or more merge requests or pull requests.

Arguments: $ARGUMENTS (one or more links, or `repo !iid` references, plus any notes on order or dependencies).

1. For each one, fetch it: its title, description, branch, draft flag, pipeline status and commits.
   - GitLab: the REST API on the host in the link, with `$GITLAB_TOKEN`: `GET /projects/:id/merge_requests/:iid` and `.../commits`.
   - GitHub: `gh pr view <link> --json title,body,isDraft,statusCheckRollup,commits` if `gh` is signed in.
2. Take the ticket key (such as ABC-123) from the title, else the branch or the commits.
3. Write one line per merge request. If the user gave a format or an example, follow it. Otherwise use:

```
:eyes: <KEY> - <link> - <what it does, in a short phrase>.
```

Example:

```
:eyes: ABC-410 - https://gitlab.example/acme/auth/-/merge_requests/81 - admins can publish packages. Merge this first, the two ABC-388 requests depend on it.
:eyes: ABC-388 - https://gitlab.example/acme/engine/-/merge_requests/1088 - package tools that write check the new permission before calling the graph service.
```

Rules:

- One line per merge request, in merge order when one depends on another. Two requests on one ticket each get their own line.
- The description says what changes for someone using it, in one short phrase, lower case after the dash. No commit lists, no test counts.
- Add a second short sentence only for something a reviewer must know: merge order, a dependency, a failing pipeline that is not this request's fault, or "the review bot approved it, but no human has looked".
- Use the full link. Use plain hyphens as separators. No bold, no headings.
- Do not include @mentions: the user adds those.
- Warn the user, outside the copyable block, about any request that is still a draft or has a failing pipeline.
- Output the lines in a single code block the user can copy, and nothing else beyond any warning.
- Write in the language and by the writing rules the user has set in Underlings' Settings (Language, Writing rules).
