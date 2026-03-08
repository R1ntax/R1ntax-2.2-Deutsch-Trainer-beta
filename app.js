const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
  measurementId: 'YOUR_MEASUREMENT_ID'
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const analytics = firebase.analytics?.();

const ranks = [
  { name: 'Anfänger', icon: 'icons/rank1.png' },
  { name: 'Rekrut', icon: 'icons/rank2.png' },
  { name: 'Kämpfer', icon: 'icons/rank3.png' },
  { name: 'Elite', icon: 'icons/rank4.png' },
  { name: 'Meister', icon: 'icons/rank5.png' },
  { name: 'Legende', icon: 'icons/rank6.png' }
];

const defaultWords = [
  ['Haus', 'дом'], ['Baum', 'дерево'], ['Wasser', 'вода'], ['Freund', 'друг'],
  ['Buch', 'книга'], ['Schule', 'школа'], ['Fenster', 'окно'], ['Straße', 'улица'],
  ['Stadt', 'город'], ['Zeit', 'время'], ['Licht', 'свет'], ['Sprache', 'язык']
].map(([german, translation]) => ({ german, translation }));

const $ = (id) => document.getElementById(id);
const state = { user: null, player: null, words: [], myWords: [], duelId: null, duelUnsub: null, duelTimer: null, duelStart: 0 };

$('loginBtn').onclick = async () => {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await auth.signInWithPopup(provider);
    $('bgMusic').play().catch(() => {});
  } catch (e) {
    alert('Ошибка входа: ' + e.message);
  }
};

auth.onAuthStateChanged(async (user) => {
  if (!user) return;
  state.user = user;
  $('authPanel').classList.add('hidden');
  $('menuPanel').classList.remove('hidden');
  $('userBadge').classList.remove('hidden');
  await ensurePlayer();
  bindRealtimePanels();
  await loadWords();
  await loadMyWords();
  renderProfile();
});

async function ensurePlayer() {
  const ref = db.collection('players').doc(state.user.uid);
  const snap = await ref.get();
  const today = new Date().toISOString().slice(0, 10);
  if (!snap.exists) {
    await ref.set({
      name: state.user.displayName || 'Spieler',
      xp: 0, level: 1, rankIndex: 0,
      streak: 1, lastLoginDate: today,
      daily: { date: today, target: 30, progress: 0, claimed: false },
      chests: 0, online: true,
      country: Intl.DateTimeFormat().resolvedOptions().locale,
      device: navigator.userAgent,
      lastActive: firebase.firestore.FieldValue.serverTimestamp()
    });
  } else {
    const data = snap.data();
    let streak = data.streak || 0;
    if (data.lastLoginDate !== today) streak += 1;
    await ref.update({
      streak, lastLoginDate: today, online: true,
      lastActive: firebase.firestore.FieldValue.serverTimestamp(),
      device: navigator.userAgent
    });
  }
  state.player = (await ref.get()).data();
}

async function loadWords() {
  const snap = await db.collection('words').limit(100).get();
  state.words = snap.empty ? defaultWords : snap.docs.map((d) => d.data());
}

async function loadMyWords() {
  const snap = await db.collection('users').doc(state.user.uid).collection('myWords').limit(50).get();
  state.myWords = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderMyWords();
}

function renderProfile() {
  const p = state.player;
  const rank = ranks[p.rankIndex || 0] || ranks[0];
  $('rankIcon').src = rank.icon;
  $('playerName').textContent = state.user.displayName || 'Spieler';
  $('rankLabel').textContent = rank.name;
  $('xpLabel').textContent = `XP: ${p.xp || 0} • Lv. ${p.level || 1}`;
  $('streakLabel').textContent = p.streak || 0;
  $('dailyLabel').textContent = `${p.daily?.progress || 0} / ${p.daily?.target || 30}`;
  $('chestLabel').textContent = p.chests || 0;
}

function calcLevelAndRank(xp) {
  const level = Math.floor(xp / 20) + 1;
  const rankIndex = Math.min(5, Math.floor((level - 1) / 3));
  return { level, rankIndex };
}

