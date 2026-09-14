import {
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const video = document.getElementById('cam');
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const startOverlay = document.getElementById('startOverlay');
const endOverlay = document.getElementById('endOverlay');
const startBtn = document.getElementById('startBtn');
const retryBtn = document.getElementById('retryBtn');
const camStatus = document.getElementById('camStatus');
const score1El = document.getElementById('score1');
const score2El = document.getElementById('score2');
const p2Pill = document.getElementById('p2Pill');
const timeEl = document.getElementById('time');
const finalScoreText = document.getElementById('finalScoreText');
const statsBar = document.getElementById('statsBar');
const modeRow = document.getElementById('modeRow');

// ---- sound effects (synthesized with Web Audio API, no external files) ----
let audioCtx = null;
function ensureAudio(){
  if(!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } else if(audioCtx.state === 'suspended'){
    audioCtx.resume();
  }
  return audioCtx;
}

function playTone({freq=440, freqEnd=null, duration=0.15, type='sine', vol=0.2, delay=0}={}){
  const ctxA = ensureAudio();
  const osc = ctxA.createOscillator();
  const gain = ctxA.createGain();
  osc.type = type;
  const t0 = ctxA.currentTime + delay;
  osc.frequency.setValueAtTime(freq, t0);
  if(freqEnd !== null){
    osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 20), t0 + duration);
  }
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ctxA.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}

function playCatchFruit(pts){
  // brighter chime for higher-value fruit
  const base = 480 + pts * 70;
  playTone({ freq: base, freqEnd: base * 1.6, duration: 0.13, type: 'triangle', vol: 0.22 });
}

function playCatchBomb(){
  const ctxA = ensureAudio();
  const bufferSize = Math.floor(ctxA.sampleRate * 0.25);
  const buffer = ctxA.createBuffer(1, bufferSize, ctxA.sampleRate);
  const data = buffer.getChannelData(0);
  for(let i = 0; i < bufferSize; i++){
    data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  }
  const noise = ctxA.createBufferSource();
  noise.buffer = buffer;
  const filter = ctxA.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(1400, ctxA.currentTime);
  filter.frequency.exponentialRampToValueAtTime(120, ctxA.currentTime + 0.25);
  const gain = ctxA.createGain();
  gain.gain.setValueAtTime(0.32, ctxA.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctxA.currentTime + 0.25);
  noise.connect(filter).connect(gain).connect(ctxA.destination);
  noise.start();
  playTone({ freq: 140, freqEnd: 55, duration: 0.22, type: 'sawtooth', vol: 0.25 });
}

function playCountdownTick(){
  playTone({ freq: 880, duration: 0.08, type: 'square', vol: 0.1 });
}

function playGameStart(){
  [523, 659, 784].forEach((f, i) =>
    playTone({ freq: f, duration: 0.12, type: 'triangle', vol: 0.18, delay: i * 0.09 })
  );
}

function playGameOver(){
  [784, 659, 523, 392].forEach((f, i) =>
    playTone({ freq: f, duration: 0.18, type: 'triangle', vol: 0.2, delay: i * 0.12 })
  );
}
// -----------------------------------------------------------------------

let numPlayers = 1;
modeRow.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if(!btn) return;
  [...modeRow.querySelectorAll('.mode-btn')].forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  numPlayers = parseInt(btn.dataset.mode, 10);
  p2Pill.style.display = numPlayers === 2 ? 'flex' : 'none';
});

let handLandmarker = null;

async function initHandLandmarker(maxHands){
  camStatus.textContent = 'กำลังโหลดโมเดลตรวจจับมือ...';
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: maxHands,
  });
}

let W = 0, H = 0;
function resize(){
  const rect = canvas.getBoundingClientRect();
  W = canvas.width = rect.width;
  H = canvas.height = rect.height;
}
window.addEventListener('resize', resize);

// Players: index 0 = player 1 (blue, left half), index 1 = player 2 (orange, right half)
// Each player's basket is confined to its own half of the screen so the two
// baskets can never physically overlap or "fight" over the same fruit.
const ZONE = [
  { min: 0.06, max: 0.47 },
  { min: 0.53, max: 0.94 },
];

const players = [
  { basketX: 0.26, targetX: 0.26, visible: false, score: 0, fruitsCaught: 0, bombsHit: 0, color: '#6db8f2', label: '🔵' },
  { basketX: 0.74, targetX: 0.74, visible: false, score: 0, fruitsCaught: 0, bombsHit: 0, color: '#f2934a', label: '🟠' },
];

let running = false;
let timeLeft = 45;
let timerInterval = null;
let bombFlashUntil = 0;

const FRUITS = [
  { emoji:'🍎', pts:1 },
  { emoji:'🍊', pts:1 },
  { emoji:'🍋', pts:1 },
  { emoji:'🍇', pts:2 },
  { emoji:'🍓', pts:2 },
  { emoji:'🥝', pts:3 },
];

