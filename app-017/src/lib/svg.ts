/**
 * 点阵图输出：按「方」绘制 6 点（3 行 × 2 列），SVG 用户单位 = mm，
 * width/height 带 mm 单位 → 打印 100% 时为真实尺寸（点距 2.5mm、点径 1.5mm 可配置）。
 */
import type { BrailleCell, PageSetup, PrinterParams } from '../types';
import type { LayoutPage } from './layout';

/** 点位 → 方内偏移（单位：点距）。左列 1/2/3，右列 4/5/6 */
const DOT_OFFSET: Record<number, [number, number]> = {
  1: [0, 0],
  4: [1, 0],
  2: [0, 1],
  5: [1, 1],
  3: [0, 2],
  6: [1, 2],
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface PageSVGOptions {
  /** 显示错误标记（预览用）；打印导出保持纯黑 */
  markUncertain?: boolean;
  /** 显示来源对照（调试用，默认关闭） */
  showSource?: boolean;
}

function cellDotsSVG(cell: BrailleCell, x: number, y: number, p: PrinterParams): string {
  const r = p.dotDiameterMm / 2;
  return cell.dots
    .map((d) => {
      const [ox, oy] = DOT_OFFSET[d] ?? [0, 0];
      const cx = (x + ox * p.dotPitchMm).toFixed(3);
      const cy = (y + oy * p.dotPitchMm).toFixed(3);
      return `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(3)}"/>`;
    })
    .join('');
}

/** 单页 → 独立 SVG 字符串（真实 mm 尺寸，可直接打印） */
export function pageToSVG(page: LayoutPage, setup: PageSetup, printer: PrinterParams, opts: PageSVGOptions = {}): string {
  const w = printer.paperWidthMm;
  const h = printer.paperHeightMm;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}" class="braille-page">${pageBodySVG(page, setup, printer, opts)}</svg>`;
}

/** 单页凸点正文（不含 svg 外壳），供单页/长图复用，保证两种导出内容完全一致 */
function pageBodySVG(page: LayoutPage, setup: PageSetup, printer: PrinterParams, opts: PageSVGOptions = {}): string {
  const parts: string[] = [];
  page.lines.forEach((line, li) => {
    line.cells.forEach((cell, ci) => {
      if (cell.dots.length === 0) return;
      const x = setup.marginMm.left + ci * printer.cellPitchMm;
      const y = setup.marginMm.top + li * printer.linePitchMm;
      parts.push(`<g${cell.uncertain && opts.markUncertain ? ' class="uncertain"' : ''}>${cellDotsSVG(cell, x, y, printer)}</g>`);
    });
  });
  return parts.join('');
}

/**
 * 多页 → 单个 SVG 长图：所有页按页序竖向拼接（页间不留缝，可连续向下翻看）。
 * 与单页导出共用同一套坐标计算，内容确定、重复导出字节一致。
 */
