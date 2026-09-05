// LP の相談フォーム送信と流入元（UTM）の保持
(function () {
  var form = document.getElementById('inquiryForm');
  if (!form) return;
  var params = new URLSearchParams(location.search);
  var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid'];
  // 最初に来たときの UTM を保持（ページ内で移動しても消えないように）
  try {
    keys.forEach(function (k) { if (params.get(k)) sessionStorage.setItem('lp_' + k, params.get(k)); });
    if (document.referrer && !sessionStorage.getItem('lp_referrer')) sessionStorage.setItem('lp_referrer', document.referrer);
  } catch (e) { /* storage が使えない環境では無視 */ }
  var err = document.getElementById('inqErr');
  var btn = document.getElementById('inqSubmit');
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    err.textContent = '';
    var fd = new FormData(form);
    var body = {};
    fd.forEach(function (v, k) { body[k] = v; });
    body.consent = form.querySelector('[name=consent]').checked;
    try {
      keys.concat(['referrer']).forEach(function (k) { var v = sessionStorage.getItem('lp_' + k); if (v) body[k] = v; });
    } catch (e) { /* ignore */ }
    body.page = location.pathname;
    if (!body.company || !body.name) { err.textContent = '会社名とお名前を入力してください'; return; }
    if (!body.email && !body.phone) { err.textContent = 'メールアドレスか電話番号のどちらかを入力してください'; return; }
    if (!body.consent) { err.textContent = 'プライバシーポリシーへの同意にチェックしてください'; return; }
    btn.disabled = true; btn.textContent = '送信中…';
    fetch('/api/public/inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || '送信に失敗しました');
        if (window.dataLayer) window.dataLayer.push({ event: 'inquiry_submit', inquiry_id: res.d.id });
        location.href = '/lp-thanks.html';
      })
      .catch(function (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = '相談する（無料）'; });
  });
})();
