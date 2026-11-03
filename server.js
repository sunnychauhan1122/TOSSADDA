require("dotenv").config();
const express=require("express"),helmet=require("helmet"),rateLimit=require("express-rate-limit"),bcrypt=require("bcryptjs"),jwt=require("jsonwebtoken"),Database=require("better-sqlite3"),path=require("path"),crypto=require("crypto");
const {JWT_SECRET,ADMIN_EMAIL,ADMIN_PASSWORD}=process.env,PORT=+process.env.PORT||3000;
if(!JWT_SECRET||JWT_SECRET.length<32)throw Error("Set JWT_SECRET (32+ chars) in .env");
const START=1000,MIN=100,MAX=1e9,MULT=1.9;
const app=express(),db=new Database(process.env.DB_FILE||"tossking.sqlite");app.set("trust proxy",1);db.pragma("busy_timeout = 5000");
const h=s=>crypto.createHash("sha256").update(String(s)).digest(),same=(a,b)=>crypto.timingSafeEqual(h(a),h(b));
app.use(helmet({contentSecurityPolicy:{directives:{"default-src":["'self'"],"style-src":["'self'","'unsafe-inline'"],"script-src":["'self'"],"img-src":["'self'","data:"],"connect-src":["'self'"],"upgrade-insecure-requests":null}}}));
app.use(express.json({limit:"20kb"}));
app.use("/api",rateLimit({windowMs:15*60*1000,max:400,standardHeaders:true,legacyHeaders:false}));
const strict=rateLimit({windowMs:15*60*1000,max:25,message:{error:"Too many attempts, try again later"}});
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,points INTEGER NOT NULL DEFAULT ${START},last_bonus TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY,competition TEXT NOT NULL,team_a TEXT NOT NULL,team_b TEXT NOT NULL,color_a TEXT NOT NULL DEFAULT '#f5c451',color_b TEXT NOT NULL DEFAULT '#2ee6b6',starts_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'OPEN',result TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS txns(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,type TEXT NOT NULL,descr TEXT NOT NULL,amount INTEGER NOT NULL,balance INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS predictions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),match_id TEXT NOT NULL REFERENCES matches(id),team TEXT NOT NULL,stake INTEGER NOT NULL DEFAULT 0,payout INTEGER,created_at TEXT NOT NULL);`);
for(const s of ["ALTER TABLE users ADD COLUMN last_bonus TEXT","ALTER TABLE matches ADD COLUMN result TEXT","ALTER TABLE predictions ADD COLUMN stake INTEGER NOT NULL DEFAULT 0","ALTER TABLE predictions ADD COLUMN payout INTEGER"])try{db.exec(s)}catch{}
if((db.prepare("SELECT sql FROM sqlite_master WHERE name='predictions'").get().sql||"").includes("UNIQUE(user_id,match_id)")){db.pragma("foreign_keys = OFF");db.transaction(()=>db.exec("ALTER TABLE predictions RENAME TO predictions_old;CREATE TABLE predictions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),match_id TEXT NOT NULL REFERENCES matches(id),team TEXT NOT NULL,stake INTEGER NOT NULL DEFAULT 0,payout INTEGER,created_at TEXT NOT NULL);INSERT INTO predictions(id,user_id,match_id,team,stake,payout,created_at) SELECT id,user_id,match_id,team,stake,payout,created_at FROM predictions_old;DROP TABLE predictions_old"))();db.pragma("foreign_keys = ON")}
const clients=new Set(),broadcast=()=>{for(const r of clients)try{r.write("data: u\n\n")}catch{}};
const now=()=>new Date().toISOString(),id=()=>crypto.randomUUID(),clean=(v,m=60)=>typeof v==="string"?v.trim().slice(0,m):"";
const log=(uid,type,descr,amount)=>db.prepare("INSERT INTO txns(user_id,type,descr,amount,balance,created_at) VALUES(?,?,?,?,(SELECT points FROM users WHERE id=?),?)").run(uid,type,descr,amount,uid,now());
const fail=(res,c,e)=>res.status(c).json({error:e}),pub=u=>({id:u.id,name:u.name,email:u.email,points:u.points,joined:u.created_at});
const tok=(sub,role,exp)=>jwt.sign({sub,role},JWT_SECRET,{expiresIn:exp});
const bearer=r=>(r.headers.authorization||"").replace(/^Bearer /,"");
const auth=(req,res,next)=>{try{const d=jwt.verify(bearer(req),JWT_SECRET),u=d.role==="user"&&db.prepare("SELECT * FROM users WHERE id=?").get(d.sub);if(!u)throw 0;req.user=u;next()}catch{fail(res,401,"Please sign in again")}};
const adminAuth=(req,res,next)=>{try{const d=jwt.verify(bearer(req),JWT_SECRET);if(d.role!=="admin")throw 0;next()}catch{fail(res,401,"Admin session expired - sign in again")}};
app.get("/api/stream",(req,res)=>{try{const d=jwt.verify(String(req.query.t||""),JWT_SECRET);if(d.role==="user"&&!db.prepare("SELECT 1 FROM users WHERE id=?").get(d.sub))throw 0}catch{return res.status(401).end()}
 res.set({"Content-Type":"text/event-stream","Cache-Control":"no-cache",Connection:"keep-alive"});res.flushHeaders();res.write("retry: 3000\n\n");clients.add(res);const ka=setInterval(()=>res.write(": ka\n\n"),25000);req.on("close",()=>{clearInterval(ka);clients.delete(res)})});
const MATCHES=`SELECT m.*,(SELECT COUNT(*) FROM predictions WHERE match_id=m.id AND team=m.team_a) votesA,(SELECT COUNT(*) FROM predictions WHERE match_id=m.id AND team=m.team_b) votesB,(SELECT COALESCE(SUM(stake),0) FROM predictions WHERE match_id=m.id AND team=m.team_a) poolA,(SELECT COALESCE(SUM(stake),0) FROM predictions WHERE match_id=m.id AND team=m.team_b) poolB,(SELECT COALESCE(SUM(stake),0) FROM predictions WHERE match_id=m.id) pool FROM matches m ORDER BY CASE WHEN m.starts_at>=? THEN 0 ELSE 1 END,CASE WHEN m.starts_at>=? THEN m.starts_at END ASC,m.starts_at DESC`;
const sod=()=>{const d=new Date(Date.now()+19800000);d.setUTCHours(0,0,0,0);const t=new Date(d.getTime()-19800000).toISOString();return t},ALLM=()=>{const t=sod();return db.prepare(MATCHES).all(t,t)};
// ---- telegram (2 channels: PUBLIC = schedule/results/anonymous bets, ADMIN = full user details)
const TGT=process.env.TG_BOT_TOKEN,PUB=process.env.TG_PUBLIC_CHANNEL,ADM=process.env.TG_ADMIN_CHANNEL;
const esc=t=>String(t).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])),code=n=>"TKB"+String(1000+n);
const ist=iso=>new Date(iso).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",hour12:true});
const queues={};
function tg(chat,text){if(!TGT||!chat)return;const q=queues[chat]||(queues[chat]={items:[],busy:false});q.items.push(text);if(q.busy)return;q.busy=true;
 (async()=>{while(q.items.length){const t=q.items.shift();try{const r=await fetch(`https://api.telegram.org/bot${TGT}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chat,text:t,parse_mode:"HTML",disable_web_page_preview:true})});
  if(r.status===429){const j=await r.json().catch(()=>({}));q.items.unshift(t);await new Promise(o=>setTimeout(o,((j.parameters&&j.parameters.retry_after)||5)*1000))}}catch{}
  await new Promise(o=>setTimeout(o,1200))}q.busy=false})()}
