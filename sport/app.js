// ====== 常數 ======
const DB_NAME = 'basket-scoreboard';
const DB_VER  = 5; // 與上一版一致
const BONUS_LIMIT = 5;

// ====== IndexedDB 小工具 ======
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
  shot:{ ms:24000, running:false, lastTs:null, poss:'home' },
  game:{ ms:12*60*1000, totalMs:12*60*1000, running:false, lastTs:null, linkShot:false },
  ui:{ view:'scoreView' }
};

async function saveState(){ await put('game',{k:'state', v:structuredClone(state)}); }
function idOf(team,num){ return `${team}#${num}`; }
function periodLabel(n){ return n<=4 ? `第${n}節` : `OT${n-4}`; }

// ====== 初始化 ======
async function loadState(){
  const saved = await get('game','state');
  if(saved){ Object.assign(state,saved.v); }
  // 初始化 UI
  $('#gameTitle').value = state.gameTitle || '';
  setScore('home', state.home.score);
  setScore('away', state.away.score);
  renderTeamFouls('home'); renderTeamFouls('away');
  $('#homeTO').textContent = state.home.timeouts;
  $('#awayTO').textContent = state.away.timeouts;
  renderPeriod();
  updateShotUI(true);
  updateGameUI(true);
  setView(state.ui.view || 'scoreView');
  if(state.shot.running) startShot(true);
  if(state.game.running) startGame(true);
}

// 小幫手
const $ = (sel)=>document.querySelector(sel);

// ====== 節次 / 比分 ======
function renderPeriod(){ $('#period').textContent = periodLabel(state.period); }
function setScore(side, val){
  state[side].score = Math.max(0, val|0);
  $('#'+side+'Score').textContent = state[side].score;
  saveState();
}

// ====== 團隊犯規 ======
function renderTeamFouls(side){
  const n = Math.max(0, state[side].teamFouls|0);
  $('#'+side+'Fouls').textContent = n;
  const bonusEl = $('#'+side+'Bonus');
  bonusEl.style.display = n >= BONUS_LIMIT ? 'inline-flex' : 'none';
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

// ====== 球員表格（含個人犯規控制） ======
function trForPlayer(p){
  const tr = document.createElement('tr'); tr.dataset.id=p.id;
  const cells = [
    ['team', p.team==='home'?'主隊':'客隊', false],
    ['number', p.number, true],
    ['name', p.name||'', true],
    ['pos', p.pos||'', true],
    ['PTS', p.PTS|0, false],
    ['PF',  p.PF|0,  false],
    ['AST', p.AST|0, false],
    ['REB', p.REB|0, false],
    ['STL', p.STL|0, false],
    ['BLK', p.BLK|0, false],
    ['TOV', p.TOV|0, false],
  ];
  for(const [k,val,editable] of cells){
    const td = document.createElement('td');
    td.className = ['PTS','PF','AST','REB','STL','BLK','TOV'].includes(k)?'mono':'';
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
        await put('players', storeVal);
        renderPlayers();
      });
    }
    tr.appendChild(td);
  }
  const op = document.createElement('td');

  const pfPlus = document.createElement('button');
  pfPlus.textContent = '+ 犯規'; pfPlus.className='opbtn btn-warn';
  pfPlus.addEventListener('click', async ()=>{
    const rec = await get('players', p.id); if(!rec) return;
    rec.PF = (rec.PF|0)+1; await put('players', rec); addTeamFoul(rec.team, +1); renderPlayers();
  });

  const pfMinus = document.createElement('button');
  pfMinus.textContent = '- 犯規'; pfMinus.className='opbtn';
  pfMinus.addEventListener('click', async ()=>{
    const rec = await get('players', p.id); if(!rec) return;
    if((rec.PF|0)>0){ rec.PF = rec.PF-1; await put('players', rec); addTeamFoul(rec.team, -1); renderPlayers(); }
  });

  const delBtn = document.createElement('button');
  delBtn.textContent='刪除'; delBtn.className='opbtn';
  delBtn.addEventListener('click', async ()=>{ await del('players', p.id); renderPlayers(); });

  op.appendChild(pfPlus); op.appendChild(pfMinus); op.appendChild(delBtn);
  tr.appendChild(op);
  return tr;
}
async function renderPlayers(){
  const players = await allPlayers();
  const tbody = $('#playersTbl tbody');
  if(!tbody) return;
  tbody.innerHTML='';
  players.sort((a,b)=> (a.team===b.team?0:(a.team==='home'?-1:1)) || (a.number-b.number));
  for(const p of players){ tbody.appendChild(trForPlayer(p)); }
}

