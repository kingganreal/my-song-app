/* ============ IndexedDB ============ */
const DB_NAME = 'my-song-app';
const DB_VERSION = 1;
const STORE = 'tracks';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('order', 'order');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.order - b.order));
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(track) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(track);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ============ state ============ */
let tracks = [];
let currentIndex = -1;
let objectUrl = null;
let engine = 'audio';     // 'audio' | 'yt'
let repeatMode = 'off';   // off | all | one
let shuffleOn = false;
let ytPlayer = null;
let ytApiPromise = null;
let ytTick = null;

/* ============ dom ============ */
const $ = (id) => document.getElementById(id);

const audio = $('audio');
const playlistEl = $('playlist');
const emptyMsg = $('emptyMsg');
const trackCount = $('trackCount');
const fileInput = $('fileInput');
const folderInput = $('folderInput');

const art = $('art');
const artImg = $('artImg');
const ytWrap = $('ytWrap');
const npTitle = $('npTitle');
const npSub = $('npSub');

const addBtn = $('addBtn');
const sheetBackdrop = $('sheetBackdrop');
const modalBackdrop = $('modalBackdrop');
const modalTitle = $('modalTitle');
const modalName = $('modalName');
const modalUrl = $('modalUrl');
const modalHint = $('modalHint');
const modalCancel = $('modalCancel');
const modalSave = $('modalSave');

const shuffleAllBtn = $('shuffleAllBtn');
const seekBar = $('seekBar');
const curTimeEl = $('curTime');
const durTimeEl = $('durTime');
const playBtn = $('playBtn');
const prevBtn = $('prevBtn');
const nextBtn = $('nextBtn');
const shuffleBtn = $('shuffleBtn');
const repeatBtn = $('repeatBtn');
const volumeBar = $('volumeBar');
const toastEl = $('toast');

let modalMode = 'url';

/* ============ init ============ */
init();

async function init() {
  tracks = await dbGetAll();
  await migrateYouTubeUrls();
  renderPlaylist();

  const savedVolume = localStorage.getItem('volume');
  if (savedVolume !== null) {
    audio.volume = parseFloat(savedVolume);
    volumeBar.value = audio.volume;
  }
  setRangeFill(volumeBar);

  repeatMode = localStorage.getItem('repeatMode') || 'off';
  updateRepeatBtn();
  setRangeFill(seekBar);

  if (tracks.length) await requestPersistentStorage();
  updateStorageInfo();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// Older versions stored YouTube links as plain audio URLs, which can never play.
// Convert them in place so existing entries start working.
async function migrateYouTubeUrls() {
  let changed = 0;
  for (const t of tracks) {
    if (t.type !== 'url' || !t.url) continue;
    const id = parseYouTubeId(t.url);
    if (!id) continue;
    t.type = 'youtube';
    t.videoId = id;
    delete t.url;
    await dbPut(t);
    changed++;
  }
  if (changed) toast(`유튜브 링크 ${changed}개를 재생 가능하게 고쳤어요`);
}

/* ============ storage ============ */
// Without this the browser may evict the stored music when space runs low.
async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

async function updateStorageInfo() {
  let label = `${tracks.length}곡`;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage } = await navigator.storage.estimate();
      if (usage) label += ` · ${formatBytes(usage)}`;
    }
    if (navigator.storage && navigator.storage.persisted) {
      if (await navigator.storage.persisted()) label += ' · 보호됨';
    }
  } catch { /* estimate unsupported */ }
  trackCount.textContent = label;
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/* ============ ID3 tag reading ============ */
// Minimal ID3v2.2/2.3/2.4 reader — title, artist, album, cover art.
async function readID3(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null; // "ID3"

    const major = head[3];
    const tagSize = synchsafe(head, 6);
    const buf = new Uint8Array(await file.slice(0, 10 + tagSize).arrayBuffer());

    const idLen = major === 2 ? 3 : 4;
    const headerLen = major === 2 ? 6 : 10;
    const out = {};
    let p = 10;

    while (p + headerLen <= buf.length) {
      const id = String.fromCharCode(...buf.slice(p, p + idLen));
      if (!/^[A-Z0-9]+$/.test(id)) break; // padding reached

      let size;
      if (major === 2) size = (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5];
      else if (major === 4) size = synchsafe(buf, p + 4);
      else size = (buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7];

      if (size <= 0 || p + headerLen + size > buf.length) break;
      const body = buf.slice(p + headerLen, p + headerLen + size);

      if (id === 'TIT2' || id === 'TT2') out.title = textFrame(body);
      else if (id === 'TPE1' || id === 'TP1') out.artist = textFrame(body);
      else if (id === 'TALB' || id === 'TAL') out.album = textFrame(body);
      else if (id === 'APIC' || id === 'PIC') out.picture = pictureFrame(body, major);

      p += headerLen + size;
    }
    return out;
  } catch {
    return null;
  }
}

