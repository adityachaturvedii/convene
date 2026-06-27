export const URLSAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function randomToken(len){
  len = len || 22;
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let s = "";
  for(let i=0;i<len;i++) s += URLSAFE[arr[i] % URLSAFE.length];
  return s;
}

export async function sha256Hex(str){
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

export function isValidEmail(s){
  s = String(s||"").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export function slugify(s){
  const slug = String(s||"")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g,"")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"");
  return slug || "guest";
}

export const uid = () => Math.random().toString(36).slice(2,9);

export const esc = s => String(s??"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

export function parseHash(){
  const h={}; 
  location.hash.replace(/^#/,"").split("&").forEach(p=>{
    const[k,v]=p.split("="); if(k) h[k]=v?decodeURIComponent(v):true;
  });
  return h;
}
