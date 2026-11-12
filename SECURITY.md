# Security

## Reporting a vulnerability

Please report it privately, not in a public issue. On GitHub, open the repository's
**Security** tab and choose **Report a vulnerability**. That opens a private advisory only the
maintainers can see.

Say what you found, the version (the footer of the rail, or `build.json`), and the steps to
reproduce it. A fix goes out as a new release, and you are credited in it unless you would
rather not be. There is no bug bounty.

## What Underlings is, for this purpose

Underlings is an app that runs on your Mac, for you alone. It reads your merge requests, tickets
and calendar with tokens you give it, and runs Claude Code agents on your machine. It has no
server of its own and no account system, and it sends nothing to its authors.

## Threat model

**In scope**

- Another site, another local user or another process on the machine reading the page's data
  or acting through it.
- A merge request, ticket, email, Slack message or calendar entry (all untrusted text) making
  an agent or the page do something you did not ask: running a command, posting or merging on
  your behalf, leaking a token.
- A token reaching a place it should not: a log, an agent's environment, a link, a file other
  users can read.
- A way out of the sandbox the artifact preview or the app's windows run in.

**Out of scope**

- Anyone who already controls your account on the machine. They can read the tokens and the
  state folders directly.
- What Claude Code itself does with the permissions you choose for it. Underlings passes your
  choice on; it does not widen it. The default is to ask.
- A GitLab, GitHub or Jira token you gave far more scope than the documented scopes.
- Prompt injection that stays inside what an agent may already do at the permission level you
  set.

## How it is built

- **The server** listens on `127.0.0.1` only and checks the `Host` header. Every request needs
  the token from the page link. A read may carry it in the query. A write is a `POST` with the
  token in an `x-cc-token` header and an `Origin` of the page itself, so another site, or a
  page framing this one, can neither read it nor act through it.
- **Nothing on the page leaves it.** The only way out is a button that says so, which opens the
  link in your default browser. Only `http` and `https` links open. Text from GitLab, GitHub,
  Jira, agents and terminals is shown as text, never parsed as markup.
- **Artifact previews** are served with `Content-Security-Policy: sandbox allow-scripts` and
  framed with `sandbox="allow-scripts"`, so each runs in an origin of its own and cannot reach
  the page, open a window or navigate the tab. A preview token opens that artifact's copy and
  nothing else, and the page token is refused there.
- **The app's windows** run sandboxed with no Node in the page. Preloads give a window only its
  own buttons, and the main process takes those messages only from the frame that should send
  them.
- **Tokens** are kept in files readable only by you under `~/.config/underlings/`, or read from
  your shell profile, and are scrubbed from anything said about a failure. The Slack, email and
  ticket-drafting reads run with no forge token in their environment, and a GitHub token is never
  given to any agent. A review, fix or kickoff agent does get `GITLAB_TOKEN`, as it reads and
  raises merge requests through the GitLab API, so what it may run with it is down to the Claude
  Code permission mode you set. The calendar address, which is a secret, is held in memory only.
- **Agents** run as Claude Code with the permission mode you set. A review agent is told never to
  write to a merge request and queues its findings through a tool that can only queue them, so
  nothing reaches the forge from Underlings until you have read it, unless you turn on full auto
  and name the people it may act for. Full auto has its own limits (paths it never touches, a
  size cap, a kill switch).
- **Hooks** Claude Code calls back into Underlings carry a token of their own, which opens
  nothing else and is refused from a page.

The README's Privacy section lists what leaves the machine.

## Supported versions

Only the latest release is supported. Underlings is built from source, so updating is a
`git pull` and the install command again.