const tgBoth=(pub,adm)=>{tg(PUB,pub);tg(ADM,adm||pub)};
function scheduleText(){const t=sod(),end=new Date(Date.parse(t)+864e5).toISOString();
 const ms=db.prepare("SELECT * FROM matches WHERE starts_at>=? AND starts_at<? AND status!='VOID' ORDER BY starts_at").all(t,end);
 if(!ms.length)return null;
 return `\u{1F3CF} <b>TOSSKING TOSS SCHEDULE</b>\n\u{1F4C5} ${new Date(Date.now()).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"long",year:"numeric"})}\n\n`+ms.map(m=>`\u{1F380} ${esc(m.team_a)} v ${esc(m.team_b)} - ${new Date(m.starts_at).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit",hour12:true})}${m.status==="SETTLED"?" \u2705 "+esc(m.result):""}`).join("\n")+"\n\n\u{1F4B0} Free-play points only. No real money."}
let lastSched="";setInterval(()=>{const i=new Date(Date.now()+19800000),k=i.toISOString().slice(0,10);if(i.getUTCHours()===8&&i.getUTCMinutes()<2&&lastSched!==k){lastSched=k;const t=scheduleText();if(t)tgBoth(t)}},30000);
// ---- user auth
app.post("/api/auth/register",strict,async(req,res)=>{const name=clean(req.body.name,20),email=clean(req.body.email,120).toLowerCase(),pw=req.body.password;
 if(name.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||typeof pw!=="string"||pw.length<8||pw.length>100)return fail(res,400,"Enter a name, valid email and password (8-100 characters)");
 if(db.prepare("SELECT 1 FROM users WHERE email=?").get(email))return fail(res,409,"Email is already registered");
 const uid=id();db.prepare("INSERT INTO users(id,name,email,password_hash,created_at) VALUES(?,?,?,?,?)").run(uid,name,email,await bcrypt.hash(pw,10),now());
 res.json({token:tok(uid,"user","7d")})});
