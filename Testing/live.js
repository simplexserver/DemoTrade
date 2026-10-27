(()=>{'use strict';
const WS='wss://ws-feed.exchange.coinbase.com',REST='https://api.exchange.coinbase.com',CH=['ticker','matches'];
const L={ws:null,on:false,prod:'BTC-USD',fails:0,rt:0,cb:[]};
const emit=(t,d)=>L.cb.forEach(f=>f(t,d));
const send=o=>{if(L.ws&&L.ws.readyState===1)L.ws.send(JSON.stringify(o))};
function open(){
  if(!L.on)return;
  emit('status',{s:'connecting'});
  const ws=L.ws=new WebSocket(WS);
  ws.onopen=()=>{L.fails=0;send({type:'subscribe',product_ids:[L.prod],channels:CH});emit('status',{s:'ok'})};
  ws.onmessage=e=>{
    let m;try{m=JSON.parse(e.data)}catch(x){return}
    if(m.product_id!==L.prod)return;
    if(m.type==='ticker')emit('ticker',m);
    else if(m.type==='match'||m.type==='last_match')emit('trade',{p:+m.price,q:+m.size,side:m.side,t:Date.parse(m.time)||Date.now()});
    else if(m.type==='error')emit('status',{s:'down'});
  };
  ws.onclose=()=>{if(!L.on||L.ws!==ws)return;L.fails++;emit('status',{s:'down'});L.rt=setTimeout(open,Math.min(2e3*2**L.fails,3e4)*(.8+Math.random()*.4))};
}
window.Live={
  start(p){if(p)L.prod=p;if(L.on)return;L.on=true;open()},
  stop(){L.on=false;clearTimeout(L.rt);if(L.ws){L.ws.onclose=null;L.ws.close();L.ws=null}},
  setProduct(p){if(p===L.prod)return;send({type:'unsubscribe',product_ids:[L.prod],channels:CH});L.prod=p;send({type:'subscribe',product_ids:[p],channels:CH})},
  candles(p,g){return fetch(`${REST}/products/${p}/candles?granularity=${g}`).then(r=>{if(!r.ok)throw new Error(String(r.status));return r.json()}).then(a=>a.reverse().map(x=>({t:x[0]*1e3,l:x[1],h:x[2],o:x[3],c:x[4],n:1,eq:0})))},
  on(f){L.cb.push(f)}
};
})();
