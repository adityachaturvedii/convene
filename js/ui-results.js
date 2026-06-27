import { state, appState, setConvergeAllOnly, lookupMyPolls as doLoadMyPolls } from "./state.js";
import { esc } from "./utils.js";
import { localPartsFull, zonedWallToUtc, localParts } from "./tz-engine.js";
import { Store, sharedMode } from "./github-store.js";
import { app, render } from "./ui-components.js";

export function convToggle(el){
  setConvergeAllOnly(!!(el && el.checked));
  if(appState.appMode==="responder"){ 
    // In responder, we just call a global hook. We'll handle this in responder.js.
    window.refreshDashboard && window.refreshDashboard();
  } else if(appState.view==="results"){ 
    refreshResults(); 
  }
}

export function convergencePanel(poll, votes, opts){
  opts = opts || {};
  const refTz = poll.refTz;
  const pad = n => String(n).padStart(2,"0");
  // Include EVERY respondent who shared weekly availability, regardless of their
  // Yes/Maybe/No answers (the refactor wrongly limited this to all-"n" voters,
  // and "n" never matched the real value "no" — so it always came up empty).
  const contributors = Object.values(votes||{})
    .filter(v => v && v.availability && Object.keys(v.availability).length)
    .map(v => ({ tz: v.tz || refTz, avail: v.availability }));
  if(!contributors.length){
    if(opts.responder) return "";
    return `<div class="panel"><h2>Best converging times</h2>
      <p class="note">No one has shared their weekly availability yet. As responders add the hours they're free (with any answer — Yes, Maybe or No), the best meeting windows appear here automatically.</p></div>`;
  }
  const M = contributors.length;

  const dayCount = {}, dayMeta = {};
  contributors.forEach(c=>{
    Object.entries(c.avail).forEach(([dISO, hours])=>{
      const [Y,Mo,D] = dISO.split("-").map(Number);
      (hours||[]).forEach(h=>{
        const utc = zonedWallToUtc(Y, Mo, D, h, 0, c.tz);
        const rp = localPartsFull(utc, refTz);
        const refHour = parseInt(localParts(utc, refTz).hh, 10);
        const key = `${rp.y}-${pad(rp.m)}-${pad(rp.d)}`;
        dayCount[key] = dayCount[key] || {};
        dayCount[key][refHour] = (dayCount[key][refHour]||0) + 1;
        dayMeta[key] = { y:rp.y, m:rp.m, d:rp.d };
      });
    });
  });

  const flat = [];
  Object.entries(dayCount).forEach(([dISO, hours])=>
    Object.entries(hours).forEach(([h,c])=> flat.push({ dISO, h:+h, c, meta:dayMeta[dISO] })));
  flat.sort((a,b)=> b.c-a.c || a.dISO.localeCompare(b.dISO) || a.h-b.h);
  let ranked = flat.filter(x=>x.c>0);
  if(appState.convergeAllOnly) ranked = ranked.filter(x=>x.c===M);
  const top = ranked.slice(0, opts.responder?4:6);
  const maxC = top.length ? top[0].c : 0;
  const zonesMulti = (poll.zones||[]).length>1;
  const suggestions = top.map((x,i)=>{
    const utc = zonedWallToUtc(x.meta.y, x.meta.m, x.meta.d, x.h, 0, refTz);
    const lp = localParts(utc, refTz);
    const isBest = x.c===maxC;
    const zmini = zonesMulti ? (poll.zones||[]).map(z=>{ const zl=localParts(utc,z.tz);
      return `${esc(z.tz.split("/").pop())} <b class="mono">${zl.hh}:${zl.mm}</b>`; }).join(" · ") : "";
    return `<div class="res-card${isBest?" leading":""}">
      <div class="res-top"><span class="res-rank">${i+1}</span>
        <div class="res-when"><div class="res-time">${lp.wd} ${pad(x.h)}:00</div>
          <div class="res-sub">${lp.day} ${lp.mon} · ${esc(refTz.split("/").pop())}</div></div>
        <span class="res-badge" ${isBest?'':'style="background:var(--muted)"'}>${x.c} of ${M} free</span></div>
      ${zmini?`<div class="res-sub" style="margin-top:5px">${zmini}</div>`:""}
    </div>`;
  }).join("");

  const H0=7, H1=20;
  const heatRows = Object.keys(dayCount).sort().filter(dISO => Object.keys(dayCount[dISO]).some(h => +h >= 7 && +h <= 20)).map(dISO=>{
    const meta = dayMeta[dISO];
    const lp = localParts(zonedWallToUtc(meta.y, meta.m, meta.d, 12, 0, refTz), refTz);
    const counts = dayCount[dISO];
    const maxD = Math.max(0, ...Object.values(counts));
    let strip = "";
    for(let h=H0; h<=H1; h++){ const c=counts[h]||0;
      strip += `<div class="cellh${c>0&&c===maxD?' best':''}" title="${pad(h)}:00 — ${c} free">${c||""}</div>`; }
    return `<div class="av-row"><span class="av-dlabel">${lp.wd} ${lp.day} ${lp.mon}</span><div class="heat">${strip}</div></div>`;
  }).join("");

  return `<div class="panel">
    <h2>${opts.responder?"Where everyone converges":"★ Best converging times"}</h2>
    <p class="note">From <b>${M}</b> ${M===1?"person":"people"} who shared weekly availability. Ranked by how many are free, in <b>${esc(refTz.split("/").pop())}</b>${zonesMulti?" (each zone shown under the time)":""}. Approximate around date boundaries.</p>
    <label style="display:inline-flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink);margin:0 0 13px;cursor:pointer">
      <input type="checkbox" id="convToggleCb" ${appState.convergeAllOnly?"checked":""} style="width:auto;margin:0">
      Show when <b>everyone</b> is free</label>
    ${suggestions || (appState.convergeAllOnly
      ? `<p class="note" style="color:var(--edge)">No single time works for all ${M} who shared availability yet — uncheck to see the closest options.</p>`
      : '<p class="note">No overlapping free time yet.</p>')}
    ${opts.responder ? "" : `<details style="margin-top:14px"><summary class="note" style="cursor:pointer;display:inline-block">Full weekly heatmap (${pad(H0)}:00–${pad(H1)}:00 ${esc(refTz.split("/").pop())})</summary><div style="margin-top:10px">${heatRows}</div></details>`}
  </div>`;
}

