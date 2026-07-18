/* ============================================================
   ○×採点 共有クラウド同期 GAS（過去問・国語WS・塾技100 共通）
   ------------------------------------------------------------
   ■ 役割: 3アプリの○×採点データを1つのスプレッドシートで
           端末非依存に共有する小さなAPI。家族共有（ユーザー区別なし）。
   ■ 置き方（初回のみ約5分・komaguchi@gmail.com で行う）:
     1) https://sheets.google.com で新しいスプレッドシートを作成
        （名前は「○×採点同期」など）
     2) 拡張機能 → Apps Script を開き、このファイルの中身を全部貼り付けて保存
     3) デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
        - 次のユーザーとして実行: 自分
        - アクセスできるユーザー: 全員
     4) 発行された /exec URL を Claude に伝える
        → 3アプリの GRADE_SYNC_URL に設定して再Pushする
   ■ データ: アプリごとにシート sync_{app}（A列=キー / B列=値JSON / C列=更新時刻ms）。
     キー単位で「更新時刻が新しい方」を採用してマージ（丸ごと上書きしない）。
     A:C列はテキスト固定（setNumberFormat("@")）で日付自動変換を防止。
   ■ プロトコル:
     GET  ?app=kakomon                     → { status:"ok", entries:{ key:{v,t} } }
     POST { app, entries:{ key:{v,t} } }   → キー単位マージ → { status:"ok", merged:N }
   ============================================================ */

// 任意: 既存のスプレッドシートを使う場合はIDを入れる（空なら初回に自動作成）
const SHEET_ID = "";

function getSs_() {
  if (SHEET_ID) return SpreadsheetApp.openById(SHEET_ID);
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty("SHEET_ID");
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create("○×採点同期（過去問・国語WS・塾技）");
  props.setProperty("SHEET_ID", ss.getId());
  return ss;
}

function getSheet_(app) {
  const ss = getSs_();
  const name = "sync_" + app;
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange("A:C").setNumberFormat("@");  // 日付自動変換の防止
  }
  return sh;
}

function readAll_(sh) {
  const out = {};
  const last = sh.getLastRow();
  if (last >= 1) {
    const rows = sh.getRange(1, 1, last, 3).getValues();
    for (const r of rows) {
      if (!r[0]) continue;
      out[String(r[0])] = { v: String(r[1]), t: Number(r[2]) || 0 };
    }
  }
  return out;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    const app = String((e.parameter && e.parameter.app) || "").trim();
    if (!app) return json_({ status: "error", message: "app required" });
    return json_({ status: "ok", entries: readAll_(getSheet_(app)) });
  } catch (err) {
    return json_({ status: "error", message: err.message });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);   // 複数端末の同時保存でも上書き事故を防ぐ
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const app = String(body.app || "").trim();
    const entries = body.entries || {};
    if (!app) return json_({ status: "error", message: "app required" });
    const sh = getSheet_(app);
    const cur = readAll_(sh);
    let changed = 0;
    for (const k in entries) {
      const inc = entries[k];
      if (!inc || typeof inc.v !== "string") continue;
      const t = Number(inc.t) || 0;
      if (!cur[k] || t > cur[k].t) { cur[k] = { v: inc.v, t: t }; changed++; }
    }
    if (changed > 0) {
      const keys = Object.keys(cur);
      sh.clearContents();
      if (keys.length) {
        const rows = keys.map((k) => [k, cur[k].v, String(cur[k].t)]);
        const range = sh.getRange(1, 1, rows.length, 3);
        range.setNumberFormat("@");
        range.setValues(rows);
      }
    }
    return json_({ status: "ok", merged: changed });
  } catch (err) {
    return json_({ status: "error", message: err.message });
  } finally {
    lock.releaseLock();
  }
}
