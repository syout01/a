// CSV パーサ（ブラウザ・Node 両対応の ES module）
// RFC4180 準拠のクォート処理、CRLF/LF 混在、BOM 除去

export function parseCsv(text) {
  if (!text) return [];
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',' || ch === '\t') { row.push(field); field = ''; continue; }
    if (ch === '\r') { continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // 完全な空行は除く
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// 見出しの注釈を落として読みやすくする
//   "姓｜例）山田" → "姓"、"住所 ※会社住所をご記入ください（都道府県｜例）東京都）" → "住所（都道府県）"
export function cleanHeader(h) {
  return String(h ?? '')
    .replace(/[｜|]\s*例\s*[)）][^（()）]*/g, '')   // ｜例）山田
    .replace(/\s*※[^（()）]*/g, '')                // ※注意書き
    .replace(/\s*[（(]\s*[)）]/g, '')               // 空になった括弧
    .replace(/\s+/g, ' ')
    .trim();
}

// 1行目をヘッダとしてオブジェクト配列に。見出しは注釈を除去し、重複は "(2)" を付けて区別する
export function csvToObjects(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], records: [] };
  const seen = new Map();
  const headers = rows[0].map((h, i) => {
    let name = cleanHeader(h) || `列${i + 1}`;
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name}(${n})`;
    return name;
  });
  const records = rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i] != null ? String(r[i]).trim() : ''; });
    return o;
  });
  return { headers, records };
}

// バイト列を UTF-8 → 失敗（置換文字が出る）なら Shift_JIS として読む
export function decodeBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(u8);
    return { text: utf8, encoding: 'utf-8' };
  } catch {
    const sjis = new TextDecoder('shift_jis').decode(u8);
    return { text: sjis, encoding: 'shift_jis' };
  }
}

// 取り込み先フィールド（画面の対応付け UI と共通）
export const TARGET_FIELDS = [
  { key: 'company', label: '会社名' },
  { key: 'name', label: '氏名' },
  { key: 'last_name', label: '姓（分かれている場合）' },
  { key: 'first_name', label: '名（分かれている場合）' },
  { key: 'department', label: '部署' },
  { key: 'title', label: '役職' },
  { key: 'email', label: 'メール' },
  { key: 'phone', label: '電話' },
  { key: 'industry', label: '業種' },
  { key: 'employees', label: '従業員数' },
  { key: 'memo', label: 'ブースメモ・アンケート' },
  { key: 'segment', label: '既存ランク → セグメント' },
  { key: 'assignee', label: '担当者名 → フォロー担当' },
  { key: 'note', label: '対応メモ → 最終フォローメモ' },
];

// 主催者CSVの見出しから、取り込み先フィールドを推測する
export const FIELD_SYNONYMS = {
  company: ['会社名', '企業名', '社名', '法人名', '所属', '勤務先', '団体名', 'company', 'organization', '会社'],
  name: ['氏名', '名前', 'お名前', '姓名', '来場者名', 'name', 'フルネーム'],
  last_name: ['姓', '苗字', '名字', 'lastname', 'last name', 'family name'],
  first_name: ['名', 'firstname', 'first name', 'given name'],
  department: ['部署', '部門', '所属部署', '部署名', 'department', 'division'],
  title: ['役職', '役職名', '肩書', '肩書き', 'title', 'position', '職位'],
  email: ['メール', 'メールアドレス', 'e-mail', 'email', 'mail', 'eメール', 'ログインアカウント', 'アカウント'],
  phone: ['電話', '電話番号', 'tel', 'phone', '携帯', '連絡先'],
  industry: ['業種', '業界', 'industry', '事業内容', '大業種'],
  employees: ['従業員数', '社員数', '従業員規模', '従業員区分', '企業規模', '規模', 'employees', '人数', '従業員'],
  memo: ['メモ', '備考', 'コメント', 'アンケート', '興味', '関心', 'ヒアリング', 'note', 'memo', 'remarks', '質問'],
  segment: ['ランク', 'セグメント', '優先度', '判定', 'rank', 'segment', '温度感'],
  assignee: ['担当', '担当者', 'フォロー担当', '営業担当', '架電担当', 'assignee', 'owner'],
  note: ['対応メモ', '対応履歴', 'フォローメモ', '架電メモ', 'フォロー内容', '対応内容', '進捗メモ'],
};

// 来場者本人ではない列（スキャンした自社側の人など）を氏名・担当の候補から外す
const NOT_VISITOR_NAME = /(担当者|端末|代表者|スキャン|ログイン|オペレーター|登録者)/;

const normH = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[\s　（）()【】\[\]※:：?？]/g, '').replace(/\(\d+\)$/, '');

export function guessMapping(headers, records = []) {
  const mapping = {};
  const used = new Set();
  const find = (field, { exclude } = {}) => {
    const syns = FIELD_SYNONYMS[field].map(normH);
    const cands = headers.filter((h) => !used.has(h) && !(exclude && exclude.test(h)));
    let hit = cands.find((h) => syns.includes(normH(h)));
    if (!hit) hit = cands.find((h) => syns.some((s) => s.length >= 2 && normH(h).includes(s)));
    return hit;
  };
  const take = (field, h) => { if (h) { mapping[field] = h; used.add(h); } };

  take('email', find('email'));
  // 見出しで見つからなければ、値の半分以上に @ が含まれる列をメールとみなす
  if (!mapping.email && records.length) {
    const hit = headers.find((h) => !used.has(h) && ratio(records, h, (v) => v.includes('@')) >= 0.5);
    take('email', hit);
  }
  take('phone', find('phone'));
  take('company', find('company'));
  take('last_name', find('last_name', { exclude: NOT_VISITOR_NAME }));
  take('first_name', find('first_name', { exclude: NOT_VISITOR_NAME }));
  if (mapping.last_name && mapping.first_name) {
    mapping.name = '__combine_last_first__';
  } else {
    take('name', find('name', { exclude: NOT_VISITOR_NAME }));
  }
  take('department', find('department'));
  take('title', find('title', { exclude: /レベル/ }));
  take('industry', find('industry'));
  take('employees', find('employees'));
  take('segment', find('segment'));
  take('assignee', find('assignee', { exclude: NOT_VISITOR_NAME }));
  take('note', find('note'));
  take('memo', find('memo'));
  return mapping;
}

function ratio(records, h, pred) {
  const vals = records.map((r) => r[h]).filter((v) => v && v.trim());
  if (!vals.length) return 0;
  return vals.filter(pred).length / vals.length;
}

// 電話番号のゆれを直す：全角→半角、Excel で落ちた先頭の 0 を補う
export function normalizePhone(v) {
  // 全角→半角、ダッシュ類（− – — ‐ ー）は半角ハイフンに寄せる
  let s = String(v ?? '').normalize('NFKC').replace(/[\u2212\u2013\u2014\u2010\u30fc]/g, '-').trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  if (!digits) return s;
  if (/^[\d\-() ]+$/.test(s) && !digits.startsWith('0') && (digits.length === 9 || digits.length === 10)) {
    return '0' + digits;
  }
  return s;
}

// mapping に従って 1 レコードをリードに変換（未使用列は extra に）
export function applyMapping(record, mapping, headers) {
  const lead = { company: '', name: '', department: '', title: '', email: '', phone: '', industry: '', employees: '', memo: '', segment_hint: '', assignee_name: '', note: '', extra: {} };
  const usedCols = new Set();
  const pick = (key, col) => { if (col && col in record) { usedCols.add(col); return record[col]; } return ''; };
  for (const key of ['company', 'department', 'title', 'email', 'phone', 'industry', 'employees', 'memo', 'note']) lead[key] = pick(key, mapping[key]);
  lead.segment_hint = pick('segment', mapping.segment);
  lead.assignee_name = pick('assignee', mapping.assignee);
  if (mapping.name === '__combine_last_first__') {
    const l = pick('last_name', mapping.last_name);
    const f = pick('first_name', mapping.first_name);
    lead.name = `${l} ${f}`.trim();
  } else if (mapping.name && mapping.name in record) {
    lead.name = record[mapping.name];
    usedCols.add(mapping.name);
  }
  lead.phone = normalizePhone(lead.phone);
  for (const h of headers) if (!usedCols.has(h) && record[h] !== '') lead.extra[h] = record[h];
  return lead;
}
