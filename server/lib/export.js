// Excel / CSV / Google スプレッドシート 書き出し
import ExcelJS from 'exceljs';
import { LEAD_STATUSES } from './db.js';

const STATUS_LABEL = Object.fromEntries(LEAD_STATUSES.map((s) => [s.code, s.label]));

export const LEAD_COLUMNS = [
  { key: 'id', header: 'ID', width: 8 },
  { key: 'segment_label', header: 'セグメント', width: 18 },
  { key: 'assignee_name', header: '担当', width: 12 },
  { key: 'status_label', header: 'ステータス', width: 20 },
  { key: 'next_call_at', header: '次回コール', width: 18 },
  { key: 'company', header: '会社名', width: 28 },
  { key: 'name', header: '氏名', width: 14 },
  { key: 'department', header: '部署', width: 20 },
  { key: 'title', header: '役職', width: 14 },
  { key: 'phone', header: '電話', width: 16 },
  { key: 'email', header: 'メール', width: 28 },
  { key: 'industry', header: '業種', width: 16 },
  { key: 'employees', header: '従業員数', width: 12 },
  { key: 'memo', header: 'ブースメモ', width: 30 },
  { key: 'last_note', header: '最終フォローメモ', width: 30 },
  { key: 'last_contact_at', header: '最終接触日時', width: 18 },
  { key: 'returning', header: '過去接触', width: 10 },
  { key: 'created_at', header: '取込日時', width: 18 },
];

// 書き出し用の行データを組み立てる（extra 列は末尾に展開）
export function buildExportRows({ exhibition, leads, segments, members }) {
  const segLabel = Object.fromEntries(segments.map((s) => [s.code, s.label]));
  const memberName = Object.fromEntries(members.map((m) => [m.id, m.name]));
  const extraKeys = [];
  for (const l of leads) for (const k of Object.keys(l.extra || {})) if (!extraKeys.includes(k)) extraKeys.push(k);
  const columns = [...LEAD_COLUMNS, ...extraKeys.map((k) => ({ key: `extra:${k}`, header: k, width: 18 }))];
  const rows = leads.map((l) => {
    const r = {
      id: l.id,
      segment_label: segLabel[l.segment_code] || l.segment_code || '',
      assignee_name: l.assignee_id ? memberName[l.assignee_id] || '' : '',
      status_label: STATUS_LABEL[l.status] || l.status,
      next_call_at: l.next_call_at || '',
      company: l.company || '', name: l.name || '', department: l.department || '', title: l.title || '',
      phone: l.phone || '', email: l.email || '', industry: l.industry || '', employees: l.employees || '',
      memo: l.memo || '', last_note: l.last_note || '', last_contact_at: l.last_contact_at || '',
      returning: l.returning_lead_id ? 'あり' : '',
      created_at: l.created_at || '',
    };
    for (const k of extraKeys) r[`extra:${k}`] = l.extra?.[k] ?? '';
    return r;
  });
  return { columns, rows, exhibition };
}

export function buildSummary({ leads, segments, members, activities }) {
  const segRows = segments.map((s) => {
    const ls = leads.filter((l) => l.segment_code === s.code);
    return summarize(s.label, ls);
  });
  const memberRows = [...members.map((m) => summarize(m.name, leads.filter((l) => l.assignee_id === m.id))), summarize('（未割当）', leads.filter((l) => !l.assignee_id))];
  const total = summarize('合計', leads);
  const statusRows = LEAD_STATUSES.map((s) => ({ label: s.label, count: leads.filter((l) => l.status === s.code).length }));
  const cross = {};
  for (const s of segments) {
    cross[s.code] = {};
    for (const m of members) cross[s.code][m.id] = leads.filter((l) => l.segment_code === s.code && l.assignee_id === m.id).length;
    cross[s.code].unassigned = leads.filter((l) => l.segment_code === s.code && !l.assignee_id).length;
  }
  return { total, segRows, memberRows, statusRows, cross, activityCount: activities?.length ?? 0 };
}

export function summarize(label, ls) {
  const meta = Object.fromEntries(LEAD_STATUSES.map((s) => [s.code, s]));
  const total = ls.length;
  const touched = ls.filter((l) => meta[l.status]?.touched).length;
  const connected = ls.filter((l) => meta[l.status]?.connected).length;
  const appointment = ls.filter((l) => l.status === 'appointment').length;
  const sentDocs = ls.filter((l) => l.status === 'sent_docs').length;
  const remaining = ls.filter((l) => !meta[l.status]?.closed).length;
  return {
    label, total, touched, connected, appointment, sent_docs: sentDocs, remaining,
    connect_rate: touched ? connected / touched : null,
    appointment_rate: connected ? appointment / connected : null,
  };
}

