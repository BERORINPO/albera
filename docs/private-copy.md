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

Keep the history: the weekly comparison needs it. Create an empty **private** repository (no README, no license),
then run once, from any folder:

```
git clone --bare https://github.com/BERORINPO/albera.git
cd albera.git
git push https://github.com/<your-org>/<your-copy>.git main
cd ..
```

This pushes ALBERA's `main` only, not its other branches. Check that `main` is the copy's default branch
(Settings > General > Default branch). Then delete the `albera.git` folder and clone your copy as usual.

A copy made by uploading files, or by an import without history, shares no history with ALBERA: the workflow says so
and stops.

## Turn the updates on

1. In the copy, **Settings > Actions > General**: allow Actions to run, and turn on
   **Allow GitHub Actions to create and approve pull requests**. In an organization the switch may be greyed out: an
   organization owner first allows it in the organization's own **Settings > Actions > General**.
2. **Actions > ALBERA updates (for private copies) > Run workflow** once, to see it work. After that it runs every
   Monday at 03:17 UTC.

Optional settings (Settings > Secrets and variables > Actions):

| Name | Kind | Use |
|---|---|---|
| `ALBERA_UPSTREAM_REF` | variable | The ALBERA branch to follow. Default `main`. |
| `ALBERA_BASE_BRANCH` | variable | The copy's branch the pull request goes into. Default: the copy's default branch. |
| `ALBERA_UPSTREAM` | variable | Where ALBERA is fetched from. Default `https://github.com/BERORINPO/albera.git`. |
| `ALBERA_SYNC_TOKEN` | secret | Not recommended; read "Checks on the update pull request" first. A token for this copy only that may write contents, pull requests and workflows. With it, the workflow can also push changed workflow files, and checks start on the pull request by themselves. |

To stop the updates, disable the workflow (Actions > the workflow > Disable workflow).

## Merge the update with a merge commit

Merge the update pull request with **Create a merge commit**, not squash or rebase. A merge commit keeps the copy's
history joined to ALBERA's, so the next update lists only what is new. (After a squash or rebase merge the workflow
still sees that the changes are in and does not open the same pull request again, but the next update's commit list
starts from the older point.)

## Checks on the update pull request

Checks run ALBERA's new code, and any workflow it changed, inside your copy with your copy's secrets. So a person
reads the pull request first and starts them second:

- With GitHub's own workflow token (the default), GitHub does not start other workflows from what the token did, so
  **the checks do not start by themselves**. After reading the changes, close the pull request and reopen it: that
  starts them, as you.
- With `ALBERA_SYNC_TOKEN`, the checks start as soon as the pull request opens or is refreshed, before anyone has read
  it. Use it only if you accept that.

## Keep your own changes easy to merge

The update pull request merges ALBERA's changes into your branch, next to your own commits. It merges cleanly as long
as you do not edit the same lines. Put your own settings outside the files ALBERA ships where you can: for example, the
explain map tool (`tools/mochiba`) takes its role tables from a file you pass with `--arch`, so nothing in the tool's
folder has to change.

If GitHub shows a conflict, resolve it in the pull request (or locally on the `albera-update` branch) like any other.
The workflow keeps what you commit there: next week it merges the newer ALBERA on top of your commits, and if that
conflicts too, it changes nothing and says so.

## When the update cannot be pushed

Two cases end the job with a message:

- **ALBERA changed files under `.github/workflows/`.** GitHub does not let the workflow's own token push those. A
  person who may change workflows reads them, then pushes the branch once and runs the workflow again, which opens the
  pull request.
- **Your commits on `albera-update` conflict with the newer ALBERA.** Merge the open update pull request first, or
  merge the newer ALBERA into the branch by hand.

Both by hand, in a clone of the copy (use your `ALBERA_UPSTREAM` and `ALBERA_UPSTREAM_REF` if you set them):

```
git fetch https://github.com/BERORINPO/albera.git main
git switch albera-update        # skip if the branch does not exist yet: then push FETCH_HEAD directly
git merge FETCH_HEAD
git push origin HEAD:refs/heads/albera-update
```

## What the workflow reads and sends

- It fetches the public ALBERA branch. That is its only connection outside your copy.
- In your copy it writes one branch, `albera-update`, and never by force: it creates it, moves it forward, or merges
  onto the commits a person added there. It opens or edits one pull request, from that branch of this repository.
- The pull request body holds only ALBERA's own commit subjects and CHANGELOG lines, inside fenced blocks (so they
  cannot mention people or show images in your copy). Nothing about your copy (its code, branches, issues or pull
  requests) is read for the body or sent anywhere.

## Telling ALBERA about a problem

Open an issue in BERORINPO/albera with the form **From a private copy or the explain map**
(<https://github.com/BERORINPO/albera/issues/new?template=from-a-copy.yml>). The explain map page and every update
pull request link to it.

Issues there are **public**: anyone can read them. Describe the problem in general terms, and do not paste your
organization's code, file or feature names, paths, screenshots, or anything from a page the tools wrote about your code.
The form asks you to confirm that before it sends.