app.post("/api/auth/login",strict,async(req,res)=>{const u=db.prepare("SELECT * FROM users WHERE email=?").get(clean(req.body.email,120).toLowerCase());
 if(!u||!await bcrypt.compare(String(req.body.password||""),u.password_hash))return fail(res,401,"Incorrect email or password");res.json({token:tok(u.id,"user","7d")})});
app.get("/api/me",auth,(req,res)=>{const e=db.prepare("SELECT COALESCE(SUM(p.stake),0) n FROM predictions p JOIN matches m ON m.id=p.match_id WHERE p.user_id=? AND m.status IN ('OPEN','CLOSED')").get(req.user.id).n;res.json({user:{...pub(req.user),exposure:e}})});
// ---- game
app.get("/api/config",(req,res)=>res.json({min:MIN,max:MAX,mult:MULT,wa:(process.env.SUPPORT_WHATSAPP||"").replace(/\D/g,""),mail:process.env.SUPPORT_EMAIL||""}));
app.get("/api/matches",auth,(req,res)=>res.json({matches:ALLM().map(m=>({id:m.id,competition:m.competition,teamA:m.team_a,teamB:m.team_b,colorA:m.color_a,colorB:m.color_b,startsAt:m.starts_at,status:m.status,result:m.result,votesA:m.votesA,votesB:m.votesB,poolA:m.poolA,poolB:m.poolB,pool:m.pool}))}));
app.post("/api/matches/:id/predictions",auth,(req,res)=>{const m=db.prepare("SELECT * FROM matches WHERE id=?").get(req.params.id),team=clean(req.body.team),stake=Number(req.body.stake);
 if(!m)return fail(res,404,"Match not found");if(m.status!=="OPEN"||Date.now()>=Date.parse(m.starts_at))return fail(res,409,"Betting is closed for this match");
 if(team!==m.team_a&&team!==m.team_b)return fail(res,400,"Choose one of the listed teams");
 if(!Number.isInteger(stake)||stake<MIN||stake>MAX)return fail(res,400,`Minimum ${MIN} points required`);
 try{db.transaction(()=>{const u=db.prepare("SELECT points FROM users WHERE id=?").get(req.user.id);if(u.points<stake)throw Error("NOPTS");
  db.prepare("INSERT INTO predictions(id,user_id,match_id,team,stake,created_at) VALUES(?,?,?,?,?,?)").run(id(),req.user.id,m.id,team,stake,now());
  db.prepare("UPDATE users SET points=points-? WHERE id=?").run(stake,req.user.id);log(req.user.id,"BET",`Bet: ${m.team_a} vs ${m.team_b} (${team})`,-stake)})();broadcast();{const rid=db.prepare("SELECT rowid r FROM users WHERE id=?").get(req.user.id).r,tot=db.prepare("SELECT COALESCE(SUM(stake),0) n FROM predictions WHERE match_id=? AND team=?").get(m.id,team).n;
  tgBoth(`\u{1F381} <b>${code(rid)}</b> ${esc(team)} \u26A1${stake}`,`\u{1F381} <b>${esc(req.user.name)}</b> (${code(rid)}, ${esc(req.user.email)})\n${esc(m.team_a)} v ${esc(m.team_b)}\nTeam: <b>${esc(team)}</b> | Stake: <b>${stake}</b> pts | Pool on ${esc(team)}: ${tot}`)}res.json({ok:true})}
 catch(e){fail(res,409,e.message==="NOPTS"?"Not enough points":"Could not place bet, try again")}});
