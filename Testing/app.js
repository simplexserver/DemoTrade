(()=>{'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const safeText=(sel,txt)=>{const el=$(sel);if(el)el.textContent=txt};
const safeHTML=(sel,html)=>{const el=$(sel);if(el)el.innerHTML=html};
const K='gt.v3',PAY=.95,START=1e4,DMS=6e4,T0=Date.now()-900*DMS;
const DEF={stake:5,dur:5,durL:60,maxStake:50,maxOpen:3,riskPct:2,dailyLoss:500,regime:'auto',vol:1,drift:0,speed:4,tpc:20,strat:'trend',autoSel:true,autoOn:false,theme:'midnight',src:'demo',prod:'BTC-USD',gran:60,tv:'COINBASE:BTCUSD'};
const NUM=new Set(['stake','dur','durL','maxStake','maxOpen','riskPct','dailyLoss','vol','drift','speed','tpc']);
const S={...DEF,...JSON.parse(localStorage.getItem(K)||'{}')};
const F={demo:{C:[],p:100,ser:0,reg:'range',anchor:100,mom:0,vol:1},live:{C:[],p:0,at:0}};
const V={bars:70,off:0,auto:true,lo:0,hi:0},RX=56;
let bal=START,OPEN=[],DONE=[],EQ=[START],mode=S.src,GRAN=S.gran,shown=START,hx=-1,ehx=-1,lastNote='',dp=null,TAPE=[],ST={},feed='connecting',timer=0;
try{const st=JSON.parse(localStorage.getItem(K+'.st')||'null');if(st){bal=st.bal;OPEN=st.open||[];DONE=st.done||[];EQ=st.eq||[START]}}catch(e){}
const cv=$('#chart'),tip=$('#tip'),sp=$('#spark'),ec=$('#eqc');
const cx=cv?cv.getContext('2d'):null,spx=sp?sp.getContext('2d'):null,ex=ec?ec.getContext('2d'):null;
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const money=v=>(v<0?'-':'')+'$'+Math.abs(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const sgn=v=>(v>=0?'+':'')+money(v);
const fmtP=v=>v>=100?v.toFixed(2):v>=1?v.toFixed(3):v.toFixed(5);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sum=a=>a.reduce((s,t)=>s+t.pnl,0);
const eqv=()=>bal+OPEN.reduce((a,t)=>a+t.stake,0);
const won=(t,p)=>t.dir==='up'?p>t.entry:p<t.entry;
const projOf=t=>won(t,F[t.mode].p)?t.stake*PAY:-t.stake;
const panelOn=n=>$('#p-'+n).classList.contains('on');
const save=()=>{localStorage.setItem(K,JSON.stringify(S));localStorage.setItem(K+'.st',JSON.stringify({bal,open:OPEN,done:DONE.slice(0,300),eq:EQ.slice(-600)}))};
function toast(m,k){const t=$('#toast');if(!t)return;t.textContent=m;t.className='toast on '+(k||'');clearTimeout(toast.h);toast.h=setTimeout(()=>t.classList.remove('on'),2400)}
function note(m){if(m===lastNote)return;lastNote=m;const L=$('#alog');if(!L)return;const d=document.createElement('div');d.textContent=new Date().toLocaleTimeString()+'  '+m;L.prepend(d);while(L.children.length>40)L.lastChild.remove()}

const RG={up:[5e-4,8e-4],down:[-5e-4,8e-4],range:[0,6e-4],crash:[-2.5e-3,3e-3],spike:[0,4e-3]};
const NX={up:['up','range','spike'],down:['down','range','crash'],range:['range','up','down'],crash:['down','range'],spike:['range','up']};
const gauss=()=>Math.sqrt(-2*Math.log(Math.random()||1e-12))*Math.cos(6.283185*Math.random());
function step(d){
  if(S.regime==='auto'&&Math.random()<.008){const n=NX[d.reg];d.reg=n[(Math.random()*n.length)|0]}
  const R=S.regime==='auto'?d.reg:S.regime,[mu,sg]=RG[R];
  d.vol=clamp(d.vol*Math.exp(gauss()*.05),.4,3);
  d.mom=d.mom*.85+gauss()*sg*.6;
  let r=mu+S.drift*8e-4+d.mom+sg*S.vol*d.vol*gauss();
  if(R==='range')r+=(d.anchor-d.p)/d.p*.04;
  if(Math.random()<.002)r+=(Math.random()<.5?-1:1)*(.002+Math.random()*.006);
  d.p*=Math.exp(r);d.anchor*=Math.exp(gauss()*5e-4);
}
function demoNew(){const d=F.demo,c={s:d.ser++,t:T0+d.ser*DMS,o:d.p,h:d.p,l:d.p,c:d.p,n:0,eq:0};d.C.push(c);if(d.C.length>900)d.C.shift();return c}
function demoTick(warm){
  const d=F.demo;step(d);
  let c=d.C[d.C.length-1]||demoNew();
  if(c.n>=S.tpc){if(warm)c.eq=START;else shut('demo',c);c=demoNew()}
  c.h=Math.max(c.h,d.p);c.l=Math.min(c.l,d.p);c.c=d.p;c.n++;
  if(!warm)for(const t of OPEN.slice())if(t.mode==='demo'&&++t.ticks>=t.dur)settle(t);
}
function shut(store,c){
  c.eq=eqv();
  if(!S.autoOn||mode!==store||OPEN.some(t=>t.who==='auto'))return;
  const k=pick(),sig=STR[k](F[store].C);
  if(!sig)return;
  const e=openT(sig,S.stake,'auto',k);
  note(e||((sig==='up'?'Rise ':'Fall ')+money(S.stake)+' via '+k));
}
function liveTrade(p,ts){
  const L=F.live,ms=GRAN*1e3,b=Math.floor((ts||Date.now())/ms)*ms;
  let c=L.C[L.C.length-1];
  if(c&&c.t>b)return;
  if(!c||c.t<b){if(c)shut('live',c);c={t:b,o:p,h:p,l:p,c:p,n:0,eq:0};L.C.push(c);if(L.C.length>900)L.C.shift()}
  c.h=Math.max(c.h,p);c.l=Math.min(c.l,p);c.c=p;c.n++;L.p=p;L.at=Date.now();
}
async function seedLive(){
  const p=S.prod,g=S.gran;F.live.C=[];F.live.p=0;TAPE=[];ST={};
  try{const h=await Live.candles(p,g);if(p!==S.prod||g!==S.gran)return;F.live.C=h;if(h.length&&!F.live.p)F.live.p=h[h.length-1].c}
  catch(e){toast('History unavailable. The chart fills in from live trades.','bad')}
}
const avgC=(a,n)=>a.slice(-n).reduce((s,c)=>s+c.c,0)/n;
const STR={
  trend:a=>a.length<21?null:avgC(a,5)>avgC(a,20)?'up':avgC(a,5)<avgC(a,20)?'down':null,
  rsi:a=>{if(a.length<15)return null;let g=0,l=0;for(let i=a.length-14;i<a.length;i++){const d=a[i].c-a[i-1].c;d>0?g+=d:l-=d}const r=l?100-100/(1+g/l):100;return r<30?'up':r>70?'down':null},
  brk:a=>{if(a.length<12)return null;const L=a.slice(-11,-1),hi=Math.max(...L.map(c=>c.h)),lo=Math.min(...L.map(c=>c.l)),x=a[a.length-1].c;return x>hi?'up':x<lo?'down':null}
};
function pick(){
  if(!S.autoSel)return S.strat;
  let best=S.strat,be=-Infinity;
  for(const k in STR){const ts=DONE.filter(t=>t.strat===k);if(ts.length<30)continue;const e=sum(ts)/ts.length;if(e>be){be=e;best=k}}
  return best;
}
function todayPL(){const d=new Date().toDateString();return sum(DONE.filter(t=>new Date(t.done).toDateString()===d))}
function check(st){
  if(mode==='tv')return 'Switch to Demo or Live to trade.';
  if(mode==='live'&&(!F.live.p||Date.now()-F.live.at>2e4))return 'Waiting for a fresh live price.';
  if(!(st>0))return 'Stake must be above zero.';
  if(st>S.maxStake)return 'Stake is above your max of '+money(S.maxStake)+'.';
  if(st>bal)return 'Not enough balance for this stake.';
  if(st>bal*S.riskPct/100)return 'Stake is above '+S.riskPct+'% of your balance.';
  if(OPEN.length>=S.maxOpen)return 'Max '+S.maxOpen+' open positions reached.';
  if(todayPL()<=-S.dailyLoss)return 'Daily loss limit hit. New trades are blocked until tomorrow.';
  return '';
}
function openT(dir,st,who,strat){
  const e=check(st);
  if(e){if(who==='manual')toast(e,'bad');return e}
  bal-=st;
  const f=F[mode],now=Date.now();
  OPEN.push({id:Math.random().toString(36).slice(2),mode,dir,stake:st,dur:S.dur,ticks:0,entry:f.p,who,strat,ci:F.demo.C[F.demo.C.length-1].s,ct:now,expAt:now+S.durL*1e3});
  if(who==='manual')toast((dir==='up'?'Rise ':'Fall ')+money(st)+' opened','ok');
  save();return '';
}
function settle(t){
  const win=won(t,F[t.mode].p),pnl=win?t.stake*PAY:-t.stake;
  bal+=t.stake+pnl;
  Object.assign(t,{pnl:+pnl.toFixed(2),win,done:Date.now()});
  OPEN=OPEN.filter(x=>x!==t);DONE.unshift(t);if(DONE.length>500)DONE.length=500;
  EQ.push(eqv());if(EQ.length>1000)EQ.shift();
  toast((win?'Won ':'Lost ')+money(Math.abs(pnl))+' on '+(t.dir==='up'?'Rise':'Fall'),win?'ok':'bad');
  save();
}
function pulse(){for(const t of OPEN.slice())if(t.mode==='live'&&Date.now()>=t.expAt)settle(t)}
function stats(){
  const n=DONE.length,W=DONE.filter(t=>t.win),L=DONE.filter(t=>!t.win);
  const wr=n?W.length/n:0,aw=W.length?sum(W)/W.length:0,al=L.length?sum(L)/L.length:0;
  let pk=-Infinity,dd=0;for(const v of EQ){pk=Math.max(pk,v);dd=Math.max(dd,pk-v)}
  const gl=-sum(L);
  return{n,wr,aw,al,ex:wr*aw+(1-wr)*al,dd,pf:gl?sum(W)/gl:0};
}
function renderStats(){
  const s=stats(),cell=(l,v,c)=>`<div class="stat"><span>${l}</span><em class="${c||''}">${v}</em></div>`;
  safeHTML('#stats',[cell('Trades',s.n),cell('Win rate',(s.wr*100).toFixed(1)+'%'),cell('Average win',sgn(s.aw),'up'),cell('Average loss',sgn(s.al),'dn'),cell('Expectancy',sgn(s.ex),s.ex>=0?'up':'dn'),cell('Max drawdown',money(s.dd),'dn'),cell('Profit factor',s.n&&s.pf?s.pf.toFixed(2):'n/a'),cell('Net result',sgn(eqv()-START),eqv()>=START?'up':'dn')].join(''));
}
function renderHist(){
  safeHTML('#hist','<tr><th>Time</th><th>Market</th><th>Side</th><th>Stake</th><th>Result</th><th>Strategy</th></tr>'+DONE.slice(0,60).map(t=>`<tr><td>${new Date(t.done).toLocaleTimeString()}</td><td>${t.mode}</td><td>${t.dir==='up'?'Rise':'Fall'}</td><td>${money(t.stake)}</td><td class="${t.pnl>=0?'up':'dn'}">${sgn(t.pnl)}</td><td>${esc(t.strat)}</td></tr>`).join(''));
}
function renderMarket(){
  const p=ST.price||0,ch=ST.open?(p-ST.open)/ST.open*100:0;
  $('#cpx').textContent=p?fmtP(p):'—';
  $('#cch').innerHTML=p?`<span class="${ch>=0?'up':'dn'}">${ch>=0?'+':''}${ch.toFixed(2)}% 24h</span>`:'';
  $('#cstats').innerHTML=p?[['24h high',fmtP(ST.hi)],['24h low',fmtP(ST.lo)],['24h volume',Math.round(ST.vol||0).toLocaleString()],['Feed',feed]].map(([l,v])=>`<div class="stat"><span>${l}</span><em>${v}</em></div>`).join(''):'';
  $('#tape').innerHTML=TAPE.map((t,i)=>{const pv=TAPE[i+1]?TAPE[i+1].p:t.p;return `<div><span class="${t.p>=pv?'up':'dn'}">${fmtP(t.p)}</span><span class="lbl">${t.q.toFixed(4)}</span><span class="lbl">${new Date(t.t).toLocaleTimeString()}</span></div>`}).join('')||'<p class="lbl">Waiting for trades…</p>';
  $('#fst').textContent='Coinbase '+S.prod+', '+feed;
}
function ui(){
  safeHTML('#pos',OPEN.length?OPEN.map(t=>`<div class="pos"><span>${t.dir==='up'?'Rise':'Fall'} ${money(t.stake)} ${t.mode}${t.who==='auto'?' auto':''}</span><span class="${projOf(t)>=0?'up':'dn'}">${sgn(projOf(t))}</span><span class="lbl">${t.mode==='live'?Math.max(0,Math.ceil((t.expAt-Date.now())/1e3))+'s left':(t.dur-t.ticks)+' ticks left'}</span></div>`).join(''):'<p class="lbl">None open.</p>');
  safeText('#risk',check(S.stake)||'Within limits');
  safeText('#feedline',mode==='live'?`${S.prod} ${F.live.p?fmtP(F.live.p):'…'}, feed ${feed}`:mode==='demo'?'Demo market, practice prices':'Embedded chart, no trading');
  renderMarket();
  if(panelOn('analytics')){renderStats();renderHist()}
  setTimeout(ui,400);
}

function fit(el,g){if(!el||!g)return[0,0];const r=el.getBoundingClientRect(),d=window.devicePixelRatio||1;if(el.width!==Math.round(r.width*d)||el.height!==Math.round(r.height*d)){el.width=Math.round(r.width*d);el.height=Math.round(r.height*d)}g.setTransform(d,0,0,d,0,0);g.clearRect(0,0,r.width,r.height);return[r.width,r.height]}
function palette(){const s=getComputedStyle(document.documentElement),g=n=>s.getPropertyValue(n).trim();return{up:g('--up'),dn:g('--dn'),line:g('--line'),mu:g('--muted'),acc:g('--acc')}}
function drawChart(k){
  if(mode==='tv'||!cv||!cx)return;
  const[W,H]=fit(cv,cx);if(!W||!H)return;
  const src=F[mode],C=src.C;
  cx.textBaseline='middle';cx.font='11px Outfit,sans-serif';
  if(!C.length){cx.fillStyle=k.mu;cx.font='13px Outfit,sans-serif';cx.fillText(mode==='live'?'Loading live candles…':'Warming up the market…',14,28);return}
  V.bars=clamp(V.bars,12,240);V.off=clamp(Math.round(V.off),0,Math.max(0,C.length-8));
  const n=Math.round(V.bars),e=C.length-V.off,v=C.slice(Math.max(0,e-n),e),m=v.length,cw=W-RX,bw=cw/n,o=(n-m)*bw;
  const X=i=>o+i*bw+bw/2;
  let lo=Infinity,hi=-Infinity;for(const c of v){if(c.l<lo)lo=c.l;if(c.h>hi)hi=c.h}
  const pad=(hi-lo)*.12||.5;
  if(V.auto){if(!V.hi){V.lo=lo-pad;V.hi=hi+pad}V.lo+=(lo-pad-V.lo)*.15;V.hi+=(hi+pad-V.hi)*.15}
  const Y=x=>H-(x-V.lo)/(V.hi-V.lo)*H;
  for(let i=0;i<=4;i++){const y=H*i/4;cx.strokeStyle=k.line;cx.globalAlpha=.6;cx.lineWidth=1;cx.beginPath();cx.moveTo(0,y);cx.lineTo(cw,y);cx.stroke();cx.globalAlpha=1;cx.fillStyle=k.mu;cx.fillText(fmtP(V.hi-(V.hi-V.lo)*i/4),cw+6,y)}
  v.forEach((c,i)=>{const q=c.c>=c.o?k.up:k.dn,x=X(i),a=Y(Math.max(c.o,c.c)),b=Y(Math.min(c.o,c.c));cx.strokeStyle=q;cx.fillStyle=q;cx.beginPath();cx.moveTo(x,Y(c.h));cx.lineTo(x,Y(c.l));cx.stroke();cx.fillRect(x-bw*.32,a,Math.max(1,bw*.64),Math.max(1,b-a))});
  for(const t of OPEN.concat(DONE.slice(0,60))){if(t.mode!==mode)continue;const i=mode==='demo'?t.ci-v[0].s:v.findIndex(c=>t.ct>=c.t&&t.ct<c.t+GRAN*1e3);if(i<0||i>=m)continue;const up=t.dir==='up',y=up?Y(v[i].l)+9:Y(v[i].h)-9;cx.fillStyle=up?k.up:k.dn;cx.beginPath();cx.moveTo(X(i),up?y-7:y+7);cx.lineTo(X(i)-4,y);cx.lineTo(X(i)+4,y);cx.fill()}
  const py=Y(src.p);cx.setLineDash([4,4]);cx.strokeStyle=k.acc;cx.beginPath();cx.moveTo(0,py);cx.lineTo(cw,py);cx.stroke();cx.setLineDash([]);
  cx.fillStyle=k.acc;cx.fillRect(cw,py-9,RX,18);cx.fillStyle='#06121f';cx.fillText(fmtP(src.p),cw+6,py);
  if(hx>=0&&hx<cw){
    const i=clamp(Math.floor((hx-o)/bw),0,m-1),c=v[i],x=X(i);
    cx.strokeStyle=k.mu;cx.setLineDash([3,4]);cx.beginPath();cx.moveTo(x,0);cx.lineTo(x,H);cx.stroke();cx.setLineDash([]);
    const eq=c.eq||(i===m-1?eqv():START),pl=eq-START,ch=(c.c-c.o)/c.o*100;
    tip.innerHTML=`<div>${new Date(c.t).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div><div>O ${fmtP(c.o)} H ${fmtP(c.h)}</div><div>L ${fmtP(c.l)} C ${fmtP(c.c)}</div><div>Change <span class="${ch>=0?'up':'dn'}">${ch.toFixed(2)}%</span></div><div>Equity ${money(eq)}</div><div>Result <span class="${pl>=0?'up':'dn'}">${sgn(pl)}</span></div>`;
    tip.style.display='block';const tw=tip.offsetWidth;tip.style.left=(x>W/2?x-tw-12:x+12)+'px';
  }else tip.style.display='none';
}
function drawSpark(k){if(!sp||!spx)return;const[W,H]=fit(sp,spx);const v=EQ.slice(-90);if(!W||v.length<2)return;let lo=Math.min(...v),hi=Math.max(...v);const p=(hi-lo)*.1||1;lo-=p;hi+=p;spx.beginPath();v.forEach((x,i)=>{const X=i/(v.length-1)*W,Y=H-(x-lo)/(hi-lo)*H;i?spx.lineTo(X,Y):spx.moveTo(X,Y)});spx.strokeStyle=v[v.length-1]>=START?k.up:k.dn;spx.lineWidth=1.6;spx.stroke()}
function drawEq(k){
  if(!ec||!ex)return;const[W,H]=fit(ec,ex);const v=EQ;if(!W||v.length<2)return;
  let lo=Math.min(...v),hi=Math.max(...v);const p=(hi-lo)*.1||1;lo-=p;hi+=p;
  const X=i=>i/(v.length-1)*W,Y=x=>H-(x-lo)/(hi-lo)*H;
  ex.beginPath();v.forEach((x,i)=>i?ex.lineTo(X(i),Y(x)):ex.moveTo(X(i),Y(x)));
  ex.strokeStyle=k.acc;ex.lineWidth=2;ex.stroke();
  let lbl=money(v[v.length-1])+' now';
  if(ehx>=0){const i=clamp(Math.round(ehx/W*(v.length-1)),0,v.length-1),x=X(i),y=Y(v[i]);ex.beginPath();ex.arc(x,y,4,0,6.283);ex.fillStyle=k.acc;ex.fill();lbl=money(v[i])+' after trade '+i}
  safeText('#eqv', lbl);
}
const P=new Map();let drag=null,pd=0,tapAt=0;
function zoom(f){V.bars=clamp(V.bars*f,12,240)}
function yzoom(f){const mid=(V.lo+V.hi)/2,h=(V.hi-V.lo)/2*f;V.lo=mid-h;V.hi=mid+h;V.auto=false;const _ya=$('#yauto');if(_ya)_ya.textContent='Auto scale: off'}
function resetView(){V.bars=70;V.off=0;V.auto=true;const _ya2=$('#yauto');if(_ya2)_ya2.textContent='Auto scale: on'}
cv.addEventListener('pointerdown',e=>{cv.setPointerCapture(e.pointerId);P.set(e.pointerId,{x:e.clientX,y:e.clientY});drag={x:e.clientX,y:e.clientY,off:V.off,lo:V.lo,hi:V.hi,t:Date.now(),mv:0};pd=0});
cv.addEventListener('pointermove',e=>{
  hx=e.clientX-cv.getBoundingClientRect().left;
  if(!P.has(e.pointerId))return;
  P.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(P.size>1){const[a,b]=[...P.values()],d=Math.hypot(a.x-b.x,a.y-b.y);if(pd)zoom(pd/d);pd=d;return}
  const r=cv.getBoundingClientRect(),bw=(r.width-RX)/Math.round(V.bars),dx=e.clientX-drag.x,dy=e.clientY-drag.y;
  drag.mv+=Math.abs(dx)+Math.abs(dy);
  V.off=drag.off+dx/bw;
  if(!V.auto){const sh=dy/r.height*(drag.hi-drag.lo);V.lo=drag.lo+sh;V.hi=drag.hi+sh}
});
function release(e){
  if(drag&&P.size===1&&drag.mv<8&&Date.now()-drag.t<300){const now=Date.now();if(now-tapAt<350)resetView();tapAt=now}
  P.delete(e.pointerId);
  if(P.size===1){const p=[...P.values()][0];drag={x:p.x,y:p.y,off:V.off,lo:V.lo,hi:V.hi,t:Date.now(),mv:99};pd=0}
  else if(!P.size){drag=null;pd=0}
}
cv.addEventListener('pointerup',release);cv.addEventListener('pointercancel',release);
cv.addEventListener('pointerleave',()=>{if(!P.size)hx=-1});
cv.addEventListener('wheel',e=>{e.preventDefault();zoom(e.deltaY>0?1.12:.89)},{passive:false});
ec.addEventListener('pointermove',e=>ehx=e.clientX-ec.getBoundingClientRect().left);
ec.addEventListener('pointerleave',()=>ehx=-1);

function frame(){
  const k=palette(),e=eqv();
  shown+=(e-shown)*.18;if(Math.abs(e-shown)<.004)shown=e;
  safeText('#eq', money(shown));
  const pl=e-START,pe=$('#pl');if(pe){pe.textContent=sgn(pl);pe.className=pl>=0?'up':'dn'}
  const pj=OPEN.reduce((s,t)=>s+projOf(t),0),pr=$('#proj');if(pr){pr.textContent=sgn(pj);pr.className=pj>=0?'up':'dn'}
  drawChart(k);drawSpark(k);if(panelOn('analytics'))drawEq(k);
  requestAnimationFrame(frame);
}

function onLive(type,d){
  if(type==='trade'){liveTrade(d.p,d.t);F.live.at=Date.now();TAPE.unshift(d);if(TAPE.length>25)TAPE.length=25}
  else if(type==='ticker'){ST={price:+d.price,open:+d.open_24h,hi:+d.high_24h,lo:+d.low_24h,vol:+d.volume_24h};F.live.at=Date.now();if(!F.live.p)F.live.p=ST.price}
  else if(type==='status'){feed=d.s==='ok'?'live':d.s==='down'?'reconnecting':'connecting'}
}
function tvURL(sym){return 'https://s.tradingview.com/widgetembed/?symbol='+encodeURIComponent(sym)+'&interval=15&theme='+(S.theme==='paper'?'light':'dark')+'&style=1&locale=en'}
function setMode(m){
  mode=m;S.src=m;save();
  const tv=m==='tv';
  const _src=$('#src');if(_src)_src.value=m;
  $('.chartbox').hidden=tv;$('.tools').hidden=tv;$('#tvT').hidden=!tv;
  if(tv)$('#tvT').src=tvURL(S.tv);
  $('#prod').hidden=m!=='live';$('#gran').hidden=m!=='live';
  $('#durD').hidden=m==='live';$('#durL').hidden=m!=='live';
  const _up=$('#upb'),_dn=$('#dnb');if(_up)_up.disabled=tv;if(_dn)_dn.disabled=tv;
  $('#modepill').textContent=m==='demo'?'Demo money only':m==='live'?'Live prices, virtual money':'Embedded chart, no trading';
  if(m==='live'&&!F.live.C.length)seedLive();
}
function apply(){clearInterval(timer);timer=setInterval(()=>demoTick(false),1000/Math.max(1,S.speed));const vv=$('#vv');if(vv)vv.textContent=S.vol.toFixed(1)+'x'}
function setStake(v){S.stake=Math.max(.5,+(+v).toFixed(2));$('[data-k=stake]').value=S.stake;save()}
function theme(t){S.theme=t;document.documentElement.dataset.theme=t;$$('[data-theme-set]').forEach(b=>b.classList.toggle('on',b.dataset.themeSet===t));const tv=$('#tv');if(tv)tv.src=tvURL(S.tv);save()}
function dStatus(d){
  const b=$('#dbtn'), dot=$('#ddot'), st=$('#dstat'), bal=$('#dbal');
  const on = d.state && d.state !== 'off';
  b.textContent = on ? '⚡ API' : '⚡ API';
  b.title = d.msg || '';
  if (dot) {
    dot.className = 'dot ' + (d.state==='ok'?'ok':d.state==='connecting'||d.state==='auth'||d.state==='limit'?'warn':'bad');
  }
  if (st) st.textContent = d.msg || d.state || 'Off';
  if (bal && d.balance) bal.textContent = money(d.balance.balance || d.balance);
  const run = $('#drun');
  if (run) {
    if (d.state === 'connecting' || d.state === 'auth') {
      run.innerHTML = '<span class="spinner"></span> Connecting';
      run.disabled = true;
    } else if (d.state === 'ok') {
      run.textContent = 'Connected';
      run.disabled = false;
    } else {
      run.textContent = 'Connect';
      run.disabled = false;
    }
  }
}
function bind(){
  $$('[data-k]').forEach(el=>{
    const k=el.dataset.k;
    if(el.type==='checkbox')el.checked=!!S[k];else el.value=S[k];
    const set=()=>{S[k]=el.type==='checkbox'?el.checked:(NUM.has(k)||el.type==='range'||el.type==='number')?(parseFloat(el.value)||0):el.value;apply();save()};
    el.addEventListener('input',set);el.addEventListener('change',set);
  });
  $$('[data-step]').forEach(b=>b.onclick=()=>setStake(S.stake+ +b.dataset.step));
  $$('[data-set]').forEach(b=>b.onclick=()=>setStake(+b.dataset.set));
  $$('.tabs button').forEach(b=>b.onclick=()=>{$$('.tabs button').forEach(x=>x.classList.toggle('on',x===b));$$('.panel').forEach(p=>p.classList.toggle('on',p.id==='p-'+b.dataset.t))});
  $$('[data-theme-set]').forEach(b=>b.onclick=()=>theme(b.dataset.themeSet));
  const srcEl=$('#src');if(srcEl){srcEl.value=mode;srcEl.onchange=e=>setMode(e.target.value)}
  const prodEl=$('#prod');if(prodEl){prodEl.value=S.prod;prodEl.onchange=e=>{S.prod=e.target.value;Live.setProduct(S.prod);seedLive();save()}}
  const granEl=$('#gran');if(granEl){granEl.value=S.gran;granEl.onchange=e=>{S.gran=GRAN=+e.target.value;seedLive();save()}}
  const upb=$('#upb'),dnb=$('#dnb');
  if(upb)upb.onclick=()=>openT('up',S.stake,'manual','manual');
  if(dnb)dnb.onclick=()=>openT('down',S.stake,'manual','manual');
  const zin=$('#zin'),zout=$('#zout'),yauto=$('#yauto'),yz=$('#yz'),yzo=$('#yzo'),latest=$('#latest');
  if(zin)zin.onclick=()=>zoom(.8);
  if(zout)zout.onclick=()=>zoom(1.25);
  if(yauto)yauto.onclick=()=>{V.auto=!V.auto;yauto.textContent='Auto scale: '+(V.auto?'on':'off')};
  if(yz)yz.onclick=()=>yzoom(.8);
  if(yzo)yzo.onclick=()=>yzoom(1.25);
  if(latest)latest.onclick=()=>{V.off=0};

  // Deriv modal
  const modal=$('#dmodal');
  const dbtn=$('#dbtn');
  if(dbtn)dbtn.onclick=()=>{if(modal)modal.hidden=false};
  const dclose=$('#dclose');
  if(dclose)dclose.onclick=()=>{if(modal)modal.hidden=true};
  if(modal)modal.addEventListener('click',e=>{if(e.target===modal)modal.hidden=true});
  const drun=$('#drun');
  if(drun)drun.onclick=()=>{
    const tok=($('#dtoken')&&$('#dtoken').value||'').trim();
    const app=+($('#dapp')&&$('#dapp').value)||1089;
    if(!tok){toast('Paste a demo API token first','bad');return}
    Deriv.start({token:tok,appId:app});
  };
  const dstop=$('#dstop');
  if(dstop)dstop.onclick=()=>Deriv.stop();
  let checkTimer;
  const dtoken=$('#dtoken');
  if(dtoken)dtoken.addEventListener('input',()=>{
    clearTimeout(checkTimer);
    const tok=dtoken.value.trim();
    const el=$('#dcheck');
    if(!el)return;
    if(tok.length<15){el.textContent='';return}
    el.textContent='Checking…';el.style.color='var(--warn)';
    checkTimer=setTimeout(async()=>{
      try{
        const r=await Deriv.quickCheck(tok);
        if(r.ok){el.textContent=`Valid · ${r.loginid} · ${r.currency} ${r.balance}`;el.style.color='var(--up)'}
        else{el.textContent=r.reason||'Invalid';el.style.color='var(--dn)'}
      }catch{el.textContent='Check failed – try Connect';el.style.color='var(--dn)'}
    },600);
  });
  addEventListener('deriv:status',e=>dStatus(e.detail));
  addEventListener('deriv:balance',e=>{if(e.detail&&$('#dbal'))$('#dbal').textContent=money(e.detail.balance)});

  // Trade type tabs
  $$('.ttabs button').forEach(b=>{
    b.onclick=()=>{
      $$('.ttabs button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      const t=b.dataset.tt;
      ['options','cfd','mult','accu'].forEach(k=>{
        const p=$('#panel-'+k);
        if(p)p.hidden=k!==t;
      });
    };
  });
  const safeClick=(id,dir,src)=>{const el=$(id);if(el)el.onclick=()=>openT(dir,S.stake,'manual',src)};
  safeClick('#cfd-buy','up','cfd');
  safeClick('#cfd-sell','down','cfd');
  safeClick('#m-up','up','mult');
  safeClick('#m-dn','down','mult');
  safeClick('#a-buy','up','accu');
  safeClick('#a-sell','down','accu');
}

function init(){
  theme(S.theme);bind();apply();setStake(S.stake);
  if(!F.demo.C.length)for(let i=0;i<900*S.tpc;i++)demoTick(true);
  Live.on(onLive);Live.start(S.prod);
  setMode(S.src);
  setInterval(pulse,250);
  requestAnimationFrame(frame);ui();
  if('serviceWorker' in navigator)addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
}
init();
})();
