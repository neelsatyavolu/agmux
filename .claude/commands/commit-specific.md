# commit-specific

Create individual commits for each changed file with targeted commit messages, then push.

## Steps

1. Run `git status` to see all modified, added, and untracked files (never use `-uall` flag).
2. Run `git diff` and `git diff --cached` to understand changes in each file.
3. Run `git log --oneline -5` to match the repo's commit message style.
4. For EACH changed file (modified, added, or untracked):
   a. Read the diff for that specific file (`git diff -- <file>` or `git diff --cached -- <file>`).
   b. Write a concise commit message describing what changed in THAT file specifically. Use conventional commit format (`feat:`, `fix:`, `refactor:`, `style:`, `docs:`, `chore:`, `test:`, `perf:`).
   c. Stage ONLY that file: `git add <file>`
   d. Commit with the file-specific message using a HEREDOC.
   e. Move to the next file.
5. After all files are committed, run `git push` to push all commits.
6. Show a summary of all commits created (hash + message + file).

## Rules

- Do NOT commit files that likely contain secrets (.env, credentials, tokens). Warn the user instead.
- Group closely related files (e.g., a component and its types file) into a single commit ONLY if they are clearly part of the same atomic change. Prefer separate commits when in doubt.
- If there are no changes to commit, inform the user and stop.
- If push fails, inform the user of the error — do NOT force push.
- Binary files (images, icons) that changed together can be grouped into one commit.