export function wireConvergencePanel() {
  const cb = document.getElementById("convToggleCb");
  if(cb) cb.addEventListener("change", (e) => convToggle(e.target));
}

function lcache(k){ try{ const v=localStorage.getItem("czmc:"+k); return v?JSON.parse(v):null; }catch(e){ return null; } }

export function viewResults(){
  if(!state.pollId){
    const known = state.organizerEmail || state.organizer || "";
    return `<div class="panel"><h2><span class="section-num">04 · </span>Results — my polls</h2>
      <p class="note">See the live tally for any poll <b>you</b> published, from any device. Enter the <b>name or email</b> you published with.</p>
      <div class="row">
        <div><label class="fld" for="orgWho">Your name or email</label>
          <input type="text" id="orgWho" aria-label="Your name or email" value="${esc(known)}" placeholder="e.g. Aditya  or  you@email.com"></div>
        <div style="flex:0"><button class="btn" id="loadMyPolls">Show my polls</button></div>
      </div>
      <div id="myPolls" style="margin-top:14px"></div>
      <hr style="border:none;border-top:1px solid var(--line);margin:18px 0">
      <div class="row">
        <div><label class="fld" for="pollIdInput">Or open one poll by link / id</label>
          <input type="text" id="pollIdInput" aria-label="Poll ID" placeholder="pxnxB8uLw  or a full results link"></div>
        <div style="flex:0"><button class="btn ghost" id="openPollId">Open results</button></div>
      </div></div>`;
  }
  const poll = lcache("poll:"+state.pollId) || { slots: state.slots, roster: state.roster.filter(r=>(r.name||"").trim()) };
  const slots = [...(poll.slots||state.slots)];
  const roster = poll.roster || [];
  const votes = state.votes || {};
  const refTz = poll.refTz || state.meta.refTz;

  const { cards, best, total } = rankedTally(slots, votes, refTz, {});

  const isRosterKey = k => !k.startsWith("guest:") && !k.startsWith("c:");
  const respondedRosterKeys = new Set(Object.keys(votes).filter(isRosterKey));
  const respondedNamesLower = new Set(Object.values(votes).map(v => (v.name||"").trim().toLowerCase()));
  const respondedNames = [];
  const awaiting = [];
  roster.forEach(r => {
    if (respondedRosterKeys.has(r.rosterId || r.id) || respondedNamesLower.has((r.name||"").trim().toLowerCase())) {
      respondedNames.push(r.name);
    } else {
      awaiting.push(r.name);
    }
  });
  const guests = Object.entries(votes).filter(([k,v])=>!isRosterKey(k) && !roster.some(r => (r.name||"").trim().toLowerCase() === (v.name||"").trim().toLowerCase())).map(([,v])=>v.name);
  const invited = roster.length;
  const pct = invited ? Math.round(respondedNames.length/invited*100) : 0;

  // Only celebrate a "Leading time" when a slot actually has Yes votes. A slot
  // that merely has the most maybes (0 yes) is NOT a winner.
  const winner = best && best.y>0 ? best : null;
  const hero = winner
    ? `<div class="res-hero"><div class="lead-k">★ Leading time</div>
        <div class="lead-t mono">${winner.lp.wd} ${winner.lp.hh}:${winner.lp.mm} · <span style="font-size:15px;font-weight:500">${winner.lp.day} ${winner.lp.mon} ${esc(refTz.split("/").pop())}</span></div>
        <div class="lead-s">${winner.y} yes${winner.m?` · ${winner.m} maybe`:""}${winner.n?` · ${winner.n} no`:""} — out of ${total} response${total===1?"":"s"}</div></div>`
    : (total>0
        ? `<div class="res-hero empty"><div class="lead-k">${total} response${total===1?"":"s"} so far — no clear winner yet</div>
            <div class="lead-s">No option has a <b>Yes</b> vote yet${best&&best.m?` (best so far: ${best.lp.wd} ${best.lp.hh}:${best.lp.mm} — ${best.m} maybe, ${best.n} no)`:""}. These times may not work — see "Best converging times" below, or add new slots.</div></div>`
        : `<div class="res-hero empty"><div class="lead-k">No responses yet</div>
            <div class="lead-s">Share your invite links (Poll &amp; invite) to start collecting answers.</div></div>`);

  const progress = invited ? `
    <div class="res-prog-wrap">
      <div class="res-prog-lab"><b>${respondedNames.length} of ${invited}</b> invited responded${guests.length?` · <b>${guests.length}</b> guest${guests.length>1?"s":""}`:""}</div>
      <div class="res-prog"><i style="width:${pct}%"></i></div>
    </div>` : "";

  return `
  <div class="panel">
    <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
      <h2><span class="section-num">04 · </span>${esc(poll.title||state.meta.title)} — results</h2>
      <button class="btn ghost" id="refreshResults">Refresh</button>
    </div>
    ${hero}
    ${progress}
    ${slots.length?cards:'<p class="note">No candidate times in this poll.</p>'}
    <p class="note" style="margin-top:6px">Ranked best-first ("Leading" = most yes; maybe counts half). Bars show Yes/Maybe/No of everyone who's responded.${sharedMode?" Auto-refreshes ~5s.":""}</p>
  </div>
  ${awaitingChips(respondedNames, awaiting, guests)}
  ${convergencePanel(poll, votes)}`;
}

