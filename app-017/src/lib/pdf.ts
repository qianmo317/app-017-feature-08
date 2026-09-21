/**
 * 多页矢量 PDF 生成器（浏览器端，无第三方依赖）。
 * 每页按真实纸张尺寸（mm → PDF pt）出一页，凸点用矢量黑色圆点绘制，
 * 打印效果与 SVG 一致，且 PDF 阅读器可以一页页连续往下翻。
 * 输出完全确定：无时间戳 / 无随机 ID / 固定编号顺序，同一份文档重复导出字节一致。
 */
import type { BrailleCell, PageSetup, PrinterParams } from '../types';
import type { LayoutPage } from './layout';
import { concatBytes, zlibDeflate } from './deflate';

const MM_PER_INCH = 25.4;
const PT_PER_INCH = 72;
const mmToPt = (mm: number) => (mm / MM_PER_INCH) * PT_PER_INCH;

/** 点位 → 方内偏移（单位：点距）。与 svg.ts 保持一致：左列 1/2/3，右列 4/5/6 */
const DOT_OFFSET: Record<number, [number, number]> = {
  1: [0, 0],
  4: [1, 0],
  2: [0, 1],
  5: [1, 1],
  3: [0, 2],
  6: [1, 2],
};

const f = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

function fillCircle(cx: number, cy: number, r: number): string {
  // 四次三次贝塞尔近似圆，kappa = 4*(sqrt(2)-1)/3
  const k = r * 0.5522847498;
  return (
    `${f(cx - r)} ${f(cy)} m\n` +
    `${f(cx - r)} ${f(cy + k)} ${f(cx - k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c\n` +
    `${f(cx + k)} ${f(cy + r)} ${f(cx + r)} ${f(cy + k)} ${f(cx + r)} ${f(cy)} c\n` +
    `${f(cx + r)} ${f(cy - k)} ${f(cx + k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c\n` +
    `${f(cx - k)} ${f(cy - r)} ${f(cx - r)} ${f(cy - k)} ${f(cx - r)} ${f(cy)} c\n` +
    `h f\n`
  );
}

/** 单页正文内容流（未压缩）：白底 + 所有凸点 */
export function pageContentStream(
  page: LayoutPage,
  setup: PageSetup,
  printer: PrinterParams,
): Uint8Array {
  const w = mmToPt(printer.paperWidthMm);
  const h = mmToPt(printer.paperHeightMm);
  const r = mmToPt(printer.dotDiameterMm / 2);
  const parts: string[] = [];
  parts.push('0 g\n');
  parts.push(`0 0 ${f(w)} ${f(h)} re f\n`); // 白底，防止阅读器用透明/深色背景
  for (let li = 0; li < page.lines.length; li++) {
    const line = page.lines[li];
    for (let ci = 0; ci < line.cells.length; ci++) {
      const cell: BrailleCell = line.cells[ci];
      if (cell.dots.length === 0) continue;
      const xMm = setup.marginMm.left + ci * printer.cellPitchMm;
      const yTopMm = setup.marginMm.top + li * printer.linePitchMm;
      for (const d of cell.dots) {
        const [ox, oy] = DOT_OFFSET[d] ?? [0, 0];
        // 与 svg.ts 完全一致：圆心位于 (x+ox·点距, y+oy·点距)
        const cx = mmToPt(xMm + ox * printer.dotPitchMm);
        // PDF 坐标自下而上，将「距页顶」翻成「距页底」
        const cy = h - mmToPt(yTopMm + oy * printer.dotPitchMm);
        parts.push(fillCircle(cx, cy, r));
      }
    }
  }
  return new TextEncoder().encode(parts.join(''));
}

export interface ExportProgress {
  onProgress?: (pagesDone: number, totalPages: number) => void;
  signal?: AbortSignal;
}

/** 多页排版结果 → 单个多页 PDF Blob。任何一页失败 / 中止都会抛出，不会下载半截文件。 */
export async function pagesToPdfBlob(
  pages: LayoutPage[],
  setup: PageSetup,
  printer: PrinterParams,
  prog: ExportProgress = {},
): Promise<Blob> {
  if (pages.length === 0) throw new Error('没有可导出的页面');
  prog.signal?.throwIfAborted();

  const w = mmToPt(printer.paperWidthMm);
  const h = mmToPt(printer.paperHeightMm);
  const n = pages.length;

  // 逐页压缩内容流；全部成功后才开始拼装文件
  const contentBlobs: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    prog.signal?.throwIfAborted();
    const raw = pageContentStream(pages[i], setup, printer);
    contentBlobs.push(await zlibDeflate(raw, { signal: prog.signal }));
    prog.onProgress?.(i + 1, n);
    // 每页让出一次主线程：进度可刷新、中止可响应（上百页时尤其必要）
    if (i < n - 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const put = (b: Uint8Array) => {
    chunks.push(b);
    length += b.length;
  };

  // PDF 头（第二行放二进制标记，防止被当作文本误处理）
  put(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // 1 catalog / 2 pages / 随后：每页 page + content 两个对象
  const pageObjId = (i: number) => 3 + i * 2;
  const contentObjId = (i: number) => 4 + i * 2;

  const writeObj = (id: number, body: Uint8Array) => {
    offsets[id] = length;
    put(enc.encode(`${id} 0 obj\n`));
    put(body);
    put(enc.encode('\nendobj\n'));
  };

  writeObj(1, enc.encode('<< /Type /Catalog /Pages 2 0 R >>'));
  const kids = Array.from({ length: n }, (_, i) => `${pageObjId(i)} 0 R`).join(' ');
  writeObj(2, enc.encode(`<< /Type /Pages /Count ${n} /Kids [${kids}] >>`));

  for (let i = 0; i < n; i++) {
    writeObj(
      pageObjId(i),
      enc.encode(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(w)} ${f(h)}] ` +
          `/Resources << >> /Contents ${contentObjId(i)} 0 R >>`,
      ),
    );
    const data = contentBlobs[i];
    writeObj(
      contentObjId(i),
      concatBytes([enc.encode(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`), data, enc.encode('\nendstream')]),
    );
  }

  const xrefStart = length;
  const objCount = 2 + n * 2;
  let xref = `xref\n0 ${objCount + 1}\n`;
  xref += '0000000000 65535 f \n'; // 固定 20 字节
  for (let id = 1; id <= objCount; id++) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  put(enc.encode(xref));

  return new Blob(chunks, { type: 'application/pdf' });
}

/** 估算导出文件体积：盲文页以白底长扫描行为主，zlib 压缩率高，按压缩后 12% 粗估 + 结构开销 */
export function estimatePdfBytes(pages: LayoutPage[], setup: PageSetup, printer: PrinterParams): number {
  if (pages.length === 0) return 0;
  let total = 0;
  for (const p of pages) total += pageContentStream(p, setup, printer).length;
  return Math.round(total * 0.12) + pages.length * 150 + 400;
}
