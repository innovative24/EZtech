// ====== 常數 ======
const DB_NAME = 'basket-scoreboard';
const DB_VER  = 8; // 新：上場時間、罰球引導器、CSV/JSON 匯出
const BONUS_LIMIT = 5;

// ====== IndexedDB ======
let db;
function openDB(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e)=>{
      const db = e.target.result;
      if(!db.objectStoreNames.contains('players')){
        const s = db.createObjectStore('players',{ keyPath:'id' });
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

// ====== 狀態 ======
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
  // 裁判
  referees:{ crew:'', u1:'', u2:'' },
  // 時計
  shot:{ ms:24000, running:false, lastTs:null, poss:'home' },
  game:{ ms:12*60*1000, totalMs:12*60*1000, running:false, lastTs:null, linkShot:false },
  // UI
  ui:{ view:'scoreView' }
};

// 工具
const deepCopy = (o)=>JSON.parse(JSON.stringify(o));
async function saveState(){ await put('game',{k:'state', v:deepCopy(state)}); }
const $ = (sel)=>document.querySelector(sel);
const idOf = (team,num)=>`${team}#${num}`;
const sideLabel = (t)=> t==='home'?'主隊':'客隊';
const periodLabel = (n)=> n<=4 ? `第${n}節` : `OT${n-4}`;
const fmtMin = (ms)=>{ const s=Math.floor(Math.max(0,ms)/1000); const m=Math.floor(s/60); const sec=s%60; return `${m}:${String(sec).padStart(2,'0')}`; };

// ====== 初始化 ======
async function loadState(){
  const saved = await get('game','state');
  if(saved){ Object.assign(state,saved.v||saved); }
  $('#gameTitle') && ($('#gameTitle').value = state.gameTitle || '');
  setScore('home', state.home.score);
  setScore('away', state.away.score);
  renderTeamFouls('home'); renderTeamFouls('away');
  renderPeriod();
  updateShotUI(true); updateGameUI(true);

  // 規則 UI
  $('#ruleCountCommon').checked = !!state.rules.countCommon;
  $('#ruleCountOffensive').checked = !!state.rules.countOffensive;
  $('#ruleCountTechnical').checked = !!state.rules.countTechnical;
  $('#ruleCountUnsportsmanlike').checked = !!state.rules.countUnsportsmanlike;
  $('#limitPF').value = state.rules.limitPF;
  $('#limitT').value  = state.rules.limitT;
  $('#limitU').value  = state.rules.limitU;

  // 裁判 UI
  const R = state.referees || {};
  $('#refCrew') && ($('#refCrew').value = R.crew || '');
  $('#refU1') && ($('#refU1').value = R.u1 || '');
  $('#refU2') && ($('#refU2').value = R.u2 || '');

  setView(state.ui.view || 'scoreView');
  if(state.shot.running) startShot(true);
  if(state.game.running) startGame(true);
}

// ====== 節次 / 比分 ======
function renderPeriod(){ const el=$('#period'); if(el) el.textContent = periodLabel(state.period); }
function setScore(side, val){
  state[side].score = Math.max(0, val|0);
  const el = $('#'+side+'Score'); if(el) el.textContent = state[side].score;
  saveState();
}

// ====== 團隊犯規 ======
function renderTeamFouls(side){
  const n = Math.max(0, state[side].teamFouls|0);
  const foulEl = $('#'+side+'Fouls'); foulEl && (foulEl.textContent = n);
  const bonusEl = $('#'+side+'Bonus'); bonusEl && (bonusEl.style.display = n>=BONUS_LIMIT?'inline-flex':'none');
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

// ====== 球員（含上場時間） ======
function ensurePlayerShape(p){
  p.PTS|=0; p.AST|=0; p.REB|=0; p.STL|=0; p.BLK|=0; p.TOV|=0;
  p.PF|=0; p.PFOFF|=0; p.PFT|=0; p.PFU|=0;
  p.oncourt = !!p.oncourt;      // 是否在場
  p.playMs = p.playMs|0;        // 累計上場毫秒
  // 提醒旗標
  if(p.alertedPF===undefined) p.alertedPF=false;
  if(p.alertedT===undefined)  p.alertedT=false;
  if(p.alertedU===undefined)  p.alertedU=false;
  return p;
}
function needsFlag(p){
  const overPF = (p.PF|0) >= (state.rules.limitPF|0);
  const overT  = (p.PFT|0) >= (state.rules.limitT|0);
  const overU  = (p.PFU|0) >= (state.rules.limitU|0);
  return { overPF, overT, overU };
}
function trForPlayer(p0){
  const p = ensurePlayerShape(p0);
  const tr = document.createElement('tr'); tr.dataset.id=p.id;
  const {overPF,overT,overU} = needsFlag(p);
  if(overT || overU) tr.classList.add('tr-eject');
  else if(overPF) tr.classList.add('tr-flag');

  const cells = [
    ['team', p.team==='home'?'主隊':'客隊', false],
    ['number', p.number, true],
    ['name', p.name||'', true],
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
      });
    }
    tr.appendChild(td);
  }

  // 上場 & MIN
  const tdOn = document.createElement('td');
  const chk = document.createElement('input'); chk.type='checkbox'; chk.checked = !!p.oncourt;
  chk.addEventListener('change', async ()=>{
    const rec = await get('players', p.id); if(!rec) return;
    rec.oncourt = chk.checked; await put('players', ensurePlayerShape(rec));
  });
  tdOn.appendChild(chk); tr.appendChild(tdOn);

  const tdMin = document.createElement('td'); tdMin.className='mono'; tdMin.textContent = fmtMin(p.playMs); tr.appendChild(tdMin);

  // 操作
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
  box.appendChild(mkBtn('刪除',null, async ()=>{ await del('players', p.id); renderPlayers(); }));
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

