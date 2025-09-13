/* =========================================================
   Basket Scoreboard — App Logic (IndexedDB + UI behaviors)
   ========================================================= */

const DB_NAME = 'basket-scoreboard';
const DB_VER  = 9; // v9: Player Admin (advanced), avatars, bulk import/export
const BONUS_LIMIT = 5;

/* ========== IndexedDB ========== */
let db;
function openDB(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e)=>{
      const db = e.target.result;
      if(!db.objectStoreNames.contains('players')){
        const s = db.createObjectStore('players',{ keyPath:'id' }); // id: `${team}#${number}`
        s.createIndex('team','team',{unique:false});
      }
      if(!db.objectStoreNames.contains('game')){
        db.createObjectStore('game',{ keyPath:'k' });
      }
      if(!db.objectStoreNames.contains('file')){
        db.createObjectStore('file',{ keyPath:'k' });
      }
    };
    req.onsuccess = ()=>{ db=req.result; resolve(db); };
    req.onerror = ()=>reject(req.error);
  });
}
function tx(store,mode='readonly'){ return db.transaction(store,mode).objectStore(store); }
const put = (store,val)=>new Promise((res,rej)=>{ const r=tx(store,'readwrite').put(val); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); });
const get = (store,key)=>new Promise((res,rej)=>{ const r=tx(store).get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
const del = (store,key)=>new Promise((res,rej)=>{ const r=tx(store,'readwrite').delete(key); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); });
const allPlayers = ()=>new Promise((res,rej)=>{ const r=tx('players').getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error); });

/* ========== State ========== */
const state = {
  gameTitle:'',
  period:1,
  home:{score:0,timeouts:6,teamFouls:0},
  away:{score:0,timeouts:6,teamFouls:0},
  rules:{
    countCommon:true,
    countOffensive:false,
    countTechnical:false,
    countUnsportsmanlike:true,
    limitPF:5, limitT:2, limitU:2
  },
  referees:{ crew:'', u1:'', u2:'' },
  shot:{ ms:24000, running:false, lastTs:null, poss:'home' },
  game:{ ms:12*60*1000, totalMs:12*60*1000, running:false, lastTs:null, linkShot:false },
  ui:{ view:'scoreView' }
};

/* ========== Utilities ========== */
const deepCopy = (o)=>JSON.parse(JSON.stringify(o));
async function saveState(){ await put('game',{k:'state', v:deepCopy(state)}); }
const $ = (sel)=>document.querySelector(sel);
const idOf = (team,num)=>`${team}#${num}`;
const sideLabel = (t)=> t==='home'?'主隊':'客隊';
const periodLabel = (n)=> n<=4 ? `第${n}節` : `OT${n-4}`;
const fmtMin = (ms)=>{ const s=Math.floor(Math.max(0,ms)/1000); const m=Math.floor(s/60); const sec=s%60; return `${m}:${String(sec).padStart(2,'0')}`; };

/* ========== Init / Load ========== */
async function loadState(){
  const saved = await get('game','state');
  if(saved){ Object.assign(state,saved.v||saved); }
  if($('#gameTitle')) $('#gameTitle').value = state.gameTitle || '';
  setScore('home', state.home.score);
  setScore('away', state.away.score);
  renderTeamFouls('home'); renderTeamFouls('away');
  renderPeriod();
  updateShotUI(true); updateGameUI(true);

  // Rules
  $('#ruleCountCommon').checked = !!state.rules.countCommon;
  $('#ruleCountOffensive').checked = !!state.rules.countOffensive;
  $('#ruleCountTechnical').checked = !!state.rules.countTechnical;
  $('#ruleCountUnsportsmanlike').checked = !!state.rules.countUnsportsmanlike;
  $('#limitPF').value = state.rules.limitPF;
  $('#limitT').value  = state.rules.limitT;
  $('#limitU').value  = state.rules.limitU;

  // Referees
  const R = state.referees || {};
  $('#refCrew') && ($('#refCrew').value = R.crew || '');
  $('#refU1') && ($('#refU1').value = R.u1 || '');
  $('#refU2') && ($('#refU2').value = R.u2 || '');

  setView(state.ui.view || 'scoreView');
  if(state.shot.running) startShot(true);
  if(state.game.running) startGame(true);
}

/* ========== Period / Score ========== */
function renderPeriod(){ const el=$('#period'); if(el) el.textContent = periodLabel(state.period); }
function setScore(side, val){
  state[side].score = Math.max(0, val|0);
  const el = $('#'+side+'Score'); if(el) el.textContent = state[side].score;
  saveState();
}

/* ========== Team Fouls ========== */
function renderTeamFouls(side){
  const n = Math.max(0, state[side].teamFouls|0);
  const foulEl = $('#'+side+'Fouls'); if(foulEl) foulEl.textContent = n;
  const bonusEl = $('#'+side+'Bonus'); if(bonusEl) bonusEl.style.display = n >= BONUS_LIMIT ? 'inline-flex' : 'none';
  saveState();
}
function addTeamFoul(side, delta){
  state[side].teamFouls = Math.max(0, (state[side].teamFouls|0) + delta);
  renderTeamFouls(side);
}
function resetTeamFouls(){
  state.home.teamFouls = 0; state.away.teamFouls = 0;
  renderTeamFouls('home'); renderTeamFouls('away');
}

/* ========== Players (with advanced profile) ========== */
function ensurePlayerShape(p){
  // Base identity fields (for Admin page)
  p.team = p.team || 'home';
  p.number = Number(p.number||0);
  p.nameZh = p.nameZh || p.name || ''; // backward compatible
  p.nameEn = p.nameEn || '';
  p.pos = p.pos || '';
  p.role = p.role || 'bench';
  p.height = Number(p.height||0);
  p.weight = Number(p.weight||0);
  p.dob = p.dob || ''; // YYYY-MM-DD
  p.nationality = p.nationality || '';
  p.hand = p.hand || 'R';
  p.arc = p.arc || ''; // role/arc preference (3&D..)
  p.numberStyle = p.numberStyle || '';
  p.regId = p.regId || '';
  p.email = p.email || '';
  p.phone = p.phone || '';
  p.avatar = p.avatar || ''; // dataURL or URL

  // In-game stats (for Players view)
  p.PTS|=0; p.AST|=0; p.REB|=0; p.STL|=0; p.BLK|=0; p.TOV|=0;
  p.PF|=0; p.PFOFF|=0; p.PFT|=0; p.PFU|=0;
  p.oncourt = !!p.oncourt;
  p.playMs = p.playMs|0;

  // Alerts
  if(p.alertedPF===undefined) p.alertedPF=false;
  if(p.alertedT===undefined)  p.alertedT=false;
  if(p.alertedU===undefined)  p.alertedU=false;

  // Legacy compat
  if(p.name && !p.nameZh) p.nameZh = p.name;

  return p;
}
function needsFlag(p){
  const overPF = (p.PF|0) >= (state.rules.limitPF|0);
  const overT  = (p.PFT|0) >= (state.rules.limitT|0);
  const overU  = (p.PFU|0) >= (state.rules.limitU|0);
  return { overPF, overT, overU };
}

/* ===== Players View (box score quick panel) ===== */
function trForPlayer(p0){
  const p = ensurePlayerShape(p0);
  const tr = document.createElement('tr'); tr.dataset.id=p.id;
  const {overPF,overT,overU} = needsFlag(p);
  if(overT || overU) tr.classList.add('tr-eject');
  else if(overPF) tr.classList.add('tr-flag');

  const cells = [
    ['team', p.team==='home'?'主隊':'客隊', false],
    ['number', p.number, true],
    ['nameZh', p.nameZh||'', true],
    ['pos', p.pos||'', true],
    ['PTS', p.PTS|0, false],
    ['PF',  p.PF|0,  false],
    ['PFOFF', p.PFOFF|0, false],
    ['PFT', p.PFT|0, false],
    ['PFU', p.PFU|0, false],
    ['AST', p.AST|0, false],
    ['REB', p.REB|0, false],
    ['STL', p.STL|0, false],
    ['BLK', p.BLK|0, false],
    ['TOV', p.TOV|0, false],
  ];
  for(const [k,val,editable] of cells){
    const td = document.createElement('td');
    td.className = ['PTS','PF','PFOFF','PFT','PFU','AST','REB','STL','BLK','TOV'].includes(k)?'mono':'';
    td.textContent = val;
    if(editable){
      td.contentEditable = true;
      td.addEventListener('blur', async ()=>{
        const rec = await get('players', p.id);
        if(!rec) return;
        if(k==='number'){
          const newNum = parseInt(td.textContent||'0',10)||0;
          if(newNum!==rec.number){
            await del('players', rec.id);
            rec.number = newNum;
            rec.id = idOf(rec.team, newNum);
          }
        }else{
          rec[k] = td.textContent.trim();
        }
        await put('players', ensurePlayerShape(rec));
        renderPlayers();
        renderRoster(); // keep admin view in sync
      });
    }
    tr.appendChild(td);
  }

  const tdOn = document.createElement('td');
  const chk = document.createElement('input'); chk.type='checkbox'; chk.checked = !!p.oncourt;
  chk.addEventListener('change', async ()=>{
    const rec = await get('players', p.id); if(!rec) return;
    rec.oncourt = chk.checked; await put('players', ensurePlayerShape(rec));
  });
  tdOn.appendChild(chk); tr.appendChild(tdOn);

  const tdMin = document.createElement('td'); tdMin.className='mono'; tdMin.textContent = fmtMin(p.playMs); tr.appendChild(tdMin);

  const op = document.createElement('td');
  const box = document.createElement('div'); box.className='opset';
  const mkBtn=(txt, cls, fn)=>{ const b=document.createElement('button'); b.textContent=txt; b.className='opbtn '+(cls||''); b.addEventListener('click', fn); return b; };
  box.appendChild(mkBtn('+ 一般','btn-warn', ()=> updatePersonalFoul(p.id,'common', +1)));
  box.appendChild(mkBtn('+ 進攻','btn-warn', ()=> updatePersonalFoul(p.id,'offensive', +1)));
  box.appendChild(mkBtn('+ 技','btn-warn', ()=> updatePersonalFoul(p.id,'technical', +1)));
  box.appendChild(mkBtn('+ 違體','btn-warn', ()=> updatePersonalFoul(p.id,'unsportsmanlike', +1)));
  box.appendChild(mkBtn('- 一般',null, ()=> updatePersonalFoul(p.id,'common', -1)));
  box.appendChild(mkBtn('- 進攻',null, ()=> updatePersonalFoul(p.id,'offensive', -1)));
  box.appendChild(mkBtn('- 技',null, ()=> updatePersonalFoul(p.id,'technical', -1)));
  box.appendChild(mkBtn('- 違體',null, ()=> updatePersonalFoul(p.id,'unsportsmanlike', -1)));
  box.appendChild(mkBtn('刪除','', async ()=>{ await del('players', p.id); renderPlayers(); renderRoster(); }));
  op.appendChild(box); tr.appendChild(op);

  return tr;
}
async function renderPlayers(){
  const players = (await allPlayers()).map(ensurePlayerShape);
  const tbody = document.querySelector('#playersTbl tbody'); if(!tbody) return;
  tbody.innerHTML='';
  players.sort((a,b)=> (a.team===b.team?0:(a.team==='home'?-1:1)) || (a.number-b.number));
  for(const p of players){ tbody.appendChild(trForPlayer(p)); }
}

