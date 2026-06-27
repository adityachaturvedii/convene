# Setup Guide — from zero to a live, vote-collecting site

This is the click-by-click guide for **you, the organizer (Aditya)**, to publish the meeting-overlap
poll and start collecting votes. No prior GitHub experience is assumed. Follow the steps **in order**.

You will end up with a free public website at:

```
https://adityachaturvedii.github.io/convene/
```

This guide is pre-filled for the account **adityachaturvedii** and the repository **convene**
(live URL `https://adityachaturvedii.github.io/convene/`). If you use a different account or repo
name, do a find-and-replace of those two values here and in the `GH` config block at the top of
`index.html`.

> **Before you start, you need:**
> - A GitHub account (free) — sign up at https://github.com if you don't have one.
> - Git installed on your computer (https://git-scm.com), OR you can use GitHub's web uploader.
> - The project files: `index.html`, the `.github/workflows/` folder, and the `scripts/` folder.

---

## Step 1 — Create a new PUBLIC repository and push the files

The repo **must be public** — that is what makes Actions free and lets browsers read the data
without a key.

1. Go to https://github.com and click the **+** in the top-right, then **New repository**.
2. **Owner:** your account. **Repository name:** pick a short name, e.g. `meeting-poll`.
3. Set visibility to **Public**. *(Do not check "Add a README" — you already have one.)*
4. Click **Create repository**.
5. GitHub shows you a page with a repo URL like `https://github.com/adityachaturvedii/convene.git`.
   Push the project files to the `main` branch. From a terminal, in the folder that contains
   `index.html`:

   ```bash
   git init
   git add index.html .github scripts README.md SETUP.md
   git commit -m "Initial app + workflows"
   git branch -M main
   git remote add origin https://github.com/adityachaturvedii/convene.git
   git push -u origin main
   ```

   *(Prefer clicking? On the repo page choose "uploading an existing file" and drag in `index.html`,
   the `.github` folder, and the `scripts` folder. Git on the command line is recommended because it
   preserves the folder structure correctly.)*

After this, your application code lives on the **`main`** branch.

---

## Step 2 — Create the orphan `poll-data` branch (the database)

Votes and polls are stored as JSON on a **separate branch called `poll-data`**, kept completely
apart from your app code. "Orphan" just means it starts with no shared history — it is a clean,
empty branch.

Run these commands in the same project folder:

```bash
git checkout --orphan poll-data   # create a fresh branch with no history
git rm -rf .                      # remove all tracked files so it starts empty
git commit --allow-empty -m "Init poll-data branch"   # an empty first commit
git push origin poll-data         # publish the branch to GitHub
git checkout main                 # switch back to your app branch
```

> **Note:** if you skip this step, **the ingest Action will create the `poll-data` branch
> automatically the first time someone saves a poll or votes.** Creating it yourself up front is
> tidier and avoids a confusing first-run, but it is optional.

Always finish by switching back to `main` so you don't accidentally commit app changes onto the data
branch.

---

## Step 3 — Create a fine-grained token and add it as an Actions secret

This is the single most important step for going from "local-only" to "live." The page needs a
token so a visitor's browser can ask GitHub to save a vote (the technical name for that request is a
**repository_dispatch**, and triggering it requires **Contents: Read and write** permission).

We deliberately make this token as weak as possible.

**Create the token:**
1. Go to https://github.com → click your profile picture (top-right) → **Settings**.
2. In the left sidebar, scroll to the bottom and click **Developer settings**.
3. Click **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
4. **Token name:** e.g. `poll-dispatch`.
5. **Expiration:** choose a **short** expiry (e.g. 30 days). A short life limits the damage if it
   leaks. *(You will need to regenerate and re-paste it when it expires — see "Maintenance" below.)*
6. **Resource owner:** your account.
7. **Repository access:** select **Only select repositories** and choose **just this one repo**
   (`convene`). Do **not** grant access to all repositories.
8. **Permissions** → **Repository permissions** → find **Contents** and set it to
   **Read and write**. Leave everything else as **No access**.
9. Click **Generate token** and **copy the token now** — GitHub only shows it once.

**Add it as an Actions secret (named exactly `POLL_DISPATCH_TOKEN`):**
1. Go to your repository → **Settings** (the repo's settings, not your account's).
2. Left sidebar → **Secrets and variables** → **Actions**.
3. Click **New repository secret**.
4. **Name:** `POLL_DISPATCH_TOKEN` (must be spelled exactly this way).
5. **Secret:** paste the token you copied.
6. Click **Add secret**.