function synchsafe(arr, off) {
  return (arr[off] << 21) | (arr[off + 1] << 14) | (arr[off + 2] << 7) | arr[off + 3];
}

function textFrame(body) {
  const text = decodeText(body.slice(1), body[0]);
  return text.replace(/\0+$/, '').trim() || null;
}

function decodeText(bytes, enc) {
  try {
    if (enc === 1) return new TextDecoder('utf-16').decode(bytes);
    if (enc === 2) return new TextDecoder('utf-16be').decode(bytes);
    if (enc === 3) return new TextDecoder('utf-8').decode(bytes);
  } catch { /* fall through */ }

  // enc 0 is declared ISO-8859-1, but Korean files commonly store EUC-KR here.
  if (bytes.some((b) => b >= 0x80)) {
    try {
      const euckr = new TextDecoder('euc-kr').decode(bytes);
      if (/[가-힣]/.test(euckr)) return euckr;
    } catch { /* euc-kr unsupported */ }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch { /* not valid utf-8 */ }
  }
  try {
    return new TextDecoder('iso-8859-1').decode(bytes);
  } catch {
    return '';
  }
}

function pictureFrame(body, major) {
  const enc = body[0];
  let p = 1;
  let mime;

  if (major === 2) {
    // v2.2 PIC uses a 3-character format code instead of a MIME string
    const fmt = String.fromCharCode(...body.slice(1, 4)).toLowerCase();
    mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
    p = 4;
  } else {
    const end = body.indexOf(0, p);
    if (end < 0) return null;
    mime = String.fromCharCode(...body.slice(p, end)) || 'image/jpeg';
    p = end + 1;
  }

  p += 1; // picture type byte

  // description, terminated by 1 or 2 nulls depending on encoding
  if (enc === 1 || enc === 2) {
    while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < body.length && body[p] !== 0) p += 1;
    p += 1;
  }

  if (p >= body.length) return null;
  return new Blob([body.slice(p)], { type: mime });
}

/* ============ cover art urls ============ */
const artUrlCache = new Map();

function artUrlFor(track) {
  if (!track.picture) return null;
  if (!artUrlCache.has(track.id)) {
    artUrlCache.set(track.id, URL.createObjectURL(track.picture));
  }
  return artUrlCache.get(track.id);
}

function releaseArtUrl(id) {
  if (artUrlCache.has(id)) {
    URL.revokeObjectURL(artUrlCache.get(id));
    artUrlCache.delete(id);
  }
}

/* ============ add: sheet ============ */
addBtn.addEventListener('click', () => openBackdrop(sheetBackdrop));

sheetBackdrop.addEventListener('click', (e) => {
  if (e.target === sheetBackdrop) closeBackdrop(sheetBackdrop);
});

document.querySelectorAll('.sheet-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.add;
    closeBackdrop(sheetBackdrop);
    if (kind === 'file') {
      fileInput.click();
    } else if (kind === 'folder') {
      folderInput.click();
    } else {
      setTimeout(() => openModal(kind), 180);
    }
  });
});

function openBackdrop(el) { el.classList.add('open'); }
function closeBackdrop(el) { el.classList.remove('open'); }

/* ============ add: file ============ */
fileInput.addEventListener('change', () => importFiles(fileInput));
folderInput.addEventListener('change', () => importFiles(folderInput));

const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|opus|wma)$/i;

