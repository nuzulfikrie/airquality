/* Sekolah Al-Amin and Boarding School Selangor Air Quality
 * Data sources (reverse-engineered from aqicn.org/airnet.js). All three public endpoints send
 * Access-Control-Allow-Origin: *, so on static hosting (GitHub Pages) the browser calls them directly:
 *   POST https://api.waqi.info/mapq/bounds          -> official WAQI/DOE stations (AQI + dominant pollutant)
 *   POST https://airnet.waqi.info/airnet/map/bounds -> AirNet community sensors (PM2.5 µg/m³)
 *   GET  https://airnet.waqi.info/airnet/feed/hourly/{id} -> latest reading + hourly PM2.5 series
 * On Cloudflare Pages the same calls go through same-origin Pages Functions under /api/ first.
 *   GET  /api/feed/{id}  (optional, Cloudflare only, needs WAQI_TOKEN) -> official station detail
 */
"use strict";

/* ---------- AQI helpers ---------- */
const EPA_STOPS=[[0,"#009966"],[50,"#ffde33"],[100,"#ff9933"],[150,"#cc0033"],[200,"#660099"],[300,"#7e0023"]];
function hx(h){return [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];}
function mix(a,b,t){const A=hx(a),B=hx(b);return "#"+A.map((v,i)=>{const c=Math.round(v+(B[i]-v)*t).toString(16);return c.length<2?"0"+c:c;}).join("");}
function aqiColor(v){
  if(!isFinite(v)||v<0) return "#cccccc";
  for(let i=1;i<EPA_STOPS.length;i++){
    if(v<=EPA_STOPS[i][0]){
      const [v0,c0]=EPA_STOPS[i-1],[v1,c1]=EPA_STOPS[i];
      return mix(c0,c1,(v-v0)/(v1-v0));
    }
  }
  return "#7e0023";
}
function aqiFg(v){return (v>=20&&v<=130)?"#000000":"#ffffff";}
function aqiLevel(v){
  if(!isFinite(v)||v<0) return ["No data","#888"];
  if(v<=50) return ["Good","#009966"];
  if(v<=100) return ["Moderate","#ffde33"];
  if(v<=150) return ["Unhealthy for Sensitive Groups","#ff9933"];
  if(v<=200) return ["Unhealthy","#cc0033"];
  if(v<=300) return ["Very Unhealthy","#660099"];
  return ["Hazardous","#7e0023"];
}
/* US EPA PM2.5 (µg/m³, 24-h basis) -> AQI, 2024 revision (in force since 6 May 2024).
 * EPA method: truncate the concentration to 0.1 µg/m³, interpolate linearly inside the band, round to an integer. */
const PM25_BP=[ // [Clow, Chigh, Ilow, Ihigh]
  [0.0,9.0,0,50],[9.1,35.4,51,100],[35.5,55.4,101,150],
  [55.5,125.4,151,200],[125.5,225.4,201,300],[225.5,325.4,301,500]];
function pm25ToAqi(c){
  if(!isFinite(c)||c<0) return NaN;
  const t=Math.floor(c*10+1e-9)/10;
  for(const [cl,ch,il,ih] of PM25_BP){
    if(t<=ch) return Math.round((ih-il)/(ch-cl)*(t-cl)+il);
  }
  return 500; /* above 325.4 µg/m³: beyond the index, capped at 500 */
}
const POL_LABEL={pm25:"PM2.5",pm10:"PM10",o3:"O₃",no2:"NO₂",so2:"SO₂",co:"CO"};
function polLabel(p){return p?(POL_LABEL[String(p).toLowerCase()]||String(p).toUpperCase()):"";}
function timeAgo(t){
  const m=Math.round((Date.now()-t.getTime())/60000);
  if(m<1) return "just now"; if(m<60) return m+" min ago";
  const h=Math.round(m/60); if(h<24) return h+" h ago";
  return Math.round(h/24)+" d ago";
}
const hav=(a,b,c,d)=>{const R=6371,r=x=>x*Math.PI/180;
  const h=Math.sin(r(c-a)/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(r(d-b)/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));};

/* ---------- network layer ---------- */
const MAX_KM=25;      /* nearest-station cutoff */
const PAD_DEG=0.25;   /* bbox half-width: 0.25° ≈ 27.8 km N-S, ≈ 27.7 km E-W at 3°N, so it covers MAX_KM */
const MAX_AGE_H=48;   /* ignore readings older than this */

