/* ===== 過去問アプリ ロジック ===== */
'use strict';

const state = {
  schools: [],        // schools.json
  schoolCache: {},    // id -> data/{id}.json
  school: null,       // 現在の学校データ
  exam: null,         // 現在の試験（年度・回）
  subject: null,      // 現在の教科
  view: 'question',   // 'question' | 'expl'
};

const $ = (sel) => document.querySelector(sel);

// 画像repoのベースURL（ローカル開発時は隣のディレクトリを参照）
const IMG_V = 2; // 画像を全差し替えしたら+1（キャッシュ破棄用）
function imgBase(school) {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  return local ? school.imgBaseLocal : school.imgBaseProd;
}
function imgUrl(p) { return `${imgBase(state.school)}/${p}?v=${IMG_V}`; }

// ---- 初期化 ----
async function init() {
  try {
    const res = await fetch('schools.json', { cache: 'no-store' });
    state.schools = await res.json();
    renderHome();
  } catch (e) {
    $('#school-list').innerHTML = '<p class="loading">学校一覧の読み込みに失敗しました。</p>';
    console.error(e);
  }
  $('#back-btn').addEventListener('click', goBack);
  document.querySelectorAll('#detail .tab').forEach((t) =>
    t.addEventListener('click', () => switchView(t.dataset.view)));
  $('#lightbox-close').addEventListener('click', closeLightbox);
  $('#info-print-btn').addEventListener('click', () => printInfo());
}

// ---- 画面遷移 ----
function showScreen(id) {
  for (const s of ['home', 'school', 'info', 'detail']) $('#' + s).hidden = (s !== id);
  $('#back-btn').hidden = (id === 'home');
  window.scrollTo(0, 0);
}
function goBack() {
  if (!$('#detail').hidden || !$('#info').hidden) { showScreen('school'); return; }
  state.school = null;
  showScreen('home');
}

// ---- 学校一覧 ----
function renderHome() {
  if (!state.schools.length) {
    $('#school-list').innerHTML = '<p class="loading">まだ学校がありません。</p>';
    return;
  }
  const html = '<div class="school-grid">' + state.schools.map((s) => `
    <div class="school-card" data-id="${s.id}">
      <span class="school-icon">🏫</span>
      <div>
        <div class="school-name">${s.name}</div>
        <div class="school-sub">${s.yearsLabel || ''}</div>
      </div>
    </div>`).join('') + '</div>';
  const list = $('#school-list');
  list.innerHTML = html;
  list.querySelectorAll('.school-card').forEach((c) =>
    c.addEventListener('click', () => openSchool(c.dataset.id)));
}

// ---- 学校トップ ----
async function openSchool(id) {
  let data = state.schoolCache[id];
  if (!data) {
    const res = await fetch(`data/${id}.json`, { cache: 'no-store' });
    data = await res.json();
    state.schoolCache[id] = data;
  }
  state.school = data;
  $('#school-title').textContent = `🏫 ${data.name}`;
  // 学校情報カード + 年度グループ
  let html = '';
  if (data.info && data.info.pages.length) {
    html += `
      <div class="exam-card info-card" id="open-info">
        <span class="school-icon">📋</span>
        <div>
          <div class="exam-name">学校情報・出題傾向&対策</div>
          <div class="exam-sub">受験情報・教科別の出題分析</div>
        </div>
      </div>`;
  }
  const byYear = {};
  for (const ex of data.exams) (byYear[ex.year] || (byYear[ex.year] = [])).push(ex);
  const roundOrder = (r) => ({ '1': 1, '2': 2, '3': 3 }[String(r)] || 9);
  for (const y in byYear) byYear[y].sort((a, b) => roundOrder(a.round) - roundOrder(b.round));
  const years = Object.keys(byYear).sort().reverse();
  for (const y of years) {
    html += `<section class="year-group"><h3 class="year-head">${y}年度</h3><div class="exam-grid">`;
    for (const ex of byYear[y]) {
      const subs = ex.subjects.map((s) => s.name).join('・');
      html += `
        <div class="exam-card" data-id="${ex.id}">
          <div class="exam-name">${ex.label}</div>
          <div class="exam-sub">${ex.roundNote ? ex.roundNote + '／' : ''}${subs}</div>
        </div>`;
    }
    html += '</div></section>';
  }
  const list = $('#exam-list');
  list.innerHTML = html;
  const infoCard = $('#open-info');
  if (infoCard) infoCard.addEventListener('click', openInfo);
  list.querySelectorAll('.exam-card[data-id]').forEach((c) =>
    c.addEventListener('click', () => openExam(c.dataset.id)));
  showScreen('school');
}

// ---- 学校情報・出題傾向 ----
function openInfo() {
  $('#info-title').textContent = `📋 ${state.school.name} 学校情報・出題傾向&対策`;
  $('#info-stack').innerHTML = state.school.info.pages.map((p, i) => `
    <div class="page-item">
      <img src="${imgUrl(p.small)}" data-full="${imgUrl(p.full)}" alt="ページ${i + 1}" loading="lazy">
    </div>`).join('');
  bindLightbox($('#info-stack'));
  showScreen('info');
}

