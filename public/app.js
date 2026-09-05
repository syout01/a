import { csvToObjects, decodeBytes, guessMapping, applyMapping, TARGET_FIELDS } from '/csv.js';

// ---------- 共通 ----------
const state = {
  config: null, exhibitions: [], members: [], segments: [], rules: [],
  exhibitionId: +localStorage.getItem('exhibitionId') || null,
  me: null, meId: null,
  importData: null,
  follow: { mode: 'today', segment: '', status: '', q: '', assignee: null, selectedId: null, items: [] },
  assign: { segment: '', assignee: '', q: '', selected: new Set(), items: [], total: 0 },
};
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v) => (v == null ? '-' : `${(v * 100).toFixed(1)}%`);
const fmtDt = (s) => (s ? String(s).slice(0, 16) : '');

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.replace('/login.html'); throw new Error('ログインが必要です'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const isAdmin = () => state.me?.role === 'admin';
let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg; el.className = `toast${isError ? ' error' : ''}`; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3000);
}
const onErr = (e) => { console.error(e); toast(e.message || String(e), true); };

const ex = () => state.exhibitions.find((e) => e.id === state.exhibitionId) || null;
const seg = (code) => state.segments.find((s) => s.code === code);
const segBadge = (code) => { const s = seg(code); return `<span class="badge" style="background:${esc(s?.color || '#777')}">${esc(s?.label || code || '-')}</span>`; };
const statusLabel = (code) => state.config?.statuses.find((s) => s.code === code)?.label || code;
const activeMembers = () => state.members.filter((m) => m.active);

async function loadBase() {
  const [{ user }, config, exhibitions, members, segments, rules] = await Promise.all([
    api('/api/auth/me'), api('/api/config'), api('/api/exhibitions'), api('/api/members'), api('/api/segments'), api('/api/rules'),
  ]);
  Object.assign(state, { me: user, meId: user.id, config, exhibitions, members, segments, rules });
  if (!ex() && exhibitions.length) state.exhibitionId = exhibitions[0].id;
  renderHeader();
}

function renderHeader() {
  const exSel = $('#exhibitionSelect');
  exSel.innerHTML = state.exhibitions.map((e) => `<option value="${e.id}" ${e.id === state.exhibitionId ? 'selected' : ''}>${esc(e.name)}${e.held_on ? `（${esc(e.held_on)}）` : ''} / ${e.lead_count}件</option>`).join('') || '<option value="">（展示会を作成してください）</option>';
  exSel.onchange = () => { state.exhibitionId = +exSel.value || null; localStorage.setItem('exhibitionId', state.exhibitionId || ''); state.follow.selectedId = null; state.assign.selected.clear(); route(); };
  $('#meBox').innerHTML = `<span>${esc(state.me.name)}</span><span class="role">${state.me.role === 'admin' ? '管理者' : '担当者'}</span><button class="small" id="logout">ログアウト</button>`;
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); location.replace('/login.html'); };
  // 担当者には管理者専用タブを出さない
  const adminTabs = ['#/import', '#/rules', '#/assign'];
  $$('#tabs a').forEach((a) => { a.hidden = !isAdmin() && adminTabs.includes(a.getAttribute('href')); });
}

