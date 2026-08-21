'use strict';

const FORMAT = 'audio-playlist';
const VERSION = 2;
const DB_NAME = 'audio-playlist-db';
const DB_VERSION = 1;
const DB_STORE = 'current';
const LOCAL_KEY = 'audio-playlist-current-v1';

const state = {
  playlist: {
    id: crypto.randomUUID(),
    name: 'My Playlist',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  settings: {
    repeatMode: 'off',
    loopStart: null,
    loopEnd: null,
    randomWithinLoop: false
  },
  assets: new Map(),
  tracks: [],
  selectedTrackId: null,
  objectUrls: new Map(),
  audioLoadedTrackId: null,
  audioLoadedAssetId: null,
  nextPreloadTrackId: null,
  nextPreloadAssetId: null,
  preloadAudio: null,
  previewingTrim: false,
  previewToken: 0
};

const $ = (id) => document.getElementById(id);
const fileInput = $('fileInput');
const trackList = $('trackList');
const trackEmpty = $('trackEmpty');
const audioPlayer = $('audioPlayer');
const seekRange = $('seekRange');
const positionInput = $('positionInput');
const durationOutput = $('durationOutput');
const nowPlaying = $('nowPlaying');
const trimStartInput = $('trimStartInput');
const trimEndInput = $('trimEndInput');
const repeatMode = $('repeatMode');
const statusEl = $('status');

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#b00020' : '#333';
}

function roundTime(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value / 0.05) * 0.05;
}

function clampTime(value, duration) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, value), Math.max(0, duration));
}

function createAssetFromFile(file) {
  const id = crypto.randomUUID();
  return {
    id,
    name: file.name,
    mimeType: file.type || guessMimeType(file.name),
    size: file.size,
    file,
    sourcePath: null
  };
}

function guessMimeType(name) {
  const ext = name.toLowerCase().split('.').pop();
  return ({
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    aac: 'audio/aac',
    m4a: 'audio/mp4'
  })[ext] || 'application/octet-stream';
}

function createTrack(asset) {
  return {
    id: crypto.randomUUID(),
    assetId: asset.id,
    trim: { start: 0, end: null },
    weight: 1
  };
}

function getSelectedTrack() {
  return state.tracks.find(t => t.id === state.selectedTrackId) || null;
}

function getSelectedAsset() {
  const track = getSelectedTrack();
  return track ? state.assets.get(track.assetId) : null;
}

function formatSeconds(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

function normalizeLoopSettings() {
  const count = state.tracks.length;
  if (count === 0) {
    state.settings.loopStart = null;
    state.settings.loopEnd = null;
    return;
  }
  if (state.settings.loopStart == null || !Number.isInteger(state.settings.loopStart)) state.settings.loopStart = count - 1;
  if (state.settings.loopEnd == null || !Number.isInteger(state.settings.loopEnd)) state.settings.loopEnd = state.settings.loopStart;
  state.settings.loopStart = Math.max(0, Math.min(state.settings.loopStart, count - 1));
  state.settings.loopEnd = Math.max(state.settings.loopStart, Math.min(state.settings.loopEnd, count - 1));
  state.settings.randomWithinLoop = Boolean(state.settings.randomWithinLoop);
}

function updateLoopUI() {
  const count = state.tracks.length;
  const loopStartSelect = $('loopStartSelect');
  const loopEndSelect = $('loopEndSelect');
  if (!loopStartSelect || !loopEndSelect) return;
  loopStartSelect.innerHTML = '';
  loopEndSelect.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const asset = state.assets.get(state.tracks[i].assetId);
    const label = `${i + 1}. ${asset?.name || '(missing)'}`;
    const a = new Option(label, String(i));
    const b = new Option(label, String(i));
    loopStartSelect.appendChild(a);
    loopEndSelect.appendChild(b);
  }
  if (!count) {
    loopStartSelect.disabled = true;
    loopEndSelect.disabled = true;
    $('randomWithinLoop').disabled = true;
    return;
  }
  normalizeLoopSettings();
  loopStartSelect.value = String(state.settings.loopStart);
  loopEndSelect.value = String(state.settings.loopEnd);
  loopStartSelect.disabled = state.settings.repeatMode !== 'loop';
  loopEndSelect.disabled = state.settings.repeatMode !== 'loop';
  $('randomWithinLoop').disabled = state.settings.repeatMode !== 'loop';
  $('randomWithinLoop').checked = Boolean(state.settings.randomWithinLoop);
}

function getLoopRange() {
  normalizeLoopSettings();
  if (!state.tracks.length) return null;
  return { start: state.settings.loopStart, end: state.settings.loopEnd };
}

