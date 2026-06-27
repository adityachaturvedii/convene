import { state, appState, setView, setConvergeAllOnly, currentGap, computeRecommendation, saveMeta, saveZones, saveRoster, saveSlots, indexMyPoll, unindexMyPoll, zoneById, COMMON_TZS } from "./state.js";
import { Store, GHIO, sharedMode, GH, ownerSet, repoSet } from "./github-store.js";
import { esc, uid, randomToken, sha256Hex } from "./utils.js";
import { WD, FULL_WD, zonedWallToUtc, localParts, nearestWeekdayDate, fmtMin, localPartsFull, classify, CLASS_LABEL } from "./tz-engine.js";
import { viewResults, wireResults } from "./ui-results.js";

export const pagesBase = (ownerSet && repoSet)
  ? `https://${GH.owner}.github.io/${GH.repo}/`
  : (location.origin + location.pathname);

export function rootEl(){ return document.getElementById("root"); }
export const app = () => document.getElementById("app");

export function organizerShell(){
  const meta = state.meta || { title: "Cross-zone team sync" };
  rootEl().className = "wrap";
  rootEl().innerHTML = `
  <header class="masthead">
    <div>
      <p class="eyebrow" id="eyebrow">Convene · cross-zone scheduling</p>
      <h1 id="title">${esc(meta.title)}</h1>
      <p class="sub" id="subline">Find the least-cruel common slot. Working hours are shaded per zone; the overlap is where everyone is awake and at work.</p>
    </div>
    <div class="gap-readout">
      <span class="big mono" id="gapBig">—</span>
      <small id="gapLabel">offset today</small>
    </div>
  </header>
  <div id="modebar"></div>
  <nav class="tabs" id="tabs" role="tablist">
    <button class="tab" role="tab" data-view="setup" aria-selected="false">Setup</button>
    <button class="tab" role="tab" data-view="overlap" aria-selected="true">Overlap board</button>
    <button class="tab" role="tab" data-view="recurring" aria-selected="false">Recurring slot</button>
    <button class="tab" role="tab" data-view="poll" aria-selected="false">Poll &amp; invite</button>
    <button class="tab" role="tab" data-view="results" aria-selected="false">Results</button>
  </nav>
  <div id="app"><div class="loading">Loading…</div></div>`;
  document.getElementById("tabs").addEventListener("click", e=>{
    const b=e.target.closest(".tab"); if(b){ setView(b.dataset.view); render(); }
  });
  renderModebar();
}

export function renderModebar(){
  const el = document.getElementById("modebar");
  if(!el) return;
  if(sharedMode){ el.style.display="none"; el.innerHTML=""; el.className="modebar"; return; }
  el.style.display="";
  el.className = "modebar local";
  el.innerHTML = `<span class="dot"></span>Local mode — deploy to GitHub to collect votes from others.`;
}

export function renderHeader(){
  const t = document.getElementById("title"); if(t) t.textContent = state.meta.title;
  const g = currentGap();
  if(g && document.getElementById("gapBig")){
    document.getElementById("gapBig").textContent = (g.hours>0?"+":"")+g.hours+"h";
    document.getElementById("gapLabel").textContent =
      g.a.tz.split("/").pop()+" vs "+g.b.tz.split("/").pop()+" today";
  }
}

export function render(){
  renderHeader();
  if(appState.view==="overlap")   { app().innerHTML = viewOverlap(); wireOverlap(); }
  if(appState.view==="recurring") { app().innerHTML = viewRecurring(); }
  if(appState.view==="poll"){ app().innerHTML = viewPoll(); wirePoll(); }
  if(appState.view==="results"){ app().innerHTML = viewResults(); wireResults(); }
  if(appState.view==="setup"){ app().innerHTML = viewSetup(); wireSetup(); }
  document.querySelectorAll(".tab").forEach(t =>
    t.setAttribute("aria-selected", String(t.dataset.view===appState.view)));
}

function wireOverlap() {
  document.querySelectorAll(".board th, .board td.cell").forEach(cell => {
    if(cell.dataset.hr) {
      cell.addEventListener("click", () => toggleBoardSlot(parseInt(cell.dataset.hr, 10)));
    }
  });
}

