// ログイン不要の公開 API（LP の相談フォーム）
import { Router } from 'express';
import { rateLimit, clientIp } from '../lib/auth.js';
import { normEmail } from './auth.js';

export default function publicRoutes(db) {
  const r = Router();

  r.post('/inquiry', async (req, res) => {
    const ip = clientIp(req);
    if (!rateLimit(`inq:${ip}`, 5, 60 * 60 * 1000)) return res.status(429).json({ error: '送信が多すぎます。しばらくしてからお試しください' });
    const b = req.body || {};
    // ハニーポット：人間には見えない欄が埋まっていたら bot として黙って捨てる
    if (b.website) return res.json({ ok: true });
    const s = (v, n = 200) => String(v ?? '').trim().slice(0, n);
    const company = s(b.company), name = s(b.name), phone = s(b.phone, 40), scale = s(b.scale, 40), message = s(b.message, 2000);
    const email = normEmail(b.email);
    if (!company || !name) return res.status(400).json({ error: '会社名とお名前は必須です' });
    if (!email && !phone) return res.status(400).json({ error: 'メールアドレスか電話番号のどちらかを入れてください' });
    if (b.email && !email) return res.status(400).json({ error: 'メールアドレスの形式が正しくありません' });
    if (!b.consent) return res.status(400).json({ error: 'プライバシーポリシーへの同意が必要です' });
    const source = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'referrer', 'page']) if (b[k]) source[k] = s(b[k], 300);
    const info = db.prepare('INSERT INTO inquiries (company, name, email, phone, scale, message, source_json, ip) VALUES (?,?,?,?,?,?,?,?)')
      .run(company, name, email, phone, scale, message, JSON.stringify(source), ip);
    notifySlack({ id: Number(info.lastInsertRowid), company, name, email, phone, scale, message, source }).catch((e) => console.warn('[slack] 通知失敗:', e.message));
    res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
  });

  return r;
}

async function notifySlack(inq) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const lines = [
    `*LP から相談が届きました* #${inq.id}`,
    `会社: ${inq.company} / 氏名: ${inq.name}`,
    `連絡先: ${inq.email || '-'} / ${inq.phone || '-'}`,
    `規模: ${inq.scale || '-'}`,
    inq.message ? `内容: ${inq.message.slice(0, 500)}` : null,
    Object.keys(inq.source).length ? `流入: ${Object.entries(inq.source).map(([k, v]) => `${k}=${v}`).join(' ')}` : null,
  ].filter(Boolean);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: lines.join('\n') }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
