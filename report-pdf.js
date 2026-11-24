// ==========================================
// Financial report -> PDF (uses pdf-lib, pure JavaScript, no system deps)
// ==========================================

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 44;
const CONTENT_W = PAGE_W - MARGIN * 2;

// Standard PDF fonts only cover the WinAnsi character set, so map the
// common "smart" characters and swap anything else for a safe fallback.
const WIN_ANSI_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

function pdfSafe(input) {
  const str = String(input ?? '')
    .replace(/₹\s?/g, 'Rs. ')
    .replace(/[‐-‒]/g, '-')
    .replace(/ /g, ' ')
    .replace(/[\r\n\t]+/g, ' ');
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) || WIN_ANSI_EXTRAS.has(ch)) {
      out += ch;
    } else {
      out += '?';
    }
  }
  return out;
}

function rupees(val) {
  const num = Number(val || 0);
  const sign = num < 0 ? '-' : '';
  return `${sign}Rs. ${Math.abs(num).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function formatDate(sqlDate) {
  if (!sqlDate) return '-';
  const d = new Date(String(sqlDate).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return String(sqlDate);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function hexToRgb(hex, fallback = [0.72, 0.11, 0.11]) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return rgb(...fallback);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

const INK = rgb(0.094, 0.078, 0.071);
const MUTED = rgb(0.34, 0.31, 0.29);
const LINE = rgb(0.87, 0.85, 0.82);
const HEAD_FILL = rgb(0.965, 0.95, 0.94);
const ZEBRA = rgb(0.985, 0.978, 0.972);
const GREEN = rgb(0.08, 0.5, 0.24);
const RED = rgb(0.6, 0.1, 0.1);

class Writer {
  constructor(doc, fonts, brand) {
    this.doc = doc;
    this.font = fonts.regular;
    this.bold = fonts.bold;
    this.brand = brand;
    this.pages = [];
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
  }

  ensure(height) {
    if (this.y - height < MARGIN + 24) {
      this.newPage();
      return true;
    }
    return false;
  }

  fit(text, font, size, maxWidth) {
    let str = pdfSafe(text);
    if (font.widthOfTextAtSize(str, size) <= maxWidth) return str;
    while (str.length > 1 && font.widthOfTextAtSize(`${str}...`, size) > maxWidth) {
      str = str.slice(0, -1);
    }
    return `${str.trimEnd()}...`;
  }

  wrap(text, font, size, maxWidth) {
    const words = pdfSafe(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = font.widthOfTextAtSize(word, size) > maxWidth ? this.fit(word, font, size, maxWidth) : word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  text(str, { x = MARGIN, size = 10, font = this.font, color = INK, maxWidth = CONTENT_W, gap = 4 } = {}) {
    const lines = this.wrap(str, font, size, maxWidth);
    for (const line of lines) {
      this.ensure(size + gap);
      this.page.drawText(line, { x, y: this.y - size, size, font, color });
      this.y -= size + gap;
    }
  }

  space(h) {
    this.y -= h;
  }

  heading(str) {
    this.ensure(100); // keep a heading together with the start of its table
    this.space(10);
    this.page.drawRectangle({ x: MARGIN, y: this.y - 14, width: 3, height: 14, color: this.brand });
    this.page.drawText(pdfSafe(str), { x: MARGIN + 9, y: this.y - 12, size: 12.5, font: this.bold, color: INK });
    this.y -= 22;
  }

  note(str) {
    this.text(str, { size: 8.5, color: MUTED, gap: 3 });
  }

  // columns: [{ label, width (fraction of content width), align: 'left'|'right' }]
  table(columns, rows, { totalRow = null, emptyText = 'Nothing to show.' } = {}) {
    const rowH = 17;
    const size = 8.6;
    const pad = 5;
    const widths = columns.map((c) => c.width * CONTENT_W);

    const drawHeader = () => {
      this.page.drawRectangle({ x: MARGIN, y: this.y - rowH, width: CONTENT_W, height: rowH, color: HEAD_FILL });
      let x = MARGIN;
      columns.forEach((col, i) => {
        const label = this.fit(col.label, this.bold, size, widths[i] - pad * 2);
        const w = this.bold.widthOfTextAtSize(label, size);
        const tx = col.align === 'right' ? x + widths[i] - pad - w : x + pad;
        this.page.drawText(label, { x: tx, y: this.y - rowH + 5.5, size, font: this.bold, color: MUTED });
        x += widths[i];
      });
      this.y -= rowH;
      this.page.drawLine({
        start: { x: MARGIN, y: this.y }, end: { x: MARGIN + CONTENT_W, y: this.y }, thickness: 0.8, color: LINE,
      });
    };

    const drawRow = (cells, { bold = false, fill = null, colors = [] } = {}) => {
      if (this.ensure(rowH + 2)) drawHeader();
      if (fill) {
        this.page.drawRectangle({ x: MARGIN, y: this.y - rowH, width: CONTENT_W, height: rowH, color: fill });
      }
      let x = MARGIN;
      const font = bold ? this.bold : this.font;
      columns.forEach((col, i) => {
        const val = this.fit(cells[i] ?? '', font, size, widths[i] - pad * 2);
        const w = font.widthOfTextAtSize(val, size);
        const tx = col.align === 'right' ? x + widths[i] - pad - w : x + pad;
        this.page.drawText(val, { x: tx, y: this.y - rowH + 5.5, size, font, color: colors[i] || INK });
        x += widths[i];
      });
      this.y -= rowH;
      this.page.drawLine({
        start: { x: MARGIN, y: this.y }, end: { x: MARGIN + CONTENT_W, y: this.y }, thickness: 0.4, color: LINE,
      });
    };

    this.ensure(rowH * 3);
    drawHeader();

    if (!rows.length) {
      drawRow([emptyText, ...columns.slice(1).map(() => '')], { colors: [MUTED] });
      return;
    }

    rows.forEach((r, idx) => {
      const cells = Array.isArray(r) ? r : r.cells;
      drawRow(cells, { fill: idx % 2 === 1 ? ZEBRA : null, colors: r.colors || [] });
    });

    if (totalRow) drawRow(totalRow, { bold: true, fill: HEAD_FILL });
  }

  statBoxes(stats) {
    const gap = 10;
    const h = 62;
    const w = (CONTENT_W - gap * (stats.length - 1)) / stats.length;
    this.ensure(h + 10);
    stats.forEach((s, i) => {
      const x = MARGIN + i * (w + gap);
      const y = this.y - h;
      this.page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 1, 1), borderColor: LINE, borderWidth: 0.8 });
      this.page.drawRectangle({ x, y: y + h - 3, width: w, height: 3, color: s.color || this.brand });
      this.page.drawText(pdfSafe(s.label).toUpperCase(), { x: x + 10, y: y + h - 18, size: 7.5, font: this.bold, color: MUTED });
      this.page.drawText(this.fit(s.value, this.bold, 15, w - 20), { x: x + 10, y: y + h - 38, size: 15, font: this.bold, color: s.color || INK });
      this.page.drawText(this.fit(s.sub || '', this.font, 7.8, w - 20), { x: x + 10, y: y + 9, size: 7.8, font: this.font, color: MUTED });
    });
    this.y -= h + 6;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.report        { title, period_label, report_type, generated_by, created_at, summary }
 * @param {Array}  opts.majorDonations rows { id, donor, house_name, amount, event_tag, note, is_manual, created_at }
 * @param {number} opts.threshold
 * @param {object} opts.theme         { siteName, colors: { primary } }
 */
async function buildReportPdf({ report, majorDonations, threshold, theme }) {
  const doc = await PDFDocument.create();
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const brand = hexToRgb(theme && theme.colors && theme.colors.primary);
  const siteName = pdfSafe((theme && theme.siteName) || 'GSB ONLINE');
  const s = report.summary || {};

  doc.setTitle(pdfSafe(report.title));
  doc.setAuthor(siteName);
  doc.setSubject(pdfSafe(`Financial report - ${report.period_label}`));
  doc.setCreator(siteName);

  const w = new Writer(doc, fonts, brand);

  // Header band
  w.page.drawRectangle({ x: 0, y: PAGE_H - 70, width: PAGE_W, height: 70, color: brand });
  w.page.drawText(siteName, { x: MARGIN, y: PAGE_H - 43, size: 17, font: fonts.bold, color: rgb(1, 1, 1) });
  const tag = 'FINANCIAL REPORT';
  w.page.drawText(tag, {
    x: PAGE_W - MARGIN - fonts.bold.widthOfTextAtSize(tag, 9),
    y: PAGE_H - 40, size: 9, font: fonts.bold, color: rgb(1, 1, 1),
  });
  w.y = PAGE_H - 70 - 26;

  w.text(report.title, { size: 18, font: fonts.bold, gap: 6 });
  w.text(`Period: ${report.period_label}`, { size: 10.5, color: MUTED, gap: 4 });
  if (report.scope_label) w.text(`Covers: ${report.scope_label}`, { size: 10.5, color: MUTED, gap: 4 });
  w.text(
    `Generated by ${report.generated_by || '-'} on ${formatDate(report.created_at)}  ·  Downloaded ${formatDate(
      new Date().toISOString().slice(0, 19).replace('T', ' ')
    )}`,
    { size: 9, color: MUTED, gap: 4 }
  );
  w.space(10);

  w.statBoxes([
    {
      label: 'Total Donations',
      value: rupees(s.total_donations),
      sub: s.manual_donations_total > 0
        ? `${s.donation_count || 0} entries · ${rupees(s.manual_donations_total)} offline`
        : `${s.donation_count || 0} donation(s)`,
      color: GREEN,
    },
    { label: 'Total Expenses', value: rupees(s.total_expenses), sub: `${s.expense_count || 0} expense(s)`, color: RED },
    { label: 'Net Balance', value: rupees(s.net_balance), sub: 'Donations minus expenses', color: brand },
  ]);

  // Major donations
  w.heading(`Donations above ${rupees(threshold)}`);
  const majorTotal = majorDonations.reduce((sum, d) => sum + Number(d.amount || 0), 0);
  const multiCentre = report.scope_type && report.scope_type !== 'centre';
  w.table(
    [
      { label: 'Receipt', width: 0.14 },
      { label: 'Donor', width: 0.21 },
      { label: multiCentre ? 'Centre' : 'House', width: 0.14 },
      { label: 'Event / Cause', width: 0.16 },
      { label: 'Date', width: 0.13 },
      { label: 'Amount', width: 0.22, align: 'right' },
    ],
    majorDonations.map((d) => [
      `DON-${String(d.id).padStart(5, '0')}`,
      d.donor + (d.is_manual ? ' (offline)' : ''),
      (multiCentre ? d.centre_name : d.house_name) || '-',
      d.event_tag || 'General',
      formatDate(d.created_at),
      rupees(d.amount),
    ]),
    {
      totalRow: majorDonations.length
        ? ['Total', `${majorDonations.length} donation(s)`, '', '', '', rupees(majorTotal)]
        : null,
      emptyText: `No donations above ${rupees(threshold)} in this period.`,
    }
  );
  w.space(3);
  w.note('This list is taken from the donation records at the time of download.');

  // Donations by centre (area-wide reports)
  if ((s.donations_by_centre || []).length > 1) {
    w.heading('Donations by centre');
    w.table(
      [
        { label: 'Centre', width: 0.55 },
        { label: 'Entries', width: 0.15, align: 'right' },
        { label: 'Total donated', width: 0.3, align: 'right' },
      ],
      s.donations_by_centre.map((c) => [c.category || '-', String(c.count), rupees(c.total)]),
      { totalRow: ['Total', String(s.donation_count || 0), rupees(s.total_donations)] }
    );
  }

  // Donations by category
  w.heading('Donations under each category (event)');
  const cats = s.donations_by_category || [];
  w.table(
    [
      { label: 'Category', width: 0.55 },
      { label: 'Entries', width: 0.15, align: 'right' },
      { label: 'Total donated', width: 0.3, align: 'right' },
    ],
    cats.map((c) => [c.category, String(c.count), rupees(c.total)]),
    {
      totalRow: cats.length ? ['Total', String(s.donation_count || 0), rupees(s.total_donations)] : null,
      emptyText: 'No donations in this period.',
    }
  );

  // Expenses by type and by event
  const groupTable = (title, groups) => {
    w.heading(title);
    w.table(
      [
        { label: 'Category', width: 0.55 },
        { label: 'Entries', width: 0.15, align: 'right' },
        { label: 'Total spent', width: 0.3, align: 'right' },
      ],
      (groups || []).map((g) => [g.category, String(g.count), rupees(g.total)]),
      {
        totalRow: (groups || []).length ? ['Total', String(s.expense_count || 0), rupees(s.total_expenses)] : null,
        emptyText: 'No expenses in this period.',
      }
    );
  };
  groupTable('Expenses under each type', s.expenses_by_type);
  groupTable('Expenses under each event', s.expenses_by_event);

  // Expense details
  const expenseItems = (s.expenses_by_type || []).flatMap((g) => g.items || []).sort((a, b) => b.id - a.id);
  if (expenseItems.length) {
    w.heading('Expense details');
    w.table(
      [
        { label: '#', width: 0.08 },
        { label: 'Type', width: 0.17 },
        { label: 'Event', width: 0.17 },
        { label: 'Note', width: 0.27 },
        { label: 'Date', width: 0.13 },
        { label: 'Amount', width: 0.18, align: 'right' },
      ],
      expenseItems.map((e) => [
        `#${e.id}`, e.type_tag, e.event_tag, e.note || '-', formatDate(e.created_at), rupees(e.amount),
      ])
    );
  }

  // Footer on every page
  const total = w.pages.length;
  w.pages.forEach((page, i) => {
    const footer = pdfSafe(`${siteName}  ·  ${report.title}`);
    page.drawLine({
      start: { x: MARGIN, y: MARGIN - 4 }, end: { x: PAGE_W - MARGIN, y: MARGIN - 4 }, thickness: 0.5, color: LINE,
    });
    page.drawText(w.fit(footer, fonts.regular, 7.5, CONTENT_W - 80), {
      x: MARGIN, y: MARGIN - 16, size: 7.5, font: fonts.regular, color: MUTED,
    });
    const pn = `Page ${i + 1} of ${total}`;
    page.drawText(pn, {
      x: PAGE_W - MARGIN - fonts.regular.widthOfTextAtSize(pn, 7.5),
      y: MARGIN - 16, size: 7.5, font: fonts.regular, color: MUTED,
    });
  });

  return Buffer.from(await doc.save());
}

module.exports = { buildReportPdf, pdfSafe };