async function importFiles(input) {
  const picked = Array.from(input.files || []);
  input.value = '';

  const files = picked.filter((f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
  if (!files.length) {
    if (picked.length) toast('음악 파일을 찾지 못했어요');
    return;
  }

  await requestPersistentStorage();

  let order = nextOrder();
  let done = 0;

  for (const file of files) {
    toast(`가져오는 중… ${done + 1}/${files.length}`);
    const tag = await readID3(file);

    const track = {
      id: crypto.randomUUID(),
      name: (tag && tag.title) || file.name.replace(/\.[^/.]+$/, ''),
      artist: (tag && tag.artist) || null,
      album: (tag && tag.album) || null,
      picture: (tag && tag.picture) || null,
      type: 'file',
      blob: file,
      order: order++,
    };

    await dbPut(track);
    tracks.push(track);
    done++;

    // keep the UI responsive on large folders
    if (done % 10 === 0) {
      renderPlaylist();
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  renderPlaylist();
  updateStorageInfo();
  toast(`${done}곡 추가했어요`);
}

function nextOrder() {
  return tracks.length ? Math.max(...tracks.map((t) => t.order)) + 1 : 0;
}

/* ============ add: modal (url / youtube) ============ */
function openModal(mode) {
  modalMode = mode;
  modalName.value = '';
  modalUrl.value = '';
  if (mode === 'yt') {
    modalTitle.textContent = '유튜브 링크 추가';
    modalUrl.placeholder = 'https://music.youtube.com/watch?v=...';
    modalHint.textContent =
      '유튜브 공식 플레이어로 재생됩니다. 인터넷이 필요하고, 화면을 끄면 재생이 멈춥니다.';
  } else {
    modalTitle.textContent = '오디오 주소 추가';
    modalUrl.placeholder = 'https://example.com/song.mp3';
    modalHint.textContent = 'mp3 등 오디오 파일을 직접 가리키는 주소여야 합니다.';
  }
  openBackdrop(modalBackdrop);
  setTimeout(() => modalUrl.focus(), 260);
}

modalCancel.addEventListener('click', () => closeBackdrop(modalBackdrop));

modalBackdrop.addEventListener('click', (e) => {
  if (e.target === modalBackdrop) closeBackdrop(modalBackdrop);
});

modalUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') modalSave.click();
});

modalSave.addEventListener('click', async () => {
  const raw = modalUrl.value.trim();
  if (!raw) return;

  const ytId = parseYouTubeId(raw);
  let track;

  if (modalMode === 'yt' || ytId) {
    if (!ytId) {
      toast('유튜브 링크를 인식하지 못했어요');
      return;
    }
    track = {
      id: crypto.randomUUID(),
      name: modalName.value.trim() || '유튜브 곡',
      type: 'youtube',
      videoId: ytId,
      order: nextOrder(),
    };
  } else {
    let name = modalName.value.trim();
    if (!name) {
      try {
        name = decodeURIComponent(raw.split('/').pop().split('?')[0]) || raw;
      } catch {
        name = raw;
      }
    }
    track = { id: crypto.randomUUID(), name, type: 'url', url: raw, order: nextOrder() };
  }

  await dbPut(track);
  tracks.push(track);
  closeBackdrop(modalBackdrop);
  renderPlaylist();
  toast('추가했어요');
});

function parseYouTubeId(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    return /^[\w-]{11}$/.test(input) ? input : null;
  }
  const host = u.hostname.replace(/^www\./, '');
  const isYt =
    host === 'youtube.com' || host === 'm.youtube.com' ||
    host === 'music.youtube.com' || host === 'youtu.be' ||
    host === 'youtube-nocookie.com';
  if (!isYt) return null;

  if (host === 'youtu.be') return validId(u.pathname.slice(1));

  const v = u.searchParams.get('v');
  if (v) return validId(v);

  const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/);
  if (m) return validId(m[2]);

  return null;
}

function validId(id) {
  return /^[\w-]{11}$/.test(id) ? id : null;
}

/* ============ render ============ */
const KIND = {
  file: { icon: '🎵', label: '내 파일' },
  url: { icon: '🔗', label: '링크' },
  youtube: { icon: '▶️', label: '유튜브' },
};

