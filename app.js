/* ===== 過去問アプリ ロジック ===== */
'use strict';

const state = {
  schools: [],        // schools.json
  schoolCache: {},    // id -> data/{id}.json
  school: null,       // 現在の学校データ
  exam: null,         // 現在の試験（年度・回）
  subject: null,      // 現在の教科
  view: 'question',   // 'question' | 'expl'
  homeScroll: 0,      // トップの離脱時スクロール位置（もどる時に復元）
  schoolScroll: 0,    // 学校ページの離脱時スクロール位置
  screen: 'home',     // 'home' | 'school' | 'info' | 'detail'
};

const $ = (sel) => document.querySelector(sel);

// 画像repoのベースURL（ローカル開発時は隣のディレクトリを参照）
// 有名中など大きい学校は試験（=学校）単位のimgBaseで画像repoを分割できる
const IMG_V = 5; // 画像を全差し替えしたら+1（キャッシュ破棄用）
function imgBase(school, exam) {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (exam && exam.imgBaseProd) return local ? exam.imgBaseLocal : exam.imgBaseProd;
  return local ? school.imgBaseLocal : school.imgBaseProd;
}
function imgUrl(p) { return `${imgBase(state.school, state.exam)}/${p}?v=${IMG_V}`; }

// ---- 初期化 ----
async function init() {
  try {
    const res = await fetch('schools.json', { cache: 'no-store' });
    state.schools = await res.json();
    // 全学校のデータを並列に読み、トップに試験一覧まで展開する
    const datas = await Promise.all(state.schools.map((s) =>
      fetch(`data/${s.id}.json`, { cache: 'no-store' }).then((r) => r.json())));
    state.schools.forEach((s, i) => { state.schoolCache[s.id] = datas[i]; });
    renderHome();
    openFromHash();   // #school/exam/subject で直接その教科を開く（正誤提案の案内URL用）
  } catch (e) {
    $('#school-list').innerHTML = '<p class="loading">学校一覧の読み込みに失敗しました。</p>';
    console.error(e);
  }
  $('#back-btn').addEventListener('click', goBack);
  document.querySelectorAll('#detail .tab').forEach((t) =>
    t.addEventListener('click', () => switchView(t.dataset.view)));
  $('#lightbox-close').addEventListener('click', closeLightbox);
  $('#info-print-btn').addEventListener('click', () => printInfo());
  // ○×表のクラウド同期（表示中の教科があれば取り込み後に再描画）
  gradeSyncInit(() => {   // 同期取り込み後は棒グラフも更新
    if (state.subject) renderDetail();
    else if (state.screen === 'school') renderSchool();
    else renderHome();
  });
}

// ---- ディープリンク（#school/exam/subject）----
function openFromHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (!raw) return;
  const [schoolId, examId, subjectId] = raw.split('/');
  const data = state.schoolCache[schoolId];
  if (!data) return;
  state.school = Object.assign({ id: schoolId }, data);
  if (!examId || !data.exams.some((e) => e.id === examId)) { openSchool(schoolId); return; }
  openExam(examId);
  if (subjectId) {
    const sub = state.exam.subjects.find((s) => s.id === subjectId);
    if (sub) { state.subject = sub; renderSubjectTabs(); renderDetail(); }
  }
}

// ---- 画面遷移 ----
function showScreen(id) {
  for (const s of ['home', 'school', 'info', 'detail']) $('#' + s).hidden = (s !== id);
  $('#back-btn').hidden = (id === 'home');
  state.screen = id;
  if (id === 'home') window.scrollTo(0, state.homeScroll);
  else if (id === 'school') window.scrollTo(0, state.schoolScroll);
  else window.scrollTo(0, 0);
}
function leaveHome() { state.homeScroll = window.scrollY; }
function leaveSchool() { state.schoolScroll = window.scrollY; }
// もどる: 試験詳細/学校情報 → 学校ページ、学校ページ → トップ
function goBack() {
  if (state.screen === 'school' || !state.school) {
    state.school = null; state.exam = null; state.subject = null;
    renderHome();   // 採点後の棒グラフを反映
    showScreen('home');
    return;
  }
  state.exam = null; state.subject = null;
  renderSchool();
  showScreen('school');
}

// ---- 試験グループ分け（年度 or 編） ----
function examGroupsOf(data) {
  if (data.exams.some((e) => e.group)) {
    // 有名中形式: exam.group（男子校編など）で出現順にグループ化
    const groups = [];
    const byLabel = {};
    for (const ex of data.exams) {
      const g = ex.group || 'その他';
      if (!byLabel[g]) { byLabel[g] = { label: g, exams: [] }; groups.push(byLabel[g]); }
      byLabel[g].exams.push(ex);
    }
    return groups;
  }
  // 通常: 年度降順×回順
  const byYear = {};
  for (const ex of data.exams) (byYear[ex.year] || (byYear[ex.year] = [])).push(ex);
  const roundOrder = (r) => ({ '1': 1, '2': 2, '3': 3 }[String(r)] || 9);
  for (const y in byYear) byYear[y].sort((a, b) => roundOrder(a.round) - roundOrder(b.round));
  return Object.keys(byYear).sort().reverse()
    .map((y) => ({ label: y + '年度', exams: byYear[y] }));
}

// ---- 試験カードの正誤棒グラフ（全教科の小問を合算。緑=正答率60%以上 / 黄=60%未満 / 灰=未） ----
const GOOD_RATE = 0.6;   // ★2026-08-23 ユーザー確定・全アプリ共通
function examBarStats(schoolId, ex) {
  let total = 0, attempted = 0, good = 0;
  for (const sub of ex.subjects || []) {
    const qs = sub.questions || [];
    if (!qs.length) continue;
    let g = null;
    try { g = JSON.parse(localStorage.getItem(`kakomon:${schoolId}:${ex.id}:${sub.id}`)); } catch (e) {}
    const attempts = (g && Array.isArray(g.attempts)) ? g.attempts : [];
    for (const q of qs) {
      total++;
      let n = 0, ok = 0;
      for (const a of attempts) {
        const m = a && a.marks ? a.marks[q] : '';
        if (m === 'o') { n++; ok++; } else if (m === 'x') { n++; }
      }
      if (n > 0) { attempted++; if (ok / n >= GOOD_RATE) good++; }
    }
  }
  return { total, attempted, good, low: attempted - good, unanswered: total - attempted };
}
function unitBarBlock(st) {
  if (!(st.total > 0)) return '';
  const pct = (n) => (n / st.total * 100);
  const donePct = Math.round(st.attempted / st.total * 100);
  return `
      <div class="unit-card-row">
        <div class="unit-card-info">
          <div class="unit-card-bar" title="緑=正答率60%以上 / 黄=60%未満 / 灰=未回答">
            <div class="unit-card-bar-good" style="width:${pct(st.good)}%"></div>
            <div class="unit-card-bar-low" style="width:${pct(st.low)}%"></div>
          </div>
          <div class="unit-card-legend">
            <span class="lg-good">○ ${st.good}</span>
            <span class="lg-low">△ ${st.low}</span>
            <span class="lg-none">未 ${st.unanswered}</span>
          </div>
        </div>
        <div class="unit-card-stats">
          <div class="unit-card-accuracy">${donePct}%</div>
          <div class="unit-card-detail">完了 ${st.attempted}/${st.total}</div>
        </div>
      </div>`;
}