export function rankedTally(slots, votes, displayTz, opts){
  opts = opts || {};
  
  // Dedup centralized link votes from roster votes (Deduplicate by name normalisation!)
  const dedupedVotes = {};
  Object.entries(votes || {}).forEach(([key, v]) => {
    // We keep the most recent vote for a normalized name if available.
    const normName = (v.name||"").trim().toLowerCase();
    if(normName) {
      if(!dedupedVotes[normName] || new Date(dedupedVotes[normName].updatedAt || 0) < new Date(v.updatedAt || 0)) {
        dedupedVotes[normName] = v;
      }
    } else {
      dedupedVotes[key] = v;
    }
  });

  const uniqueVotes = Object.values(dedupedVotes);
  const total = uniqueVotes.length;
  const rows = [...(slots||[])].map(s=>{
    let y=0,m=0,n=0;
    uniqueVotes.forEach(v=>{ const r=v.responses && v.responses[s.id];
      if(r==="yes")y++; else if(r==="maybe")m++; else if(r==="no")n++; });
    return { s, y, m, n, resp:y+m+n, score:y*2+m, lp:localParts(new Date(s.utc), displayTz) };
  });
  rows.sort((a,b)=> b.score-a.score || b.y-a.y || a.s.utc.localeCompare(b.s.utc));
  const best = rows.length && rows[0].score>0 ? rows[0] : null;
  const w = x => total ? (x/total*100) : 0;
  const cards = rows.map((r,i)=>{
    const leading = best && r===best && best.y>0;   // only badge a real winner (has Yes votes)
    let sub;
    if(opts.refTz && opts.refTz!==displayTz){
      const rl = localParts(new Date(r.s.utc), opts.refTz);
      sub = `${r.lp.day} ${r.lp.mon} · ${rl.hh}:${rl.mm} ${esc(opts.refTz.split("/").pop())}${r.s.label?" · "+esc(r.s.label):""}`;
    } else {
      sub = `${r.lp.day} ${r.lp.mon} · ${esc(displayTz.split("/").pop())}${r.s.label?" · "+esc(r.s.label):""}`;
    }
    const mine = opts.mine && opts.mine[r.s.id];
    const mineTag = mine ? `<span class="res-mine ${mine}">your answer: ${mine}</span>` : "";
    return `<div class="res-card${leading?" leading":""}">
      <div class="res-top">
        <span class="res-rank">${i+1}</span>
        <div class="res-when"><div class="res-time">${r.lp.wd} ${r.lp.hh}:${r.lp.mm}</div><div class="res-sub">${sub}</div></div>
        ${leading?'<span class="res-badge">★ Leading</span>':""}${mineTag}
      </div>
      <div class="res-bar" title="${r.y} yes, ${r.m} maybe, ${r.n} no of ${total}">
        <div class="seg seg-y" style="width:${w(r.y)}%"></div>
        <div class="seg seg-m" style="width:${w(r.m)}%"></div>
        <div class="seg seg-n" style="width:${w(r.n)}%"></div>
      </div>
      <div class="res-counts"><span class="cy">${r.y} yes</span><span class="cm">${r.m} maybe</span><span class="cn">${r.n} no</span>${total>r.resp?`<span class="cnone">${total-r.resp} no reply</span>`:""}</div>
    </div>`;
  }).join("");
  return { cards, best, total };
}

