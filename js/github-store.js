export const GH = window.GH || {};

export const sharedMode = !!GH.dispatchToken && !GH.dispatchToken.startsWith("__");
export const ownerSet = !!GH.owner && !GH.owner.startsWith("__");
export const repoSet  = !!GH.repo  && !GH.repo.startsWith("__");
export const remoteEnabled = ownerSet && repoSet;

export function utf8ToB64(str){
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CHUNK = 0x8000;
  for(let i=0;i<bytes.length;i+=CHUNK){
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i+CHUNK));
  }
  return btoa(bin);
}

export function b64ToUtf8(b64){
  const clean = String(b64||"").replace(/\s+/g,"");
  return new TextDecoder().decode(Uint8Array.from(atob(clean), c=>c.charCodeAt(0)));
}

export function ConflictError(msg){ const e = new Error(msg||"sha conflict"); e.conflict = true; return e; }

export const GHIO = {
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

  async rawGetJson(path){
    const res = await fetch(this.rawUrl(path) + "?cb=" + Date.now(), { cache:"no-store" });
    if(res.status === 404) return null;
    if(!res.ok) throw new Error("rawGetJson "+path+" failed: HTTP "+res.status);
    const text = await res.text();
    try{ return text.trim() ? JSON.parse(text) : null; }catch(e){ return null; }
  },

  async readJson(path){
    // Prefer the keyless CDN read: much faster than the authenticated API, no rate
    // limit, and the ?cb cache-bust keeps it fresh. Fall back to the authenticated
    // Contents API only if the CDN read throws (a 404 returns null = "not found").
    try{ return await this.rawGetJson(path); }
    catch(e){
      if(sharedMode){ try{ return (await this.ghGetFile(path)).json; }catch(e2){} }
      return null;
    }
  },

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

  async ghDeleteFile(path, message){
    let sha;
    try{ const got = await this.ghGetFile(path); sha = got.sha; }
    catch(e){ sha = null; }
    if(!sha) return;
    const res = await fetch(this.apiUrl(path), {
      method:"DELETE", headers:this.ghHeaders(),
      body: JSON.stringify({ message: message || ("delete "+path), sha, branch: GH.dataBranch })
    });
    if(res.status === 404) return;
    if(!res.ok && res.status !== 422) throw new Error("ghDeleteFile "+path+" failed: HTTP "+res.status);
  },

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
        if(e && e.conflict){
          // Apply randomized exponential backoff (jitter)
          const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 3000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error("upsertVoter: exhausted retries");
  },

  async upsertJson(path, mutate, message){
    let lastErr=null;
    for(let attempt=0; attempt<6; attempt++){
      try{
        const { json, sha } = await this.ghGetFile(path);
        const next = mutate(json && typeof json==="object" ? json : {});
        await this.ghPutFile(path, next, sha, message || ("update "+path));
        return next;
      }catch(e){ 
        lastErr=e; 
        if(e&&e.conflict){
          const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 3000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw e; 
      }
    }
    throw lastErr || new Error("upsertJson: exhausted retries");
  },

  ownerNamePath:  h => `owners/n_${h}.json`,
  ownerEmailPath: h => `owners/e_${h}.json`,
  pollJsonPath:  pid => `polls/${pid}/poll.json`,
  votesJsonPath: pid => `polls/${pid}/votes.json`
};

export const Store = (() => {
  const PFX = "czmc:";
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

  async function get(k){ return lget(k); }
  async function set(k,v){ return lset(k,v); }
  async function del(k){ ldel(k); }
  async function list(pfx){ return llist(pfx); }

  async function savePoll(poll){
    lset("poll:"+poll.id, poll);
    if(!sharedMode) return { ok:false, local:true };
    try{
      const pollPath = GHIO.pollJsonPath(poll.id);
      const cur = await GHIO.ghGetFile(pollPath);
      await GHIO.ghPutFile(pollPath, poll, cur.sha, "save-poll: "+poll.id);
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
  
  async function loadPoll(pid){
    if(remoteEnabled){
      try{
        const json = await GHIO.readJson(GHIO.pollJsonPath(pid));
        if(json){ lset("poll:"+pid, json); return json; }
      }catch(e){ }
    }
    return lget("poll:"+pid);
  }
  
  async function loadVotes(pid){
    if(remoteEnabled){
      try{
        const json = await GHIO.readJson(GHIO.votesJsonPath(pid));
        if(json){ return json; }
      }catch(e){ }
    }
    return lget("votes:"+pid) || {};
  }
  
  async function castVote(payload){
    const pid = payload.pollId;
    const key = payload.voterKey;
    const entry = payload.entry;
    const cache = lget("votes:"+pid) || {};
    cache[key] = entry;
    lset("votes:"+pid, cache);
    if(!sharedMode) return { ok:false, local:true };
    try{
      const merged = await GHIO.upsertVoter(pid, key, entry);
      lset("votes:"+pid, merged);
      return { ok:true };
    }catch(e){
      return { ok:false, status:e && e.status, error:e };
    }
  }
  
  function mergeVotes(pid, remote, protectKey){
    const cache = lget("votes:"+pid) || {};
    const merged = { ...remote };
    if(protectKey && cache[protectKey]){
      const r = remote[protectKey], l = cache[protectKey];
      if(!r || (l.updatedAt && (!r.updatedAt || l.updatedAt > r.updatedAt))) merged[protectKey] = l;
    }
    lset("votes:"+pid, merged);
    return merged;
  }
  
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
