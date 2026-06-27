"use strict";
// sharedMode = a real token was injected at deploy.
// IMPORTANT: do NOT compare against a literal copy of "__POLL_DISPATCH_TOKEN__" —
// the deploy's find-and-replace would substitute that copy too, making it equal
// to the injected token and forcing sharedMode false forever. Instead detect the
// un-injected placeholder by its "__" prefix; a real PAT never starts with "__".
const sharedMode = !!GH.dispatchToken && !GH.dispatchToken.startsWith("__");
// Detect un-injected placeholders ONLY by their "__" prefix. Never compare against
// a literal "__GH_OWNER__"/"__GH_REPO__" copy — the deploy's find-and-replace would
// rewrite that copy too (it rewrote __POLL_DISPATCH_TOKEN__ the same way), turning
// the comparison into x !== x and silently disabling remote reads.
const ownerSet = !!GH.owner && !GH.owner.startsWith("__");
const repoSet  = !!GH.repo  && !GH.repo.startsWith("__");
// reads can happen whenever owner/repo are known (keyless via raw), even without a token
const remoteEnabled = ownerSet && repoSet;
const GHIO = {
  ghHeaders(){
    return {
      "Authorization":"Bearer "+GH.dispatchToken,
      "Accept":"application/vnd.github+json",
      "X-GitHub-Api-Version":"2022-11-28"
    };
  },
  apiUrl(path){
    return `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${path}`;
  },
  rawUrl(path){
    return `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${GH.dataBranch}/${path}`;
  },

  // GET a JSON file on the data branch. 200 => {json, sha}; 404 => {json:null, sha:null}.
  async ghGetFile(path){
    const url = this.apiUrl(path) + "?ref=" + encodeURIComponent(GH.dataBranch) + "&cb=" + Date.now();
    const res = await fetch(url, { headers:this.ghHeaders(), cache:"no-store" });
    if(res.status === 404) return { json:null, sha:null };
    if(!res.ok) throw new Error("ghGetFile "+path+" failed: HTTP "+res.status);
    const data = await res.json();
    const text = b64ToUtf8(data.content||"");
    let json = null;
    try{ json = text.trim() ? JSON.parse(text) : null; }catch(e){ json = null; }
    return { json, sha:data.sha };
  },

  // KEYLESS read via raw.githubusercontent (public, CDN). No token, no API rate
  // limit — so a published poll is findable on ANY device/network even if that
  // page never got a token injected. Returns the parsed JSON or null on 404.
  async rawGetJson(path){
    const res = await fetch(this.rawUrl(path) + "?cb=" + Date.now(), { cache:"no-store" });
    if(res.status === 404) return null;
    if(!res.ok) throw new Error("rawGetJson "+path+" failed: HTTP "+res.status);
    const text = await res.text();
    try{ return text.trim() ? JSON.parse(text) : null; }catch(e){ return null; }
  },

  // Best read for the situation: authenticated+fresh when we hold a token,
  // otherwise the keyless raw fallback so reads still work.
  async readJson(path){
    if(sharedMode){ try{ return (await this.ghGetFile(path)).json; }catch(e){ /* fall back */ } }
    return this.rawGetJson(path);
  },

  // PUT (create/update) a JSON file. Returns the new content sha.
  // On 409/422 (stale sha) throw a tagged conflict error so callers can retry.
  async ghPutFile(path, obj, sha, message){
    const body = {
      message: message || ("update "+path),
      content: utf8ToB64(JSON.stringify(obj, null, 0)),
      branch: GH.dataBranch
    };
    if(sha) body.sha = sha;
    const res = await fetch(this.apiUrl(path), {
      method:"PUT", headers:this.ghHeaders(), body: JSON.stringify(body)
    });
    if(res.status === 409 || res.status === 422) throw ConflictError("stale sha for "+path);
    if(!res.ok) throw new Error("ghPutFile "+path+" failed: HTTP "+res.status);
    const data = await res.json();
    return data.content && data.content.sha;
  },

  // DELETE a file via the Contents API (needs its current sha). Ignore 404.
  async ghDeleteFile(path, message){
    let sha;
    try{ const got = await this.ghGetFile(path); sha = got.sha; }
    catch(e){ sha = null; }
    if(!sha) return;                         // already absent (404) — nothing to do
    const res = await fetch(this.apiUrl(path), {
      method:"DELETE", headers:this.ghHeaders(),
      body: JSON.stringify({ message: message || ("delete "+path), sha, branch: GH.dataBranch })
    });
    if(res.status === 404) return;
    if(!res.ok && res.status !== 422) throw new Error("ghDeleteFile "+path+" failed: HTTP "+res.status);
  },

  // read-modify-write a single voter row into votes.json with a retry loop.
  // up to 6 attempts: GET (fresh sha) -> merge votes[voterKey]=entry -> PUT.
  // On a stale-sha conflict, refetch and retry. Never discards other rows.
  async upsertVoter(pollId, voterKey, entry){
    const path = this.votesJsonPath(pollId);
    let lastErr = null;
    for(let attempt=0; attempt<6; attempt++){
      try{
        const { json, sha } = await this.ghGetFile(path);
        const votes = json && typeof json === "object" ? { ...json } : {};
        votes[voterKey] = entry;
        await this.ghPutFile(path, votes, sha, "vote: "+voterKey);
        return votes;
      }catch(e){
        lastErr = e;
        if(e && e.conflict) continue;        // stale sha — refetch & retry
        throw e;                             // non-conflict error — bubble up
      }
    }
    throw lastErr || new Error("upsertVoter: exhausted retries");
  },

  // generic read-modify-write of a JSON file with a stale-sha retry loop.
  // mutate(obj) receives the current object (or {}) and returns the new object.
  async upsertJson(path, mutate, message){
    let lastErr=null;
    for(let attempt=0; attempt<6; attempt++){
      try{
        const { json, sha } = await this.ghGetFile(path);
        const next = mutate(json && typeof json==="object" ? json : {});
        await this.ghPutFile(path, next, sha, message || ("update "+path));
        return next;
      }catch(e){ lastErr=e; if(e&&e.conflict) continue; throw e; }
    }
    throw lastErr || new Error("upsertJson: exhausted retries");
  },

  // organizer poll indexes (so a publisher lists THEIR polls from any device, no accounts):
  //  owners/n_<sha256(lowercased name)>.json  = { name, byEmail:{ <emailHash|"_noemail">:{emailHash, polls:{id:{title,meetingDateISO,updatedAt}}} } }
  //  owners/e_<sha256(lowercased email)>.json = { name, polls:{ id:{...} } }
  ownerNamePath:  h => `owners/n_${h}.json`,
  ownerEmailPath: h => `owners/e_${h}.json`,
  pollJsonPath:  pid => `polls/${pid}/poll.json`,
  votesJsonPath: pid => `polls/${pid}/votes.json`
};

