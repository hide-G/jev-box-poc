// ============================================================
// jev Box PoC - フロントロジック
// ------------------------------------------------------------
//   1. 画像を読み込み、jev制限(256〜1568px)に収まるよう必要なら縮小
//   2. Canvas にプレビュー描画
//   3. プロンプト(instructions)と画像base64を /api/box へ送信
//   4. jev の Box 回答 { box:{top,bottom,left,right}(0〜1), confidence }
//      を数値表示し、画像上に矩形を描画する
// ============================================================

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------
// API ベース URL の解決
//   config.js が window.__JEV_POC_CONFIG__.apiBase を定義する。
//   空文字 = 同一オリジンの相対パス（ローカル: localhost:8787/api/*）
//   AWS では CDK が Function URL を埋め込んだ config.js を配置する。
// ------------------------------------------------------------
const CFG = window.__JEV_POC_CONFIG__ || {};
const API_BASE = (CFG.apiBase || "").replace(/\/$/, ""); // 末尾スラッシュを除去

const el = {
  drop: $("drop"),
  file: $("file"),
  prompt: $("prompt"),
  btnSend: $("btn-send"),
  btnReset: $("btn-reset"),
  btnTranslate: $("btn-translate"),
  translateStatus: $("translateStatus"),
  status: $("status"),
  canvasBox: $("canvasBox"),
  canvas: $("canvas"),
  placeholder: $("placeholder"),
  resultArea: $("resultArea"),
  resultGrid: $("resultGrid"),
  confBar: $("confBar"),
  logDetails: $("logDetails"),
  logPre: $("logPre"),
  counter: $("counter"),
  counterText: $("counterText"),
};

// 日次上限に到達したか（到達後は送信ボタンを無効のままにする）
let dailyLimitReached = false;

// jev の画像サイズ制限
const MAX_SIDE = 1568; // 長辺の最大
const MIN_SIDE = 256; // 各辺の最小

// 現在読み込んでいる画像の状態
let state = {
  imgBitmap: null, // 送信用（リサイズ後）の ImageBitmap/Canvas
  drawW: 0, // Canvas に描画している幅(px)
  drawH: 0, // Canvas に描画している高さ(px)
  base64: null, // 送信用 base64（プレフィックスなし）
  format: null, // "png" | "jpeg"
};

const ctx = el.canvas.getContext("2d");

// ------------------------------------------------------------
// ステータス表示
// ------------------------------------------------------------
function setStatus(msg, kind) {
  el.status.className = "status" + (kind ? " " + kind : "");
  el.status.innerHTML = msg;
}

// ------------------------------------------------------------
// 画像ファイルを読み込み、リサイズして Canvas にプレビュー描画する
// ------------------------------------------------------------
async function loadImageFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpe?g)$/i.test(file.type)) {
    setStatus("PNG または JPEG を選んでください。", "err");
    return;
  }

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    prepareImage(img, file.type);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus("画像の読み込みに失敗しました。", "err");
  };
  img.src = url;
}

// 読み込んだ画像を制限内にリサイズし、Canvas描画 + base64化する
function prepareImage(img, mime) {
  let w = img.naturalWidth;
  let h = img.naturalHeight;

  // 長辺が MAX_SIDE を超える場合は縮小
  const longest = Math.max(w, h);
  let scale = 1;
  if (longest > MAX_SIDE) scale = MAX_SIDE / longest;
  w = Math.round(w * scale);
  h = Math.round(h * scale);

  // 最小サイズを満たさない場合は拡大（jevは最小256px・面積78,400px²が必要）
  const shortest = Math.min(w, h);
  if (shortest < MIN_SIDE) {
    const up = MIN_SIDE / shortest;
    w = Math.round(w * up);
    h = Math.round(h * up);
  }

  // 送信用フォーマット: 元が jpeg ならjpeg、それ以外は png
  const isJpeg = /jpe?g/i.test(mime);
  state.format = isJpeg ? "jpeg" : "png";

  // オフスクリーンにリサイズ描画
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const octx = off.getContext("2d");
  octx.drawImage(img, 0, 0, w, h);

  // base64（data URL のプレフィックスを除去）
  const dataUrl = off.toDataURL(isJpeg ? "image/jpeg" : "image/png", 0.92);
  state.base64 = dataUrl.split(",")[1];

  // 表示用 Canvas にセット
  state.drawW = w;
  state.drawH = h;
  el.canvas.width = w;
  el.canvas.height = h;
  ctx.drawImage(off, 0, 0);

  // 矩形描画のとき素画像に戻せるよう、リサイズ後の素画像をキャッシュしておく
  _srcCanvas = off;
  _srcKey = state.base64;

  el.placeholder.style.display = "none";
  el.canvas.style.display = "block";
  el.resultArea.style.display = "none";
  el.logDetails.style.display = "none";

  const resized = scale !== 1 || shortest < MIN_SIDE;
  setStatus(
    `画像を読み込みました（${w}×${h}px${resized ? "・自動調整済み" : ""}）。プロンプトを入力して送信してください。`,
    "ok"
  );
  updateSendEnabled();
}