const BOMB_CHANCE = 0.35;
const BOMB_PENALTY = 3;

let items = [];
let spawnTimer = 0;
let spawnInterval = 36;

function spawnItem(){
  const isBomb = Math.random() < BOMB_CHANCE;
  if(isBomb){
    items.push({
      x: 0.08 + Math.random()*0.84,
      y: -0.08,
      speed: 0.004 + Math.random()*0.004,
      emoji: '💣',
      pts: -BOMB_PENALTY,
      isBomb: true,
      size: 34,
      caught: false,
      rot: (Math.random()-0.5)*0.4,
    });
  } else {
    const f = FRUITS[Math.floor(Math.random()*FRUITS.length)];
    items.push({
      x: 0.08 + Math.random()*0.84,
      y: -0.08,
      speed: 0.0035 + Math.random()*0.0035,
      emoji: f.emoji,
      pts: f.pts,
      isBomb: false,
      size: 34 + Math.random()*10,
      caught: false,
      rot: (Math.random()-0.5)*0.4,
    });
  }
}

function detectHands(){
  if(!handLandmarker || video.readyState < 2) return;
  const now = performance.now();
  const result = handLandmarker.detectForVideo(video, now);

  players.forEach(p => p.visible = false);

  if(result.landmarks && result.landmarks.length > 0){
    // mirrored x for each detected hand (landmark 9 = middle finger MCP)
    const detected = result.landmarks.map(lm => 1 - lm[9].x);

    if(numPlayers === 1){
      players[0].targetX = detected[0];
      players[0].visible = true;
    } else {
      // sort left-to-right: the leftmost hand is always player 1, the
      // rightmost is always player 2. Combined with each basket being
      // locked to its own half of the screen, this keeps assignment
      // stable even when both hands are on screen at once.
      const sorted = [...detected].sort((a, b) => a - b);
      if(sorted.length >= 1){
        players[0].targetX = sorted[0];
        players[0].visible = true;
      }
      if(sorted.length >= 2){
        players[1].targetX = sorted[sorted.length - 1];
        players[1].visible = true;
      }
    }
  }
}

function update(){
  const activePlayers = players.slice(0, numPlayers);

  activePlayers.forEach((p, i) => {
    p.basketX += (p.targetX - p.basketX) * 0.22;
    const zone = numPlayers === 2 ? ZONE[i] : { min: 0.06, max: 0.94 };
    p.basketX = Math.max(zone.min, Math.min(zone.max, p.basketX));
  });

  spawnTimer++;
  if(spawnTimer > spawnInterval){
    spawnTimer = 0;
    spawnItem();
    if(spawnInterval > 16) spawnInterval -= 0.4;
  }

  const basketPxY = H - 46;
  const basketHalfWidth = 52;

  for(let i=items.length-1; i>=0; i--){
    const it = items[i];
    it.y += it.speed;
    const px = it.x * W;
    const py = it.y * H;

    if(!it.caught && py > basketPxY - 18 && py < basketPxY + 22){
      for(const p of activePlayers){
        const basketPxX = p.basketX * W;
        if(Math.abs(px - basketPxX) < basketHalfWidth){
          it.caught = true;
          p.score = Math.max(0, p.score + it.pts);
          if(p === players[0]) score1El.textContent = p.score;
          else score2El.textContent = p.score;
          if(it.isBomb){
            p.bombsHit++;
            bombFlashUntil = performance.now() + 220;
            playCatchBomb();
          } else {
            p.fruitsCaught++;
            playCatchFruit(it.pts);
          }
          items.splice(i,1);
          break;
        }
      }
      if(it.caught) continue;
    }
    if(it.y > 1.08){
      items.splice(i,1);
    }
  }
}

function draw(){
  ctx.clearRect(0,0,W,H);

  // zone divider for 2-player mode
  if(numPlayers === 2){
    ctx.save();
    ctx.strokeStyle = 'rgba(244,234,217,0.12)';
    ctx.setLineDash([6,8]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W/2, 0);
    ctx.lineTo(W/2, H);
    ctx.stroke();
    ctx.restore();
  }

  // ground line
  const groundY = H - 30;
  ctx.strokeStyle = 'rgba(244,234,217,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, groundY);
  ctx.lineTo(W, groundY);
  ctx.stroke();

  // items
  for(const it of items){
    const px = it.x * W;
    const py = it.y * H;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(it.rot);
    ctx.font = it.size + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(it.emoji, 0, 0);
    ctx.restore();
  }

  // baskets
  const activePlayers = players.slice(0, numPlayers);
  activePlayers.forEach(p => {
    const bx = p.basketX * W;
    const by = H - 46;
    ctx.save();
    ctx.translate(bx, by);
    ctx.beginPath();
    ctx.arc(0, 4, 30, 0, Math.PI*2);
    ctx.fillStyle = p.color + '33';
    ctx.fill();
    ctx.font = '52px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🧺', 0, 0);
    ctx.restore();
  });

  // bomb-hit flash
  if(performance.now() < bombFlashUntil){
    ctx.save();
    ctx.fillStyle = 'rgba(230,60,50,0.18)';
    ctx.fillRect(0,0,W,H);
    ctx.restore();
  }

  // hand-tracking indicator
  const missing = activePlayers.filter(p => !p.visible).length;
  if(missing > 0){
    ctx.save();
    ctx.font = "600 13px 'Baloo 2', sans-serif";
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(246,131,107,0.85)';
    const msg = numPlayers === 1
      ? 'ยกมือให้เห็นในกล้อง'
      : 'ให้เห็นมือทั้งสองฝั่งในกล้อง';
    ctx.fillText(msg, W/2, 26);
    ctx.restore();
  }
}