app.get("/api/my-predictions",auth,(req,res)=>res.json({predictions:db.prepare("SELECT p.team,p.stake,p.payout,p.created_at createdAt,m.team_a teamA,m.team_b teamB,m.id matchId,m.status,m.result FROM predictions p JOIN matches m ON m.id=p.match_id WHERE p.user_id=? ORDER BY p.created_at DESC").all(req.user.id)}));
app.get("/api/statement",auth,(req,res)=>res.json({rows:db.prepare("SELECT type,descr,amount,balance,created_at createdAt FROM txns WHERE user_id=? ORDER BY id DESC LIMIT 100").all(req.user.id)}));
app.get("/api/winners",auth,(req,res)=>res.json({rows:db.prepare("SELECT u.name,SUM(p.payout-p.stake) net FROM predictions p JOIN users u ON u.id=p.user_id JOIN matches m ON m.id=p.match_id WHERE m.status='SETTLED' AND p.created_at>=? GROUP BY u.id HAVING net>0 ORDER BY net DESC LIMIT 5").all(new Date(Date.now()-864e5).toISOString())}));
app.get("/api/leaderboard",auth,(req,res)=>res.json({rows:db.prepare("SELECT name,points FROM users ORDER BY points DESC LIMIT 20").all()}));
// ---- admin
app.post("/api/admin/login",strict,(req,res)=>{const e=clean(req.body.email,120).toLowerCase();
 if(!ADMIN_EMAIL||!ADMIN_PASSWORD||!same(e,ADMIN_EMAIL.toLowerCase())||!same(req.body.password||"",ADMIN_PASSWORD))return fail(res,401,"Invalid admin email or password");
 res.json({token:tok("site-admin","admin","4h")})});
app.get("/api/admin/overview",adminAuth,(req,res)=>{const n=s=>db.prepare(s).get().n;
 res.json({stats:{users:n("SELECT COUNT(*) n FROM users"),openMatches:n("SELECT COUNT(*) n FROM matches WHERE status='OPEN'"),predictions:n("SELECT COUNT(*) n FROM predictions"),points:n("SELECT COALESCE(SUM(points),0) n FROM users")},
 matches:ALLM().map(m=>({id:m.id,teamA:m.team_a,teamB:m.team_b,status:m.status,result:m.result,startsAt:m.starts_at,predictions:m.votesA+m.votesB,pool:m.pool})),
 recent:db.prepare("SELECT u.name,m.team_a teamA,m.team_b teamB,p.team,p.stake,p.created_at createdAt FROM predictions p JOIN users u ON u.id=p.user_id JOIN matches m ON m.id=p.match_id ORDER BY p.created_at DESC LIMIT 30").all(),
 users:db.prepare("SELECT id,name,email,points,created_at createdAt FROM users ORDER BY created_at DESC LIMIT 50").all()})});
app.post("/api/admin/matches",adminAuth,(req,res)=>{const c=clean(req.body.competition,80),a=clean(req.body.teamA),b=clean(req.body.teamB),t=new Date(req.body.startsAt);
 if(!c||!a||!b||a.toLowerCase()===b.toLowerCase()||isNaN(t))return fail(res,400,"Enter a competition, two different teams and a valid start time");
 db.prepare("INSERT INTO matches(id,competition,team_a,team_b,starts_at,created_at) VALUES(?,?,?,?,?,?)").run(id(),c,a,b,t.toISOString(),now());broadcast();
 tgBoth(`\u{1F4C5} <b>NEW MATCH</b> - ${esc(c)}\n\u{1F380} ${esc(a)} v ${esc(b)}\n\u23F0 Bets close: ${ist(t.toISOString())}`);res.json({ok:true})});