function weightedRandomIndex(indices) {
  const positive = indices.map(i => ({ index: i, weight: Number(state.tracks[i].weight) }))
    .filter(x => Number.isFinite(x.weight) && x.weight >= 0);
  const total = positive.reduce((sum, x) => sum + x.weight, 0);
  if (total <= 0) return indices[Math.floor(Math.random() * indices.length)];
  let target = Math.random() * total;
  for (const item of positive) {
    target -= item.weight;
    if (target < 0) return item.index;
  }
  return positive[positive.length - 1].index;
}

function chooseLoopIndex() {
  const range = getLoopRange();
  if (!range) return -1;
  const indices = [];
  for (let i = range.start; i <= range.end; i++) indices.push(i);
  if (!state.settings.randomWithinLoop || indices.length === 0) return indices[0];
  return weightedRandomIndex(indices);
}

function chooseNextIndex(currentIndex) {
  let mode = state.settings.repeatMode;
  if (mode === 'one') mode = 'loop'; // 古い内部値への保険

  if (mode === 'loop') {
    const range = getLoopRange();
    if (!range) return currentIndex + 1 < state.tracks.length ? currentIndex + 1 : -1;
    // ループ区間へ入る前は通常の再生順を維持する。
    // これにより [1 -> 2 -> (3 -> 4 -> 5) -> ...] のように、
    // 区間開始前の曲を飛ばさず再生できる。
    if (currentIndex < range.start) {
      return currentIndex + 1 < state.tracks.length ? currentIndex + 1 : -1;
    }
    if (currentIndex >= range.start && currentIndex <= range.end) {
      if (state.settings.randomWithinLoop) return chooseLoopIndex();
      return currentIndex < range.end ? currentIndex + 1 : range.start;
    }
    return currentIndex + 1 < state.tracks.length ? currentIndex + 1 : -1;
  }

  const nextIndex = currentIndex + 1;
  if (nextIndex < state.tracks.length) return nextIndex;
  return mode === 'list' ? 0 : -1;
}

function revokeAssetUrl(assetId) {
  const url = state.objectUrls.get(assetId);
  if (url) {
    URL.revokeObjectURL(url);
    state.objectUrls.delete(assetId);
  }
}

function getAssetUrl(asset) {
  if (!asset || !asset.file) return null;
  if (!state.objectUrls.has(asset.id)) {
    state.objectUrls.set(asset.id, URL.createObjectURL(asset.file));
  }
  return state.objectUrls.get(asset.id);
}

function renderTracks() {
  trackList.innerHTML = '';
  trackEmpty.hidden = state.tracks.length !== 0;

  state.tracks.forEach((track, index) => {
    const asset = state.assets.get(track.assetId);
    const li = document.createElement('li');
    li.className = 'track-item' + (track.id === state.selectedTrackId ? ' selected' : '');
    li.dataset.trackId = track.id;
    li.draggable = true;

    const num = document.createElement('div');
    num.className = 'track-number';
    num.textContent = String(index + 1);

    const main = document.createElement('div');
    main.className = 'track-main';

    const name = document.createElement('div');
    name.className = 'track-name';
    name.textContent = asset?.name || '(missing file)';
    name.title = asset?.name || '(missing file)';

    const detail = document.createElement('div');
    detail.className = 'track-detail';
    const end = track.trim.end == null ? 'end' : formatSeconds(track.trim.end);
    detail.textContent = `${formatSeconds(track.trim.start)} - ${end}s`;
    main.append(name, detail);

    const weightWrap = document.createElement('label');
    weightWrap.className = 'weight-wrap';
    weightWrap.textContent = '重み';
    const weightInput = document.createElement('input');
    weightInput.type = 'number';
    weightInput.min = '0';
    weightInput.step = 'any';
    weightInput.value = Number.isFinite(track.weight) ? String(track.weight) : '1';
    weightInput.title = '区間内ランダム時の出現重み（0以上）';
    weightInput.addEventListener('click', e => e.stopPropagation());
    weightInput.addEventListener('change', () => {
      const value = Number(weightInput.value);
      if (!Number.isFinite(value) || value < 0) {
        weightInput.value = String(track.weight ?? 1);
        setStatus('重みには0以上の数値を指定してください。', true);
        return;
      }
      track.weight = value;
      state.playlist.updatedAt = new Date().toISOString();
    });
    weightWrap.appendChild(weightInput);

    li.append(num, main, weightWrap);
    li.addEventListener('click', () => selectTrack(track.id));
    li.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', track.id));
    li.addEventListener('dragover', e => e.preventDefault());
    li.addEventListener('drop', e => {
      e.preventDefault();
      const fromId = e.dataTransfer.getData('text/plain');
      if (fromId && fromId !== track.id) reorderTrack(fromId, track.id);
    });
    trackList.appendChild(li);
  });

  updateTrackButtons();
  updateLoopUI();
}
function updateTrackButtons() {
  const index = state.tracks.findIndex(t => t.id === state.selectedTrackId);
  $('removeTrackBtn').disabled = index < 0;
  $('moveUpBtn').disabled = index <= 0;
  $('moveDownBtn').disabled = index < 0 || index >= state.tracks.length - 1;
}