/* ===== Upper-limit alerts ===== */
async function maybeAlertLimits(rec){
  const {overPF,overT,overU} = needsFlag(rec);
  let changed=false, msgs=[];
  if(overPF && !rec.alertedPF){ rec.alertedPF=true; changed=true; msgs.push(`【提醒】${sideLabel(rec.team)} #${rec.number} 個人犯滿（≥${state.rules.limitPF}）。`); }
  if(overT && !rec.alertedT){ rec.alertedT=true; changed=true; msgs.push(`【退場條件】${sideLabel(rec.team)} #${rec.number} 技術犯規達上限（${state.rules.limitT}）。`); }
  if(overU && !rec.alertedU){ rec.alertedU=true; changed=true; msgs.push(`【退場條件】${sideLabel(rec.team)} #${rec.number} 違體犯規達上限（${state.rules.limitU}）。`); }
  if(changed){ await put('players', rec); alert(msgs.join('\n')); }
}
async function updatePersonalFoul(playerId, type, delta){
  const rec = await get('players', playerId);
  if(!rec) return;
  ensurePlayerShape(rec);
  if(type==='common'){ rec.PF = Math.max(0,(rec.PF|0)+delta); }
  else if(type==='offensive'){ rec.PFOFF = Math.max(0,(rec.PFOFF|0)+delta); }
  else if(type==='technical'){ rec.PFT = Math.max(0,(rec.PFT|0)+delta); }
  else if(type==='unsportsmanlike'){ rec.PFU = Math.max(0,(rec.PFU|0)+delta); }
  rec.PF = Math.max(0,(rec.PFOFF|0)+(rec.PFT|0)+(rec.PFU|0)+(rec.PF|0));
  let countToTeam = false;
  if(type==='common' && state.rules.countCommon) countToTeam = true;
  if(type==='offensive' && state.rules.countOffensive) countToTeam = true;
  if(type==='technical' && state.rules.countTechnical) countToTeam = true;
  if(type==='unsportsmanlike' && state.rules.countUnsportsmanlike) countToTeam = true;
  if(countToTeam){ addTeamFoul(rec.team, delta); }
  await put('players', rec);
  await maybeAlertLimits(rec);
  renderPlayers();
}

/* ========== Tabs ========== */
function setView(viewId){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById(viewId)?.classList.add('active');
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.view===viewId));
  state.ui.view = viewId; saveState();
}
document.querySelectorAll('.tab').forEach(btn=> btn.addEventListener('click', ()=> setView(btn.dataset.view)));

/* ========== Shot Clock ========== */
let shotTimer = null, lastShownWhole = null;
function fmtShot(ms){ const s=Math.max(0,ms)/1000; return s>8?String(Math.ceil(s|0)):s.toFixed(2); }
function updateShotUI(force=false){
  const d = document.getElementById('shotDisplay'); const pos = document.getElementById('shotPos'); if(!d||!pos) return;
  const s = state.shot.ms/1000; d.classList.toggle('shot-danger', s<=8);
  if(s>8 && !force){ const whole=Math.ceil(s); if(whole===lastShownWhole){ pos.textContent=`球權：${sideLabel(state.shot.poss)}${state.shot.running?'（計時中）':''}`; return; } lastShownWhole=whole; }
  d.textContent = fmtShot(state.shot.ms);
  pos.textContent = `球權：${sideLabel(state.shot.poss)}${state.shot.running?'（計時中）':''}`;
  saveState();
}
function buzzer(){
  try{
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type='square'; o.frequency.value= 440;
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime+0.01);
    o.start();
    setTimeout(()=>{ g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+0.6); o.stop(ctx.currentTime+0.65); ctx.close(); }, 600);
  }catch(e){}
}
function pickShotInterval(){ return (state.shot.ms/1000 > 8) ? 200 : 50; }
function startShot(){
  if(shotTimer) clearInterval(shotTimer);
  state.shot.running = true; state.shot.lastTs = performance.now();
  const tick = ()=>{
    const now = performance.now(), elapsed = now - state.shot.lastTs; state.shot.lastTs = now; state.shot.ms -= elapsed;
    if(state.shot.ms <= 0){ state.shot.ms=0; updateShotUI(true); clearInterval(shotTimer); shotTimer=null; state.shot.running=false; buzzer(); shotViolationAuto(); }
    else{ updateShotUI(); const newInt = pickShotInterval(); if(newInt!==shotTickInterval){ clearInterval(shotTimer); shotTickInterval=newInt; shotTimer=setInterval(tick, shotTickInterval); } }
  };
  let shotTickInterval = pickShotInterval();
  shotTimer = setInterval(tick, shotTickInterval);
  updateShotUI(true);
}
function pauseShot(){ if(shotTimer){ clearInterval(shotTimer); shotTimer=null; } state.shot.running=false; state.shot.lastTs=null; updateShotUI(true); }
function resetShot(ms, {autoRunIfLinked=false}={}){
  state.shot.ms = ms; state.shot.lastTs = performance.now(); lastShownWhole=null; updateShotUI(true);
  if(state.shot.running){ clearInterval(shotTimer); startShot(); }
  if(autoRunIfLinked && state.game.linkShot && state.game.running && !state.shot.running){ startShot(); }
}
function swapPossession(){ state.shot.poss = (state.shot.poss==='home'?'away':'home'); updateShotUI(true); }
async function shotViolationAuto(){
  const team = state.shot.poss;
  const notes = document.getElementById('notes'); if(notes){ notes.value += (notes.value?'\r\n':'') + `【${new Date().toLocaleTimeString()}】${sideLabel(team)} 24秒違例`; }
  swapPossession(); resetShot(24000,{autoRunIfLinked:true}); await saveState();
}
async function shotViolationManual(){ pauseShot(); buzzer(); await shotViolationAuto(); }