app.post("/api/admin/matches/:id/close",adminAuth,(req,res)=>db.prepare("UPDATE matches SET status='CLOSED' WHERE id=? AND status='OPEN'").run(req.params.id).changes?(broadcast(),(()=>{const m=db.prepare("SELECT * FROM matches WHERE id=?").get(req.params.id);tgBoth(`\u{1F512} <b>Betting closed</b>: ${esc(m.team_a)} v ${esc(m.team_b)}`)})(),res.json({ok:true})):fail(res,404,"Open match not found"));
app.post("/api/admin/users/:id/points",adminAuth,(req,res)=>{const a=Math.trunc(Number(req.body.amount));if(!Number.isFinite(a)||!a||Math.abs(a)>1e7)return fail(res,400,"Enter a valid points amount");
 const u=db.prepare("SELECT points FROM users WHERE id=?").get(req.params.id);if(!u)return fail(res,404,"User not found");if(u.points+a<0)return fail(res,400,"User balance cannot go below 0");
 db.prepare("UPDATE users SET points=points+? WHERE id=?").run(a,req.params.id);log(req.params.id,"ADJUST",a>0?"Points added by admin":"Points removed by admin",a);broadcast();res.json({ok:true})});
app.post("/api/admin/users/:id/password",adminAuth,async(req,res)=>{const pw=req.body.password;if(typeof pw!=="string"||pw.length<8||pw.length>100)return fail(res,400,"Password must be 8-100 characters");
 if(!db.prepare("SELECT 1 FROM users WHERE id=?").get(req.params.id))return fail(res,404,"User not found");
 db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(await bcrypt.hash(pw,10),req.params.id);res.json({ok:true})});
// settle / correct: winners get 1.9x. If the result is changed later, old payouts are reversed and the new ones paid automatically.
function settle(mid,winner,decision){const m=db.prepare("SELECT * FROM matches WHERE id=?").get(mid);if(!m)return false;
 const status=winner?"SETTLED":"VOID",redo=m.status==="SETTLED"||m.status==="VOID";if(redo&&m.status===status&&(m.result||null)===(winner||null))return false;
 const ps=db.prepare("SELECT * FROM predictions WHERE match_id=?").all(mid),title=`${m.team_a} vs ${m.team_b}`;
 db.transaction(()=>{for(const p of ps){const pay=!winner?p.stake:p.team===winner?Math.floor(p.stake*MULT):0,d=pay-(redo?(p.payout||0):0);
  db.prepare("UPDATE predictions SET payout=? WHERE id=?").run(pay,p.id);
  if(d){db.prepare("UPDATE users SET points=points+? WHERE id=?").run(d,p.user_id);log(p.user_id,redo?"FIX":!winner?"REFUND":"WIN",redo?`Result corrected: ${title} (${winner?winner+" won":"void"})`:!winner?`Refund: ${title}`:`Win: ${title}`,d)}}
  db.prepare("UPDATE matches SET status=?,result=? WHERE id=?").run(status,winner||null,mid)})();broadcast();
 {const ws=winner?ps.filter(p=>p.team===winner):[],paid=ws.reduce((a,p)=>a+Math.floor(p.stake*MULT),0);
  if(winner){const T=`${esc(m.team_a)} VS ${esc(m.team_b)}`,dec=decision==="BAT"?"BAT":decision==="BOWL"?"BOWL":"";
   tg(PUB,`\u{1F3CF} <b>${T}</b>\n\u2705 <b>ALL BETS SETTLED</b> \u2705\n\n\u{1F3CF} <b>${esc(winner).toUpperCase()}</b> \u{1F3CF} <b>WON THE TOSS</b> \u2705\u2705\n\n\u2764\uFE0F <b>FASTEST SETTLEMENT</b> \u2764\uFE0F`);
   if(dec)tg(PUB,`\u{1F3CF} <b>${esc(winner).toUpperCase()}</b> WON THE TOSS AND DECIDED TO ${dec} \u2705\u2705`);
   tg(ADM,`\u2705 <b>${esc(title)}</b> - <b>${esc(winner)}</b> won toss${dec?" ("+dec+")":""}\n\u{1F3C6} ${ws.length} winners | ${paid} pts paid`)}
  else tgBoth(`\u26A0\uFE0F <b>${esc(m.team_a)} VS ${esc(m.team_b)}</b>\nMATCH VOID - ALL BETS REFUNDED`)}return true}
app.post("/api/admin/matches/:id/settle",adminAuth,(req,res)=>{const m=db.prepare("SELECT * FROM matches WHERE id=?").get(req.params.id),w=clean(req.body.winner);
 if(!m||(w!==m.team_a&&w!==m.team_b))return fail(res,400,"Pick a valid winner");settle(m.id,w,clean(req.body.decision,10).toUpperCase())?res.json({ok:true}):fail(res,409,"Result is already set to that")});