export function toggleBoardSlot(h) {
  const refTz = state.meta.refTz, weekday = state.meta.weekday;
  const now = new Date();
  const day = nearestWeekdayDate(now.getUTCFullYear(), now.getUTCMonth()+1, now.getUTCDate(), weekday, refTz);
  const utc = zonedWallToUtc(day.y, day.m, day.d, h, 0, refTz);
  const utcISO = typeof utc === 'string' ? utc : utc.toISOString();
  const existingIdx = state.slots.findIndex(s => Math.abs(Date.parse(s.utc) - Date.parse(utcISO)) < 1000);
  if (existingIdx >= 0) {
    state.slots.splice(existingIdx, 1);
  } else {
    state.slots.push({ id: "s_"+uid(), utc: utcISO, d: state.meta.duration, label: "" });
    state.slots.sort((a,b) => Date.parse(a.utc) - Date.parse(b.utc));
  }
  saveSlots().then(() => render());
}

export function viewOverlap(){
  const refTz = state.meta.refTz, weekday = state.meta.weekday;
  const now = new Date();
  const day = nearestWeekdayDate(now.getUTCFullYear(), now.getUTCMonth()+1, now.getUTCDate(), weekday, refTz);
  const startH=0, endH=24;
  const rec = computeRecommendation(weekday);
  const pinHour = rec ? Math.round(rec.t/60) : -1;
  const nowRefTz = new Intl.DateTimeFormat("en-US", {timeZone: refTz, year: 'numeric', month: '2-digit', day: '2-digit'}).format(now);
  const [nM, nD, nY] = nowRefTz.split("/");
  const isCurrentDay = `${nY}-${nM}-${nD}` === `${day.y}-${String(day.m).padStart(2,'0')}-${String(day.d).padStart(2,'0')}`;
  const currentHourRef = isCurrentDay ? parseInt(new Intl.DateTimeFormat("en-US", {timeZone: refTz, hour: 'numeric', hour12: false}).format(now)) : -1;

  const cols = [];
  for(let h=startH; h<endH; h++){
    const utc = zonedWallToUtc(day.y,day.m,day.d,h,0,refTz);
    const cells = state.zones.map(z=>{
      const lp = localParts(utc,z.tz);
      return { c:classify(lp.min,z), hh:lp.hh, mm:lp.mm };
    });
    const allWork = cells.every(c=>c.c==="work");
    const allOk   = cells.every(c=>c.c!=="off");
    cols.push({h, cells, allWork, allOk});
  }

  let head = `<th class="b-zonecol">Zone</th>`;
  cols.forEach(c => head += `<th data-hr="${c.h}" class="b-hour${c.allOk?" in-work":""}${c.h===currentHourRef?" current-hour":""}" title="Click to toggle slot" style="cursor:pointer">${String(c.h).padStart(2,"0")}</th>`);

  let overlapRow = `<td class="b-zonecol" style="border-bottom:none"></td>`;
  cols.forEach(c => overlapRow += `<td class="${c.allWork?"b-mark-work":(c.allOk?"b-mark-edge":"")}"></td>`);

  let body = "";
  state.zones.forEach((z,zi)=>{
    let row = `<td class="b-zonecol"><div class="zname">${esc(z.label)}</div>
      <div class="ztz mono">${esc(z.tz.split("/").pop())} · ${fmtMin(z.ws)}–${fmtMin(z.we)}</div></td>`;
    cols.forEach(c=>{
      const cell = c.cells[zi];
      const pin = c.h===pinHour ? " pinned" : "";
      const t = cell.mm==="00" ? cell.hh : `${cell.hh}<span class="mm">:${cell.mm}</span>`;
      row += `<td data-hr="${c.h}" class="cell ${cell.c}${pin}${c.h===currentHourRef?" current-hour":""}" title="Click to toggle slot" style="cursor:pointer">${t}</td>`;
    });
    body += `<tr>${row}</tr>`;
  });

  const recTxt = rec ? `Recommended recurring slot sits at <b class="mono">${fmtMin(rec.t)} ${refTz.split("/").pop()}</b> on ${FULL_WD[weekday]} — the ${rec.work}-of-${state.zones.length}-zone best. See the Recurring tab.` : "";

  return `
  <div class="panel">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
      <h2><span class="section-num">01 · </span>Where the day actually overlaps</h2>
      <span class="mono" style="font-size:12px;color:var(--muted)">${WD[weekday]} · columns = ${refTz.split("/").pop()} hours</span>
    </div>
    <p class="note">Each cell shows that zone's local hour. Night hours are dimmed so the
      <b style="color:var(--work)">green</b> overlap — where everyone is at work — stands out;
      <b style="color:var(--edge)">amber (hatched)</b> marks the edge of someone's day.</p>
    <div class="board-scroll">
      <table class="board">
        <thead><tr>${head}</tr></thead>
        <tbody>
          <tr class="b-overlap-row">${overlapRow}</tr>
          ${body}
        </tbody>
      </table>
    </div>
    <div class="pin-flag"><span class="pin-dot"></span>${recTxt}</div>
    <div class="legend">
      <span><i class="sw work"></i> Working hours</span>
      <span><i class="sw edge"></i> Edge of day (early / late)</span>
      <span><i class="sw off"></i> Outside hours / night</span>
    </div>
  </div>`;
}