export async function toXlsxBuffer({ exhibition, leads, segments, members, activities }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'expo-lead-followup';
  wb.created = new Date();

  const { columns, rows } = buildExportRows({ exhibition, leads, segments, members });
  const ws = wb.addWorksheet('リード一覧', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  styleHeader(ws);
  rows.forEach((r) => ws.addRow(r));
  ws.autoFilter = { from: 'A1', to: { row: 1, column: columns.length } };

  const sum = buildSummary({ leads, segments, members, activities });
  const ws2 = wb.addWorksheet('サマリー');
  ws2.addRow([`${exhibition.name}${exhibition.held_on ? `（${exhibition.held_on}）` : ''}`]).font = { bold: true, size: 14 };
  ws2.addRow([]);
  addSummaryTable(ws2, 'セグメント別', [sum.total, ...sum.segRows]);
  ws2.addRow([]);
  addSummaryTable(ws2, '担当者別', sum.memberRows);
  ws2.addRow([]);
  ws2.addRow(['ステータス別']).font = { bold: true };
  sum.statusRows.forEach((s) => ws2.addRow([s.label, s.count]));
  ws2.getColumn(1).width = 24;
  for (let i = 2; i <= 9; i++) ws2.getColumn(i).width = 12;

  const ws3 = wb.addWorksheet('セグメント×担当');
  ws3.addRow(['セグメント', ...members.map((m) => m.name), '未割当', '合計']).font = { bold: true };
  for (const s of segments) {
    const c = sum.cross[s.code];
    const vals = members.map((m) => c[m.id]);
    ws3.addRow([s.label, ...vals, c.unassigned, vals.reduce((a, b) => a + b, 0) + c.unassigned]);
  }
  ws3.getColumn(1).width = 22;

  const ws4 = wb.addWorksheet('フォロー履歴', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws4.columns = [
    { header: '日時', key: 'created_at', width: 18 }, { header: '担当', key: 'member_name', width: 12 },
    { header: 'リードID', key: 'lead_id', width: 8 }, { header: '会社名', key: 'company', width: 28 }, { header: '氏名', key: 'name', width: 14 },
    { header: 'ステータス', key: 'status', width: 20 }, { header: '次回コール', key: 'next_call_at', width: 18 }, { header: 'メモ', key: 'note', width: 40 },
  ];
  styleHeader(ws4);
  for (const a of activities || []) ws4.addRow({ ...a, status: STATUS_LABEL[a.status] || a.status || '' });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function styleHeader(ws) {
  const h = ws.getRow(1);
  h.font = { bold: true };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
}

function addSummaryTable(ws, title, rows) {
  ws.addRow([title]).font = { bold: true };
  const hdr = ws.addRow(['区分', '件数', '架電済', '通電', 'アポ', '資料送付', '残件', '通電率', 'アポ率']);
  hdr.font = { bold: true };
  for (const r of rows) {
    const row = ws.addRow([r.label, r.total, r.touched, r.connected, r.appointment, r.sent_docs, r.remaining, r.connect_rate, r.appointment_rate]);
    row.getCell(8).numFmt = '0.0%';
    row.getCell(9).numFmt = '0.0%';
  }
}

// Excel で開ける UTF-8 (BOM 付き) CSV
export function toCsv({ exhibition, leads, segments, members }) {
  const { columns, rows } = buildExportRows({ exhibition, leads, segments, members });
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c.key])).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// Google スプレッドシートに書き出す 2 次元配列（リード一覧 / サマリー / 履歴）
export function toSheetValues({ exhibition, leads, segments, members, activities }) {
  const { columns, rows } = buildExportRows({ exhibition, leads, segments, members });
  const leadValues = [columns.map((c) => c.header), ...rows.map((r) => columns.map((c) => r[c.key] ?? ''))];
  const sum = buildSummary({ leads, segments, members, activities });
  const pct = (v) => (v == null ? '' : `${(v * 100).toFixed(1)}%`);
  const sumHeader = ['区分', '件数', '架電済', '通電', 'アポ', '資料送付', '残件', '通電率', 'アポ率'];
  const sumRow = (r) => [r.label, r.total, r.touched, r.connected, r.appointment, r.sent_docs, r.remaining, pct(r.connect_rate), pct(r.appointment_rate)];
  const summaryValues = [
    [`${exhibition.name}${exhibition.held_on ? `（${exhibition.held_on}）` : ''}`, `更新: ${new Date().toLocaleString('ja-JP')}`],
    [],
    ['セグメント別'], sumHeader, ...[sum.total, ...sum.segRows].map(sumRow),
    [],
    ['担当者別'], sumHeader, ...sum.memberRows.map(sumRow),
    [],
    ['ステータス別'], ...sum.statusRows.map((s) => [s.label, s.count]),
  ];
  const histValues = [
    ['日時', '担当', 'リードID', '会社名', '氏名', 'ステータス', '次回コール', 'メモ'],
    ...(activities || []).map((a) => [a.created_at, a.member_name || '', a.lead_id, a.company || '', a.name || '', STATUS_LABEL[a.status] || a.status || '', a.next_call_at || '', a.note || '']),
  ];
  return { 'リード一覧': leadValues, 'サマリー': summaryValues, 'フォロー履歴': histValues };
}