/* ========== Game Clock (with playtime accrual) ========== */
let gameTimer = null, gameLastShownSec = null;
function fmtGame(ms){
  const t = Math.max(0, ms|0), s = Math.floor(t/1000), m = Math.floor(s/60), sec = s%60;
  if(s>=60) return `${String(m).padStart(1,'0')}:${String(sec).padStart(2,'0')}`;
  const hundred = Math.floor((t%1000)/10);
  return `${String(m).padStart(1,'0')}:${String(sec).padStart(2,'0')}.${String(hundred).padStart(2,'0')}`;
}
async function accruePlaytime(elapsedMs){
  const players = await allPlayers();
  let changed=false;
  for(const p of players){
    if(p.oncourt){ p.playMs = (p.playMs|0) + elapsedMs; changed=true; await put('players', ensurePlayerShape(p)); }
  }
  if(changed){ renderPlayers(); renderRosterMINOnly(); }
}
function updateGameUI(force=false){
  const d=$('#gameDisplay'), info=$('#gameInfo'); if(!d||!info) return;
  const s = Math.floor(state.game.ms/1000); d.classList.toggle('game-danger', s<60);
  if(s>=60 && !force){ if(s===gameLastShownSec){ info.textContent = `長度：${fmtGame(state.game.totalMs)}`; return; } gameLastShownSec=s; }
  d.textContent = fmtGame(state.game.ms);
  info.textContent = `長度：${fmtGame(state.game.totalMs)}`;
  const linkBtn = $('#toggleLink'); linkBtn && (linkBtn.textContent = `與 24s 連動：${state.game.linkShot?'開':'關'}`);
  saveState();
}
function startGame(){
  if(gameTimer) clearInterval(gameTimer);
  state.game.running=true; state.game.lastTs=performance.now();
  if(state.game.linkShot && !state.shot.running) startShot();
  const tick=async ()=>{
    const now=performance.now(), elapsed=now-state.game.lastTs;
    state.game.lastTs=now; state.game.ms-=elapsed;
    await accruePlaytime(elapsed);
    if(state.game.ms<=0){ state.game.ms=0; updateGameUI(true); clearInterval(gameTimer); gameTimer=null; state.game.running=false; buzzer(); nextPeriod(); }
    else{ updateGameUI(); }
  };
  gameTimer=setInterval(tick,(state.game.ms>=60*1000)?250:50); updateGameUI(true);
}
function pauseGame(){ if(gameTimer){ clearInterval(gameTimer); gameTimer=null; } state.game.running=false; state.game.lastTs=null; if(state.game.linkShot && state.shot.running) pauseShot(); updateGameUI(true); }
function setGameLength(mins){ const ms=mins*60*1000; state.game.totalMs=ms; state.game.ms=ms; gameLastShownSec=null; updateGameUI(true); if(state.game.running){ clearInterval(gameTimer); startGame(); } }
function resetGameClock(){ state.game.ms=state.game.totalMs; gameLastShownSec=null; updateGameUI(true); }
function nextPeriod(){
  state.period += 1;
  if(state.period<=4){ resetGameClock(); }
  else{ state.game.totalMs = 5*60*1000; resetGameClock(); }
  resetTeamFouls(); resetShot(24000,{autoRunIfLinked:true}); renderPeriod(); saveState();
}

/* ========== Notes helper ========== */
async function appendNote(text){
  const notes = $('#notes'); if(notes){ notes.value += (notes.value?'\r\n':'') + `【${new Date().toLocaleTimeString()}】` + text; }
  await saveState();
}
function sideOpp(side){ return side==='home'?'away':'home'; }
function getEvtTarget(){
  const team = $('#evtTeam')?.value || 'home';
  const num  = parseInt($('#evtNum')?.value||'0',10);
  if(!num){ alert('請先輸入背號'); return null; }
  return {team,num,id:idOf(team,num)};
}

/* ========== Free Throw Helper ========== */
const ft = { team:'home', attempts:2, results:[] };
function openFT(team, attempts, titleNote){
  ft.team = team; ft.attempts = attempts; ft.results = new Array(attempts).fill(null);
  $('#ftInfo').textContent = `${sideLabel(team)} 罰球（${attempts} 次）${titleNote?`｜${titleNote}`:''}`;
  const shots = $('#ftShots'); shots.innerHTML='';
  for(let i=0;i<attempts;i++){
    const makeBtn = document.createElement('button'); makeBtn.className='btn ft-btn'; makeBtn.textContent=`第${i+1}罰：命中`;
    const missBtn = document.createElement('button'); missBtn.className='btn ft-btn'; missBtn.textContent=`第${i+1}罰：未中`;
    makeBtn.onclick=()=>{ ft.results[i]=true; makeBtn.classList.add('btn-accent'); missBtn.classList.remove('btn-danger'); };
    missBtn.onclick=()=>{ ft.results[i]=false; missBtn.classList.add('btn-danger'); makeBtn.classList.remove('btn-accent'); };
    shots.appendChild(makeBtn); shots.appendChild(missBtn);
  }
  $('#ftModal').style.display='flex';
}
function closeFT(){ $('#ftModal').style.display='none'; }
function bindFT(){
  $('#ftClose').onclick = closeFT;
  $('#ftReset').onclick = ()=> openFT(ft.team, ft.attempts);
  $('#ftDone').onclick = async ()=>{
    let made = ft.results.filter(v=>v===true).length;
    if(made>0){ setScore(ft.team, state[ft.team].score + made); }
    await appendNote(`${sideLabel(ft.team)} 罰球 ${ft.attempts} 次，命中 ${made}。`);
    closeFT();
  };
}

/* ========== Event Panel binds ========== */
async function eventAddFoul(playerId, type, note){
  await updatePersonalFoul(playerId, type, +1);
  await appendNote(note);
}
function bindEventPanel(){
  $('#evDefCommon')?.addEventListener('click', async ()=>{
    const tgt = getEvtTarget(); if(!tgt) return;
    await eventAddFoul(tgt.id,'common', `${sideLabel(tgt.team)} #${tgt.num} 防守犯規 → ${sideLabel(sideOpp(tgt.team))} 兩罰`);
    openFT(sideOpp(tgt.team), 2, '防守犯規');
  });
  $('#evOffensive')?.addEventListener('click', async ()=>{
    const tgt = getEvtTarget(); if(!tgt) return;
    await eventAddFoul(tgt.id,'offensive', `${sideLabel(tgt.team)} #${tgt.num} 進攻犯規（控球犯規）`);
    swapPossession(); resetShot(24000,{autoRunIfLinked:true});
  });
  $('#evShoot2')?.addEventListener('click', async ()=>{
    const tgt = getEvtTarget(); if(!tgt) return;
    await eventAddFoul(tgt.id,'common', `${sideLabel(tgt.team)} #${tgt.num} 投籃犯規（2罰）`);
    openFT(sideOpp(tgt.team), 2, '投籃犯規');
  });
  $('#evShoot3')?.addEventListener('click', async ()=>{
    const tgt = getEvtTarget(); if(!tgt) return;
    await eventAddFoul(tgt.id,'common', `${sideLabel(tgt.team)} #${tgt.num} 投籃犯規（3罰）`);
    openFT(sideOpp(tgt.team), 3, '投籃犯規');
  });
  $('#evAnd1')?.addEventListener('click', async ()=>{
    const tgt = getEvtTarget(); if(!tgt) return;
    await eventAddFoul(tgt.id,'common', `${sideLabel(tgt.team)} #${tgt.num} And-1（投籃成球+一罰）`);
    openFT(sideOpp(tgt.team), 1, 'And-1');
  });
  $('#evTechnical')?.addEventListener('click', async ()=>{
    const tgt = getEvtTarget(); if(!tgt) return;
    await eventAddFoul(tgt.id,'technical', `${sideLabel(tgt.team)} #${tgt.num} 技術犯規`);
    openFT(sideOpp(tgt.team), 1, '技術犯規');
  });
  $('#evUnsports')?.addEventListener('click', async ()=>{
    const tgt = getEvtTarget(); if(!tgt) return;
    await eventAddFoul(tgt.id,'unsportsmanlike', `${sideLabel(tgt.team)} #${tgt.num} 違體犯規`);
    openFT(sideOpp(tgt.team), 2, '違體犯規');
  });
}

