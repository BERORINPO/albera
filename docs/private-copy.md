# Running a private copy of ALBERA

A fork of a public repository is public. To use ALBERA inside an organization that keeps its code private, make a
**private copy** instead, and let the copy hear about new versions of ALBERA by itself.

What this gives you:

1. **A notice when ALBERA changes.** Once a week the copy compares itself with the public ALBERA.
2. **One pull request that brings the changes in.** It is called `ALBERA update: N new commits`, lists the new
   CHANGELOG lines and the commits, and is refreshed while it stays open. Everyone watching the copy is notified when it
   opens. Nothing merges by itself: a person reads it and merges it.

The workflow that does this is [`.github/workflows/albera-updates.yml`](../.github/workflows/albera-updates.yml); the
work is done by [`scripts/upstream-sync.mjs`](../scripts/upstream-sync.mjs). It never runs in the public ALBERA itself.

## Make the copy

Keep the history: the weekly comparison needs it. In an empty **private** repository you created (no README, no
license), run once, from any folder:

```
git clone --bare https://github.com/BERORINPO/albera.git
cd albera.git
git push --mirror https://github.com/<your-org>/<your-copy>.git
cd ..
```

Then delete the `albera.git` folder and clone your copy as usual. (A copy made by uploading files, or by
"import" without history, shares no history with ALBERA: the workflow will say so and stop.)

## Turn the updates on

1. In the copy: **Settings > Actions > General**: allow Actions to run, and turn on
   **Allow GitHub Actions to create and approve pull requests**.
2. **Actions > ALBERA updates (for private copies) > Run workflow** once, to see it work. After that it runs every
   Monday at 03:17 UTC.

Optional settings (Settings > Secrets and variables > Actions):

| Name | Kind | Use |
|---|---|---|
| `ALBERA_SYNC_TOKEN` | secret | A token for this copy only that may write contents, pull requests **and workflows**. Needed only when ALBERA changes files under `.github/workflows/`: GitHub's own workflow token may not push those. |
| `ALBERA_UPSTREAM_REF` | variable | The ALBERA branch to follow. Default `main`. |
| `ALBERA_BASE_BRANCH` | variable | The copy's branch the pull request goes into. Default: the copy's default branch. |
| `ALBERA_UPSTREAM` | variable | Where ALBERA is fetched from. Default `https://github.com/BERORINPO/albera.git`. |

To stop the updates, disable the workflow (Actions > the workflow > Disable workflow).

## Keep your own changes easy to merge

The update pull request merges ALBERA's changes into your branch, next to your own commits. It merges cleanly as long
as you do not edit the same lines. Put your own settings outside the files ALBERA ships where you can: for example,
the explain map tool (`tools/mochiba`) takes its role tables from a file you pass with `--arch`, so nothing in the
tool's folder has to change.

If GitHub shows a conflict, resolve it in the pull request (or locally on the `albera-update` branch) like any other.

## When the update cannot be pushed

When ALBERA changes files under `.github/workflows/`, GitHub refuses to let the workflow's own token push them, and the
job ends with a message that says so. Either add `ALBERA_SYNC_TOKEN` (see above), or let a person who may change
workflows push the branch once, then run the workflow again so it opens the pull request:

```
git fetch https://github.com/BERORINPO/albera.git main
git push origin FETCH_HEAD:refs/heads/albera-update
```

Read workflow changes before merging them: they run in your copy with your copy's permissions.

## What the workflow reads and sends

- It fetches the public ALBERA branch. That is its only connection outside your copy.
- In your copy it pushes one branch, `albera-update` (it writes no other branch), and opens or edits one pull request.
- The pull request body holds only ALBERA's own commit subjects and CHANGELOG lines, inside fenced blocks (so they
  cannot mention people or show images in your copy). Nothing about your copy (its code, branches, issues or pull
  requests) is read for the body or sent anywhere.

## Telling ALBERA about a problem

Issues in BERORINPO/albera are **public**. Use the Bug report form there, and describe the problem in general terms:
do not paste your organization's code, names, paths, screenshots or anything from a page the tools wrote about your
code.
