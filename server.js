const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const DESTINATIONS = [
  { id:'BKK', name:'Bangkok', country:'Thailand', region:'Asia Pacific', base:620, growth:.14, social:82, sentiment:.78, price:76, sell:124, cancel:.12, supply:940, hotel:true, flight:true },
  { id:'DXB', name:'Dubai', country:'UAE', region:'Middle East', base:570, growth:.09, social:64, sentiment:.71, price:118, sell:182, cancel:.09, supply:720, hotel:true, flight:true },
  { id:'IST', name:'Istanbul', country:'Türkiye', region:'Europe', base:485, growth:.19, social:91, sentiment:.84, price:83, sell:139, cancel:.11, supply:680, hotel:true, flight:true },
  { id:'SIN', name:'Singapore', country:'Singapore', region:'Asia Pacific', base:450, growth:.08, social:59, sentiment:.82, price:132, sell:198, cancel:.07, supply:510, hotel:true, flight:true },
  { id:'TYO', name:'Tokyo', country:'Japan', region:'Asia Pacific', base:410, growth:.24, social:96, sentiment:.88, price:146, sell:224, cancel:.08, supply:560, hotel:true, flight:true },
  { id:'PAR', name:'Paris', country:'France', region:'Europe', base:390, growth:.07, social:73, sentiment:.75, price:158, sell:236, cancel:.14, supply:480, hotel:true, flight:true },
  { id:'CMB', name:'Colombo', country:'Sri Lanka', region:'South Asia', base:280, growth:.16, social:68, sentiment:.73, price:61, sell:102, cancel:.16, supply:390, hotel:true, flight:true },
  { id:'KTM', name:'Kathmandu', country:'Nepal', region:'South Asia', base:215, growth:.12, social:54, sentiment:.69, price:52, sell:91, cancel:.18, supply:330, hotel:true, flight:true }
];
const CATEGORIES = [
  { id:'hotel', name:'Hotel rooms', multiplier:1, cost:1, sell:1, cancellation:.04, salvage:.22, fee:.06 },
  { id:'flight', name:'Flight seats', multiplier:.62, cost:.73, sell:.68, cancellation:.07, salvage:.08, fee:.045 }
];
const EVENTS = [
  { destination:'Tokyo', event:'Cherry blossom shoulder season', date:'Apr 2027', impact:'+18%', type:'Seasonal', status:'Scenario signal' },
  { destination:'Istanbul', event:'Spring cultural calendar', date:'May 2027', impact:'+12%', type:'Cultural', status:'Scenario signal' },
  { destination:'Bangkok', event:'Songkran travel period', date:'Apr 2027', impact:'+22%', type:'Festival', status:'Scenario signal' },
  { destination:'Dubai', event:'Winter sun demand window', date:'Dec 2026', impact:'+14%', type:'Seasonal', status:'Scenario signal' },
  { destination:'Paris', event:'Summer peak season', date:'Jun 2027', impact:'+16%', type:'Seasonal', status:'Scenario signal' }
];
function round(n, d=0) { const p=10**d; return Math.round((n+Number.EPSILON)*p)/p; }
function historical() {
  return Array.from({length:12}, (_, i) => {
    const season=1+0.12*Math.sin((i/12)*Math.PI*2-1.15);
    const bookings=DESTINATIONS.reduce((sum,x)=>sum+Math.round(x.base*season*(.88+i*.011)),0);
    return { month:new Date(Date.UTC(2025+i/12, i%12, 1)).toLocaleString('en',{month:'short', timeZone:'UTC'}), bookings, searches:Math.round(bookings*5.25), cancellations:Math.round(bookings*.115), soldOut:Math.round(2+i*.34) };
  });
}
function opportunities(signals={}) {
  const demandShift=Number(signals.demandShift||0), socialWeight=Number(signals.socialWeight??.08), supplierShift=Number(signals.supplierShift||0), cancelShift=Number(signals.cancelShift||0);
  return DESTINATIONS.flatMap(d => CATEGORIES.map(c => {
    const hist=Math.round(d.base*c.multiplier);
    const socialLift=Math.max(-.03,Math.min(.18,(d.social-55)/300*socialWeight/.08));
    const marketGrowth=d.growth+socialLift;
    // `base` is an average monthly booking level; project a three-month travel
    // window so displayed forecasts align with the dashboard's 90-day horizon.
    const forecast=Math.max(1,Math.round(hist*3*(1+marketGrowth+demandShift)));
    const available=Math.floor(d.supply*c.multiplier*(c.id==='flight'?.88:1));
    const cost=round(d.price*c.cost*(1+supplierShift),2), sell=round(d.sell*c.sell,2), cancel=Math.min(.55,Math.max(.01,d.cancel+c.cancellation+cancelShift));
    const margin=sell*(1-cancel)-sell*c.fee-cost*(1-cancel)-cost*cancel*(1-c.salvage);
    const serviceDemand=forecast*(c.id==='flight'?.90:1);
    const conversion=round(.19+(d.sentiment-.65)*.32,3);
    const expectedSales=Math.min(forecast,Math.round(serviceDemand*conversion/.22));
    const optimal=Math.min(available,Math.max(0,Math.ceil(expectedSales*.91)));
    const revenue=round(Math.min(optimal,expectedSales)*sell*(1-cancel),2);
    const procurementCost=round(optimal*cost,2);
    const other=round(optimal*sell*c.fee,2);
    const expectedLoss=round(Math.max(0,optimal-expectedSales)*cost*(1-c.salvage)+optimal*cancel*cost*(1-c.salvage),2);
    const profit=round(revenue-procurementCost-other+round(optimal*cancel*cost*c.salvage,2),2);
    const risk=round(Math.min(99,Math.max(8,(cancel*100)*.48+(Math.max(0,optimal-expectedSales)/Math.max(1,optimal))*100*.34+(d.id==='CMB'||d.id==='KTM'?14:7))),0);
    const score=round(Math.max(0,Math.min(100,50+marketGrowth*105+(margin/Math.max(1,cost))*16-risk*.28)),0);
    const label=score>=72&&risk<32?'High potential':risk>=40?'High risk':score>=54?'Moderate':'Low potential';
    return { destination:d.name, code:d.id, region:d.region, category:c.id, categoryName:c.name, historical:hist, forecast, available, cost, sell, conversion, cancellation:round(cancel,3), expectedSales, recommended:optimal, revenue, profit, risk, score, label, social:d.social, sentiment:d.sentiment, growth:round(marketGrowth*100,1), margin:round(margin,2), explanation:`${forecast} forecast ${c.id==='hotel'?'room':'seat'} demand, ${round(marketGrowth*100,1)}% growth trend and ${available} available units. Expected unit economics are ${margin>=0?'positive':'negative'} after cancellation exposure; estimated cancellation is ${round(cancel*100,1)}%. Social attention is an unverified supporting signal.` };
  })).sort((a,b)=>b.score-a.score);
}
function optimize({budget=250000, riskTolerance=55, minMargin=0, demandShift=0, supplierShift=0, cancelShift=0, socialWeight=.08, category='all', destination='all'}={}) {
  budget=Number(budget); riskTolerance=Number(riskTolerance); minMargin=Number(minMargin);
  if(!Number.isFinite(budget)||budget<0||budget>100000000) throw new Error('Budget must be between $0 and $100,000,000.');
  if(!Number.isFinite(riskTolerance)||riskTolerance<0||riskTolerance>100) throw new Error('Risk tolerance must be between 0 and 100.');
  if(!Number.isFinite(minMargin)||minMargin<0||minMargin>100) throw new Error('Minimum margin must be between 0 and 100%.');
  const rows=opportunities({demandShift,supplierShift,cancelShift,socialWeight}).filter(x=>(category==='all'||x.category===category)&&(destination==='all'||x.code===destination));
  const riskLimit=15+riskTolerance*.75;
  let remaining=budget; const picks=[];
  // Prioritize risk-adjusted unit contribution, purchase only if the expected
  // contribution clears the floor. Greedy allocation is auditable and capped.
  const ranked=rows.filter(x=>x.margin>0&&x.risk<=riskLimit&&x.margin/x.cost*100>=minMargin).sort((a,b)=>(b.margin*(1-b.risk/150)/b.cost)-(a.margin*(1-a.risk/150)/a.cost));
  for(const row of ranked){
    const units=Math.min(row.recommended,Math.floor(remaining/row.cost));
    if(!units) continue;
    const revenue=round(Math.min(units,row.expectedSales)*row.sell*(1-row.cancellation),2);
    const cost=round(units*row.cost,2), other=round(units*row.sell*.05,2);
    const loss=round(Math.max(0,units-row.expectedSales)*row.cost*.78+units*row.cancellation*row.cost*.78,2);
    const profit=round(revenue-cost-other+units*row.cancellation*row.cost*.22,2);
    picks.push({...row, recommended:units, revenue, procurementCost:cost, otherCosts:other, expectedLoss:loss, profit, riskExposure:round(loss,2)});
    remaining=round(remaining-cost,2);
  }
  const investment=round(budget-remaining,2), revenue=round(picks.reduce((s,x)=>s+x.revenue,0),2), profit=round(picks.reduce((s,x)=>s+x.profit,0),2), riskExposure=round(picks.reduce((s,x)=>s+x.riskExposure,0),2);
  return { budget, investment, remaining, revenue, profit, riskExposure, roi:investment?round(profit/investment*100,1):0, purchases:picks.sort((a,b)=>b.profit-a.profit), rejected:rows.filter(x=>!picks.some(p=>p.code===x.code&&p.category===x.category)).slice(0,5).map(x=>({destination:x.destination,categoryName:x.categoryName,reason:x.margin<=0?'Negative expected unit contribution':x.risk>riskLimit?'Outside current risk tolerance':`Fails ${minMargin}% minimum margin or budget cap`})), assumptions:{demandShift,supplierShift,cancelShift,socialWeight,riskTolerance,minMargin}, model:'Risk-adjusted contribution ranking with supplier, demand and availability caps; deterministic prototype, not a trained ML model.' };
}
function dashboard() {
  const hist=historical(), opp=opportunities(), plan=optimize();
  return { historical:hist, destinations:DESTINATIONS, opportunities:opp, plan, events:EVENTS,
    kpis:{ bookings:hist.reduce((s,x)=>s+x.bookings,0), forecast:opp.filter(x=>x.category==='hotel').reduce((s,x)=>s+x.forecast,0), searches:hist.reduce((s,x)=>s+x.searches,0), cancellations:hist.reduce((s,x)=>s+x.cancellations,0), soldOut:hist.reduce((s,x)=>s+x.soldOut,0) },
    social:DESTINATIONS.map(d=>({destination:d.name,mentions:d.social,change:round(d.growth*100,1),sentiment:d.sentiment,label:'Simulated social signal'})) };
}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  res.setHeader('Access-Control-Allow-Origin','*');
  try{
    if(req.method==='GET'&&url.pathname==='/api/dashboard'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(dashboard()));}
    if(req.method==='GET'&&url.pathname==='/api/opportunities'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(opportunities(Object.fromEntries(url.searchParams))));}
    if(req.method==='POST'&&url.pathname==='/api/optimize'){
      let body='';req.on('data',chunk=>{body+=chunk;if(body.length>1e6)throw new Error('Payload too large');});
      req.on('end',()=>{try{const result=optimize(JSON.parse(body||'{}'));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));}catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}});return;
    }
    if(req.method==='GET'){
      const pathname=url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname);
      const file=path.resolve(__dirname,'.'+pathname);
      if(!file.startsWith(__dirname+path.sep)){res.writeHead(403);return res.end('Forbidden');}
      fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found');}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(data);});return;
    }
    res.writeHead(405);res.end('Method not allowed');
  }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
});
if(require.main===module)server.listen(PORT,()=>console.log(`TravelPulse running at http://localhost:${PORT}`));
module.exports={server,optimize,opportunities,historical,dashboard};