/* ========== Export TXT / CSV / JSON ========== */
function buildHeaderLines(){
  const L = [];
  L.push(`# ${state.gameTitle || '未命名比賽'}`);
  L.push(`# Period: ${periodLabel(state.period)}`);
  L.push(`# Score: HOME ${state.home.score} - AWAY ${state.away.score}`);
  L.push(`# TeamFouls: HOME ${state.home.teamFouls} / AWAY ${state.away.teamFouls}${(state.home.teamFouls>=BONUS_LIMIT||state.away.teamFouls>=BONUS_LIMIT)?' (Bonus in effect)':''}`);
  L.push(`# Timeouts: HOME ${state.home.timeouts} / AWAY ${state.away.timeouts}`);
  L.push(`# GameClock: ${fmtGame(state.game.ms)} / ${fmtGame(state.game.totalMs)}${state.game.running?' (running)':''}`);
  L.push(`# Possession: ${state.shot.poss==='home'?'HOME':'AWAY'}`);
  const R = state.referees || {};
  const refLine = [`Crew Chief: ${R.crew||'-'}`, `Umpire 1: ${R.u1||'-'}`, `Umpire 2: ${R.u2||'-'}`].join(' | ');
  L.push(`# Referees: ${refLine}`);
  const s = state.shot.ms/1000;
  L.push(`# ShotClock: ${s>8?Math.ceil(s):s.toFixed(2)}s ${state.shot.running?'(running)':''}`);
  return L;
}
function buildTxt(players){
  const L = buildHeaderLines();
  L.push('');
  L.push('Team,Number,Name,Pos,PTS,PF_Total,PF_Off,PF_Tech,PF_Unspt,AST,REB,STL,BLK,TOV,ON,MIN');
  players.sort((a,b)=> (a.team===b.team?0:(a.team==='home'?-1:1)) || (a.number-b.number))
    .forEach(p=>{
      p=ensurePlayerShape(p);
      const row=[p.team,p.number,p.nameZh||p.name||'',p.pos,p.PTS|0,(p.PF|0),(p.PFOFF|0),(p.PFT|0),(p.PFU|0),p.AST|0,p.REB|0,p.STL|0,p.BLK|0,p.TOV|0,p.oncourt?1:0,fmtMin(p.playMs)];
      L.push(row.join(','));
    });
  const notes = ($('#notes')?.value||'').trim();
  if(notes){ L.push(''); L.push('--- Notes ---'); L.push(notes); }
  return L.join('\r\n');
}
function buildCSV(players){
  const rows = [];
  rows.push(['GameTitle', state.gameTitle||'']);
  rows.push(['Period', periodLabel(state.period)]);
  rows.push(['Score', `HOME ${state.home.score} - AWAY ${state.away.score}`]);
  rows.push(['TeamFouls', `HOME ${state.home.teamFouls} / AWAY ${state.away.teamFouls}`]);
  const R = state.referees||{};
  rows.push(['Referees', `Crew Chief: ${R.crew||'-'} | U1: ${R.u1||'-'} | U2: ${R.u2||'-'}`]);
  rows.push([]);
  rows.push(['Team','Number','Name','Pos','PTS','PF_Total','PF_Off','PF_Tech','PF_Unspt','AST','REB','STL','BLK','TOV','ON','MIN']);
  players.sort((a,b)=> (a.team===b.team?0:(a.team==='home'?-1:1)) || (a.number-b.number))
    .forEach(p=>{
      p=ensurePlayerShape(p);
      rows.push([p.team,p.number,p.nameZh||p.name||'',p.pos,p.PTS|0,(p.PF|0),(p.PFOFF|0),(p.PFT|0),(p.PFU|0),p.AST|0,p.REB|0,p.STL|0,p.BLK|0,p.TOV|0,p.oncourt?1:0,fmtMin(p.playMs)]);
    });
  return rows.map(r=>r.join(',')).join('\r\n');
}
function buildJSON(players){
  const obj = {
    game:{
      title: state.gameTitle||'',
      period: state.period,
      score:{home:state.home.score, away:state.away.score},
      teamFouls:{home:state.home.teamFouls, away:state.away.teamFouls},
      gameClock:{remainingMs: state.game.ms, periodLengthMs: state.game.totalMs, running: state.game.running},
      shotClock:{remainingMs: state.shot.ms, possession: state.shot.poss, running: state.shot.running},
      referees: state.referees
    },
    players: players.map(p=>({
      team:p.team, number:p.number, nameZh:p.nameZh||p.name||'', nameEn:p.nameEn||'',
      pos:p.pos, role:p.role, height:p.height, weight:p.weight, dob:p.dob, nationality:p.nationality,
      hand:p.hand, arc:p.arc, numberStyle:p.numberStyle, regId:p.regId, email:p.email, phone:p.phone, avatar:p.avatar||'',
      stats:{ PTS:p.PTS|0, PF_total:p.PF|0, PF_off:p.PFOFF|0, PF_tech:p.PFT|0, PF_unspt:p.PFU|0, AST:p.AST|0, REB:p.REB|0, STL:p.STL|0, BLK:p.BLK|0, TOV:p.TOV|0 },
      on:p.oncourt?1:0, playMs:p.playMs|0, playMin:fmtMin(p.playMs)
    })),
    notes: ($('#notes')?.value||'').trim()
  };
  return JSON.stringify(obj, null, 2);
}
async function getSavedHandle(){ const rec = await get('file','txtHandle'); return rec?.handle || null; }
async function setSavedHandle(handle){ try{ if(handle?.requestPermission) await handle.requestPermission({mode:'readwrite'});}catch(e){} await put('file',{k:'txtHandle', handle}); }
async function saveAsTxt(){
  const players = (await allPlayers()).map(ensurePlayerShape);
  const txt = buildTxt(players);
  const bom = '\ufeff';
  if(window.showSaveFilePicker){
    const handle = await window.showSaveFilePicker({ suggestedName:(state.gameTitle||'game')+'.txt', types:[{description:'Text',accept:{'text/plain':['.txt']}}] });
    const w = await handle.createWritable(); await w.write(bom+txt); await w.close(); await setSavedHandle(handle);
    alert('已匯出 TXT 並記住檔案位置。之後可用「更新」覆寫。');
  }else{
    const blob = new Blob([bom, txt], {type:'text/plain;charset=utf-8'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = (state.gameTitle||'game') + '-' + new Date().toISOString().replaceAll(':','').slice(0,15)+'.txt';
    a.click(); URL.revokeObjectURL(a.href);
    alert('瀏覽器不支援覆寫同檔，已下載新檔（含 UTF-8 BOM）。');
  }
}
async function updateTxt(){
  const handle = await getSavedHandle();
  if(!handle){ await saveAsTxt(); return; }
  try{
    const players = (await allPlayers()).map(ensurePlayerShape);
    const txt = buildTxt(players);
    const w = await handle.createWritable(); await w.write('\ufeff'+txt); await w.close();
    alert('已更新並覆寫原檔。');
  }catch(err){ console.warn(err); await saveAsTxt(); }
}
async function saveAsCSV(){
  const players = (await allPlayers()).map(ensurePlayerShape);
  const csv = buildCSV(players);
  const bom = '\ufeff';
  const blob = new Blob([bom, csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = (state.gameTitle||'game') + '.csv'; a.click(); URL.revokeObjectURL(a.href);
}
async function saveAsJSON(){
  const players = (await allPlayers()).map(ensurePlayerShape);
  const json = buildJSON(players);
  const blob = new Blob([json], {type:'application/json;charset=utf-8'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = (state.gameTitle||'game') + '.json'; a.click(); URL.revokeObjectURL(a.href);
}

/* ========== Player Admin (High-end) ========== */
// form inputs
const fm = {
  team:     ()=>$('#fmTeam'),
  number:   ()=>$('#fmNumber'),
  nameZh:   ()=>$('#fmNameZh'),
  nameEn:   ()=>$('#fmNameEn'),
  pos:      ()=>$('#fmPos'),
  role:     ()=>$('#fmRole'),
  height:   ()=>$('#fmHeight'),
  weight:   ()=>$('#fmWeight'),
  dob:      ()=>$('#fmDob'),
  nationality: ()=>$('#fmNationality'),
  hand:     ()=>$('#fmHand'),
  arc:      ()=>$('#fmArc'),
  numberStyle: ()=>$('#fmNumberStyle'),
  regId:    ()=>$('#fmRegId'),
  email:    ()=>$('#fmEmail'),
  phone:    ()=>$('#fmPhone'),
  avatarFile: ()=>$('#fmAvatar'),
  avatarUrl:  ()=>$('#fmAvatarUrl'),
  avatarPreview: ()=>$('#fmAvatarPreview')
};
function clearPlayerForm(){
  fm.team().value='home';
  fm.number().value='';
  fm.nameZh().value='';
  fm.nameEn().value='';
  fm.pos().value='PG';
  fm.role().value='bench';
  fm.height().value=''; fm.weight().value='';
  fm.dob().value=''; fm.nationality().value='';
  fm.hand().value='R'; fm.arc().value='';
  fm.numberStyle().value=''; fm.regId().value='';
  fm.email().value=''; fm.phone().value='';
  fm.avatarFile().value=''; fm.avatarUrl().value='';
  fm.avatarPreview().src='';
}
function fillPlayerForm(p){
  p=ensurePlayerShape(p);
  fm.team().value = p.team;
  fm.number().value = p.number;
  fm.nameZh().value = p.nameZh||'';
  fm.nameEn().value = p.nameEn||'';
  fm.pos().value = p.pos||'PG';
  fm.role().value = p.role||'bench';
  fm.height().value = p.height||'';
  fm.weight().value = p.weight||'';
  fm.dob().value = p.dob||'';
  fm.nationality().value = p.nationality||'';
  fm.hand().value = p.hand||'R';
  fm.arc().value = p.arc||'';
  fm.numberStyle().value = p.numberStyle||'';
  fm.regId().value = p.regId||'';
  fm.email().value = p.email||'';
  fm.phone().value = p.phone||'';
  fm.avatarPreview().src = p.avatar||'';
}
function readFileAsDataURL(file){
  return new Promise((resolve,reject)=>{
    const fr = new FileReader();
    fr.onload = ()=> resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}
async function resolveAvatarValue(){
  const file = fm.avatarFile().files?.[0];
  const url = fm.avatarUrl().value.trim();
  if(file){ try{ return await readFileAsDataURL(file); }catch(e){ console.warn(e); } }
  if(url){ return url; }
  // if both empty, keep as is (empty string will be saved)
  return '';
}
async function savePlayerFromForm(){
  const team = fm.team().value || 'home';
  const number = parseInt(fm.number().value||'0',10);
  if(!number){ alert('請輸入背號（數字）'); return; }
  const avatar = await resolveAvatarValue();
  const rec = ensurePlayerShape({
    id: idOf(team, number),
    team, number,
    nameZh: fm.nameZh().value.trim(),
    nameEn: fm.nameEn().value.trim(),
    pos: fm.pos().value,
    role: fm.role().value,
    height: parseInt(fm.height().value||'0',10)||0,
    weight: parseInt(fm.weight().value||'0',10)||0,
    dob: fm.dob().value || '',
    nationality: fm.nationality().value.trim(),
    hand: fm.hand().value,
    arc: fm.arc().value,
    numberStyle: fm.numberStyle().value.trim(),
    regId: fm.regId().value.trim(),
    email: fm.email().value.trim(),
    phone: fm.phone().value.trim(),
    avatar
  });
  // merge existing stats if present
  const existed = await get('players', rec.id);
  if(existed){
    rec.PTS = existed.PTS|0; rec.AST = existed.AST|0; rec.REB = existed.REB|0; rec.STL = existed.STL|0; rec.BLK = existed.BLK|0; rec.TOV = existed.TOV|0;
    rec.PF = existed.PF|0; rec.PFOFF = existed.PFOFF|0; rec.PFT = existed.PFT|0; rec.PFU = existed.PFU|0;
    rec.oncourt = !!existed.oncourt; rec.playMs = existed.playMs|0;
    rec.alertedPF = !!existed.alertedPF; rec.alertedT = !!existed.alertedT; rec.alertedU = !!existed.alertedU;
  }
  await put('players', rec);
  alert('已儲存 / 更新球員');
  renderPlayers(); renderRoster();
}
function rosterRow(p){
  const tr = document.createElement('tr'); tr.dataset.id = p.id;
  const td = (t)=>{ const x=document.createElement('td'); x.textContent=t; return x; };
  tr.appendChild(td(p.team==='home'?'主':'客'));
  tr.appendChild(td(p.number));
  tr.appendChild(td(p.nameZh||''));
  tr.appendChild(td(p.nameEn||''));
  tr.appendChild(td(p.pos||''));
  tr.appendChild(td(p.height?`${p.height}`:'')); 
  tr.appendChild(td(p.weight?`${p.weight}`:'')); 
  tr.appendChild(td(p.dob||'')); 
  tr.appendChild(td(p.nationality||'')); 
  tr.appendChild(td(p.role||'')); 
  tr.appendChild(td(p.hand||'')); 
  tr.appendChild(td(p.regId||''));
  // contact (email/phone)
  const tdContact = document.createElement('td');
  tdContact.textContent = [p.email||'', p.phone||''].filter(Boolean).join(' / ');
  tr.appendChild(tdContact);
  // avatar
  const tdAv = document.createElement('td');
  if(p.avatar){
    const img=document.createElement('img'); img.src=p.avatar; img.className='roster-avatar'; tdAv.appendChild(img);
  }else{
    tdAv.textContent='—';
  }
  tr.appendChild(tdAv);

  // ops
  const tdOp = document.createElement('td');
  const box = document.createElement('div'); box.className='opset';
  const mk=(txt,cls,fn)=>{ const b=document.createElement('button'); b.textContent=txt; b.className='opbtn '+(cls||''); b.onclick=fn; return b; };
  box.appendChild(mk('編輯','btn-accent', async ()=>{ const rec=await get('players', p.id); if(rec){ fillPlayerForm(rec); setView('playerAdminView'); } }));
  box.appendChild(mk('刪除','btn-danger', async ()=>{
    if(confirm(`刪除 ${p.team==='home'?'主隊':'客隊'} #${p.number} ${p.nameZh||''}？`)){
      await del('players', p.id); renderRoster(); renderPlayers();
    }
  }));
  tdOp.appendChild(box);
  tr.appendChild(tdOp);
  return tr;
}
function applyRosterFilterKeyword(p, kw){
  if(!kw) return true;
  const k = kw.toLowerCase();
  return [
    p.team, String(p.number), p.nameZh||'', p.nameEn||'', p.pos||'', p.role||'', p.nationality||'', p.regId||''
  ].some(v=> String(v).toLowerCase().includes(k));
}
async function renderRoster(){
  const filterTeam = $('#filterTeam')?.value || 'all';
  const kw = $('#filterKeyword')?.value?.trim() || '';
  const list = (await allPlayers()).map(ensurePlayerShape)
    .filter(p=> filterTeam==='all' ? true : p.team===filterTeam)
    .filter(p=> applyRosterFilterKeyword(p, kw))
    .sort((a,b)=> (a.team===b.team?0:(a.team==='home'?-1:1)) || (a.number-b.number));
  const tb = $('#rosterTbl tbody'); if(!tb) return;
  tb.innerHTML='';
  list.forEach(p=> tb.appendChild(rosterRow(p)));
}
async function renderRosterMINOnly(){
  // For frequent updates from game clock; only update MIN column in roster table for performance
  const tb = $('#rosterTbl tbody'); if(!tb || !tb.children.length) return;
  const map = new Map(); (await allPlayers()).forEach(p=> map.set(p.id, ensurePlayerShape(p)));
  Array.from(tb.children).forEach(tr=>{
    const id = tr.dataset.id; const p = map.get(id);
    if(!p) return;
    // MIN is column index where? We used: team,number,nameZh,nameEn,pos,height,weight,dob,nationality,role,hand,regId,contact,avatar,ops
    // No MIN here: so nothing to update.
    // If you later add a MIN col to roster, update here.
  });
}

/* ===== Player Admin: CSV Export, Clear Roster ===== */
function rosterToCSV(rows){
  return rows.map(r=> r.map(x=>{
    const s = (x==null?'':String(x));
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(',')).join('\r\n');
}
async function exportRosterCSV(){
  const players = (await allPlayers()).map(ensurePlayerShape)
    .sort((a,b)=> (a.team===b.team?0:(a.team==='home'?-1:1)) || (a.number-b.number));
  const head = ['team','number','nameZh','nameEn','pos','height','weight','dob','nationality','role','hand','regId','email','phone','avatarUrl'];
  const rows = [head];
  players.forEach(p=>{
    rows.push([p.team,p.number,p.nameZh||'',p.nameEn||'',p.pos||'',p.height||'',p.weight||'',p.dob||'',p.nationality||'',p.role||'',p.hand||'',p.regId||'',p.email||'',p.phone||'',p.avatar||'']);
  });
  const csv = rosterToCSV(rows);
  const bom = '\ufeff';
  const blob = new Blob([bom, csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'roster.csv'; a.click(); URL.revokeObjectURL(a.href);
}
async function clearRoster(){
  if(!confirm('確定清空名單？（不影響比賽分數/時計，但會刪除所有球員資料）')) return;
  const players = await allPlayers();
  for(const p of players){ await del('players', p.id); }
  renderRoster(); renderPlayers();
}

/* ===== Player Admin: Bulk Import (modal) ===== */
function openBulk(){ $('#bulkModal').style.display='flex'; }
function closeBulk(){ $('#bulkModal').style.display='none'; $('#bulkPaste').value=''; $('#bulkFile').value=''; $('#bulkHeadRow').innerHTML=''; $('#bulkBody').innerHTML=''; _bulkParsed=null; }
let _bulkParsed = null;

function parseCSV(text){
  // robust-ish CSV parser (handles quotes)
  const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(l=>l.trim().length>0);
  const rows = [];
  for(const line of lines){
    const out=[]; let i=0, cur='', inQ=false;
    while(i<line.length){
      const ch=line[i];
      if(inQ){
        if(ch==='"'){
          if(i+1<line.length && line[i+1]==='"'){ cur+='"'; i+=2; }
          else{ inQ=false; i++; }
        }else{ cur+=ch; i++; }
      }else{
        if(ch===','){ out.push(cur); cur=''; i++; }
        else if(ch==='"'){ inQ=true; i++; }
        else{ cur+=ch; i++; }
      }
    }
    out.push(cur);
    rows.push(out);
  }
  return rows;
}
function previewBulk(rows){
  const head = rows[0] || [];
  const body = rows.slice(1);
  const headRow = $('#bulkHeadRow'); const tbody = $('#bulkBody');
  headRow.innerHTML=''; tbody.innerHTML='';
  head.forEach(h=>{ const th=document.createElement('th'); th.textContent=h; headRow.appendChild(th); });
  body.forEach(r=>{
    const tr=document.createElement('tr');
    r.forEach(c=>{ const td=document.createElement('td'); td.textContent=c; tr.appendChild(td); });
    tbody.appendChild(tr);
  });
}
function normalizeHeader(h){ return (h||'').trim().toLowerCase(); }
function rowToPlayerObj(head, row){
  const idx = (name)=> head.findIndex(h=> normalizeHeader(h)===normalizeHeader(name));
  const take = (name)=> { const i=idx(name); return i>=0 ? row[i] : ''; };
  const team = (take('team')||'home').toLowerCase()==='away'?'away':'home';
  const number = parseInt(take('number')||'0',10)||0;
  if(!number) return null;
  return ensurePlayerShape({
    id: idOf(team, number),
    team, number,
    nameZh: take('namezh') || take('name_zh') || take('name') || '',
    nameEn: take('nameen') || take('name_en') || '',
    pos: take('pos') || '',
    height: parseInt(take('height')||'0',10)||0,
    weight: parseInt(take('weight')||'0',10)||0,
    dob: take('dob') || '',
    nationality: take('nationality') || '',
    role: take('role') || 'bench',
    hand: (take('hand')||'R').toUpperCase()==='L'?'L':'R',
    arc: take('arc') || '',
    numberStyle: take('numberstyle') || '',
    regId: take('regid') || '',
    email: take('email') || '',
    phone: take('phone') || '',
    avatar: take('avatarurl') || ''
  });
}
async function confirmBulkWrite(){
  if(!_bulkParsed || !_bulkParsed.length){ alert('沒有可寫入的資料'); return; }
  const head = _bulkParsed[0]; const rows=_bulkParsed.slice(1);
  let count=0;
  for(const r of rows){
    const p = rowToPlayerObj(head, r);
    if(!p) continue;
    // merge existing in-game stats if existed
    const existed = await get('players', p.id);
    if(existed){
      p.PTS = existed.PTS|0; p.AST = existed.AST|0; p.REB = existed.REB|0; p.STL = existed.STL|0; p.BLK = existed.BLK|0; p.TOV = existed.TOV|0;
      p.PF = existed.PF|0; p.PFOFF = existed.PFOFF|0; p.PFT = existed.PFT|0; p.PFU = existed.PFU|0;
      p.oncourt = !!existed.oncourt; p.playMs = existed.playMs|0;
      p.alertedPF = !!existed.alertedPF; p.alertedT = !!existed.alertedT; p.alertedU = !!existed.alertedU;
    }
    await put('players', p);
    count++;
  }
  alert(`已寫入 ${count} 筆球員資料`);
  closeBulk(); renderRoster(); renderPlayers();
}

/* ========== Bindings ========== */
function bindEvents(){
  // Export
  $('#btnExport')?.addEventListener('click', saveAsTxt);
  $('#btnUpdate')?.addEventListener('click', updateTxt);
  $('#btnExportCSV')?.addEventListener('click', saveAsCSV);
  $('#btnExportJSON')?.addEventListener('click', saveAsJSON);

  // Reset ALL
  $('#btnReset')?.addEventListener('click', async ()=>{
    if(!confirm('確定要清空本場資料？（球員與分數/時計等將清空）')) return;
    db.close();
    await new Promise((res,rej)=>{ const delReq = indexedDB.deleteDatabase(DB_NAME); delReq.onsuccess=()=>res(); delReq.onerror=()=>rej(delReq.error); });
    await openDB(); location.reload();
  });

  // Score
  document.querySelectorAll('[data-add]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const [side,delta] = btn.dataset.add.split(':'); setScore(side, state[side].score + parseInt(delta,10));
    });
  });
  // Team fouls manual
  document.querySelectorAll('[data-tf]').forEach(btn=>{
    btn.addEventListener('click', ()=>{ const [side,delta] = btn.dataset.tf.split(':'); addTeamFoul(side, parseInt(delta,10)); });
  });
  $('#homeFoulsReset')?.addEventListener('click', ()=>{ state.home.teamFouls=0; renderTeamFouls('home'); });
  $('#awayFoulsReset')?.addEventListener('click', ()=>{ state.away.teamFouls=0; renderTeamFouls('away'); });

  // Period
  $('#periodInc')?.addEventListener('click', ()=>{ state.period=(state.period|0)+1; if(state.period>4){ state.game.totalMs=5*60*1000; } resetGameClock(); resetTeamFouls(); resetShot(24000,{autoRunIfLinked:true}); renderPeriod(); saveState(); });
  $('#periodDec')?.addEventListener('click', ()=>{ state.period=Math.max(1,(state.period|0)-1); if(state.period>4){ state.game.totalMs=5*60*1000; } resetGameClock(); resetTeamFouls(); resetShot(24000,{autoRunIfLinked:true}); renderPeriod(); saveState(); });

  // Title
  $('#gameTitle')?.addEventListener('input', e=>{ state.gameTitle = e.target.value; saveState(); });

  // Shot
  $('#shotStart')?.addEventListener('click', ()=> startShot());
  $('#shotPause')?.addEventListener('click', ()=> pauseShot());
  $('#shotReset24')?.addEventListener('click', ()=> resetShot(24000,{autoRunIfLinked:true}));
  $('#shotReset14')?.addEventListener('click', ()=> resetShot(14000,{autoRunIfLinked:true}));
  $('#shotMinus')?.addEventListener('click', ()=>{ state.shot.ms=Math.max(0,state.shot.ms-1000); updateShotUI(true); if(state.shot.running){ clearInterval(shotTimer); startShot();} });
  $('#shotPlus')?.addEventListener('click', ()=>{ state.shot.ms=Math.min(24000,state.shot.ms+1000); updateShotUI(true); if(state.shot.running){ clearInterval(shotTimer); startShot();} });
  $('#shotSwap')?.addEventListener('click', ()=>{ swapPossession(); if(state.game.linkShot && state.game.running) startShot(); });
  $('#shotViolation')?.addEventListener('click', ()=> shotViolationManual());
  $('#qaOffReb14')?.addEventListener('click', ()=> resetShot(14000,{autoRunIfLinked:true}));
  $('#qaChangePoss24')?.addEventListener('click', ()=>{ swapPossession(); resetShot(24000,{autoRunIfLinked:true}); });

  // Game
  $('#gameStart')?.addEventListener('click', ()=> startGame());
  $('#gamePause')?.addEventListener('click', ()=> pauseGame());
  $('#gameReset')?.addEventListener('click', ()=> resetGameClock());
  $('#set12')?.addEventListener('click', ()=> setGameLength(12));
  $('#set10')?.addEventListener('click', ()=> setGameLength(10));
  $('#set5')?.addEventListener('click',  ()=> setGameLength(5));
  $('#toggleLink')?.addEventListener('click', ()=>{ state.game.linkShot = !state.game.linkShot; updateGameUI(true); });

  // Rules + Referees
  const syncRulesFromUI = ()=>{
    state.rules.countCommon = $('#ruleCountCommon').checked;
    state.rules.countOffensive = $('#ruleCountOffensive').checked;
    state.rules.countTechnical = $('#ruleCountTechnical').checked;
    state.rules.countUnsportsmanlike = $('#ruleCountUnsportsmanlike').checked;
    state.rules.limitPF = Math.max(1,parseInt($('#limitPF').value||'5',10));
    state.rules.limitT  = Math.max(1,parseInt($('#limitT').value||'2',10));
    state.rules.limitU  = Math.max(1,parseInt($('#limitU').value||'2',10));
    state.referees.crew = $('#refCrew')?.value?.trim()||'';
    state.referees.u1   = $('#refU1')?.value?.trim()||'';
    state.referees.u2   = $('#refU2')?.value?.trim()||'';
    saveState(); renderPlayers();
  };
  ['ruleCountCommon','ruleCountOffensive','ruleCountTechnical','ruleCountUnsportsmanlike','limitPF','limitT','limitU','refCrew','refU1','refU2'].forEach(id=>{
    document.getElementById(id)?.addEventListener('change', syncRulesFromUI);
    document.getElementById(id)?.addEventListener('input', syncRulesFromUI);
  });
  $('#presetFIBA')?.addEventListener('click', ()=>{
    $('#ruleCountCommon').checked = true;
    $('#ruleCountOffensive').checked = false;
    $('#ruleCountTechnical').checked = false;
    $('#ruleCountUnsportsmanlike').checked = true;
    $('#limitPF').value = 5; $('#limitT').value = 2; $('#limitU').value = 2; 
    syncRulesFromUI();
  });
  $('#presetNBA')?.addEventListener('click', ()=>{
    $('#ruleCountCommon').checked = true;
    $('#ruleCountOffensive').checked = false;
    $('#ruleCountTechnical').checked = false;
    $('#ruleCountUnsportsmanlike').checked = true;
    $('#limitPF').value = 6; $('#limitT').value = 2; $('#limitU').value = 2;
    syncRulesFromUI();
  });

  // Event panel & Free throw
  bindEventPanel();
  bindFT();

  /* Player Admin binds */
  $('#btnSavePlayer')?.addEventListener('click', savePlayerFromForm);
  $('#btnResetForm')?.addEventListener('click', clearPlayerForm);

  // Avatar preview from file
  fm.avatarFile()?.addEventListener('change', async ()=>{
    const f = fm.avatarFile().files?.[0];
    if(!f){ fm.avatarPreview().src=''; return; }
    try{ fm.avatarPreview().src = await readFileAsDataURL(f); }catch(e){ console.warn(e); }
  });
  // Avatar preview from URL
  fm.avatarUrl()?.addEventListener('input', ()=>{
    const u = fm.avatarUrl().value.trim();
    fm.avatarPreview().src = u || '';
  });

  // Roster filters
  $('#filterTeam')?.addEventListener('change', renderRoster);
  $('#filterKeyword')?.addEventListener('input', renderRoster);

  // Bulk modal
  $('#btnBulkImport')?.addEventListener('click', openBulk);
  $('#bulkClose')?.addEventListener('click', closeBulk);
  $('#bulkFile')?.addEventListener('change', async ()=>{
    const f = $('#bulkFile').files?.[0]; if(!f) return;
    const text = await f.text(); const rows = parseCSV(text); _bulkParsed = rows; previewBulk(rows);
  });
  $('#bulkParse')?.addEventListener('click', ()=>{
    const txt = $('#bulkPaste').value.trim(); if(!txt){ alert('請貼上 CSV 內容或選擇檔案'); return; }
    const rows = parseCSV(txt); _bulkParsed = rows; previewBulk(rows);
  });
  $('#bulkConfirm')?.addEventListener('click', confirmBulkWrite);

  // Roster export & clear
  $('#btnBulkExport')?.addEventListener('click', exportRosterCSV);
  $('#btnClearRoster')?.addEventListener('click', clearRoster);

  // Players quick add (Players view)
  $('#addPlayer')?.addEventListener('click', async ()=>{
    const num = parseInt($('#pNum').value||'0',10)||0;
    const name = ($('#pName').value||'').trim();
    const team = $('#pTeam').value || 'home';
    const pos = ($('#pPos').value||'').trim();
    if(!num){ alert('請輸入背號'); return; }
    const rec = ensurePlayerShape({ id:idOf(team,num), team, number:num, nameZh:name, pos });
    const existed = await get('players', rec.id);
    if(existed){
      // keep stats
      rec.PTS=existed.PTS|0; rec.AST=existed.AST|0; rec.REB=existed.REB|0; rec.STL=existed.STL|0; rec.BLK=existed.BLK|0; rec.TOV=existed.TOV|0;
      rec.PF=existed.PF|0; rec.PFOFF=existed.PFOFF|0; rec.PFT=existed.PFT|0; rec.PFU=existed.PFU|0;
      rec.oncourt=!!existed.oncourt; rec.playMs=existed.playMs|0;
      rec.alertedPF=!!existed.alertedPF; rec.alertedT=!!existed.alertedT; rec.alertedU=!!existed.alertedU;
      // keep extended profile if name was empty from quick add
      rec.nameEn=existed.nameEn||''; rec.height=existed.height||0; rec.weight=existed.weight||0; rec.dob=existed.dob||''; rec.nationality=existed.nationality||'';
      rec.role=existed.role||'bench'; rec.hand=existed.hand||'R'; rec.arc=existed.arc||''; rec.numberStyle=existed.numberStyle||'';
      rec.regId=existed.regId||''; rec.email=existed.email||''; rec.phone=existed.phone||''; rec.avatar=existed.avatar||'';
    }
    await put('players', rec);
    renderPlayers(); renderRoster();
    // clear quick inputs
    $('#pNum').value=''; $('#pName').value=''; $('#pPos').value='';
  });
}

/* ========== Boot ========== */
(async function init(){
  await openDB();
  await loadState();
  await renderPlayers();
  await renderRoster();
  bindEvents();
})();

/* =========================================================
   Dashboard Controller (binds to existing app.js state/DB)
   ========================================================= */
(()=>{
  // === 小工具，沿用你現有的輔助 ===
  const $ = (sel)=>document.querySelector(sel);
  const sideLabel = (t)=> t==='home'?'主隊':'客隊';
  const periodLabel = (n)=> n<=4 ? `第${n}節` : `OT${n-4}`;
  const fmtMin = (ms)=>{ const s=Math.floor(Math.max(0,ms)/1000); const m=Math.floor(s/60); const sec=s%60; return `${m}:${String(sec).padStart(2,'0')}`; };
  const fmtGame = (ms)=>{
    const t = Math.max(0, ms|0), s = Math.floor(t/1000), m = Math.floor(s/60), sec = s%60;
    if(s>=60) return `${String(m)}:${String(sec).padStart(2,'0')}`;
    const hundred = Math.floor((t%1000)/10);
    return `${String(m)}:${String(sec)}.${String(hundred).padStart(2,'0')}`;
  };
  const fmtShot = (ms)=>{ const s=Math.max(0,ms)/1000; return s>8?String(Math.ceil(s|0)):s.toFixed(2); };

  // 需要用到你在 app.js 的函式 / 變數：
  // - state
  // - allPlayers(), get(), put()
  // - ensurePlayerShape(p), needsFlag(p), fillPlayerForm(p)（若沒有就會跳過）

  // === 嘗試從「比賽名稱」推測 Home / Away 名稱（可選） ===
  function parseTeamNamesFromTitle(title){
    if(!title) return {home:'HOME', away:'AWAY'};
    // 常見分隔：vs、VS、Vs、v.s.、對、：
    const t = title.replace('：',':');
    let home='HOME', away='AWAY';
    const byVs = t.split(/vs|VS|Vs|v\.s\./i);
    if(byVs.length===2){
      // 可能是「聯賽A：主隊 vs 客隊」→ 左邊還有聯賽名，再以冒號切
      const leftParts = byVs[0].split(':');
      home = (leftParts[leftParts.length-1]||'HOME').trim() || 'HOME';
      away = (byVs[1]||'AWAY').trim() || 'AWAY';
      return {home, away};
    }
    // 「主隊 對 客隊」
    const byChinese = t.split('對');
    if(byChinese.length===2){
      const leftParts = byChinese[0].split(':');
      home = (leftParts[leftParts.length-1]||'HOME').trim() || 'HOME';
      away = (byChinese[1]||'AWAY').trim() || 'AWAY';
      return {home, away};
    }
    return {home:'HOME', away:'AWAY'};
  }

  // === 卡片渲染 ===
  const tpl = ()=> $('#dashPlayerCardTpl');
  function createCardFor(p){
    const node = tpl().content.firstElementChild.cloneNode(true);
    const over = (p.PF|0) >= (state?.rules?.limitPF|0 || 5);
    if(over) node.classList.add('foul-max');

    node.querySelector('.player-avatar').src = p.avatar || '';
    node.querySelector('.player-num').textContent = `#${p.number||0}`;
    node.querySelector('.player-name').textContent = p.nameZh || p.nameEn || `球員 ${p.number||''}`;
    node.querySelector('.player-meta').textContent = `上場：${fmtMin(p.playMs|0)}｜犯規：${p.PF|0}`;

    const stats = {
      PTS: p.PTS|0, REB: p.REB|0, AST: p.AST|0
    };
    const vals = node.querySelectorAll('.player-stats .value');
    vals[0].textContent = stats.PTS;
    vals[1].textContent = stats.REB;
    vals[2].textContent = stats.AST;

    // 點卡片 → 跳到管理（可改成 noop）
    node.addEventListener('click', async ()=>{
      try{
        if(typeof fillPlayerForm === 'function'){ fillPlayerForm(p); }
        if(typeof setView === 'function'){ setView('playerAdminView'); }
      }catch(e){}
    });

    // 在元素上留 id，方便輕量更新
    node.dataset.pid = p.id;
    return node;
  }

  function placeholderCard(){
    const node = tpl().content.firstElementChild.cloneNode(true);
    node.querySelector('.player-avatar').src = '';
    node.querySelector('.player-num').textContent = '#--';
    node.querySelector('.player-name').textContent = '空位';
    node.querySelector('.player-meta').textContent = '上場：0:00｜犯規：0';
    const vals = node.querySelectorAll('.player-stats .value');
    vals.forEach(v=> v.textContent='0');
    node.style.opacity = .6;
    node.classList.remove('foul-max');
    node.dataset.pid = '';
    return node;
  }

  // === Dashboard 主控制 ===
  const Dashboard = {
    active: false,
    lightTimer: null,   // 0.5s 更新（鐘、卡片數字）
    heavyTimer: null,   // 2s 重新撈玩家 & 重渲染卡片（偵測上場名單/犯滿變化）
    cacheIds: { home:[], away:[] },

    async renderHeader(){
      if(!$('#dashboardView')) return;
      const {home, away} = parseTeamNamesFromTitle(state?.gameTitle||'');
      $('#dashGameTitle') && ($('#dashGameTitle').textContent = state?.gameTitle || '未命名比賽');
      $('#dashPeriod') && ($('#dashPeriod').textContent = periodLabel(state?.period||1));
      $('#dashHomeName') && ($('#dashHomeName').textContent = home);
      $('#dashAwayName') && ($('#dashAwayName').textContent = away);
      $('#dashHomeTeamName') && ($('#dashHomeTeamName').textContent = sideLabel('home') + '｜' + home);
      $('#dashAwayTeamName') && ($('#dashAwayTeamName').textContent = sideLabel('away') + '｜' + away);

      // 分數
      $('#dashHomeScore') && ($('#dashHomeScore').textContent = state?.home?.score|0);
      $('#dashAwayScore') && ($('#dashAwayScore').textContent = state?.away?.score|0);
    },

    renderClocks(){
      if(!$('#dashboardView')) return;
      // 比賽時計
      const gms = state?.game?.ms ?? 0;
      $('#dashGameClock') && ($('#dashGameClock').textContent = fmtGame(gms));
      $('#dashGameInfo') && ($('#dashGameInfo').textContent = `長度：${fmtGame(state?.game?.totalMs ?? 0)}`);

      // 進攻時計
      const sms = state?.shot?.ms ?? 0;
      const shotEl = $('#dashShotClock');
      if(shotEl){
        shotEl.textContent = fmtShot(sms);
        const s = sms/1000;
        shotEl.classList.toggle('shot-danger', s<=8);
      }
      $('#dashPoss') && ($('#dashPoss').textContent = `球權：${sideLabel(state?.shot?.poss || 'home')}`);
    },

    async renderFive(){
      const list = (await allPlayers()).map(p=> ensurePlayerShape(p));
      const homeOn = list.filter(p=> p.team==='home' && p.oncourt).sort((a,b)=> (a.number|0)-(b.number|0)).slice(0,5);
      const awayOn = list.filter(p=> p.team==='away' && p.oncourt).sort((a,b)=> (a.number|0)-(b.number|0)).slice(0,5);

      // 重繪（若上場名單與 cache 不同）
      const ids = { home:homeOn.map(p=>p.id), away:awayOn.map(p=>p.id) };
      const needRerender = JSON.stringify(ids)!==JSON.stringify(this.cacheIds);

      if(needRerender){
        const homeWrap = $('#dashHomeFive'); if(homeWrap){ homeWrap.innerHTML=''; }
        const awayWrap = $('#dashAwayFive'); if(awayWrap){ awayWrap.innerHTML=''; }

        // 主隊
        if($('#dashHomeFive')){
          homeOn.forEach(p=> $('#dashHomeFive').appendChild(createCardFor(p)));
          for(let i=homeOn.length;i<5;i++){ $('#dashHomeFive').appendChild(placeholderCard()); }
        }
        // 客隊
        if($('#dashAwayFive')){
          awayOn.forEach(p=> $('#dashAwayFive').appendChild(createCardFor(p)));
          for(let i=awayOn.length;i<5;i++){ $('#dashAwayFive').appendChild(placeholderCard()); }
        }
        this.cacheIds = ids;
      }

      // 輕量數字更新（PTS/REB/AST、PF、上場時間、犯滿樣式）
      const map = new Map(list.map(p=> [p.id, p]));
      const updWrap = (wrapSel)=>{
        const wrap = $(wrapSel); if(!wrap) return;
        Array.from(wrap.children).forEach(card=>{
          const pid = card.dataset.pid;
          if(!pid) return; // placeholder
          const p = map.get(pid); if(!p) return;
          // meta：上場時間｜犯規
          const meta = card.querySelector('.player-meta');
          if(meta) meta.textContent = `上場：${fmtMin(p.playMs|0)}｜犯規：${p.PF|0}`;
          // stats
          const vals = card.querySelectorAll('.player-stats .value');
          if(vals[0]) vals[0].textContent = p.PTS|0;
          if(vals[1]) vals[1].textContent = p.REB|0;
          if(vals[2]) vals[2].textContent = p.AST|0;
          // 犯滿樣式
          const over = (p.PF|0) >= (state?.rules?.limitPF|0 || 5);
          card.classList.toggle('foul-max', over);
        });
      };
      updWrap('#dashHomeFive');
      updWrap('#dashAwayFive');

      // 分數與節次也順手同步
      $('#dashHomeScore') && ($('#dashHomeScore').textContent = state?.home?.score|0);
      $('#dashAwayScore') && ($('#dashAwayScore').textContent = state?.away?.score|0);
      $('#dashPeriod') && ($('#dashPeriod').textContent = periodLabel(state?.period||1));
    },

    async activate(){
      if(this.active) return;
      this.active = true;
      await this.renderHeader();
      this.renderClocks();
      await this.renderFive();

      // 輕量更新（鐘＆卡片數字）
      this.lightTimer = setInterval(()=>{
        if(!this.active) return;
        try{
          this.renderClocks();
        }catch(e){}
      }, 500);

      // 重撈資料（偵測名單/數值大變動）
      this.heavyTimer = setInterval(async ()=>{
        if(!this.active) return;
        try{
          await this.renderHeader();
          await this.renderFive();
        }catch(e){}
      }, 2000);
    },

    deactivate(){
      this.active = false;
      if(this.lightTimer){ clearInterval(this.lightTimer); this.lightTimer=null; }
      if(this.heavyTimer){ clearInterval(this.heavyTimer); this.heavyTimer=null; }
    }
  };

  // === 與既有 setView 整合：覆寫為包裝器 ===
  if(typeof setView === 'function'){
    const __setView = setView;
    window.setView = function(viewId){
      __setView(viewId);
      if(viewId==='dashboardView'){ Dashboard.activate(); } else { Dashboard.deactivate(); }
    };
  }else{
    // 若此段載入時 setView 尚未定義，保險起見也監聽 tab 點擊
    document.addEventListener('click', (e)=>{
      const btn = e.target.closest('.tab');
      if(!btn) return;
      const v = btn.dataset.view;
      if(v==='dashboardView'){ Dashboard.activate(); } else { Dashboard.deactivate(); }
    });
  }

  // 如果一開啟就落在 Dashboard，也要啟動
  if(document.querySelector('.view#dashboardView')?.classList.contains('active')){
    Dashboard.activate();
  }

  // 暴露到全域，萬一你之後想手動 refresh
  window.__Dashboard = Dashboard;
})();

/* ===== Dashboard 操作綁定（與現有邏輯共用） ===== */
(function bindDashboardOps(){
  const $ = (s)=>document.querySelector(s);
  const BONUS_LIMIT = 5;

  // —— 計分 —— //
  $('#dashHomeAdd1')?.addEventListener('click', ()=> setScore('home', state.home.score+1));
  $('#dashHomeAdd2')?.addEventListener('click', ()=> setScore('home', state.home.score+2));
  $('#dashHomeAdd3')?.addEventListener('click', ()=> setScore('home', state.home.score+3));
  $('#dashHomeSub1')?.addEventListener('click', ()=> setScore('home', state.home.score-1));

  $('#dashAwayAdd1')?.addEventListener('click', ()=> setScore('away', state.away.score+1));
  $('#dashAwayAdd2')?.addEventListener('click', ()=> setScore('away', state.away.score+2));
  $('#dashAwayAdd3')?.addEventListener('click', ()=> setScore('away', state.away.score+3));
  $('#dashAwaySub1')?.addEventListener('click', ()=> setScore('away', state.away.score-1));

  // —— 團隊犯規（同步 Bonus 顯示） —— //
  function syncDashTeamFouls(){
    const set = (side)=>{
      const n = state[side].teamFouls|0;
      const tf = side==='home' ? $('#dashHomeTF') : $('#dashAwayTF');
      const b  = side==='home' ? $('#dashHomeBonus') : $('#dashAwayBonus');
      if(tf) tf.textContent = n;
      if(b)  b.style.display = n>=BONUS_LIMIT ? 'inline-flex':'none';
    };
    set('home'); set('away');
  }
  $('#dashHomeTFPlus')?.addEventListener('click', ()=>{ addTeamFoul('home', +1); syncDashTeamFouls(); });
  $('#dashHomeTFMinus')?.addEventListener('click', ()=>{ addTeamFoul('home', -1); syncDashTeamFouls(); });
  $('#dashHomeTFReset')?.addEventListener('click', ()=>{ state.home.teamFouls=0; syncDashTeamFouls(); saveState(); });

  $('#dashAwayTFPlus')?.addEventListener('click', ()=>{ addTeamFoul('away', +1); syncDashTeamFouls(); });
  $('#dashAwayTFMinus')?.addEventListener('click', ()=>{ addTeamFoul('away', -1); syncDashTeamFouls(); });
  $('#dashAwayTFReset')?.addEventListener('click', ()=>{ state.away.teamFouls=0; syncDashTeamFouls(); saveState(); });

  // 初始同步一次
  syncDashTeamFouls();

  // —— 節次 —— //
  function renderDashPeriod(){ $('#dashPeriod') && ($('#dashPeriod').textContent = (state.period<=4?`第${state.period}節`:`OT${state.period-4}`)); }
  $('#dashPeriodInc')?.addEventListener('click', ()=>{ state.period=(state.period|0)+1; if(state.period>4){ state.game.totalMs=5*60*1000; } resetGameClock(); resetTeamFouls(); resetShot(24000,{autoRunIfLinked:true}); renderDashPeriod(); saveState(); });
  $('#dashPeriodDec')?.addEventListener('click', ()=>{ state.period=Math.max(1,(state.period|0)-1); if(state.period>4){ state.game.totalMs=5*60*1000; } resetGameClock(); resetTeamFouls(); resetShot(24000,{autoRunIfLinked:true}); renderDashPeriod(); saveState(); });
  renderDashPeriod();

  // —— Game Clock —— //
  $('#dashGameStart')?.addEventListener('click', ()=> startGame());
  $('#dashGamePause')?.addEventListener('click', ()=> pauseGame());
  $('#dashGameReset')?.addEventListener('click', ()=> resetGameClock());
  $('#dashSet12')?.addEventListener('click', ()=> setGameLength(12));
  $('#dashSet10')?.addEventListener('click', ()=> setGameLength(10));
  $('#dashSet5')?.addEventListener('click',  ()=> setGameLength(5));

  // —— Shot Clock —— //
  $('#dashShotStart')?.addEventListener('click', ()=> startShot());
  $('#dashShotPause')?.addEventListener('click', ()=> pauseShot());
  $('#dashShot24')?.addEventListener('click', ()=> resetShot(24000,{autoRunIfLinked:true}));
  $('#dashShot14')?.addEventListener('click', ()=> resetShot(14000,{autoRunIfLinked:true}));
  $('#dashSwap')?.addEventListener('click', ()=>{ state.shot.poss = (state.shot.poss==='home'?'away':'home'); saveState(); });
  $('#dashShotViolation')?.addEventListener('click', ()=> shotViolationManual());

  // —— 分數/團犯/節次 由 app.js 狀態變更時也能反映 —— //
  const _origSetScore = window.setScore;
  if(typeof _origSetScore === 'function'){
    window.setScore = function(side, val){
      _origSetScore(side, val);
      if(side==='home'){ $('#dashHomeScore') && ($('#dashHomeScore').textContent = state.home.score); }
      else{ $('#dashAwayScore') && ($('#dashAwayScore').textContent = state.away.score); }
    };
  }
  const _origRenderTeamFouls = window.renderTeamFouls;
  if(typeof _origRenderTeamFouls === 'function'){
    window.renderTeamFouls = function(side){
      _origRenderTeamFouls(side);
      // 再同步 Dashboard 的團犯與 Bonus
      const n = state[side].teamFouls|0;
      const tf = side==='home' ? $('#dashHomeTF') : $('#dashAwayTF');
      const b  = side==='home' ? $('#dashHomeBonus') : $('#dashAwayBonus');
      if(tf) tf.textContent = n;
      if(b)  b.style.display = n>=BONUS_LIMIT ? 'inline-flex':'none';
    };
  }
})();