// ---- トップ: 学校カード一覧（学校を選ぶ → 学校ページ） ----
function schoolBarStats(schoolId, data) {
  const t = { total: 0, attempted: 0, good: 0, low: 0, unanswered: 0 };
  for (const ex of data.exams) {
    const st = examBarStats(schoolId, ex);
    for (const k in t) t[k] += st[k];
  }
  return t;
}
function renderHome() {
  if (!state.schools.length) {
    $('#school-list').innerHTML = '<p class="loading">まだ学校がありません。</p>';
    return;
  }
  let html = '<div class="school-grid">';
  for (const s of state.schools) {
    const data = state.schoolCache[s.id];
    if (!data) continue;
    html += `
      <div class="exam-card school-card" data-school="${s.id}">
        <div class="school-card-head"><span class="school-icon">🏫</span>
          <div><div class="exam-name">${s.name}</div>
          <div class="exam-sub">${s.yearsLabel || ''}${data.exams.length ? `　${data.exams.length}回` : ''}</div></div></div>
        ${unitBarBlock(schoolBarStats(s.id, data))}
      </div>`;
  }
  html += '</div>';
  const list = $('#school-list');
  list.innerHTML = html;
  list.querySelectorAll('.school-card').forEach((c) =>
    c.addEventListener('click', () => { leaveHome(); openSchool(c.dataset.school); }));
}

// ---- 学校ページ: 学校情報カード＋年度（編）別の試験一覧 ----
function openSchool(schoolId) {
  state.school = Object.assign({ id: schoolId }, state.schoolCache[schoolId]);
  state.exam = null; state.subject = null;
  state.schoolScroll = 0;
  renderSchool();
  showScreen('school');
}
function renderSchool() {
  const s = state.schools.find((x) => x.id === state.school.id) || state.school;
  const data = state.schoolCache[s.id];
  let html = `
    <section class="school-section" data-school="${s.id}">
      <h2 class="school-head">
        <span class="school-icon">🏫</span>
        <span class="school-head-name">${s.name}</span>
        <span class="school-head-sub">${s.yearsLabel || ''}</span>
      </h2>`;
  if (data.info && data.info.pages.length) {
    html += `
      <div class="exam-card info-card" data-info="${s.id}">
        <span class="info-icon">📋</span>
        <div>
          <div class="exam-name">${data.info.title || '学校情報・出題傾向&対策'}</div>
          <div class="exam-sub">${data.info.subtitle || '受験情報・教科別の出題分析'}</div>
        </div>
      </div>`;
  }
  for (const g of examGroupsOf(data)) {
    html += `<div class="year-group"><h3 class="year-head">${g.label}</h3><div class="exam-grid">`;
    for (const ex of g.exams) {
      const subs = ex.subjects.map((sub) => sub.name).join('・');
      html += `
        <div class="exam-card" data-school="${s.id}" data-id="${ex.id}">
          <div class="exam-name">${ex.label}</div>
          <div class="exam-sub">${ex.roundNote ? ex.roundNote + '／' : ''}${subs}</div>${unitBarBlock(examBarStats(s.id, ex))}
        </div>`;
    }
    html += '</div></div>';
  }
  html += '</section>';
  const body = $('#school-body');
  body.innerHTML = html;
  body.querySelectorAll('.exam-card[data-info]').forEach((c) =>
    c.addEventListener('click', () => { leaveSchool(); openInfo(); }));
  body.querySelectorAll('.exam-card[data-id]').forEach((c) =>
    c.addEventListener('click', () => { leaveSchool(); openExam(c.dataset.id); }));
}

// ---- 学校情報・出題傾向 ----
function openInfo() {
  state.exam = null;  // 学校レベルのimgBaseを使う（試験単位imgBase上書きの解除）
  $('#info-title').textContent = `📋 ${state.school.name} ${state.school.info.title || '学校情報・出題傾向&対策'}`;
  $('#info-stack').innerHTML = pagePairsHTML(state.school.info.pages, 'ページ', false);
  bindLightbox($('#info-stack'));
  showScreen('info');
}

// ---- 試験詳細 ----
function openExam(examId) {
  state.exam = state.school.exams.find((e) => e.id === examId);
  state.subject = state.exam.subjects[0];
  state.view = 'question';
  const schoolLabel = state.school.shortName || state.school.name;
  $('#detail-title').textContent = `${schoolLabel} ${state.exam.label}${state.exam.roundNote ? '（' + state.exam.roundNote + '）' : ''}`;
  renderSubjectTabs();
  syncViewTabs();
  showScreen('detail');
  renderDetail();
}

function renderSubjectTabs() {
  $('#subject-tabs').innerHTML = state.exam.subjects.map((s) => `
    <button class="subject-tab ${s.id === state.subject.id ? 'on-' + s.id : ''}" data-id="${s.id}">${s.name}</button>
  `).join('');
  document.querySelectorAll('.subject-tab').forEach((b) =>
    b.addEventListener('click', () => {
      state.subject = state.exam.subjects.find((s) => s.id === b.dataset.id);
      renderSubjectTabs();
      renderDetail();
    }));
}