/* Same-origin Pages Functions only exist on Cloudflare. On GitHub Pages / plain static hosting they 404/405,
 * so remember the first failure per proxy and go straight to the upstream API after that. */
const proxyDown={};
if(/\.github\.io$/i.test(location.hostname)||location.protocol==="file:"){
  proxyDown["waqi-map"]=proxyDown["airnet-map"]=proxyDown["airnet-feed"]=proxyDown.feed=true;
}
async function tryProxy(key,url,opts){
  if(proxyDown[key]) return null;
  try{
    const r=await fetch(url,opts);
    if(r.ok&&/json/i.test(r.headers.get("content-type")||"")) return await r.json();
  }catch(e){}
  proxyDown[key]=true;
  return null;
}
async function fetchJson(url,opts){
  const r=await fetch(url,opts);
  if(!r.ok) throw new Error(url.split("?")[0]+" HTTP "+r.status);
  return await r.json();
}
async function postWithFallback(key,sameOriginUrl,directUrl,contentType,body){
  const opts={method:"POST",headers:{"Content-Type":contentType},body};
  const j=await tryProxy(key,sameOriginUrl,opts);
  if(j!==null) return j;
  return await fetchJson(directUrl,opts);
}
/* One bbox covering every school ± PAD_DEG, fetched once per refresh and shared by all cards
 * (37 schools would otherwise mean 74 map requests every 10 minutes). b = {s,w,n,e} in degrees. */
function areaBounds(list,pad=PAD_DEG){
  const lats=list.map(s=>+s.lat), lons=list.map(s=>+s.lon);
  return {s:Math.min(...lats)-pad,w:Math.min(...lons)-pad,n:Math.max(...lats)+pad,e:Math.max(...lons)+pad};
}
async function waqiStationsIn(b){
  /* WAQI bounds order: lat1,lon1,lat2,lon2 */
  const body=new URLSearchParams({bounds:[b.s,b.w,b.n,b.e].join(","),
    inc:"placeholders",viewer:"webgl"}).toString();
  const j=await postWithFallback("waqi-map","/api/waqi-map","https://api.waqi.info/mapq/bounds",
    "application/x-www-form-urlencoded",body);
  if(!Array.isArray(j)) return [];
  /* aqi is a string; "-", "" and "placeholder" mean no data. `x` is the station id used by feed/@{id}
   * (verified: @2625 = Batu Muda); the map's `idx` field is a different id space and is not used. */
  return j.filter(s=>s&&s.x&&s.lat&&s.lon&&/^\d+$/.test(String(s.aqi).trim()))
    .map(s=>({src:"waqi",id:String(s.x),name:s.city||("station @"+s.x),
      lat:+s.lat,lon:+s.lon,aqi:parseInt(s.aqi,10),pol:s.pol||null,pm25:null,
      time:new Date(+s.stamp*1000)}));
}
async function airnetStationsIn(b){
  /* AirNet bounds order: lon1,lat1,lon2,lat2 */
  const body=JSON.stringify({bounds:[b.w,b.s,b.e,b.n].join(","),
    zoom:12,xscale:1000,width:800});
  const j=await postWithFallback("airnet-map","/api/airnet-map","https://airnet.waqi.info/airnet/map/bounds",
    "application/json",body);
  if(!j||!Array.isArray(j.data)) return [];
  const out=[];
  for(const s of j.data){
    /* g=[lat,lon], n=name, u=epoch s, c=PM2.5 µg/m³, a=AQI from upstream (legacy scale, -1 = no data),
     * x=sensor id, i=invalidated flag. We recompute the AQI from c with the 2024 breakpoints. */
    const c=parseFloat(s.c), u=+s.u;
    if(!Array.isArray(s.g)||s.i||!isFinite(c)||c<0||!(u>0)||parseInt(s.a,10)<0) continue;
    out.push({src:"airnet",id:String(s.x),name:s.n||("sensor "+s.x),lat:+s.g[0],lon:+s.g[1],
      pm25:c,aqi:pm25ToAqi(c),pol:"pm25",time:new Date(u*1000)});
  }
  return out;
}
async function airnetHourly(id){
  const path=encodeURIComponent(id);
  let j=await tryProxy("airnet-feed","/api/airnet-feed/"+path,{});
  if(j===null) j=await fetchJson("https://airnet.waqi.info/airnet/feed/hourly/"+path);
  /* Hourly series (data.pm25 is [] for dead sensors); keep the last 48 points for the sparkline. */
  const raw=(((j||{}).data||{}).pm25)||[];
  const series=raw.map(p=>{
    let t=p.time; if(typeof t==="number"&&t<1e12) t*=1000;
    return {t:new Date(t),v:parseFloat(p.mean)};
  }).filter(p=>isFinite(p.v)&&p.v>=0&&!isNaN(p.t.getTime()))
    .sort((a,b)=>a.t-b.t).slice(-48);
  /* Latest single reading: feed.pm25 = [epoch seconds, µg/m³ × 100] */
  let latest=null;
  const f=((j||{}).feed||{}).pm25;
  if(Array.isArray(f)&&f.length>=2&&+f[0]>0&&isFinite(+f[1])&&+f[1]>=0)
    latest={t:new Date(+f[0]*1000),v:+f[1]/100};
  return {latest,lastMean:series.length?series[series.length-1]:null,series};
}
async function waqiFeed(id){ /* Cloudflare-only proxy (WAQI_TOKEN); returns null when unavailable */
  const j=await tryProxy("feed","/api/feed/"+encodeURIComponent(id),{});
  if(!j||j.status!=="ok"||!j.data) return null;
  const d=j.data, iaqi=d.iaqi||{}, tm=d.time||{};
  let time=null;
  if(tm.iso) time=new Date(tm.iso);
  else if(tm.s&&tm.tz) time=new Date(tm.s.replace(" ","T")+tm.tz);
  if(time&&isNaN(time.getTime())) time=null;
  return {aqi:parseInt(d.aqi,10),pol:d.dominentpol||null,
    pm25Sub:iaqi.pm25?+iaqi.pm25.v:null, /* WAQI iaqi values are AQI sub-indices, not µg/m³ */
    time};
}