export function awaitingChips(responded, awaiting, guests){
  if(!responded.length && !awaiting.length && !guests.length) return "";
  const initials = n => {
    const p = String(n||"").trim().split(/\s+/).filter(Boolean);
    return ((p[0]?.[0]||"") + (p[1]?.[0]||"")).toUpperCase() || "?";
  };
  const person = (n, cls) => `<div class="person"><span class="avatar ${cls}" title="${esc(n)}">${esc(initials(n))}</span><span class="pname">${esc(n)}</span></div>`;
  const total = responded.length + awaiting.length;
  return `<div class="panel">
    <h2>Who has responded ${total?`<span class="pill">${responded.length}/${total}</span>`:""}</h2>
    <div class="people">
      ${responded.map(n=>person(n,"done")).join("")}
      ${awaiting.map(n=>person(n,"wait")).join("")}
      ${guests.map(n=>person(n,"guest")).join("")}
    </div>
    <p class="note" style="margin-top:16px">
      <span class="lg"><i class="lg-done"></i> responded</span>
      <span class="lg"><i class="lg-wait"></i> awaiting</span>
      <span class="lg"><i class="lg-guest"></i> guest (not on the invite list)</span></p>
  </div>`;
}

let resultsTimer=null;
export function wireResults(){
  if(resultsTimer){ clearInterval(resultsTimer); resultsTimer=null; }
  wireConvergencePanel();
  if(!state.pollId){
    document.getElementById("loadMyPolls")?.addEventListener("click", ()=>loadMyPollsUI());
    document.getElementById("openPollId")?.addEventListener("click", ()=>{
      const raw=(document.getElementById("pollIdInput")?.value||"").trim();
      const m=raw.match(/poll=([A-Za-z0-9_-]+)/);
      const id=m?m[1]:raw.replace(/[^A-Za-z0-9_-]/g,"");
      if(id) location.hash = "poll="+encodeURIComponent(id)+"&admin";
    });
    if(state.organizer || state.organizerEmail) loadMyPollsUI();
    return;
  }
  document.getElementById("refreshResults")?.addEventListener("click", refreshResults);
  if(sharedMode && state.pollId){
    resultsTimer = setInterval(()=>{ if(appState.view==="results") refreshResults(); else { clearInterval(resultsTimer); resultsTimer=null; } }, 5000);
  }
}

