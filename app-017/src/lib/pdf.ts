/**
 * 多页 PDF 导出（浏览器端，零第三方依赖）。
 *
 * 矢量绘制：每个凸点用四段三次贝塞尔近似圆直接写入内容流，
 * 打印按真实 mm 尺寸（PDF 用户单位 = 1/72 inch），无栅格化、无字体依赖。
 *
 * 可重复性：文件内不写入任何时间戳 / 生成器字段，/ID 由内容哈希派生；
 * 同一份文档（含页面设置与打印机参数）重复导出字节一致。
 */
import type { PageSetup, PrinterParams } from '../types';
import type { LayoutPage } from './layout';

const MM_TO_PT = 72 / 25.4;
const K = 0.5522847498; // 圆 → 三次贝塞尔系数
const enc = new TextEncoder();

/** 点位 → 方内偏移（与 svg.ts 保持一致） */
const DOT_OFFSET: Record<number, [number, number]> = {
  1: [0, 0],
  4: [1, 0],
  2: [0, 1],
  5: [1, 1],
  3: [0, 2],
  6: [1, 2],
};

/** 固定两位小数 → 去尾零；0.01pt ≈ 3.5μm，远小于点径，精度足够且输出确定 */
function n(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(r);
}

/** 单页内容流（PDF 坐标原点在左下角，SVG y 向下，需要按页高翻转） */
function pageContentStream(page: LayoutPage, setup: PageSetup, p: PrinterParams, wPt: number, hPt: number): string {
  const dotR = (p.dotDiameterMm / 2) * MM_TO_PT;
  const parts: string[] = [];
  // 白底（避免某些查看器按透明处理）
  parts.push(`1 g 0 0 ${n(wPt)} ${n(hPt)} re f`);
  parts.push('0 g');

  let body = '';
  for (let li = 0; li < page.lines.length; li++) {
    const line = page.lines[li];
    for (let ci = 0; ci < line.cells.length; ci++) {
      const cell = line.cells[ci];
      if (cell.dots.length === 0) continue;
      const cxMm = setup.marginMm.left + ci * p.cellPitchMm;
      const cyMmTop = setup.marginMm.top + li * p.linePitchMm;
      for (const d of cell.dots) {
        const [ox, oy] = DOT_OFFSET[d] ?? [0, 0];
        const cx = (cxMm + ox * p.dotPitchMm) * MM_TO_PT;
        const cy = hPt - (cyMmTop + oy * p.dotPitchMm) * MM_TO_PT;
        const r = dotR;
        const kr = K * r;
        const x = n(cx);
        const y = n(cy);
        body +=
          `${x} ${n(cy + r)} m` +
          `${n(cx + kr)} ${n(cy + r)} ${n(cx + r)} ${n(cy + kr)} ${n(cx + r)} ${y} c` +
          `${n(cx + r)} ${n(cy - kr)} ${n(cx + kr)} ${n(cy - r)} ${x} ${n(cy - r)} c` +
          `${n(cx - kr)} ${n(cy - r)} ${n(cx - r)} ${n(cy - kr)} ${n(cx - r)} ${y} c` +
          `${n(cx - r)} ${n(cy + kr)} ${n(cx - kr)} ${n(cy + r)} ${x} ${n(cy + r)} c h`;
      }
    }
  }
  parts.push(body, 'f');
  return parts.join('\n');
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  void writer.ready.catch(() => {});
  void writer.write(bytes).catch(() => {});
  void writer.close().catch(() => {});
  const reader = cs.readable.getReader();
  const out: Uint8Array[] = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out.push(value);
  }
  let total = 0;
  for (const b of out) total += b.length;
  const flat = new Uint8Array(total);
  let off = 0;
  for (const b of out) {
    flat.set(b, off);
    off += b.length;
  }
  return flat;
}

/** FNV-1a 32 位 → 32 个十六进制字符的 /ID（重复导出同一文档时相同） */
function idHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x12345678;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[i], 0x85ebca77) >>> 0;
  }
  const hex = (v: number) => v.toString(16).padStart(8, '0');
  // 重复两遍组成 128bit 样式的 ID
  return hex(h1) + hex(h2) + hex(h2) + hex(h1);
}

export interface PdfBuildOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * 多页 → 单个 PDF Blob。逐页压缩内容流，全部成功后才组装文件；
 * 任何一页失败 / 取消都会抛错，不会返回半截文件。
 */
export async function pagesToPdfBlob(
  pages: LayoutPage[],
  setup: PageSetup,
  printer: PrinterParams,
  opts: PdfBuildOptions = {},
): Promise<Blob> {
  if (pages.length === 0) throw new Error('没有可导出的页面');
  const wPt = printer.paperWidthMm * MM_TO_PT;
  const hPt = printer.paperHeightMm * MM_TO_PT;

  // 1) 逐页生成并压缩内容流（可报进度、可取消）
  const streams: Uint8Array[] = [];
  for (let i = 0; i < pages.length; i++) {
    if (opts.signal?.aborted) throw new DOMException('导出已停止', 'AbortError');
    const raw = enc.encode(pageContentStream(pages[i], setup, printer, wPt, hPt));
    // eslint-disable-next-line no-await-in-loop
    const z = await deflate(raw);
    streams.push(z);
    opts.onProgress?.(i + 1, pages.length);
  }

  // 2) 同步组装 PDF（对象编号：1=Catalog，2=Pages，之后每页一对 Page/Contents）
  const out: number[] = [];
  const push = (s: string) => {
    const b = enc.encode(s);
    for (const v of b) out.push(v);
  };
  const offsets: number[] = [];
  const record = (s: string) => {
    offsets.push(out.length);
    push(s);
  };

  push('%PDF-1.4\n%âãÏÓ\n');

  record('<</Type/Catalog/Pages 2 0 R>>\nendobj\n');
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  record(
    `<</Type/Pages/Kids[${kids}]/Count ${pages.length}` +
      `/MediaBox[0 0 ${n(wPt)} ${n(hPt)}]/Resources<<>>>>\nendobj\n`,
  );
  for (let i = 0; i < pages.length; i++) {
    const pageObj = 3 + i * 2;
    const contentObj = pageObj + 1;
    record(`<</Type/Page/Parent 2 0 R/Contents ${contentObj} 0 R>>\nendobj\n`);
    record(`<</Length ${streams[i].length}/Filter/FlateDecode>>\nstream\n`);
    out.push(...streams[i]);
    push('\nendstream\nendobj\n');
  }

  const xrefOffset = out.length;
  const objectCount = 2 + pages.length * 2;
  // 对「除 trailer 外的全部文件字节」取哈希：内容相同 → ID 相同（与 xrefOffset 无关）
  const id = idHash(new Uint8Array(out));
  push(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
  for (const off of offsets) push(`${String(off).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<</Size ${objectCount + 1}/Root 1 0 R/ID[<${id}><${id}>]>>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob([new Uint8Array(out)], { type: 'application/pdf' });
}

/** 统计全部页的凸点数 */
export function countDots(pages: LayoutPage[]): number {
  let count = 0;
  for (const page of pages) {
    for (const line of page.lines) {
      for (const cell of line.cells) count += cell.dots.length;
    }
  }
  return count;
}

/**
 * PDF 文件大小预估（字节）。内容流为坐标文本（zlib 压缩），
 * 按实测量级「每凸点压缩后约 40 字节 + 每页对象开销」估计，仅用于导出前告知。
 */
export function estimatePdfBytes(pages: LayoutPage[]): number {
  return countDots(pages) * 40 + pages.length * 400 + 900;
}
