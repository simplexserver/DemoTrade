(()=>{'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const K='gt.v2',PAY=.95,START=1e4;
const DEF={stake:5,dur:5,maxStake:50,maxOpen:3,riskPct:2,dailyLoss:500,regime:'auto',vol:1,drift:0,speed:4,tpc:20,strat:'trend',autoSel:true,autoOn:false,theme:'midnight',tv:'FX:EURUSD'};
const NUM=new Set(['stake','dur','maxStake','maxOpen','riskPct','dailyLoss','vol','drift','speed','tpc']);
const S={...DEF,...JSON.parse(localStorage.getItem(K)||'{}')};
let bal=START,OPEN=[],DONE=[],EQ=[START],C=[],price=100,anchor=100,reg='range',ser=0,shown=START,timer=0,hx=-1,ehx=-1,lastNote='',dp=null;
const view={lo:0,hi:0};
try{const st=JSON.parse(localStorage.getItem(K+'.st')||'null');if(st){bal=st.bal;OPEN=st.open||[];DONE=st.done||[];EQ=st.eq||[START]}}catch(e){}
const money=v=>(v<0?'-':'')+'$'+Math.abs(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const sgn=v=>(v>=0?'+':'')+money(v);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sum=a=>a.reduce((s,t)=>s+t.pnl,0);
const eqv=()=>bal+OPEN.reduce((a,t)=>a+t.stake,0);
const won=(t,p)=>t.dir==='up'?p>t.entry:p<t.entry;
const projOf=t=>won(t,price)?t.stake*PAY:-t.stake;
const panelOn=n=>$('#p-'+n).classList.contains('on');
const save=()=>{localStorage.setItem(K,JSON.stringify(S));localStorage.setItem(K+'.st',JSON.stringify({bal,open:OPEN,done:DONE.slice(0,300),eq:EQ.slice(-600)}))};
function toast(m,k){const t=$('#toast');t.textContent=m;t.className='toast on '+(k||'');clearTimeout(toast.h);toast.h=setTimeout(()=>t.classList.remove('on'),2400)}
function note(m){if(m===lastNote)return;lastNote=m;const L=$('#alog');const d=document.createElement('div');d.textContent=new Date().toLocaleTimeString()+'  '+m;L.prepend(d);while(L.children.length>40)L.lastChild.remove()}

const RG={up:[.0007,.0009],down:[-.0007,.0009],range:[0,.0007],crash:[-.003,.0035],spike:[0,.0045]};
const NX={up:['up','range','spike'],down:['down','range','crash'],range:['range','up','down'],crash:['down','range'],spike:['range','up']};
const gauss=()=>Math.sqrt(-2*Math.log(Math.random()||1e-12))*Math.cos(6.283185*Math.random());
function step(){
  if(S.regime==='auto'&&Math.random()<.006){const n=NX[reg];reg=n[(Math.random()*n.length)|0]}
  const R=S.regime==='auto'?reg:S.regime,[mu,sg]=RG[R];
  let r=mu+S.drift*8e-4+sg*S.vol*gauss();
  if(R==='range')r+=(anchor-price)/price*.03;
  if(Math.random()<8e-4)r+=(Math.random()<.5?-1:1)*.004;
  price*=Math.exp(r);
  anchor*=Math.exp(gauss()*4e-4);
}
function newC(){const c={s:ser++,o:price,h:price,l:price,c:price,n:0,t:Date.now(),eq:0};C.push(c);if(C.length>420)C.shift();return c}
function tick(){
  step();
  let c=C[C.length-1]||newC();
  if(c.n>=S.tpc){c.eq=eqv();afterClose(c);c=newC()}
  c.h=Math.max(c.h,price);c.l=Math.min(c.l,price);c.c=price;c.n++;
  for(const t of OPEN.slice())if(++t.ticks>=t.dur)settle(t);
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
function afterClose(c){
  if(!S.autoOn||OPEN.some(t=>t.who==='auto'))return;
  const k=pick(),sig=STR[k](C);
  if(!sig)return;
  const e=openT(sig,S.stake,'auto',k);
  note(e||((sig==='up'?'Rise ':'Fall ')+money(S.stake)+' via '+k));
}

function todayPL(){const d=new Date().toDateString();return sum(DONE.filter(t=>new Date(t.done).toDateString()===d))}
function check(st){
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
  OPEN.push({id:Math.random().toString(36).slice(2),dir,stake:st,dur:S.dur,ticks:0,entry:price,who,strat,ci:C[C.length-1].s});
  if(who==='manual')toast((dir==='up'?'Rise ':'Fall ')+money(st)+' opened','ok');
  save();return '';
}
function settle(t){
  const win=won(t,price),pnl=win?t.stake*PAY:-t.stake;
  bal+=t.stake+pnl;
  Object.assign(t,{pnl:+pnl.toFixed(2),win,done:Date.now()});
  OPEN=OPEN.filter(x=>x!==t);DONE.unshift(t);if(DONE.length>500)DONE.length=500;
  EQ.push(eqv());if(EQ.length>1000)EQ.shift();
  toast((win?'Won ':'Lost ')+money(Math.abs(pnl))+' on '+(t.dir==='up'?'Rise':'Fall'),win?'ok':'bad');
  save();
}

function stats(){
  const n=DONE.length,W=DONE.filter(t=>t.win),L=DONE.filter(t=>!t.win);
  const wr=n?W.length/n:0,aw=W.length?sum(W)/W.length:0,al=L.length?sum(L)/L.length:0;
  let pk=-Infinity,dd=0;for(const v of EQ){pk=Math.max(pk,v);dd=Math.max(dd,pk-v)}
  const gl=-sum(L);
  return{n,wr,aw,al,ex:wr*aw+(1-wr)*al,dd,pf:gl?sum(W)/gl:0};
}
function renderStats(){
  const s=stats(),cell=(l,v,c)=>`<div class="stat"><span>${l}</span><em class="${c||''}">${v}</em></div>`;
  $('#stats').innerHTML=[cell('Trades',s.n),cell('Win rate',(s.wr*100).toFixed(1)+'%'),cell('Average win',sgn(s.aw),'up'),cell('Average loss',sgn(s.al),'dn'),cell('Expectancy',sgn(s.ex),s.ex>=0?'up':'dn'),cell('Max drawdown',money(s.dd),'dn'),cell('Profit factor',s.n&&s.pf?s.pf.toFixed(2):'n/a'),cell('Net result',sgn(eqv()-START),eqv()>=START?'up':'dn')].join('');
}
function renderHist(){
  $('#hist').innerHTML='<tr><th>Time</th><th>Side</th><th>Stake</th><th>Result</th><th>Strategy</th></tr>'+DONE.slice(0,60).map(t=>`<tr><td>${new Date(t.done).toLocaleTimeString()}</td><td>${t.dir==='up'?'Rise':'Fall'}</td><td>${money(t.stake)}</td><td class="${t.pnl>=0?'up':'dn'}">${sgn(t.pnl)}</td><td>${esc(t.strat)}</td></tr>`).join('');
}
function ui(){
  $('#pos').innerHTML=OPEN.length?OPEN.map(t=>`<div class="pos"><span>${t.dir==='up'?'Rise':'Fall'} ${money(t.stake)}${t.who==='auto'?' auto':''}</span><span class="${projOf(t)>=0?'up':'dn'}">${sgn(projOf(t))}</span><span class="lbl">${t.dur-t.ticks} ticks left</span></div>`).join(''):'<p class="lbl">None open.</p>';
  $('#risk').textContent=check(S.stake)||'Within limits';
  if(panelOn('analytics')){renderStats();renderHist()}
  setTimeout(ui,400);
}

const cv=$('#chart'),cx=cv.getContext('2d'),tip=$('#tip'),sp=$('#spark'),spx=sp.getContext('2d'),ec=$('#eqc'),ex=ec.getContext('2d');
function fit(el,g){const r=el.getBoundingClientRect(),d=window.devicePixelRatio||1;if(el.width!==Math.round(r.width*d)||el.height!==Math.round(r.height*d)){el.width=Math.round(r.width*d);el.height=Math.round(r.height*d)}g.setTransform(d,0,0,d,0,0);g.clearRect(0,0,r.width,r.height);return[r.width,r.height]}
function palette(){const s=getComputedStyle(document.documentElement),g=n=>s.getPropertyValue(n).trim();return{up:g('--up'),dn:g('--dn'),line:g('--line'),mu:g('--muted'),acc:g('--acc')}}
function drawChart(k){
  const[W,H]=fit(cv,cx);const n=Math.max(20,Math.floor(W/8));const v=C.slice(-n);if(!W||!v.length)return;
  let lo=Infinity,hi=-Infinity;for(const c of v){if(c.l<lo)lo=c.l;if(c.h>hi)hi=c.h}
  const p=(hi-lo)*.12||.5;lo-=p;hi+=p;
  if(!view.hi){view.lo=lo;view.hi=hi}
  view.lo+=(lo-view.lo)*.12;view.hi+=(hi-view.hi)*.12;
  const m=v.length,bw=W/m,X=i=>(i+.5)*bw,Y=x=>H-(x-view.lo)/(view.hi-view.lo)*H;
  cx.lineWidth=1;cx.strokeStyle=k.line;cx.globalAlpha=.55;
  for(let i=1;i<5;i++){cx.beginPath();cx.moveTo(0,H*i/5);cx.lineTo(W,H*i/5);cx.stroke()}
  cx.globalAlpha=1;
  v.forEach((c,i)=>{const q=c.c>=c.o?k.up:k.dn,x=X(i),a=Y(Math.max(c.o,c.c)),b=Y(Math.min(c.o,c.c));cx.strokeStyle=q;cx.fillStyle=q;cx.beginPath();cx.moveTo(x,Y(c.h));cx.lineTo(x,Y(c.l));cx.stroke();cx.fillRect(x-bw*.32,a,bw*.64,Math.max(1,b-a))});
  const base=v[0].s;
  for(const t of OPEN.concat(DONE.slice(0,40))){const i=t.ci-base;if(i<0||i>=m)continue;const up=t.dir==='up',y=up?Y(v[i].l)+9:Y(v[i].h)-9;cx.fillStyle=up?k.up:k.dn;cx.beginPath();cx.moveTo(X(i),up?y-7:y+7);cx.lineTo(X(i)-4,y);cx.lineTo(X(i)+4,y);cx.fill()}
  const py=Y(price);cx.setLineDash([4,4]);cx.strokeStyle=k.acc;cx.beginPath();cx.moveTo(0,py);cx.lineTo(W,py);cx.stroke();cx.setLineDash([]);
  if(hx>=0){
    const i=Math.min(m-1,Math.max(0,Math.floor(hx/bw))),c=v[i],x=X(i);
    cx.strokeStyle=k.mu;cx.setLineDash([3,4]);cx.beginPath();cx.moveTo(x,0);cx.lineTo(x,H);cx.stroke();cx.setLineDash([]);
    const eqc=c.eq||eqv(),ch=(c.c-c.o)/c.o*100,pl=eqc-START;
    tip.innerHTML=`<div>Open ${c.o.toFixed(2)} &nbsp; High ${c.h.toFixed(2)}</div><div>Low ${c.l.toFixed(2)} &nbsp; Close ${c.c.toFixed(2)}</div><div>Change <span class="${ch>=0?'up':'dn'}">${ch.toFixed(2)}%</span></div><div>Equity ${money(eqc)}</div><div>Result <span class="${pl>=0?'up':'dn'}">${sgn(pl)}</span></div>`;
    tip.style.display='block';
    const tw=tip.offsetWidth;tip.style.left=(cv.offsetLeft+(x>W/2?x-tw-12:x+12))+'px';
  }
}
function drawSpark(k){
  const[W,H]=fit(sp,spx);const v=EQ.slice(-90);if(!W||v.length<2)return;
  let lo=Math.min(...v),hi=Math.max(...v);const p=(hi-lo)*.1||1;lo-=p;hi+=p;
  spx.beginPath();v.forEach((x,i)=>{const X=i/(v.length-1)*W,Y=H-(x-lo)/(hi-lo)*H;i?spx.lineTo(X,Y):spx.moveTo(X,Y)});
  spx.strokeStyle=v[v.length-1]>=START?k.up:k.dn;spx.lineWidth=1.6;spx.stroke();
}
function drawEq(k){
  const[W,H]=fit(ec,ex);const v=EQ;if(!W||v.length<2)return;
  let lo=Math.min(...v),hi=Math.max(...v);const p=(hi-lo)*.1||1;lo-=p;hi+=p;
  const X=i=>i/(v.length-1)*W,Y=x=>H-(x-lo)/(hi-lo)*H;
  ex.beginPath();v.forEach((x,i)=>i?ex.lineTo(X(i),Y(x)):ex.moveTo(X(i),Y(x)));
  ex.strokeStyle=k.acc;ex.lineWidth=2;ex.stroke();
  let lbl=money(v[v.length-1])+' now';
  if(ehx>=0){const i=Math.min(v.length-1,Math.max(0,Math.round(ehx/W*(v.length-1)))),x=X(i),y=Y(v[i]);ex.beginPath();ex.arc(x,y,4,0,6.283);ex.fillStyle=k.acc;ex.fill();lbl=money(v[i])+' after trade '+i}
  $('#eqv').textContent=lbl;
}
cv.addEventListener('pointermove',e=>{hx=e.clientX-cv.getBoundingClientRect().left;tip.style.display='block'});
cv.addEventListener('pointerdown',e=>{hx=e.clientX-cv.getBoundingClientRect().left;tip.style.display='block'});
cv.addEventListener('pointerleave',()=>{hx=-1;tip.style.display='none'});
ec.addEventListener('pointermove',e=>ehx=e.clientX-ec.getBoundingClientRect().left);
ec.addEventListener('pointerleave',()=>ehx=-1);
function frame(){
  const k=palette(),e=eqv();
  shown+=(e-shown)*.18;if(Math.abs(e-shown)<.004)shown=e;
  $('#eq').textContent=money(shown);
  const pl=e-START,pe=$('#pl');pe.textContent=sgn(pl);pe.className=pl>=0?'up':'dn';
  const pj=OPEN.reduce((s,t)=>s+projOf(t),0),pr=$('#proj');pr.textContent=sgn(pj);pr.className=pj>=0?'up':'dn';
  drawChart(k);drawSpark(k);if(panelOn('analytics'))drawEq(k);
  requestAnimationFrame(frame);
}

function apply(){clearInterval(timer);timer=setInterval(tick,1000/Math.max(1,S.speed));$('#vv').textContent=S.vol.toFixed(1)+'x'}
function setStake(v){S.stake=Math.max(.5,+(+v).toFixed(2));$('[data-k=stake]').value=S.stake;save()}
function tvURL(){return 'https://s.tradingview.com/widgetembed/?symbol='+encodeURIComponent(S.tv)+'&interval=15&theme='+(S.theme==='paper'?'light':'dark')+'&style=1&locale=en'}
function theme(t){S.theme=t;document.documentElement.dataset.theme=t;$$('[data-theme-set]').forEach(b=>b.classList.toggle('on',b.dataset.themeSet===t));$('#tv').src=tvURL();save()}
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
  $('#tvsym').value=S.tv;
  $('#tvsym').onchange=e=>{S.tv=e.target.value;$('#tv').src=tvURL();save()};
  $('#upb').onclick=()=>openT('up',S.stake,'manual','manual');
  $('#dnb').onclick=()=>openT('down',S.stake,'manual','manual');
  $('#shock').onclick=()=>{price*=Math.random()<.5?.99:1.01;toast('News shock applied','ok')};
  $('#wipe').onclick=()=>{if(confirm('Reset all demo data? This clears trades and balance.')){localStorage.removeItem(K+'.st');localStorage.removeItem(K);location.reload()}};
  $('#openGuide').onclick=()=>$('#guide').showModal();
  $('#gx').onclick=()=>$('#guide').close();
  $('#inst').onclick=()=>{if(dp){dp.prompt();dp=null;$('#inst').hidden=true}};
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();dp=e;$('#inst').hidden=false});
  $('#dbtn').onclick=()=>$('#dmod').showModal();
  $('#dx').onclick=()=>$('#dmod').close();
  $('#drun').onclick=()=>{DerivLink.start({name:$('#dname').value,env:$('#denv').value,token:$('#dtok').value});$('#dtok').value=''};
  $('#dstop').onclick=()=>DerivLink.stop();
  $('#dshow').onclick=()=>{const t=$('#dtok'),show=t.type==='password';t.type=show?'text':'password';$('#dshow').textContent=show?'Hide':'Show'};
  window.addEventListener('deriv:status',e=>dStatus(e.detail));
}
function setStakeInput(){$('[data-k=stake]').value=S.stake}
function dStatus(d){
  const on=d.state&&d.state!=='off',b=$('#dbtn');
  b.innerHTML=on?`<svg class="dlogo" viewBox="0 0 64 22" aria-hidden="true"><text x="0" y="17" font-size="19" fill="currentColor">deriv</text></svg><span>${esc(d.name)}</span><i class="dot ${d.state}"></i>`:'+';
  b.title=d.msg||'';$('#dmsg').textContent=d.msg||'';
}
function init(){
  theme(S.theme);bind();apply();setStakeInput();
  if(!C.length)newC();
  for(let i=0;i<40;i++)tick();
  requestAnimationFrame(frame);ui();
  if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
}
init();
})();