async function addXP(points) {
  const ref = db.collection('players').doc(state.user.uid);
  const snap = await ref.get();
  const p = snap.data();
  const xp = (p.xp || 0) + points;
  const daily = p.daily?.date === new Date().toISOString().slice(0, 10)
    ? p.daily
    : { date: new Date().toISOString().slice(0, 10), target: 30, progress: 0, claimed: false };
  daily.progress += points;
  if (!daily.claimed && daily.progress >= daily.target) {
    daily.claimed = true;
    p.chests = (p.chests || 0) + 1;
  }
  const { level, rankIndex } = calcLevelAndRank(xp);
  await ref.update({ xp, level, rankIndex, daily, chests: p.chests || 0, lastActive: firebase.firestore.FieldValue.serverTimestamp() });
  state.player = (await ref.get()).data();
  renderProfile();
}

function playSound(ok) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = ok ? 'sine' : 'sawtooth';
  osc.frequency.value = ok ? 740 : 180;
  gain.gain.value = 0.12;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.18);
}

function showPanel(id) {
  ['studyPanel', 'myWordsPanel', 'duelPanel'].forEach((p) => $(p).classList.add('hidden'));
  $(id).classList.remove('hidden');
}

$('studyModeBtn').onclick = () => { showPanel('studyPanel'); renderRound(); };
$('myWordsModeBtn').onclick = () => { showPanel('myWordsPanel'); loadMyWords(); };
$('duelModeBtn').onclick = () => { showPanel('duelPanel'); };
document.querySelectorAll('.back-menu').forEach((b) => (b.onclick = () => showPanel('menuPanel')));

function renderRound() {
  $('feedback').textContent = '';
  $('feedback').className = '';
  const source = [...state.words, ...state.myWords].slice(0, 100);
  const sample = source.sort(() => 0.5 - Math.random()).slice(0, 4);
  $('cardsGrid').innerHTML = '';
  sample.forEach((w, index) => {
    const card = document.createElement('div');
    card.className = 'card';
    const translations = sample.map((s) => s.translation).sort(() => Math.random() - 0.5);
    card.innerHTML = `<div class="word">${index + 1}. ${w.german}</div><div class="options"></div>`;
    const wrap = card.querySelector('.options');
    translations.forEach((t) => {
      const btn = document.createElement('button');
      btn.className = 'btn opt-btn';
      btn.textContent = t;
      btn.onclick = async () => {
        if (t === w.translation) {
          playSound(true);
          $('feedback').textContent = '✅ Отлично! +5 XP';
          $('feedback').className = 'ok';
          await addXP(5);
          setTimeout(renderRound, 350);
        } else {
          playSound(false);
          $('feedback').textContent = '❌ Неверно. Попробуй снова!';
          $('feedback').className = 'bad';
        }
      };
      wrap.appendChild(btn);
    });
    $('cardsGrid').appendChild(card);
  });
}

$('addWordBtn').onclick = async () => {
  const german = $('germanInput').value.trim();
  const translation = $('translationInput').value.trim();
  if (!german || !translation) return;
  if (state.myWords.length >= 50) return alert('Достигнут лимит 50 слов.');
  await db.collection('users').doc(state.user.uid).collection('myWords').add({ german, translation, createdAt: Date.now() });
  $('germanInput').value = '';
  $('translationInput').value = '';
  await loadMyWords();
};

function renderMyWords() {
  $('myWordsCount').textContent = `Добавлено: ${state.myWords.length}/50`;
  $('myWordsList').innerHTML = '';
  state.myWords.forEach((w) => {
    const li = document.createElement('li');
    li.textContent = `${w.german} → ${w.translation}`;
    $('myWordsList').appendChild(li);
  });
}

$('findDuelBtn').onclick = async () => {
  $('duelStatus').textContent = 'Ищем соперника...';
  const waiting = await db.collection('duels').where('status', '==', 'waiting').limit(1).get();
  if (!waiting.empty && waiting.docs[0].data().player1 !== state.user.uid) {
    const duel = waiting.docs[0];
    await duel.ref.update({ player2: state.user.uid, status: 'active', startedAt: Date.now(), p1Score: 0, p2Score: 0 });
    subscribeDuel(duel.id);
  } else {
    const duelRef = await db.collection('duels').add({ player1: state.user.uid, status: 'waiting', createdAt: Date.now() });
    subscribeDuel(duelRef.id);
  }
};