function switchView(view) {
  if (!state.exam || view === state.view) return;
  state.view = view;
  syncViewTabs();
  window.scrollTo(0, 0);
  renderDetail();
}
function syncViewTabs() {
  document.querySelectorAll('#detail .tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.view === state.view));
}

// ---- 詳細描画 ----
function pageImg(p, i, label) {
  return `
    <div class="page-item">
      <img src="${imgUrl(p.small)}" data-full="${imgUrl(p.full)}" alt="${label}${i + 1}" loading="lazy">
    </div>`;
}

// 縦長ページ列の見開き表示: 印刷のB4横2面付け（printDuo/composePair）と同じ並びで
// 画面にも2ページずつ横に並べる。rtl=true（国語）はペア内で右→左。
// landscape:true のページ（学校情報の横長面）は1枚で1行。
// 縦ページを1枚ずつ横幅いっぱいに出すと拡大されすぎるため（2026-09-07 ユーザー要望）。
function pagePairsHTML(pages, label, rtl) {
  let html = '';
  for (let i = 0; i < pages.length; ) {
    if (pages[i].landscape) { html += pageImg(pages[i], i, label); i += 1; continue; }
    const pair = (i + 1 < pages.length && !pages[i + 1].landscape)
      ? [pages[i], pages[i + 1]] : [pages[i]];
    const items = pair.map((p, j) => pageImg(p, i + j, label));
    // 1枚だけ余った場合は印刷と同じく読み進む側に寄せ、他方は空白
    if (pair.length === 1) items.push('<div class="page-duo-empty"></div>');
    html += `<div class="page-duo${rtl ? ' rtl' : ''}">${items.join('')}</div>`;
    i += pair.length;
  }
  return html;
}

// ---- 解答一覧（解答用紙に答えを書き込んだ状態のサマリ）----
// data の subjects[].nanido.answers（声教の解答ボックス転記。分数は {分子/分母}）を、
// 大問ごとの解答らん風グリッドで表示。各らんに A/B/C・配点、コベツバがあれば正答率・🎥。
function fracHTML(s) {
  return String(s).replace(/\{(\d+)\/(\d+)\}/g,
    '<span class="frac"><sup>$1</sup>⁄<sub>$2</sub></span>');
}
function daimonOf(q) { const m = /^(\d+)/.exec(q); return m ? m[1] : q; }
function ytLink(id, text, title) {
  const t = (title || text).replace(/"/g, '&quot;');
  return `<button type="button" class="ans-vid" data-yt="${id}" data-title="${t}">${text}</button>`;
}
function renderAnswerSummary() {
  const sub = state.subject, n = sub.nanido;
  if (!n || !n.answers) return '';
  const groups = [];
  for (const q of sub.questions || []) {
    const d = daimonOf(q);
    let g = groups[groups.length - 1];
    if (!g || g.d !== d) { g = { d, qs: [] }; groups.push(g); }
    g.qs.push(q);
  }
  let body = '';
  for (const grp of groups) {
    body += `<div class="ans-daimon"><div class="ans-dnum">${grp.d}</div><div class="ans-cells">`;
    for (const q of grp.qs) {
      const v = n.q[q] || [];
      const cls = v[0], pts = v[1], rate = v[2], vids = v[3];
      const subLabel = q.slice(grp.d.length) || q;
      let meta = '';
      if (rate) meta += `<span class="ans-rate">正答率${rate}</span>`;
      if (vids) meta += vids.map((id, i) => ytLink(id, `🎥解説${vids.length > 1 ? i + 1 : ''}`,
        `${sub.name} ${q} の解説${vids.length > 1 ? `（${i + 1}）` : ''}`)).join('');
      body += `<div class="ans-cell">
        <div class="ans-head"><span class="ans-sub">${subLabel}</span>
          ${cls ? `<span class="lv lv-${cls.toLowerCase()}">${cls}</span>` : ''}
          ${pts != null ? `<span class="ans-pts">${pts}点</span>` : ''}</div>
        <div class="ans-val">${fracHTML(n.answers[q] ?? '')}</div>
        ${meta ? `<div class="ans-meta">${meta}</div>` : ''}
      </div>`;
    }
    body += '</div></div>';
  }
  const pv = (n.pointVideos && n.pointVideos.length)
    ? `<div class="ans-points">🎥 ポイント解説（コベツバ）: ${n.pointVideos.map((p) => ytLink(p.youtubeId, p.title, `ポイント解説: ${p.title}`)).join('　')}</div>`
    : '';
  const src = n.src === 'kobetsuba' ? 'コベツバ過去問DB' : 'Claude分類';
  return `<div class="ans-summary" id="ans-summary">
    <div class="ans-title">解答一覧 <span class="note">${state.school.name} ${state.exam.label} ${sub.name}${sub.maxScore ? `（${sub.maxScore}点）` : ''}　難易度=${src}</span></div>
    ${nanidoBarHTML()}
    ${body}${pv}
  </div>`;
}

// ---- 解説ページの教科範囲クリップ ----
// 声教の解説は教科をまたいで1ページに同居する（例: 算数の末尾と社会の冒頭）。
// explPages[i].clip=[top,bottom]（高さ比）があれば、その範囲だけを表示・印刷する。
function pageImgClip(p, i, label) {
  if (!p.clip) return pageImg(p, i, label);
  return `
    <div class="page-item clip" data-top="${p.clip[0]}" data-bot="${p.clip[1]}">
      <img src="${imgUrl(p.small)}" data-full="${imgUrl(p.full)}" alt="${label}${i + 1}" loading="lazy">
    </div>`;
}
function fitClip(wrap) {
  const im = wrap.querySelector('img');
  if (!im || !im.naturalHeight) return;
  const h = im.clientWidth * im.naturalHeight / im.naturalWidth;
  const t = +wrap.dataset.top, b = +wrap.dataset.bot;
  wrap.style.height = `${h * (b - t)}px`;
  im.style.marginTop = `${-h * t}px`;
}
function applyClips(root) {
  root.querySelectorAll('.page-item.clip').forEach((w) => {
    const im = w.querySelector('img');
    if (im.complete && im.naturalHeight) fitClip(w);
    else im.addEventListener('load', () => fitClip(w), { once: true });
  });
}
window.addEventListener('resize', () =>
  document.querySelectorAll('#page-stack .page-item.clip').forEach(fitClip));

// clip範囲をcanvasで切り出す（印刷用）
async function cropImage(p) {
  const im = await loadImage(imgUrl(p.full));
  const [t, b] = p.clip;
  const y0 = Math.round(im.naturalHeight * t), h = Math.round(im.naturalHeight * (b - t));
  const c = document.createElement('canvas');
  c.width = im.naturalWidth; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, h);
  ctx.drawImage(im, 0, y0, im.naturalWidth, h, 0, 0, im.naturalWidth, h);
  const url = c.toDataURL('image/jpeg', 0.9);
  c.width = 0; c.height = 0;
  return url;
}

// 解答解説の印刷: A4縦。1枚目=解答一覧（あれば）、以降=教科範囲の解説を1面ずつ
async function printExpl(btn) {
  const pages = state.subject.explPages || [];
  const label = btn ? btn.textContent : '';
  try {
    setPageStyle('@media print { @page { size: A4 portrait; margin: 8mm; } }');
    const container = $('#print-container');
    container.innerHTML = '';
    const summary = document.getElementById('ans-summary');
    if (summary) {
      const div = document.createElement('div');
      div.className = 'print-page a4 a4-html';
      div.innerHTML = summary.outerHTML.replace('id="ans-summary"', '');
      container.appendChild(div);
    }
    for (let i = 0; i < pages.length; i++) {
      if (btn) btn.textContent = `準備中… ${i + 1}/${pages.length}`;
      const div = document.createElement('div');
      div.className = 'print-page a4';
      const im = document.createElement('img');
      im.src = pages[i].clip ? await cropImage(pages[i]) : imgUrl(pages[i].full);
      div.appendChild(im);
      container.appendChild(div);
    }
    await firePrint(container);
  } finally {
    if (btn) btn.textContent = label;
  }
}

function renderDetail() {
  const sub = state.subject;
  const note = $('#view-note');
  const stack = $('#page-stack');
  let html = renderGrading();
  if (state.view === 'question') {
    const specs = [sub.minutes ? sub.minutes + '分' : '', sub.maxScore ? '満点' + sub.maxScore + '点' : ''].filter(Boolean);
    note.textContent = `${sub.name}${specs.length ? '（' + specs.join('・') + '）' : ''}問題と解答用紙です。画像タップで拡大。`;
    html += `<h3 class="section-head">問題</h3>`;
    html += pagePairsHTML(sub.questionPages, '問題', sub.rtl);
    if (sub.sheetPages && sub.sheetPages.length) {
      html += `<h3 class="section-head">解答用紙</h3>`;
      html += sub.sheetPages.map((p, i) => pageImg(p, i, '解答用紙')).join('');
    }
  } else {
    note.textContent = state.exam.ansOnly
      ? `${sub.name}の解答です（この回は解答のみ収録・全教科分をまとめて表示しています）。`
      : `${sub.name}の解答解説です。画像タップで拡大。`;
    // 1枚目=解答一覧（解答用紙風サマリ。nanido.answers がある教科のみ）
    html += renderAnswerSummary();
    // 解説は教科に属する範囲だけを1列・大きく（印刷もA4縦1面ずつ）
    html += `<h3 class="section-head">解説</h3>`;
    html += sub.explPages.map((p, i) => pageImgClip(p, i, '解説')).join('');
    // 解いた解答用紙（原本・赤採点そのまま・追加日付入り）を解答タブ末尾に
    if (sub.solvedPages && sub.solvedPages.length) {
      html += `<h3 class="section-head">解いた解答用紙</h3>`;
      html += sub.solvedPages.map((p, i) => `
    <div class="page-item">
      ${p.date ? `<div class="page-date">${p.date} 追加</div>` : ''}
      <img src="${imgUrl(p.small)}" data-full="${imgUrl(p.full)}" alt="解いた解答用紙${i + 1}" loading="lazy">
    </div>`).join('');
    }
  }
  stack.innerHTML = html;
  bindLightbox(stack);
  applyClips(stack);
  stack.querySelectorAll('.ans-vid').forEach((b) =>
    b.addEventListener('click', () => openVideoModal(b.dataset.yt, b.dataset.title)));
  bindGrading();
  renderPrintButtons();
  loadProposal();
}

// ---- AI正誤提案（proposals/{school}/{exam}/{subject}.json: 解答用紙の赤○✓を読み取った○×）----
// 「仮入力する」→ 空いている回（1〜3回目の最初の未入力列）に仮の○×を表示 → 直して「確定」で保存。
// 確定/閉じる後は同じ提案（id）を再表示しない（kakomon-proposal-done:{id}）。
let proposalState = null;   // { id, t, grades:{q:bool}, score, date, review:false }
function proposalDoneKey(id) { return `kakomon-proposal-done:${id}`; }
async function loadProposal() {
  proposalState = null;
  const box = document.getElementById('proposal-banner');
  if (box) box.remove();
  if (!state.school || !state.exam || !state.subject || !(state.subject.questions || []).length) return;
  const sch = state.school.id, ex = state.exam.id, sub = state.subject.id;
  let prop = null;
  try {
    const r = await fetch(`proposals/${sch}/${ex}/${sub}.json`, { cache: 'no-cache' });
    if (!r.ok) return;
    prop = await r.json();
  } catch (e) { return; }
  if (!state.exam || state.exam.id !== ex || state.subject.id !== sub) return;
  if (!prop || !prop.grades) return;
  const id = prop.id || `${sch}/${ex}/${sub}:${prop.created || ''}`;
  try { if (localStorage.getItem(proposalDoneKey(id)) === '1') return; } catch (e) {}
  const qs = new Set(state.subject.questions || []);
  const grades = {};
  for (const q of Object.keys(prop.grades)) {
    const v = prop.grades[q];
    if (qs.has(q) && (v === true || v === false)) grades[q] = v;
  }
  if (!Object.keys(grades).length) return;
  // 入れる回: 1〜3回目のうち最初の「○×が1つも無い」列（全部埋まっていれば3回目）
  const g = loadGrades();
  let t = g.attempts.findIndex((a) => !Object.values(a.marks || {}).some((v) => v));
  if (t < 0) t = 2;
  proposalState = { id, t, grades, score: prop.score != null ? String(prop.score) : '', date: prop.created || '', review: false };
  renderProposalBanner();
}
function renderProposalBanner() {
  let box = document.getElementById('proposal-banner');
  const grading = document.querySelector('.grading');
  if (!proposalState || !grading) { if (box) box.remove(); return; }
  if (!box) {
    box = document.createElement('div');
    box.id = 'proposal-banner';
    box.className = 'proposal-banner';
    grading.insertBefore(box, grading.querySelector('.grade-table-wrap'));
  }
  const ps = proposalState;
  const vals = Object.values(ps.grades);
  const nOk = vals.filter((v) => v).length;
  if (!ps.review) {
    box.innerHTML = `
      <span class="pb-text">🤖 解答用紙から読み取った○×提案があります（${vals.length}件: ○${nOk} ×${vals.length - nOk}${ps.score ? '・合計' + ps.score + '点' : ''}）→ <b>${ps.t + 1}回目</b>に入れます</span>
      <span class="pb-btns">
        <button class="pb-btn pb-primary" id="pb-apply">仮入力する</button>
        <button class="pb-btn" id="pb-dismiss">閉じる</button>
      </span>`;
    box.querySelector('#pb-apply').addEventListener('click', applyProposal);
    box.querySelector('#pb-dismiss').addEventListener('click', dismissProposal);
  } else {
    box.innerHTML = `
      <span class="pb-text">✏️ ${ps.t + 1}回目に仮入力しました。違うものは○×をタップして直し、最後に「確定」を押してください（確定まで保存されません）</span>
      <span class="pb-btns">
        <button class="pb-btn pb-primary" id="pb-confirm">確定</button>
        <button class="pb-btn" id="pb-cancel">取り消し</button>
      </span>`;
    box.querySelector('#pb-confirm').addEventListener('click', confirmProposal);
    box.querySelector('#pb-cancel').addEventListener('click', cancelProposal);
  }
}
function applyProposal() {
  if (!proposalState) return;
  const ps = proposalState;
  ps.review = true;
  ps.pending = Object.assign({}, ps.grades);   // {q: bool} 画面上の仮の値（タップで反転）
  for (const q of Object.keys(ps.pending)) {
    const btn = document.querySelector(`.mark-btn[data-q="${CSS.escape(q)}"][data-t="${ps.t}"]`);
    if (!btn) continue;
    const v = ps.pending[q] ? 'o' : 'x';
    btn.className = `mark-btn pend ${v}`;
    btn.textContent = v === 'o' ? '○' : '×';
  }
  const wrap = document.querySelector('.grade-table-wrap');
  if (wrap && wrap.hidden) { wrap.hidden = false; sessionStorage.setItem('kakomon-grading-open', '1'); const tm = document.querySelector('#grading-toggle .toggle-mark'); if (tm) tm.textContent = '▲ とじる'; }
  const si = document.querySelector(`.score-input[data-t="${ps.t}"]`);
  if (si && ps.score && !si.value) { si.value = ps.score; si.classList.add('pend'); }
  const di = document.querySelector(`.date-input[data-t="${ps.t}"]`);
  if (di && ps.date && !di.value) { di.value = ps.date; di.classList.add('pend'); }
  renderProposalBanner();
}
function confirmProposal() {
  const ps = proposalState;
  if (!ps || !ps.review) return;
  const g = loadGrades();
  for (const q of Object.keys(ps.pending)) g.attempts[ps.t].marks[q] = ps.pending[q] ? 'o' : 'x';
  const si = document.querySelector(`.score-input[data-t="${ps.t}"]`);
  if (si && si.value) g.attempts[ps.t].score = si.value;
  const di = document.querySelector(`.date-input[data-t="${ps.t}"]`);
  if (di && di.value) g.attempts[ps.t].date = di.value;
  saveGrades(g);
  try { localStorage.setItem(proposalDoneKey(ps.id), '1'); } catch (e) {}
  proposalState = null;
  renderDetail();
}
function cancelProposal() {
  proposalState = null;
  renderDetail();   // 画面の仮の値を捨てて描き直し（保存はしていない）
}
function dismissProposal() {
  if (proposalState) { try { localStorage.setItem(proposalDoneKey(proposalState.id), '1'); } catch (e) {} }
  proposalState = null;
  renderProposalBanner();
}

function renderPrintButtons() {
  const g = $('#print-group');
  if (state.view === 'question') {
    g.innerHTML = `
      <button class="print-btn" id="pr-q">🖨 問題（B4横 2面）</button>
      <button class="print-btn" id="pr-s">🖨 解答用紙（B4拡大）</button>`;
    $('#pr-q').addEventListener('click', (e) => printDuo(state.subject.questionPages, state.subject.rtl, e.currentTarget));
    $('#pr-s').addEventListener('click', () => printSheets(state.subject.sheetPages));
  } else {
    g.innerHTML = `<button class="print-btn" id="pr-e">🖨 解答一覧＋解説（A4縦）</button>`;
    $('#pr-e').addEventListener('click', (e) => printExpl(e.currentTarget));
  }
}

// ---- 家族共有クラウド同期（○×表を端末非依存にする） ----
// GAS（grade-sync.gs）を「アクセス: 全員」でデプロイし、/exec URL を下の "" に入れると有効になる。
// 未設定の間は従来通り端末内保存のみ。データはキー単位で「更新時刻が新しい方」を採用してマージ。
const GRADE_SYNC_URL = localStorage.getItem('grade-sync-url') || 'https://script.google.com/macros/s/AKfycbwvfaMQjYIL56_EodEPWsTU27IRHz4FIkkU9GKt2wwSI1bRNEcK5M1tia3VGGwEQVmy/exec';
const GRADE_SYNC_APP = 'kakomon';
const GRADE_SYNC_PREFIXES = ['kakomon:'];
const GRADE_SYNC_META = 'kakomon-sync-t';   // キーごとの最終更新時刻(ms)

let _gsTimer = null, _gsBusy = false;
function _gsMeta() { try { return JSON.parse(localStorage.getItem(GRADE_SYNC_META)) || {}; } catch (e) { return {}; } }
function _gsSetMeta(m) { try { localStorage.setItem(GRADE_SYNC_META, JSON.stringify(m)); } catch (e) {} }
function _gsKeys() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (GRADE_SYNC_PREFIXES.some((p) => k === p || k.startsWith(p))) out.push(k);
  }
  return out;
}
// 採点の保存時に呼ぶ: 更新時刻を記録し、0.8秒後にまとめて送信
function gradeSyncTouch(key) {
  if (!GRADE_SYNC_URL) return;
  const m = _gsMeta(); m[key] = Date.now(); _gsSetMeta(m);
  clearTimeout(_gsTimer);
  _gsTimer = setTimeout(gradeSyncPush, 800);
}
async function gradeSyncPush() {
  if (!GRADE_SYNC_URL) return;
  const m = _gsMeta();
  let metaChanged = false;
  const entries = {};
  for (const k of _gsKeys()) {
    const v = localStorage.getItem(k);
    if (v == null) continue;
    if (!m[k]) { m[k] = Date.now(); metaChanged = true; }  // 同期導入前からのデータに時刻を付与
    entries[k] = { v, t: m[k] };
  }
  if (metaChanged) _gsSetMeta(m);
  if (!Object.keys(entries).length) return;
  try {
    await fetch(GRADE_SYNC_URL, {
      method: 'POST', mode: 'cors',
      headers: { 'Content-Type': 'text/plain' },  // GASのpreflight回避
      body: JSON.stringify({ app: GRADE_SYNC_APP, entries }),
    });
  } catch (e) { console.warn('gradeSyncPush failed:', e); }
}
// クラウドの新しいキーだけ取り込み → 変化があれば画面更新
async function gradeSyncPull(onUpdate) {
  if (!GRADE_SYNC_URL || _gsBusy) return;
  _gsBusy = true;
  try {
    const res = await fetch(GRADE_SYNC_URL + '?app=' + encodeURIComponent(GRADE_SYNC_APP), { mode: 'cors' });
    const json = await res.json();
    if (json.status !== 'ok' || !json.entries) return;
    const m = _gsMeta();
    let changed = false;
    for (const k in json.entries) {
      if (!GRADE_SYNC_PREFIXES.some((p) => k === p || k.startsWith(p))) continue;
      const e = json.entries[k];
      if (!e || typeof e.v !== 'string') continue;
      if (localStorage.getItem(k) == null || (e.t || 0) > (m[k] || 0)) {
        localStorage.setItem(k, e.v);
        m[k] = e.t || 0;
        changed = true;
      }
    }
    if (changed) { _gsSetMeta(m); if (onUpdate) onUpdate(); }
  } catch (e) { console.warn('gradeSyncPull failed:', e); }
  finally { _gsBusy = false; }
}
function gradeSyncInit(onUpdate) {
  if (!GRADE_SYNC_URL) return;
  gradeSyncPull(onUpdate);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { gradeSyncPush(); gradeSyncPull(onUpdate); }
  });
  window.addEventListener('online', () => gradeSyncPush());
}

