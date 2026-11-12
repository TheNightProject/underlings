---
name: kickoff
description: "Take a ticket from kickoff to Draft merge requests: plan, build in waves of builders, review with cold reviewers, verify, and ship, with two gates that need the user. Use when asked to start or kick off a ticket."
argument-hint: "<ticket key> [tier=low]"
disable-model-invocation: true
---

Take a ticket from kickoff to Draft merge requests: plan, build in waves, verify, ship. Every piece of work runs in its own agent with a fresh context, so this session stays the coordinator and holds only summaries.

Arguments: $ARGUMENTS

The ticket key comes first, then optionally `tier=low` (the default is `tier=high`). Anything else after it is context from Underlings, such as the checkouts it found and the user's writing language and rules. Pass the writing language and rules to every brief you write.

## How it runs

- This session coordinates. It plans, dispatches, waits and decides. It does not edit code itself.
- Use the Agent tool for every unit of work: one agent per unit, independent ones sent in a single message. Every brief stands alone: the ticket, the step, the repository and branch, and the rules below. A worker never sees another worker's reasoning, only artefacts: diffs, files, test output.
- Pass effort on every Agent call: `medium` for builders, cold reviewers, the claim prover and the refuter; `low` for hunters. Never name a model, so the Builders setting in Underlings' Settings, Models, chooses it.
- Two gates need the user: the plan, and shipping. Everything between them runs without asking.
- If your instructions say to ask before pushing, raising a merge request or touching the ticket tracker, that holds for every step below, including the first status change.

## 1. Intake

1. Read the ticket with its comments and links. Through `acli`: `acli jira workitem view <KEY> --fields '*all' --json`. Use an Atlassian MCP server instead if one is connected.
2. Find the repositories it touches among the checkouts you were given (otherwise the folders with a `.git` under the workspace root, Underlings' Settings, Workspace), any open merge requests or branches that already name the ticket (the forge's API with the token in your environment, `$GITLAB_TOKEN` for GitLab), and any design records or docs the ticket names.
3. Move the ticket to the status your workflow uses for work started, usually In Progress: `acli jira workitem transition --key <KEY> --status "<status>" --yes`.

## 2. Plan

1. Write the plan as steps N1 to Nk. Each names its repository, the behaviour that changes, the files it likely touches, the test that proves it (and fails without it), and what it depends on.
2. Group the steps into waves. A wave holds steps that do not depend on each other. A step in the same repository as an earlier one stacks on that branch.
3. High tier only: dispatch two cold reviewers in parallel, given the ticket and the plan and nothing else.
   - **Premise:** is this the right problem, read against the code as it is today? What already exists?
   - **Approach:** is there a simpler shape, a path the plan misses, a blast radius it does not name?

   Fold in what holds up. Say what you rejected, and why.
4. **Gate 1.** Show the steps, waves, repositories, merge request order and anything you cannot verify, then ask with AskUserQuestion: approve, change or stop. Nothing is built before approval. Record the approved plan as a ticket comment.

## 3. Build, in waves

For each wave in turn, dispatch one builder per step, in parallel. Each builder:

- creates its own git worktree from `origin/<default branch>`, or from the branch it stacks on, on `feat/<KEY>-<slug>` or `fix/<KEY>-<slug>`;
- writes the test first and shows it fails, then makes the change, then runs the repository's own hooks and default test lane;
- commits with the repository's commit conventions and the ticket key, and does not push.

When a builder reports done, dispatch a cold reviewer with only the step's goal and its `git diff`, never the builder's account. It loads the `underlings:review` skill with the Skill tool, applies that checklist to the diff, reports its findings to you in chat and queues nothing. The builder fixes what is confirmed. A step is done when its reviewer confirms nothing. Start the next wave only when every step in this one is done.

## 4. Verify

1. **Claim prover.** A fresh agent gets only the ticket's acceptance criteria and the built branches, and uses the change the way its user would: calls the endpoint, builds a small app from the new guide, runs the command. It marks each criterion proved, not proved or could not check, with evidence.
2. **Verify-self rounds,** at most three:
   - **Hunters:** four agents over the whole diff across every branch, one lens each: correctness and edge cases; access and security; tests that bite (revert each fix, its test must fail); simplicity and method size.
   - **Refuter:** one agent checks each finding against the code and marks it confirmed, partial or refuted.
   - Builders fix confirmed and partial findings. The next round re-checks those fixes and looks for regressions.
   - Stop when a round confirms nothing. If findings are still confirmed after three rounds, stop and bring them to the user.

## 5. Ship

1. Run `underlings:pre-mr-review` on each branch, one worker per branch.
2. **Gate 2.** Show the branches, merge request order, gate and test results, what the claim prover could not check, and anything left open. Ask: ship as Draft, or hold.
3. Push each branch with the credentials the user's git already has for that host, or, where it has none, the token inline in the URL of that one command and never saved in git config. Raise Draft merge requests in dependency order. Each description says what it stacks on and what could not be verified.
4. Move the ticket to the status your workflow uses for review, with a comment listing the merge requests, and offer `/underlings:mr-message` to write the post asking for reviews.

## Report

Whenever the user asks, and at the end: the plan, each wave's steps and their status, each verify round's counts (hunters, findings, confirmed, partial, refuted, fixed, regressed), and the merge requests.

## Rules for every brief

- The repository's own contribution and agent guidance (its CLAUDE.md or contributing guide) applies, and so do the writing language and rules you were given: for commit messages, code comments and the merge request.
- Never `git stash` and never switch branches in a shared checkout: one worktree per branch.
- Never store a token in git config, a file or a command you print.
- Nothing is pushed before `underlings:pre-mr-review`, and every merge request is a Draft.
- No new tickets beyond those the approved plan names. Ask the coordinator.