// ====== Tabs ======
function setView(viewId){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  $('#'+viewId).classList.add('active');
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.view===viewId));
  state.ui.view = viewId; saveState();
}
document.querySelectorAll('.tab').forEach(btn=>{
  btn.addEventListener('click', ()=> setView(btn.dataset.view));
});

// ====== Shot Clock（>8s：整秒；≤8s：兩位小數） ======
let shotTimer = null, lastShownWhole = null;
function fmtShot(ms){
  const s = Math.max(0, ms)/1000;
  if(s > 8) return String(Math.ceil(s|0));
  return s.toFixed(2);
}
function updateShotUI(force=false){
  const d = $('#shotDisplay');
  const pos = $('#shotPos');
  const s = state.shot.ms/1000;
  d.classList.toggle('shot-danger', s<=8);
  if(s>8 && !force){
    const whole = Math.ceil(s);
    if(whole===lastShownWhole) { pos.textContent = `球權：${state.shot.poss==='home'?'主隊':'客隊'}${state.shot.running?'（計時中）':''}`; return; }
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
function pauseShot(){
  if(shotTimer){ clearInterval(shotTimer); shotTimer=null; }
  state.shot.running=false; state.shot.lastTs=null;
  updateShotUI(true);
}
function resetShot(ms, {autoRunIfLinked=false}={}){
  state.shot.ms = ms;
  state.shot.lastTs = performance.now();
  lastShownWhole = null;
  updateShotUI(true);
  if(state.shot.running){ clearInterval(shotTimer); startShot(); }
  if(autoRunIfLinked && state.game.linkShot && state.game.running && !state.shot.running){
    startShot();
  }
}
function swapPossession(){
  state.shot.poss = (state.shot.poss==='home'?'away':'home');
  updateShotUI(true);
}
async function shotViolationAuto(){
  const team = state.shot.poss;
  const notes = $('#notes');
  notes.value += (notes.value?'\r\n':'') + `【${new Date().toLocaleTimeString()}】${team==='home'?'主隊':'客隊'} 24秒違例`;
  swapPossession();
  resetShot(24000, {autoRunIfLinked:true});
  await saveState();
}
async function shotViolationManual(){ pauseShot(); buzzer(); await shotViolationAuto(); }

// ====== Game Clock（比賽時計） ======
let gameTimer = null, gameLastShownSec = null;
function fmtGame(ms){
  const t = Math.max(0, ms|0);
  const s = Math.floor(t/1000);
  const m = Math.floor(s/60);
  const sec = s%60;
  if(s >= 60){
    return `${String(m).padStart(1,'0')}:${String(sec).padStart(2,'0')}`;
  }else{
    const hundred = Math.floor((t%1000)/10); // 兩位小數（百分之一秒）
    return `${String(m).padStart(1,'0')}:${String(sec).padStart(2,'0')}.${String(hundred).padStart(2,'0')}`;
  }
}
function updateGameUI(force=false){
  const d = $('#gameDisplay');
  const info = $('#gameInfo');
  const s = Math.floor(state.game.ms/1000);
  d.classList.toggle('game-danger', s<60);
  if(s>=60 && !force){
    if(s===gameLastShownSec){ info.textContent = `長度：${fmtGame(state.game.totalMs)}`; return; }
    gameLastShownSec = s;
  }
  d.textContent = fmtGame(state.game.ms);
  info.textContent = `長度：${fmtGame(state.game.totalMs)}`;
  $('#toggleLink').textContent = `與 24s 連動：${state.game.linkShot?'開':'關'}`;
  saveState();
}
function startGame(){
  if(gameTimer) clearInterval(gameTimer);
  state.game.running = true;
  state.game.lastTs = performance.now();
  if(state.game.linkShot && !state.shot.running) startShot(); // 同步啟動 24s
  const tick = ()=>{
    const now = performance.now();
    const elapsed = now - state.game.lastTs;
    state.game.lastTs = now;
    state.game.ms -= elapsed;
    if(state.game.ms <= 0){
      state.game.ms = 0;
      updateGameUI(true);
      clearInterval(gameTimer); gameTimer=null;
      state.game.running=false;
      buzzer();
      nextPeriod();
    }else{
      updateGameUI();
    }
  };
  gameTimer = setInterval(tick, (state.game.ms>=60*1000)? 250 : 50);
  updateGameUI(true);
}
function pauseGame(){
  if(gameTimer){ clearInterval(gameTimer); gameTimer=null; }
  state.game.running=false; state.game.lastTs=null;
  if(state.game.linkShot && state.shot.running) pauseShot();
  updateGameUI(true);
}
function setGameLength(mins){
  const ms = mins*60*1000;
  state.game.totalMs = ms;
  state.game.ms = ms;
  gameLastShownSec = null;
  updateGameUI(true);
  if(state.game.running){ clearInterval(gameTimer); startGame(); }
}
function resetGameClock(){
  state.game.ms = state.game.totalMs;
  gameLastShownSec = null;
  updateGameUI(true);
}
function nextPeriod(){
  state.period += 1;
  if(state.period <= 4){
    resetGameClock();
  }else{
    state.game.totalMs = 5*60*1000; // OT 統一 5:00
    resetGameClock();
  }
  resetTeamFouls();
  resetShot(24000, {autoRunIfLinked:true});
  renderPeriod();
  saveState();
}

// ====== 匯出 TXT（UTF-8 BOM + CRLF） ======
function buildTxt(players){
  const L = [];
  L.push(`# ${state.gameTitle || '未命名比賽'}`);
  L.push(`# Period: ${periodLabel(state.period)}`);
  L.push(`# Score: HOME ${state.home.score} - AWAY ${state.away.score}`);
  L.push(`# TeamFouls: HOME ${state.home.teamFouls} / AWAY ${state.away.teamFouls}${(state.home.teamFouls>=BONUS_LIMIT||state.away.teamFouls>=BONUS_LIMIT)?' (Bonus in effect)':''}`);
  L.push(`# Timeouts: HOME ${state.home.timeouts} / AWAY ${state.away.timeouts}`);
  L.push(`# GameClock: ${fmtGame(state.game.ms)} / ${fmtGame(state.game.totalMs)}${state.game.running?' (running)':''}`);
  L.push(`# Possession: ${state.shot.poss==='home'?'HOME':'AWAY'}`);
  const s = state.shot.ms/1000;
  L.push(`# ShotClock: ${s>8?Math.ceil(s):s.toFixed(2)}s ${state.shot.running?'(running)':''}`);
  L.push('');
  L.push('Team,Number,Name,Pos,PTS,PF,AST,REB,STL,BLK,TOV');
  players.sort((a,b)=> (a.team===b.team?0:(a.team==='home'?-1:1)) || (a.number-b.number))
    .forEach(p=>L.push(`${p.team},${p.number},${p.name},${p.pos},${p.PTS|0},${p.PF|0},${p.AST|0},${p.REB|0},${p.STL|0},${p.BLK|0},${p.TOV|0}`));
  const notes = ($('#notes')?.value||'').trim();
  if(notes){ L.push(''); L.push('--- Notes ---'); L.push(notes); }
  return L.join('\r\n');
}
async function getSavedHandle(){ const rec = await get('file','txtHandle'); return rec?.handle || null; }
async function setSavedHandle(handle){
  try{ if (handle && handle.requestPermission) await handle.requestPermission({mode:'readwrite'});}catch(e){}
  await put('file',{k:'txtHandle', handle});
}
async function saveAsTxt(){
  const players = await allPlayers();
  const txt = buildTxt(players);
  const bom = '\ufeff';
  if(window.showSaveFilePicker){
    const handle = await window.showSaveFilePicker({
      suggestedName: (state.gameTitle||'game') + '.txt',
      types: [{ description: 'Text', accept: {'text/plain':['.txt']} }]
    });
    const writable = await handle.createWritable();
    await writable.write(bom + txt);
    await writable.close();
    await setSavedHandle(handle);
    alert('已匯出 TXT 並記住檔案位置。之後可用「更新」覆寫。');
  }else{
    const blob = new Blob([bom, txt], {type:'text/plain;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.gameTitle||'game') + '-' + new Date().toISOString().replaceAll(':','').slice(0,15)+'.txt';
    a.click();
    URL.revokeObjectURL(a.href);
    alert('瀏覽器不支援覆寫同檔，已下載新檔（含 UTF-8 BOM）。');
  }
}
async function updateTxt(){
  const handle = await getSavedHandle();
  if(!handle){ await saveAsTxt(); return; }
  try{
    const players = await allPlayers();
    const txt = buildTxt(players);
    const writable = await handle.createWritable();
    await writable.write('\ufeff' + txt);
    await writable.close();
    alert('已更新並覆寫原檔。');
  }catch(err){
    console.warn(err);
    await saveAsTxt();
  }
}

// ====== 事件綁定 ======
function bindEvents(){
  // 匯出
  $('#btnExport').onclick = saveAsTxt;
  $('#btnUpdate').onclick = updateTxt;

  // 重置整場
  $('#btnReset').onclick = async ()=>{
    if(!confirm('確定要清空本場資料？（球員與分數等將清空）')) return;
    db.close();
    await new Promise((res,rej)=>{ const delReq = indexedDB.deleteDatabase(DB_NAME); delReq.onsuccess=()=>res(); delReq.onerror=()=>rej(delReq.error); });
    await openDB();
    location.reload();
  };

  // 比分 + 暫停
  document.querySelectorAll('[data-add]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const [side,delta] = btn.dataset.add.split(':'); setScore(side, state[side].score + parseInt(delta,10));
    });
  });
  document.querySelectorAll('[data-tos]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const [side,delta] = btn.dataset.tos.split(':'); state[side].timeouts = Math.max(0, (state[side].timeouts|0) + parseInt(delta,10));
      $('#'+side+'TO').textContent = state[side].timeouts; saveState();
    });
  });

  // 團隊犯規
  document.querySelectorAll('[data-tf]').forEach(btn=>{
    btn.addEventListener('click', ()=>{ const [side,delta] = btn.dataset.tf.split(':'); addTeamFoul(side, parseInt(delta,10)); });
  });
  $('#homeFoulsReset').onclick = ()=>{ state.home.teamFouls=0; renderTeamFouls('home'); };
  $('#awayFoulsReset').onclick = ()=>{ state.away.teamFouls=0; renderTeamFouls('away'); };

  // 節次（手動）
  $('#periodInc').onclick = ()=>{ state.period = (state.period|0)+1; if(state.period>4){ state.game.totalMs = 5*60*1000; } resetGameClock(); resetTeamFouls(); resetShot(24000, {autoRunIfLinked:true}); renderPeriod(); saveState(); };
  $('#periodDec').onclick = ()=>{ state.period = Math.max(1,(state.period|0)-1); if(state.period>4){ state.game.totalMs = 5*60*1000; } resetGameClock(); resetTeamFouls(); resetShot(24000, {autoRunIfLinked:true}); renderPeriod(); saveState(); };

  // 比賽標題
  $('#gameTitle').addEventListener('input', e=>{ state.gameTitle = e.target.value; saveState(); });

  // Shot
  $('#shotStart').onclick = ()=> startShot();
  $('#shotPause').onclick = ()=> pauseShot();
  $('#shotReset24').onclick = ()=> resetShot(24000, {autoRunIfLinked:true});
  $('#shotReset14').onclick = ()=> resetShot(14000, {autoRunIfLinked:true});
  $('#shotMinus').onclick = ()=>{ state.shot.ms = Math.max(0, state.shot.ms-1000); updateShotUI(true); if(state.shot.running){ clearInterval(shotTimer); startShot();} };
  $('#shotPlus').onclick  = ()=>{ state.shot.ms = Math.min(24000, state.shot.ms+1000); updateShotUI(true); if(state.shot.running){ clearInterval(shotTimer); startShot();} };
  $('#shotSwap').onclick  = ()=> { swapPossession(); if(state.game.linkShot && state.game.running) startShot(); };
  $('#shotViolation').onclick = ()=> shotViolationManual();
  $('#qaOffReb14').onclick = ()=> resetShot(14000, {autoRunIfLinked:true});
  $('#qaChangePoss24').onclick = ()=>{ swapPossession(); resetShot(24000, {autoRunIfLinked:true}); };

  // Game
  $('#gameStart').onclick = ()=> startGame();
  $('#gamePause').onclick = ()=> pauseGame();
  $('#gameReset').onclick = ()=> resetGameClock();
  $('#set12').onclick = ()=> setGameLength(12);
  $('#set10').onclick = ()=> setGameLength(10);
  $('#set5').onclick  = ()=> setGameLength(5);
  $('#toggleLink').onclick = ()=>{ state.game.linkShot = !state.game.linkShot; updateGameUI(true); };

  // 新增球員（索引分頁）
  const addPlayerBtn = $('#addPlayer');
  if(addPlayerBtn){
    addPlayerBtn.onclick = async ()=>{
      const number = parseInt($('#pNum').value||'0',10);
      const name   = $('#pName').value.trim();
      const team   = $('#pTeam').value;
      const pos    = $('#pPos').value.trim();
      if(!number || !name){ alert('請輸入背號與姓名'); return; }
      const id = idOf(team, number);
      const base = await get('players', id) || { id, team, number, name:'', pos:'', PTS:0, PF:0, AST:0, REB:0, STL:0, BLK:0, TOV:0 };
      base.name=name; base.pos=pos;
      await put('players', base);
      $('#pNum').value=''; $('#pName').value=''; $('#pPos').value='';
      renderPlayers();
    };
  }
}

// ====== 啟動 ======
(async function init(){
  await openDB();
  await loadState();
  await renderPlayers();
  bindEvents();
})();