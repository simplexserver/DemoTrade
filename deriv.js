(()=>{'use strict';
const URL='wss://api.derivws.com/trading/v1/options/ws/public';
const LIM={trading:[200,['proposal','proposal_open_contract','buy','sell']],balance:[30,['balance','statement']],portfolio:[10,['portfolio','profit_table']],other:[100,[]]};
const hits={},hold={};
let ws=null,run=false,token='',name='Deriv',env='demo',state='off',fails=0,rt=0,hb=0;
const bucket=t=>Object.keys(LIM).find(k=>LIM[k][1].includes(t))||'other';
const jitter=ms=>ms*(.8+Math.random()*.4);
function allowed(t){const k=bucket(t),now=Date.now();if((hold[k]||0)>now)return false;hits[k]=(hits[k]||[]).filter(x=>now-x<6e4);return hits[k].length<LIM[k][0]}
function send(o){const t=Object.keys(o)[0];if(!ws||ws.readyState!==1||!allowed(t))return false;const k=bucket(t);(hits[k]=hits[k]||[]).push(Date.now());ws.send(JSON.stringify(o));return true}
function emit(s,msg){state=s;window.dispatchEvent(new CustomEvent('deriv:status',{detail:{state:s,msg,name,env}}))}
function cool(){fails++;const ms=jitter(Math.min(3e4*2**(fails-1),6e5));for(const k in LIM)hold[k]=Date.now()+ms;emit('limit','Rate limited. All calls paused for '+Math.round(ms/1e3)+' seconds, then retrying.')}
function connect(){
  if(!run)return;
  emit('connecting','Connecting to the Deriv public feed…');
  ws=new WebSocket(URL);
  ws.onopen=()=>{fails=0;clearInterval(hb);hb=setInterval(()=>send({ping:1}),2e4);emit('ok',(token?'Token held in this tab only. ':'')+'Public feed live. Trading stays locked until the server relay is connected.')};
  ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch(x){return}const c=(m.error&&m.error.code)||'';if(/RateLimit/i.test(c))cool()};
  ws.onerror=()=>{if(run)emit('down','Deriv feed unreachable. Check your network and try again.')};
  ws.onclose=()=>{clearInterval(hb);if(!run)return;fails++;emit('down','Connection lost. Reconnecting…');rt=setTimeout(connect,jitter(Math.min(3e3*2**(fails-1),6e4)))};
}
setInterval(()=>{if(run&&state==='limit'&&ws&&ws.readyState===1&&Date.now()>(hold.trading||0))emit('ok','Rate limit cleared. Feed live.')},1e3);
function stop(quiet){run=false;clearTimeout(rt);clearInterval(hb);token='';if(ws){ws.onclose=null;ws.close();ws=null}if(!quiet)emit('off','Stopped. Nothing is connected.')}
function start(o){
  stop(true);
  name=String(o.name||'').trim().slice(0,32)||'Deriv';
  env=o.env==='test'?'test':'demo';
  token=String(o.token||'').trim();
  if(token&&(token.length<16||/\s/.test(token))){token='';emit('down','That token looks wrong. Copy the full API token again from your Deriv account.');return}
  run=true;fails=0;connect();
}
window.DerivLink={start,stop,send,order:()=>({ok:false,reason:'Trading is locked. Orders need the server relay (spec section 5.4).'}),get state(){return state}};
})();
