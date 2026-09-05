// ログイン／初期セットアップ／招待・再設定リンクの受諾（同じ画面でモードを切り替える）
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (url, body) => {
    const r = await fetch(url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };
  const field = (name, label, type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" ${extra} required></label>`;
  const PW_HINT = '10 文字以上、英字と数字を含む';
  let mode = 'login';
  let token = null;

  async function init() {
    const m = location.hash.match(/token=([A-Za-z0-9_-]+)/);
    if (m) { token = m[1]; return initToken(); }
    const st = await api('/api/auth/status').catch(() => ({}));
    if (st.user) { location.replace('/'); return; }
    if (st.needs_setup) return render('setup');
    render('login');
  }
  async function initToken() {
    try {
      const t = await api(`/api/auth/token/${token}`);
      render(t.kind === 'invite' ? 'invite' : 'reset', t);
    } catch (e) {
      render('login');
      $('#err').textContent = e.message;
    }
  }
  function render(m, info = {}) {
    mode = m;
    const conf = {
      login: { title: 'ログイン', desc: '', fields: field('email', 'メールアドレス', 'email', 'autocomplete="username"') + field('password', 'パスワード', 'password', 'autocomplete="current-password"'), btn: 'ログイン' },
      setup: { title: '最初の管理者を作成', desc: 'まだ管理者がいません。あなたのアカウントを作ると、このツールの管理者になります。', fields: field('name', 'お名前') + field('email', 'メールアドレス（ログイン ID）', 'email', 'autocomplete="username"') + field('password', `パスワード（${PW_HINT}）`, 'password', 'autocomplete="new-password"'), btn: '管理者を作成して始める' },
      invite: { title: 'アカウントを有効化', desc: `${esc(info.email)} として招待されています。名前とパスワードを設定してください。`, fields: field('name', 'お名前', 'text', `value="${esc(info.name)}"`) + field('password', `パスワード（${PW_HINT}）`, 'password', 'autocomplete="new-password"'), btn: '有効化してログイン' },
      reset: { title: 'パスワードを再設定', desc: `${esc(info.email)} の新しいパスワードを設定してください。`, fields: field('password', `新しいパスワード（${PW_HINT}）`, 'password', 'autocomplete="new-password"'), btn: '再設定してログイン' },
    }[m];
    $('#title').textContent = conf.title;
    $('#desc').textContent = conf.desc;
    $('#fields').innerHTML = conf.fields;
    $('#submit').textContent = conf.btn;
    $('#err').textContent = '';
    const first = $('#fields input'); if (first) first.focus();
  }
  $('#form').onsubmit = async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target));
    $('#submit').disabled = true; $('#err').textContent = '';
    try {
      if (mode === 'login') await api('/api/auth/login', body);
      else if (mode === 'setup') await api('/api/auth/setup', body);
      else await api(`/api/auth/token/${token}`, body);
      location.replace('/');
    } catch (e) {
      $('#err').textContent = e.message;
      $('#submit').disabled = false;
    }
  };
  init();
})();