function renderPlaylist() {
  playlistEl.innerHTML = '';
  updateStorageInfo();
  emptyMsg.classList.toggle('hidden', tracks.length > 0);

  tracks.forEach((track, idx) => {
    const kind = KIND[track.type] || KIND.url;
    const isCur = idx === currentIndex;

    const li = document.createElement('li');
    li.className = 'track' + (isCur ? ' playing' : '') + (isCur && isPlaying() ? ' is-playing' : '');

    const main = document.createElement('div');
    main.className = 'track-main';

    const ico = document.createElement('div');
    ico.className = 'tk-ico';
    const cover = artUrlFor(track);
    if (cover) {
      ico.classList.add('has-art');
      ico.style.backgroundImage = `url("${cover}")`;
    }
    const emoji = document.createElement('span');
    emoji.className = 'tk-ico-emoji';
    emoji.textContent = kind.icon;
    const eq = document.createElement('div');
    eq.className = 'eq';
    eq.innerHTML = '<i></i><i></i><i></i>';
    ico.append(emoji, eq);

    const body = document.createElement('div');
    body.className = 'tk-body';
    const name = document.createElement('div');
    name.className = 'tk-name';
    name.textContent = track.name;
    const sub = document.createElement('div');
    sub.className = 'tk-sub';
    sub.textContent = isCur ? '재생 중' : (track.artist || kind.label);
    body.append(name, sub);

    main.append(ico, body);
    main.addEventListener('click', () => playIndex(idx));

    const actions = document.createElement('div');
    actions.className = 'tk-actions';

    const up = document.createElement('button');
    up.textContent = '⌃';
    up.setAttribute('aria-label', '위로');
    up.addEventListener('click', (e) => { e.stopPropagation(); moveTrack(idx, -1); });

    const down = document.createElement('button');
    down.textContent = '⌄';
    down.setAttribute('aria-label', '아래로');
    down.addEventListener('click', (e) => { e.stopPropagation(); moveTrack(idx, 1); });

    const del = document.createElement('button');
    del.textContent = '✕';
    del.setAttribute('aria-label', '삭제');
    del.addEventListener('click', (e) => { e.stopPropagation(); removeTrack(idx); });

    actions.append(up, down, del);
    li.append(main, actions);
    playlistEl.appendChild(li);
  });
}

async function moveTrack(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= tracks.length) return;
  [tracks[idx], tracks[j]] = [tracks[j], tracks[idx]];
  tracks.forEach((t, i) => { t.order = i; });
  if (currentIndex === idx) currentIndex = j;
  else if (currentIndex === j) currentIndex = idx;
  await Promise.all(tracks.map(dbPut));
  renderPlaylist();
}

async function removeTrack(idx) {
  const track = tracks[idx];
  if (!confirm(`"${track.name}"을(를) 삭제할까요?`)) return;

  await dbDelete(track.id);
  releaseArtUrl(track.id);
  tracks.splice(idx, 1);
  tracks.forEach((t, i) => { t.order = i; });
  await Promise.all(tracks.map(dbPut));

  if (idx === currentIndex) {
    stopAll();
    currentIndex = -1;
    setNowPlaying(null);
  } else if (idx < currentIndex) {
    currentIndex--;
  }
  renderPlaylist();
  toast('삭제했어요');
}

/* ============ youtube engine ============ */
function loadYouTubeApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve();
    const timer = setTimeout(() => reject(new Error('timeout')), 10000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { clearTimeout(timer); reject(new Error('blocked')); };
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

async function createYtPlayer() {
  await loadYouTubeApi();
  if (ytPlayer) return ytPlayer;

  return new Promise((resolve) => {
    ytPlayer = new YT.Player('ytPlayer', {
      width: '100%',
      height: '100%',
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => resolve(ytPlayer),
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED) handleEnded();
          updatePlayBtn();
          syncRowState();
        },
        onError: () => {
          npSub.textContent = '이 영상은 외부 재생이 막혀 있어요';
          toast('이 영상은 임베드가 차단되어 재생할 수 없어요');
        },
      },
    });
  });
}

function startYtTick() {
  stopYtTick();
  ytTick = setInterval(() => {
    if (!ytPlayer || engine !== 'yt' || !ytPlayer.getDuration) return;
    const dur = ytPlayer.getDuration() || 0;
    const cur = ytPlayer.getCurrentTime() || 0;
    seekBar.max = dur || 100;
    if (!seekBar.matches(':active')) {
      seekBar.value = cur;
      setRangeFill(seekBar);
    }
    curTimeEl.textContent = formatTime(cur);
    durTimeEl.textContent = formatTime(dur);
    updatePlayBtn();
  }, 500);
}