// ---- ○×表（小問×3回＋合計点） ----
function gradeKey() {
  return `kakomon:${state.school.id}:${state.exam.id}:${state.subject.id}`;
}
function loadGrades() {
  try {
    const g = JSON.parse(localStorage.getItem(gradeKey()));
    if (g && Array.isArray(g.attempts) && g.attempts.length === 3) {
      g.attempts.forEach((a) => { if (a.date === undefined) a.date = ''; });
      return g;
    }
  } catch (e) {}
  return { attempts: [
    { marks: {}, score: '', date: '' },
    { marks: {}, score: '', date: '' },
    { marks: {}, score: '', date: '' }] };
}
function saveGrades(g) {
  try { localStorage.setItem(gradeKey(), JSON.stringify(g)); } catch (e) {}
  gradeSyncTouch(gradeKey());
}

// ---- 難易度マップ（A=全部正解したい / B=3〜4割取りたい / C=捨ててよい）----
// data/{school}.json の subjects[].nanido に焼き込み済み
// （scripts/kakomon/burn_nanido_levels.py が 04_learning/.../nanido/ から生成）
// 国理社=Claudeが全問読んで分類、算数=コベツバ過去問データベース由来。
const B_TARGET_RATE = 0.35;   // 目標点 = A合計 ＋ Bの3〜4割（ユーザー確定基準の中央値）