export function viewRecurring(){
  const refTz = state.meta.refTz, weekday = state.meta.weekday;
  const rec = computeRecommendation(weekday);
  if(!rec) return `<div class="panel"><p class="note">Add at least one zone in Setup.</p></div>`;

  const wallH = Math.floor(rec.t/60), wallM = rec.t%60;
  const stripFor = (utc) => state.zones.map(z=>{
    const lp = localParts(utc,z.tz); const c = classify(lp.min,z);
    return `<div class="chip ${c}"><div class="czone">${esc(z.label)}</div>
      <div class="ctime mono">${lp.wd} ${lp.hh}:${lp.mm}</div>
      <div class="ctag">${CLASS_LABEL[c]}</div></div>`;
  }).join("");

  const now = new Date();
  const sd = nearestWeekdayDate(now.getUTCFullYear(), now.getUTCMonth()+1, now.getUTCDate(), weekday, refTz);
  const summerUtc = zonedWallToUtc(sd.y,sd.m,sd.d,wallH,wallM,refTz);
  const wd2 = nearestWeekdayDate(2026,12,10,weekday,refTz);
  const winterUtc = zonedWallToUtc(wd2.y,wd2.m,wd2.d,wallH,wallM,refTz);

  let drift = [];
  state.zones.forEach(z=>{
    const cs = classify(localParts(summerUtc,z.tz).min,z);
    const cw = classify(localParts(winterUtc,z.tz).min,z);
    if(cs!==cw){
      const lw = localParts(winterUtc,z.tz);
      drift.push(`${z.tz.split("/").pop()} becomes <b class="mono">${lw.hh}:${lw.mm}</b> (${CLASS_LABEL[cw].toLowerCase()})`);
    }
  });
  const driftBanner = drift.length
    ? `<div class="warn"><span class="wicon">!</span><div><b>DST drift.</b> Europe and Australia shift clocks in opposite directions. A fixed wall-clock time rots across the year — by mid-December: ${drift.join("; ")}. Consider re-anchoring the slot each DST season, or pinning to UTC.</div></div>`
    : `<div class="warn ok"><span class="wicon">✓</span><div>This slot holds its comfort profile across the summer/winter DST shift. Safe to set as a standing wall-clock time.</div></div>`;

  return `
  <div class="panel">
    <h2><span class="section-num">02 · </span>Best standing weekly slot</h2>
    <p class="note">Searched 06:00–20:00 ${refTz.split("/").pop()} on ${FULL_WD[weekday]}, scored by how many people land in working hours (night times penalised). Change the day in Setup.</p>
    <div class="rec-headline">
      <span class="rec-time mono">${fmtMin(rec.t)}</span>
      <span class="rec-day">${refTz.split("/").pop()} · every ${FULL_WD[weekday]} · ${state.meta.duration} min</span>
    </div>
    <div class="strip">${stripFor(rec.utc)}</div>
    ${driftBanner}
  </div>`;
}