function stopYtTick() {
  if (ytTick) clearInterval(ytTick);
  ytTick = null;
}

/* ============ engine-neutral ============ */
function isPlaying() {
  if (currentIndex === -1) return false;
  if (engine === 'yt') {
    return !!(ytPlayer && ytPlayer.getPlayerState && ytPlayer.getPlayerState() === 1);
  }
  return !audio.paused;
}

function stopAll() {
  audio.pause();
  audio.removeAttribute('src');
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
  stopYtTick();
  art.classList.remove('yt', 'active', 'spinning');
  seekBar.value = 0;
  setRangeFill(seekBar);
  curTimeEl.textContent = '0:00';
  durTimeEl.textContent = '0:00';
  updatePlayBtn();
}

function setNowPlaying(track) {
  if (!track) {
    npTitle.textContent = '재생 중인 곡 없음';
    npSub.textContent = tracks.length ? '곡을 눌러 재생하세요' : '위 + 를 눌러 음악을 추가하세요';
    showCover(null);
    return;
  }
  npTitle.textContent = track.name;
  npSub.textContent = track.artist || (KIND[track.type] || KIND.url).label;
  showCover(artUrlFor(track));
}

function showCover(url) {
  if (url) {
    artImg.src = url;
    art.classList.add('has-art');
  } else {
    artImg.removeAttribute('src');
    art.classList.remove('has-art');
  }
}

/* ============ playback ============ */
async function playIndex(idx) {
  if (idx < 0 || idx >= tracks.length) return;
  currentIndex = idx;
  const track = tracks[idx];

  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }

  setNowPlaying(track);
  art.classList.add('active');

  if (track.type === 'youtube') {
    audio.pause();
    audio.removeAttribute('src');
    engine = 'yt';
    art.classList.add('yt');
    art.classList.remove('spinning');
    try {
      const player = await createYtPlayer();
      player.loadVideoById(track.videoId);
      player.setVolume(Math.round(parseFloat(volumeBar.value) * 100));
      startYtTick();
    } catch {
      npSub.textContent = '유튜브를 불러오지 못했어요';
      toast('유튜브 플레이어를 불러오지 못했어요 (인터넷 확인)');
    }
  } else {
    if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
    stopYtTick();
    art.classList.remove('yt');
    art.classList.add('spinning');
    engine = 'audio';

    if (track.type === 'file') {
      objectUrl = URL.createObjectURL(track.blob);
      audio.src = objectUrl;
    } else {
      audio.src = track.url;
    }
    audio.play().catch(() => {});
  }

  updateMediaSession(track);
  updatePlayBtn();
  renderPlaylist();
}