// 上限提醒
async function maybeAlertLimits(rec){
  const {overPF,overT,overU} = needsFlag(rec);
  let changed=false, msgs=[];
  if(overPF && !rec.alertedPF){ rec.alertedPF=true; changed=true; msgs.push(`【提醒】${sideLabel(rec.team)} #${rec.number} 個人犯滿（≥${state.rules.limitPF}）。`); }
  if(overT && !rec.alertedT){ rec.alertedT=true; changed=true; msgs.push(`【退場條件】${sideLabel(rec.team)} #${rec.number} 技術犯規達上限（${state.rules.limitT}）。`); }
  if(overU && !rec.alertedU){ rec.alertedU=true; changed=true; msgs.push(`【退場條件】${sideLabel(rec.team)} #${rec.number} 違體犯規達上限（${state.rules.limitU}）。`); }
  if(changed){ await put('players', rec); alert(msgs.join('\n')); }
}

// 更新個人犯規 + 團犯 + 上限提醒
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

// ====== Tabs ======
function setView(viewId){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById(viewId)?.classList.add('active');
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.view===viewId));
  state.ui.view = viewId; saveState();
}
document.querySelectorAll('.tab').forEach(btn=> btn.addEventListener('click', ()=> setView(btn.dataset.view)));

// ====== Shot Clock（>8s：整秒；≤8s：兩位小數） ======
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

// ====== Game Clock（含上場時間累計） ======
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
  if(changed) renderPlayers();
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
    // 累計上場時間
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

// ====== 註記 & 事件 ======
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

// ====== 罰球引導器 ======
const ft = { team:'home', attempts:2, results:[] }; // results: true=中, false=失手
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

// ====== 事件面板（串起犯規 + 罰球引導器） ======
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

