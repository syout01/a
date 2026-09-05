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

// 1行目をヘッダとしてオブジェクト配列に
export function csvToObjects(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h, i) => (String(h).trim() || `列${i + 1}`));
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

// 主催者CSVの見出しから、取り込み先フィールドを推測する
export const FIELD_SYNONYMS = {
  company: ['会社名', '企業名', '社名', '法人名', '所属', '勤務先', '団体名', 'company', 'organization', '会社'],
  name: ['氏名', '名前', 'お名前', '姓名', '来場者名', 'name', 'フルネーム'],
  last_name: ['姓', '苗字', '名字', 'lastname', 'last name', 'family name'],
  first_name: ['名', 'firstname', 'first name', 'given name'],
  department: ['部署', '部門', '所属部署', '部署名', 'department', 'division'],
  title: ['役職', '役職名', '肩書', '肩書き', 'title', 'position', '職位'],
  email: ['メール', 'メールアドレス', 'e-mail', 'email', 'mail', 'eメール'],
  phone: ['電話', '電話番号', 'tel', 'phone', '携帯', '連絡先'],
  industry: ['業種', '業界', 'industry', '事業内容'],
  employees: ['従業員数', '社員数', '従業員規模', '企業規模', '規模', 'employees', '人数'],
  memo: ['メモ', '備考', 'コメント', 'アンケート', '興味', '関心', 'ヒアリング', 'note', 'memo', 'remarks', '質問'],
};

export function guessMapping(headers) {
  const norm = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[\s　（）()【】\[\]※:：]/g, '');
  const mapping = {};
  const used = new Set();
  const order = ['email', 'phone', 'company', 'last_name', 'first_name', 'name', 'department', 'title', 'industry', 'employees', 'memo'];
  for (const field of order) {
    const syns = FIELD_SYNONYMS[field].map(norm);
    // 完全一致を優先し、次に部分一致
    let hit = headers.find((h) => !used.has(h) && syns.includes(norm(h)));
    if (!hit) hit = headers.find((h) => !used.has(h) && syns.some((s) => s.length >= 2 && norm(h).includes(s)));
    if (hit) { mapping[field] = hit; used.add(hit); }
  }
  // 姓・名が両方取れたら氏名は結合扱いにする
  if (mapping.last_name && mapping.first_name && !mapping.name) mapping.name = '__combine_last_first__';
  return mapping;
}

// mapping に従って 1 レコードをリードに変換（未使用列は extra に）
export function applyMapping(record, mapping, headers) {
  const lead = { company: '', name: '', department: '', title: '', email: '', phone: '', industry: '', employees: '', memo: '', extra: {} };
  const usedCols = new Set();
  for (const key of ['company', 'department', 'title', 'email', 'phone', 'industry', 'employees', 'memo']) {
    const col = mapping[key];
    if (col && col in record) { lead[key] = record[col]; usedCols.add(col); }
  }
  if (mapping.name === '__combine_last_first__') {
    const l = mapping.last_name ? record[mapping.last_name] ?? '' : '';
    const f = mapping.first_name ? record[mapping.first_name] ?? '' : '';
    lead.name = `${l} ${f}`.trim();
    if (mapping.last_name) usedCols.add(mapping.last_name);
    if (mapping.first_name) usedCols.add(mapping.first_name);
  } else if (mapping.name && mapping.name in record) {
    lead.name = record[mapping.name];
    usedCols.add(mapping.name);
  }
  for (const h of headers) if (!usedCols.has(h) && record[h] !== '') lead.extra[h] = record[h];
  return lead;
}