export function renderMyPollsList(cont, pollsObj){
  const polls = pollsObj ? Object.entries(pollsObj) : [];
  if(!polls.length){ cont.innerHTML = `<p class="awaiting">No polls found. Double-check the name/email you published with.</p>`; return; }
  polls.sort((a,b)=>String(b[1].updatedAt||"").localeCompare(String(a[1].updatedAt||"")));
  cont.innerHTML = `<div class="tally-labels" style="margin:0 0 8px">${polls.length} poll${polls.length>1?"s":""}:</div>` +
    polls.map(([id,m])=>`
    <div class="invite-row">
      <span class="who">${esc(m.title||id)}</span>
      <span class="lnk mono" title="${esc(id)}">${esc(id)}</span>
      <a class="btn ghost" href="#poll=${encodeURIComponent(id)}&admin">View results</a>
    </div>`).join("");
}

export async function loadMyPollsUI(forceEmail){
  const cont = document.getElementById("myPolls"); if(!cont) return;
  const who = (document.getElementById("orgWho")?.value||"").trim();
  const value = forceEmail || who;
  if(!value){ cont.innerHTML = `<p class="awaiting">Enter your name or email first.</p>`; return; }
  cont.innerHTML = `<p class="note">Loading your polls…</p>`;
  let r=null;
  try{ r = await doLoadMyPolls(value); }catch(e){ r=null; }
  if(!r){ cont.innerHTML = `<p class="awaiting">Couldn't load — check your connection and try again.</p>`; return; }
  if(r.needEmail){
    cont.innerHTML = `<p class="awaiting" style="color:var(--edge)">More than one organizer used that name. Enter the <b>email</b> you published with:</p>
      <div class="row" style="margin-top:8px">
        <div><input type="text" id="orgEmailDisambig" aria-label="Your email" placeholder="you@email.com"></div>
        <div style="flex:0"><button class="btn" id="orgEmailGo">Show my polls</button></div>
      </div>`;
    document.getElementById("orgEmailGo")?.addEventListener("click", ()=>{
      const em=(document.getElementById("orgEmailDisambig")?.value||"").trim();
      if(em) loadMyPollsUI(em);
    });
    return;
  }
  renderMyPollsList(cont, r.polls);
}

export async function refreshResults(){
  if(!state.pollId) return;
  const fresh = await Store.loadVotes(state.pollId);
  state.votes = Store.mergeVotes(state.pollId, fresh, null);
  if(appState.view==="results") { app().innerHTML = viewResults(); wireResults(); }
}