function nanidoOf(q) {
  const n = state.subject && state.subject.nanido;
  const v = n && n.q && n.q[q];
  return v ? { cls: v[0], points: v[1] } : null;
}
function levelChip(q) {
  const d = nanidoOf(q);
  return d ? `<span class="lv lv-${d.cls.toLowerCase()}">${d.cls}</span>` : '';
}
// A帯の到達状況（1回ごとに「Aの何問を○にできたか」）
function aStats(attempt, qs) {
  const aQs = qs.filter((q) => { const d = nanidoOf(q); return d && d.cls === 'A'; });
  const done = aQs.filter((q) => attempt.marks[q]);
  const ok = aQs.filter((q) => attempt.marks[q] === 'o');
  return { total: aQs.length, done: done.length, ok: ok.length };
}
function aCellHTML(attempt, qs) {
  const st = aStats(attempt, qs);
  if (!st.total) return '<td class="a-cell">—</td>';
  if (!st.done) return '<td class="a-cell">—</td>';
  const miss = st.done - st.ok;
  return `<td class="a-cell${miss ? ' miss' : ' full'}">${st.ok}/${st.total}${miss ? `<br><span class="a-miss">×${miss}</span>` : ''}</td>`;
}
function nanidoBarHTML() {
  const n = state.subject && state.subject.nanido;
  if (!n) return '';
  const target = Math.round(n.sums.A + n.sums.B * B_TARGET_RATE);
  const avg = (n.avg && n.avg.gokakusha != null)
    ? `　合格者平均 <b>${n.avg.gokakusha}点</b>` : '';
  const src = n.src === 'kobetsuba' ? 'コベツバ過去問DB' : 'Claude分類';
  return `
    <div class="nanido-bar">
      <span class="lv lv-a">A</span>${n.sums.A}点
      <span class="lv lv-b">B</span>${n.sums.B}点
      <span class="lv lv-c">C</span>${n.sums.C}点
      ／ 目標 <b>${target}点</b>（Aを全部＋Bの3〜4割）${avg}
      <span class="nanido-src">${src}</span>
    </div>
    <div class="nanido-help">
      <span class="lv lv-a">A</span>全部正解したい（×は必ず直す）
      <span class="lv lv-b">B</span>3〜4割取りたい（惜しい×だけ直す）
      <span class="lv lv-c">C</span>捨ててよい（解説を一読）
    </div>`;
}