// ---------- ルーター ----------
const routes = { import: renderImport, rules: renderRules, assign: renderAssign, follow: renderFollow, dashboard: renderDashboard, export: renderExport, settings: renderSettings };
const ADMIN_ROUTES = new Set(['import', 'rules', 'assign']);
function route() {
  let key = (location.hash.replace(/^#\//, '') || (isAdmin() ? 'import' : 'follow')).split('?')[0];
  if (!isAdmin() && ADMIN_ROUTES.has(key)) key = 'follow';
  const fn = routes[key] || renderFollow;
  $$('#tabs a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/${key}`));
  const view = $('#view');
  view.innerHTML = '<p class="muted">読み込み中…</p>';
  Promise.resolve(fn(view)).catch(onErr);
}
window.addEventListener('hashchange', route);

function needExhibition(view) {
  if (ex()) return false;
  view.innerHTML = `<div class="card"><h2>展示会がまだありません</h2><p>まず <a href="#/import">① 取り込み</a> で展示会を作成してください。</p></div>`;
  return true;
}

// ---------- ① 取り込み ----------
async function renderImport(view) {
  const e = ex();
  view.innerHTML = `
    <div class="grid2">
      <div class="card">
        <h2>展示会を作成</h2>
        <form id="exForm" class="row">
          <input type="text" name="name" placeholder="展示会名（例：Japan IT Week 秋）" required style="min-width:260px">
          <input type="date" name="held_on">
          <input type="text" name="venue" placeholder="会場（任意）">
          <button class="primary">作成</button>
        </form>
      </div>
      <div class="card">
        <h2>現在の展示会</h2>
        ${e ? `<div><b>${esc(e.name)}</b> ${e.held_on ? esc(e.held_on) : ''} ${e.venue ? '／' + esc(e.venue) : ''}<div class="muted small mt">取り込み済み ${e.lead_count} 件。ヘッダーの「展示会」で切り替えできます。</div></div>` : '<p class="muted">左のフォームから作成してください。</p>'}
      </div>
    </div>
    ${e ? `
    <div class="card">
      <h2>バーコードリストの CSV を取り込む（${esc(e.name)}）</h2>
      <p class="muted small">主催者から届く来場者CSV／バッジスキャンデータをそのまま入れてください。UTF-8 と Shift_JIS を自動判別します。列名はこのあと対応付けできます。</p>
      <div id="drop" class="dropzone">ここに CSV をドラッグ＆ドロップ、または <label style="color:var(--primary);cursor:pointer;text-decoration:underline">ファイルを選択<input id="file" type="file" accept=".csv,.tsv,.txt" hidden></label></div>
      <div id="importArea"></div>
    </div>` : ''}
  `;
  $('#exForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      const created = await api('/api/exhibitions', { method: 'POST', body: Object.fromEntries(fd) });
      state.exhibitionId = created.id; localStorage.setItem('exhibitionId', created.id);
      await loadBase(); toast('展示会を作成しました'); route();
    } catch (err) { onErr(err); }
  };
  if (!e) return;
  const drop = $('#drop');
  drop.ondragover = (ev) => { ev.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (ev) => { ev.preventDefault(); drop.classList.remove('over'); if (ev.dataTransfer.files[0]) handleFile(ev.dataTransfer.files[0]); };
  $('#file').onchange = (ev) => { if (ev.target.files[0]) handleFile(ev.target.files[0]); };
  if (state.importData && state.importData.exhibitionId === e.id) renderMapping();

  async function handleFile(file) {
    const buf = await file.arrayBuffer();
    const { text, encoding } = decodeBytes(buf);
    const { headers, records } = csvToObjects(text);
    if (!headers.length || !records.length) return toast('CSV に行がありません', true);
    const saved = e.mapping && Object.values(e.mapping).every((c) => c === '__combine_last_first__' || headers.includes(c)) ? e.mapping : null;
    state.importData = { exhibitionId: e.id, fileName: file.name, encoding, headers, records, mapping: saved || guessMapping(headers, records), createMembers: true, preview: null, result: null };
    renderMapping();
  }

  function renderMapping() {
    const d = state.importData;
    const fields = TARGET_FIELDS.map((f) => [f.key, f.label]);
    const opt = (key) => {
      const cur = d.mapping[key] || '';
      let html = `<option value="">（取り込まない）</option>`;
      if (key === 'name') html += `<option value="__combine_last_first__" ${cur === '__combine_last_first__' ? 'selected' : ''}>姓＋名を結合</option>`;
      html += d.headers.map((h) => `<option value="${esc(h)}" ${cur === h ? 'selected' : ''}>${esc(h)}</option>`).join('');
      return html;
    };
    const mapped = d.records.slice(0, 8).map((r) => applyMapping(r, d.mapping, d.headers));
    $('#importArea').innerHTML = `
      <div class="row between mt"><div><b>${esc(d.fileName)}</b> <span class="chip">${esc(d.encoding)}</span> <span class="chip">${d.records.length} 行</span> <span class="chip">${d.headers.length} 列</span></div>
        <button id="clearImport" class="small">クリア</button></div>
      <h3>列の対応付け</h3>
      <div class="grid3">
        ${fields.map(([k, label]) => `<label class="row"><span style="width:150px">${label}</span><select data-map="${k}" style="flex:1">${opt(k)}</select></label>`).join('')}
      </div>
      <p class="muted small">対応付けしなかった列も「その他の項目」として保存され、フォロー画面の表示・ルール条件（extra.列名）・書き出しに使えます。
        「既存ランク」を対応付けると、その値に合うセグメント（A/B/C…）があればルールより優先して固定します。「担当者名」はフォロー担当になり、
        <label><input type="checkbox" id="createMembers" ${d.createMembers ? 'checked' : ''}> 未登録の名前は担当者として自動登録</label></p>
      <h3>プレビュー（先頭 8 行）</h3>
      <div class="scroll"><table class="tbl"><thead><tr><th>会社名</th><th>氏名</th><th>部署</th><th>役職</th><th>メール</th><th>電話</th><th>業種</th><th>従業員数</th><th>メモ</th><th>既存ランク</th><th>担当</th><th>対応メモ</th><th>その他</th></tr></thead>
      <tbody>${mapped.map((l) => `<tr><td>${esc(l.company)}</td><td>${esc(l.name)}</td><td>${esc(l.department)}</td><td>${esc(l.title)}</td><td>${esc(l.email)}</td><td>${esc(l.phone)}</td><td>${esc(l.industry)}</td><td>${esc(l.employees)}</td><td>${esc(l.memo)}</td><td>${esc(l.segment_hint)}</td><td>${esc(l.assignee_name)}</td><td>${esc(l.note)}</td><td class="small muted">${esc(Object.entries(l.extra).map(([k, v]) => `${k}=${v}`).join(' / ').slice(0, 80))}</td></tr>`).join('')}</tbody></table></div>
      <div class="row mt">
        <button id="dryRun">判定プレビュー（書き込まない）</button>
        <button id="doImport" class="primary">この内容で取り込む</button>
        <span id="importMsg" class="muted small"></span>
      </div>
      <div id="importResult" class="mt"></div>`;
    $$('select[data-map]').forEach((s) => { s.onchange = () => { d.mapping[s.dataset.map] = s.value; if (s.dataset.map === 'name' && s.value && s.value !== '__combine_last_first__') { /* 氏名を直接選んだら姓名結合は解除 */ } renderMapping(); }; });
    $('#clearImport').onclick = () => { state.importData = null; $('#importArea').innerHTML = ''; };
    $('#createMembers').onchange = (ev) => { d.createMembers = ev.target.checked; };
    const buildLeads = () => d.records.map((r) => applyMapping(r, d.mapping, d.headers));
    const showResult = (r) => {
      $('#importResult').innerHTML = `<div class="${r.dry_run ? 'notice' : 'card'}">
        <b>${r.dry_run ? '判定プレビュー' : '取り込み完了'}</b>：取り込み ${r.imported} 件／重複スキップ ${r.duplicates} 件／過去展示会で接触あり ${r.returning} 件／空行 ${r.skipped_empty} 件
        <div class="row mt">${Object.entries(r.bySegment).map(([c, n]) => `${segBadge(c)} ${n}件`).join(' ')}</div>
        ${r.segment_from_csv ? `<div class="small mt">CSV の既存ランクを採用：${r.segment_from_csv} 件（手動固定扱い）</div>` : ''}
        ${Object.keys(r.segment_hint_unmatched || {}).length ? `<div class="small mt">対応するセグメントがなくルール判定にしたランク：${Object.entries(r.segment_hint_unmatched).map(([k, v]) => `「${esc(k)}」${v}件`).join('、')}。<a href="#/settings">設定</a>でセグメントを追加して再取り込みすると採用されます。</div>` : ''}
        ${r.assigned_from_csv ? `<div class="small mt">CSV の担当者名で割当：${r.assigned_from_csv} 件${r.members_created?.length ? `（新規登録：${esc([...new Set(r.members_created)].join('、'))}）` : ''}</div>` : ''}
        ${r.dry_run ? '' : '<div class="mt">次は <a href="#/assign">③ 担当割当</a> へ。</div>'}</div>`;
    };
    $('#dryRun').onclick = async () => {
      try { showResult(await api(`/api/exhibitions/${e.id}/import`, { method: 'POST', body: { leads: buildLeads(), mapping: d.mapping, dry_run: true, create_members: d.createMembers } })); } catch (err) { onErr(err); }
    };
    $('#doImport').onclick = async () => {
      if (!confirm(`${d.records.length} 行を「${e.name}」に取り込みます。よろしいですか？`)) return;
      try {
        const r = await api(`/api/exhibitions/${e.id}/import`, { method: 'POST', body: { leads: buildLeads(), mapping: d.mapping, create_members: d.createMembers } });
        await loadBase(); showResult(r); toast(`${r.imported} 件を取り込みました`);
      } catch (err) { onErr(err); }
    };
  }
}

// ---------- ② 振り分けルール ----------
async function renderRules(view) {
  state.rules = await api('/api/rules');
  const e = ex();
  view.innerHTML = `
    <div class="card">
      <h2>セグメント</h2>
      <div class="row">${state.segments.map((s) => `<div>${segBadge(s.code)} <span class="small muted">${esc(s.action || '')}${s.is_excluded ? '（割当対象外）' : ''}</span></div>`).join('')}</div>
      <p class="muted small">セグメントの追加・編集は <a href="#/settings">設定</a> から。</p>
    </div>
    <div class="card">
      <div class="row between"><h2>振り分けルール</h2>
        <div class="row">
          ${e ? `<label class="small"><input type="checkbox" id="overwriteLocked"> 手動で変更した分も上書き</label><button id="reclassify">「${esc(e.name)}」を再判定</button>` : ''}
          <button id="addRule" class="primary">＋ ルールを追加</button>
        </div></div>
      <p class="muted small">優先度の小さい順に評価し、最初に一致したルールのセグメントになります。どれにも当たらなければ「未分類」です。</p>
      <div id="ruleList"></div>
    </div>`;
  const list = $('#ruleList');
  const fields = state.config.fields;
  const ops = state.config.operators;
  const noValueOps = new Set(['is_empty', 'not_empty']);

  const ruleHtml = (r, idx) => `
    <div class="rule ${r.enabled ? '' : 'disabled'}" data-idx="${idx}">
      <div class="rule-head">
        <label class="small"><input type="checkbox" data-k="enabled" ${r.enabled ? 'checked' : ''}> 有効</label>
        <input type="text" data-k="name" value="${esc(r.name)}" placeholder="ルール名" style="min-width:220px">
        <span class="small muted">優先度</span><input type="number" data-k="priority" value="${r.priority}" style="width:70px">
        <span class="small muted">→</span>
        <select data-k="segment_code">${state.segments.map((s) => `<option value="${s.code}" ${s.code === r.segment_code ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
        <select data-k="match_mode"><option value="all" ${r.match_mode === 'all' ? 'selected' : ''}>すべての条件に一致</option><option value="any" ${r.match_mode === 'any' ? 'selected' : ''}>いずれかの条件に一致</option></select>
        <span style="flex:1"></span>
        <button class="small primary" data-act="save">保存</button>
        <button class="small danger" data-act="del">削除</button>
      </div>
      <div class="conds mt">
        ${r.conditions.map((c, ci) => condHtml(c, ci)).join('')}
        <button class="small" data-act="addCond">＋ 条件</button>
      </div>
    </div>`;
  const condHtml = (c, ci) => {
    const isCustom = c.field && c.field.startsWith('extra.');
    return `<div class="cond-row" data-ci="${ci}">
      <div class="row" style="gap:4px"><select data-c="field" style="flex:1">${fields.map((f) => `<option value="${f.key}" ${f.key === c.field ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}<option value="__custom__" ${isCustom ? 'selected' : ''}>その他の列…</option></select></div>
      <select data-c="op">${ops.map((o) => `<option value="${o.key}" ${o.key === c.op ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
      <div class="row" style="gap:4px">${isCustom ? `<input type="text" data-c="customField" value="${esc(c.field.slice(6))}" placeholder="列名" style="width:130px">` : ''}<input type="text" data-c="value" value="${esc(c.value ?? '')}" placeholder="${noValueOps.has(c.op) ? '（値は不要）' : '値'}" style="flex:1" ${noValueOps.has(c.op) ? 'disabled' : ''}></div>
      <button class="small danger" data-act="delCond">×</button>
    </div>`;
  };
  const draw = () => { list.innerHTML = state.rules.map(ruleHtml).join('') || '<p class="muted">ルールがありません。</p>'; };
  draw();

  const readRule = (card) => {
    const idx = +card.dataset.idx;
    const r = state.rules[idx];
    r.enabled = $('[data-k=enabled]', card).checked ? 1 : 0;
    r.name = $('[data-k=name]', card).value;
    r.priority = +$('[data-k=priority]', card).value;
    r.segment_code = $('[data-k=segment_code]', card).value;
    r.match_mode = $('[data-k=match_mode]', card).value;
    r.conditions = $$('.cond-row', card).map((row) => {
      const fsel = $('[data-c=field]', row).value;
      const custom = $('[data-c=customField]', row);
      return { field: fsel === '__custom__' ? `extra.${custom ? custom.value.trim() : ''}` : fsel, op: $('[data-c=op]', row).value, value: $('[data-c=value]', row).value };
    });
    return r;
  };
  list.onchange = (ev) => {
    const card = ev.target.closest('.rule'); if (!card) return;
    const t = ev.target;
    if (t.dataset.c === 'field' || t.dataset.c === 'op') { readRule(card); draw(); }
  };
  list.onclick = async (ev) => {
    const btn = ev.target.closest('button[data-act]'); if (!btn) return;
    const card = btn.closest('.rule'); const idx = +card.dataset.idx; const r = readRule(card);
    const act = btn.dataset.act;
    if (act === 'addCond') { r.conditions.push({ field: 'title', op: 'contains', value: '' }); draw(); return; }
    if (act === 'delCond') { r.conditions.splice(+btn.closest('.cond-row').dataset.ci, 1); draw(); return; }
    if (act === 'del') {
      if (r.id) { if (!confirm(`ルール「${r.name}」を削除しますか？`)) return; await api(`/api/rules/${r.id}`, { method: 'DELETE' }).catch(onErr); }
      state.rules.splice(idx, 1); draw(); return;
    }
    if (act === 'save') {
      try {
        const saved = r.id ? await api(`/api/rules/${r.id}`, { method: 'PUT', body: r }) : await api('/api/rules', { method: 'POST', body: r });
        state.rules[idx] = saved; state.rules.sort((a, b) => a.priority - b.priority || a.id - b.id); draw(); toast('ルールを保存しました');
      } catch (err) { onErr(err); }
    }
  };
  $('#addRule').onclick = () => { state.rules.push({ name: '', segment_code: state.segments[0]?.code, priority: (Math.max(0, ...state.rules.map((r) => r.priority)) || 0) + 10, match_mode: 'any', enabled: 1, conditions: [{ field: 'title', op: 'contains', value: '' }] }); draw(); list.lastElementChild?.scrollIntoView({ behavior: 'smooth' }); };
  if (e) $('#reclassify').onclick = async () => {
    try {
      const r = await api(`/api/exhibitions/${e.id}/reclassify`, { method: 'POST', body: { overwrite_locked: $('#overwriteLocked').checked } });
      toast(`${r.total} 件中 ${r.changed} 件のセグメントが変わりました：` + Object.entries(r.bySegment).map(([c, n]) => `${seg(c)?.label || c} ${n}`).join('、'));
    } catch (err) { onErr(err); }
  };
}

// ---------- ③ 担当割当 ----------
async function renderAssign(view) {
  if (needExhibition(view)) return;
  const e = ex();
  const a = state.assign;
  const sum = await api(`/api/exhibitions/${e.id}/summary`);
  const members = activeMembers();
  view.innerHTML = `
    <div class="grid2">
      <div class="card">
        <h2>セグメント × 担当（${esc(e.name)}）</h2>
        <div class="scroll"><table class="tbl"><thead><tr><th>セグメント</th>${members.map((m) => `<th class="num">${esc(m.name)}</th>`).join('')}<th class="num">未割当</th><th class="num">合計</th></tr></thead>
        <tbody>${state.segments.map((s) => { const c = sum.cross[s.code] || {}; const vals = members.map((m) => c[m.id] || 0); const tot = vals.reduce((x, y) => x + y, 0) + (c.unassigned || 0); return `<tr><td>${segBadge(s.code)}</td>${vals.map((v) => `<td class="num">${v}</td>`).join('')}<td class="num ${c.unassigned ? 'warn' : ''}">${c.unassigned || 0}</td><td class="num"><b>${tot}</b></td></tr>`; }).join('')}</tbody></table></div>
      </div>
      <div class="card">
        <h2>自動で振り分ける（ラウンドロビン）</h2>
        <h3>担当者</h3>
        <div class="row">${members.map((m) => `<label><input type="checkbox" name="mem" value="${m.id}" checked> ${esc(m.name)}</label>`).join('') || '<span class="muted">設定で担当者を追加してください</span>'}</div>
        <h3>対象セグメント</h3>
        <div class="row">${state.segments.filter((s) => !s.is_excluded).map((s) => `<label><input type="checkbox" name="segc" value="${s.code}" ${s.code === 'U' ? '' : 'checked'}> ${esc(s.label)}</label>`).join('')}</div>
        <h3>対象</h3>
        <div class="row"><label><input type="radio" name="mode" value="unassigned" checked> 未割当のみ</label><label><input type="radio" name="mode" value="all"> 全件を割り当て直す</label></div>
        <div class="mt"><button id="runAssign" class="primary">割当を実行</button> <span class="muted small">セグメント優先度の高い順に配るので、A ランクも人ごとに均等になります。</span></div>
      </div>
    </div>
    <div class="card">
      <div class="row between"><h2>リード一覧</h2>
        <div class="row">
          <select id="fSeg"><option value="">全セグメント</option>${state.segments.map((s) => `<option value="${s.code}" ${a.segment === s.code ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
          <select id="fAss"><option value="">全担当</option><option value="0" ${a.assignee === '0' ? 'selected' : ''}>未割当</option>${members.map((m) => `<option value="${m.id}" ${a.assignee == m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
          <input type="text" id="fQ" placeholder="会社名・氏名・メモで検索" value="${esc(a.q)}">
        </div></div>
      <div class="row mt">
        <span id="selCount" class="chip">0 件選択</span>
        <select id="bulkMember"><option value="">担当を変更…</option><option value="0">（未割当にする）</option>${members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
        <select id="bulkSeg"><option value="">セグメントを変更…</option>${state.segments.map((s) => `<option value="${s.code}">${esc(s.label)}</option>`).join('')}</select>
      </div>
      <div class="scroll mt" id="leadTable"></div>
      <div class="row mt"><span id="leadTotal" class="muted small"></span><button id="more" class="small">さらに読み込む</button></div>
    </div>`;

  $('#runAssign').onclick = async () => {
    const member_ids = $$('input[name=mem]:checked').map((i) => +i.value);
    const segment_codes = $$('input[name=segc]:checked').map((i) => i.value);
    const mode = $('input[name=mode]:checked').value;
    if (!member_ids.length) return toast('担当者を選んでください', true);
    if (mode === 'all' && !confirm('選んだセグメントの全件を割り当て直します。よろしいですか？')) return;
    try { const r = await api(`/api/exhibitions/${e.id}/assign`, { method: 'POST', body: { member_ids, segment_codes, mode } }); toast(`${r.assigned} 件を割り当てました`); renderAssign(view); } catch (err) { onErr(err); }
  };
  const loadLeads = async (append = false) => {
    const params = new URLSearchParams({ exhibition_id: e.id, limit: 200, offset: append ? a.items.length : 0, sort: 'priority' });
    if (a.segment) params.set('segment', a.segment);
    if (a.assignee !== '' && a.assignee != null) params.set('assignee_id', a.assignee);
    if (a.q) params.set('q', a.q);
    const r = await api(`/api/leads?${params}`);
    a.items = append ? a.items.concat(r.items) : r.items; a.total = r.total;
    drawTable();
  };
  const drawTable = () => {
    $('#leadTable').innerHTML = `<table class="tbl"><thead><tr><th><input type="checkbox" id="selAll"></th><th>セグメント</th><th>会社名</th><th>氏名</th><th>役職</th><th>業種</th><th>担当</th><th>ステータス</th><th>メモ</th></tr></thead>
      <tbody>${a.items.map((l) => `<tr data-id="${l.id}" class="${a.selected.has(l.id) ? 'selected' : ''}"><td><input type="checkbox" data-sel="${l.id}" ${a.selected.has(l.id) ? 'checked' : ''}></td><td>${segBadge(l.segment_code)}${l.segment_locked ? ' <span class="chip small" title="手動で固定">固定</span>' : ''}</td><td>${esc(l.company)}${l.returning_lead_id ? ' <span class="chip warn">過去接触</span>' : ''}</td><td>${esc(l.name)}</td><td>${esc(l.title)}</td><td>${esc(l.industry)}</td><td>${esc(l.assignee_name || '')}</td><td>${esc(statusLabel(l.status))}</td><td class="small muted">${esc((l.memo || '').slice(0, 40))}</td></tr>`).join('')}</tbody></table>`;
    $('#leadTotal').textContent = `${a.items.length} / ${a.total} 件`;
    $('#more').disabled = a.items.length >= a.total;
    $('#selCount').textContent = `${a.selected.size} 件選択`;
    $('#selAll').onchange = (ev) => { a.items.forEach((l) => (ev.target.checked ? a.selected.add(l.id) : a.selected.delete(l.id))); drawTable(); };
    $$('input[data-sel]').forEach((cb) => { cb.onchange = () => { cb.checked ? a.selected.add(+cb.dataset.sel) : a.selected.delete(+cb.dataset.sel); cb.closest('tr').classList.toggle('selected', cb.checked); $('#selCount').textContent = `${a.selected.size} 件選択`; }; });
  };
  $('#fSeg').onchange = (ev) => { a.segment = ev.target.value; loadLeads().catch(onErr); };
  $('#fAss').onchange = (ev) => { a.assignee = ev.target.value; loadLeads().catch(onErr); };
  let qt; $('#fQ').oninput = (ev) => { clearTimeout(qt); qt = setTimeout(() => { a.q = ev.target.value; loadLeads().catch(onErr); }, 300); };
  $('#more').onclick = () => loadLeads(true).catch(onErr);
  const bulk = async (body) => {
    if (!a.selected.size) return toast('行を選択してください', true);
    try { await api('/api/leads/bulk', { method: 'POST', body: { ids: [...a.selected], ...body } }); toast(`${a.selected.size} 件を更新しました`); a.selected.clear(); renderAssign(view); } catch (err) { onErr(err); }
  };
  $('#bulkMember').onchange = (ev) => { if (ev.target.value !== '') bulk({ assignee_id: +ev.target.value }); };
  $('#bulkSeg').onchange = (ev) => { if (ev.target.value) bulk({ segment_code: ev.target.value }); };
  await loadLeads();
}

// ---------- ④ フォロー ----------
async function renderFollow(view) {
  if (needExhibition(view)) return;
  const e = ex();
  const f = state.follow;
  if (f.assignee == null) f.assignee = state.meId;
  const members = activeMembers();
  view.innerHTML = `
    <div class="card">
      <div class="row">
        <select id="fMode"><option value="today" ${f.mode === 'today' ? 'selected' : ''}>今日やるリスト</option><option value="overdue" ${f.mode === 'overdue' ? 'selected' : ''}>期限切れ（再コール漏れ）</option><option value="all" ${f.mode === 'all' ? 'selected' : ''}>すべて</option></select>
        <select id="fAssignee"><option value="">全担当</option><option value="0" ${f.assignee === 0 ? 'selected' : ''}>未割当</option>${members.map((m) => `<option value="${m.id}" ${f.assignee === m.id ? 'selected' : ''}>${esc(m.name)}${m.id === state.meId ? '（自分）' : ''}</option>`).join('')}</select>
        <select id="fSegment"><option value="">全セグメント</option>${state.segments.map((s) => `<option value="${s.code}" ${f.segment === s.code ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
        <select id="fStatus"><option value="">全ステータス</option>${state.config.statuses.map((s) => `<option value="${s.code}" ${f.status === s.code ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
        <input type="text" id="fSearch" placeholder="検索" value="${esc(f.q)}">
        <span id="fCount" class="chip"></span>
      </div>
    </div>
    <div class="follow-layout">
      <div class="card"><div class="scroll" style="max-height:75vh" id="followTable"></div></div>
      <div class="card detail" id="detail"><p class="muted">左のリストから 1 件選ぶと、ここに詳細とフォロー入力が出ます。</p></div>
    </div>`;
  const load = async () => {
    const params = new URLSearchParams({ exhibition_id: e.id, limit: 500, sort: 'priority' });
    if (f.mode !== 'all') params.set('due', f.mode);
    if (f.assignee !== '' && f.assignee != null) params.set('assignee_id', f.assignee);
    if (f.segment) params.set('segment', f.segment);
    if (f.status) params.set('status', f.status);
    if (f.q) params.set('q', f.q);
    const r = await api(`/api/leads?${params}`);
    f.items = r.items;
    $('#fCount').textContent = `${r.total} 件`;
    drawList();
  };
  const now = new Date();
  const drawList = () => {
    $('#followTable').innerHTML = f.items.length ? `<table class="tbl"><thead><tr><th>Seg</th><th>会社名 / 氏名</th><th>役職</th><th>電話</th><th>状態</th><th>次回</th><th>担当</th></tr></thead>
      <tbody>${f.items.map((l) => { const due = l.next_call_at && new Date(l.next_call_at.replace(' ', 'T')) < now; return `<tr class="clickable ${l.id === f.selectedId ? 'selected' : ''}" data-id="${l.id}"><td>${segBadge(l.segment_code)}</td><td><b>${esc(l.company)}</b><br><span class="small">${esc(l.name)}${l.returning_lead_id ? ' <span class="chip warn">過去接触</span>' : ''}</span></td><td class="small">${esc(l.title)}</td><td class="small">${esc(l.phone)}</td><td class="small">${esc(statusLabel(l.status))}</td><td class="small ${due ? 'danger' : ''}" style="${due ? 'color:var(--danger);font-weight:600' : ''}">${esc(fmtDt(l.next_call_at))}</td><td class="small">${esc(l.assignee_name || '-')}</td></tr>`; }).join('')}</tbody></table>` : '<p class="muted">該当するリードはありません。</p>';
    $$('#followTable tr[data-id]').forEach((tr) => { tr.onclick = () => openLead(+tr.dataset.id); });
  };
  const openLead = async (id) => {
    f.selectedId = id;
    $$('#followTable tr[data-id]').forEach((tr) => tr.classList.toggle('selected', +tr.dataset.id === id));
    const l = await api(`/api/leads/${id}`);
    drawDetail(l);
  };
  const toLocalInput = (s) => (s ? s.slice(0, 16).replace(' ', 'T') : '');
  const fromLocalInput = (s) => (s ? s.replace('T', ' ') + ':00' : null);
  const plusDays = (d, h = 9) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); const p = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:00`; };
  const drawDetail = (l) => {
    const extra = Object.entries(l.extra || {});
    $('#detail').innerHTML = `
      <div class="row between"><h2 style="margin:0">${esc(l.company)}</h2>${segBadge(l.segment_code)}</div>
      <div><b>${esc(l.name)}</b> <span class="muted">${esc([l.department, l.title].filter(Boolean).join(' / '))}</span></div>
      ${l.returning ? `<div class="notice mt small">過去の展示会「${esc(l.returning.exhibition_name)}」でも接触あり（当時：${esc(statusLabel(l.returning.status))}${l.returning.last_note ? '／' + esc(l.returning.last_note) : ''}）</div>` : ''}
      <dl>
        <dt>電話</dt><dd>${l.phone ? `<a href="tel:${esc(l.phone)}">${esc(l.phone)}</a>` : '-'}</dd>
        <dt>メール</dt><dd>${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : '-'}</dd>
        <dt>業種</dt><dd>${esc(l.industry) || '-'}</dd>
        <dt>従業員数</dt><dd>${esc(l.employees) || '-'}</dd>
        <dt>ブースメモ</dt><dd>${esc(l.memo) || '-'}</dd>
        ${extra.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
      </dl>
      <div class="row">
        <label class="small">セグメント <select id="dSeg">${state.segments.map((s) => `<option value="${s.code}" ${s.code === l.segment_code ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></label>
        <label class="small">担当 <select id="dAss"><option value="0">（未割当）</option>${members.map((m) => `<option value="${m.id}" ${m.id === l.assignee_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
      </div>
      <h3>フォロー結果を記録</h3>
      <div class="status-buttons" id="dStatus">${state.config.statuses.map((s) => `<button data-s="${s.code}" class="${s.code === l.status ? 'active' : ''}">${esc(s.label)}</button>`).join('')}</div>
      <div class="row mt"><label class="small">次回コール <input type="datetime-local" id="dNext" value="${toLocalInput(l.next_call_at)}"></label>
        <button class="small" data-q="1">明日 9時</button><button class="small" data-q="3">3日後</button><button class="small" data-q="7">1週間後</button><button class="small" data-q="clear">なし</button></div>
      <textarea id="dNote" class="mt" placeholder="ヒアリング内容・次回アクション（例：担当不在、9/10 午後に再コール）"></textarea>
      <div class="row mt"><button id="dSave" class="primary">記録して次へ</button><span class="muted small">記録者：${esc(state.me.name)}</span></div>
      <h3>履歴（${l.activities.length}）</h3>
      <ul class="history">${l.activities.map((a) => `<li><span class="muted small">${esc(fmtDt(a.created_at))} ${esc(a.member_name || '')}</span> <span class="chip">${esc(statusLabel(a.status))}</span> ${a.next_call_at ? `<span class="chip">次回 ${esc(fmtDt(a.next_call_at))}</span>` : ''}<div>${esc(a.note || '')}</div></li>`).join('') || '<li class="muted">まだ記録がありません</li>'}</ul>`;
    let status = l.status;
    $$('#dStatus button').forEach((b) => { b.onclick = () => { status = b.dataset.s; $$('#dStatus button').forEach((x) => x.classList.toggle('active', x === b)); }; });
    $$('button[data-q]').forEach((b) => { b.onclick = () => { $('#dNext').value = b.dataset.q === 'clear' ? '' : plusDays(+b.dataset.q); if (b.dataset.q !== 'clear' && status === 'new') { status = 'calling'; $$('#dStatus button').forEach((x) => x.classList.toggle('active', x.dataset.s === 'calling')); } }; });
    $('#dSeg').onchange = async (ev) => { try { await api(`/api/leads/${l.id}`, { method: 'PATCH', body: { segment_code: ev.target.value } }); toast('セグメントを変更しました（固定）'); load(); } catch (err) { onErr(err); } };
    $('#dAss').onchange = async (ev) => { try { await api(`/api/leads/${l.id}`, { method: 'PATCH', body: { assignee_id: +ev.target.value } }); toast('担当を変更しました'); load(); } catch (err) { onErr(err); } };
    $('#dSave').onclick = async () => {
      try {
        await api(`/api/leads/${l.id}/activities`, { method: 'POST', body: { status, note: $('#dNote').value, next_call_at: fromLocalInput($('#dNext').value) } });
        toast('記録しました');
        const idx = f.items.findIndex((x) => x.id === l.id);
        await load();
        const next = f.items.find((x) => x.id === l.id) ? f.items[Math.min(idx + 1, f.items.length - 1)] : f.items[Math.min(idx, f.items.length - 1)];
        if (next) openLead(next.id); else $('#detail').innerHTML = '<p class="muted">このリストは完了です 🎉</p>';
      } catch (err) { onErr(err); }
    };
  };
  $('#fMode').onchange = (ev) => { f.mode = ev.target.value; load().catch(onErr); };
  $('#fAssignee').onchange = (ev) => { f.assignee = ev.target.value === '' ? '' : +ev.target.value; load().catch(onErr); };
  $('#fSegment').onchange = (ev) => { f.segment = ev.target.value; load().catch(onErr); };
  $('#fStatus').onchange = (ev) => { f.status = ev.target.value; load().catch(onErr); };
  let st; $('#fSearch').oninput = (ev) => { clearTimeout(st); st = setTimeout(() => { f.q = ev.target.value; load().catch(onErr); }, 300); };
  await load();
  if (f.selectedId && f.items.find((x) => x.id === f.selectedId)) openLead(f.selectedId);
}

// ---------- ⑤ ダッシュボード ----------
async function renderDashboard(view) {
  if (needExhibition(view)) return;
  const e = ex();
  const s = await api(`/api/exhibitions/${e.id}/summary`);
  const t = s.total;
  const kpi = (v, l) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  const tbl = (rows, showBar = true) => `<table class="tbl"><thead><tr><th>区分</th><th class="num">件数</th><th class="num">架電済</th><th class="num">通電</th><th class="num">アポ</th><th class="num">資料</th><th class="num">残件</th><th class="num">通電率</th><th class="num">アポ率</th>${showBar ? '<th style="width:160px">消化率</th>' : ''}</tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${r.total}</td><td class="num">${r.touched}</td><td class="num">${r.connected}</td><td class="num"><b>${r.appointment}</b></td><td class="num">${r.sent_docs}</td><td class="num">${r.remaining}</td><td class="num">${pct(r.connect_rate)}</td><td class="num">${pct(r.appointment_rate)}</td>${showBar ? `<td><div class="bar"><span style="width:${r.total ? Math.round((r.total - r.remaining) / r.total * 100) : 0}%"></span></div></td>` : ''}</tr>`).join('')}</tbody></table>`;
  const maxCalls = Math.max(1, ...s.daily.map((d) => d.calls));
  view.innerHTML = `
    <h2 style="margin:0 0 12px">${esc(e.name)} ${e.held_on ? `<span class="muted small">${esc(e.held_on)}</span>` : ''}</h2>
    <div class="kpis">
      ${kpi(t.total, '総リード数')}${kpi(t.touched, '架電済み')}${kpi(pct(t.connect_rate), '通電率')}${kpi(t.appointment, 'アポ獲得')}${kpi(pct(t.appointment_rate), 'アポ率（通電比）')}${kpi(t.sent_docs, '資料送付')}${kpi(t.remaining, '残件')}${kpi(`<span style="color:${s.overdue ? 'var(--danger)' : 'inherit'}">${s.overdue}</span>`, '再コール期限切れ')}
    </div>
    <div class="grid2 mt">
      <div class="card"><h2>セグメント別</h2>${tbl(s.segRows.filter((r) => r.total))}</div>
      <div class="card"><h2>担当者別</h2>${tbl(s.memberRows.filter((r) => r.total))}</div>
    </div>
    <div class="grid2">
      <div class="card"><h2>ステータス分布</h2>
        ${s.statusRows.map((r) => `<div class="row" style="margin-bottom:6px"><span style="width:200px" class="small">${esc(r.label)}</span><div class="bar" style="flex:1"><span style="width:${t.total ? Math.round(r.count / t.total * 100) : 0}%"></span></div><span class="num small" style="width:40px;text-align:right">${r.count}</span></div>`).join('')}</div>
      <div class="card"><h2>日別アクション（直近 14 日）</h2>
        ${s.daily.length ? `<table class="tbl"><thead><tr><th>日付</th><th class="num">架電・記録</th><th class="num">通電</th><th class="num">アポ</th><th style="width:40%"></th></tr></thead><tbody>${s.daily.map((d) => `<tr><td>${esc(d.day)}</td><td class="num">${d.calls}</td><td class="num">${d.connected}</td><td class="num"><b>${d.appointments}</b></td><td><div class="bar"><span style="width:${Math.round(d.calls / maxCalls * 100)}%"></span></div></td></tr>`).join('')}</tbody></table>` : '<p class="muted">まだフォロー記録がありません。</p>'}
      </div>
    </div>`;
}

// ---------- ⑥ 書き出し ----------
async function renderExport(view) {
  if (needExhibition(view)) return;
  const e = ex();
  const g = state.config.gsheets;
  view.innerHTML = `
    <div class="grid2">
      <div class="card">
        <h2>ファイルでダウンロード</h2>
        <p class="muted small">「リード一覧」「サマリー」「セグメント×担当」「フォロー履歴」の 4 シート構成です。</p>
        <div class="row"><a href="/api/exhibitions/${e.id}/export.xlsx"><button class="primary">Excel (.xlsx)</button></a><a href="/api/exhibitions/${e.id}/export.csv"><button>CSV（Excel 対応 UTF-8）</button></a></div>
      </div>
      <div class="card">
        <h2>Google スプレッドシートへ書き出す</h2>
        ${g.enabled ? `
          <p class="small">書き出し先のスプレッドシートを、サービスアカウント <code>${esc(g.serviceAccountEmail)}</code> に<b>編集者</b>で共有してから、URL を貼ってください。「リード一覧」「サマリー」「フォロー履歴」タブを作成／上書きします。</p>
          <div class="row"><input type="text" id="gsUrl" placeholder="https://docs.google.com/spreadsheets/d/…" style="flex:1" value="${esc(localStorage.getItem('gsUrl') || '')}"><button id="gsRun" class="primary">書き出す</button></div>
          <div id="gsResult" class="mt"></div>`
        : `<div class="notice small">未設定です。サーバーの <code>.env</code> に <code>GOOGLE_APPLICATION_CREDENTIALS</code>（サービスアカウント JSON のパス）を設定して再起動すると使えます。手順は README を参照。</div>
           <p class="muted small mt">それまでは Excel/CSV をダウンロードして、スプレッドシートに「ファイル → インポート」してください。</p>`}
      </div>
    </div>`;
  if (g.enabled) $('#gsRun').onclick = async () => {
    const url = $('#gsUrl').value.trim(); if (!url) return toast('URL を入力してください', true);
    localStorage.setItem('gsUrl', url);
    $('#gsResult').innerHTML = '<span class="muted">書き出し中…</span>';
    try {
      const r = await api(`/api/exhibitions/${e.id}/export/gsheets`, { method: 'POST', body: { spreadsheet: url } });
      $('#gsResult').innerHTML = `<div class="chip ok">完了</div> <a href="${esc(r.spreadsheetUrl)}" target="_blank" rel="noopener">スプレッドシートを開く</a> <span class="muted small">${Object.entries(r.rows).map(([k, v]) => `${k} ${v}行`).join(' / ')}</span>`;
    } catch (err) { $('#gsResult').innerHTML = `<div class="chip danger">失敗</div> <span class="small">${esc(err.message)}</span>`; }
  };
}

// ---------- 設定 ----------
async function renderSettings(view) {
  const e = ex();
  view.innerHTML = `
    <div class="grid2">
      <div class="card">
        <h2>メンバー</h2>
        <p class="muted small">メールアドレスを入れたメンバーはログインできます（招待リンクを発行して渡してください）。入れなければ「担当者としてだけ」存在します。</p>
        ${isAdmin() ? `<form id="memForm" class="row"><input type="text" name="name" placeholder="氏名" required><input type="email" name="email" placeholder="メール（任意）"><select name="role"><option value="member">担当者</option><option value="admin">管理者</option></select><button class="primary">追加</button></form>` : ''}
        <div class="scroll"><table class="tbl mt"><thead><tr><th>名前</th><th>メール</th><th>権限</th><th>状態</th><th></th></tr></thead><tbody>${state.members.map((m) => `<tr data-mid="${m.id}">
          <td>${esc(m.name)}${m.id === state.me.id ? ' <span class="chip">自分</span>' : ''}</td>
          <td>${isAdmin() ? `<input type="email" value="${esc(m.email || '')}" data-f="email" placeholder="未設定" style="width:210px">` : esc(m.email || '')}</td>
          <td>${isAdmin() && m.id !== state.me.id ? `<select data-f="role"><option value="member" ${m.role !== 'admin' ? 'selected' : ''}>担当者</option><option value="admin" ${m.role === 'admin' ? 'selected' : ''}>管理者</option></select>` : (m.role === 'admin' ? '管理者' : '担当者')}</td>
          <td>${m.active ? '<span class="chip ok">稼働中</span>' : '<span class="chip">停止</span>'} ${m.has_login ? '<span class="chip">ログイン可</span>' : ''}${m.last_login_at ? `<div class="small muted">最終 ${esc(fmtDt(m.last_login_at))}</div>` : ''}</td>
          <td class="num" style="white-space:nowrap">${isAdmin() ? `<button class="small" data-savemem="${m.id}">保存</button> <button class="small" data-invite="${m.id}" ${m.email ? '' : 'disabled title="メールを設定して保存してから"'}>${m.has_login ? '再設定リンク' : '招待リンク'}</button> ${m.id !== state.me.id ? `<button class="small" data-toggle="${m.id}" data-active="${m.active}">${m.active ? '停止' : '再開'}</button> <button class="small danger" data-delmem="${m.id}">削除</button>` : ''}` : ''}</td>
        </tr><tr class="linkrow" data-linkfor="${m.id}" hidden><td colspan="5"></td></tr>`).join('')}</tbody></table></div>
      </div>
      <div class="card">
        <h2>自分のパスワード</h2>
        <form id="pwForm" class="row"><input type="password" name="current" placeholder="現在のパスワード" autocomplete="current-password" required><input type="password" name="password" placeholder="新しいパスワード（10文字以上・英数字）" autocomplete="new-password" required><button class="primary">変更</button></form>
      </div>
      ${isAdmin() ? `<div class="card">
        <h2>バックアップ</h2>
        <p class="muted small">毎日自動でサーバー内に 14 世代保存しています。手元にも定期的にダウンロードして保管してください。</p>
        <div class="row"><a href="/api/backups/download"><button class="primary">今すぐバックアップをダウンロード</button></a><span id="bkList" class="small muted"></span></div>
      </div>` : ''}
      ${isAdmin() ? `<div class="card">
        <h2>セグメント</h2>
        <form id="segForm" class="row"><input type="text" name="code" placeholder="コード（例 D）" style="width:100px" required><input type="text" name="label" placeholder="表示名" required><input type="text" name="action" placeholder="やること"><input type="color" name="color" value="#5b8def"><label class="small"><input type="checkbox" name="is_excluded"> 割当対象外</label><button class="primary">追加</button></form>
        <table class="tbl mt"><thead><tr><th>順</th><th>表示</th><th>やること</th><th></th></tr></thead><tbody>${state.segments.map((s) => `<tr data-seg="${s.id}"><td><input type="number" value="${s.sort_order}" data-f="sort_order" style="width:60px"></td><td><input type="color" value="${esc(s.color || '#777777')}" data-f="color"> <input type="text" value="${esc(s.label)}" data-f="label"></td><td><input type="text" value="${esc(s.action || '')}" data-f="action"> <label class="small"><input type="checkbox" data-f="is_excluded" ${s.is_excluded ? 'checked' : ''}>対象外</label></td><td class="num"><button class="small" data-savseg="${s.id}">保存</button> ${s.code !== 'U' ? `<button class="small danger" data-delseg="${s.id}">削除</button>` : ''}</td></tr>`).join('')}</tbody></table>
      </div>` : ''}
    </div>
    ${e && isAdmin() ? `<div class="card"><h2>展示会の編集</h2>
      <form id="exEdit" class="row"><input type="text" name="name" value="${esc(e.name)}" required style="min-width:260px"><input type="date" name="held_on" value="${esc(e.held_on || '')}"><input type="text" name="venue" value="${esc(e.venue || '')}" placeholder="会場"><button class="primary">保存</button><button type="button" id="exDel" class="danger">この展示会を削除（リードも消えます）</button></form></div>` : ''}`;
  const memForm = $('#memForm');
  if (memForm) memForm.onsubmit = async (ev) => { ev.preventDefault(); try { await api('/api/members', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }); await loadBase(); renderSettings(view); } catch (err) { onErr(err); } };
  $$('[data-savemem]').forEach((b) => { b.onclick = async () => { const tr = b.closest('tr'); const body = { email: $('[data-f=email]', tr).value.trim() }; const role = $('[data-f=role]', tr); if (role) body.role = role.value; try { await api(`/api/members/${b.dataset.savemem}`, { method: 'PUT', body }); await loadBase(); toast('保存しました'); renderSettings(view); } catch (err) { onErr(err); } }; });
  $$('[data-invite]').forEach((b) => { b.onclick = async () => { try { const r = await api(`/api/members/${b.dataset.invite}/invite`, { method: 'POST' }); const row = $(`tr[data-linkfor="${b.dataset.invite}"]`); row.hidden = false; row.firstElementChild.innerHTML = `<div class="notice small">${r.kind === 'invite' ? '招待' : 'パスワード再設定'}リンク（${r.expires_hours >= 48 ? r.expires_hours / 24 + ' 日間' : r.expires_hours + ' 時間'}有効・1 回限り）。本人に Slack などで渡してください。<div class="linkbox"><input type="text" readonly value="${esc(r.url)}"><button class="small" data-copy>コピー</button></div></div>`; const inp = $('input', row); $('[data-copy]', row).onclick = () => { inp.select(); navigator.clipboard?.writeText(inp.value); toast('コピーしました'); }; inp.select(); } catch (err) { onErr(err); } }; });
  $$('[data-toggle]').forEach((b) => { b.onclick = async () => { await api(`/api/members/${b.dataset.toggle}`, { method: 'PUT', body: { active: b.dataset.active !== '1' } }).catch(onErr); await loadBase(); renderSettings(view); }; });
  $$('[data-delmem]').forEach((b) => { b.onclick = async () => { if (!confirm('メンバーを削除しますか？（割当は未割当に戻ります。履歴は残ります）')) return; await api(`/api/members/${b.dataset.delmem}`, { method: 'DELETE' }).catch(onErr); await loadBase(); renderSettings(view); }; });
  $('#pwForm').onsubmit = async (ev) => { ev.preventDefault(); try { await api('/api/auth/password', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }); ev.target.reset(); toast('パスワードを変更しました'); } catch (err) { onErr(err); } };
  if (isAdmin()) api('/api/backups').then((r) => { $('#bkList').textContent = r.files.length ? `サーバー内の最新：${r.files[0].file}（${r.files.length} 世代）` : 'サーバー内のバックアップはまだありません'; }).catch(() => {});
  if ($('#segForm')) $('#segForm').onsubmit = async (ev) => { ev.preventDefault(); const fd = new FormData(ev.target); const body = Object.fromEntries(fd); body.is_excluded = fd.get('is_excluded') ? 1 : 0; try { await api('/api/segments', { method: 'POST', body }); await loadBase(); renderSettings(view); } catch (err) { onErr(err); } };
  $$('[data-savseg]').forEach((b) => { b.onclick = async () => { const tr = b.closest('tr'); const body = { sort_order: +$('[data-f=sort_order]', tr).value, color: $('[data-f=color]', tr).value, label: $('[data-f=label]', tr).value, action: $('[data-f=action]', tr).value, is_excluded: $('[data-f=is_excluded]', tr).checked ? 1 : 0 }; try { await api(`/api/segments/${b.dataset.savseg}`, { method: 'PUT', body }); await loadBase(); toast('保存しました'); renderSettings(view); } catch (err) { onErr(err); } }; });
  $$('[data-delseg]').forEach((b) => { b.onclick = async () => { if (!confirm('セグメントを削除しますか？（該当リードは未分類に、関連ルールも削除）')) return; try { await api(`/api/segments/${b.dataset.delseg}`, { method: 'DELETE' }); await loadBase(); renderSettings(view); } catch (err) { onErr(err); } }; });
  if (e && isAdmin()) {
    $('#exEdit').onsubmit = async (ev) => { ev.preventDefault(); try { await api(`/api/exhibitions/${e.id}`, { method: 'PUT', body: Object.fromEntries(new FormData(ev.target)) }); await loadBase(); toast('保存しました'); renderSettings(view); } catch (err) { onErr(err); } };
    $('#exDel').onclick = async () => { if (!confirm(`「${e.name}」とそのリードをすべて削除します。元に戻せません。よろしいですか？`)) return; try { await api(`/api/exhibitions/${e.id}`, { method: 'DELETE' }); state.exhibitionId = null; await loadBase(); location.hash = '#/import'; } catch (err) { onErr(err); } };
  }
}

// ---------- 起動 ----------
loadBase().then(route).catch(onErr);