export function viewPoll(){
  const slots = [...state.slots].sort((a,b)=>a.utc.localeCompare(b.utc));
  const slotCards = slots.map(s=>{
    const utc=new Date(s.utc); const lp=localParts(utc,state.meta.refTz);
    const mini = state.zones.map(z=>{
      const l=localParts(utc,z.tz); const c=classify(l.min,z);
      return `<span class="ministub ${c}">${z.tz.split("/").pop()} ${l.hh}:${l.mm}</span>`;
    }).join("");
    return `
    <div class="slot-row">
      <div class="slot-head">
        <div class="slot-when mono">${lp.wd} ${lp.day} ${lp.mon} · ${lp.hh}:${lp.mm}
          <small>${state.meta.refTz.split("/").pop()}${s.label?" · "+esc(s.label):""}</small></div>
        <button class="link" data-sdel="${s.id}">remove</button>
      </div>
      <div class="minstrip">${mini}</div>
    </div>`;
  }).join("");

  const tzOptions = state.zones.map(z=>
    `<option value="${esc(z.tz)}" ${z.tz===state.meta.refTz?"selected":""}>${esc(z.label)} (${esc(z.tz.split("/").pop())})</option>`).join("");
  const addForm = `
    <div class="row">
      <div><label class="fld" for="newDate">Date</label><input type="date" id="newDate"></div>
      <div><label class="fld" for="newTime">Time</label><input type="time" id="newTime" value="09:00"></div>
      <div><label class="fld" for="newTz">Timezone</label><select id="newTz">${tzOptions}</select></div>
      <div><label class="fld" for="newLabel">Label (optional)</label><input type="text" id="newLabel" placeholder="e.g. backup"></div>
      <div style="flex:0"><button class="btn" id="addSlot">Add slot</button></div>
    </div>`;

  const rosterRows = state.roster.map(r=>`
    <tr>
      <td><input type="text" aria-label="Name" data-redit="name" data-id="${r.id}" value="${esc(r.name)}" placeholder="Name"></td>
      <td><input type="email" aria-label="Email" data-redit="email" data-id="${r.id}" value="${esc(r.email||"")}" placeholder="email (stays local)"></td>
      <td><select aria-label="Timezone" data-redit="zoneId" data-id="${r.id}">${state.zones.map(z=>
        `<option value="${z.id}" ${z.id===r.zoneId?"selected":""}>${esc(z.label)}</option>`).join("")}</select></td>
      <td><button class="link" data-rdel="${r.id}">remove</button></td>
    </tr>`).join("");

  const invitePanel = state.invites ? renderInvitePanel() : "";

  return `
  <div class="panel">
    <h2><span class="section-num">03 · </span>Meeting &amp; candidate slots</h2>
    <p class="note">Set the title and the times you want to offer. Pick the timezone you're
      entering each time in — it converts for everyone automatically.</p>
    <div class="row" style="margin-bottom:14px">
      <div><label class="fld" for="pollTitle">Meeting title</label><input type="text" id="pollTitle" value="${esc(state.meta.title)}"></div>
      <div><label class="fld" for="orgName">Organizer name</label><input type="text" id="orgName" value="${esc(state.organizer)}" placeholder="e.g. Aditya"></div>
      <div><label class="fld" for="orgEmail">Organizer email (optional)</label><input type="text" id="orgEmail" value="${esc(state.organizerEmail||"")}" placeholder="to find your polls later"></div>
    </div>
    <p class="storage-note" style="margin-top:-6px;margin-bottom:14px">Your name (and email, if you add one) let you find this poll's results on any device via <b>Results → My polls</b>. Email is stored only as a private hash.</p>
    ${slots.length?slotCards:'<p class="note">No slots yet — add one below.</p>'}
    ${addForm}
  </div>

  <div class="panel">
    <h2>Invitees <span class="pill">${state.roster.length} people</span></h2>
    <p class="note">Name + email per person. <b>Emails stay in this browser only</b> — they are never
      written into poll.json or any GitHub request. Each person gets a private invite link.</p>
    <table class="list"><thead><tr style="font-size:11px;color:var(--muted)">
      <td>Name</td><td>Email (local only)</td><td>Zone</td><td></td></tr></thead>
      <tbody>${rosterRows}</tbody></table>
    <div style="margin-top:12px"><button class="btn ghost" id="addPerson">+ Add person</button></div>
  </div>

  <div class="panel">
    <h2>Publish &amp; invite links</h2>
    <p class="note">${sharedMode
      ? "Publishing generates a poll id and a private token per person, then commits poll.json straight to the poll-data branch (~1-2s). Share each per-person link, or the one central link, with people."
      : "Local mode: publishing generates the poll + invite links locally so you can preview them. Deploy to GitHub to collect real votes."}</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="btn" id="publishPoll">${state.invites?"Re-publish poll":"Create / publish poll"}</button>
      ${state.invites?`<button class="btn danger" id="deletePoll">Delete this poll + all its data</button>`:""}
      <span id="publishState" class="storage-note" aria-live="polite"></span>
    </div>
    ${invitePanel}
  </div>`;
}

