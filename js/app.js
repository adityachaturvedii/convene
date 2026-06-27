"use strict";
const pagesBase = (ownerSet && repoSet)
  ? `https://${GH.owner}.github.io/${GH.repo}/`
  : (location.origin + location.pathname);

/* ====================================================================
   0b. GITHUB I/O — DIRECT GitHub Contents-API commits (CHANGE 1).
   --------------------------------------------------------------------
   The browser now commits directly to the poll-data branch via the
   Contents API (~1-2s) instead of firing repository_dispatch and waiting
   ~30s for a GitHub Action. These are the ONLY functions that talk to
   GitHub; the Store adapter (section 1) layers localStorage on top.

   The retired repository_dispatch write path has been removed. Reads now
   also go through the authenticated Contents API (not raw) so they are
   always fresh (raw is CDN-cached and can lag commits).
   ==================================================================== */

// --- utf8 <-> base64 helpers (handle non-ASCII names safely) ----------
// encode in chunks to avoid the call-stack limit of String.fromCharCode(...).
function utf8ToB64(str){
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CHUNK = 0x8000;                      // 32k per chunk keeps the stack safe
  for(let i=0;i<bytes.length;i+=CHUNK){
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i+CHUNK));
  }
  return btoa(bin);
}
function b64ToUtf8(b64){
  // GitHub may wrap base64 content with newlines — strip whitespace first.
  const clean = String(b64||"").replace(/\s+/g,"");
  return new TextDecoder().decode(Uint8Array.from(atob(clean), c=>c.charCodeAt(0)));
}

// tagged error so the upsert retry loop can recognise a stale-sha conflict
function ConflictError(msg){ const e = new Error(msg||"sha conflict"); e.conflict = true; return e; }


/* ====================================================================
   1b. CRYPTO / IDENTITY
   - random url-safe token (>=16 chars) via crypto.getRandomValues
   - tokenHash = lowercase hex SHA-256 of the raw token (Web Crypto)
   ==================================================================== */
const URLSAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function randomToken(len){
  len = len || 22;
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let s = "";
  for(let i=0;i<len;i++) s += URLSAFE[arr[i] % URLSAFE.length];
  return s;
}
async function sha256Hex(str){
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
// loose-but-sane email syntax check — block voting until this passes (CHANGE 2).
function isValidEmail(s){
  s = String(s||"").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function slugify(s){
  // MUST stay byte-identical to slugifyName() in scripts/ingest.mjs so the guest
  // key minted in the browser equals the key the ingest Action commits.
  const slug = String(s||"")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g,"")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"");
  return slug || "guest";
}

/* ====================================================================
   2. TIMEZONE PRIMITIVES (verified against Intl tz database) — VERBATIM
   ==================================================================== */
const WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const FULL_WD = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function tzOffsetMin(tz, date){
  const dtf = new Intl.DateTimeFormat("en-US",{timeZone:tz,hour12:false,
    year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
  const p = {}; for(const x of dtf.formatToParts(date)) if(x.type!=="literal") p[x.type]=x.value;
  let h = parseInt(p.hour,10); if(h===24) h=0;
  const asUTC = Date.UTC(+p.year, +p.month-1, +p.day, h, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime())/60000);
}
function zonedWallToUtc(y,mo,d,h,mi,tz){
  const guess = Date.UTC(y,mo-1,d,h,mi);
  let off = tzOffsetMin(tz, new Date(guess));
  let utc = guess - off*60000;
  off = tzOffsetMin(tz, new Date(utc));       // second pass: DST-boundary safe
  utc = guess - off*60000;
  return new Date(utc);
}
function localParts(date, tz){
  const dtf = new Intl.DateTimeFormat("en-GB",{timeZone:tz,weekday:"short",
    day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",hour12:false});
  const p = {}; for(const x of dtf.formatToParts(date)) if(x.type!=="literal") p[x.type]=x.value;
  let h = parseInt(p.hour,10); if(h===24) h=0;
  const m = parseInt(p.minute,10);
  return { min:h*60+m, hh:String(h).padStart(2,"0"), mm:String(m).padStart(2,"0"),
           wd:p.weekday, day:p.day, mon:p.month };
}
function refWeekday(y,m,d,tz){
  const utc = zonedWallToUtc(y,m,d,12,0,tz);
  return WD.indexOf(new Intl.DateTimeFormat("en-US",{timeZone:tz,weekday:"short"}).format(utc));
}
function nearestWeekdayDate(y,m,d,target,tz){
  for(let off=0;off<7;off++){
    const dt = new Date(Date.UTC(y,m-1,d+off));
    if(refWeekday(dt.getUTCFullYear(),dt.getUTCMonth()+1,dt.getUTCDate(),tz)===target)
      return {y:dt.getUTCFullYear(),m:dt.getUTCMonth()+1,d:dt.getUTCDate()};
  }
  return {y,m,d};
}
const fmtMin = m => String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0");

// numeric calendar Y/M/D of a UTC instant in a given zone (derived accessor;
// does not touch the verified tz engine). Used by the availability grid.
function localPartsFull(date, tz){
  const dtf = new Intl.DateTimeFormat("en-CA",{timeZone:tz,
    year:"numeric",month:"2-digit",day:"2-digit"});
  const p={}; for(const x of dtf.formatToParts(date)) if(x.type!=="literal") p[x.type]=x.value;
  return { y:+p.year, m:+p.month, d:+p.day };
}

/* comfort classification: work | edge (shoulder) | off (night) */
function classify(localMin, z){
  if(localMin>=z.ws && localMin<z.we) return "work";
  if((localMin>=z.ws-90 && localMin<z.ws) || (localMin>=z.we && localMin<z.we+120)) return "edge";
  return "off";
}
const CLASS_LABEL = {work:"Working hrs", edge:"Edge of day", off:"Outside hrs"};

/* ====================================================================
   3. DEFAULT SEED  (editable in Setup)
   ==================================================================== */
const DEFAULTS = {
  meta:{ title:"Cross-zone team sync", refTz:"Europe/Berlin", weekday:2, duration:60 },
  zones:[
    {id:"z_cest", label:"CEST · Biberach / Budapest", tz:"Europe/Berlin",       ws:8*60, we:18*60},
    {id:"z_aest", label:"AEST · Proxmed (Melbourne)", tz:"Australia/Melbourne",  ws:8*60, we:18*60},
    {id:"z_ist",  label:"IST · You (Delhi)",          tz:"Asia/Kolkata",         ws:9*60, we:19*60},
  ],
  roster:[
    {id:"r1", name:"Adelheid Orend",   zoneId:"z_cest", email:""},
    {id:"r2", name:"Zita Mehesz",      zoneId:"z_cest", email:""},
    {id:"r3", name:"Doris Zimmermann", zoneId:"z_cest", email:""},
    {id:"r4", name:"Gagan Sharma",     zoneId:"z_aest", email:""},
    {id:"r5", name:"Niruta Dhimal",    zoneId:"z_aest", email:""},
    {id:"r6", name:"Aditya Chaturvedi",zoneId:"z_ist",  email:""},
  ],
  slots:[] // candidate poll slots seeded at load relative to "now"
};

const COMMON_TZS = ["Europe/Berlin","Europe/Budapest","Australia/Melbourne","Australia/Sydney",
  "Asia/Kolkata","Asia/Tokyo","Asia/Shanghai","Europe/London","America/New_York","America/Los_Angeles","UTC"];

/* ====================================================================
   4. STATE
   ==================================================================== */
let state = { meta:null, zones:[], roster:[], slots:[], votes:{},
              pollId:null, organizer:"", invites:null };
let view = "overlap";
const uid = () => Math.random().toString(36).slice(2,9);

// detect this browser's zone, match it to a configured zone if possible
function detectTz(){
  try{ return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch(e){ return "UTC"; }
}

async function loadOrganizerState(){
  state.meta   = await Store.get("meta")   || {...DEFAULTS.meta};
  state.zones  = await Store.get("zones")  || DEFAULTS.zones.map(z=>({...z}));
  state.roster = await Store.get("roster") || DEFAULTS.roster.map(r=>({...r}));
  state.slots  = await Store.get("slots");
  if(!state.slots){ state.slots = seedSlots(); await Store.set("slots", state.slots); }
  state.organizer = await Store.get("organizer") || "";
  state.organizerEmail = await Store.get("organizerEmail") || "";
  state.pollId    = await Store.get("currentPollId") || null;
  state.invites   = await Store.get("invites:"+(state.pollId||"")) || null;
  // load votes for the current poll if any
  state.votes = state.pollId ? (await Store.loadVotes(state.pollId)) : {};
}

function seedSlots(){
  // three concrete candidates anchored to the next recurring weekday in CEST
  const wd = DEFAULTS.meta.weekday, refTz = DEFAULTS.meta.refTz;
  const now = new Date();
  const base = nearestWeekdayDate(now.getUTCFullYear(), now.getUTCMonth()+1, now.getUTCDate()+3, wd, refTz);
  const mk = (h,m,lbl) => ({ id:"s_"+uid(),
    utc: zonedWallToUtc(base.y,base.m,base.d,h,m,refTz).toISOString(), label:lbl });
  return [ mk(9,0,"Inside overlap"), mk(11,0,"Current proposal"), mk(8,30,"Early CEST") ];
}
// Organizer identity = name (+ optional email). Indexing a poll under the
// organizer's name/email lets them list THEIR polls from any device (no accounts).
const normId = s => String(s||"").trim().toLowerCase();
// Index a poll under the organizer's name and (if given) email.
async function indexMyPoll(pollId, title, meetingDateISO, name, email){
  if(!sharedMode) return;
  name = (name||"").trim();
  if(!name) return;                                   // a name is required to index
  const meta = { title, meetingDateISO, updatedAt: new Date().toISOString() };
  const nameHash  = await sha256Hex(normId(name));
  const emailNorm = normId(email);
  const emailHash = emailNorm ? await sha256Hex(emailNorm) : null;
  const bucket = emailHash || "_noemail";
  try{
    await GHIO.upsertJson(GHIO.ownerNamePath(nameHash), idx=>{
      idx.name = name;
      idx.byEmail = (idx.byEmail && typeof idx.byEmail==="object") ? idx.byEmail : {};
      const b = idx.byEmail[bucket] || { emailHash, polls:{} };
      b.emailHash = emailHash; b.polls = b.polls || {}; b.polls[pollId] = meta;
      idx.byEmail[bucket] = b;
      return idx;
    }, "index(name) "+pollId);
    if(emailHash){
      await GHIO.upsertJson(GHIO.ownerEmailPath(emailHash), idx=>{
        idx.name = name; idx.polls = idx.polls || {}; idx.polls[pollId] = meta; return idx;
      }, "index(email) "+pollId);
    }
  }catch(e){}
}
// Remove a poll from the organizer's indexes (best-effort, on delete).
async function unindexMyPoll(pollId, name, email){
  if(!sharedMode || !(name||"").trim()) return;
  const nameHash  = await sha256Hex(normId(name));
  const emailNorm = normId(email);
  const emailHash = emailNorm ? await sha256Hex(emailNorm) : null;
  const bucket = emailHash || "_noemail";
  try{
    await GHIO.upsertJson(GHIO.ownerNamePath(nameHash), idx=>{
      if(idx.byEmail && idx.byEmail[bucket] && idx.byEmail[bucket].polls) delete idx.byEmail[bucket].polls[pollId];
      return idx;
    }, "unindex(name) "+pollId);
    if(emailHash) await GHIO.upsertJson(GHIO.ownerEmailPath(emailHash), idx=>{
      if(idx.polls) delete idx.polls[pollId]; return idx;
    }, "unindex(email) "+pollId);
  }catch(e){}
}
// Look up a publisher's polls by a single "name or email" value.
// Returns { polls } or { needEmail:true } (name shared by multiple people).
async function lookupMyPolls(value){
  const v = (value||"").trim();
  if(!v) return { polls:{} };
  if(v.includes("@")){
    const idx = await GHIO.readJson(GHIO.ownerEmailPath(await sha256Hex(normId(v))));
    return { polls: (idx && idx.polls) ? idx.polls : {} };
  }
  const idx = await GHIO.readJson(GHIO.ownerNamePath(await sha256Hex(normId(v))));
  const buckets = idx && idx.byEmail ? Object.keys(idx.byEmail) : [];
  if(!buckets.length) return { polls:{} };
  if(buckets.length === 1) return { polls: idx.byEmail[buckets[0]].polls || {} };
  return { needEmail:true };                          // ambiguous name → ask for email
}

// Load a poll's data straight from GitHub into state so its results render on ANY
// device (no localStorage needed). Used by the admin/results link (#poll=<id>&admin).
async function adoptRemotePoll(pollId){
  state.pollId = pollId;
  const poll = await Store.loadPoll(pollId);   // remote-first (keyless); caches "poll:"+id locally
  if(poll){
    state.meta = { ...state.meta,
      title: poll.title || state.meta.title,
      refTz: poll.refTz || state.meta.refTz,
      weekday: (poll.weekday!=null ? poll.weekday : state.meta.weekday),
      duration: poll.duration || state.meta.duration };
    if(Array.isArray(poll.zones) && poll.zones.length) state.zones = poll.zones.map(z=>({...z}));
    if(Array.isArray(poll.slots)) state.slots = poll.slots.map(s=>({...s}));
  }
  state.votes = await Store.loadVotes(pollId) || {};
}
async function saveMeta(){ await Store.set("meta", state.meta); }
async function saveZones(){ await Store.set("zones", state.zones); }
async function saveRoster(){ await Store.set("roster", state.roster); }
async function saveSlots(){ await Store.set("slots", state.slots); }

/* ====================================================================
   5. HELPERS
   ==================================================================== */
const zoneById = id => state.zones.find(z=>z.id===id);
const peopleInZone = id => state.roster.filter(r=>r.zoneId===id).length;
const esc = s => String(s??"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

function currentGap(){
  const cest = state.zones.find(z=>z.tz==="Europe/Berlin") || state.zones[0];
  const aest = state.zones.find(z=>z.tz==="Australia/Melbourne") || state.zones[1] || state.zones[0];
  if(!cest || !aest) return null;
  const now = new Date();
  const g = (tzOffsetMin(aest.tz,now) - tzOffsetMin(cest.tz,now))/60;
  return { hours:g, a:aest, b:cest };
}

function computeRecommendation(weekday){
  const refTz = state.meta.refTz;
  const now = new Date();
  const sd = nearestWeekdayDate(now.getUTCFullYear(), now.getUTCMonth()+1, now.getUTCDate(), weekday, refTz);
  let best = null;
  for(let t=6*60; t<=20*60; t+=30){
    const utc = zonedWallToUtc(sd.y,sd.m,sd.d,Math.floor(t/60),t%60,refTz);
    let score=0, work=0;
    for(const z of state.zones){
      const c = classify(localParts(utc,z.tz).min, z);
      const n = Math.max(1, peopleInZone(z.id));
      score += (c==="work"?2:c==="edge"?1:-3)*n;
      if(c==="work") work++;
    }
    if(!best || score>best.score || (score===best.score && work>best.work))
      best = {t, utc, score, work};
  }
  return best;
}

/* ====================================================================
   6. ROUTING — responder view when location.hash has poll=<id>
   ==================================================================== */
function parseHash(){
  const h = location.hash.replace(/^#/, "");
  const p = new URLSearchParams(h);
  return { poll:p.get("poll"), who:p.get("who"), t:p.get("t"), admin:p.has("admin") };
}

/* ====================================================================
   7a. ORGANIZER APP RENDER
   ==================================================================== */
function rootEl(){ return document.getElementById("root"); }

function organizerShell(){
  rootEl().className = "wrap";
  rootEl().innerHTML = `
  <header class="masthead">
    <div>
      <p class="eyebrow" id="eyebrow">Convene · cross-zone scheduling</p>
      <h1 id="title">${esc(state.meta.title)}</h1>
      <p class="sub" id="subline">Find the least-cruel common slot. Working hours are shaded per zone; the overlap is where everyone is awake and at work.</p>
    </div>
    <div class="gap-readout">
      <span class="big mono" id="gapBig">—</span>
      <small id="gapLabel">offset today</small>
    </div>
  </header>
  <div id="modebar"></div>
  <nav class="tabs" id="tabs" role="tablist">
    <button class="tab" role="tab" data-view="overlap" aria-selected="true">Overlap board</button>
    <button class="tab" role="tab" data-view="recurring" aria-selected="false">Recurring slot</button>
    <button class="tab" role="tab" data-view="poll" aria-selected="false">Poll &amp; invite</button>
    <button class="tab" role="tab" data-view="results" aria-selected="false">Results</button>
    <button class="tab" role="tab" data-view="setup" aria-selected="false">Setup</button>
  </nav>
  <div id="app"><div class="loading">Loading…</div></div>`;
  document.getElementById("tabs").addEventListener("click", e=>{
    const b=e.target.closest(".tab"); if(b) setView(b.dataset.view);
  });
  renderModebar();
}
function renderModebar(){
  const el = document.getElementById("modebar");
  if(!el) return;
  // On the live (shared) site the mode banner is just noise — only show the
  // hint in local/dev mode.
  if(sharedMode){ el.style.display="none"; el.innerHTML=""; el.className="modebar"; return; }
  el.style.display="";
  el.className = "modebar local";
  el.innerHTML = `<span class="dot"></span>Local mode — deploy to GitHub to collect votes from others.`;
}
const app = () => document.getElementById("app");

function renderHeader(){
  const t = document.getElementById("title"); if(t) t.textContent = state.meta.title;
  const g = currentGap();
  if(g && document.getElementById("gapBig")){
    document.getElementById("gapBig").textContent = (g.hours>0?"+":"")+g.hours+"h";
    document.getElementById("gapLabel").textContent =
      g.a.tz.split("/").pop()+" vs "+g.b.tz.split("/").pop()+" today";
  }
}
function setView(v){
  view = v;
  document.querySelectorAll(".tab").forEach(t =>
    t.setAttribute("aria-selected", String(t.dataset.view===v)));
  render();
}
function render(){
  renderHeader();
  if(view==="overlap")   app().innerHTML = viewOverlap();
  if(view==="recurring") app().innerHTML = viewRecurring();
  if(view==="poll"){ app().innerHTML = viewPoll(); wirePoll(); }
  if(view==="results"){ app().innerHTML = viewResults(); wireResults(); }
  if(view==="setup"){ app().innerHTML = viewSetup(); wireSetup(); }
}

/* ---- Overlap board (VERBATIM visual language) ----------------------- */
function viewOverlap(){
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
  cols.forEach(c => head += `<th onclick="toggleBoardSlot(${c.h})" class="b-hour${c.allOk?" in-work":""}${c.h===currentHourRef?" current-hour":""}" title="Click to toggle slot">${String(c.h).padStart(2,"0")}</th>`);

  let overlapRow = `<td class="b-zonecol" style="border-bottom:none"></td>`;
  cols.forEach(c => overlapRow +=
    `<td class="${c.allWork?"b-mark-work":(c.allOk?"b-mark-edge":"")}"></td>`);

  let body = "";
  state.zones.forEach((z,zi)=>{
    let row = `<td class="b-zonecol"><div class="zname">${esc(z.label)}</div>
      <div class="ztz mono">${esc(z.tz.split("/").pop())} · ${fmtMin(z.ws)}–${fmtMin(z.we)}</div></td>`;
    cols.forEach(c=>{
      const cell = c.cells[zi];
      const pin = c.h===pinHour ? " pinned" : "";
      const t = cell.mm==="00" ? cell.hh : `${cell.hh}<span class="mm">:${cell.mm}</span>`;
      row += `<td onclick="toggleBoardSlot(${c.h})" class="cell ${cell.c}${pin}${c.h===currentHourRef?" current-hour":""}" title="Click to toggle slot">${t}</td>`;
    });
    body += `<tr>${row}</tr>`;
  });

  const recTxt = rec
    ? `Recommended recurring slot sits at <b class="mono">${fmtMin(rec.t)} ${refTz.split("/").pop()}</b> on ${FULL_WD[weekday]} — the ${rec.work}-of-${state.zones.length}-zone best. See the Recurring tab.`
    : "";

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

/* ---- Recurring recommendation + DST check (VERBATIM) ---------------- */
function viewRecurring(){
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
    ? `<div class="warn"><span class="wicon">!</span><div><b>DST drift.</b> Europe and Australia shift clocks in
        opposite directions. A fixed wall-clock time rots across the year — by mid-December:
        ${drift.join("; ")}. Consider re-anchoring the slot each DST season, or pinning to UTC.</div></div>`
    : `<div class="warn ok"><span class="wicon">✓</span><div>This slot holds its comfort profile across the
        summer/winter DST shift. Safe to set as a standing wall-clock time.</div></div>`;

  return `
  <div class="panel">
    <h2><span class="section-num">02 · </span>Best standing weekly slot</h2>
    <p class="note">Searched 06:00–20:00 ${refTz.split("/").pop()} on ${FULL_WD[weekday]}, scored by how many
      people land in working hours (night times penalised). Change the day in Setup.</p>
    <div class="rec-headline">
      <span class="rec-time mono">${fmtMin(rec.t)}</span>
      <span class="rec-day">${refTz.split("/").pop()} · every ${FULL_WD[weekday]} · ${state.meta.duration} min</span>
    </div>
    <div class="strip">${stripFor(rec.utc)}</div>
    ${driftBanner}
  </div>`;
}

/* ---- Poll & invite (organizer create-poll flow) --------------------- */
function viewPoll(){
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

  const addForm = `
    <div class="row">
      <div><label class="fld">Date</label><input type="date" id="newDate"></div>
      <div><label class="fld">Time (${state.meta.refTz.split("/").pop()})</label><input type="time" id="newTime" value="09:00"></div>
      <div><label class="fld">Label (optional)</label><input type="text" id="newLabel" placeholder="e.g. backup"></div>
      <div style="flex:0"><button class="btn" id="addSlot">Add slot</button></div>
    </div>`;

  const rosterRows = state.roster.map(r=>`
    <tr>
      <td><input type="text" data-redit="name" data-id="${r.id}" value="${esc(r.name)}" placeholder="Name"></td>
      <td><input type="email" data-redit="email" data-id="${r.id}" value="${esc(r.email||"")}" placeholder="email (stays local)"></td>
      <td><select data-redit="zoneId" data-id="${r.id}">${state.zones.map(z=>
        `<option value="${z.id}" ${z.id===r.zoneId?"selected":""}>${esc(z.label)}</option>`).join("")}</select></td>
      <td><button class="link" data-rdel="${r.id}">remove</button></td>
    </tr>`).join("");

  const invitePanel = state.invites ? renderInvitePanel() : "";

  return `
  <div class="panel">
    <h2><span class="section-num">03 · </span>Meeting &amp; candidate slots</h2>
    <p class="note">Set the title and the times you want to offer. Times are entered in
      ${state.meta.refTz.split("/").pop()} and convert for everyone automatically.</p>
    <div class="row" style="margin-bottom:14px">
      <div><label class="fld">Meeting title</label><input type="text" id="pollTitle" value="${esc(state.meta.title)}"></div>
      <div><label class="fld">Organizer name</label><input type="text" id="orgName" value="${esc(state.organizer)}" placeholder="e.g. Aditya"></div>
      <div><label class="fld">Organizer email (optional)</label><input type="text" id="orgEmail" value="${esc(state.organizerEmail||"")}" placeholder="to find your polls later"></div>
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
      <span id="publishState" class="storage-note"></span>
    </div>
    ${invitePanel}
  </div>`;
}

function renderInvitePanel(){
  const inv = state.invites;
  const rows = inv.links.map(l=>`
    <div class="invite-row">
      <span class="who">${esc(l.name)}</span>
      <span class="lnk" title="${esc(l.url)}">${esc(l.url)}</span>
      <button class="btn ghost" data-copyone="${esc(l.url)}">Copy</button>
    </div>`).join("");
  // central "anyone" link (CHANGE 2) — no &who/&t. Whoever opens it is asked
  // for name + email; the email is stored only as a private hash.
  const centralUrl = inv.centralUrl || (`${pagesBase}#poll=${encodeURIComponent(inv.pollId)}`);
  const centralRow = `
    <div class="invite-row" style="border-color:var(--accent);background:var(--accent-bg)">
      <span class="who">Central link (anyone)</span>
      <span class="lnk" title="${esc(centralUrl)}">${esc(centralUrl)}</span>
      <button class="btn ghost" data-copyone="${esc(centralUrl)}" id="copyCentral">Copy central link</button>
    </div>`;
  // YOUR results link — opens the live tally on ANY device (no localStorage needed).
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
    <p class="storage-note" style="margin-top:8px">📊 To see results on another device: open <b>Results → My polls</b> and enter your
      organizer ${state.organizerEmail?`<b>name or email</b> (${esc(state.organizer)} / ${esc(state.organizerEmail)})`:`<b>name</b> (${esc(state.organizer||"set it above")})`}.</p>
    <p class="storage-note" style="margin-top:8px">Each per-person link contains a one-time private token. Anyone with a
      person's link can answer as that person, so send those individually. The <b>central link</b> is safe to forward
      to anyone — it asks each responder for their name + email (the email is stored only as a private hash, never shown).</p>
  </div>`;
}

function wirePoll(){
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
    const utc=zonedWallToUtc(y,mo,da,h,mi,state.meta.refTz);
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

function copyToClipboard(text, btn){
  const done=()=>{ if(btn){ const o=btn.textContent; btn.textContent="Copied ✓"; setTimeout(()=>btn.textContent=o,1400); } };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done, ()=>fallbackCopy(text,done));
  } else fallbackCopy(text,done);
}
function fallbackCopy(text, done){
  const ta=document.createElement("textarea"); ta.value=text; ta.style.position="fixed"; ta.style.opacity="0";
  document.body.appendChild(ta); ta.select(); try{ document.execCommand("copy"); done&&done(); }catch(e){}
  document.body.removeChild(ta);
}

async function publishPoll(){
  const stateEl = document.getElementById("publishState");
  const named = state.roster.filter(r=>(r.name||"").trim());
  if(!named.length){ if(stateEl) stateEl.textContent="Add at least one named invitee first."; return; }
  if(!state.slots.length){ if(stateEl) stateEl.textContent="Add at least one candidate slot first."; return; }
  if(stateEl) stateEl.textContent="Publishing…";

  // generate (or reuse) pollId
  const pollId = state.pollId || ("p"+randomToken(8));
  state.pollId = pollId;

  // mint per-invitee token + tokenHash (Web Crypto SHA-256).
  // On RE-PUBLISH, reuse each person's existing token so invite links already
  // sent stay valid — only mint a fresh token for newly-added invitees.
  const existingTok = {};
  if(state.invites && Array.isArray(state.invites.links))
    for(const lk of state.invites.links) existingTok[lk.rosterId] = lk.token;
  const rosterOut = [];           // goes into poll.json — NO email, NO raw token
  const links = [];               // organizer-only invite links (memory + local)
  for(const r of named){
    const token = existingTok[r.id] || randomToken(22);
    const tokenHash = await sha256Hex(token);
    rosterOut.push({ rosterId:r.id, name:r.name.trim(), zoneId:r.zoneId, tokenHash });
    const url = `${pagesBase}#poll=${encodeURIComponent(pollId)}&who=${encodeURIComponent(r.id)}&t=${encodeURIComponent(token)}`;
    links.push({ rosterId:r.id, name:r.name.trim(), token, url });
  }

  // poll.json object — verbatim save-poll 'poll' shape (no emails, tokenHash not token)
  const poll = {
    id: pollId,
    title: state.meta.title,
    meetingDateISO: state.slots.map(s=>s.utc).sort()[0],   // earliest candidate (for retention)
    refTz: state.meta.refTz,
    weekday: state.meta.weekday,
    duration: state.meta.duration,
    zones: state.zones.map(z=>({id:z.id,label:z.label,tz:z.tz,ws:z.ws,we:z.we})),
    roster: rosterOut,
    slots: state.slots.map(s=>({id:s.id,utc:s.utc,label:s.label||""}))
  };

  const res = await Store.savePoll(poll);
  // central "anyone" link = the responder URL WITHOUT &who/&t (CHANGE 2)
  const centralUrl = `${pagesBase}#poll=${encodeURIComponent(pollId)}`;
  state.invites = { pollId, links, centralUrl };
  await Store.set("currentPollId", pollId);
  await Store.set("invites:"+pollId, state.invites);
  // index this poll under the organizer's key so it's visible in "My polls" anywhere
  await indexMyPoll(pollId, poll.title, poll.meetingDateISO, state.organizer, state.organizerEmail);

  if(stateEl){
    stateEl.textContent = sharedMode
      ? (res.ok ? "Published ✓ — committed to the poll-data branch. Links are live now."
                : "Couldn't commit poll.json (HTTP "+(res.status||"?")+"). Check the token/repo; links generated locally.")
      : "Generated locally (local mode — not sent to GitHub).";
  }
  render();
}

// If we hold a poll locally (id + invites) but it never reached GitHub — e.g. it
// was created before sharedMode worked — push it live automatically, reusing the
// SAME per-invitee tokens so already-sent links keep working. Idempotent: it only
// commits when the poll is definitively absent from the server.
async function ensurePollLive(){
  if(!sharedMode || !state.pollId || !state.invites || !Array.isArray(state.invites.links)) return;
  let onServer = null;
  try{ onServer = await GHIO.readJson(GHIO.pollJsonPath(state.pollId)); }
  catch(e){ return; }                    // transient read error: don't risk a needless write
  if(onServer){
    // already live — just make sure it's listed in "My polls" for this organizer key
    try{ await indexMyPoll(state.pollId, onServer.title||state.meta.title, onServer.meetingDateISO, state.organizer, state.organizerEmail); }catch(e){}
    return;
  }
  const named = state.roster.filter(r=>(r.name||"").trim());
  const tokById = {};
  for(const lk of state.invites.links) tokById[lk.rosterId] = lk.token;
  const rosterOut = [];
  for(const r of named){
    const token = tokById[r.id]; if(!token) continue;     // only re-push known invitees
    rosterOut.push({ rosterId:r.id, name:r.name.trim(), zoneId:r.zoneId, tokenHash: await sha256Hex(token) });
  }
  if(!rosterOut.length || !state.slots.length) return;
  const poll = {
    id: state.pollId, title: state.meta.title,
    meetingDateISO: state.slots.map(s=>s.utc).sort()[0],
    refTz: state.meta.refTz, weekday: state.meta.weekday, duration: state.meta.duration,
    zones: state.zones.map(z=>({id:z.id,label:z.label,tz:z.tz,ws:z.ws,we:z.we})),
    roster: rosterOut,
    slots: state.slots.map(s=>({id:s.id,utc:s.utc,label:s.label||""}))
  };
  try{ await Store.savePoll(poll); await indexMyPoll(poll.id, poll.title, poll.meetingDateISO, state.organizer, state.organizerEmail); }catch(e){}
}

async function deleteCurrentPoll(){
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

/* ---- CHANGE 3 (organizer): aggregate "No" voters' weekly availability ----
   For every voter entry that carries `availability`, convert each free LOCAL
   hour into the poll's REFERENCE zone and tally how many people are free at
   each ref-zone hour per day. Render a readable heat strip + best hour/day. */
// Filter state for the convergence section: show only times where ALL availability
// sharers are free. Global so the inline toggle can re-render the active view.
let convergeAllOnly = false;
let appMode = "organizer";
function convToggle(el){
  convergeAllOnly = !!(el && el.checked);
  if(appMode==="responder"){ if(Responder.refreshDashboard) Responder.refreshDashboard(); }
  else if(typeof view!=="undefined" && view==="results"){ refreshResults(); }
}

// Convergence: from EVERY respondent who shared weekly availability (any answer),
// convert each free local hour to the reference zone, rank the times where the most
// people are free, and surface them as concrete meeting suggestions (+ per-zone times).
function convergencePanel(poll, votes, opts){
  opts = opts || {};
  const refTz = poll.refTz;
  const pad = n => String(n).padStart(2,"0");
  const contributors = Object.values(votes||{})
    .filter(v => v && v.availability && Object.keys(v.availability).length && (!v.responses || Object.values(v.responses).every(ans => ans === "n")))
    .map(v => ({ tz: v.tz || refTz, avail: v.availability }));
  if(!contributors.length){
    if(opts.responder) return "";
    return `<div class="panel"><h2>Best converging times</h2>
      <p class="note">No one has shared their weekly availability yet. As responders add the hours they're
      free (with any answer — Yes, Maybe or No), the best meeting windows appear here automatically.</p></div>`;
  }
  const M = contributors.length;

  const dayCount = {}, dayMeta = {};
  contributors.forEach(c=>{
    Object.entries(c.avail).forEach(([dISO, hours])=>{
      const [Y,Mo,D] = dISO.split("-").map(Number);
      (hours||[]).forEach(h=>{
        const utc = zonedWallToUtc(Y, Mo, D, h, 0, c.tz);     // free local hour -> UTC
        const rp = localPartsFull(utc, refTz);
        const refHour = parseInt(localParts(utc, refTz).hh, 10);
        const key = `${rp.y}-${pad(rp.m)}-${pad(rp.d)}`;
        dayCount[key] = dayCount[key] || {};
        dayCount[key][refHour] = (dayCount[key][refHour]||0) + 1;
        dayMeta[key] = { y:rp.y, m:rp.m, d:rp.d };
      });
    });
  });

  // ranked suggestions (most-free first)
  const flat = [];
  Object.entries(dayCount).forEach(([dISO, hours])=>
    Object.entries(hours).forEach(([h,c])=> flat.push({ dISO, h:+h, c, meta:dayMeta[dISO] })));
  flat.sort((a,b)=> b.c-a.c || a.dISO.localeCompare(b.dISO) || a.h-b.h);
  let ranked = flat.filter(x=>x.c>0);
  if(convergeAllOnly) ranked = ranked.filter(x=>x.c===M);   // only times EVERYONE is free
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

  // detail heatmap (organizer only, collapsed)
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
    <p class="note">From <b>${M}</b> ${M===1?"person":"people"} who shared weekly availability. Ranked by how many
      are free, in <b>${esc(refTz.split("/").pop())}</b>${zonesMulti?" (each zone shown under the time)":""}.
      Approximate around date boundaries.</p>
    <label style="display:inline-flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink);margin:0 0 13px;cursor:pointer">
      <input type="checkbox" ${convergeAllOnly?"checked":""} onchange="convToggle(this)" style="width:auto;margin:0">
      Only times when <b>everyone</b> (all ${M}) is free</label>
    ${suggestions || (convergeAllOnly
      ? `<p class="note" style="color:var(--edge)">No single time works for all ${M} who shared availability yet — uncheck to see the closest options.</p>`
      : '<p class="note">No overlapping free time yet.</p>')}
    ${opts.responder ? "" : `<details style="margin-top:14px"><summary class="note" style="cursor:pointer;display:inline-block">Full weekly heatmap (${pad(H0)}:00–${pad(H1)}:00 ${esc(refTz.split("/").pop())})</summary><div style="margin-top:10px">${heatRows}</div></details>`}
  </div>`;
}

/* ---- Results (organizer reads votes.json) --------------------------- */
function viewResults(){
  if(!state.pollId){
    const known = state.organizerEmail || state.organizer || "";
    return `<div class="panel"><h2><span class="section-num">04 · </span>Results — my polls</h2>
      <p class="note">See the live tally for any poll <b>you</b> published, from any device. Enter the
      <b>name or email</b> you published with.</p>
      <div class="row">
        <div><label class="fld">Your name or email</label>
          <input type="text" id="orgWho" aria-label="Your name or email" value="${esc(known)}" placeholder="e.g. Aditya  or  you@email.com"></div>
        <div style="flex:0"><button class="btn" id="loadMyPolls">Show my polls</button></div>
      </div>
      <div id="myPolls" style="margin-top:14px"></div>
      <hr style="border:none;border-top:1px solid var(--line);margin:18px 0">
      <div class="row">
        <div><label class="fld">Or open one poll by link / id</label>
          <input type="text" id="pollIdInput" aria-label="Poll ID" placeholder="pxnxB8uLw  or a full results link"></div>
        <div style="flex:0"><button class="btn ghost" id="openPollId">Open results</button></div>
      </div></div>`;
  }
  const poll = lcache("poll:"+state.pollId) || {
    slots: state.slots, roster: state.roster.filter(r=>(r.name||"").trim())
  };
  const slots = [...(poll.slots||state.slots)];
  const roster = poll.roster || [];
  const votes = state.votes || {};
  const refTz = poll.refTz || state.meta.refTz;

  const { cards, best, total } = rankedTally(slots, votes, refTz, {});

  // who has responded (roster by rosterId; guests/central are separate)
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

  const hero = best
    ? `<div class="res-hero"><div class="lead-k">★ Leading time</div>
        <div class="lead-t mono">${best.lp.wd} ${best.lp.hh}:${best.lp.mm} · <span style="font-size:15px;font-weight:500">${best.lp.day} ${best.lp.mon} ${esc(refTz.split("/").pop())}</span></div>
        <div class="lead-s">${best.y} yes${best.m?` · ${best.m} maybe`:""}${best.n?` · ${best.n} no`:""} — out of ${total} response${total===1?"":"s"}</div></div>`
    : (total>0
        ? `<div class="res-hero empty"><div class="lead-k">${total} response${total===1?"":"s"} so far — no clear winner</div>
            <div class="lead-s">Every answer so far is "No". You likely need different times — see who's free below.</div></div>`
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

// Shared ranked tally renderer for the organizer Results AND the responder dashboard.
// displayTz = the zone to show prominently; opts.refTz adds a secondary ref time;
// opts.mine = {slotId:answer} highlights the viewer's own pick.
function rankedTally(slots, votes, displayTz, opts){
  opts = opts || {};
  const total = Object.keys(votes||{}).length;
  const rows = [...(slots||[])].map(s=>{
    let y=0,m=0,n=0;
    Object.values(votes||{}).forEach(v=>{ const r=v.responses && v.responses[s.id];
      if(r==="yes")y++; else if(r==="maybe")m++; else if(r==="no")n++; });
    return { s, y, m, n, resp:y+m+n, score:y*2+m, lp:localParts(new Date(s.utc), displayTz) };
  });
  rows.sort((a,b)=> b.score-a.score || b.y-a.y || a.s.utc.localeCompare(b.s.utc));
  const best = rows.length && rows[0].score>0 ? rows[0] : null;
  const w = x => total ? (x/total*100) : 0;
  const cards = rows.map((r,i)=>{
    const leading = best && r===best;
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
function awaitingChips(responded, awaiting, guests){
  if(!responded.length && !awaiting.length && !guests.length) return "";
  return `<div class="panel">
    <h2>Who has responded</h2>
    <div class="chips">
      ${responded.map(n=>`<span class="chip-r">✓ ${esc(n)}</span>`).join("")}
      ${awaiting.map(n=>`<span class="chip-a">${esc(n)}</span>`).join("")}
      ${guests.map(n=>`<span class="chip-g">+ ${esc(n)}</span>`).join("")}
    </div>
    <p class="note" style="margin-top:11px"><span style="color:#0a6f60">✓ responded</span> ·
      <span style="color:var(--muted)">awaiting</span> ·
      <span style="color:#8a5c06">+ guest (not on the invite list)</span></p>
  </div>`;
}
function lcache(k){ try{ const v=localStorage.getItem("czmc:"+k); return v?JSON.parse(v):null; }catch(e){ return null; } }

let resultsTimer=null;
function wireResults(){
  if(resultsTimer){ clearInterval(resultsTimer); resultsTimer=null; }
  if(!state.pollId){
    // "My polls" empty-state wiring
    document.getElementById("loadMyPolls")?.addEventListener("click", ()=>loadMyPolls());
    document.getElementById("openPollId")?.addEventListener("click", ()=>{
      const raw=(document.getElementById("pollIdInput")?.value||"").trim();
      const m=raw.match(/poll=([A-Za-z0-9_-]+)/);
      const id=m?m[1]:raw.replace(/[^A-Za-z0-9_-]/g,"");
      if(id) location.hash = "poll="+encodeURIComponent(id)+"&admin";   // hashchange -> reload -> admin route
    });
    if(state.organizer || state.organizerEmail) loadMyPolls();   // auto-list on the organizer's own device
    return;
  }
  document.getElementById("refreshResults")?.addEventListener("click", refreshResults);
  if(sharedMode && state.pollId){
    resultsTimer = setInterval(()=>{ if(view==="results") refreshResults(); else { clearInterval(resultsTimer); resultsTimer=null; } }, 5000);
  }
}
function renderMyPollsList(cont, pollsObj){
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
async function loadMyPolls(forceEmail){
  const cont = document.getElementById("myPolls"); if(!cont) return;
  const who = (document.getElementById("orgWho")?.value||"").trim();
  const value = forceEmail || who;
  if(!value){ cont.innerHTML = `<p class="awaiting">Enter your name or email first.</p>`; return; }
  cont.innerHTML = `<p class="note">Loading your polls…</p>`;
  let r=null;
  try{ r = await lookupMyPolls(value); }catch(e){ r=null; }
  if(!r){ cont.innerHTML = `<p class="awaiting">Couldn't load — check your connection and try again.</p>`; return; }
  if(r.needEmail){
    cont.innerHTML = `<p class="awaiting" style="color:var(--edge)">More than one organizer used that name. Enter the <b>email</b> you published with:</p>
      <div class="row" style="margin-top:8px">
        <div><input type="text" id="orgEmailDisambig" aria-label="Your email" placeholder="you@email.com"></div>
        <div style="flex:0"><button class="btn" id="orgEmailGo">Show my polls</button></div>
      </div>`;
    document.getElementById("orgEmailGo")?.addEventListener("click", ()=>{
      const em=(document.getElementById("orgEmailDisambig")?.value||"").trim();
      if(em) loadMyPolls(em);
    });
    return;
  }
  renderMyPollsList(cont, r.polls);
}
async function refreshResults(){
  if(!state.pollId) return;
  const fresh = await Store.loadVotes(state.pollId);
  state.votes = Store.mergeVotes(state.pollId, fresh, null);
  if(view==="results") app().innerHTML = viewResults(), wireResults();
}

/* ---- Setup ---------------------------------------------------------- */
function viewSetup(){
  const tzOpt = (sel)=>COMMON_TZS.map(t=>`<option value="${t}" ${t===sel?"selected":""}>${t}</option>`).join("");
  const zoneRows = state.zones.map(z=>`
    <tr>
      <td><input type="text" data-zedit="label" data-id="${z.id}" value="${esc(z.label)}" style="min-width:160px"></td>
      <td><select data-zedit="tz" data-id="${z.id}">${tzOpt(z.tz)}</select></td>
      <td><input type="time" data-zedit="ws" data-id="${z.id}" value="${fmtMin(z.ws)}" style="width:108px"></td>
      <td><input type="time" data-zedit="we" data-id="${z.id}" value="${fmtMin(z.we)}" style="width:108px"></td>
      <td><button class="link" data-zdel="${z.id}">remove</button></td>
    </tr>`).join("");

  return `
  <div class="panel">
    <h2>Meeting</h2>
    <div class="row">
      <div><label class="fld">Title</label><input type="text" id="setTitle" value="${esc(state.meta.title)}"></div>
      <div><label class="fld">Reference zone</label><select id="setRef">${tzOpt(state.meta.refTz)}</select></div>
      <div><label class="fld">Cadence day</label><select id="setWd">${WD.map((w,i)=>
        `<option value="${i}" ${i===state.meta.weekday?"selected":""}>${w}day</option>`).join("")}</select></div>
      <div><label class="fld">Duration (min)</label><input type="number" id="setDur" value="${state.meta.duration}" min="15" step="15"></div>
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

function wireSetup(){
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
    await loadOrganizerState(); setView("overlap");
  });
}

/* ====================================================================
   7b. RESPONDER VIEW — rendered ONLY when location.hash has poll=<id>.
   Single-column guest ballot. No setup/overlap/recurring tabs, no
   roster list, no live tally (seeing the tally biases late responders).
   ==================================================================== */
const Responder = (() => {
  let poll=null, pollId=null, rawToken=null, rosterId=null;
  let me=null;          // {name, email, zoneId, responses, guest, availability, ...}
  let myZoneTz=null;
  let pollTimer=null;
  let dashTimer=null;
  let saving=false;
  let submitted=false;  // after a successful save -> show the live-results dashboard
  let showAvail=false;  // whether the weekly-availability grid is revealed (CHANGE 3)

  // localStorage key for this browser's own raw email per poll (NEVER committed).
  function emailLSKey(){ return "myemail:"+pollId; }

  async function start(h){
    pollId = h.poll;
    rawToken = h.t || sessionStorage.getItem("czmc_t_"+pollId) || null;        // kept in memory only
    rosterId = h.who || sessionStorage.getItem("czmc_who_"+pollId) || null;
    showAvail = false;
    submitted = false;

    // strip token (and who) from the VISIBLE url; keep token in memory
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

    // A responder is "verified" only with BOTH a roster &who AND a &t token.
    // Without a valid token (central link, forwarded link, manual pick) they
    // go through the central entry form and MUST supply name + email (CHANGE 2).
    const rosterEntry = rosterId ? (poll.roster||[]).find(r=>r.rosterId===rosterId) : null;
    const verified = !!(rosterEntry && rawToken);

    const detected = detectTz();
    // detected zone -> match to a poll zone, else use roster's zone, else first
    let matchedZone = (poll.zones||[]).find(z=>z.tz===detected);
    const defaultZoneId = matchedZone ? matchedZone.id
      : (rosterEntry ? rosterEntry.zoneId : (poll.zones?.[0]?.id));

    // hydrate any in-progress local vote for this identity
    const localKey = verified ? rosterEntry.rosterId : null;
    const cache = lcache("votes:"+pollId) || {};
    const prior = localKey ? cache[localKey] : null;

    // re-use a previously typed email from THIS browser (raw, local-only).
    const priorEmail = lcache(emailLSKey()) || "";

    me = {
      name: rosterEntry ? rosterEntry.name : (prior?.name || ""),
      email: priorEmail,                 // raw, local-only; never committed
      zoneId: prior?.zoneId || defaultZoneId,
      responses: prior?.responses ? {...prior.responses} : {},
      availability: prior?.availability ? {...prior.availability} : null,
      guest: !verified,                  // guest/central until a verified identity
      viaCentral: !verified              // central path => email required
    };

    render();
    startPolling();
  }

  function myZone(){
    return (poll.zones||[]).find(z=>z.id===me.zoneId) || poll.zones?.[0];
  }

  // --- CHANGE 3: which days the availability grid should cover -----------
  // meetingDateISO = earliest candidate slot's UTC. In the poll's reference
  // zone, take Mon–Fri of the week containing that date. If the meeting day
  // is Thu(4)/Fri(5), also append next week's Mon–Fri (little of this week
  // is left to reschedule into). Each day = its ref-zone calendar date.
  function availabilityDays(){
    const refTz = poll.refTz;
    const slots = (poll.slots||[]);
    if(!slots.length) return [];
    const earliest = slots.map(s=>s.utc).sort()[0] || poll.meetingDateISO;
    if(!earliest) return [];
    const md = new Date(earliest);
    // ref-zone calendar date of the meeting
    const lp = localPartsFull(md, refTz);
    const meetWd = refWeekday(lp.y, lp.m, lp.d, refTz);  // 0=Sun..6=Sat
    // step back to Monday of that ref-zone week
    const backToMon = (meetWd === 0) ? 6 : (meetWd - 1);
    const days = [];
    const pushWeek = (startY,startM,startD)=>{
      for(let i=0;i<5;i++){                       // Mon..Fri
        const dt = new Date(Date.UTC(startY, startM-1, startD+i));
        const y=dt.getUTCFullYear(), m=dt.getUTCMonth()+1, d=dt.getUTCDate();
        const iso = `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
        days.push({ iso, y, m, d });
      }
    };
    // Monday of the meeting week (in plain UTC date arithmetic on the ref date)
    pushWeek(lp.y, lp.m, lp.d - backToMon);
    if(meetWd === 4 || meetWd === 5){             // Thu/Fri => add next week too
      pushWeek(lp.y, lp.m, lp.d - backToMon + 7);
    }
    // label each day with weekday + date in the ref zone
    return days.map(day=>{
      const noonUtc = zonedWallToUtc(day.y, day.m, day.d, 12, 0, refTz);
      const dlp = localParts(noonUtc, refTz);
      return { ...day, label:`${dlp.wd} ${dlp.day} ${dlp.mon}` };
    });
  }

  const AVAIL_H_START = 7, AVAIL_H_END = 20;   // hours 07..20 inclusive

  // Build the weekly availability grid (rows = days, cols = hours in MY zone).
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
        // not color-only: free cells carry a check glyph + "free" text
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
        <p class="storage-note" style="margin-top:8px">Free = ✓ filled green · Busy = empty. Stored per day as the
          hours you marked free.</p>
      </div>`;
  }

  // true when the responder has answered "no" on every candidate slot.
  function allNo(){
    const slots = (poll.slots||[]);
    if(!slots.length) return false;
    return slots.every(s => (me.responses||{})[s.id] === "no");
  }

  function organizerName(){
    // organizer name isn't in poll.json; show a neutral phrasing if unknown
    return null;
  }

  function render(){
    if(submitted){ renderDashboard(); return; }
    const z = myZone(); myZoneTz = z?.tz || detectTz();
    const slots = [...(poll.slots||[])].sort((a,b)=>a.utc.localeCompare(b.utc));

    const rosterEntry = rosterId ? (poll.roster||[]).find(r=>r.rosterId===rosterId) : null;

    // verified == arrived with a valid roster &who AND a &t token. Those keep
    // the original token flow (no email). Everyone else is "central" (CHANGE 2).
    const verified = !!(rosterEntry && rawToken);

    // identity block
    let identHtml;
    if(verified){
      identHtml = `
        <p class="who-line">Responding as <b>${esc(me.name)}</b>
          — <button class="link" id="switchWho">not you? switch</button></p>`;
    } else if((poll.roster||[]).length){
      // name-select from roster fallback when no valid token
      const opts = (poll.roster||[]).map(r=>`<option value="${esc(r.rosterId)}" ${me.rosterPick===r.rosterId?"selected":""}>${esc(r.name)}</option>`).join("");
      identHtml = `
        <label class="fld">Who are you?</label>
        <select id="pickWho">
          <option value="">— choose your name —</option>
          ${opts}
          <option value="__guest__" ${me.guest&&me.name?"selected":""}>I'm not on the list (guest)</option>
        </select>
        <div id="guestNameWrap" style="margin-top:10px">
          <label class="fld">Your name</label>
          <input type="text" id="guestName" value="${esc(me.name||'')}" placeholder="Type your name">
        </div>`;
    } else {
      identHtml = `
        <label class="fld">Your name</label>
        <input type="text" id="guestName" value="${esc(me.name)}" placeholder="Type your name">`;
    }

    // CHANGE 2 — central voters MUST supply a syntactically valid email.
    // The raw email lives ONLY in this browser's localStorage; the committed
    // vote stores a SHA-256 hash, never the address.
    let emailHtml = "";
    if(me.viaCentral){
      const emailVal = esc(me.email||"");
      const bad = (me.email||"").trim() && !isValidEmail(me.email);
      emailHtml = `
        <label class="fld" style="margin-top:12px">Email <span style="color:var(--off)">(required)</span></label>
        <input type="email" id="respEmail" value="${emailVal}" placeholder="you@example.com" autocomplete="email">
        ${bad?`<div class="email-err" id="emailErr">Enter a valid email to continue.</div>`:`<div class="email-err hide" id="emailErr"></div>`}
        <div class="central-notice">Your name is shared with the organizer; your email is stored only as a
          private hash and is never shown to anyone.</div>`;
    }

    const slotHtml = slots.map(s=>{
      const utc=new Date(s.utc);
      const myLp = localParts(utc, myZoneTz);
      const myC = classify(myLp.min, myZone() || {ws:9*60,we:17*60});
      const refLp = localParts(utc, poll.refTz);
      const resp = me.responses?.[s.id] || null;
      const seg = ["yes","maybe","no"].map(opt=>{
        const labels={yes:"Yes",maybe:"Maybe",no:"No"};
        return `<button data-slot="${s.id}" data-resp="${opt}" ${resp===opt?`data-on="${opt}"`:""}>${labels[opt]}</button>`;
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
      <label class="fld" style="margin-top:14px">Your timezone (auto-detected: ${esc(detectTz())})</label>
      <select id="respZone">${(poll.zones||[]).map(z=>
        `<option value="${z.id}" ${z.id===me.zoneId?"selected":""}>${esc(z.label)}</option>`).join("")}</select>`;

    // CHANGE 3 — reveal the availability grid when the user marked "no" on
    // everything, or clicked the always-present "None of these work" link.
    const wantAvail = showAvail || allNo();
    const availLink = `
      <p style="margin-top:14px"><button class="link" id="noneWork">${wantAvail?"Hide weekly availability":"➕ Also share when you're free this week (optional — helps find a better time for everyone)"}</button></p>`;
    const availHtml = wantAvail ? availabilityGridHtml() : "";

    // privacy/trust line — accurate for both token and central voters.
    const trustLine = me.viaCentral
      ? `Who can see this: your <b>name</b> and your Yes/Maybe/No answers are committed to a public GitHub
         branch for this poll. Your <b>email is stored only as a private hash</b> (never the address, never shown).
         ${sharedMode?"":"(Local preview — nothing is sent anywhere.)"}`
      : `Who can see this: your name and your Yes/Maybe/No answers are committed to a public GitHub branch for
         this poll, visible to anyone with the repo link. No email is collected for token links.
         ${sharedMode?"":"(Local preview — nothing is sent anywhere.)"}`;

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
        <div id="saveState" class="save-state"></div>
      </div>
      <p class="trust">${trustLine}</p>
    </div>`;

    wire(slots);
  }

  function wire(slots){
    document.getElementById("switchWho")?.addEventListener("click", ()=>{
      // drop the resolved identity -> fall into the central form (email required)
      rosterId=null; rawToken=null;
      me.guest=true; me.viaCentral=true; me.name=""; me.rosterPick=null;
      render();
    });

    const pickWho=document.getElementById("pickWho");
    if(pickWho) pickWho.addEventListener("change", e=>{
      const v=e.target.value;
      // either way this is a token-less (central) responder: email required.
      me.viaCentral=true; rawToken=null;
      if(v==="__guest__"){ me.guest=true; me.name=""; me.rosterPick=null; rosterId=null; }
      else if(v){
        const r=(poll.roster||[]).find(x=>x.rosterId===v);
        me.guest=true; me.rosterPick=v; rosterId=v;   // no token -> recorded as central
        me.name=r?r.name:"";
      } else { me.rosterPick=null; me.name=""; }
      render();
    });
    document.getElementById("guestName")?.addEventListener("input", e=>{ me.name=e.target.value; });

    // CHANGE 2 — keep the raw email in memory + local-only; never committed.
    const emailEl=document.getElementById("respEmail");
    if(emailEl) emailEl.addEventListener("input", e=>{
      me.email=e.target.value;
      Store.set(emailLSKey(), me.email);              // remember for re-edit (this browser only)
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
        // re-render (also auto-reveals the availability grid once all are "no")
        render();
      });
    });

    // weekly availability grid — optional for everyone (Yes/Maybe/No), toggles open/closed.
    document.getElementById("noneWork")?.addEventListener("click", ()=>{
      showAvail = !(showAvail || allNo()); render();
      document.getElementById("availPanel")?.scrollIntoView({behavior:"smooth",block:"start"});
    });

    // availability cell toggles (click + keyboard).
    function toggleAvail(td){
      const iso=td.dataset.avday, h=parseInt(td.dataset.avh,10);
      me.availability=me.availability||{};
      const set=new Set(me.availability[iso]||[]);
      if(set.has(h)) set.delete(h); else set.add(h);
      me.availability[iso] = [...set].sort((a,b)=>a-b);
      if(!me.availability[iso].length) delete me.availability[iso];
      // toggle this cell in place (avoid a full re-render that loses scroll)
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

  // true once we have a verified token identity (roster &who + &t).
  function isVerified(){ return !!(rosterId && rawToken && !me.viaCentral); }

  // The voterKey this responder writes under, mirroring castVote's keying:
  //  - verified token vote  -> rosterId
  //  - central/guest vote   -> "c:"+emailHash.slice(0,16)  (CHANGE 2)
  // The async form computes the central hash; cachedCentralKey memoises it so
  // the (sync) poller can reuse it without recomputing.
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
    // CHANGE 2 — central voters must enter a syntactically valid email first.
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
      // unchanged token-vote shape, keyed by rosterId. No email.
      voterKey = rosterId;
      entry = {
        name, zoneId: me.zoneId, tz: myZoneTz,
        responses: { ...me.responses }, guest:false,
        updatedAt: nowISO
      };
    }else{
      // central/guest vote: email hashed, raw email NEVER committed (CHANGE 2).
      const emailHash = await sha256Hex((me.email||"").trim().toLowerCase());
      voterKey = "c:"+emailHash.slice(0,16);
      entry = {
        name, zoneId: me.zoneId, tz: myZoneTz,
        responses: { ...me.responses },
        guest:true, viaCentral:true,
        emailHash,                                   // NOT the raw email
        updatedAt: nowISO
      };
    }
    // CHANGE 3 — persist weekly availability if the responder supplied any.
    if(me.availability && Object.keys(me.availability).length){
      entry.availability = me.availability;
    }

    let res;
    try{ res = await Store.castVote({ pollId, voterKey, entry }); }
    catch(e){ res = { ok:false, error:e }; }

    document.getElementById("saveVote").disabled=false;
    saving=false;

    if(!sharedMode){
      // local preview — still show the dashboard so the flow is consistent
      submitted=true; if(pollTimer){clearInterval(pollTimer);pollTimer=null;} render(); return;
    }
    if(res && res.ok){
      submitted=true; if(pollTimer){clearInterval(pollTimer);pollTimer=null;} render();   // -> dashboard
    } else {
      // NEVER drop the user's picks — they remain in me.responses + local cache
      setState("err","Couldn't save — your picks are kept. Tap “Save my answers” to retry."
        + (res&&res.status?` (HTTP ${res.status})`:""));
    }
  }

  function setState(kind, msg){
    const el=document.getElementById("saveState"); if(!el) return;
    el.className="save-state"+(kind?" "+kind:""); el.textContent=msg;
  }

  // ---- post-submit dashboard: live tally + ability to change the response ----
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
    // reconcile from votes.json (~5s), but never discard the in-flight local key
    pollTimer=setInterval(async ()=>{
      const fresh = await Store.loadVotes(pollId);
      const protectKey = await voterKeyForMe();
      Store.mergeVotes(pollId, fresh, protectKey);   // keeps local optimistic copy
      // we do NOT re-render the responder over their in-progress picks; tally is hidden anyway.
    }, 5000);
  }

  // expose a dashboard re-render so the global convergence filter toggle can refresh it
  return { start, refreshDashboard: ()=>{ if(submitted) refreshDash(); } };
})();

/* ====================================================================
   8. INIT — route by hash
   ==================================================================== */
(async function init(){
  try{
    const h = parseHash();
    appMode = (h.poll && !h.admin) ? "responder" : "organizer";
    if(h.poll && !h.admin){
      // RESPONDER MODE
      await Responder.start(h);
    } else if(h.poll && h.admin){
      // ADMIN/RESULTS MODE — view a poll's live results from ANY device.
      // No localStorage dependency: poll + votes load straight from GitHub.
      await loadOrganizerState();
      await adoptRemotePoll(h.poll);
      organizerShell();
      setView("results");
    } else {
      // ORGANIZER MODE
      await loadOrganizerState();
      organizerShell();
      render();
      ensurePollLive();   // push a locally-created-but-not-yet-committed poll live
    }
  }catch(err){
    console.error(err);
    rootEl().innerHTML = `<div class="wrap"><div class="panel"><p class="note">Couldn't load: ${esc(err.message)}.
      Try reloading.</p></div></div>`;
  }
})();
// re-route if the hash changes (e.g. organizer pastes an invite link)
window.addEventListener("hashchange", ()=>{ location.reload(); });

function toggleBoardSlot(h) {
  const refTz = state.meta.refTz, weekday = state.meta.weekday;
  const now = new Date();
  const day = nearestWeekdayDate(now.getUTCFullYear(), now.getUTCMonth()+1, now.getUTCDate(), weekday, refTz);
  const utc = zonedWallToUtc(day.y, day.m, day.d, h, 0, refTz);
  const utcISO = typeof utc === 'string' ? utc : utc.toISOString();
  const existingIdx = state.slots.findIndex(s => Math.abs(Date.parse(s.utc) - Date.parse(utcISO)) < 1000);
  if (existingIdx >= 0) {
    state.slots.splice(existingIdx, 1);
  } else {
    state.slots.push({ utc: utcISO, d: state.meta.duration });
    state.slots.sort((a,b) => Date.parse(a.utc) - Date.parse(b.utc));
  }
  saveState();
  renderApp();
}
