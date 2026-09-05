// セグメント判定エンジン（純粋関数。テスト対象）
// rule = { id, segment_code, priority, match_mode: 'all'|'any', conditions: [{field, op, value}], enabled }

export const LEAD_FIELDS = [
  { key: 'company', label: '会社名' },
  { key: 'name', label: '氏名' },
  { key: 'department', label: '部署' },
  { key: 'title', label: '役職' },
  { key: 'email', label: 'メール' },
  { key: 'phone', label: '電話' },
  { key: 'industry', label: '業種' },
  { key: 'employees', label: '従業員数' },
  { key: 'memo', label: 'メモ・アンケート' },
];

export const OPERATORS = [
  { key: 'contains', label: 'を含む' },
  { key: 'not_contains', label: 'を含まない' },
  { key: 'equals', label: 'と一致' },
  { key: 'not_equals', label: 'と一致しない' },
  { key: 'starts_with', label: 'で始まる' },
  { key: 'in_list', label: 'のいずれかを含む（カンマ区切り）' },
  { key: 'regex', label: '正規表現に一致' },
  { key: 'gte', label: '以上（数値）' },
  { key: 'lte', label: '以下（数値）' },
  { key: 'is_empty', label: 'が空' },
  { key: 'not_empty', label: 'が空でない' },
];

export function normalizeText(v) {
  if (v == null) return '';
  return String(v).normalize('NFKC').trim().toLowerCase();
}

// "100〜300名" "1,200人" "約５０名" などから最初の数値を取り出す
export function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // 「４．100-300人未満」「(2) 50名」のような選択肢の連番は数値ではないので外す
  const raw = String(v).replace(/^\s*(?:[０-９]{1,2}\s*[．。、）)]|\d{1,2}\s*[、）)]|\d{1,2}\.\s+|[(（]\s*\d{1,2}\s*[)）])\s*/, '');
  const s = raw.normalize('NFKC').replace(/,/g, '');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  if (/\d\s*万/.test(s)) n *= 10000;
  return n;
}

export function getField(lead, field) {
  if (!field) return '';
  if (field.startsWith('extra.')) {
    const k = field.slice('extra.'.length);
    return lead.extra && lead.extra[k] != null ? lead.extra[k] : '';
  }
  return lead[field] != null ? lead[field] : '';
}

export function evalCondition(lead, cond) {
  const raw = getField(lead, cond.field);
  const val = normalizeText(raw);
  const target = normalizeText(cond.value);
  switch (cond.op) {
    case 'contains': return target !== '' && val.includes(target);
    case 'not_contains': return target === '' ? true : !val.includes(target);
    case 'equals': return val === target;
    case 'not_equals': return val !== target;
    case 'starts_with': return target !== '' && val.startsWith(target);
    case 'in_list': {
      const items = String(cond.value ?? '').split(/[,、，\n]/).map(normalizeText).filter(Boolean);
      return items.some((it) => val.includes(it));
    }
    case 'regex': {
      if (!cond.value) return false;
      try { return new RegExp(cond.value, 'iu').test(String(raw ?? '').normalize('NFKC')); } catch { return false; }
    }
    case 'gte': { const n = toNumber(raw), t = toNumber(cond.value); return n != null && t != null && n >= t; }
    case 'lte': { const n = toNumber(raw), t = toNumber(cond.value); return n != null && t != null && n <= t; }
    case 'is_empty': return val === '';
    case 'not_empty': return val !== '';
    default: return false;
  }
}

export function evalRule(lead, rule) {
  const conds = Array.isArray(rule.conditions) ? rule.conditions : [];
  if (conds.length === 0) return false;
  return rule.match_mode === 'any' ? conds.some((c) => evalCondition(lead, c)) : conds.every((c) => evalCondition(lead, c));
}

// 優先度の小さい順に評価し、最初に一致したルールのセグメントを返す
export function classify(lead, rules, defaultSegment = 'U') {
  const sorted = [...rules].filter((r) => r.enabled !== 0 && r.enabled !== false).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || (a.id ?? 0) - (b.id ?? 0));
  for (const r of sorted) {
    if (evalRule(lead, r)) return { segment_code: r.segment_code, rule_id: r.id ?? null, rule_name: r.name ?? null };
  }
  return { segment_code: defaultSegment, rule_id: null, rule_name: null };
}

// 担当者へのラウンドロビン割当（セグメント順にまわして人ごとの件数を平準化）
export function roundRobinAssign(leads, memberIds) {
  if (!memberIds.length) return [];
  const counts = new Map(memberIds.map((m) => [m, 0]));
  const out = [];
  let i = 0;
  for (const lead of leads) {
    // 一番件数の少ない人（同数なら順番）に渡す
    let best = memberIds[i % memberIds.length];
    for (const m of memberIds) if (counts.get(m) < counts.get(best)) best = m;
    counts.set(best, counts.get(best) + 1);
    out.push({ lead_id: lead.id, member_id: best });
    i++;
  }
  return out;
}