// ---- 試験詳細 ----
function openExam(examId) {
  state.exam = state.school.exams.find((e) => e.id === examId);
  state.subject = state.exam.subjects[0];
  state.view = 'question';
  $('#detail-title').textContent = `${state.school.name} ${state.exam.label}${state.exam.roundNote ? '（' + state.exam.roundNote + '）' : ''}`;
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

function renderDetail() {
  const sub = state.subject;
  const note = $('#view-note');
  const stack = $('#page-stack');
  let html = renderGrading();
  if (state.view === 'question') {
    note.textContent = `${sub.name}（${sub.minutes ? sub.minutes + '分' : ''}${sub.maxScore ? '・満点' + sub.maxScore + '点' : ''}）問題と解答用紙です。画像タップで拡大。`;
    html += `<h3 class="section-head">問題</h3>`;
    html += sub.questionPages.map((p, i) => pageImg(p, i, '問題')).join('');
    if (sub.sheetPages && sub.sheetPages.length) {
      html += `<h3 class="section-head">解答用紙</h3>`;
      html += sub.sheetPages.map((p, i) => pageImg(p, i, '解答用紙')).join('');
    }
  } else {
    note.textContent = state.exam.ansOnly
      ? `${sub.name}の解答です（この回は解答のみ収録・全教科分をまとめて表示しています）。`
      : `${sub.name}の解答解説です。画像タップで拡大。`;
    html += sub.explPages.map((p, i) => pageImg(p, i, '解説')).join('');
  }
  stack.innerHTML = html;
  bindLightbox(stack);
  bindGrading();
  renderPrintButtons();
}

function renderPrintButtons() {
  const g = $('#print-group');
  if (state.view === 'question') {
    g.innerHTML = `
      <button class="print-btn" id="pr-q">🖨 問題（B4横 2面）</button>
      <button class="print-btn" id="pr-s">🖨 解答用紙（B4拡大）</button>`;
    $('#pr-q').addEventListener('click', () => printDuo(state.subject.questionPages, state.subject.rtl));
    $('#pr-s').addEventListener('click', () => printSheets(state.subject.sheetPages));
  } else {
    g.innerHTML = `<button class="print-btn" id="pr-e">🖨 解説（B4横 2面）</button>`;
    $('#pr-e').addEventListener('click', () => printDuo(state.subject.explPages, false));
  }
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
  let rows = '';
  for (const q of qs) {
    rows += `<tr><td class="q-label">${q}</td>`;
    for (let t = 0; t < 3; t++) {
      const v = g.attempts[t].marks[q] || '';
      rows += `<td><button class="mark-btn ${v}" data-q="${q}" data-t="${t}">${v === 'o' ? '○' : v === 'x' ? '×' : '・'}</button></td>`;
    }
    rows += '</tr>';
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
        <table class="grade-table">
          <thead><tr><th>問題</th><th>1回目</th><th>2回目</th><th>3回目</th></tr></thead>
          <tbody>
            <tr><td class="q-label">取り組んだ日</td>${dateCells}</tr>
            ${rows}
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
      const g = loadGrades();
      const { q, t } = btn.dataset;
      const cur = g.attempts[t].marks[q] || '';
      const next = cur === '' ? 'o' : cur === 'o' ? 'x' : '';  // ・→○→×→・
      g.attempts[t].marks[q] = next;
      saveGrades(g);
      btn.className = `mark-btn ${next}`;
      btn.textContent = next === 'o' ? '○' : next === 'x' ? '×' : '・';
      const counts = g.attempts.map((a) => {
        const o = Object.values(a.marks).filter((v) => v === 'o').length;
        return `${o}/${(state.subject.questions || []).length}`;
      });
      const el = document.querySelector('.grade-count');
      if (el) el.textContent = `正解数 ${counts.join(' ／ ')}`;
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

// B4横に2面付け。rtl=true（国語）はペア内で右→左に配置
function printDuo(pages, rtl) {
  if (!pages || !pages.length) return;
  setPageStyle('@media print { @page { size: B4 landscape; margin: 8mm; } }');
  const container = $('#print-container');
  let html = '';
  for (let i = 0; i < pages.length; i += 2) {
    const pair = pages.slice(i, i + 2);
    // DOMは左→右に並ぶ。RTLはペアを逆順にして [2枚目, 1枚目] と置くと 1枚目が右になる
    const ordered = rtl ? pair.slice().reverse() : pair;
    const align = pair.length === 1 ? (rtl ? 'align-right' : 'align-left') : '';
    html += `<div class="print-page duo ${align}">` +
      ordered.map((p) => `<img src="${imgUrl(p.full)}">`).join('') + '</div>';
  }
  container.innerHTML = html;
  firePrint(container);
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

function printInfo() {
  printDuo(state.school.info.pages, false);
}

init();