export function pagesToLongSVG(pages: LayoutPage[], setup: PageSetup, printer: PrinterParams): string {
  if (pages.length === 0) throw new Error('没有可导出的页面');
  const w = printer.paperWidthMm;
  const h = printer.paperHeightMm;
  const bodies = pages
    .map((p, i) => `<g transform="translate(0,${(i * h).toFixed(3)})">${pageBodySVG(p, setup, printer)}</g>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${(h * pages.length).toFixed(3)}mm" viewBox="0 0 ${w} ${(h * pages.length).toFixed(3)}">${bodies}</svg>`;
}

/** 长 SVG 的 UTF-8 字节数（导出前展示确切体积） */
export function longSVGByteLength(pages: LayoutPage[], setup: PageSetup, printer: PrinterParams): number {
  return new TextEncoder().encode(pagesToLongSVG(pages, setup, printer)).length;
}

export interface SVGBuildProgress {
  onProgress?: (pagesDone: number, totalPages: number) => void;
  signal?: AbortSignal;
}

/**
 * 逐页拼装单个 SVG 长图：页间让出主线程并回报进度，支持中止。
 * 中止/失败时 reject，不会触发下载。
 */
export async function pagesToLongSVGString(
  pages: LayoutPage[],
  setup: PageSetup,
  printer: PrinterParams,
  prog: SVGBuildProgress = {},
): Promise<string> {
  if (pages.length === 0) throw new Error('没有可导出的页面');
  prog.signal?.throwIfAborted();
  const w = printer.paperWidthMm;
  const h = printer.paperHeightMm;
  const parts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    prog.signal?.throwIfAborted();
    parts.push(`<g transform="translate(0,${(i * h).toFixed(3)})">${pageBodySVG(pages[i], setup, printer)}</g>`);
    prog.onProgress?.(i + 1, pages.length);
    // 让出主线程，使进度条可刷新、中止可响应
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${(h * pages.length).toFixed(3)}mm" viewBox="0 0 ${w} ${(h * pages.length).toFixed(3)}">${parts.join('')}</svg>`;
}

/**
 * 打印校准页：横向/纵向各一段 10 方点阵 + mm 标尺线 + 说明文字。
 * 用途：打印后用尺量「10 方宽 = 62mm（默认）」验证水平/垂直点距。
 */
export function calibrationSVG(printer: PrinterParams, setup: PageSetup): string {
  const p = printer;
  const w = p.paperWidthMm;
  const h = p.paperHeightMm;
  const parts: string[] = [];
  const x0 = setup.marginMm.left;
  const y0 = setup.marginMm.top + 20;

  const dots = (n: number) => [1, 2, 3, 4, 5, 6].slice(0, n);

  // 横向：10 方满点方阵
  for (let c = 0; c < 10; c++) {
    parts.push(cellDotsSVG({ dots: dots(6), kind: 'prefix' }, x0 + c * p.cellPitchMm, y0, p));
  }
  const rowWidthMm = 9 * p.cellPitchMm + p.dotPitchMm;
  // 横向标尺线
  parts.push(
    `<line x1="${x0}" y1="${y0 + 8}" x2="${x0 + rowWidthMm}" y2="${y0 + 8}" stroke="#000" stroke-width="0.3"/>`,
    `<text x="${x0}" y="${y0 + 13}" font-family="sans-serif" font-size="4">横向 10 方 ≈ ${rowWidthMm.toFixed(1)} mm</text>`,
  );

  // 纵向：10 行满点方阵
  const y1 = y0 + 30;
  for (let r = 0; r < 10; r++) {
    parts.push(cellDotsSVG({ dots: dots(6), kind: 'prefix' }, x0, y1 + r * p.linePitchMm, p));
  }
  const rowHeightMm = 9 * p.linePitchMm + 2 * p.dotPitchMm;
  parts.push(
    `<line x1="${x0 + 20}" y1="${y1}" x2="${x0 + 20}" y2="${y1 + 9 * p.linePitchMm}" stroke="#000" stroke-width="0.3"/>`,
    `<text x="${x0 + 24}" y="${y1 + 9 * p.linePitchMm / 2}" font-family="sans-serif" font-size="4">纵向 10 行 ≈ ${rowHeightMm.toFixed(1)} mm</text>`,
  );

  const note =
    `打印校准页 · 打印时请选择「实际大小 / 100%」，缩放会改变点距\n` +
    `点距 ${p.dotPitchMm}mm · 点径 ${p.dotDiameterMm}mm · 方距 ${p.cellPitchMm}mm · 行距 ${p.linePitchMm}mm\n` +
    `量测凸点横向 10 方总宽应 ≈ ${rowWidthMm.toFixed(1)}mm（误差 ±0.2mm 内为合格）`;
  parts.push(
    `<text x="${x0}" y="${setup.marginMm.top}" font-family="sans-serif" font-size="5" font-weight="bold">${esc('打印校准页')}</text>`,
    ...note
      .split('\n')
      .map((l, i) => `<text x="${x0}" y="${setup.marginMm.top + 8 + i * 5}" font-family="sans-serif" font-size="3.5">${esc(l)}</text>`),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
}
