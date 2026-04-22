import { useState, useEffect, useRef } from "react";

const GAMMA = "https://cors-anywhere.herokuapp.com/https://gamma-api.polymarket.com";
   const CLOB  = "https://cors-anywhere.herokuapp.com/https://clob.polymarket.com";
const POLL  = 4000;

const short = a => a ? `${a.slice(0,6)}…${a.slice(-4)}` : "???";
const fmt$  = v => `$${Math.round(+v).toLocaleString()}`;
const fmtC  = v => `${(+v*100).toFixed(1)}¢`;
const fmtPct= v => v != null ? `${(v*100).toFixed(1)}%` : "N/A";
const ago   = ms => { const s=Math.floor((Date.now()-ms)/1000); return s<60?`${s}s`:s<3600?`${Math.floor(s/60)}m`:`${Math.floor(s/3600)}h`; };

async function apiFetch(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

// ── Simulation ────────────────────────────────────────────────────
const mkAddr = n => `0x${n.toString(16).padStart(4,"0")}${"0123456789abcdef".repeat(5).slice(0,36)}`;
const SIM_STATS = Array.from({length:18},(_,i)=>({
  addr: mkAddr(i+1),
  winRate: i<5 ? 0.62+Math.random()*0.14 : 0.40+Math.random()*0.20,
  vol: Math.round(4000+Math.random()*180000),
  count: Math.floor(20+Math.random()*400),
})).sort((a,b)=>b.winRate*b.vol - a.winRate*a.vol);

const SIM_MKTS = [
  {id:"m1",conditionId:"m1",question:"Will BTC be higher in 5 min? (12:00 UTC)",tokens:[{token_id:"t1",outcome:"Yes"},{token_id:"t1n",outcome:"No"}],volume:284000,outcomePrices:"[0.97,0.03]"},
  {id:"m2",conditionId:"m2",question:"Will BTC be higher in 5 min? (12:05 UTC)",tokens:[{token_id:"t2",outcome:"Yes"},{token_id:"t2n",outcome:"No"}],volume:156000,outcomePrices:"[0.62,0.38]"},
  {id:"m3",conditionId:"m3",question:"Will BTC be above $94,500 in next 5 min?",tokens:[{token_id:"t3",outcome:"Yes"},{token_id:"t3n",outcome:"No"}],volume:98000,outcomePrices:"[0.55,0.45]"},
  {id:"m4",conditionId:"m4",question:"Will BTC price rise 0.1% in next 5 min?",tokens:[{token_id:"t4",outcome:"Yes"},{token_id:"t4n",outcome:"No"}],volume:67000,outcomePrices:"[0.48,0.52]"},
];

let _tid = 0;
function genTrade(mktId, forceAddr=null) {
  const addr = forceAddr || SIM_STATS[Math.floor(Math.random()*SIM_STATS.length)].addr;
  const price= (0.88+Math.random()*0.11).toFixed(3);
  const size = (20+Math.random()*600).toFixed(2);
  return { id:`s${++_tid}`, maker_address:addr, market:mktId, price, size,
    side: Math.random()<0.55?"BUY":"SELL", outcome:"Yes",
    timestamp: Math.floor(Date.now()/1000), _sim:true };
}

function genBook(c=0.97) {
  const bids=[], asks=[];
  for(let i=0;i<14;i++){
    bids.push({price:(c-0.001-i*0.002).toFixed(3), size:(100+Math.random()*2800).toFixed(0)});
    asks.push({price:(c+0.001+i*0.002).toFixed(3), size:(80+Math.random()*1800).toFixed(0)});
  }
  const wi = bids.findIndex(b=>+b.price<=0.970);
  if(wi>=0) bids[wi].size=(7000+Math.random()*18000).toFixed(0);
  bids.sort((a,b)=>+b.price-+a.price);
  asks.sort((a,b)=>+a.price-+b.price);
  return {bids,asks};
}

// ── 97¢ Safety Score ──────────────────────────────────────────────
function compute97(book, trades) {
  if(!book?.bids) return null;
  const T=0.97;
  const bids=book.bids.map(b=>({p:+b.price,s:+b.size}));
  const asks=book.asks.map(a=>({p:+a.price,s:+a.size}));
  const bidWall = bids.filter(b=>b.p>=T-0.005).reduce((s,b)=>s+b.s,0);
  const askLoad = asks.filter(a=>a.p<=T+0.015).reduce((s,a)=>s+a.s,0);
  const buyMom  = (trades||[]).slice(0,30).filter(t=>+t.price>=T&&t.side==="BUY").reduce((s,t)=>s+(+t.size)*(+t.price),0);
  const totBid  = bids.reduce((s,b)=>s+b.s,0);
  const totAsk  = asks.reduce((s,a)=>s+a.s,0);
  const liq     = totBid/(totBid+totAsk+1);
  const spread  = (asks[0]?.p||1)-(bids[0]?.p||0);
  const pending = bids.filter(b=>b.p>=T-0.003).length;
  const comps = {
    "Bid wall at 97¢":      {v:Math.min(bidWall/8000,1), w:28, raw:fmt$(bidWall)},
    "Ask overhead":         {v:1-Math.min(askLoad/3000,1),w:20, raw:fmt$(askLoad)},
    "Buy momentum":         {v:Math.min(buyMom/8000,1),  w:22, raw:fmt$(buyMom)},
    "Bid/ask liquidity":    {v:liq,                       w:15, raw:fmtPct(liq)},
    "Spread tightness":     {v:Math.max(0,1-spread/0.03), w:10, raw:spread.toFixed(4)},
    "Pending orders at 97¢":{v:Math.min(pending/5,1),    w: 5, raw:`${pending} lvls`},
  };
  const total=Math.round(Object.values(comps).reduce((s,c)=>s+c.v*c.w,0));
  const bestBid=bids[0]?.p||0, bestAsk=asks[0]?.p||1;
  return {
    total, comps, bestBid, bestAsk, mid:(bestBid+bestAsk)/2,
    bidWall, liq,
    label: total>=72?"SAFE TO BUY":total>=50?"MODERATE RISK":"HIGH RISK",
    color: total>=72?"#22c55e":total>=50?"#f59e0b":"#ef4444",
  };
}

// ── Trader Ranking (solves P&L limitation via resolved cross-ref) ─
function rankTraders(allTrades, resolvedMkts, simMode) {
  const map={};
  for(const t of allTrades){
    const addr=t.maker_address||t.owner;
    if(!addr||addr.length<10) continue;
    if(!map[addr]) map[addr]={addr,vol:0,count:0,recent:[],wins:0,losses:0};
    map[addr].vol += (+t.size||0)*(+t.price||0);
    map[addr].count++;
    if(map[addr].recent.length<8) map[addr].recent.push(t);
  }
  // Cross-reference resolved markets → true win-rate
  for(const rm of (resolvedMkts||[])){
    const prices=(()=>{try{return JSON.parse(rm.outcomePrices||"[]");}catch{return [];}})();
    if(!prices.length) continue;
    const yesWon=+prices[0]>=0.99;
    const yesTokenId=rm.tokens?.[0]?.token_id;
    const mktTrades=allTrades.filter(t=>t.market===rm.conditionId||t.market===rm.id);
    for(const t of mktTrades){
      const addr=t.maker_address||t.owner;
      if(!map[addr]) continue;
      const boughtYes=t.outcome==="Yes"||t.asset_id===yesTokenId;
      if(t.side==="BUY"){
        if((yesWon&&boughtYes)||(!yesWon&&!boughtYes)) map[addr].wins++;
        else map[addr].losses++;
      }
    }
  }
  const simMap=simMode?Object.fromEntries(SIM_STATS.map(s=>[s.addr,s])):{};
  return Object.values(map).map(t=>{
    const res=t.wins+t.losses;
    const wr=res>2?t.wins/res:(simMap[t.addr]?.winRate??null);
    return {...t, winRate:wr, resolved:res, score:(t.vol/1000)*(wr!=null?wr*2:1)*Math.log(t.count+1), short:short(t.addr)};
  }).filter(t=>t.count>=1).sort((a,b)=>b.score-a.score).slice(0,12);
}

// ── Market intelligence signals ───────────────────────────────────
function marketIntel(trades, book) {
  if(!trades.length) return [];
  const recent=trades.slice(0,20);
  const last10=trades.slice(0,10);
  const sigs=[];
  // Price trend
  const prices=recent.map(t=>+t.price);
  const avg5=prices.slice(0,5).reduce((a,b)=>a+b,0)/5||0;
  const avg10=prices.slice(5,10).reduce((a,b)=>a+b,0)/5||0;
  if(avg5>avg10+0.005) sigs.push({type:"bull",text:`YES price trending up +${((avg5-avg10)*100).toFixed(1)}¢ (5-trade avg)`});
  else if(avg5<avg10-0.005) sigs.push({type:"bear",text:`YES price trending down ${((avg10-avg5)*100).toFixed(1)}¢`});
  // Volume spike
  const sizes=recent.map(t=>(+t.size)*(+t.price));
  const avgSz=sizes.reduce((a,b)=>a+b,0)/sizes.length||1;
  const lastSz=(+trades[0]?.size||0)*(+trades[0]?.price||0);
  if(lastSz>avgSz*2.5) sigs.push({type:"alert",text:`Volume spike: ${fmt$(lastSz)} (${(lastSz/avgSz).toFixed(1)}× avg)`});
  // Buy/sell ratio
  const buys=last10.filter(t=>t.side==="BUY").length;
  if(buys>=8) sigs.push({type:"bull",text:`Strong buy pressure: ${buys}/10 recent trades are BUY`});
  else if(buys<=2) sigs.push({type:"bear",text:`Selling pressure: only ${buys}/10 recent trades are BUY`});
  // Big order
  const bigOrder=recent.find(t=>(+t.size)*(+t.price)>5000);
  if(bigOrder) sigs.push({type:"alert",text:`Whale: ${fmt$((+bigOrder.size)*(+bigOrder.price))} ${bigOrder.side} at ${fmtC(bigOrder.price)}`});
  // Book imbalance
  if(book?.bids&&book?.asks){
    const bLiq=book.bids.reduce((s,b)=>s+(+b.size),0);
    const aLiq=book.asks.reduce((s,a)=>s+(+a.size),0);
    const ratio=bLiq/(aLiq||1);
    if(ratio>2) sigs.push({type:"bull",text:`Order book skewed ${ratio.toFixed(1)}× long — strong bid support`});
    else if(ratio<0.5) sigs.push({type:"bear",text:`Order book skewed ${(1/ratio).toFixed(1)}× short — heavy ask side`});
  }
  return sigs.slice(0,5);
}

// ── Main Dashboard ────────────────────────────────────────────────
const C={
  bg:"#06060f", panel:"#0d0d1e", border:"#1a1a35",
  accent:"#7c3aed", cyan:"#06b6d4", green:"#22c55e",
  red:"#ef4444", yellow:"#f59e0b", muted:"#64748b", text:"#e2e8f0", dim:"#94a3b8",
};

export default function PolyDash() {
  const [mode,   setMode]   = useState("loading");
  const [mkts,   setMkts]   = useState([]);
  const [mkt,    setMkt]    = useState(null);
  const [trades, setTrades] = useState([]);
  const [book,   setBook]   = useState(null);
  const [traders,setTraders]= useState([]);
  const [sigs,   setSigs]   = useState([]);
  const [s97,    setS97]    = useState(null);
  const [intel,  setIntel]  = useState([]);
  const [tab,    setTab]    = useState("signals");
  const [status, setStatus] = useState("Connecting…");
  const [tick,   setTick]   = useState(0);

  const tradesRef  = useRef([]);
  const seenRef    = useRef(new Set());
  const topRef     = useRef([]);
  const resolvedRef= useRef([]);
  const tickRef    = useRef(0);
  const simMode    = mode==="sim";

  useEffect(()=>{
    (async()=>{
      setStatus("Fetching BTC 5-min markets…");
      let liveMkts=null;
      let data=await apiFetch(`${GAMMA}/markets?active=true&tag_slug=btc-price-5-minutes&limit=30`);
      if(!Array.isArray(data)||!data.length) data=await apiFetch(`${GAMMA}/markets?active=true&limit=100`);
      if(Array.isArray(data)){
        const f=data.filter(m=>{
          const q=(m.question||m.title||"").toLowerCase();
          return (q.includes("btc")||q.includes("bitcoin"))&&(q.includes("5")||q.includes("minute"));
        });
        if(f.length) liveMkts=f.slice(0,8);
      }
      if(liveMkts?.length){
        setMode("live"); setMkts(liveMkts); setMkt(liveMkts[0]);
        setStatus(`Live · ${liveMkts.length} BTC markets`);
        const res=await apiFetch(`${GAMMA}/markets?closed=true&limit=60`);
        if(Array.isArray(res)) resolvedRef.current=res;
      } else {
        setMode("sim"); setMkts(SIM_MKTS); setMkt(SIM_MKTS[0]);
        setStatus("Simulation mode · Polymarket API unreachable from sandbox");
        const ranked=SIM_STATS.slice(0,10).map(s=>({...s,wins:Math.round(s.count*s.winRate),losses:Math.round(s.count*(1-s.winRate)),resolved:s.count,recent:[],score:s.winRate*s.vol/1000,short:short(s.addr)}));
        setTraders(ranked); topRef.current=ranked.slice(0,5).map(r=>r.addr);
        const initT=Array.from({length:25},()=>genTrade(SIM_MKTS[0].id));
        tradesRef.current=initT; setTrades(initT);
        const initB=genBook(0.97); setBook(initB); setS97(compute97(initB,initT));
        setIntel(marketIntel(initT,initB));
      }
    })();
  },[]);

  useEffect(()=>{
    if(!mkt) return;
    const poll=async()=>{
      const t=++tickRef.current; setTick(t);
      let newT=[];
      if(!simMode){
        const condId=mkt.conditionId||mkt.condition_id||mkt.id;
        const resp=await apiFetch(`${CLOB}/trades?market=${condId}&limit=50`);
        if(Array.isArray(resp)){
          newT=resp.filter(t=>!seenRef.current.has(t.id));
          newT.forEach(t=>seenRef.current.add(t.id));
        }
        if(t%2===0){
          const yid=mkt.tokens?.[0]?.token_id;
          if(yid){const b=await apiFetch(`${CLOB}/book?token_id=${yid}`);if(b){setBook(b);setS97(compute97(b,tradesRef.current));}}
        }
      } else {
        newT=Array.from({length:1+Math.floor(Math.random()*3)},()=>{
          const addr=Math.random()<0.15&&topRef.current.length>0?topRef.current[Math.floor(Math.random()*topRef.current.length)]:null;
          return genTrade(mkt.id,addr);
        });
        if(t%2===0){
          const lp=tradesRef.current[0]?.price||"0.97";
          const b=genBook(+lp); setBook(b); setS97(compute97(b,tradesRef.current));
        }
      }
      if(newT.length){
        tradesRef.current=[...newT,...tradesRef.current].slice(0,500);
        setTrades([...tradesRef.current]);
        const topSigs=newT.filter(t=>topRef.current.includes(t.maker_address||t.owner));
        if(topSigs.length) setSigs(prev=>[...topSigs.map(t=>({...t,traderShort:short(t.maker_address||t.owner),sigTime:Date.now()})),...prev].slice(0,100));
        setIntel(marketIntel(tradesRef.current,book));
      }
      if(t%8===0&&tradesRef.current.length){
        const ranked=rankTraders(tradesRef.current,resolvedRef.current,simMode);
        setTraders(ranked); topRef.current=ranked.slice(0,5).map(r=>r.addr);
      }
    };
    const iv=setInterval(poll,POLL); poll(); return()=>clearInterval(iv);
  },[mkt,mode]);

  const pill=(color,txt,small)=>(
    <span style={{background:color+"22",color,border:`1px solid ${color}44`,borderRadius:4,padding:small?"1px 5px":"2px 8px",fontSize:small?10:11,fontWeight:600,whiteSpace:"nowrap"}}>{txt}</span>
  );
  const card=(children,sx={})=>(
    <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:12,...sx}}>{children}</div>
  );
  const getMktPrice=m=>{try{const p=JSON.parse(m.outcomePrices||"[]");return p[0]!=null?+p[0]:null;}catch{return null;}};

  const TABS=[
    {id:"signals", label:"Signals",  icon:"◉", cnt:sigs.length},
    {id:"traders", label:"Traders",  icon:"★", cnt:traders.length},
    {id:"book",    label:"Book",     icon:"▤", cnt:null},
    {id:"score97", label:"97¢ Safe", icon:"◎", cnt:s97?.total},
  ];

  return (
    <div style={{background:C.bg,color:C.text,minHeight:"100vh",fontFamily:"'Segoe UI',system-ui,sans-serif",fontSize:13}}>
      <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}} .live{animation:blink 1.2s infinite;} button{cursor:pointer;}`}</style>

      {/* Header */}
      <div style={{background:C.panel,borderBottom:`1px solid ${C.border}`,padding:"10px 14px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <span style={{fontSize:16,fontWeight:800,color:C.accent,letterSpacing:.3}}>⚡ Polymarket BTC 5-Min Tracker</span>
        {pill(simMode?C.yellow:C.green, simMode?"SIMULATION":"LIVE")}
        <span style={{color:C.dim,fontSize:11,flex:1}}>{status}</span>
        <span style={{color:C.muted,fontSize:10,fontFamily:"monospace"}}>#{tick} · {new Date().toLocaleTimeString()}</span>
      </div>

      {/* Market selector */}
      <div style={{background:C.panel,borderBottom:`1px solid ${C.border}`,padding:"6px 14px",display:"flex",gap:6,overflowX:"auto"}}>
        {mkts.map(m=>{
          const price=getMktPrice(m); const active=mkt?.id===m.id;
          return (
            <button key={m.id} onClick={()=>{setMkt(m);seenRef.current=new Set();tradesRef.current=[];setTrades([]);setSigs([]);}}
              style={{background:active?C.accent+"33":"transparent",border:`1px solid ${active?C.accent:C.border}`,borderRadius:6,padding:"5px 10px",color:active?C.text:C.dim,textAlign:"left",minWidth:180,flexShrink:0}}>
              <div style={{fontSize:11,fontWeight:600,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis",maxWidth:180}}>{(m.question||"Market").slice(0,44)}…</div>
              {price!=null&&<div style={{fontSize:10,color:price>=0.7?C.green:price>=0.4?C.yellow:C.red,fontFamily:"monospace"}}>{fmtC(price)} YES · {fmt$(m.volume||0)}</div>}
            </button>
          );
        })}
      </div>

      {/* 97¢ Safety Bar */}
      {s97&&(
        <div style={{background:s97.color+"15",borderBottom:`1px solid ${s97.color}44`,padding:"6px 14px",display:"flex",alignItems:"center",gap:10}}>
          <span style={{color:s97.color,fontWeight:700,fontSize:12}}>97¢ {s97.label}</span>
          <div style={{flex:1,background:C.border,borderRadius:3,height:6,overflow:"hidden"}}>
            <div style={{width:`${s97.total}%`,height:6,background:s97.color,borderRadius:3,transition:"width .5s"}}/>
          </div>
          <span style={{color:s97.color,fontWeight:800,fontFamily:"monospace",fontSize:14}}>{s97.total}<span style={{fontSize:10,fontWeight:400}}>/100</span></span>
          <span style={{color:C.dim,fontSize:11}}>Mid: <b style={{color:C.text,fontFamily:"monospace"}}>{fmtC(s97.mid)}</b></span>
          <span style={{color:C.dim,fontSize:11}}>Bid liq: <b style={{color:C.green,fontFamily:"monospace"}}>{fmt$(s97.bidWall)}</b></span>
        </div>
      )}

      {/* Market Intel bar */}
      {intel.length>0&&(
        <div style={{background:"#0a0a1c",borderBottom:`1px solid ${C.border}`,padding:"5px 14px",display:"flex",gap:10,overflowX:"auto",alignItems:"center"}}>
          <span style={{color:C.muted,fontSize:10,flexShrink:0,fontWeight:600}}>SIGNALS</span>
          {intel.map((sig,i)=>(
            <span key={i} style={{color:sig.type==="bull"?C.green:sig.type==="bear"?C.red:C.yellow,fontSize:11,whiteSpace:"nowrap"}}>
              {sig.type==="bull"?"▲":sig.type==="bear"?"▼":"◆"} {sig.text}
            </span>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{borderBottom:`1px solid ${C.border}`,display:"flex",padding:"0 14px",background:C.panel}}>
        {TABS.map(({id,label,icon,cnt})=>(
          <button key={id} onClick={()=>setTab(id)}
            style={{padding:"9px 14px",border:"none",background:"transparent",color:tab===id?C.accent:C.muted,borderBottom:`2px solid ${tab===id?C.accent:"transparent"}`,fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:5}}>
            <span style={{fontSize:13}}>{icon}</span>{label}
            {cnt!=null&&<span style={{background:C.accent+"33",color:C.accent,borderRadius:10,padding:"0 5px",fontSize:10,minWidth:18,textAlign:"center"}}>{cnt}</span>}
          </button>
        ))}
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
          <span className="live" style={{width:7,height:7,borderRadius:"50%",background:C.green,display:"inline-block"}}/>
          <span style={{color:C.dim,fontSize:10}}>{simMode?"Simulated":"Live"} · every {POLL/1000}s</span>
        </div>
      </div>

      {/* Tab Content */}
      <div style={{padding:14,maxWidth:1100,margin:"0 auto"}}>

        {/* SIGNALS */}
        {tab==="signals"&&(
          <div>
            {sigs.length===0?(
              <div style={{textAlign:"center",padding:"40px 0",color:C.muted}}>
                <div style={{fontSize:28}}>◉</div>
                <div style={{marginTop:8,fontSize:14}}>Watching for top-5 trader activity…</div>
                <div style={{fontSize:11,marginTop:4}}>Top traders flagged with ★ in the Traders tab</div>
              </div>
            ):(
              <div>
                <div style={{color:C.dim,fontSize:11,marginBottom:10}}>Top trader alerts — these addresses are tracked 24/7</div>
                {sigs.slice(0,12).map((sig,i)=>(
                  <div key={sig.id+i} style={{background:i===0?C.accent+"1a":C.panel,border:`1px solid ${i===0?C.accent:C.border}`,borderRadius:8,padding:"9px 12px",marginBottom:7,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                    {i===0&&<span className="live" style={{fontSize:16,color:C.red}}>◉</span>}
                    <span style={{color:C.cyan,fontWeight:700,fontFamily:"monospace"}}>{sig.traderShort}</span>
                    {pill(C.accent,"TOP TRADER",true)}
                    <div style={{display:"flex",gap:6,alignItems:"center"}}>
                      {pill(sig.side==="BUY"?C.green:C.red,sig.side)}
                      {pill(C.cyan,fmtC(sig.price))}
                      <span style={{color:C.text,fontFamily:"monospace",fontWeight:700}}>{fmt$((+sig.size)*(+sig.price))}</span>
                      <span style={{color:C.dim,fontSize:11}}>YES token</span>
                    </div>
                    <span style={{marginLeft:"auto",color:C.muted,fontSize:11}}>{ago(sig.sigTime)}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{marginTop:18,marginBottom:8,fontWeight:600,color:C.dim,fontSize:12}}>All recent trades ({trades.length} total)</div>
            {card(
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead>
                    <tr style={{borderBottom:`1px solid ${C.border}`,color:C.muted}}>
                      {["Trader","Side","Price","Value","Outcome","Time"].map(h=>(
                        <th key={h} style={{padding:"7px 10px",fontWeight:600,textAlign:"left",whiteSpace:"nowrap"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trades.slice(0,30).map((t,i)=>{
                      const isTop=topRef.current.includes(t.maker_address||t.owner);
                      return (
                        <tr key={t.id+i} style={{borderBottom:`1px solid ${C.border}22`,background:isTop?C.accent+"0e":"transparent"}}>
                          <td style={{padding:"5px 10px",fontFamily:"monospace",color:isTop?C.cyan:C.dim,whiteSpace:"nowrap"}}>
                            {short(t.maker_address||t.owner)}{isTop&&<span style={{color:C.accent,marginLeft:4,fontSize:11}}>★</span>}
                          </td>
                          <td style={{padding:"5px 10px"}}><span style={{color:t.side==="BUY"?C.green:C.red,fontWeight:600}}>{t.side}</span></td>
                          <td style={{padding:"5px 10px",fontFamily:"monospace",color:+t.price>=0.95?C.green:C.text}}>{fmtC(t.price)}</td>
                          <td style={{padding:"5px 10px",fontFamily:"monospace"}}>{fmt$((+t.size)*(+t.price))}</td>
                          <td style={{padding:"5px 10px",color:C.dim}}>{t.outcome||"Yes"}</td>
                          <td style={{padding:"5px 10px",color:C.muted,fontSize:11}}>{t.timestamp?ago((+t.timestamp)*1000):"now"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* TRADERS */}
        {tab==="traders"&&(
          <div>
            <div style={{color:C.dim,fontSize:11,marginBottom:12}}>
              Score = volume × win-rate × log(trades). Win-rate sourced from {resolvedRef.current.length} resolved markets via <code style={{color:C.cyan}}>gamma-api…/markets?closed=true</code> — solves the CLOB P&L limitation. ★ = actively tracked.
              {simMode&&<span style={{color:C.yellow}}> Simulated win-rates in demo mode.</span>}
            </div>
            {traders.map((t,i)=>(
              <div key={t.addr} style={{background:C.panel,border:`1px solid ${i<3?C.accent+"88":C.border}`,borderRadius:8,padding:"11px 14px",marginBottom:7,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                <div style={{width:26,height:26,borderRadius:"50%",background:i===0?"#7c3aed":i===1?"#94a3b8":i===2?"#b45309":"#1e1e35",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:11,color:"#fff",flexShrink:0}}>{i+1}</div>
                <div style={{flex:1,minWidth:100}}>
                  <div style={{fontFamily:"monospace",color:C.cyan,fontWeight:700}}>{t.short}{i<5&&<span style={{color:C.accent,marginLeft:5}}>★</span>}</div>
                  <div style={{fontSize:10,color:C.muted,marginTop:2}}>{t.count} trades · {fmt$(t.vol)} vol</div>
                </div>
                <div style={{display:"flex",gap:14,flexWrap:"wrap",alignItems:"center"}}>
                  {t.winRate!=null?(
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:20,fontWeight:800,color:t.winRate>=0.6?C.green:t.winRate>=0.5?C.yellow:C.red,fontFamily:"monospace"}}>{fmtPct(t.winRate)}</div>
                      <div style={{fontSize:9,color:C.muted}}>WIN RATE*</div>
                    </div>
                  ):(
                    <div style={{textAlign:"center"}}><div style={{fontSize:13,color:C.muted}}>N/A</div><div style={{fontSize:9,color:C.muted}}>NO RESOLVED</div></div>
                  )}
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:18,fontWeight:800,color:C.text,fontFamily:"monospace"}}>{Math.round(t.score)}</div>
                    <div style={{fontSize:9,color:C.muted}}>SCORE</div>
                  </div>
                  {t.resolved>0&&(
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:12,fontFamily:"monospace"}}><span style={{color:C.green}}>{t.wins}W</span><span style={{color:C.muted}}>/</span><span style={{color:C.red}}>{t.losses}L</span></div>
                      <div style={{fontSize:9,color:C.muted}}>{t.resolved} RESOLVED</div>
                    </div>
                  )}
                </div>
                {i<5&&pill(C.accent,"TRACKED")}
              </div>
            ))}
            <div style={{background:C.panel+"80",border:`1px solid ${C.border}`,borderRadius:6,padding:"9px 12px",marginTop:10,fontSize:11,color:C.dim,lineHeight:1.6}}>
              * <b style={{color:C.text}}>P&L Limitation Fix:</b> Polymarket CLOB doesn't expose realized P&L. This dashboard cross-references each trader's positions against <code style={{color:C.cyan}}>gamma-api.polymarket.com/markets?closed=true</code> — checking if they held YES/NO on the correct side when the market resolved. Requires min 3 resolved trades to display win-rate.
            </div>
          </div>
        )}

        {/* ORDER BOOK */}
        {tab==="book"&&(
          <div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
              <div>
                <div style={{marginBottom:7,fontWeight:700,color:C.green,fontSize:12}}>Bids — Buy orders</div>
                {card(
                  <div>
                    {(book?.bids||[]).slice(0,16).map((b,i)=>{
                      const is97=+b.price>=0.969&&+b.price<=0.971;
                      const maxS=Math.max(...(book?.bids||[{size:1}]).map(x=>+x.size));
                      return (
                        <div key={i} style={{display:"flex",alignItems:"center",gap:7,padding:"2px 0",position:"relative"}}>
                          <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${(+b.size/maxS*100).toFixed(0)}%`,background:is97?C.green+"35":C.green+"12",borderRadius:2}}/>
                          <span style={{fontFamily:"monospace",color:is97?C.green:+b.price>=0.96?C.yellow:C.text,fontWeight:is97?800:400,width:46,fontSize:12,zIndex:1}}>{fmtC(b.price)}</span>
                          <span style={{fontFamily:"monospace",color:C.text,flex:1,textAlign:"right",zIndex:1,fontSize:12}}>{Math.round(+b.size).toLocaleString()}</span>
                          {is97&&<span style={{color:C.green,fontSize:9,fontWeight:700,zIndex:1}}>◀ 97¢</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div>
                <div style={{marginBottom:7,fontWeight:700,color:C.red,fontSize:12}}>Asks — Sell orders</div>
                {card(
                  <div>
                    {(book?.asks||[]).slice(0,16).map((a,i)=>{
                      const maxS=Math.max(...(book?.asks||[{size:1}]).map(x=>+x.size));
                      return (
                        <div key={i} style={{display:"flex",alignItems:"center",gap:7,padding:"2px 0",position:"relative"}}>
                          <div style={{position:"absolute",right:0,top:0,bottom:0,width:`${(+a.size/maxS*100).toFixed(0)}%`,background:C.red+"15",borderRadius:2}}/>
                          <span style={{fontFamily:"monospace",color:C.text,width:46,zIndex:1,fontSize:12}}>{fmtC(a.price)}</span>
                          <span style={{fontFamily:"monospace",color:C.text,flex:1,textAlign:"right",zIndex:1,fontSize:12}}>{Math.round(+a.size).toLocaleString()}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            {book&&(
              <div style={{marginTop:14}}>
                {card(
                  <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
                    {[
                      ["Best bid", book.bids?.[0]?fmtC(book.bids[0].price):"-", C.green],
                      ["Best ask", book.asks?.[0]?fmtC(book.asks[0].price):"-", C.red],
                      ["Spread",   book.bids?.[0]&&book.asks?.[0]?`${((+book.asks[0].price-+book.bids[0].price)*100).toFixed(3)}¢`:"-", C.yellow],
                      ["Total bid liq", fmt$(book.bids.reduce((s,b)=>s+(+b.size),0)), C.green],
                      ["Total ask liq", fmt$(book.asks.reduce((s,a)=>s+(+a.size),0)), C.red],
                      ["Bid/ask ratio", (book.bids.reduce((s,b)=>s+(+b.size),0)/book.asks.reduce((s,a)=>s+(+a.size),0)).toFixed(2)+"×", C.cyan],
                      ["97¢ bid wall", s97?fmt$(s97.bidWall):"-", C.green],
                    ].map(([l,v,c])=>(
                      <div key={l}><div style={{fontSize:10,color:C.muted,marginBottom:2}}>{l}</div><div style={{fontSize:16,fontWeight:700,color:c,fontFamily:"monospace"}}>{v}</div></div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* 97¢ ANALYSIS */}
        {tab==="score97"&&s97&&(
          <div>
            <div style={{textAlign:"center",padding:"20px 0 16px",borderBottom:`1px solid ${C.border}`,marginBottom:18}}>
              <div style={{fontSize:68,fontWeight:900,color:s97.color,fontFamily:"monospace",lineHeight:1}}>{s97.total}</div>
              <div style={{fontSize:16,fontWeight:700,color:s97.color,marginTop:6}}>{s97.label}</div>
              <div style={{color:C.dim,fontSize:12,marginTop:4}}>Safety score for buying YES at 97¢ · 0 = dangerous, 100 = very safe</div>
            </div>
            <div style={{marginBottom:12,fontWeight:600,color:C.dim,fontSize:12}}>Factor breakdown</div>
            {Object.entries(s97.comps).map(([name,{v,w,raw}])=>{
              const pts=Math.round(v*w);
              return (
                <div key={name} style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"9px 12px",marginBottom:7}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                    <span style={{fontWeight:600,fontSize:12}}>{name}</span>
                    <div style={{display:"flex",gap:10,alignItems:"center"}}>
                      <span style={{color:C.muted,fontSize:10}}>weight {w}</span>
                      <span style={{fontFamily:"monospace",color:C.dim,fontSize:11}}>{raw}</span>
                      <span style={{fontFamily:"monospace",fontWeight:700,color:v>=0.7?C.green:v>=0.4?C.yellow:C.red,minWidth:50,textAlign:"right"}}>{pts}/{w}</span>
                    </div>
                  </div>
                  <div style={{background:C.border,borderRadius:3,height:5,overflow:"hidden"}}>
                    <div style={{width:`${(v*100).toFixed(0)}%`,height:5,background:v>=0.7?C.green:v>=0.4?C.yellow:C.red,borderRadius:3,transition:"width .4s"}}/>
                  </div>
                </div>
              );
            })}
            <div style={{background:s97.color+"12",border:`1px solid ${s97.color}44`,borderRadius:8,padding:"12px 14px",marginTop:14}}>
              <div style={{fontWeight:700,color:s97.color,marginBottom:8,fontSize:12}}>Buy guidance at 97¢</div>
              {s97.total>=72?(
                <ul style={{margin:0,paddingLeft:16,color:C.text,lineHeight:1.8,fontSize:12}}>
                  <li>Strong bid wall confirmed — low slippage risk at 97¢</li>
                  <li>Bid-to-ask ratio favors buyers at this level</li>
                  <li>Recent buy momentum validates directional bias</li>
                  <li>Tight spread — liquidity providers are active</li>
                  <li>Multiple pending orders in CLOB near 97¢</li>
                </ul>
              ):s97.total>=50?(
                <ul style={{margin:0,paddingLeft:16,color:C.text,lineHeight:1.8,fontSize:12}}>
                  <li>Moderate conditions — confirm position sizing before entry</li>
                  <li>Consider splitting into smaller tranches to reduce slippage</li>
                  <li>Monitor bid wall closely — thin support detected</li>
                </ul>
              ):(
                <ul style={{margin:0,paddingLeft:16,color:C.text,lineHeight:1.8,fontSize:12}}>
                  <li>Low bid support — price may slip through 97¢</li>
                  <li>Heavy ask pressure above — sellers present at this level</li>
                  <li>Wait for better setup or lower your entry target</li>
                </ul>
              )}
            </div>
            {card(
              <div>
                <div style={{fontWeight:600,marginBottom:8,color:C.dim,fontSize:12}}>CLOB snapshot</div>
                <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
                  {[
                    ["Best bid",  fmtC(s97.bestBid), C.green],
                    ["Best ask",  fmtC(s97.bestAsk), C.red],
                    ["Mid price", fmtC(s97.mid),     C.text],
                    ["Bid liq @97¢", fmt$(s97.bidWall), C.green],
                    ["Liq ratio", fmtPct(s97.liq),   C.cyan],
                  ].map(([l,v,c])=>(
                    <div key={l}><div style={{fontSize:10,color:C.muted}}>{l}</div><div style={{fontFamily:"monospace",fontWeight:700,color:c,fontSize:15}}>{v}</div></div>
                  ))}
                </div>
              </div>
            ,{marginTop:12})}
          </div>
        )}
      </div>
    </div>
  );
}
