const dtfCache = {};
function getDtf(locale, options) {
  const key = locale + JSON.stringify(options);
  if (!dtfCache[key]) dtfCache[key] = new Intl.DateTimeFormat(locale, options);
  return dtfCache[key];
}

export const WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
export const FULL_WD = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

export function tzOffsetMin(tz, date){
  const dtf = getDtf("en-US", {timeZone:tz, hour12:false,
    year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit"});
  const p = {}; 
  for(const x of dtf.formatToParts(date)) if(x.type!=="literal") p[x.type]=x.value;
  let h = parseInt(p.hour,10); if(h===24) h=0;
  const asUTC = Date.UTC(+p.year, +p.month-1, +p.day, h, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime())/60000);
}

export function zonedWallToUtc(y,mo,d,h,mi,tz){
  const guess = Date.UTC(y,mo-1,d,h,mi);
  let off = tzOffsetMin(tz, new Date(guess));
  let utc = guess - off*60000;
  off = tzOffsetMin(tz, new Date(utc));       // second pass: DST-boundary safe
  utc = guess - off*60000;
  return new Date(utc);
}

export function localParts(date, tz){
  const dtf = getDtf("en-GB", {timeZone:tz, weekday:"short",
    day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit", hour12:false});
  const p = {}; 
  for(const x of dtf.formatToParts(date)) if(x.type!=="literal") p[x.type]=x.value;
  let h = parseInt(p.hour,10); if(h===24) h=0;
  const m = parseInt(p.minute,10);
  return { min:h*60+m, hh:String(h).padStart(2,"0"), mm:String(m).padStart(2,"0"),
           wd:p.weekday, day:p.day, mon:p.month };
}

export function refWeekday(y,m,d,tz){
  const utc = zonedWallToUtc(y,m,d,12,0,tz);
  const dtf = getDtf("en-US", {timeZone:tz, weekday:"short"});
  return WD.indexOf(dtf.format(utc));
}

export function nearestWeekdayDate(y,m,d,target,tz){
  for(let off=0;off<7;off++){
    const dt = new Date(Date.UTC(y,m-1,d+off));
    if(refWeekday(dt.getUTCFullYear(), dt.getUTCMonth()+1, dt.getUTCDate(), tz)===target)
      return {y:dt.getUTCFullYear(), m:dt.getUTCMonth()+1, d:dt.getUTCDate()};
  }
  return {y,m,d};
}

export const fmtMin = m => String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0");

export function localPartsFull(date, tz){
  const dtf = getDtf("en-CA", {timeZone:tz, year:"numeric", month:"2-digit", day:"2-digit"});
  const p={}; 
  for(const x of dtf.formatToParts(date)) if(x.type!=="literal") p[x.type]=x.value;
  return { y:+p.year, m:+p.month, d:+p.day };
}

export function classify(localMin, z){
  if(localMin>=z.ws && localMin<z.we) return "work";
  if((localMin>=z.ws-90 && localMin<z.ws) || (localMin>=z.we && localMin<z.we+120)) return "edge";
  return "off";
}

export const CLASS_LABEL = {work:"Working hrs", edge:"Edge of day", off:"Outside hrs"};
