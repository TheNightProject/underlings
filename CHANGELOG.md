# Changelog

What changed in each version of Underlings, newest first. Each line is a merged change: `npm run release` drafts the next section from the ones merged since the last release.

## 1.2.0 (2026-11-11)

### New

- Gamify Underlings: XP, coins, levels, quests, and a shop and wardrobe in the office
- Open the tickets and MRs Claude Code names in its terminal, at their agent when they have one
- Show the agents as a little 3D office, with a card that answers and acts on them
- Action a Slack message or email thread with an agent that proposes your reply
- Make the Claude panel the real Claude Code in the app, carrying on the panel's chat

### Fixed

- Keep an agent working while its builders run in the background, and say what they are doing
- Keep the office's name tags inside the scene and its card inside its column

### Look and feel

- Underline the tickets and MRs in Claude Code's terminal in amber, without waiting for a hover

## 1.1.0 (2026-11-10)

### New

- Read the conversation around a Slack message, and reply to it from there
- Keep the graph turning while the page loads, and light a branch of it for each step
- Open published artifacts in a window of the app's own, signed in to claude.ai once
- Sign Slack messages sent from Underlings' own Claude sessions
- Open the page with a 3D graph that gathers into the logo and flies into the rail
- Show the Slack messages that need you, read through Claude Code's own connector
- Pick the cswap account Claude Code runs as from Settings
- Run the real Claude Code in a window of the app, with Underlings' tools, ask rules and banners
- Show the email that needs you, read from Gmail through Claude Code's own connector

### Fixed

- Let Google's sign-in hop through its own account hosts in the artifact window
- Read a DM or channel conversation in Slack's own shape, with sender and time in the heading
- Read Jira in turns, so your tickets load while the QA board builds
- Do not report an update as failed once a later build has replaced it
- Reopen the app on its own once an update has installed

### Changed

- Slow the intro down, hold the logo until the page has loaded, and replay it on request

## 1.0.0 (2026-11-10)

### New

- Show what changed in each version, and update Underlings from the page
- A Claude panel: one long-lived session that can read and act on Underlings
- Show QA at a glance on the Overview, with the repos where tickets pile up
- Add a QA view that shows where tickets are piling up in testing
- Work out what is waiting in QA, for how long, and which merged MRs it came from
- Drive the page from the keyboard, with a palette and a shortcuts sheet, and give the app hotkeys
- Add a Standup view that works out the day and copies it for Slack
- Work out a day's standup from GitLab, Jira and a calendar
- Send a test banner from Settings, so the app's first one makes macOS list it
- A headless engine for Underlings, with full auto shared through one lock
- Run review agents as Claude Code in the background, behind an agent host Orca also implements
- Start a ticket with the kickoff agent, and read your open tickets with their descriptions and moves
- Banners come from the app while it runs, and MR descriptions read as Markdown
- Show a Claude Code review agent's conversation in the Agent tab, and answer it there
- Add a board to Tickets, and suggest each ticket's status from its MRs
- Run Underlings as a macOS app of its own
- Tickets view and drawer: move a ticket and start it with an agent in place
- Add a Board layout to Merge requests
- Show review text as formatted markdown, built only from elements and text nodes

### Fixed

- Find acli and glab when the app is opened from Finder, and give the app an icon
- Keep a markdown link whole when its URL has a route group's parentheses
- Filter merge requests by author, not by everyone involved

### Changed

- Move the review engine into this repo, and ship it inside the app
- Run agents in Claude Code's auto mode, so only a risky action asks
- Run every agent as Claude Code, and keep daily re-reviews in the state folder
- Show Claude Code agents, not Orca's, and let nothing about agents ask Orca

### Look and feel

- Put the dark merge-ring icon back on the app, and use it as the page's logo
- Give the app the page's radar logo, and sign it ad hoc so macOS lists it under Notifications
