import { state, appState } from "./state.js";
import { Store, sharedMode } from "./github-store.js";
import { esc, sha256Hex, isValidEmail } from "./utils.js";
import { detectTz, localPartsFull, refWeekday, zonedWallToUtc, localParts, classify, CLASS_LABEL } from "./tz-engine.js";
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

  function emailLSKey(){ return "myemail:"+pollId; }

  async function start(h){
    pollId = h.poll;
    rawToken = h.t || sessionStorage.getItem("czmc_t_"+pollId) || null;
    rosterId = h.who || sessionStorage.getItem("czmc_who_"+pollId) || null;

    if(rawToken) sessionStorage.setItem("czmc_t_"+pollId, rawToken);
    if(rosterId) sessionStorage.setItem("czmc_who_"+pollId, rosterId);

    showAvail = false;
    submitted = false;

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
    if(!slots.length) return [];
    const earliest = slots.map(s=>s.utc).sort()[0] || poll.meetingDateISO;
    if(!earliest) return [];
    const md = new Date(earliest);
    const lp = localPartsFull(md, refTz);
    const meetWd = refWeekday(lp.y, lp.m, lp.d, refTz);
    const backToMon = (meetWd === 0) ? 6 : (meetWd - 1);
    const days = [];
    const pushWeek = (startY,startM,startD)=>{
      for(let i=0;i<7;i++){
        const dt = new Date(Date.UTC(startY, startM-1, startD+i));
        const y=dt.getUTCFullYear(), m=dt.getUTCMonth()+1, d=dt.getUTCDate();
        const iso = `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
        days.push({ iso, y, m, d });
      }
    };
    pushWeek(lp.y, lp.m, lp.d - backToMon);
    if(meetWd === 4 || meetWd === 5){
      pushWeek(lp.y, lp.m, lp.d - backToMon + 7);
    }
    return days.map(day=>{
      const noonUtc = zonedWallToUtc(day.y, day.m, day.d, 12, 0, refTz);
      const dlp = localParts(noonUtc, refTz);
      return { ...day, label:`${dlp.wd} ${dlp.day} ${dlp.mon}` };
    });
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
        <h2>When ARE you free?</h2>
        <p class="note">Tap the hours you're free (your local time, ${esc(tz.split("/").pop())}). The organizer
          uses this to find an alternative time. Empty = busy; <b>✓ green = free</b>.</p>
        <div class="av-scroll">
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

    const wantAvail = showAvail || allNo();
    const availLink = `
      <p style="margin-top:14px"><button class="link" id="noneWork">${wantAvail?"Hide weekly availability":"➕ Also share when you're free this week (optional — helps find a better time for everyone)"}</button></p>`;
    const availHtml = wantAvail ? availabilityGridHtml() : "";

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

    document.getElementById("noneWork")?.addEventListener("click", ()=>{
      showAvail = !(showAvail || allNo()); render();
      document.getElementById("availPanel")?.scrollIntoView({behavior:"smooth",block:"start"});
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
    const hero = best
      ? `<div class="res-hero"><div class="lead-k">★ Leading so far</div>
          <div class="lead-t mono">${best.lp.wd} ${best.lp.hh}:${best.lp.mm} <span style="font-size:13px;font-weight:400;color:#0a6f60">your time</span></div>
          <div class="lead-s">${best.y} yes${best.m?` · ${best.m} maybe`:""} of ${total} response${total===1?"":"s"}</div></div>`
      : (total>0 ? `<div class="res-hero empty"><div class="lead-k">${total} response${total===1?"":"s"} — all "No" so far</div><div class="lead-s">These times don't work for the group yet.</div></div>` : "");
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
