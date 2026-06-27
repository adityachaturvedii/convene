# Meeting Overlap & Invite Poll

A single static web page that solves one annoying problem: **finding a meeting time that works
across Australia (AEST) and Europe (CEST)** — and then **collecting everyone's vote** on the
candidate times, without anyone needing a login, a server, or a paid service.

The whole thing runs as one `index.html` file served free by GitHub Pages, with GitHub Actions
acting as the "save" button behind the scenes. There is no backend to run or pay for.

---

## What it does

### The overlap problem
When half your team is in Australian Eastern time and half is in Central European time, the
working-hours windows barely touch. Eyeballing "what time is 9am in Sydney over in Berlin" across
a roster of people is error-prone and tedious. This tool computes the real overlap for you.

### The three analyzer views
1. **Timeline / overlap view** — each person's working window drawn on a shared 24-hour axis so you
   can see at a glance where the green overlap band is.
2. **Per-zone clock view** — the same candidate time shown simultaneously in every participant's
   local time, so no one has to do the maths.
3. **Ranked-slots view** — candidate meeting slots scored by how much working-hours overlap they
   capture, best first, so you can pick the least-painful options to put to a vote.

### The invite poll
Once you've chosen a short list of candidate slots, the page turns them into a **poll**. You mint a
private invite link per person, they open it, pick **yes / maybe / no** for each slot, and their
answer is saved. You watch the results come in live. Think of it as a tiny, self-hosted Doodle that
is timezone-aware and costs nothing.

---

## How it saves data (in one breath)

Your browser does not write files directly. When someone votes, the page commits the vote directly to a separate `poll-data` branch using the GitHub Contents API. The page then reads that JSON straight back from GitHub. Saved data shows up on screen instantly (~1-2 seconds) — there is zero backend latency, and no waiting for CI runners.

---

## Local mode vs shared mode

The page detects which mode it is in by looking at whether a real dispatch token was injected at
deploy time.

- **Local-only mode** — no real token is present (you opened the file locally, or the deploy secret
  was never set). Everything works *in your own browser* — you can build polls and try voting — but
  **nothing is saved to GitHub and nobody else can see it.** Good for trying things out.
- **Shared mode** — a real token was injected by the deploy. Now votes are actually committed to the
  `poll-data` branch and the poll is genuinely collaborative. This is the live, vote-collecting site.

If results never appear for other people, you are almost certainly still in local-only mode — see
`SETUP.md` step 3 (the `POLL_DISPATCH_TOKEN` secret).

---

## Security posture (the honest version)

> **Read this so there are no surprises.**
>
> To let an unauthenticated visitor's browser save a vote, the page must carry a GitHub token, and
> that token is **visible to anyone who views the page source.** That sounds alarming, so here is
> exactly why it is acceptable for this use case — and where the limits are:
>
> - **The token is deliberately weak.** It is a *fine-grained* Personal Access Token scoped to
>   **this one repository only**, with permission limited to **Contents: Read and write**, and a
>   **short expiry**. It cannot touch your other repos, your account, or anything else.
> - **The app source is protected.** Branch protection on `main` means that even though the token
>   can write to the repo, it **cannot overwrite the application code** — only the workflow can
>   commit to the data branch in the controlled way it is designed to. Worst case, an abuser writes
>   junk into the poll data, which you can revert; they cannot deface or hijack the site.
> - **No private data is in the page.** Emails **never leave your (the organizer's) browser** — they
>   are not stored, committed, or sent anywhere. Only a one-way **SHA-256 hash** of each invitee's
>   token is ever committed, never the raw token and never the email.
> - **Identity is honor-system, bounded by the roster.** A vote is accepted only if the invite
>   token's hash matches someone on the roster you created, so a random stranger can't impersonate a
>   named invitee. But this is *integrity by invitation*, not airtight authentication: anyone who is
>   forwarded a valid invite link could vote as that person. Treat it as "good enough for scheduling
>   a meeting," not as a secure ballot.
> - **Free forever.** Public repositories get **unlimited GitHub Actions minutes** and GitHub Pages
>   is free, so the running cost is **$0**.
>
> **What this is NOT:** it is not a hardened, server-side-secret system. The properly secured design
> — where the write token lives only on a server and never ships to the browser — is the documented
> **v2** direction, not what ships here. If you need real authentication or confidential ballots, do
> not use this version.

---

## Data retention

Poll data is **automatically cleaned up.** A scheduled GitHub Action deletes any poll whose meeting
date is **more than 90 days in the past.** You do not need to prune anything by hand; old polls and
their votes simply age out.

---

## Cost

**$0.** Public GitHub repo + GitHub Pages + unlimited Actions minutes on public repos. There is
nothing to pay and no server to keep alive.

---

## Getting it live

See **[SETUP.md](./SETUP.md)** for the complete, click-by-click guide to go from an empty GitHub
account to a live, vote-collecting site.