function renderGrading() {
  const qs = state.subject.questions || [];
  if (!qs.length) return '';
  const g = loadGrades();
  const counts = g.attempts.map((a) => {
    const marks = Object.values(a.marks).filter((v) => v);
    const o = marks.filter((v) => v === 'o').length;
    return `${o}/${qs.length}`;
  });
  const hasNanido = !!(state.subject.nanido && state.subject.nanido.q);
  let rows = '';
  for (const q of qs) {
    const d = nanidoOf(q);
    // Aの×＝最優先で直す問題。行ごと色を付けて目立たせる
    const mustFix = d && d.cls === 'A'
      && g.attempts.some((a) => a.marks[q] === 'x');
    rows += `<tr${mustFix ? ' class="row-mustfix"' : ''} data-row="${q}">`;
    rows += `<td class="q-label">${levelChip(q)}${q}</td>`;
    for (let t = 0; t < 3; t++) {
      const v = g.attempts[t].marks[q] || '';
      rows += `<td><button class="mark-btn ${v}" data-q="${q}" data-t="${t}">${v === 'o' ? '○' : v === 'x' ? '×' : '・'}</button></td>`;
    }
    rows += '</tr>';
  }
  let aRow = '';
  if (hasNanido) {
    aRow = `<tr class="a-row"><td class="q-label">A帯の正解</td>`
      + g.attempts.map((a) => aCellHTML(a, qs)).join('') + '</tr>';
  }
  let dateCells = '';
  for (let t = 0; t < 3; t++) {
    dateCells += `<td><input class="date-input" type="date" data-t="${t}" value="${g.attempts[t].date || ''}"></td>`;
  }
  let scoreCells = '';
  for (let t = 0; t < 3; t++) {
    scoreCells += `<td><input class="score-input" type="number" inputmode="numeric" data-t="${t}" value="${g.attempts[t].score}" placeholder="点"></td>`;
  }
  const open = sessionStorage.getItem('kakomon-grading-open') !== '0';
  return `
    <div class="grading">
      <div class="grading-head" id="grading-toggle">
        📊 ○×表（${state.subject.name}）
        <span class="grade-count">正解数 ${counts.join(' ／ ')}</span>
        <span class="toggle-mark">${open ? '▲ とじる' : '▼ ひらく'}</span>
      </div>
      <div class="grade-table-wrap" ${open ? '' : 'hidden'}>
        ${nanidoBarHTML()}
        <table class="grade-table">
          <thead><tr><th>問題</th><th>1回目</th><th>2回目</th><th>3回目</th></tr></thead>
          <tbody>
            <tr><td class="q-label">取り組んだ日</td>${dateCells}</tr>
            ${rows}
            ${aRow}
            <tr><td class="q-label">合計点${state.subject.maxScore ? `（/${state.subject.maxScore}）` : ''}</td>${scoreCells}</tr>
          </tbody>
        </table>
      </div>
    </div>`;
}