async function selectTrack(trackId) {
  if (!state.tracks.some(t => t.id === trackId)) return;
  state.selectedTrackId = trackId;
  state.nextPreloadTrackId = null;
  state.nextPreloadAssetId = null;
  state.previewingTrim = false;
  state.previewToken++;
  stopPreview();
  renderTracks();
  await loadSelectedTrack();
}

async function loadSelectedTrack() {
  const track = getSelectedTrack();
  const asset = getSelectedAsset();
  if (!track || !asset?.file) {
    clearPlayer();
    updateEditingControls(false);
    return;
  }

  updateEditingControls(false);
  nowPlaying.textContent = asset.name;
  setStatus(`「${asset.name}」を読み込み中...`);

  audioPlayer.pause();

  // 同じアセットを別trackとして続けて使う場合は、音声データを再読み込みせず流用する。
  const canReuseLoadedAsset = state.audioLoadedAssetId === asset.id && audioPlayer.readyState >= HTMLMediaElement.HAVE_METADATA;
  if (!canReuseLoadedAsset) {
    audioPlayer.removeAttribute('src');
    audioPlayer.load();
    state.audioLoadedTrackId = null;
    state.audioLoadedAssetId = null;

    const url = getAssetUrl(asset);
    audioPlayer.src = url;
    audioPlayer.load();

    try {
      await waitForCanPlay(audioPlayer);
    } catch (err) {
      console.error(err);
      setStatus('音声を読み込めませんでした。このブラウザが形式を再生できるか確認してください。', true);
      updateEditingControls(false);
      return;
    }
  }

  state.audioLoadedTrackId = track.id;
  state.audioLoadedAssetId = asset.id;
  const duration = Number.isFinite(audioPlayer.duration) ? audioPlayer.duration : 0;
  if (track.trim.end == null || track.trim.end > duration) track.trim.end = roundTime(duration);
  track.trim.start = clampTime(roundTime(track.trim.start), duration);
  track.trim.end = clampTime(roundTime(track.trim.end), duration);
  if (track.trim.end < track.trim.start) track.trim.end = track.trim.start;

  audioPlayer.currentTime = track.trim.start;
  updatePlayerTimeUI();
  updateTrimUI();
  updateEditingControls(true);
  setStatus('読み込み完了');
  prepareNextTrack();
}

function waitForCanPlay(audio) {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = () => cleanup(resolve);
    const onError = () => cleanup(() => reject(new Error('audio load error')));
    const cleanup = (done) => {
      audio.removeEventListener('loadedmetadata', onReady);
      audio.removeEventListener('canplay', onReady);
      audio.removeEventListener('error', onError);
      done();
    };
    audio.addEventListener('loadedmetadata', onReady, { once: true });
    audio.addEventListener('canplay', onReady, { once: true });
    audio.addEventListener('error', onError, { once: true });
  });
}

function clearPlayer() {
  audioPlayer.pause();
  audioPlayer.removeAttribute('src');
  audioPlayer.load();
  state.audioLoadedTrackId = null;
  state.audioLoadedAssetId = null;
  state.nextPreloadTrackId = null;
  state.nextPreloadAssetId = null;
  nowPlaying.textContent = '選択されていません';
  seekRange.value = 0;
  seekRange.max = 0;
  positionInput.value = '0.00';
  durationOutput.textContent = '0.00';
  updateEditingControls(false);
}

function updateEditingControls(enabled) {
  const ids = ['playBtn','pauseBtn','stopBtn','previewTrimBtn','stopPreviewBtn','setStartBtn','setEndBtn','fullRangeBtn'];
  ids.forEach(id => $(id).disabled = !enabled);
}

function updatePlayerTimeUI() {
  const duration = Number.isFinite(audioPlayer.duration) ? audioPlayer.duration : 0;
  const current = Number.isFinite(audioPlayer.currentTime) ? audioPlayer.currentTime : 0;
  seekRange.max = duration.toFixed(2);
  seekRange.value = clampTime(roundTime(current), duration).toFixed(2);
  positionInput.value = roundTime(current).toFixed(2);
  durationOutput.textContent = duration.toFixed(2);
}