/* ====================================================================
   1. STORE ADAPTER — the only persistence swap point.
   --------------------------------------------------------------------
   localStorage is ALWAYS used (cache + local-only source of truth for
   organizer setup and the user's own in-progress vote). When sharedMode,
   GitHub is layered on via DIRECT Contents-API commits (CHANGE 1): writes
   PUT poll.json / votes.json directly to the poll-data branch, reads GET
   them fresh through the same API. The four-function shape (get/set/del/
   list) is preserved for local keys; GitHub-backed poll/vote data uses
   the explicit Contents-API helpers below it.
   ==================================================================== */
const Store = (() => {
  const PFX = "czmc:";                  // localStorage namespace
  function lget(k){
    try{ const v = localStorage.getItem(PFX+k); return v==null ? null : JSON.parse(v); }
    catch(e){ return null; }
  }
  function lset(k,v){
    try{ localStorage.setItem(PFX+k, JSON.stringify(v)); return true; }
    catch(e){ return false; }
  }
  function ldel(k){ try{ localStorage.removeItem(PFX+k); }catch(e){} }
  function llist(pfx){
    const out=[];
    try{
      for(let i=0;i<localStorage.length;i++){
        const key = localStorage.key(i);
        if(key && key.startsWith(PFX+pfx)) out.push(key.slice(PFX.length));
      }
    }catch(e){}
    return out;
  }

  // --- four-function local adapter (organizer setup, drafts, identity) ---
  async function get(k){ return lget(k); }
  async function set(k,v){ return lset(k,v); }
  async function del(k){ ldel(k); }
  async function list(pfx){ return llist(pfx); }

  // --- GitHub-backed poll/vote ops (sharedMode) with local cache ---
  // savePoll: cache locally + PUT poll.json directly; ensure votes.json exists.
  async function savePoll(poll){
    lset("poll:"+poll.id, poll);
    if(!sharedMode) return { ok:false, local:true };
    try{
      const pollPath = GHIO.pollJsonPath(poll.id);
      const cur = await GHIO.ghGetFile(pollPath);     // get sha if it already exists
      await GHIO.ghPutFile(pollPath, poll, cur.sha, "save-poll: "+poll.id);
      // create an empty votes.json if it isn't there yet (so reads never 404 forever)
      const vp = GHIO.votesJsonPath(poll.id);
      const ve = await GHIO.ghGetFile(vp);
      if(ve.json === null && ve.sha === null){
        await GHIO.ghPutFile(vp, {}, null, "init votes: "+poll.id);
      }
      return { ok:true };
    }catch(e){
      return { ok:false, status:e && e.status, error:e };
    }
  }
  // loadPoll: try remote (authenticated if we have a token, else keyless raw) so
  // a published poll is findable on any device; fall back to local cache.
  async function loadPoll(pid){
    if(remoteEnabled){
      try{
        const json = await GHIO.readJson(GHIO.pollJsonPath(pid));
        if(json){ lset("poll:"+pid, json); return json; }
      }catch(e){ /* fall through to local cache on transient error */ }
    }
    return lget("poll:"+pid);
  }
  // loadVotes: same remote-first (keyless-capable), fall back to local optimistic cache
  async function loadVotes(pid){
    if(remoteEnabled){
      try{
        const json = await GHIO.readJson(GHIO.votesJsonPath(pid));
        if(json){ return json; }
      }catch(e){ /* fall through to local cache */ }
    }
    return lget("votes:"+pid) || {};
  }
  // castVote: optimistic local write, then commit the single voter row directly.
  // `payload.voterKey` and `payload.entry` are precomputed by the caller (the
  // responder), because the voterKey/entry shape now varies (token vs central).
  async function castVote(payload){
    const pid = payload.pollId;
    const key = payload.voterKey;
    const entry = payload.entry;
    // optimistic local cache so a failed PUT never loses the user's picks
    const cache = lget("votes:"+pid) || {};
    cache[key] = entry;
    lset("votes:"+pid, cache);
    if(!sharedMode) return { ok:false, local:true };
    try{
      const merged = await GHIO.upsertVoter(pid, key, entry);
      lset("votes:"+pid, merged);            // adopt the server's view (still has our row)
      return { ok:true };
    }catch(e){
      return { ok:false, status:e && e.status, error:e };
    }
  }
  // merge fetched votes into local cache without dropping in-flight local key
  function mergeVotes(pid, remote, protectKey){
    const cache = lget("votes:"+pid) || {};
    const merged = { ...remote };
    if(protectKey && cache[protectKey]){
      // keep local optimistic copy if remote doesn't yet have a newer one
      const r = remote[protectKey], l = cache[protectKey];
      if(!r || (l.updatedAt && (!r.updatedAt || l.updatedAt > r.updatedAt))) merged[protectKey] = l;
    }
    lset("votes:"+pid, merged);
    return merged;
  }
  // deletePoll: DELETE poll.json + votes.json via the Contents API (CHANGE 5).
  async function deletePoll(pid){
    ldel("poll:"+pid); ldel("votes:"+pid);
    if(!sharedMode) return { ok:false, local:true };
    try{
      await GHIO.ghDeleteFile(GHIO.votesJsonPath(pid), "delete-poll votes: "+pid);
      await GHIO.ghDeleteFile(GHIO.pollJsonPath(pid),  "delete-poll: "+pid);
      return { ok:true };
    }catch(e){
      return { ok:false, status:e && e.status, error:e };
    }
  }

  return { get, set, del, list,
           savePoll, loadPoll, loadVotes, castVote, mergeVotes, deletePoll };
})();
