---
name: pre-mr-review
description: "Check a branch before it is pushed or a merge request or pull request is raised. Runs the repository's own checks, re-reads the diff as a stranger, and proves the new tests fail without the change."
argument-hint: "[target branch]"
---

Pre-flight the current branch before it is pushed and before its merge request or pull request is opened. Run this before, not after CI has gone red.

Target branch: $ARGUMENTS (blank means the repository's default branch on origin).

Work through every gate. Fix what you find, then run it again. Do not raise anything until every gate passes.

## 1. Know the diff

Run `git diff origin/<target>...HEAD` and read all of it. Everything below is scoped to these lines, not the whole repository.

## 2. Run what CI runs, locally

Find the repository's own configuration and use its exact arguments, never your own defaults.

- A `.pre-commit-config.yaml`: `pre-commit run --from-ref origin/<target> --to-ref HEAD`. It is the highest-value single command, catching formatters, linters and repository-specific hooks in one pass.
- No pre-commit: read the CI configuration (`.gitlab-ci.yml`, `.github/workflows/`) and run each check job's commands by hand.
- Where a hook or job names plugins or extra dependencies for a linter, run it with them. A missing plugin means rules silently do not fire.
- Run the package's own lint, type check, formatter check and test commands, and the test lane the repository defaults to, not only your new file.
- If the repository has a check on comments, prose or commit messages, run it on the diff.

## 3. Comments and wording

Go through every comment the diff adds and remove the ones that do not earn their place.

- Remove a comment that narrates the code, restates a signature, banners a section, sits on an obvious line, or is commented-out code (version control has it).
- Keep one that carries what the code cannot: why this way and not the obvious one, a constraint from outside the file, a non-obvious consequence of getting it wrong. If a comment exists to explain what the code does, rename something and drop the comment.
- Follow the repository's own conventions for comments, commit messages and descriptions, and the writing language and rules your request gave you from the user's profile in Underlings' Settings.

## 4. Lint baseline

If a check fails, see whether it already fails on the target branch before assuming it is yours. Compare in a separate `git worktree`, never with `git stash` or by switching branches in a shared checkout. Report the change in the count, not the total.

## 5. Read the diff as a stranger

The point is to find what you would flag in someone else's merge request.

**Method size, first.** Check every method the diff adds or grows.

- A method you cannot describe without "and" does more than one thing. Split on the "and".
- Three levels of indent means the innermost one wants a name. Long and flat is fine; long and nested is not.
- A comment marking a section is a method boundary someone declined to draw. Extract the section, name it after the comment, delete the comment.
- A flag set early and read fifty lines later means the middle is its own unit.
- Past roughly 50 lines or 5 branches, justify it in the description or split it.

Do not extract to hit a number. A single-use helper with six parameters, named after its mechanics, is worse than the block it replaced. If a method you only touched was already too big, say so and leave it.

**Then the rest.**

- **A simpler shape.** Nested loops that are an ordered sequence, a chain of ifs that is a lookup, a helper that duplicates one elsewhere.
- **Every path your change created.** If you added precedence between sources, a fallback or a new field name, list the combinations and check each one behaves. This is where the real bugs are.
- **Silent no-ops.** A field read in one shape but not another. A value that passes a check and is then stripped before it reaches its consumer.
- **Blast radius.** Does a new name collide with an existing one? Search the repository. Say so plainly when the real answer lives in a database or another service you cannot check.

## 6. Prove the tests bite

For each behaviour you changed, revert the source change, run the new tests, confirm they fail, and restore. A test that passes against the old code tests nothing. Ordering and precedence tests are the worst offenders: they pass against any ordering unless you check. The tests must cover the paths from step 5, not only the happy one.

## 7. Report

Report in chat:

- the gates you ran and their results;
- what you found and fixed in step 5;
- what you could not verify, and who can;
- anything pre-existing and broken that you deliberately left alone.

Then, only if you were asked to raise the merge request or pull request, raise it as a Draft and put the unverifiable items in its description so the reviewer sees them without asking.