let rafId = null;
function loop(){
  if(!running) return;
  detectHands();
  update();
  draw();
  rafId = requestAnimationFrame(loop);
}

function startTimer(){
  timeLeft = 45;
  timeEl.textContent = timeLeft;
  timerInterval = setInterval(()=>{
    timeLeft--;
    timeEl.textContent = timeLeft;
    if(timeLeft > 0 && timeLeft <= 5){
      playCountdownTick();
    }
    if(timeLeft <= 0){
      endGame();
    }
  }, 1000);
}

function buildStatsHTML(){
  const activePlayers = players.slice(0, numPlayers);
  return activePlayers.map((p, i) => {
    const total = p.fruitsCaught + p.bombsHit;
    const acc = total ? Math.round((p.fruitsCaught / total) * 100) : 0;
    const nameLabel = numPlayers === 2 ? `${p.label} ผู้เล่น ${i + 1}` : '';
    return `
      <div class="stats-group">
        ${nameLabel ? `<div class="stats-player-label" style="color:${p.color}">${nameLabel}</div>` : ''}
        <div class="stats-row">
          <div class="stats-pill"><div class="num">${p.fruitsCaught}</div><div class="lbl">ผลไม้</div></div>
          <div class="stats-pill bomb"><div class="num">${p.bombsHit}</div><div class="lbl">ระเบิด</div></div>
          <div class="stats-pill"><div class="num">${acc}%</div><div class="lbl">แม่นยำ</div></div>
        </div>
      </div>`;
  }).join('');
}

function endGame(){
  running = false;
  clearInterval(timerInterval);
  if(rafId) cancelAnimationFrame(rafId);
  playGameOver();
  if(numPlayers === 1){
    finalScoreText.textContent = 'คุณจับผลไม้ได้ ' + players[0].score + ' แต้ม';
  } else {
    const s1 = players[0].score, s2 = players[1].score;
    let result;
    if(s1 > s2) result = '🔵 ผู้เล่น 1 ชนะ!';
    else if(s2 > s1) result = '🟠 ผู้เล่น 2 ชนะ!';
    else result = 'เสมอกัน!';
    finalScoreText.textContent = `🔵 ${s1} — ${s2} 🟠  ·  ${result}`;
  }
  statsBar.innerHTML = buildStatsHTML();
  endOverlay.style.display = 'flex';
}

function resetState(){
  players.forEach((p, i) => {
    p.score = 0;
    p.fruitsCaught = 0;
    p.bombsHit = 0;
    p.basketX = i === 0 ? 0.26 : 0.74;
    p.targetX = p.basketX;
    p.visible = false;
  });
  score1El.textContent = 0;
  score2El.textContent = 0;
  items = [];
  spawnTimer = 0;
  spawnInterval = 36;
  bombFlashUntil = 0;
}

async function startGame(){
  startBtn.disabled = true;
  try{
    if(!handLandmarker){
      await initHandLandmarker(2);
    }
    camStatus.textContent = 'กำลังขอสิทธิ์กล้อง...';
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width:320, height:240 }, audio:false });
    video.srcObject = stream;
    await video.play();
  }catch(err){
    camStatus.textContent = 'เกิดข้อผิดพลาด: ' + err.message + ' — ลองอนุญาตสิทธิ์กล้อง หรือตรวจสอบการเชื่อมต่ออินเทอร์เน็ต (ต้องโหลดโมเดลตรวจจับมือครั้งแรก) แล้วลองใหม่';
    startBtn.disabled = false;
    return;
  }
  startBtn.disabled = false;
  resize();
  resetState();
  startOverlay.style.display = 'none';
  endOverlay.style.display = 'none';
  running = true;
  playGameStart();
  startTimer();
  loop();
}

startBtn.addEventListener('click', startGame);
retryBtn.addEventListener('click', () => {
  endOverlay.style.display = 'none';
  resetState();
  running = true;
  playGameStart();
  startTimer();
  loop();
});

// initial sizing
window.addEventListener('load', resize);
resize();
