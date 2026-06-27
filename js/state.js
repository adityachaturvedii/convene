import { Store, GHIO, sharedMode } from "./github-store.js";
import { sha256Hex, uid } from "./utils.js";
import { nearestWeekdayDate, zonedWallToUtc, tzOffsetMin, classify, localParts } from "./tz-engine.js";

export const DEFAULTS = {
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
  slots:[]
};

export const COMMON_TZS = ["Europe/Berlin","Europe/Budapest","Australia/Melbourne","Australia/Sydney",
  "Asia/Kolkata","Asia/Tokyo","Asia/Shanghai","Europe/London","America/New_York","America/Los_Angeles","UTC"];

export let state = { meta:{...DEFAULTS.meta}, zones:DEFAULTS.zones.map(z=>({...z})), roster:DEFAULTS.roster.map(r=>({...r})), slots:[], votes:{}, pollId:null, organizer:"", invites:null };
export let appState = { view: "overlap", appMode: "organizer", convergeAllOnly: false };

export function setView(v) { appState.view = v; }
export function setAppMode(m) { appState.appMode = m; }
export function setConvergeAllOnly(c) { appState.convergeAllOnly = c; }

export function detectTz(){
  try{ return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch(e){ return "UTC"; }
}

export async function loadOrganizerState(){
  state.meta   = await Store.get("meta")   || {...DEFAULTS.meta};
  state.zones  = await Store.get("zones")  || DEFAULTS.zones.map(z=>({...z}));
  state.roster = await Store.get("roster") || DEFAULTS.roster.map(r=>({...r}));
  state.slots  = await Store.get("slots");
  if(!state.slots){ state.slots = seedSlots(); await Store.set("slots", state.slots); }
  state.organizer = await Store.get("organizer") || "";
  state.organizerEmail = await Store.get("organizerEmail") || "";
  state.pollId    = await Store.get("currentPollId") || null;
  state.invites   = await Store.get("invites:"+(state.pollId||"")) || null;
  state.votes = state.pollId ? (await Store.loadVotes(state.pollId)) : {};
}

export function seedSlots(){
  const wd = DEFAULTS.meta.weekday, refTz = DEFAULTS.meta.refTz;
  const now = new Date();
  const base = nearestWeekdayDate(now.getUTCFullYear(), now.getUTCMonth()+1, now.getUTCDate()+3, wd, refTz);
  const mk = (h,m,lbl) => ({ id:"s_"+uid(), utc: zonedWallToUtc(base.y,base.m,base.d,h,m,refTz).toISOString(), label:lbl });
  return [ mk(9,0,"Inside overlap"), mk(11,0,"Current proposal"), mk(8,30,"Early CEST") ];
}

const normId = s => String(s||"").trim().toLowerCase();

export async function indexMyPoll(pollId, title, meetingDateISO, name, email){
  if(!sharedMode) return;
  name = (name||"").trim();
  if(!name) return;
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

export async function unindexMyPoll(pollId, name, email){
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

export async function lookupMyPolls(value){
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
  return { needEmail:true };
}

export async function adoptRemotePoll(pollId){
  state.pollId = pollId;
  const poll = await Store.loadPoll(pollId);
  if(poll){
    state.meta = { ...state.meta,
      title: poll.title || state.meta.title,
      refTz: poll.refTz || state.meta.refTz,
      weekday: (poll.weekday!=null ? poll.weekday : state.meta.weekday),
      duration: poll.duration || state.meta.duration };
    if(Array.isArray(poll.zones) && poll.zones.length) state.zones = poll.zones.map(z=>({...z}));
    if(Array.isArray(poll.slots)) state.slots = poll.slots.map(s=>({...s}));
    // adopt the published roster (names + zone; emails are never on the branch)
    if(Array.isArray(poll.roster)) state.roster = poll.roster.map(r=>({ id:r.rosterId, name:r.name, email:"", zoneId:r.zoneId }));
  }
  state.votes = await Store.loadVotes(pollId) || {};
}

export async function saveMeta(){ await Store.set("meta", state.meta); }
export async function saveZones(){ await Store.set("zones", state.zones); }
export async function saveRoster(){ await Store.set("roster", state.roster); }
export async function saveSlots(){ await Store.set("slots", state.slots); }

export const zoneById = id => state.zones.find(z=>z.id===id);
export const peopleInZone = id => state.roster.filter(r=>r.zoneId===id).length;

export function currentGap(){
  const cest = state.zones.find(z=>z.tz==="Europe/Berlin") || state.zones[0];
  const aest = state.zones.find(z=>z.tz==="Australia/Melbourne") || state.zones[1] || state.zones[0];
  if(!cest || !aest) return null;
  const now = new Date();
  const g = (tzOffsetMin(aest.tz,now) - tzOffsetMin(cest.tz,now))/60;
  return { hours:g, a:aest, b:cest };
}

export function computeRecommendation(weekday){
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