function updateTrimUI() {
  const track = getSelectedTrack();
  if (!track) {
    trimStartInput.value = '0.00';
    trimEndInput.value = '0.00';
    return;
  }
  trimStartInput.value = formatSeconds(track.trim.start);
  trimEndInput.value = formatSeconds(track.trim.end ?? audioPlayer.duration ?? 0);
  renderTracks();
}

function setCurrentPosition(value) {
  const duration = Number.isFinite(audioPlayer.duration) ? audioPlayer.duration : 0;
  const position = clampTime(roundTime(Number(value)), duration);
  audioPlayer.currentTime = position;
  updatePlayerTimeUI();
  enforceTrimDuringPlayback();
}

function setTrimStart(value) {
  const track = getSelectedTrack();
  if (!track) return;
  const duration = Number.isFinite(audioPlayer.duration) ? audioPlayer.duration : 0;
  let start = clampTime(roundTime(Number(value)), duration);
  const end = track.trim.end ?? duration;
  if (start > end) start = end;
  track.trim.start = start;
  if (audioPlayer.currentTime < start) audioPlayer.currentTime = start;
  updateTrimUI();
}

function setTrimEnd(value) {
  const track = getSelectedTrack();
  if (!track) return;
  const duration = Number.isFinite(audioPlayer.duration) ? audioPlayer.duration : 0;
  let end = clampTime(roundTime(Number(value)), duration);
  if (end < track.trim.start) end = track.trim.start;
  track.trim.end = end;
  if (audioPlayer.currentTime > end) audioPlayer.currentTime = end;
  updateTrimUI();
}

function playTrack() {
  if (!getSelectedTrack()) return;
  state.previewingTrim = false;
  state.previewToken++;
  audioPlayer.play().catch(err => console.error(err));
}

function stopAudio() {
  state.previewingTrim = false;
  state.previewToken++;
  audioPlayer.pause();
  const track = getSelectedTrack();
  if (track) audioPlayer.currentTime = track.trim.start;
  updatePlayerTimeUI();
}

function previewTrim() {
  const track = getSelectedTrack();
  if (!track) return;
  const start = track.trim.start;
  const end = track.trim.end ?? audioPlayer.duration;
  if (end <= start) return;
  state.previewingTrim = true;
  const token = ++state.previewToken;
  audioPlayer.currentTime = start;
  audioPlayer.play().catch(err => console.error(err));
  const stopWhenDone = () => {
    if (!state.previewingTrim || token !== state.previewToken) return;
    if (audioPlayer.currentTime >= end - 0.02 || audioPlayer.ended) {
      audioPlayer.pause();
      audioPlayer.currentTime = start;
      state.previewingTrim = false;
      state.previewToken++;
      updatePlayerTimeUI();
    }
  };
  audioPlayer.addEventListener('timeupdate', stopWhenDone);
  const cleanup = () => audioPlayer.removeEventListener('timeupdate', stopWhenDone);
  setTimeout(cleanup, Math.max(1000, (end - start + 1) * 1000));
}

function stopPreview() {
  if (!state.previewingTrim) return;
  state.previewingTrim = false;
  state.previewToken++;
  audioPlayer.pause();
}

function enforceTrimDuringPlayback() {
  const track = getSelectedTrack();
  if (!track || state.audioLoadedTrackId !== track.id) return;
  const end = track.trim.end ?? audioPlayer.duration;
  if (Number.isFinite(end) && audioPlayer.currentTime >= end) {
    // trim終端を通常の曲終了として扱い、設定に応じて次曲へ進める。
    audioPlayer.pause();
    audioPlayer.currentTime = end;
    updatePlayerTimeUI();
    playNextAfterEnded();
  }
}

function playNextAfterEnded() {
  const currentIndex = state.tracks.findIndex(t => t.id === state.selectedTrackId);
  if (currentIndex < 0 || state.tracks.length === 0) return;

  let nextIndex = -1;
  if (state.nextPreloadTrackId) {
    nextIndex = state.tracks.findIndex(t => t.id === state.nextPreloadTrackId);
  }
  if (nextIndex < 0) nextIndex = chooseNextIndex(currentIndex);

  if (nextIndex < 0) {
    audioPlayer.pause();
    return;
  }

  const currentTrack = state.tracks[currentIndex];
  const nextTrack = state.tracks[nextIndex];
  const sameAsset = currentTrack.assetId === nextTrack.assetId && state.audioLoadedAssetId === currentTrack.assetId;

  state.nextPreloadTrackId = null;
  state.nextPreloadAssetId = null;

  if (sameAsset) {
    state.selectedTrackId = nextTrack.id;
    renderTracks();
    audioPlayer.currentTime = nextTrack.trim.start;
    state.audioLoadedTrackId = nextTrack.id;
    updateTrimUI();
    updatePlayerTimeUI();
    prepareNextTrack();
    audioPlayer.play().catch(console.error);
    return;
  }

  selectTrack(nextTrack.id).then(() => audioPlayer.play().catch(console.error));
}