export function renderInvitePanel(){
  const inv = state.invites;
  const rows = inv.links.map(l=>`
    <div class="invite-row">
      <span class="who">${esc(l.name)}</span>
      <span class="lnk" title="${esc(l.url)}">${esc(l.url)}</span>
      <button class="btn ghost" data-copyone="${esc(l.url)}">Copy</button>
    </div>`).join("");
  const centralUrl = inv.centralUrl || (`${pagesBase}#poll=${encodeURIComponent(inv.pollId)}`);
  const centralRow = `
    <div class="invite-row" style="border-color:var(--accent);background:var(--accent-bg)">
      <span class="who">Central link (anyone)</span>
      <span class="lnk" title="${esc(centralUrl)}">${esc(centralUrl)}</span>
      <button class="btn ghost" data-copyone="${esc(centralUrl)}" id="copyCentral">Copy central link</button>
    </div>`;
  const adminUrl = `${pagesBase}#poll=${encodeURIComponent(inv.pollId)}&admin`;
  const adminRow = `
    <div class="invite-row" style="border-color:var(--work);background:var(--work-bg)">
      <span class="who">Results (you — any device)</span>
      <span class="lnk" title="${esc(adminUrl)}">${esc(adminUrl)}</span>
      <button class="btn ghost" data-copyone="${esc(adminUrl)}">Copy results link</button>
    </div>`;
  return `
  <div class="invite-list">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
      <span class="pill">poll ${esc(inv.pollId)}</span>
      <button class="btn ghost" id="copyAll">Copy all invite links</button>
    </div>
    ${adminRow}
    ${centralRow}
    ${rows}
    <p class="storage-note" style="margin-top:8px">📊 To see results on another device: open <b>Results → My polls</b> and enter your organizer ${state.organizerEmail?`<b>name or email</b> (${esc(state.organizer)} / ${esc(state.organizerEmail)})`:`<b>name</b> (${esc(state.organizer||"set it above")})`}.</p>
    <p class="storage-note" style="margin-top:8px">Each per-person link contains a one-time private token. Anyone with a person's link can answer as that person, so send those individually. The <b>central link</b> is safe to forward to anyone — it asks each responder for their name + email (the email is stored only as a private hash, never shown).</p>
  </div>`;
}

export function wirePoll(){
  const titleEl=document.getElementById("pollTitle");
  if(titleEl) titleEl.addEventListener("change", async e=>{
    state.meta.title=e.target.value.trim()||"Cross-zone team sync"; await saveMeta(); renderHeader();
  });
  const orgEl=document.getElementById("orgName");
  if(orgEl) orgEl.addEventListener("change", async e=>{
    state.organizer=e.target.value.trim(); await Store.set("organizer", state.organizer);
  });
  const orgEmailEl=document.getElementById("orgEmail");
  if(orgEmailEl) orgEmailEl.addEventListener("change", async e=>{
    state.organizerEmail=e.target.value.trim(); await Store.set("organizerEmail", state.organizerEmail);
  });

  document.getElementById("addSlot")?.addEventListener("click", async ()=>{
    const d=document.getElementById("newDate").value, t=document.getElementById("newTime").value;
    if(!d||!t){ alert("Pick a date and time."); return; }
    const [y,mo,da]=d.split("-").map(Number); const [h,mi]=t.split(":").map(Number);
    const tz=document.getElementById("newTz")?.value || state.meta.refTz;   // enter in the chosen zone
    const utc=zonedWallToUtc(y,mo,da,h,mi,tz);
    state.slots.push({id:"s_"+uid(), utc:utc.toISOString(), label:document.getElementById("newLabel").value.trim()});
    await saveSlots(); render();
  });
  document.querySelectorAll("[data-sdel]").forEach(b=>b.addEventListener("click", async()=>{
    state.slots=state.slots.filter(s=>s.id!==b.dataset.sdel); await saveSlots(); render();
  }));

  document.querySelectorAll("[data-redit]").forEach(el=>el.addEventListener("change", async e=>{
    const r=state.roster.find(x=>x.id===el.dataset.id); if(r){ r[el.dataset.redit]=e.target.value; await saveRoster(); }
  }));
  document.querySelectorAll("[data-rdel]").forEach(b=>b.addEventListener("click", async()=>{
    state.roster=state.roster.filter(r=>r.id!==b.dataset.rdel); await saveRoster(); render();
  }));
  document.getElementById("addPerson")?.addEventListener("click", async()=>{
    state.roster.push({id:"r_"+uid(),name:"",zoneId:state.zones[0].id,email:""}); await saveRoster(); render();
  });

  document.getElementById("publishPoll")?.addEventListener("click", publishPoll);
  document.getElementById("deletePoll")?.addEventListener("click", deleteCurrentPoll);

  document.getElementById("copyAll")?.addEventListener("click", ()=>{
    const text = state.invites.links.map(l=>`${l.name}: ${l.url}`).join("\n");
    copyToClipboard(text, document.getElementById("copyAll"));
  });
  document.querySelectorAll("[data-copyone]").forEach(b=>b.addEventListener("click", ()=>{
    copyToClipboard(b.dataset.copyone, b);
  }));
}