// ------------------------------------------------------------
// 送信ボタンの有効/無効
// ------------------------------------------------------------
function updateSendEnabled() {
  // 日次上限到達後は常に無効
  el.btnSend.disabled =
    dailyLimitReached || !(state.base64 && el.prompt.value.trim());
}

// ------------------------------------------------------------
// 来訪者カウンタ表示（/api/box 成功応答の counters 到着時のみ更新）
//   成功時: 「今日 N 人目 / 累計 M 人目」（total が null なら累計は —）
// ------------------------------------------------------------
function renderCounters(counters) {
  if (!counters || typeof counters.today !== "number") return;
  const total =
    typeof counters.total === "number" ? `累計 ${counters.total} 人目` : "累計 —";
  el.counter.className = "counter";
  el.counterText.textContent = `今日 ${counters.today} 人目 / ${total}`;
}

// 日次上限到達時のカウンタ表示（「人目」表現は使わない）
function renderCounterLimit(limit, counters) {
  dailyLimitReached = true;
  el.counter.className = "counter limit";
  let text = `本日 ${limit}/${limit}（上限到達）`;
  if (counters && typeof counters.total === "number") {
    text += ` / 累計 ${counters.total} 人目`;
  }
  el.counterText.textContent = text;
  updateSendEnabled();
}

// ------------------------------------------------------------
// jev に送信して Box 結果を描画する
// ------------------------------------------------------------
async function sendToJev() {
  if (!state.base64) {
    setStatus("先に画像をアップロードしてください。", "err");
    return;
  }
  const instructions = el.prompt.value.trim();
  if (!instructions) {
    setStatus("プロンプトを入力してください。", "err");
    return;
  }

  el.btnSend.disabled = true;
  setStatus('<span class="spin"></span> jev に送信中…', "");

  try {
    const res = await fetch(API_BASE + "/api/box", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instructions,
        imageBase64: state.base64,
        format: state.format,
      }),
    });
    const data = await res.json();

    // 日次上限到達: 送信ボタンを無効化し、カウンタを「上限到達」表示にする
    if (res.status === 429 && data.reason === "daily_limit") {
      setStatus(
        data.error || "本日の上限（100回）に達しました。また明日お試しください。",
        "err"
      );
      renderCounterLimit(data.limit, data.counters);
      return;
    }
    // レート超過: 一定時間後に再試行できる旨を表示
    if (res.status === 429 && data.reason === "rate") {
      setStatus(
        data.error || "アクセスが集中しています。少し待って再試行してください。",
        "err"
      );
      return;
    }

    if (!res.ok || data.error) {
      throw new Error(data.error || "HTTP " + res.status);
    }
    renderResult(instructions, data);
    // 成功時のみカウンタを更新
    renderCounters(data.counters);
  } catch (err) {
    setStatus("エラー: " + (err?.message || err), "err");
  } finally {
    updateSendEnabled();
  }
}

// ------------------------------------------------------------
// プロンプトを翻訳する（Amazon Bedrock/Nova 経由）
//   日本語 → 英語、英語 → 日本語 を自動判定し、入力欄を置き換える
// ------------------------------------------------------------
function setTranslateStatus(msg, kind) {
  el.translateStatus.className = "translate-status" + (kind ? " " + kind : "");
  el.translateStatus.textContent = msg;
}