function prepareNextTrack() {
  if (!state.tracks.length || !getSelectedTrack()) return;
  const currentIndex = state.tracks.findIndex(t => t.id === state.selectedTrackId);
  const nextIndex = chooseNextIndex(currentIndex);
  if (nextIndex < 0) {
    state.nextPreloadTrackId = null;
    state.nextPreloadAssetId = null;
    return;
  }

  const nextTrack = state.tracks[nextIndex];
  const nextAsset = state.assets.get(nextTrack.assetId);
  if (!nextAsset?.file) return;

  state.nextPreloadTrackId = nextTrack.id;
  state.nextPreloadAssetId = nextAsset.id;

  // ブラウザ側のキャッシュを温める。実際の再生は現在のaudio要素へ切り替える。
  if (!state.preloadAudio) {
    state.preloadAudio = new Audio();
    state.preloadAudio.preload = 'auto';
    state.preloadAudio.muted = true;
  }
  const url = getAssetUrl(nextAsset);
  if (state.preloadAudio.src !== url) {
    state.preloadAudio.src = url;
    state.preloadAudio.load();
  }
}

function reorderTrack(fromId, toId) {
  const fromIndex = state.tracks.findIndex(t => t.id === fromId);
  const toIndex = state.tracks.findIndex(t => t.id === toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
  const [item] = state.tracks.splice(fromIndex, 1);
  state.tracks.splice(toIndex, 0, item);
  state.nextPreloadTrackId = null;
  state.nextPreloadAssetId = null;
  normalizeLoopSettings();
  renderTracks();
  setStatus('曲順を変更しました');
}

function moveSelected(delta) {
  const index = state.tracks.findIndex(t => t.id === state.selectedTrackId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.tracks.length) return;
  [state.tracks[index], state.tracks[target]] = [state.tracks[target], state.tracks[index]];
  renderTracks();
}

function removeSelectedTrack() {
  const index = state.tracks.findIndex(t => t.id === state.selectedTrackId);
  if (index < 0) return;
  const [removed] = state.tracks.splice(index, 1);

  const stillUsed = state.tracks.some(t => t.assetId === removed.assetId);
  if (!stillUsed) {
    revokeAssetUrl(removed.assetId);
    state.assets.delete(removed.assetId);
  }

  const newIndex = Math.min(index, state.tracks.length - 1);
  state.selectedTrackId = newIndex >= 0 ? state.tracks[newIndex].id : null;
  renderTracks();
  if (state.selectedTrackId) loadSelectedTrack();
  else clearPlayer();
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  const accepted = files.filter(file => {
    const name = file.name.toLowerCase();
    return /\.(mp3|wav|aac|m4a)$/.test(name);
  });

  if (!accepted.length) {
    setStatus('対応形式の音声ファイルがありません。MP3 / WAV / AAC / M4A を選択してください。', true);
    return;
  }

  for (const file of accepted) {
    const asset = createAssetFromFile(file);
    state.assets.set(asset.id, asset);
    state.tracks.push(createTrack(asset));
  }

  state.playlist.updatedAt = new Date().toISOString();
  normalizeLoopSettings();
  renderTracks();
  if (!state.selectedTrackId) await selectTrack(state.tracks[0].id);
  setStatus(`${accepted.length} 個のファイルを追加しました。`);
}

function makeSerializablePlaylist({ includeFilePaths = false } = {}) {
  const assets = Array.from(state.assets.values()).map(asset => {
    const obj = {
      id: asset.id,
      name: asset.name,
      mimeType: asset.mimeType,
      size: asset.size
    };
    if (includeFilePaths) obj.file = `audio/${asset.id}${extensionFromName(asset.name)}`;
    return obj;
  });

  return {
    format: FORMAT,
    version: VERSION,
    playlist: { ...state.playlist },
    settings: {
      repeatMode: state.settings.repeatMode === 'one' ? 'loop' : state.settings.repeatMode,
      loopStart: state.settings.loopStart,
      loopEnd: state.settings.loopEnd,
      randomWithinLoop: Boolean(state.settings.randomWithinLoop)
    },
    assets,
    tracks: state.tracks.map(track => ({
      id: track.id,
      assetId: track.assetId,
      weight: Number.isFinite(Number(track.weight)) && Number(track.weight) >= 0 ? Number(track.weight) : 1,
      trim: {
        start: roundTime(track.trim.start),
        end: track.trim.end == null ? null : roundTime(track.trim.end)
      }
    }))
  };
}

function extensionFromName(name) {
  const match = name.match(/\.[^.]+$/);
  return match ? match[0].toLowerCase() : '';
}

async function sha256Hex(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function addHashes(serializable) {
  const copy = structuredClone(serializable);
  for (const asset of copy.assets) {
    const file = state.assets.get(asset.id)?.file;
    if (file) asset.hash = `sha256:${await sha256Hex(file)}`;
  }
  return copy;
}

async function exportZip() {
  if (!state.tracks.length) {
    setStatus('プレイリストが空です。', true);
    return;
  }
  if (typeof JSZip === 'undefined') {
    setStatus('ZIPライブラリの読み込みに失敗しました。', true);
    return;
  }

  setStatus('ZIPを作成しています...');
  const zip = new JSZip();
  const data = await addHashes(makeSerializablePlaylist({ includeFilePaths: true }));
  zip.file('playlist.json', JSON.stringify(data, null, 2));

  const audioFolder = zip.folder('audio');
  for (const asset of state.assets.values()) {
    if (!asset.file) {
      setStatus(`音声データが見つかりません: ${asset.name}`, true);
      return;
    }
    audioFolder.file(`${asset.id}${extensionFromName(asset.name)}`, asset.file);
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  downloadBlob(blob, `${safeFileName(state.playlist.name || 'playlist')}.zip`);
  setStatus('ZIPを保存しました。');
}

function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'playlist';
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importZip(file) {
  if (typeof JSZip === 'undefined') throw new Error('JSZip unavailable');
  const zip = await JSZip.loadAsync(file);
  const jsonEntry = zip.file('playlist.json');
  if (!jsonEntry) throw new Error('playlist.json がありません。');
  const text = await jsonEntry.async('text');
  let data = JSON.parse(text);
  data = normalizePlaylistData(data);
  validatePlaylistData(data);

  const newAssets = new Map();
  for (const assetData of data.assets) {
    if (!assetData.file) throw new Error(`asset ${assetData.id} の file がありません。`);
    const entry = zip.file(assetData.file);
    if (!entry) throw new Error(`音声ファイルがありません: ${assetData.file}`);
    const blob = await entry.async('blob');
    const fileName = assetData.name || basename(assetData.file);
    const file = new File([blob], fileName, { type: assetData.mimeType || blob.type || guessMimeType(fileName) });
    newAssets.set(assetData.id, { ...assetData, file, sourcePath: assetData.file });
  }

  for (const url of state.objectUrls.values()) URL.revokeObjectURL(url);
  state.objectUrls.clear();
  state.assets = newAssets;
  state.tracks = data.tracks.map(track => ({
    id: track.id || crypto.randomUUID(),
    assetId: track.assetId,
    weight: Number.isFinite(Number(track.weight)) && Number(track.weight) >= 0 ? Number(track.weight) : 1,
    trim: {
      start: Number(track.trim?.start ?? 0),
      end: track.trim?.end == null ? null : Number(track.trim.end)
    }
  }));
  state.playlist = { ...data.playlist };
  state.settings = {
    repeatMode: data.settings?.repeatMode || 'off',
    loopStart: data.settings?.loopStart ?? null,
    loopEnd: data.settings?.loopEnd ?? null,
    randomWithinLoop: Boolean(data.settings?.randomWithinLoop)
  };
  state.selectedTrackId = state.tracks[0]?.id || null;

  repeatMode.value = state.settings.repeatMode;
  renderTracks();
  if (state.selectedTrackId) await loadSelectedTrack();
  else clearPlayer();
  setStatus('ZIPを読み込みました。');
}

function normalizePlaylistData(raw) {
  const data = structuredClone(raw);
  if (data.format !== FORMAT) return data;
  const version = Number(data.version || 1);
  if (version >= VERSION) return data;

  data.version = VERSION;
  data.playlist = data.playlist || {};
  data.settings = data.settings || {};

  if (data.settings.repeatMode === 'last-one') {
    const last = Array.isArray(data.tracks) && data.tracks.length ? data.tracks.length - 1 : 0;
    data.settings.repeatMode = 'loop';
    data.settings.loopStart = last;
    data.settings.loopEnd = last;
  } else if (data.settings.repeatMode === 'one') {
    // v1 did not persist the selected track, so use the first track as the
    // migration target. The next save is unambiguously represented as v2.
    data.settings.repeatMode = 'loop';
    data.settings.loopStart = 0;
    data.settings.loopEnd = 0;
  } else {
    data.settings.repeatMode = data.settings.repeatMode || 'off';
    data.settings.loopStart = data.settings.loopStart ?? null;
    data.settings.loopEnd = data.settings.loopEnd ?? null;
  }
  data.settings.randomWithinLoop = false;
  if (Array.isArray(data.tracks)) {
    data.tracks = data.tracks.map(track => ({
      ...track,
      weight: Number.isFinite(Number(track.weight)) && Number(track.weight) >= 0 ? Number(track.weight) : 1,
      trim: {
        start: Number(track.trim?.start ?? 0),
        end: track.trim?.end == null ? null : Number(track.trim.end)
      }
    }));
  }
  return data;
}

function validatePlaylistData(data) {
  if (!data || data.format !== FORMAT) throw new Error('対応していないプレイリスト形式です。');
  if (!Number.isInteger(data.version) || data.version < 1 || data.version > VERSION) {
    throw new Error(`未対応のプレイリストバージョンです: ${data.version}`);
  }
  if (!['off', 'list', 'loop'].includes(data.settings?.repeatMode || 'off')) {
    throw new Error(`repeatMode が不正です: ${data.settings?.repeatMode}`);
  }
  if (!Array.isArray(data.assets) || !Array.isArray(data.tracks)) {
    throw new Error('playlist.json の構造が不正です。');
  }
  const assetIds = new Set(data.assets.map(a => a.id));
  for (const track of data.tracks) {
    if (!assetIds.has(track.assetId)) throw new Error(`track ${track.id} が存在しないassetを参照しています。`);
    const weight = Number(track.weight ?? 1);
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`track ${track.id} のweightが不正です。`);
    const start = Number(track.trim?.start ?? 0);
    const end = track.trim?.end == null ? null : Number(track.trim.end);
    if (!Number.isFinite(start) || (end != null && !Number.isFinite(end)) || (end != null && end < start)) {
      throw new Error(`track ${track.id} のtrimが不正です。`);
    }
  }
}

function basename(path) {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveLocal() {
  const serializable = makeSerializablePlaylist();
  const metadata = {
    ...serializable,
    playlist: { ...serializable.playlist, updatedAt: new Date().toISOString() }
  };
  state.playlist.updatedAt = metadata.playlist.updatedAt;
  localStorage.setItem(LOCAL_KEY, JSON.stringify(metadata));

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    const assets = {};
    for (const asset of state.assets.values()) {
      assets[asset.id] = {
        id: asset.id,
        name: asset.name,
        mimeType: asset.mimeType,
        size: asset.size,
        file: asset.file
      };
    }
    store.put({ metadata, assets }, 'current');
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function loadLocal() {
  const db = await openDb();
  const record = await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get('current');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  if (!record) throw new Error('ローカル保存データがありません。');

  let data = normalizePlaylistData(record.metadata);
  validatePlaylistData(data);

  for (const url of state.objectUrls.values()) URL.revokeObjectURL(url);
  state.objectUrls.clear();
  state.assets = new Map(Object.values(record.assets).map(asset => [asset.id, asset]));
  state.tracks = data.tracks.map(track => ({ ...track, weight: Number(track.weight) >= 0 ? Number(track.weight) : 1, trim: { ...track.trim } }));
  state.playlist = { ...data.playlist };
  state.settings = {
    repeatMode: data.settings?.repeatMode || 'off',
    loopStart: data.settings?.loopStart ?? null,
    loopEnd: data.settings?.loopEnd ?? null,
    randomWithinLoop: Boolean(data.settings?.randomWithinLoop)
  };
  state.selectedTrackId = state.tracks[0]?.id || null;
  repeatMode.value = state.settings.repeatMode;
  renderTracks();
  if (state.selectedTrackId) await loadSelectedTrack(); else clearPlayer();
  setStatus('ローカル保存データを読み込みました。');
}

async function clearLocal() {
  localStorage.removeItem(LOCAL_KEY);
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete('current');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  setStatus('ローカル保存データを削除しました。');
}

// localStorageにはJSON、音声BlobはIndexedDBに分けています。
// 将来別プレイリスト管理へ拡張するときも、外部ZIP形式は変更せずに済みます。

$('addFilesBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async e => {
  await handleFiles(e.target.files);
  fileInput.value = '';
});

$('removeTrackBtn').addEventListener('click', removeSelectedTrack);
$('moveUpBtn').addEventListener('click', () => moveSelected(-1));
$('moveDownBtn').addEventListener('click', () => moveSelected(1));

$('playBtn').addEventListener('click', playTrack);
$('pauseBtn').addEventListener('click', () => audioPlayer.pause());
$('stopBtn').addEventListener('click', stopAudio);
$('previewTrimBtn').addEventListener('click', previewTrim);
$('stopPreviewBtn').addEventListener('click', () => { state.previewingTrim = false; state.previewToken++; audioPlayer.pause(); });

seekRange.addEventListener('input', () => setCurrentPosition(seekRange.value));
positionInput.addEventListener('change', () => setCurrentPosition(positionInput.value));
$('volumeRange').addEventListener('input', e => { audioPlayer.volume = Number(e.target.value); });

trimStartInput.addEventListener('change', () => setTrimStart(trimStartInput.value));
trimEndInput.addEventListener('change', () => setTrimEnd(trimEndInput.value));
$('setStartBtn').addEventListener('click', () => setTrimStart(audioPlayer.currentTime));
$('setEndBtn').addEventListener('click', () => setTrimEnd(audioPlayer.currentTime));
$('fullRangeBtn').addEventListener('click', () => {
  const track = getSelectedTrack();
  if (!track) return;
  track.trim.start = 0;
  track.trim.end = roundTime(Number.isFinite(audioPlayer.duration) ? audioPlayer.duration : 0);
  updateTrimUI();
});

repeatMode.addEventListener('change', () => {
  state.settings.repeatMode = repeatMode.value;
  normalizeLoopSettings();
  state.nextPreloadTrackId = null;
  state.nextPreloadAssetId = null;
  state.playlist.updatedAt = new Date().toISOString();
  updateLoopUI();
});

$('loopStartSelect').addEventListener('change', () => {
  state.settings.loopStart = Number($('loopStartSelect').value);
  state.nextPreloadTrackId = null;
  state.nextPreloadAssetId = null;
  if (state.settings.loopEnd < state.settings.loopStart) state.settings.loopEnd = state.settings.loopStart;
  state.playlist.updatedAt = new Date().toISOString();
  updateLoopUI();
});

$('loopEndSelect').addEventListener('change', () => {
  state.settings.loopEnd = Math.max(state.settings.loopStart ?? 0, Number($('loopEndSelect').value));
  state.nextPreloadTrackId = null;
  state.nextPreloadAssetId = null;
  state.playlist.updatedAt = new Date().toISOString();
  updateLoopUI();
});

$('randomWithinLoop').addEventListener('change', e => {
  state.settings.randomWithinLoop = e.target.checked;
  state.nextPreloadTrackId = null;
  state.nextPreloadAssetId = null;
  state.playlist.updatedAt = new Date().toISOString();
  prepareNextTrack();
});

audioPlayer.addEventListener('timeupdate', () => {
  updatePlayerTimeUI();
  if (state.previewingTrim) {
    const track = getSelectedTrack();
    const end = track?.trim.end ?? audioPlayer.duration;
    if (track && Number.isFinite(end) && audioPlayer.currentTime >= end - 0.02) {
      state.previewingTrim = false;
      state.previewToken++;
      audioPlayer.pause();
      audioPlayer.currentTime = track.trim.start;
      updatePlayerTimeUI();
    }
  } else {
    enforceTrimDuringPlayback();
  }
});

audioPlayer.addEventListener('ended', playNextAfterEnded);
audioPlayer.addEventListener('loadedmetadata', updatePlayerTimeUI);

$('saveLocalBtn').addEventListener('click', async () => {
  try { await saveLocal(); setStatus('ローカルに保存しました。'); }
  catch (e) { console.error(e); setStatus(`ローカル保存に失敗しました: ${e.message}`, true); }
});

$('loadLocalBtn').addEventListener('click', async () => {
  try { await loadLocal(); }
  catch (e) { console.error(e); setStatus(`ローカル読み込みに失敗しました: ${e.message}`, true); }
});

$('clearLocalBtn').addEventListener('click', async () => {
  if (!confirm('ローカルに保存したプレイリストを削除しますか？')) return;
  try { await clearLocal(); }
  catch (e) { console.error(e); setStatus(`削除に失敗しました: ${e.message}`, true); }
});

$('exportZipBtn').addEventListener('click', async () => {
  try { await exportZip(); }
  catch (e) { console.error(e); setStatus(`ZIP保存に失敗しました: ${e.message}`, true); }
});

$('importZipBtn').addEventListener('click', () => $('importZipInput').click());
$('importZipInput').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try { await importZip(file); }
  catch (err) { console.error(err); setStatus(`ZIP読み込みに失敗しました: ${err.message}`, true); }
});

// 外部からページを開いた直後でも、ユーザーが明示的に読み込みを押せば復元できます。
normalizeLoopSettings();
repeatMode.value = state.settings.repeatMode;
renderTracks();
updateLoopUI();
updateEditingControls(false);