function subscribeDuel(duelId) {
  state.duelId = duelId;
  if (state.duelUnsub) state.duelUnsub();
  state.duelUnsub = db.collection('duels').doc(duelId).onSnapshot(async (snap) => {
    const d = snap.data(); if (!d) return;
    if (d.status === 'waiting') return;
    $('duelStatus').textContent = 'Дуэль началась!';
    $('duelBoard').classList.remove('hidden');
    const meP1 = d.player1 === state.user.uid;
    $('myScore').textContent = meP1 ? d.p1Score || 0 : d.p2Score || 0;
    $('enemyScore').textContent = meP1 ? d.p2Score || 0 : d.p1Score || 0;
    if (!state.duelTimer) startDuelTimer(duelId);
    renderDuelQuestion();
    if (d.status === 'finished') {
      const myScore = meP1 ? d.p1Score || 0 : d.p2Score || 0;
      await addXP(myScore >= (meP1 ? d.p2Score : d.p1Score) ? 30 : 15);
      $('duelStatus').textContent = `Дуэль завершена. Твои очки: ${myScore}`;
      clearInterval(state.duelTimer); state.duelTimer = null;
    }
  });
}

function startDuelTimer(duelId) {
  state.duelStart = Date.now();
  let left = 45;
  $('duelTimer').textContent = left;
  state.duelTimer = setInterval(async () => {
    left -= 1; $('duelTimer').textContent = left;
    if (left <= 0) {
      clearInterval(state.duelTimer); state.duelTimer = null;
      await db.collection('duels').doc(duelId).update({ status: 'finished', endedAt: Date.now() });
    }
  }, 1000);
}

function renderDuelQuestion() {
  const word = state.words[Math.floor(Math.random() * state.words.length)];
  $('duelWordCard').textContent = word.german;
  const opts = [word.translation, ...state.words.sort(() => Math.random() - 0.5).slice(0, 3).map((w) => w.translation)].sort(() => Math.random() - 0.5);
  $('duelOptions').innerHTML = '';
  opts.forEach((o) => {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = o;
    btn.onclick = async () => {
      const duelRef = db.collection('duels').doc(state.duelId);
      const snap = await duelRef.get();
      const d = snap.data();
      const isP1 = d.player1 === state.user.uid;
      if (o === word.translation) {
        playSound(true);
        const field = isP1 ? 'p1Score' : 'p2Score';
        await duelRef.update({ [field]: (d[field] || 0) + 1, [`${field}Speed`]: Date.now() - state.duelStart });
      } else playSound(false);
      renderDuelQuestion();
    };
    $('duelOptions').appendChild(btn);
  });
}

function bindRealtimePanels() {
  db.collection('players').orderBy('xp', 'desc').limit(100).onSnapshot((snap) => {
    $('leaderboard').innerHTML = '';
    snap.forEach((d, i) => {
      const p = d.data();
      const li = document.createElement('li');
      li.textContent = `${i + 1}. ${p.name || 'Spieler'} — ${p.xp || 0} XP (${ranks[p.rankIndex || 0]?.name || 'Anfänger'})`;
      $('leaderboard').appendChild(li);
    });
  });

  db.collection('players').where('online', '==', true).onSnapshot((snap) => {
    $('onlineSummary').textContent = `Online: ${snap.size}`;
    $('onlineList').innerHTML = '';
    snap.forEach((d) => {
      const p = d.data();
      const row = document.createElement('div');
      row.textContent = `${p.name || 'Spieler'} | ${p.country || '-'} | ${String(p.device || '').slice(0, 30)}...`;
      $('onlineList').appendChild(row);
    });
  });

  setInterval(() => {
    if (!state.user) return;
    db.collection('players').doc(state.user.uid).update({
      online: true,
      lastActive: firebase.firestore.FieldValue.serverTimestamp(),
      activity: `screen:${document.visibilityState}`
    });
    analytics?.logEvent('heartbeat', { visibility: document.visibilityState });
  }, 20000);

  window.addEventListener('beforeunload', () => {
    if (state.user) db.collection('players').doc(state.user.uid).update({ online: false });
  });
}

(function particles() {
  const c = $('particles');
  const ctx = c.getContext('2d');
  const stars = Array.from({ length: 80 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 2 + 0.5, v: Math.random() * 0.001 + 0.0004 }));
  function resize() { c.width = innerWidth; c.height = innerHeight; }
  addEventListener('resize', resize); resize();
  (function loop() {
    ctx.clearRect(0, 0, c.width, c.height);
    stars.forEach((s) => {
      s.y += s.v; if (s.y > 1) s.y = 0;
      ctx.fillStyle = 'rgba(180,220,255,.8)';
      ctx.beginPath(); ctx.arc(s.x * c.width, s.y * c.height, s.r, 0, Math.PI * 2); ctx.fill();
    });
    requestAnimationFrame(loop);
  })();
})();
