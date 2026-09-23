Merge all local feature branches into the `dev` branch for local testing.

Steps:
1. Run `git branch --list 'feat/*' 'fix/*' 'refactor/*' 'chore/*' 'docs/*'` to find all feature branches.
2. If no `dev` branch exists, create it from `master`: `git checkout -b dev master`
3. If `dev` exists, check it out and reset it to master: `git checkout dev && git reset --hard master`
4. For each feature branch found, merge it into dev: `git merge <branch> --no-edit`
   - If a merge conflict occurs, auto-resolve using `git merge -X theirs <branch> --no-edit` (prefer the feature branch's changes).
   - Report which branches were merged and if any conflicts were auto-resolved.
5. After all merges, print a summary of which branches are included in `dev`.
6. Stay on the `dev` branch so the user can test immediately.

IMPORTANT: Never push the `dev` branch to remote. It is local-only.
