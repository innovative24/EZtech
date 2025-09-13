// ====== 常數 ======
const DB_NAME = 'basket-scoreboard';
const DB_VER  = 7; // 新：事件面板 + 上限提醒/退場
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
const allPlayers = ()=>new Promise((res,rej)=>{ const r = tx('players').getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error); });

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
    limitPF:5,  // 個人犯規上限
    limitT:2,   // 技犯上限
    limitU:2    // 違體上限
  },
  shot:{ ms:24000, running:false, lastTs:null, poss:'home' },
  game:{ ms:12*60*1000, totalMs:12*60*1000, running:false, lastTs:null, linkShot:false },
    // NEW: 本場裁判
  referees: {
    crew: '',   // 裁判長
    u1: '',     // 第一副審
    u2: ''      // 第二副審
  },
  ui:{ view:'scoreView' }
};

// 工具
const deepCopy = (o)=>JSON.parse(JSON.stringify(o));
async function saveState(){ await put('game',{k:'state', v:deepCopy(state)}); }
const $ = (sel)=>document.querySelector(sel);
const idOf = (team,num)=>`${team}#${num}`;
const periodLabel = (n)=> n<=4 ? `第${n}節` : `OT${n-4}`;

// ====== 初始化 ======
async function loadState(){
  const saved = await get('game','state');
  if(saved){ Object.assign(state,saved.v); }
  const titleEl = $('#gameTitle'); if(titleEl) titleEl.value = state.gameTitle || '';
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

  setView(state.ui.view || 'scoreView');
  if(state.shot.running) startShot(true);
  if(state.game.running) startGame(true);
 
     // NEW: 裁判 UI 初始化
  const r = state.referees || {};
  const refCrew = document.getElementById('refCrew');
  const refU1 = document.getElementById('refU1');
  const refU2 = document.getElementById('refU2');
  if(refCrew) refCrew.value = r.crew || '';
  if(refU1)   refU1.value   = r.u1   || '';
  if(refU2)   refU2.value   = r.u2   || '';
  
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

// ====== 球員表格（含犯規細分 + 警示） ======
function ensurePlayerShape(p){
  p.PTS|=0; p.AST|=0; p.REB|=0; p.STL|=0; p.BLK|=0; p.TOV|=0;
  p.PF|=0; p.PFOFF|=0; p.PFT|=0; p.PFU|=0;
  // 提醒旗標（同場僅提醒一次）
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

  // 樣式：達上限標紅；T/U 上限視為退場加重底色
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
        const storeVal = await get('players', p.id);
        if(!storeVal) return;
        if(k==='number'){
          const newNum = parseInt(td.textContent||'0',10)||0;
          if(newNum!==storeVal.number){
            await del('players', storeVal.id);
            storeVal.number = newNum;
            storeVal.id = idOf(storeVal.team, newNum);
          }
        }else{
          storeVal[k] = td.textContent.trim();
        }
        await put('players', ensurePlayerShape(storeVal));
        renderPlayers();
      });
    }
    tr.appendChild(td);
  }

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
  const tbody = document.querySelector('#playersTbl tbody');
  if(!tbody) return;
  tbody.innerHTML='';
  players.sort((a,b)=> (a.team===b.team?0:(a.team==='home'?-1:1)) || (a.number-b.number));
  for(const p of players){ tbody.appendChild(trForPlayer(p)); }
}

// 上限提醒（彈窗一次）
async function maybeAlertLimits(rec){
  const {overPF,overT,overU} = needsFlag(rec);
  let changed=false, msgs=[];
  if(overPF && !rec.alertedPF){ rec.alertedPF=true; changed=true; msgs.push(`【提醒】${sideLabel(rec.team)} #${rec.number} 個人犯滿（≥${state.rules.limitPF}）。`); }
  if(overT && !rec.alertedT){ rec.alertedT=true; changed=true; msgs.push(`【退場條件】${sideLabel(rec.team)} #${rec.number} 技術犯規達上限（${state.rules.limitT}）。`); }
  if(overU && !rec.alertedU){ rec.alertedU=true; changed=true; msgs.push(`【退場條件】${sideLabel(rec.team)} #${rec.number} 違體犯規達上限（${state.rules.limitU}）。`); }
  if(changed){ await put('players', rec); alert(msgs.join('\n')); }
}
const sideLabel = (t)=> t==='home'?'主隊':'客隊';