function bindGrading() {
  const toggle = $('#grading-toggle');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const wrap = toggle.parentElement.querySelector('.grade-table-wrap');
    const nowOpen = wrap.hidden;
    wrap.hidden = !nowOpen;
    sessionStorage.setItem('kakomon-grading-open', nowOpen ? '1' : '0');
    toggle.querySelector('.toggle-mark').textContent = nowOpen ? '▲ とじる' : '▼ ひらく';
  });
  document.querySelectorAll('.mark-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { q, t } = btn.dataset;
      // 提案レビュー中は、その回の列だけ仮の値を反転（保存しない）
      if (proposalState && proposalState.review && Number(t) === proposalState.t) {
        const cur = proposalState.pending[q];
        const next = cur === true ? false : cur === false ? null : true;   // ○→×→・→○
        if (next === null) delete proposalState.pending[q]; else proposalState.pending[q] = next;
        const v = next === true ? 'o' : next === false ? 'x' : '';
        btn.className = `mark-btn pend ${v}`;
        btn.textContent = v === 'o' ? '○' : v === 'x' ? '×' : '・';
        return;
      }
      const g = loadGrades();
      const cur = g.attempts[t].marks[q] || '';
      const next = cur === '' ? 'o' : cur === 'o' ? 'x' : '';  // ・→○→×→・
      g.attempts[t].marks[q] = next;
      saveGrades(g);
      btn.className = `mark-btn ${next}`;
      btn.textContent = next === 'o' ? '○' : next === 'x' ? '×' : '・';
      const qsAll = state.subject.questions || [];
      const counts = g.attempts.map((a) => {
        const o = Object.values(a.marks).filter((v) => v === 'o').length;
        return `${o}/${qsAll.length}`;
      });
      const el = document.querySelector('.grade-count');
      if (el) el.textContent = `正解数 ${counts.join(' ／ ')}`;
      // 難易度マップ由来の表示（A帯の到達状況・Aの×の行ハイライト）も更新
      const aRow = document.querySelector('.a-row');
      if (aRow) {
        aRow.innerHTML = '<td class="q-label">A帯の正解</td>'
          + g.attempts.map((a) => aCellHTML(a, qsAll)).join('');
      }
      const tr = document.querySelector(`tr[data-row="${CSS.escape(q)}"]`);
      const d = nanidoOf(q);
      if (tr) {
        tr.classList.toggle('row-mustfix', !!d && d.cls === 'A'
          && g.attempts.some((a) => a.marks[q] === 'x'));
      }
    });
  });
  document.querySelectorAll('.score-input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const g = loadGrades();
      g.attempts[inp.dataset.t].score = inp.value;
      saveGrades(g);
    });
  });
  document.querySelectorAll('.date-input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const g = loadGrades();
      g.attempts[inp.dataset.t].date = inp.value;
      saveGrades(g);
    });
  });
}

// ---- ライトボックス ----
function bindLightbox(root) {
  root.querySelectorAll('.page-item img').forEach((img) =>
    img.addEventListener('click', () => openLightbox(img.dataset.full)));
}
function openLightbox(fullSrc) {
  $('#lightbox-img').src = fullSrc;
  $('#lightbox').hidden = false;
  $('.lightbox-scroll').scrollTo(0, 0);
}
function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lightbox-img').src = '';
}

// ---- 印刷 ----
function setPageStyle(css) {
  let st = document.getElementById('print-page-style');
  if (!st) {
    st = document.createElement('style');
    st.id = 'print-page-style';
    document.head.appendChild(st);
  }
  st.textContent = css;
}