// ====== 匯出（TXT/CSV/JSON） ======
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
      const row=[p.team,p.number,p.name,p.pos,p.PTS|0,(p.PF|0),(p.PFOFF|0),(p.PFT|0),(p.PFU|0),p.AST|0,p.REB|0,p.STL|0,p.BLK|0,p.TOV|0,p.oncourt?1:0,fmtMin(p.playMs)];
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
      rows.push([p.team,p.number,p.name,p.pos,p.PTS|0,(p.PF|0),(p.PFOFF|0),(p.PFT|0),(p.PFU|0),p.AST|0,p.REB|0,p.STL|0,p.BLK|0,p.TOV|0,p.oncourt?1:0,fmtMin(p.playMs)]);
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
      team:p.team, number:p.number, name:p.name, pos:p.pos,
      PTS:p.PTS|0, PF_total:p.PF|0, PF_off:p.PFOFF|0, PF_tech:p.PFT|0, PF_unspt:p.PFU|0,
      AST:p.AST|0, REB:p.REB|0, STL:p.STL|0, BLK:p.BLK|0, TOV:p.TOV|0,
      on:p.oncourt?1:0, playMs:p.playMs|0, playMin:fmtMin(p.playMs)
    })),
    notes: ($('#notes')?.value||'').trim()
  };
  return JSON.stringify(obj, null, 2);
}

// 檔案存取（TXT 可覆寫；CSV/JSON 直接下載）
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
  const bom = '\ufeff'; // 讓 Excel 正確辨識 UTF-8
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

// ====== 綁定事件 ======
function bindEvents(){
  // 匯出
  $('#btnExport')?.addEventListener('click', saveAsTxt);
  $('#btnUpdate')?.addEventListener('click', updateTxt);
  $('#btnExportCSV')?.addEventListener('click', saveAsCSV);
  $('#btnExportJSON')?.addEventListener('click', saveAsJSON);

  // 清空
  $('#btnReset')?.addEventListener('click', async ()=>{
    if(!confirm('確定要清空本場資料？（球員與分數等將清空）')) return;
    db.close();
    await new Promise((res,rej)=>{ const delReq = indexedDB.deleteDatabase(DB_NAME); delReq.onsuccess=()=>res(); delReq.onerror=()=>rej(delReq.error); });
    await openDB(); location.reload();
  });

  // 比分
  document.querySelectorAll('[data-add]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const [side,delta] = btn.dataset.add.split(':'); setScore(side, state[side].score + parseInt(delta,10));
    });
  });
  // 團隊犯規（手動）
  document.querySelectorAll('[data-tf]').forEach(btn=>{
    btn.addEventListener('click', ()=>{ const [side,delta] = btn.dataset.tf.split(':'); addTeamFoul(side, parseInt(delta,10)); });
  });
  $('#homeFoulsReset')?.addEventListener('click', ()=>{ state.home.teamFouls=0; renderTeamFouls('home'); });
  $('#awayFoulsReset')?.addEventListener('click', ()=>{ state.away.teamFouls=0; renderTeamFouls('away'); });

  // 節次
  $('#periodInc')?.addEventListener('click', ()=>{ state.period=(state.period|0)+1; if(state.period>4){ state.game.totalMs=5*60*1000; } resetGameClock(); resetTeamFouls(); resetShot(24000,{autoRunIfLinked:true}); renderPeriod(); saveState(); });
  $('#periodDec')?.addEventListener('click', ()=>{ state.period=Math.max(1,(state.period|0)-1); if(state.period>4){ state.game.totalMs=5*60*1000; } resetGameClock(); resetTeamFouls(); resetShot(24000,{autoRunIfLinked:true}); renderPeriod(); saveState(); });

  // 標題
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

  // 規則設定
  const syncRulesFromUI = ()=>{
    state.rules.countCommon = $('#ruleCountCommon').checked;
    state.rules.countOffensive = $('#ruleCountOffensive').checked;
    state.rules.countTechnical = $('#ruleCountTechnical').checked;
    state.rules.countUnsportsmanlike = $('#ruleCountUnsportsmanlike').checked;
    state.rules.limitPF = Math.max(1,parseInt($('#limitPF').value||'5',10));
    state.rules.limitT  = Math.max(1,parseInt($('#limitT').value||'2',10));
    state.rules.limitU  = Math.max(1,parseInt($('#limitU').value||'2',10));
    // 裁判
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

  // 事件面板 & 罰球引導器
  bindEventPanel();
  bindFT();
}

// ====== 啟動 ======
(async function init(){
  await openDB();
  await loadState();
  await renderPlayers();
  bindEvents();
})();