app.post("/api/admin/matches/:id/void",adminAuth,(req,res)=>settle(req.params.id,null)?res.json({ok:true}):fail(res,409,"Result is already set to that"));
app.get("/api/admin/matches/:id/bets",adminAuth,(req,res)=>{const m=db.prepare("SELECT * FROM matches WHERE id=?").get(req.params.id);if(!m)return fail(res,404,"Match not found");
 const rows=db.prepare("SELECT u.rowid r,u.name,u.email,p.team,p.stake,p.payout,p.created_at createdAt FROM predictions p JOIN users u ON u.id=p.user_id WHERE p.match_id=? ORDER BY p.created_at DESC").all(m.id).map(x=>({userCode:code(x.r),name:x.name,email:x.email,team:x.team,stake:x.stake,payout:x.payout,createdAt:x.createdAt}));
 const sum=t=>rows.filter(x=>x.team===t).reduce((a,x)=>a+x.stake,0);res.json({match:{teamA:m.team_a,teamB:m.team_b,status:m.status,result:m.result},poolA:sum(m.team_a),poolB:sum(m.team_b),bets:rows})});
app.get("/api/admin/bets",adminAuth,(req,res)=>res.json({bets:db.prepare("SELECT u.rowid r,u.name,u.email,m.team_a teamA,m.team_b teamB,m.starts_at startsAt,p.team,p.stake,p.payout,p.created_at createdAt FROM predictions p JOIN users u ON u.id=p.user_id JOIN matches m ON m.id=p.match_id ORDER BY p.created_at DESC LIMIT 300").all().map(x=>({...x,userCode:code(x.r)}))}));
app.post("/api/admin/matches/:id/decision",adminAuth,(req,res)=>{const m=db.prepare("SELECT * FROM matches WHERE id=?").get(req.params.id),d=clean(req.body.decision,10).toUpperCase();if(!m||m.status!=="SETTLED"||!["BAT","BOWL"].includes(d))return fail(res,400,"Match must be settled and decision BAT or BOWL");tg(PUB,`\u{1F3CF} <b>${esc(m.result).toUpperCase()}</b> WON THE TOSS AND DECIDED TO ${d} \u2705\u2705`);res.json({ok:true})});
app.post("/api/admin/matches/:id/delete",adminAuth,(req,res)=>{const m=db.prepare("SELECT * FROM matches WHERE id=?").get(req.params.id);if(!m)return fail(res,404,"Match not found");
 const ps=db.prepare("SELECT * FROM predictions WHERE match_id=?").all(m.id),live=m.status==="OPEN"||m.status==="CLOSED";
 db.transaction(()=>{if(live)for(const p of ps){db.prepare("UPDATE users SET points=points+? WHERE id=?").run(p.stake,p.user_id);log(p.user_id,"REFUND",`Refund (match deleted): ${m.team_a} vs ${m.team_b}`,p.stake)}
  db.prepare("DELETE FROM predictions WHERE match_id=?").run(m.id);db.prepare("DELETE FROM matches WHERE id=?").run(m.id)})();broadcast();
 tg(ADM,`\u{1F5D1} Match deleted: ${esc(m.team_a)} v ${esc(m.team_b)}${live&&ps.length?" - "+ps.length+" bets refunded":""}`);res.json({ok:true})});
app.post("/api/admin/telegram/schedule",adminAuth,(req,res)=>{const t=scheduleText();if(!t)return fail(res,404,"No matches today");tgBoth(t);res.json({ok:true})});
app.post("/api/admin/telegram/test",adminAuth,(req,res)=>{if(!TGT)return fail(res,400,"TG_BOT_TOKEN not set in .env");tgBoth("\u2705 TOSSKING bot connected (public)","\u2705 TOSSKING bot connected (admin)");res.json({ok:true})});
app.get("/api/activity",auth,(req,res)=>res.json({rows:db.prepare("SELECT u.rowid r,p.team,p.stake FROM predictions p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 12").all().map(x=>({code:code(x.r),team:x.team,stake:x.stake}))}));
app.use("/api",(req,res)=>fail(res,404,"API route not found"));
app.use(express.static(path.join(__dirname,"public")));
app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`TOSSKING running on http://localhost:${PORT}  |  admin: /admin`));