/* ---------- app state ---------- */
let SCHOOLS=[],map,cardEls={},schoolMarkers={},latest={},area=null,hourlyCache={},activeGroup="all";
const GROUPS={ /* order = card order; unknown groups fall back to "other" */
  alamin:{label:"Al-Amin",color:"#3b5875"},
  sam:{label:"SAM / SAMT",color:"#8a6a2f"},
  premier:{label:"Premier / SBP",color:"#2f7a66"},
  other:{label:"Other",color:"#5b6670"}};
const grpOf=s=>GROUPS[s.group]?s.group:"other";
const $=s=>document.querySelector(s);

function initMap(){
  map=L.map("map",{scrollWheelZoom:true}).setView([3.10,101.55],10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
}
function initLegend(){
  const rows=[[0,50,"Good"],[51,100,"Moderate"],[101,150,"USG"],[151,200,"Unhealthy"],
              [201,300,"Very Unhealthy"],[301,500,"Hazardous"]];
  $("#legend").innerHTML="<b style='color:#cfe0ee'>US AQI</b>"+rows.map(r=>{
    const v=(r[0]+r[1])/2;
    return `<div class="li"><span class="sw" style="background:${aqiColor(v)}"></span>${r[2]} (${r[0]}–${r[1]==500?"500+":r[1]})</div>`;
  }).join("");
}
function schoolIcon(i,s){
  return L.divIcon({className:"school-ico",
    html:`<div class="school-pin" style="background:${GROUPS[grpOf(s)].color}"><span>${i+1}</span></div>`,
    iconSize:[26,26],iconAnchor:[13,26],popupAnchor:[0,-24]});
}
function renderFilters(){
  const nav=$("#filters"); if(!nav) return;
  const keys=Object.keys(GROUPS).filter(k=>SCHOOLS.some(s=>grpOf(s)===k));
  if(keys.length<2){nav.style.display="none";return;}
  const btn=(k,label,color,n)=>`<button class="chip-btn${k===activeGroup?" on":""}" data-g="${k}">`+
    (color?`<span class="dot" style="background:${color}"></span>`:"")+`${label} <small>${n}</small></button>`;
  nav.innerHTML=btn("all","All",null,SCHOOLS.length)+
    keys.map(k=>btn(k,GROUPS[k].label,GROUPS[k].color,SCHOOLS.filter(s=>grpOf(s)===k).length)).join("");
  nav.querySelectorAll("button").forEach(b=>b.onclick=()=>applyFilter(b.dataset.g));
}
function applyFilter(g){
  activeGroup=g;
  document.querySelectorAll("#filters button").forEach(b=>b.classList.toggle("on",b.dataset.g===g));
  SCHOOLS.forEach(s=>{
    const show=g==="all"||grpOf(s)===g;
    cardEls[s.id].style.display=show?"":"none";
    const m=schoolMarkers[s.id];
    if(show&&!map.hasLayer(m)) m.addTo(map); else if(!show&&map.hasLayer(m)) map.removeLayer(m);
  });
  updateOverall();
}
function renderCards(){
  const grid=$("#cards"); grid.innerHTML="";
  SCHOOLS.forEach((s,i)=>{
    const el=document.createElement("div");
    el.className="card"; el.id="card-"+s.id;
    el.innerHTML=`<div class="nm">${i+1}. ${s.name}</div>
      <div class="cmp"><span class="gtag" style="border-color:${GROUPS[grpOf(s)].color}">${s.short||GROUPS[grpOf(s)].label}</span> ${s.campus}${s.approx?' <span title="approximate coordinates">≈</span>':""}</div>
      <div class="row"><div class="aqi-chip" style="background:#243442;color:#9fb2c4">
        <div class="v">…</div><div class="l">loading</div></div>
        <div class="pm"><span class="dom">US AQI</span><br>PM<sub>2.5</sub> <b>—</b> <span class="u">µg/m³</span></div></div>
      <div class="stn">finding nearest station…</div>
      <svg class="spark" viewBox="0 0 200 56" preserveAspectRatio="none"></svg>`;
    el.onclick=()=>{
      const m=schoolMarkers[s.id];
      if(m){map.flyTo(m.getLatLng(),13,{duration:.8});m.openPopup();}
    };
    grid.appendChild(el); cardEls[s.id]=el;
  });
  SCHOOLS.forEach((s,i)=>{
    const m=L.marker([s.lat,s.lon],{icon:schoolIcon(i,s)}).addTo(map);
    m.bindPopup(`<b>${s.name}</b><br>${s.campus}<br><span id="popup-${s.id}">loading…</span>`);
    schoolMarkers[s.id]=m;
  });
}
function setCard(sid,d){
  const el=cardEls[sid]; if(!el) return;
  const chip=el.querySelector(".aqi-chip"), pmEl=el.querySelector(".pm"),
        stn=el.querySelector(".stn"), spark=el.querySelector(".spark");
  if(d.error){
    el.classList.add("stale");
    chip.style.background="#243442";chip.style.color="#9fb2c4";
    chip.querySelector(".v").textContent="–";chip.querySelector(".l").textContent="offline";
    stn.innerHTML=`<span class="err">${d.error}</span>`; spark.innerHTML="";
    latest[sid]=d; updateOverall(); return;
  }
  el.classList.remove("stale");
  const [lvl]=aqiLevel(d.aqi), pol=polLabel(d.pol);
  chip.style.background=aqiColor(d.aqi);chip.style.color=aqiFg(d.aqi);
  chip.querySelector(".v").textContent=Math.round(d.aqi);
  chip.querySelector(".l").textContent=lvl.split(" ")[0].toUpperCase();
  const aqiTxt=`AQI ${Math.round(d.aqi)}${pol?" · "+pol:""}`;
  let pmTxt;
  if(d.pm25!=null) pmTxt=`PM<sub>2.5</sub> <b>${d.pm25.toFixed(1)}</b> µg/m³`;
  else if(d.pm25Sub!=null&&isFinite(d.pm25Sub)) pmTxt=`PM<sub>2.5</sub> sub-index <b>${Math.round(d.pm25Sub)}</b>`;
  else pmTxt=`PM<sub>2.5</sub> <b>—</b> <span title="official stations publish the AQI only">µg/m³ n/a</span>`;
  pmEl.innerHTML=`<span class="dom" title="dominant pollutant behind this AQI">${aqiTxt}</span><br>${pmTxt}`;
  const staleH=(Date.now()-d.time.getTime())/36e5;
  el.classList.toggle("stale",staleH>24);
  stn.innerHTML=`<b>${d.station}</b> · ${d.src==="waqi"?"official":"AirNet"} · ${d.km.toFixed(1)} km<br>`+
    (staleH>24?"⚠ stale data · ":"")+timeAgo(d.time);
  const pop=document.getElementById("popup-"+sid);
  if(pop) pop.innerHTML=`${aqiTxt} (${lvl})<br>PM2.5: ${d.pm25!=null?d.pm25.toFixed(1)+" µg/m³":"—"}<br>${timeAgo(d.time)}`;
  spark.innerHTML="";
  if(d.series&&d.series.length>1){
    const w=200,h=56,n=d.series.length,bw=w/n;
    spark.innerHTML=d.series.map((p,i)=>{
      const a=pm25ToAqi(p.v),bh=Math.max(2,(Math.min(a,300)/300)*(h-6));
      return `<rect x="${(i*bw).toFixed(1)}" y="${(h-bh).toFixed(1)}" width="${Math.max(1,bw-0.6).toFixed(1)}" height="${bh.toFixed(1)}" fill="${aqiColor(a)}"><title>${p.t.toLocaleString()} — ${p.v.toFixed(1)} µg/m³ (AQI ${a})</title></rect>`;
    }).join("");
  }
  latest[sid]=d;
  updateOverall();
}
function updateOverall(){
  const shown=SCHOOLS.filter(s=>activeGroup==="all"||grpOf(s)===activeGroup);
  const vals=shown.map(s=>latest[s.id]).filter(d=>d&&!d.error&&isFinite(d.aqi));
  if(!vals.length){$("#overall").textContent="–";return;}
  const avg=vals.reduce((a,b)=>a+b.aqi,0)/vals.length;
  const el=$("#overall");
  el.textContent=`School avg US AQI ${Math.round(avg)} · ${vals.length}/${shown.length} online`;
  el.style.background=aqiColor(avg); el.style.color=aqiFg(avg);
}

/* ---------- main load ---------- */
async function loadSchool(s){
  try{
    const [w,a]=await area;
    let cands=[];
    if(w.status==="fulfilled") cands.push(...w.value); else console.warn(s.id,"WAQI",w.reason);
    if(a.status==="fulfilled") cands.push(...a.value); else console.warn(s.id,"AirNet",a.reason);
    cands=cands.map(c=>({...c,dist:hav(s.lat,s.lon,c.lat,c.lon)}))
               .filter(c=>c.dist<MAX_KM&&(Date.now()-c.time.getTime())<MAX_AGE_H*36e5);
    if(!cands.length) throw new Error("no station within "+MAX_KM+" km");
    cands.sort((x,y)=>x.dist-y.dist);
    const best=cands[0];
    const card={aqi:best.aqi,pol:best.pol,pm25:null,pm25Sub:null,time:best.time,
      station:best.name,src:best.src,km:best.dist,series:null};
    if(best.src==="airnet"){
      /* One PM2.5 number drives both the AQI and the µg/m³ shown: the newest of feed.pm25 and the map's c,
       * falling back to the last hourly mean. */
      let reading={v:best.pm25,t:best.time};
      try{
        const h=await (hourlyCache[best.id]||(hourlyCache[best.id]=airnetHourly(best.id)));
        card.series=h.series;
        if(h.latest&&h.latest.t>=reading.t) reading=h.latest;
        else if(!isFinite(reading.v)&&h.lastMean) reading=h.lastMean;
      }catch(e){ console.warn(s.id,"AirNet hourly",e); }
      card.pm25=reading.v; card.aqi=pm25ToAqi(reading.v); card.time=reading.t; card.pol="pm25";
    }else{
      const f=await waqiFeed(best.id); /* null without the Cloudflare WAQI_TOKEN proxy: AQI only */
      if(f){
        if(f.pm25Sub!=null) card.pm25Sub=f.pm25Sub;
        if(!card.pol&&f.pol) card.pol=f.pol;
      }
    }
    setCard(s.id,card);
  }catch(e){
    console.warn(s.id,e);
    setCard(s.id,{error:e.message||"failed to load"});
  }
}
async function refreshAll(){
  $("#refresh").textContent="…";
  latest={}; hourlyCache={};
  const b=areaBounds(SCHOOLS);
  area=Promise.allSettled([waqiStationsIn(b),airnetStationsIn(b)]);
  await Promise.allSettled(SCHOOLS.map(loadSchool));
  $("#updated").textContent=new Date().toLocaleString();
  $("#refresh").textContent="↻";
}

(async function boot(){
  initMap(); initLegend();
  const res=await fetch("data/schools.json");
  const j=await res.json();
  /* group order (alamin, sam, premier, other), file order inside each group */
  const order=Object.keys(GROUPS);
  SCHOOLS=j.schools.map((s,i)=>({s,i}))
    .sort((a,b)=>order.indexOf(grpOf(a.s))-order.indexOf(grpOf(b.s))||a.i-b.i).map(x=>x.s);
  renderCards(); renderFilters();
  refreshAll();
  setInterval(refreshAll,10*60*1000);
  $("#refresh").onclick=refreshAll;
})();