export function copyToClipboard(text, btn){
  const done=()=>{ if(btn){ const o=btn.textContent; btn.textContent="Copied ✓"; setTimeout(()=>btn.textContent=o,1400); } };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done, ()=>fallbackCopy(text,done));
  } else fallbackCopy(text,done);
}
export function fallbackCopy(text, done){
  const ta=document.createElement("textarea"); ta.value=text; ta.style.position="fixed"; ta.style.opacity="0";
  document.body.appendChild(ta); ta.select(); try{ document.execCommand("copy"); done&&done(); }catch(e){}
  document.body.removeChild(ta);
}

export async function publishPoll(){
  const stateEl = document.getElementById("publishState");
  const named = state.roster.filter(r=>(r.name||"").trim());
  if(!named.length){ if(stateEl) stateEl.textContent="Add at least one named invitee first."; return; }
  if(!state.slots.length){ if(stateEl) stateEl.textContent="Add at least one candidate slot first."; return; }
  if(stateEl) stateEl.textContent="Publishing…";

  const pollId = state.pollId || ("p"+randomToken(8));
  state.pollId = pollId;

  const existingTok = {};
  if(state.invites && Array.isArray(state.invites.links))
    for(const lk of state.invites.links) existingTok[lk.rosterId] = lk.token;
  const rosterOut = [];
  const links = [];
  for(const r of named){
    const token = existingTok[r.id] || randomToken(22);
    const tokenHash = await sha256Hex(token);
    rosterOut.push({ rosterId:r.id, name:r.name.trim(), zoneId:r.zoneId, tokenHash });
    const url = `${pagesBase}#poll=${encodeURIComponent(pollId)}&who=${encodeURIComponent(r.id)}&t=${encodeURIComponent(token)}`;
    links.push({ rosterId:r.id, name:r.name.trim(), token, url });
  }

  const poll = {
    id: pollId,
    title: state.meta.title,
    meetingDateISO: state.slots.map(s=>s.utc).sort()[0],
    refTz: state.meta.refTz, weekday: state.meta.weekday, duration: state.meta.duration,
    zones: state.zones.map(z=>({id:z.id,label:z.label,tz:z.tz,ws:z.ws,we:z.we})),
    roster: rosterOut,
    slots: state.slots.map(s=>({id:s.id,utc:s.utc,label:s.label||""}))
  };

  const res = await Store.savePoll(poll);
  const centralUrl = `${pagesBase}#poll=${encodeURIComponent(pollId)}`;
  state.invites = { pollId, links, centralUrl };
  await Store.set("currentPollId", pollId);
  await Store.set("invites:"+pollId, state.invites);
  await indexMyPoll(pollId, poll.title, poll.meetingDateISO, state.organizer, state.organizerEmail);

  if(stateEl){
    stateEl.textContent = sharedMode
      ? (res.ok ? "Published ✓ — committed to the poll-data branch. Links are live now."
                : "Couldn't commit poll.json (HTTP "+(res.status||"?")+"). Check the token/repo; links generated locally.")
      : "Generated locally (local mode — not sent to GitHub).";
  }
  render();
}

export async function deleteCurrentPoll(){
  if(!state.pollId) return;
  if(!confirm("Delete this poll and all its votes? This deletes poll.json + votes.json from the poll-data branch and clears local copies.")) return;
  const pid = state.pollId;
  await Store.deletePoll(pid);
  try{ await unindexMyPoll(pid, state.organizer, state.organizerEmail); }catch(e){}
  await Store.del("invites:"+pid);
  await Store.del("currentPollId");
  state.pollId=null; state.invites=null; state.votes={};
  render();
}