async function firePrint(container) {
  const imgs = Array.from(container.querySelectorAll('img'));
  await Promise.all(imgs.map((im) =>
    im.decode ? im.decode().catch(() => {}) : Promise.resolve()));
  setTimeout(() => window.print(), 100);
}

// 画像1枚をロード
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

// B5×2ページを1枚のB4横画像にcanvas合成する（iPad印刷対策:
// 2枚並びのCSSレイアウトはiOSが余白/@pageを無視して折り返すため、
// アプリ側で合成して「1画像=1ページ」の実績ある方式で刷る）
async function composePair(pair, rtl) {
  const imgs = [];
  for (const p of pair) imgs.push(await loadImage(imgUrl(p.full)));
  const ordered = rtl ? imgs.slice().reverse() : imgs;
  const h = Math.max(...ordered.map((im) => im.naturalHeight));
  const widths = ordered.map((im) => Math.round(im.naturalWidth * h / im.naturalHeight));
  const fullW = pair.length === 1 ? widths[0] * 2 : widths.reduce((a, b) => a + b, 0);
  const canvas = document.createElement('canvas');
  canvas.width = fullW;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, fullW, h);
  // 1枚だけ余った場合: 読み進む側（LTR=左, RTL=右）に寄せ、他方は白のまま
  let x = (pair.length === 1 && rtl) ? fullW - widths[0] : 0;
  ordered.forEach((im, i) => {
    ctx.drawImage(im, x, 0, widths[i], h);
    x += widths[i];
  });
  const url = canvas.toDataURL('image/jpeg', 0.9);
  canvas.width = 0; canvas.height = 0;  // iOSのcanvasメモリを早めに解放
  return url;
}

// B4横に2面付け（事前合成方式）。rtl=true（国語）はペア内で右→左に配置
async function printDuo(pages, rtl, btn) {
  if (!pages || !pages.length) return;
  const label = btn ? btn.textContent : '';
  try {
    setPageStyle('@media print { @page { size: B4 landscape; margin: 8mm; } }');
    const container = $('#print-container');
    container.innerHTML = '';
    for (let i = 0; i < pages.length; i += 2) {
      if (btn) btn.textContent = `準備中… ${Math.min(i + 2, pages.length)}/${pages.length}`;
      const url = await composePair(pages.slice(i, i + 2), rtl);
      const div = document.createElement('div');
      div.className = 'print-page duo';
      const im = document.createElement('img');
      im.src = url;
      div.appendChild(im);
      container.appendChild(div);
    }
    await firePrint(container);
  } finally {
    if (btn) btn.textContent = label;
  }
}

// 解答用紙: B4縦にB5→B4拡大で1面ずつ
function printSheets(pages) {
  if (!pages || !pages.length) return;
  setPageStyle('@media print { @page { size: B4 portrait; margin: 8mm; } }');
  const container = $('#print-container');
  container.innerHTML = pages
    .map((p) => `<div class="print-page solo"><img src="${imgUrl(p.full)}"></div>`)
    .join('');
  firePrint(container);
}

// 学校情報の印刷: 縦長ページはB4横2面付け、横長ページ（landscape:true）は1枚で1面
async function printInfo() {
  const pages = state.school.info.pages;
  if (!pages || !pages.length) return;
  const btn = $('#info-print-btn');
  const label = btn.textContent;
  try {
    setPageStyle('@media print { @page { size: B4 landscape; margin: 8mm; } }');
    const container = $('#print-container');
    container.innerHTML = '';
    let i = 0;
    while (i < pages.length) {
      btn.textContent = `準備中… ${i + 1}/${pages.length}`;
      let src;
      if (pages[i].landscape) {
        src = imgUrl(pages[i].full);
        i += 1;
      } else {
        const pair = (i + 1 < pages.length && !pages[i + 1].landscape)
          ? pages.slice(i, i + 2) : pages.slice(i, i + 1);
        src = await composePair(pair, false);
        i += pair.length;
      }
      const div = document.createElement('div');
      div.className = 'print-page duo';
      const im = document.createElement('img');
      im.src = src;
      div.appendChild(im);
      container.appendChild(div);
    }
    await firePrint(container);
  } finally {
    btn.textContent = label;
  }
}

init();

// ---- 解説動画モーダル（YouTube IFrame API・算数アプリ daily-support と同じ挙動）----
// YouTubeアプリへ遷移せずその場で再生。速度は 1x/1.5x/2x（既定1.5x）。
let ytPlayer = null, ytPlayerReady = false, pendingVideo = null, currentVideoSpeed = 1.5;
function onYouTubeIframeAPIReady() {
  ytPlayerReady = true;
  if (pendingVideo) { createPlayer(pendingVideo); pendingVideo = null; }
}
function createPlayer(videoId) {
  const wrap = document.getElementById('video-player-wrap');
  wrap.innerHTML = '<div id="yt-player"></div>';
  ytPlayer = new YT.Player('yt-player', {
    videoId, width: '100%', height: '100%',
    playerVars: { autoplay: 1, playsinline: 1, rel: 0, vq: 'hd720' },
    events: {
      onReady: (e) => e.target.setPlaybackRate(currentVideoSpeed),
      onPlaybackRateChange: (e) => { currentVideoSpeed = e.data; updateSpeedButtons(); },
    },
  });
}
function openVideoModal(videoId, label) {
  currentVideoSpeed = 1.5;
  document.getElementById('video-modal-title').textContent = label || '';
  document.getElementById('video-modal').classList.add('active');
  updateSpeedButtons();
  if (ytPlayerReady && window.YT && YT.Player) createPlayer(videoId);
  else pendingVideo = videoId;
}
function closeVideoModal(e) {
  if (e && e.target !== e.currentTarget && !e.target.classList.contains('video-modal-close')) return;
  document.getElementById('video-modal').classList.remove('active');
  if (ytPlayer && ytPlayer.destroy) { ytPlayer.destroy(); ytPlayer = null; }
  document.getElementById('video-player-wrap').innerHTML = '';
}
function setVideoSpeed(speed) {
  currentVideoSpeed = speed;
  if (ytPlayer && ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(speed);
  updateSpeedButtons();
}
function updateSpeedButtons() {
  document.querySelectorAll('.video-speed-btn').forEach((btn) =>
    btn.classList.toggle('active', parseFloat(btn.textContent) === currentVideoSpeed));
}