async function translatePrompt() {
  const text = el.prompt.value.trim();
  if (!text) {
    setTranslateStatus("先にプロンプトを入力してください。", "err");
    return;
  }

  el.btnTranslate.disabled = true;
  setTranslateStatus("翻訳中…", "");

  try {
    const res = await fetch(API_BASE + "/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();

    // 翻訳の日次上限到達（送信ボタンやカウンタ領域には影響しない）
    if (res.status === 429 && data.reason === "translate_daily_limit") {
      setTranslateStatus(
        data.error || "本日の翻訳回数の上限に達しました。また明日お試しください。",
        "err"
      );
      return;
    }
    // レート超過（/api/box と共通文言）
    if (res.status === 429 && data.reason === "rate") {
      setTranslateStatus(
        data.error || "アクセスが集中しています。少し待って再試行してください。",
        "err"
      );
      return;
    }

    if (!res.ok || data.error) {
      throw new Error(data.error || "HTTP " + res.status);
    }
    // 翻訳結果で入力欄を置き換える
    el.prompt.value = data.translated;
    updateSendEnabled();
    const dir = data.direction === "ja->en" ? "日本語→英語" : "英語→日本語";
    setTranslateStatus(`${dir} 翻訳しました（${data.latencyMs}ms / ${data.model}）`, "ok");
  } catch (err) {
    setTranslateStatus("翻訳エラー: " + (err?.message || err), "err");
  } finally {
    el.btnTranslate.disabled = false;
  }
}

// ------------------------------------------------------------
// jev の回答を数値表示 + 矩形描画
// ------------------------------------------------------------
function renderResult(instructions, data) {
  const ans = data?.response?.answers?.target;
  if (!ans || !ans.box) {
    setStatus("jev から box 回答が返りませんでした。ログを確認してください。", "err");
    showLog(data);
    return;
  }

  const box = ans.box; // {top,bottom,left,right} 0〜1
  const conf = typeof ans.confidence === "number" ? ans.confidence : null;

  // 0〜1 の割合 → ピクセル座標（左上原点）
  const px = {
    left: Math.round(box.left * state.drawW),
    right: Math.round(box.right * state.drawW),
    top: Math.round(box.top * state.drawH),
    bottom: Math.round(box.bottom * state.drawH),
  };
  const boxW = px.right - px.left;
  const boxH = px.bottom - px.top;

  // --- 画像を再描画してから矩形を重ねる ---
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  ctx.drawImage(stateCanvasSource(), 0, 0);

  // 矩形
  ctx.lineWidth = Math.max(2, Math.round(state.drawW / 400));
  ctx.strokeStyle = "#26d07c";
  ctx.strokeRect(px.left, px.top, boxW, boxH);

  // ラベル（プロンプト先頭 + confidence）
  const label =
    (instructions.length > 16 ? instructions.slice(0, 16) + "…" : instructions) +
    (conf != null ? ` (${conf.toFixed(2)})` : "");
  ctx.font = `${Math.max(12, Math.round(state.drawW / 70))}px sans-serif`;
  const tw = ctx.measureText(label).width;
  const th = Math.max(16, Math.round(state.drawW / 55));
  let ly = px.top - th - 2;
  if (ly < 0) ly = px.top + 2; // 上にはみ出すなら矩形内側上部へ
  ctx.fillStyle = "rgba(38,208,124,.85)";
  ctx.fillRect(px.left, ly, tw + 10, th);
  ctx.fillStyle = "#06222e";
  ctx.textBaseline = "middle";
  ctx.fillText(label, px.left + 5, ly + th / 2);

  // --- 数値表示 ---
  const fmt = (n) => n.toFixed(4);
  el.resultGrid.innerHTML = `
    <div class="k">検出対象</div><div class="v">${escapeHtml(instructions)}</div>
    <div class="k">割合 (0〜1)</div><div class="v">left=${fmt(box.left)} top=${fmt(box.top)} right=${fmt(box.right)} bottom=${fmt(box.bottom)}</div>
    <div class="k">ピクセル座標</div><div class="v">x=${px.left} y=${px.top} / 右下 x=${px.right} y=${px.bottom}</div>
    <div class="k">矩形サイズ</div><div class="v">${boxW} × ${boxH} px</div>
    <div class="k">画像サイズ</div><div class="v">${state.drawW} × ${state.drawH} px</div>
    <div class="k">confidence</div><div class="v">${conf != null ? conf.toFixed(4) : "(なし)"}</div>
    <div class="k">model</div><div class="v">${escapeHtml(data.model || data.response?.model || "")}</div>
    <div class="k">レイテンシ</div><div class="v">${data.latencyMs ?? "-"} ms</div>
  `;
  el.resultArea.style.display = "block";
  if (el.confBar) el.confBar.style.width = (conf != null ? Math.round(conf * 100) : 0) + "%";

  showLog(data);
  setStatus("完了しました。緑の矩形が検出位置です。", "ok");
}

// 矩形描画のたびに素画像へ戻すためのキャッシュ（prepareImage で設定）
let _srcCanvas = null;
let _srcKey = null;
function stateCanvasSource() {
  // prepareImage でリサイズ後の素画像を焼いてあるので、それを返す
  return _srcCanvas;
}

function showLog(data) {
  el.logPre.textContent = JSON.stringify(data, null, 2);
  el.logDetails.style.display = "block";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ------------------------------------------------------------
// リセット
// ------------------------------------------------------------
function reset() {
  state = { imgBitmap: null, drawW: 0, drawH: 0, base64: null, format: null };
  _srcCanvas = null;
  _srcKey = null;
  el.file.value = "";
  el.prompt.value = "";
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  el.canvas.style.display = "none";
  el.placeholder.style.display = "block";
  el.resultArea.style.display = "none";
  el.logDetails.style.display = "none";
  setStatus("", "");
  setTranslateStatus("", "");
  updateSendEnabled();
}

// ------------------------------------------------------------
// イベント配線
// ------------------------------------------------------------
el.drop.addEventListener("click", () => el.file.click());
el.file.addEventListener("change", (e) => loadImageFile(e.target.files[0]));

el.drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  el.drop.classList.add("dragover");
});
el.drop.addEventListener("dragleave", () => el.drop.classList.remove("dragover"));
el.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  el.drop.classList.remove("dragover");
  if (e.dataTransfer.files?.[0]) loadImageFile(e.dataTransfer.files[0]);
});

el.prompt.addEventListener("input", updateSendEnabled);
el.btnSend.addEventListener("click", sendToJev);
el.btnReset.addEventListener("click", reset);
el.btnTranslate.addEventListener("click", translatePrompt);

// プロンプト例チップ
document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    el.prompt.value = chip.textContent;
    updateSendEnabled();
    el.prompt.focus();
  });
});

// Ctrl+Enter で送信
el.prompt.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !el.btnSend.disabled) {
    sendToJev();
  }
});