// 更新個人犯規（含團隊犯規規則判斷 + 上限提醒）
async function updatePersonalFoul(playerId, type, delta){
  const rec = await get('players', playerId);
  if(!rec) return;
  ensurePlayerShape(rec);

  // 分項
  if(type==='common'){ rec.PF = Math.max(0,(rec.PF|0)+delta); }
  else if(type==='offensive'){ rec.PFOFF = Math.max(0,(rec.PFOFF|0)+delta); }
  else if(type==='technical'){ rec.PFT = Math.max(0,(rec.PFT|0)+delta); }
  else if(type==='unsportsmanlike'){ rec.PFU = Math.max(0,(rec.PFU|0)+delta); }

  // 個人總 PF = 分項合計
  rec.PF = Math.max(0,(rec.PFOFF|0)+(rec.PFT|0)+(rec.PFU|0)+(rec.PF|0));

  // 團隊犯規是否變動
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
  const view = document.getElementById(viewId); if(view) view.classList.add('active');
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.view===viewId));
  state.ui.view = viewId; saveState();
}
document.querySelectorAll('.tab').forEach(btn=>{
  btn.addEventListener('click', ()=> setView(btn.dataset.view));
});

// ====== Shot Clock（>8s：整秒；≤8s：兩位小數） ======
let shotTimer = null, lastShownWhole = null;
function fmtShot(ms){ const s=Math.max(0,ms)/1000; return s>8?String(Math.ceil(s|0)):s.toFixed(2); }
function updateShotUI(force=false){
  const d = document.getElementById('shotDisplay');
  const pos = document.getElementById('shotPos');
  if(!d || !pos) return;
  const s = state.shot.ms/1000;
  d.classList.toggle('shot-danger', s<=8);
  if(s>8 && !force){
    const whole = Math.ceil(s);
    if(whole===lastShownWhole){ pos.textContent=`球權：${state.shot.poss==='home'?'主隊':'客隊'}${state.shot.running?'（計時中）':''}`; return; }
    lastShownWhole = whole;
  }
  d.textContent = fmtShot(state.shot.ms);
  pos.textContent = `球權：${state.shot.poss==='home'?'主隊':'客隊'}${state.shot.running?'（計時中）':''}`;
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
  state.shot.running = true;
  state.shot.lastTs = performance.now();
  const tick = ()=>{
    const now = performance.now();
    const elapsed = now - state.shot.lastTs;
    state.shot.lastTs = now;
    state.shot.ms -= elapsed;
    if(state.shot.ms <= 0){
      state.shot.ms = 0;
      updateShotUI(true);
      clearInterval(shotTimer); shotTimer=null;
      state.shot.running=false;
      buzzer();
      shotViolationAuto();
    }else{
      updateShotUI();
      const newInt = pickShotInterval();
      if(newInt !== shotTickInterval){ clearInterval(shotTimer); shotTickInterval=newInt; shotTimer=setInterval(tick, shotTickInterval); }
    }
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
  const notes = document.getElementById('notes');
  if(notes) notes.value += (notes.value?'\r\n':'') + `【${new Date().toLocaleTimeString()}】${team==='home'?'主隊':'客隊'} 24秒違例`;
  swapPossession(); resetShot(24000,{autoRunIfLinked:true}); await saveState();
}
async function shotViolationManual(){ pauseShot(); buzzer(); await shotViolationAuto(); }

// ====== Game Clock ======
let gameTimer = null, gameLastShownSec = null;
function fmtGame(ms){
  const t = Math.max(0, ms|0), s = Math.floor(t/1000), m = Math.floor(s/60), sec = s%60;
  if(s>=60) return `${String(m).padStart(1,'0')}:${String(sec).padStart(2,'0')}`;
  const hundred = Math.floor((t%1000)/10);
  return `${String(m).padStart(1,'0')}:${String(sec).padStart(2,'0')}.${String(hundred).padStart(2,'0')}`;
}
function updateGameUI(force=false){
  const d=$('#gameDisplay'), info=$('#gameInfo'); if(!d||!info) return;
  const s = Math.floor(state.game.ms/1000);
  d.classList.toggle('game-danger', s<60);
  if(s>=60 && !force){ if(s===gameLastShownSec){ info.textContent = `長度：${fmtGame(state.game.totalMs)}`; return; } gameLastShownSec=s; }
  d.textContent = fmtGame(state.game.ms);
  info.textContent = `長度：${fmtGame(state.game.totalMs)}`;
  const linkBtn = $('#toggleLink'); if(linkBtn) linkBtn.textContent = `與 24s 連動：${state.game.linkShot?'開':'關'}`;
  saveState();
}
function startGame(){
  if(gameTimer) clearInterval(gameTimer);
  state.game.running=true; state.game.lastTs=performance.now();
  if(state.game.linkShot && !state.shot.running) startShot();
  const tick=()=>{
    const now=performance.now(), elapsed=now-state.game.lastTs;
    state.game.lastTs=now; state.game.ms-=elapsed;
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

// ====== TXT 匯出（UTF-8 BOM + CRLF） ======
function buildTxt(players){
  const L = [];
  L.push(`# ${state.gameTitle || '未命名比賽'}`);
  L.push(`# Period: ${periodLabel(state.period)}`);
  L.push(`# Score: HOME ${state.home.score} - AWAY ${state.away.score}`);
  L.push(`# TeamFouls: HOME ${state.home.teamFouls} / AWAY ${state.away.teamFouls}${(state.home.teamFouls>=BONUS_LIMIT||state.away.teamFouls>=BONUS_LIMIT)?' (Bonus in effect)':''}`);
  L.push(`# Timeouts: HOME ${state.home.timeouts} / AWAY ${state.away.timeouts}`);
  L.push(`# GameClock: ${fmtGame(state.game.ms)} / ${fmtGame(state.game.totalMs)}${state.game.running?' (running)':''}`);
  L.push(`# Possession: ${state.shot.poss==='home'?'HOME':'AWAY'}`);
    // NEW: 裁判資訊
  const R = state.referees || {};
  const refLine = [
    `Crew Chief: ${R.crew || '-'}`,
    `Umpire 1: ${R.u1 || '-'}`,
    `Umpire 2: ${R.u2 || '-'}`
  ].join(' | ');
  L.push(`# Referees: ${refLine}`);
  const s = state.shot.ms/1000;
  L.push(`# ShotClock: ${s>8?Math.ceil(s):s.toFixed(2)}s ${state.shot.running?'(running)':''}`);
  L.push('');
  L.push('Team,Number,Name,Pos,PTS,PF_Total,PF_Off,PF_Tech,PF_Unspt,AST,REB,STL,BLK,TOV');
  players.sort((a,b)=> (a.team===b.team?0:(a.team==='home'?-1:1)) || (a.number-b.number))
    .forEach(p=>{
      p=ensurePlayerShape(p);
      const row=[p.team,p.number,p.name,p.pos,p.PTS|0,(p.PF|0),(p.PFOFF|0),(p.PFT|0),(p.PFU|0),p.AST|0,p.REB|0,p.STL|0,p.BLK|0,p.TOV|0];
      L.push(row.join(','));
    });
  const notes = (document.getElementById('notes')?.value||'').trim();
  if(notes){ L.push(''); L.push('--- Notes ---'); L.push(notes); }
  return L.join('\r\n');
}
async function getSavedHandle(){ const rec = await get('file','txtHandle'); return rec?.handle || null; }
async function setSavedHandle(handle){ try{ if(handle?.requestPermission) await handle.requestPermission({mode:'readwrite'});}catch(e){} await put('file',{k:'txtHandle', handle}); }
async function saveAsTxt(){
  const players = await allPlayers();
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
    const players = await allPlayers();
    const txt = buildTxt(players);
    const w = await handle.createWritable(); await w.write('\ufeff'+txt); await w.close();
    alert('已更新並覆寫原檔。');
  }catch(err){ console.warn(err); await saveAsTxt(); }
}

// ====== 事件面板邏輯 ======
function getEvtTarget(){
  const team = $('#evtTeam')?.value || 'home';
  const num  = parseInt($('#evtNum')?.value||'0',10);
  if(!num){ alert('請先輸入背號'); return null; }
  return {team,num,id:idOf(team,num)};
}
async function appendNote(text){
  const notes = $('#notes'); if(notes){ notes.value += (notes.value?'\r\n':'') + `【${new Date().toLocaleTimeString()}】` + text; }
  await saveState();
}
async function eventAddFoul(playerId, type, note){
  await updatePersonalFoul(playerId, type, +1);
  await appendNote(note);
}
function sideOpp(side){ return side==='home'?'away':'home'; }

function bindEventPanel(){
  const defCommon = $('#evDefCommon');
  if(defCommon) defCommon.onclick = async ()=>{
    const tgt = getEvtTarget(); if(!tgt) return;
    await eventAddFoul(tgt.id,'common', `${sideLabel(tgt.team)} #${tgt.num} 防守犯規 → ${sideLabel(sideOpp(tgt.team))} 兩罰`);
  };
  const offensive = $('#evOffensive');
  if(offensive) offensive.onclick = async ()=>{
    const tgt = getEvtTarget(); if(!tgt) return;
    await eventAddFoul(tgt.id,'offensive', `${sideLabel(tgt.team)} #${tgt.num} 進攻犯規（控球犯規）`);
    // 常見處理：換球權，重置24
    swapPossession(); resetShot(24000,{autoRunIfLinked:true});
  };
  const shoot2 = $('#evShoot2');
  if(shoot2) shoot2.onclick = async ()=>{
    const tgt = getEvtTarget(); if(!tgt) return;
    await eventAddFoul(tgt.id,'common', `${sideLabel(tgt.team)} #${tgt.num} 投籃犯規（2罰）`);
  };
  const shoot3 = $('#evShoot3');
  if(shoot3) shoot3.onclick = async ()=>{
    const tgt = getEvtTarget(); if(!tgt) return;
    await eventAddFoul(tgt.id,'common', `${sideLabel(tgt.team)} #${tgt.num} 投籃犯規（3罰）`);
  };
  const and1 = $('#evAnd1');
  if(and1) and1.onclick = async ()=>{
    const tgt = getEvtTarget(); if(!tgt) return;
    await eventAddFoul(tgt.id,'common', `${sideLabel(tgt.team)} #${tgt.num} And-1（投籃成球外加一罰）`);
  };
  const tech = $('#evTechnical');
  if(tech) tech.onclick = async ()=>{
    const tgt = getEvtTarget(); if(!tgt) return;
    await eventAddFoul(tgt.id,'technical', `${sideLabel(tgt.team)} #${tgt.num} 技術犯規`);
  };
  const uns = $('#evUnsports');
  if(uns) uns.onclick = async ()=>{
    const tgt = getEvtTarget(); if(!tgt) return;
    await eventAddFoul(tgt.id,'unsportsmanlike', `${sideLabel(tgt.team)} #${tgt.num} 違體犯規`);
  };
}

// ====== 綁定事件 ======
function bindEvents(){
  // 匯出
  const be=$('#btnExport'); if(be) be.onclick = saveAsTxt;
  const bu=$('#btnUpdate'); if(bu) bu.onclick = updateTxt;

  // 清空
  const br=$('#btnReset'); if(br) br.onclick = async ()=>{
    if(!confirm('確定要清空本場資料？（球員與分數等將清空）')) return;
    db.close();
    await new Promise((res,rej)=>{ const delReq = indexedDB.deleteDatabase(DB_NAME); delReq.onsuccess=()=>res(); delReq.onerror=()=>rej(delReq.error); });
    await openDB(); location.reload();
  };

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
  const hfr=$('#homeFoulsReset'); if(hfr) hfr.onclick = ()=>{ state.home.teamFouls=0; renderTeamFouls('home'); };
  const afr=$('#awayFoulsReset'); if(afr) afr.onclick = ()=>{ state.away.teamFouls=0; renderTeamFouls('away'); };

  // 節次
  const pi=$('#periodInc'); if(pi) pi.onclick = ()=>{ state.period=(state.period|0)+1; if(state.period>4){ state.game.totalMs=5*60*1000; } resetGameClock(); resetTeamFouls(); resetShot(24000,{autoRunIfLinked:true}); renderPeriod(); saveState(); };
  const pd=$('#periodDec'); if(pd) pd.onclick = ()=>{ state.period=Math.max(1,(state.period|0)-1); if(state.period>4){ state.game.totalMs=5*60*1000; } resetGameClock(); resetTeamFouls(); resetShot(24000,{autoRunIfLinked:true}); renderPeriod(); saveState(); };

  // 標題
  const gt=$('#gameTitle'); if(gt) gt.addEventListener('input', e=>{ state.gameTitle = e.target.value; saveState(); });

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
    saveState(); renderPlayers();
  };
  ['ruleCountCommon','ruleCountOffensive','ruleCountTechnical','ruleCountUnsportsmanlike','limitPF','limitT','limitU'].forEach(id=>{
    const el = document.getElementById(id); if(el) el.addEventListener('change', syncRulesFromUI);
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
    // 這裡同樣設為常見實務：PF=6 也有人用 6；若你要 6 請改這裡或 UI 上改
    $('#ruleCountCommon').checked = true;
    $('#ruleCountOffensive').checked = false;
    $('#ruleCountTechnical').checked = false;
    $('#ruleCountUnsportsmanlike').checked = true;
    $('#limitPF').value = 6; $('#limitT').value = 2; $('#limitU').value = 2;
    syncRulesFromUI();
  });
  
    // NEW: 裁判輸入即時存檔
  const onRefChange = ()=>{
    state.referees.crew = document.getElementById('refCrew')?.value?.trim() || '';
    state.referees.u1   = document.getElementById('refU1')?.value?.trim()   || '';
    state.referees.u2   = document.getElementById('refU2')?.value?.trim()   || '';
    saveState();
  };
  document.getElementById('refCrew')?.addEventListener('input', onRefChange);
  document.getElementById('refU1')?.addEventListener('input', onRefChange);
  document.getElementById('refU2')?.addEventListener('input', onRefChange);

  // 事件面板
  bindEventPanel();
}

// ====== 啟動 ======
(async function init(){
  await openDB();
  await loadState();
  await renderPlayers();
  bindEvents();
})();