playBtn.addEventListener('click', () => {
  if (currentIndex === -1) {
    if (tracks.length) playIndex(0);
    return;
  }
  if (engine === 'yt') {
    if (!ytPlayer) return;
    if (isPlaying()) ytPlayer.pauseVideo();
    else ytPlayer.playVideo();
    setTimeout(() => { updatePlayBtn(); syncRowState(); }, 180);
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
});

audio.addEventListener('play', () => { updatePlayBtn(); syncRowState(); });
audio.addEventListener('pause', () => { updatePlayBtn(); syncRowState(); });

audio.addEventListener('error', () => {
  if (engine !== 'audio' || currentIndex === -1) return;
  npSub.textContent = '재생할 수 없는 주소예요';
  toast('이 곡을 재생할 수 없어요');
});

function updatePlayBtn() {
  const playing = isPlaying();
  playBtn.textContent = playing ? '❚❚' : '▶';
  playBtn.classList.toggle('pause', playing);
  art.classList.toggle('spinning', playing && engine === 'audio');
}

function syncRowState() {
  const rows = playlistEl.querySelectorAll('.track');
  rows.forEach((row, i) => {
    row.classList.toggle('is-playing', i === currentIndex && isPlaying());
  });
}

prevBtn.addEventListener('click', () => {
  if (!tracks.length) return;
  const cur = engine === 'yt' && ytPlayer && ytPlayer.getCurrentTime
    ? ytPlayer.getCurrentTime()
    : audio.currentTime;
  if (cur > 3) { seekTo(0); return; }
  goRelative(-1);
});

nextBtn.addEventListener('click', () => goRelative(1));

function goRelative(dir) {
  if (!tracks.length) return;
  if (shuffleOn) { playIndex(pickShuffleIndex()); return; }
  let idx = currentIndex + dir;
  if (idx < 0) idx = tracks.length - 1;
  if (idx >= tracks.length) idx = 0;
  playIndex(idx);
}

audio.addEventListener('ended', handleEnded);

function handleEnded() {
  if (repeatMode === 'one') {
    seekTo(0);
    if (engine === 'yt') ytPlayer.playVideo();
    else audio.play().catch(() => {});
    return;
  }
  if (shuffleOn) { playIndex(pickShuffleIndex()); return; }
  if (currentIndex === tracks.length - 1 && repeatMode !== 'all') {
    updatePlayBtn();
    syncRowState();
    return;
  }
  goRelative(1);
}

/* ============ shuffle / repeat ============ */
shuffleBtn.addEventListener('click', () => {
  shuffleOn = !shuffleOn;
  shuffleBtn.classList.toggle('active', shuffleOn);
  toast(shuffleOn ? '셔플 켜짐' : '셔플 꺼짐');
});

shuffleAllBtn.addEventListener('click', () => {
  if (!tracks.length) return;
  shuffleOn = true;
  shuffleBtn.classList.add('active');
  playIndex(pickShuffleIndex());
});

function pickShuffleIndex() {
  if (tracks.length <= 1) return 0;
  let idx;
  do { idx = Math.floor(Math.random() * tracks.length); } while (idx === currentIndex);
  return idx;
}

repeatBtn.addEventListener('click', () => {
  repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
  localStorage.setItem('repeatMode', repeatMode);
  updateRepeatBtn();
  toast(repeatMode === 'off' ? '반복 꺼짐' : repeatMode === 'all' ? '전체 반복' : '한 곡 반복');
});

function updateRepeatBtn() {
  repeatBtn.classList.toggle('active', repeatMode !== 'off');
  repeatBtn.textContent = repeatMode === 'one' ? '🔂' : '🔁';
}

/* ============ seek / time ============ */
audio.addEventListener('loadedmetadata', () => {
  if (engine !== 'audio') return;
  seekBar.max = audio.duration || 0;
  durTimeEl.textContent = formatTime(audio.duration);
  setRangeFill(seekBar);
});

audio.addEventListener('timeupdate', () => {
  if (engine !== 'audio') return;
  if (!seekBar.matches(':active')) {
    seekBar.value = audio.currentTime;
    setRangeFill(seekBar);
  }
  curTimeEl.textContent = formatTime(audio.currentTime);
});

seekBar.addEventListener('input', () => {
  setRangeFill(seekBar);
  seekTo(parseFloat(seekBar.value));
});

function seekTo(t) {
  if (engine === 'yt' && ytPlayer && ytPlayer.seekTo) ytPlayer.seekTo(t, true);
  else audio.currentTime = t;
  seekBar.value = t;
  setRangeFill(seekBar);
}

function setRangeFill(el) {
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 1;
  const val = parseFloat(el.value) || 0;
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--pct', pct + '%');
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/* ============ volume ============ */
volumeBar.addEventListener('input', () => {
  const v = parseFloat(volumeBar.value);
  audio.volume = v;
  if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(Math.round(v * 100));
  localStorage.setItem('volume', v);
  setRangeFill(volumeBar);
});

/* ============ media session ============ */
function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;

  const meta = {
    title: track.name,
    artist: track.artist || '내 노래',
  };
  if (track.album) meta.album = track.album;

  const cover = artUrlFor(track);
  if (cover) {
    meta.artwork = [{ src: cover, sizes: '512x512', type: track.picture.type }];
  }

  navigator.mediaSession.metadata = new MediaMetadata(meta);
  navigator.mediaSession.setActionHandler('play', () => playBtn.click());
  navigator.mediaSession.setActionHandler('pause', () => playBtn.click());
  navigator.mediaSession.setActionHandler('previoustrack', () => prevBtn.click());
  navigator.mediaSession.setActionHandler('nexttrack', () => goRelative(1));
}

/* ============ toast ============ */
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}