export function viewSetup(){
  const tzOpt = (sel)=>COMMON_TZS.map(t=>`<option value="${t}" ${t===sel?"selected":""}>${t}</option>`).join("");
  const zoneRows = state.zones.map(z=>`
    <tr>
      <td><input type="text" aria-label="Zone Label" data-zedit="label" data-id="${z.id}" value="${esc(z.label)}" style="min-width:160px"></td>
      <td><select aria-label="Timezone" data-zedit="tz" data-id="${z.id}">${tzOpt(z.tz)}</select></td>
      <td><input type="time" aria-label="Work Start" data-zedit="ws" data-id="${z.id}" value="${fmtMin(z.ws)}" style="width:108px"></td>
      <td><input type="time" aria-label="Work End" data-zedit="we" data-id="${z.id}" value="${fmtMin(z.we)}" style="width:108px"></td>
      <td><button class="link" data-zdel="${z.id}">remove</button></td>
    </tr>`).join("");

  return `
  <div class="panel">
    <h2>Meeting</h2>
    <div class="row">
      <div><label class="fld" for="setTitle">Title</label><input type="text" id="setTitle" value="${esc(state.meta.title)}"></div>
      <div><label class="fld" for="setRef">Reference zone</label><select id="setRef">${tzOpt(state.meta.refTz)}</select></div>
      <div><label class="fld" for="setWd">Cadence day</label><select id="setWd">${WD.map((w,i)=>
        `<option value="${i}" ${i===state.meta.weekday?"selected":""}>${w}day</option>`).join("")}</select></div>
      <div><label class="fld" for="setDur">Duration (min)</label><input type="number" id="setDur" value="${state.meta.duration}" min="15" step="15"></div>
    </div>
  </div>

  <div class="panel">
    <h2>Zones &amp; working hours</h2>
    <p class="note">Working hours drive every comfort colour. Tighten them per zone if a team won't take 18:00 calls.</p>
    <table class="list"><thead><tr style="font-size:11px;color:var(--muted)">
      <td>Label</td><td>Timezone</td><td>Work start</td><td>Work end</td><td></td></tr></thead>
      <tbody>${zoneRows}</tbody></table>
    <div style="margin-top:12px"><button class="btn ghost" id="addZone">+ Add zone</button></div>
  </div>

  ${sharedMode ? "" : `<div class="panel">
    <h2>Data &amp; mode</h2>
    <p class="storage-note">Local mode — no GitHub token injected, so nothing leaves this browser. Everything is stored in localStorage. Deploy to GitHub (inject the dispatch token) to collect votes from others.</p>
    <div style="margin-top:12px"><button class="btn danger" id="resetAll">Reset local setup data</button></div>
  </div>`}`;
}

export function wireSetup(){
  const bind=(id,key,fn)=>{const el=document.getElementById(id); if(el) el.addEventListener("change",async e=>{
    state.meta[key]=fn?fn(e.target.value):e.target.value; await saveMeta(); renderHeader();
    if(key==="weekday"||key==="refTz") render();
  });};
  bind("setTitle","title"); bind("setRef","refTz");
  bind("setWd","weekday",v=>parseInt(v,10)); bind("setDur","duration",v=>parseInt(v,10)||60);

  document.querySelectorAll("[data-zedit]").forEach(el=>el.addEventListener("change",async e=>{
    const z=zoneById(el.dataset.id); const k=el.dataset.zedit; let v=e.target.value;
    if(k==="ws"||k==="we"){const[h,m]=v.split(":").map(Number); v=h*60+m;}
    z[k]=v; await saveZones(); render();
  }));
  document.querySelectorAll("[data-zdel]").forEach(b=>b.addEventListener("click",async()=>{
    if(state.zones.length<=1){alert("Keep at least one zone.");return;}
    state.zones=state.zones.filter(z=>z.id!==b.dataset.zdel); await saveZones(); render();
  }));
  document.getElementById("addZone")?.addEventListener("click",async()=>{
    state.zones.push({id:"z_"+uid(),label:"New zone",tz:"UTC",ws:9*60,we:17*60}); await saveZones(); render();
  });
  document.getElementById("resetAll")?.addEventListener("click",async()=>{
    if(!confirm("Reset local meeting/zone/roster/slot setup to defaults? (Published GitHub poll data is not touched.)")) return;
    for(const k of ["meta","zones","roster","slots","organizer"]) await Store.del(k);
    location.reload();
  });
}
