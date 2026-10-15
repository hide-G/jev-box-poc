// ============================================================
// store-file.mjs - CounterStore 実装（ローカル counter.json）
// ------------------------------------------------------------
// 日次使用上限と来訪者カウンタの永続化先。counter.json に
//   { "days": { "YYYY-MM-DD": n }, "trDays": { "YYYY-MM-DD": n }, "total": n }
// を保存する。
//
// 契約（CounterStore 共通・store-dynamo.mjs と同一挙動）:
//   tryConsume(nsDayKey, limit) -> { allowed, today, total }
//   refund(nsDayKey)            -> void（本日 count のみ -1・total 不変）
//   peek(nsDayKey)              -> { today, total }
//
// nsDayKey が "TR#" 始まり    → trDays バケット（翻訳系・total 更新せず total:null）
// nsDayKey がそれ以外（日付） → days バケット（jev 系・成功時 total++）
//
// ★ 複数プロセス非対応（PoC 制約）:
//   本ストアは `node server.mjs` の単一プロセス起動を前提とする。
//   別ポートで複数起動すると counter.json に書き込み競合が起こりうる。
//   厳密な多プロセス整合が要る場合は DynamoDB バックエンド(AWS 構成)を使う。
// ============================================================

import { readFile, writeFile, rename } from "node:fs/promises";

// ------------------------------------------------------------
// nsDayKey を解析して { bucket, dayKey, isTr } に分解する。
//   "TR#2025-05-20" -> { bucket:'trDays', dayKey:'2025-05-20', isTr:true }
//   "2025-05-20"    -> { bucket:'days',   dayKey:'2025-05-20', isTr:false }
// ------------------------------------------------------------
function parseNsDayKey(nsDayKey) {
  if (nsDayKey.startsWith("TR#")) {
    return { bucket: "trDays", dayKey: nsDayKey.slice(3), isTr: true };
  }
  return { bucket: "days", dayKey: nsDayKey, isTr: false };
}

// ------------------------------------------------------------
// CounterStore（ファイル実装）を生成する。
//   filePath: counter.json の絶対パス
// ------------------------------------------------------------
export function createFileStore(filePath) {
  // 同一プロセス内の操作を直列化するミューテックス（Promise チェーン）
  let queue = Promise.resolve();

  // 直列化しつつ fn を実行する
  function serialize(fn) {
    const run = queue.then(fn, fn);
    // 失敗がキュー全体を止めないよう、エラーを握って次へ繋ぐ
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  // counter.json を読み込む（無ければ初期形）
  async function load() {
    try {
      const raw = await readFile(filePath, "utf8");
      const obj = JSON.parse(raw);
      return {
        days: obj.days || {},
        trDays: obj.trDays || {},
        total: typeof obj.total === "number" ? obj.total : 0,
      };
    } catch {
      // 未存在/壊れている場合は初期形から始める
      return { days: {}, trDays: {}, total: 0 };
    }
  }

  // counter.json を原子的に書き戻す（一時ファイル + rename）
  async function save(data) {
    const tmp = filePath + ".tmp";
    await writeFile(tmp, JSON.stringify(data), "utf8");
    await rename(tmp, filePath);
  }

  return {
    // ----------------------------------------------------------
    // 本日枠をアトミックに 1 消費する。
    // 本日分が limit 以上なら消費せず allowed:false。
    // jev 系のときのみ total++（翻訳系は total:null）。
    // 成功時のみ対象バケットの当日以外のキーを掃除する。
    // ----------------------------------------------------------
    tryConsume(nsDayKey, limit) {
      return serialize(async () => {
        const { bucket, dayKey, isTr } = parseNsDayKey(nsDayKey);
        const data = await load();
        const current = data[bucket][dayKey] || 0;

        if (current >= limit) {
          // 上限到達: 消費しない
          return {
            allowed: false,
            today: current,
            total: isTr ? null : data.total,
          };
        }

        // 枠が取れた: 本日分 +1
        const today = current + 1;
        data[bucket][dayKey] = today;

        // jev 系のみ累計 +1（翻訳系は total を更新しない）
        let total = null;
        if (!isTr) {
          data.total = (data.total || 0) + 1;
          total = data.total;
        }

        // 成功時のみ当日以外のキーを掃除する（refund/peek では掃除しない）
        for (const k of Object.keys(data[bucket])) {
          if (k !== dayKey) delete data[bucket][k];
        }

        await save(data);
        return { allowed: true, today, total };
      });
    },

    // ----------------------------------------------------------
    // 失敗時の補償。本日(= nsDayKey の日付) count のみ -1。
    // 累計 total には触れない。負数にはしない。掃除はしない。
    // ----------------------------------------------------------
    refund(nsDayKey) {
      return serialize(async () => {
        const { bucket, dayKey } = parseNsDayKey(nsDayKey);
        const data = await load();
        const current = data[bucket][dayKey];
        if (typeof current === "number" && current > 0) {
          data[bucket][dayKey] = current - 1;
          await save(data);
        }
        // 存在しない/0 の場合は no-op
      });
    },

    // ----------------------------------------------------------
    // 表示用の現在値取得（消費を伴わない）。掃除はしない。
    // ----------------------------------------------------------
    peek(nsDayKey) {
      return serialize(async () => {
        const { bucket, dayKey, isTr } = parseNsDayKey(nsDayKey);
        const data = await load();
        return {
          today: data[bucket][dayKey] || 0,
          total: isTr ? null : data.total || 0,
        };
      });
    },
  };
}
