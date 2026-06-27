import { state, appState, detectTz } from "./state.js";
import { Store, sharedMode } from "./github-store.js";
import { esc, sha256Hex, isValidEmail } from "./utils.js";
import { localPartsFull, refWeekday, zonedWallToUtc, localParts, classify, CLASS_LABEL } from "./tz-engine.js";
import { rootEl } from "./ui-components.js";
import { convergencePanel, rankedTally } from "./ui-results.js";

export const Responder = (() => {
  let poll=null, pollId=null, rawToken=null, rosterId=null;
  let me=null;
  let myZoneTz=null;
  let pollTimer=null;
  let dashTimer=null;
  let saving=false;
  let submitted=false;
  let showAvail=false;
  let availNeedsScroll=false;   // grid is wider than its container (hours off-screen)
  let availScrollAcked=false;   // user has scrolled ~3 hours (or to the end)

  function emailLSKey(){ return "myemail:"+pollId; }

  async function start(h){
    pollId = h.poll;
    rawToken = h.t || sessionStorage.getItem("czmc_t_"+pollId) || null;
    rosterId = h.who || sessionStorage.getItem("czmc_who_"+pollId) || null;

    if(rawToken) sessionStorage.setItem("czmc_t_"+pollId, rawToken);
    if(rosterId) sessionStorage.setItem("czmc_who_"+pollId, rosterId);

    showAvail = false;
    submitted = false;
    availScrollAcked = false;

    try{
      const clean = location.pathname + location.search + (pollId?("#poll="+encodeURIComponent(pollId)):"");
      history.replaceState(null, "", clean);
    }catch(e){}

    rootEl().className = "wrap narrow";
    rootEl().innerHTML = `<div class="loading">Loading invitation…</div>`;

    poll = await Store.loadPoll(pollId);
    if(!poll){
      rootEl().innerHTML = `
        <div class="panel"><h2>Invitation not found</h2>
        <p class="note">This poll hasn't synced yet, or the link is wrong. If you just received it, wait a moment and reload.</p>
        <button class="btn ghost" onclick="location.reload()">Reload</button></div>`;
      return;
    }

    const rosterEntry = rosterId ? (poll.roster||[]).find(r=>r.rosterId===rosterId) : null;
    const verified = !!(rosterEntry && rawToken);

    const detected = detectTz();
    let matchedZone = (poll.zones||[]).find(z=>z.tz===detected);
    const defaultZoneId = matchedZone ? matchedZone.id
      : (rosterEntry ? rosterEntry.zoneId : (poll.zones?.[0]?.id));

    const localKey = verified ? rosterEntry.rosterId : null;
    const cache = lcache("votes:"+pollId) || {};
    const prior = localKey ? cache[localKey] : null;

    const priorEmail = lcache(emailLSKey()) || "";

    me = {
      name: rosterEntry ? rosterEntry.name : (prior?.name || ""),
      email: priorEmail,
      zoneId: prior?.zoneId || defaultZoneId,
      responses: prior?.responses ? {...prior.responses} : {},
      availability: prior?.availability ? {...prior.availability} : null,
      guest: !verified,
      viaCentral: !verified
    };

    render();
    startPolling();
  }

  function myZone(){
    return (poll.zones||[]).find(z=>z.id===me.zoneId) || poll.zones?.[0];
  }

  function availabilityDays(){
    const refTz = poll.refTz;
    const slots = (poll.slots||[]);
    const earliest = (slots.map(s=>s.utc).sort()[0]) || poll.meetingDateISO;
    if(!earliest) return [];
    // Start at the proposed meeting date and collect the next 8 WORKING days
    // (Mon–Fri in the reference zone; Saturdays & Sundays skipped).
    const lp = localPartsFull(new Date(earliest), refTz);
    const days = [];
    for(let offset=0; days.length<8 && offset<40; offset++){
      const dt = new Date(Date.UTC(lp.y, lp.m-1, lp.d + offset));
      const y=dt.getUTCFullYear(), m=dt.getUTCMonth()+1, d=dt.getUTCDate();
      const wd = refWeekday(y, m, d, refTz);          // 0=Sun … 6=Sat
      if(wd === 0 || wd === 6) continue;              // skip weekends
      const noonUtc = zonedWallToUtc(y, m, d, 12, 0, refTz);
      const dlp = localParts(noonUtc, refTz);
      days.push({
        iso: `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`,
        y, m, d, label:`${dlp.wd} ${dlp.day} ${dlp.mon}`
      });
    }
    return days;
  }

  const AVAIL_H_START = 7, AVAIL_H_END = 20;

  function availabilityGridHtml(){
    const days = availabilityDays();
    if(!days.length) return "";
    const tz = myZoneTz;
    me.availability = me.availability || {};
    let head = `<th class="av-daycol">Day (${esc(tz.split("/").pop())})</th>`;
    for(let h=AVAIL_H_START; h<=AVAIL_H_END; h++) head += `<th class="av-hr">${String(h).padStart(2,"0")}</th>`;
    let body = "";
    days.forEach(day=>{
      const free = new Set(me.availability[day.iso] || []);
      let row = `<td class="av-daycol">${esc(day.label)}</td>`;
      for(let h=AVAIL_H_START; h<=AVAIL_H_END; h++){
        const on = free.has(h);
        row += `<td class="av-cell ${on?'av-free':'av-busy'}" data-avday="${day.iso}" data-avh="${h}"
          role="button" tabindex="0" aria-pressed="${on}">${on?'✓':''}</td>`;
      }
      body += `<tr>${row}</tr>`;
    });
    return `
      <div class="panel" id="availPanel">
        <h2>When are you free this week? <span style="color:var(--off);font-weight:600">(required)</span></h2>
        <p class="note">Tap every hour you're free (your local time, ${esc(tz.split("/").pop())}) — this is required so
          the organizer can find a time that works for everyone. Empty = busy; <b>✓ green = free</b>.</p>
        <div class="av-scrollnudge" id="avNudge" style="display:none"></div>
        <div class="av-scroll" id="avScroll" tabindex="0">
          <table class="avgrid">
            <thead><tr>${head}</tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        <p class="storage-note" style="margin-top:8px">Free = ✓ filled green · Busy = empty. Stored per day as the hours you marked free.</p>
      </div>`;
  }

  function allNo(){
    const slots = (poll.slots||[]);
    if(!slots.length) return false;
    return slots.every(s => (me.responses||{})[s.id] === "no");
  }

  function render(){
    if(submitted){ renderDashboard(); return; }
    const z = myZone(); myZoneTz = z?.tz || detectTz();
    const slots = [...(poll.slots||[])].sort((a,b)=>a.utc.localeCompare(b.utc));
    const rosterEntry = rosterId ? (poll.roster||[]).find(r=>r.rosterId===rosterId) : null;
    const verified = !!(rosterEntry && rawToken);

    let identHtml;
    if(verified){
      identHtml = `
        <p class="who-line">Responding as <b>${esc(me.name)}</b>
          — <button class="link" id="switchWho">not you? switch</button></p>`;
    } else if((poll.roster||[]).length){
      const opts = (poll.roster||[]).map(r=>`<option value="${esc(r.rosterId)}" ${me.rosterPick===r.rosterId?"selected":""}>${esc(r.name)}</option>`).join("");
      identHtml = `
        <label class="fld" for="pickWho">Who are you?</label>
        <select id="pickWho">
          <option value="">— choose your name —</option>
          ${opts}
          <option value="__guest__" ${me.guest&&me.name?"selected":""}>I'm not on the list (guest)</option>
        </select>
        <div id="guestNameWrap" style="margin-top:10px">
          <label class="fld" for="guestName">Your name</label>
          <input type="text" id="guestName" value="${esc(me.name||'')}" placeholder="Type your name">
        </div>`;
    } else {
      identHtml = `
        <label class="fld" for="guestName">Your name</label>
        <input type="text" id="guestName" value="${esc(me.name)}" placeholder="Type your name">`;
    }

    let emailHtml = "";
    if(me.viaCentral){
      const emailVal = esc(me.email||"");
      const bad = (me.email||"").trim() && !isValidEmail(me.email);
      emailHtml = `
        <label class="fld" style="margin-top:12px" for="respEmail">Email <span style="color:var(--off)">(required)</span></label>
        <input type="email" id="respEmail" value="${emailVal}" placeholder="you@example.com" autocomplete="email">
        ${bad?`<div class="email-err" id="emailErr">Enter a valid email to continue.</div>`:`<div class="email-err hide" id="emailErr"></div>`}
        <div class="central-notice">Your name is shared with the organizer; your email is stored only as a private hash and is never shown to anyone.</div>`;
    }

    const slotHtml = slots.map(s=>{
      const utc=new Date(s.utc);
      const myLp = localParts(utc, myZoneTz);
      const myC = classify(myLp.min, myZone() || {ws:9*60,we:17*60});
      const refLp = localParts(utc, poll.refTz);
      const resp = me.responses?.[s.id] || null;
      const seg = ["yes","maybe","no"].map(opt=>{
        const labels={yes:"Yes",maybe:"Maybe",no:"No"};
        return `<button data-slot="${s.id}" data-resp="${opt}" aria-pressed="${resp===opt?"true":"false"}" ${resp===opt?`data-on="${opt}"`:""}>${labels[opt]}</button>`;
      }).join("");
      return `
      <div class="resp-slot">
        <div>
          <span class="resp-mytime mono">${myLp.wd} ${myLp.hh}:${myLp.mm}</span>
          <span class="resp-comfort ${myC}">${CLASS_LABEL[myC]}</span>
        </div>
        <div class="resp-reftime">${refLp.wd} ${refLp.day} ${refLp.mon} · <b class="mono">${refLp.hh}:${refLp.mm}</b>
          ${esc(poll.refTz.split("/").pop())}${s.label?" · "+esc(s.label):""}</div>
        <div class="resp-seg">${seg}</div>
      </div>`;
    }).join("");

    const zoneSel = `
      <label class="fld" style="margin-top:14px" for="respZone">Your timezone (auto-detected: ${esc(detectTz())})</label>
      <select id="respZone">${(poll.zones||[]).map(z=>
        `<option value="${z.id}" ${z.id===me.zoneId?"selected":""}>${esc(z.label)}</option>`).join("")}</select>`;

    // Weekly availability is REQUIRED for everyone (helps find a better time if these
    // slots don't work). Always shown; validated on save.
    const availLink = `<p class="note" style="margin-top:14px;color:var(--off)"><b>Required:</b> also mark when you're free this week ⬇</p>`;
    const availHtml = availabilityGridHtml();

    const trustLine = me.viaCentral
      ? `Who can see this: your <b>name</b> and your Yes/Maybe/No answers are committed to a public GitHub branch for this poll. Your <b>email is stored only as a private hash</b> (never the address, never shown). ${sharedMode?"":"(Local preview — nothing is sent anywhere.)"}`
      : `Who can see this: your name and your Yes/Maybe/No answers are committed to a public GitHub branch for this poll, visible to anyone with the repo link. No email is collected for token links. ${sharedMode?"":"(Local preview — nothing is sent anywhere.)"}`;

    rootEl().innerHTML = `
    <header class="masthead">
      <div>
        <p class="eyebrow">You're invited</p>
        <h1>${esc(poll.title||"Meeting time")}</h1>
        <p class="sub">You've been invited to help find a time that works. Pick Yes / Maybe / No for each option below — times are shown in your own zone first.</p>
      </div>
    </header>
    <div class="panel">
      ${identHtml}
      ${emailHtml}
      ${zoneSel}
    </div>
    <div class="panel">
      <h2>Which of these work for you?</h2>
      ${slots.length?slotHtml:'<p class="note">No candidate times in this poll.</p>'}
      ${availLink}
    </div>
    ${availHtml}
    <div class="panel">
      <div class="savebar">
        <button class="btn" id="saveVote" style="width:100%">Save my answers</button>
        <div id="saveState" class="save-state" aria-live="polite"></div>
      </div>
      <p class="trust">${trustLine}</p>
    </div>`;

    wire(slots);
  }

  function wire(slots){
    document.getElementById("switchWho")?.addEventListener("click", ()=>{
      rosterId=null; rawToken=null;
      me.guest=true; me.viaCentral=true; me.name=""; me.rosterPick=null;
      render();
    });

    const pickWho=document.getElementById("pickWho");
    if(pickWho) pickWho.addEventListener("change", e=>{
      const v=e.target.value;
      me.viaCentral=true; rawToken=null;
      if(v==="__guest__"){ me.guest=true; me.name=""; me.rosterPick=null; rosterId=null; }
      else if(v){
        const r=(poll.roster||[]).find(x=>x.rosterId===v);
        me.guest=true; me.rosterPick=v; rosterId=v;
        me.name=r?r.name:"";
      } else { me.rosterPick=null; me.name=""; }
      render();
    });
    document.getElementById("guestName")?.addEventListener("input", e=>{ me.name=e.target.value; });

    const emailEl=document.getElementById("respEmail");
    if(emailEl) emailEl.addEventListener("input", e=>{
      me.email=e.target.value;
      Store.set(emailLSKey(), me.email);
      const err=document.getElementById("emailErr");
      if(err){
        const bad=me.email.trim() && !isValidEmail(me.email);
        err.textContent = bad ? "Enter a valid email to continue." : "";
        err.classList.toggle("hide", !bad);
      }
    });

    document.getElementById("respZone")?.addEventListener("change", e=>{ me.zoneId=e.target.value; render(); });

    document.querySelectorAll(".resp-seg button").forEach(b=>{
      b.addEventListener("click", ()=>{
        const sid=b.dataset.slot, r=b.dataset.resp;
        me.responses=me.responses||{};
        me.responses[sid] = (me.responses[sid]===r)? null : r;
        if(!me.responses[sid]) delete me.responses[sid];
        render();
      });
    });

    function toggleAvail(td){
      const iso=td.dataset.avday, h=parseInt(td.dataset.avh,10);
      me.availability=me.availability||{};
      const set=new Set(me.availability[iso]||[]);
      if(set.has(h)) set.delete(h); else set.add(h);
      me.availability[iso] = [...set].sort((a,b)=>a-b);
      if(!me.availability[iso].length) delete me.availability[iso];
      const on=set.has(h);
      td.className = "av-cell "+(on?"av-free":"av-busy");
      td.textContent = on?"✓":"";
      td.setAttribute("aria-pressed", String(on));
    }
    document.querySelectorAll(".av-cell").forEach(td=>{
      td.addEventListener("click", ()=>toggleAvail(td));
      td.addEventListener("keydown", e=>{
        if(e.key===" "||e.key==="Enter"){ e.preventDefault(); toggleAvail(td); }
      });
    });

    document.getElementById("saveVote")?.addEventListener("click", save);
    setupAvailScroll();
  }

  // Detect whether the availability grid has hours off-screen and nudge the user to
  // scroll. "Acknowledged" once they've scrolled ~3 hours (or reached the end).
  function setupAvailScroll(){
    const el = document.getElementById("avScroll");
    const nudge = document.getElementById("avNudge");
    if(!el) return;
    function update(){
      const ms = el.scrollWidth - el.clientWidth;          // px that can be scrolled
      availNeedsScroll = ms > 4;
      const ackThreshold = Math.min(132, ms);              // ~3 hours, or to the end if narrower
      const sl = el.scrollLeft;
      el.classList.toggle("needscroll", availNeedsScroll && sl < ms-2);
      if(!availNeedsScroll || sl >= ackThreshold) availScrollAcked = true;
      if(!nudge) return;
      if(!availNeedsScroll){ nudge.style.display="none"; return; }
      nudge.style.display = "flex";
      if(availScrollAcked){
        nudge.className = "av-scrollnudge done";
        nudge.textContent = "✓ Good — now mark every hour you're free across all days.";
      } else {
        nudge.className = "av-scrollnudge";
        nudge.innerHTML = '<span class="arr">→</span> More hours are off-screen — <b>scroll the grid sideways</b> to see &amp; mark them all.';
      }
    }
    el.addEventListener("scroll", update, { passive:true });
    window.addEventListener("resize", update, { passive:true });
    update();
    requestAnimationFrame(update);   // re-measure after layout settles
  }

  function isVerified(){ return !!(rosterId && rawToken && !me.viaCentral); }

  let cachedCentralKey=null, cachedCentralEmail=null;
  async function voterKeyForMe(){
    if(isVerified()) return rosterId;
    const norm=(me.email||"").trim().toLowerCase();
    if(cachedCentralKey && cachedCentralEmail===norm) return cachedCentralKey;
    const h=await sha256Hex(norm);
    cachedCentralKey="c:"+h.slice(0,16); cachedCentralEmail=norm;
    return cachedCentralKey;
  }

  async function save(){
    if(saving) return;
    const name=(me.name||"").trim();
    if(!name){ setState("err","Add your name first so your answer is attributed.");
      document.getElementById("guestName")?.focus(); return; }
    if(me.viaCentral && !isValidEmail(me.email)){
      setState("err","Enter a valid email to vote — it's stored only as a private hash, never shown.");
      document.getElementById("respEmail")?.focus();
      const err=document.getElementById("emailErr"); if(err){ err.textContent="Enter a valid email to continue."; err.classList.remove("hide"); }
      return;
    }
    if(!Object.keys(me.responses||{}).length){ setState("err","Pick Yes / Maybe / No on at least one option."); return; }
    const availCount = Object.values(me.availability||{}).reduce((n,a)=>n+(Array.isArray(a)?a.length:0),0);
    if(!availCount){
      setState("err","Please mark when you're free this week — it's required. Tap the green hours below.");
      document.getElementById("availPanel")?.scrollIntoView({behavior:"smooth",block:"center"});
      return;
    }
    // Nudge once if there are hours off-screen the user never scrolled to.
    if(availNeedsScroll && !availScrollAcked){
      setState("err","There are more hours to the right — scroll the availability grid across so you don't miss any free times.");
      const sc=document.getElementById("avScroll");
      sc?.scrollIntoView({behavior:"smooth",block:"center"});
      const n=document.getElementById("avNudge"); if(n){ n.style.outline="2px solid var(--accent)"; setTimeout(()=>{ if(n) n.style.outline=""; },1200); }
      return;
    }

    saving=true; setState("", "Saving…"); document.getElementById("saveVote").disabled=true;

    const verified = isVerified();
    const nowISO = new Date().toISOString();
    let voterKey, entry;

    if(verified){
      voterKey = rosterId;
      entry = {
        name, zoneId: me.zoneId, tz: myZoneTz,
        responses: { ...me.responses }, guest:false,
        updatedAt: nowISO
      };
    }else{
      const emailHash = await sha256Hex((me.email||"").trim().toLowerCase());
      voterKey = "c:"+emailHash.slice(0,16);
      entry = {
        name, zoneId: me.zoneId, tz: myZoneTz,
        responses: { ...me.responses },
        guest:true, viaCentral:true,
        emailHash,
        updatedAt: nowISO
      };
    }
    if(me.availability && Object.keys(me.availability).length){
      entry.availability = me.availability;
    }

    let res;
    try{ res = await Store.castVote({ pollId, voterKey, entry }); }
    catch(e){ res = { ok:false, error:e }; }

    document.getElementById("saveVote").disabled=false;
    saving=false;

    if(!sharedMode){
      submitted=true; if(pollTimer){clearInterval(pollTimer);pollTimer=null;} render(); return;
    }
    if(res && res.ok){
      submitted=true; if(pollTimer){clearInterval(pollTimer);pollTimer=null;} render();
    } else {
      setState("err","Couldn't save — your picks are kept. Tap “Save my answers” to retry."
        + (res&&res.status?` (HTTP ${res.status})`:""));
    }
  }

  function setState(kind, msg){
    const el=document.getElementById("saveState"); if(!el) return;
    el.className="save-state"+(kind?" "+kind:""); el.textContent=msg;
  }

  function buildDashTally(votes){
    const tz = myZoneTz || detectTz();
    const { cards, best, total } = rankedTally(poll.slots||[], votes, tz, { refTz: poll.refTz, mine: me.responses||{} });
    const winner = best && best.y>0 ? best : null;
    const hero = winner
      ? `<div class="res-hero"><div class="lead-k">★ Leading so far</div>
          <div class="lead-t mono">${winner.lp.wd} ${winner.lp.hh}:${winner.lp.mm} <span style="font-size:13px;font-weight:400;color:#0a6f60">your time</span></div>
          <div class="lead-s">${winner.y} yes${winner.m?` · ${winner.m} maybe`:""} of ${total} response${total===1?"":"s"}</div></div>`
      : (total>0 ? `<div class="res-hero empty"><div class="lead-k">${total} response${total===1?"":"s"} — no clear winner yet</div><div class="lead-s">No option has a Yes vote yet. Share your availability above to help find a better time.</div></div>` : "");
    return `<div class="res-prog-lab" style="margin-bottom:10px"><b>${total}</b> ${total===1?"person has":"people have"} responded so far.</div>
      ${hero}${cards||'<p class="note">No votes yet.</p>'}`;
  }
  
  async function renderDashboard(){
    rootEl().className = "wrap narrow";
    rootEl().innerHTML = `
      <header class="masthead"><div>
        <p class="eyebrow">Response recorded</p>
        <h1>${esc(poll.title||"Meeting time")}</h1>
        <p class="sub">Thanks, <b>${esc(me.name||"there")}</b> — your answer is in.${sharedMode?"":" (Local preview — not sent anywhere.)"} Here's how the group is leaning so far.</p>
      </div></header>
      <div class="panel" style="background:var(--work-bg);border-color:#bfe5dd">
        <b style="color:#0a6f60">✓ Your response was saved.</b> You can close this tab — or watch the results update live below.
      </div>
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
          <h2>Live results</h2>
          <button class="btn ghost" id="dashRefresh">Refresh</button>
        </div>
        <p class="note">"Leading" = most yes-votes (maybe counts half). Times in your zone, then ${esc(poll.refTz.split("/").pop())}.${sharedMode?" Auto-updates every ~10s.":""}</p>
        <div id="dashResults"><p class="note">Loading results…</p></div>
      </div>
      <div id="dashConverge"></div>
      <div class="panel">
        <button class="btn ghost" id="changeMine" style="width:100%">← Change my response</button>
      </div>`;
    document.getElementById("changeMine")?.addEventListener("click", ()=>{
      submitted=false; if(dashTimer){clearInterval(dashTimer);dashTimer=null;} render();
    });
    document.getElementById("dashRefresh")?.addEventListener("click", refreshDash);
    await refreshDash();
    startDashPolling();
  }
  
  async function refreshDash(){
    if(!submitted) return;
    let votes={};
    try{
      const remote = await Store.loadVotes(pollId) || {};
      const myKey = await voterKeyForMe();
      votes = Store.mergeVotes(pollId, remote, myKey);
    }catch(e){ votes = lcache("votes:"+pollId) || {}; }
    const cont=document.getElementById("dashResults");
    if(cont) cont.innerHTML = buildDashTally(votes);
    const conv=document.getElementById("dashConverge");
    if(conv) conv.innerHTML = convergencePanel(poll, votes, {responder:true});
  }
  
  function startDashPolling(){
    if(dashTimer) clearInterval(dashTimer);
    if(!sharedMode) return;
    dashTimer=setInterval(()=>{ if(submitted) refreshDash(); else { clearInterval(dashTimer); dashTimer=null; } }, 5000);
  }

  function startPolling(){
    if(!sharedMode) return;
    if(pollTimer) clearInterval(pollTimer);
    pollTimer=setInterval(async ()=>{
      const fresh = await Store.loadVotes(pollId);
      const protectKey = await voterKeyForMe();
      Store.mergeVotes(pollId, fresh, protectKey);
    }, 5000);
  }

  return { start, refreshDashboard: ()=>{ if(submitted) refreshDash(); } };
})();

function lcache(k){ try{ const v=localStorage.getItem("czmc:"+k); return v?JSON.parse(v):null; }catch(e){ return null; } }
