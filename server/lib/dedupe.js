// 重複判定キー（メール優先、なければ 会社名+氏名 を正規化）
const CORP_WORDS = /(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|社会福祉法人|医療法人|学校法人|特定非営利活動法人|npo法人|\(株\)|\(有\)|\(同\)|㈱|㈲|inc\.?|co\.,?\s*ltd\.?|ltd\.?|llc|corp\.?|corporation|company|k\.k\.?|kk)/g;

export function normalizeCompany(v) {
  return String(v ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(CORP_WORDS, '')
    .replace(/[\s　・･\-–—_,.、。()（）\[\]「」『』]/g, '')
    .trim();
}

export function normalizeName(v) {
  return String(v ?? '').normalize('NFKC').toLowerCase().replace(/[\s　]/g, '');
}

export function normalizeEmail(v) {
  return String(v ?? '').normalize('NFKC').trim().toLowerCase();
}

export function dedupeKey(lead) {
  const email = normalizeEmail(lead.email);
  if (email && email.includes('@')) return `e:${email}`;
  const c = normalizeCompany(lead.company);
  const n = normalizeName(lead.name);
  if (!c && !n) return null;
  return `cn:${c}|${n}`;
}