At deploy time, the workflow injects this secret into the published page so it can save votes. Until
this secret exists, the site runs in **local-only mode** and nothing is saved.

---

## Step 4 — Turn on GitHub Pages (built by Actions)

1. Repository → **Settings** → left sidebar → **Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. There is nothing else to fill in here — the deploy workflow handles the build and publish.

---

## Step 5 — Protect the `main` branch

**Why:** the dispatch token is visible in the public page. Branch protection makes sure that even if
someone grabs that token, they **cannot overwrite your application source code** — only the
controlled workflow can write to the data branch. This is what keeps the worst case to "junk votes
I can revert" instead of "my site got replaced."

1. Repository → **Settings** → left sidebar → **Branches**.
2. Click **Add branch protection rule** (or **Add rule**).
3. **Branch name pattern:** `main`.
4. Enable **Require a pull request before merging** (this restricts direct pushes to `main`).
5. *(Optional but recommended:)* enable **Do not allow bypassing the above settings**.
6. Click **Create** / **Save changes**.

From now on you change the app via pull requests, but normal voting (which writes only to
`poll-data`) is unaffected.

---

## Step 6 — Publish, get your live URL, and send invites

1. Pushing to `main` (Step 1, or any later change merged via PR) triggers the **deploy Action**.
   Watch it under the repository's **Actions** tab; wait for the green check.
2. Your live site is now at:

   ```
   https://adityachaturvedii.github.io/convene/
   ```

   Open it. If the deploy injected the secret from Step 3, you are in **shared mode** and votes will
   save. (If it still says local-only, re-check Step 3 and re-run the deploy.)

3. **Build a poll** on the page: enter the meeting details, add your invitees to the roster, and
   pick the candidate slots. The page **mints a private token for each invitee** and produces a
   personal **invite link** for each one. The link shape is:

   ```
   https://adityachaturvedii.github.io/convene/#poll=<pollId>&who=<rosterId>&t=<rawToken>
   ```

   - `<pollId>` identifies the poll, `<rosterId>` identifies the person, and `<rawToken>` is their
     private key that proves it's really them.
   - **Each person gets a different link — do not reuse one link for several people.**

4. **Send the links yourself.** The tool does **not** email anyone. You copy each person's invite
   link and paste it into your own **Outlook** (or any email/chat) and send it to that person
   individually. Their email address stays in your Outlook and your browser — it is never stored in
   the repo.

---

## Step 7 — How voting flows (what happens after you hit the wire)

When an invitee opens their link and submits yes / maybe / no:

1. **Dispatch** — their browser sends the vote to GitHub as a `repository_dispatch` event. GitHub
   immediately replies "accepted" (this is asynchronous — the data isn't saved *yet*).
2. **Action validates** — the ingest GitHub Action wakes up, re-hashes the invitee's token and
   checks it matches the roster. Valid votes are accepted; mismatches are rejected. (Someone who
   typed a name that isn't on the roster is recorded as a *guest* vote, stored separately.)
3. **Commit to `poll-data`** — the Action writes/updates that one person's entry in the poll's
   `votes.json` on the `poll-data` branch. Writes are serialized so simultaneous votes don't clobber
   each other.
4. **Page reads it back** — the results view re-reads the data from GitHub. The new vote appears on
   screen in about **15–30 seconds**. The page auto-refreshes every ~12 seconds while open, and
   there's a manual **Refresh** button too.

That's the whole loop: **dispatch → validate → commit → read back.**

---

## Maintenance & troubleshooting

- **"Nothing is saving / others can't see votes."** You're likely in local-only mode. Confirm the
  `POLL_DISPATCH_TOKEN` secret exists (Step 3) and that you re-ran the deploy afterwards.
- **Voting suddenly stops working weeks later.** The fine-grained token probably **expired**.
  Regenerate it (Step 3) and update the `POLL_DISPATCH_TOKEN` secret, then re-run the deploy.
- **A vote takes a while to show.** Saving is asynchronous; give it 15–30 seconds and hit Refresh.
- **Old polls disappearing.** That's intended — a scheduled workflow deletes any poll whose meeting
  date is more than **90 days** in the past.

You're live. Build a poll, send the per-person links from Outlook, and watch the votes roll in.
