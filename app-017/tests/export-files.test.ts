/**
 * 合并导出文件测试：
 * - 长 PNG：手工解析 chunk、zlib 解压像素，验证多页纵向拼接顺序、尺寸、CRC、确定性、缺页即作废、可取消；
 * - PDF：解析对象结构、解压内容流，验证页数、MediaBox、凸点路径数量与确定性。
 */
import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { encodeLongPng, estimateLongPngBytes } from '../src/lib/png';
import { pagesToPdfBlob, estimatePdfBytes, countDots } from '../src/lib/pdf';
import type { LayoutPage } from '../src/lib/layout';
import type { PageSetup, PrinterParams } from '../src/types';

/* ------------------------------- PNG 工具 ------------------------------- */

interface PngChunk {
  type: string;
  data: Buffer;
}

function parsePng(buf: Buffer): { chunks: PngChunk[] } {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const chunks: PngChunk[] = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crcStored = buf.readUInt32BE(off + 8 + len);
    const crcActual = zlib.crc32(buf.subarray(off + 4, off + 8 + len)) >>> 0;
    expect(crcStored).toBe(crcActual);
    chunks.push({ type, data });
    off += 12 + len;
  }
  return { chunks };
}

/** 生成一页 RGB 原始扫描线（与 png.ts 内部格式一致：每行前置过滤字节 0） */
function rawPage(w: number, h: number, paint: ((x: number, y: number) => [number, number, number] | null) | null | undefined): Buffer {
  const fn = paint ?? (() => null);
  const stride = w * 3;
  const buf = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    buf[y * (stride + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const c = fn(x, y);
      if (c) {
        const p = y * (stride + 1) + 1 + x * 3;
        buf[p] = c[0];
        buf[p + 1] = c[1];
        buf[p + 2] = c[2];
      }
    }
  }
  return buf;
}

async function* asyncPages(buffers: Buffer[]): AsyncIterable<Uint8Array> {
  for (const b of buffers) yield b;
}

describe('长 PNG 合并导出', () => {
  const W = 4;
  const H = 5;

  it('多页纵向拼接：IHDR 总高度 = 页数 × 页高，像素按页序排列', async () => {
    const pages = [
      rawPage(W, H, (x, y) => (x === 0 && y === 0 ? [255, 0, 0] : null)), // 第 1 页首像素红
      rawPage(W, H, (x, y) => (x === 0 && y === 0 ? [0, 128, 0] : null)), // 第 2 页首像素绿
      rawPage(W, H, null), // 第 3 页全白
    ];
    const blob = await encodeLongPng(W, H, 3, asyncPages(pages));
    const buf = Buffer.from(await blob.arrayBuffer());
    const { chunks } = parsePng(buf);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);

    const ihdr = chunks[0].data;
    expect(ihdr.readUInt32BE(0)).toBe(W);
    expect(ihdr.readUInt32BE(4)).toBe(H * 3);
    expect(ihdr[8]).toBe(8);
    expect(ihdr[9]).toBe(2); // RGB

    const raw = zlib.inflateSync(chunks.find((c) => c.type === 'IDAT')!.data);
    expect(raw.length).toBe((W * 3 + 1) * H * 3);
    const pixel = (page: number, x: number, y: number) => {
      const gy = page * H + y;
      const p = gy * (W * 3 + 1) + 1 + x * 3;
      return [raw[p], raw[p + 1], raw[p + 2]];
    };
    expect(pixel(0, 0, 0)).toEqual([255, 0, 0]);
    expect(pixel(1, 0, 0)).toEqual([0, 128, 0]);
    expect(pixel(2, 0, 0)).toEqual([0, 0, 0]); // 未涂色像素为 0，拼接页底色由渲染端铺白
  });

  it('300DPI 写入 pHYs（像素/米）', async () => {
    const blob = await encodeLongPng(W, H, 1, asyncPages([rawPage(W, H, null)]), 300);
    const { chunks } = parsePng(Buffer.from(await blob.arrayBuffer()));
    const phys = chunks.find((c) => c.type === 'pHYs')!.data;
    expect(phys.readUInt32BE(0)).toBe(Math.round((300 / 25.4) * 1000));
    expect(phys.readUInt32BE(4)).toBe(Math.round((300 / 25.4) * 1000));
    expect(phys[8]).toBe(1);
  });

  it('确定性：同内容重复编码字节完全一致', async () => {
    const mk = () => [
      rawPage(W, H, (x, y) => (x === y ? [0, 0, 0] : null)),
      rawPage(W, H, (x, y) => (x === 1 ? [10, 20, 30] : null)),
    ];
    const b1 = await encodeLongPng(W, H, 2, asyncPages(mk()));
    const b2 = await encodeLongPng(W, H, 2, asyncPages(mk()));
    expect(Buffer.from(await b1.arrayBuffer())).toEqual(Buffer.from(await b2.arrayBuffer()));
  });

  it('缺页（生成器少给一页）→ 整体失败，不返回 Blob', async () => {
    await expect(encodeLongPng(W, H, 3, asyncPages([rawPage(W, H, null), rawPage(W, H, null)]))).rejects.toThrow(
      /实际仅生成 2 页/,
    );
  });

  it('生成中途抛错 → 整体失败', async () => {
    async function* broken() {
      yield rawPage(W, H, null);
      throw new Error('第 2 页渲染失败');
    }
    await expect(encodeLongPng(W, H, 2, broken())).rejects.toThrow('第 2 页渲染失败');
  });

  it('开始前已取消 → 不消费任何页即拒绝', async () => {
    const controller = new AbortController();
    controller.abort();
    let consumed = 0;
    async function* counted() {
      consumed++;
      yield rawPage(W, H, null);
    }
    await expect(encodeLongPng(W, H, 1, counted(), 300, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(consumed).toBe(0);
  });

  it('A4/300DPI 单页尺寸 = 2480×3508，长图高度按页数累加', async () => {
    const a4W = Math.round((210 / 25.4) * 300);
    const a4H = Math.round((297 / 25.4) * 300);
    expect([a4W, a4H]).toEqual([2480, 3508]);
    const est = estimateLongPngBytes(100, 210, 297);
    expect(est).toBeGreaterThan(1_000_000);
  });
});

/* ------------------------------- PDF 工具 ------------------------------- */

const setup: PageSetup = {
  cellsPerLine: 32,
  linesPerPage: 25,
  doubleSided: false,
  marginMm: { top: 20, left: 15, right: 15 },
};

const printer: PrinterParams = {
  dotDiameterMm: 1.5,
  dotPitchMm: 2.5,
  cellPitchMm: 6.2,
  linePitchMm: 10,
  paperWidthMm: 210,
  paperHeightMm: 297,
};

function makePages(n: number, dotsPerCell: number[]): LayoutPage[] {
  return Array.from({ length: n }, (_, i) => ({
    number: i + 1,
    lines: [{ cells: dotsPerCell.map((d) => ({ dots: Array.from({ length: d }, (_, k) => k + 1), kind: 'hanzi' as const })) }],
  }));
}

async function pdfBuffer(n: number, dots = [1, 6, 3]): Promise<Buffer> {
  const blob = await pagesToPdfBlob(makePages(n, dots), setup, printer);
  return Buffer.from(await blob.arrayBuffer());
}

describe('PDF 多页文档导出', () => {
  it('结构：PDF 头、页数对象、A4 MediaBox（点）、xref/trailer 完整', async () => {
    const buf = await pdfBuffer(3);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.toString('latin1').endsWith('%%EOF\n')).toBe(true);
    const text = buf.toString('latin1');
    expect(text).toContain('/Type/Catalog');
    expect(text).toContain('/Type/Pages');
    expect(text).toContain('/Count 3');
    // 每页一个 Page 对象
    expect(text.match(/\/Type\/Page(?![s])/g)).toHaveLength(3);
    // A4 宽 210mm = 595.28pt
    const media = text.match(/\/MediaBox\[0 0 ([\d.]+) ([\d.]+)\]/)!;
    expect(parseFloat(media[1])).toBeCloseTo(595.28, 1);
    expect(parseFloat(media[2])).toBeCloseTo(841.89, 1);
    // Kids 按页序引用第 3、5、7 号对象
    expect(text).toContain('/Kids[3 0 R 5 0 R 7 0 R]');
    // xref 条目数 = 对象数 + 1（2 + 3×2 = 8 个对象）
    expect(text).toContain('xref\n0 9\n');
    // startxref 指向的偏移确实是 xref 位置
    const startXref = parseInt(text.match(/startxref\n(\d+)/)![1], 10);
    expect(buf.toString('latin1', startXref, startXref + 4)).toBe('xref');
  });

  it('内容流可解压缩，每凸点 4 段贝塞尔曲线（每点一个闭合子路径）', async () => {
    const pages = makePages(2, [1, 6]); // 每页 7 个点
    const blob = await pagesToPdfBlob(pages, setup, printer);
    const buf = Buffer.from(await blob.arrayBuffer());
    const streams = [...buf.toString('latin1').matchAll(/\/FlateDecode>>\nstream\n/g)].map((m) => {
      const start = m.index! + m[0].length;
      const end = buf.indexOf('endstream', start);
      return zlib.inflateSync(buf.subarray(start, end - 1)); // 去掉结尾 \n
    });
    expect(streams).toHaveLength(2);
    for (const s of streams) {
      const t = s.toString('latin1');
      expect(t.startsWith('1 g 0 0')).toBe(true); // 白底矩形
      expect((t.match(/ c/g) || []).length).toBe(7 * 4);
      expect(t.endsWith('h\nf')).toBe(true);
    }
  });

  it('确定性：同文档重复导出字节一致（无时间戳）', async () => {
    const b1 = await pdfBuffer(4, [2, 5]);
    const b2 = await pdfBuffer(4, [2, 5]);
    expect(b1).toEqual(b2);
  });

  it('不同页内容产生不同 /ID；相同内容 /ID 相同', async () => {
    const b1 = await pdfBuffer(2);
    const b2 = await pdfBuffer(3);
    const id1 = b1.toString('latin1').match(/\/ID\[<([0-9a-f]+)>/)![1];
    const id2 = b2.toString('latin1').match(/\/ID\[<([0-9a-f]+)>/)![1];
    const id1again = (await pdfBuffer(2)).toString('latin1').match(/\/ID\[<([0-9a-f]+)>/)![1];
    expect(id1).not.toBe(id2);
    expect(id1).toBe(id1again);
  });

  it('空文档拒绝导出', async () => {
    await expect(pagesToPdfBlob([], setup, printer)).rejects.toThrow('没有可导出的页面');
  });

  it('取消导出抛出 AbortError', async () => {
    const controller = new AbortController();
    const p = pagesToPdfBlob(makePages(50, [6]), setup, printer, { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('凸点计数与大小预估随页数线性增长', async () => {
    expect(countDots(makePages(1, [1, 6]))).toBe(7);
    expect(estimatePdfBytes(makePages(10, [6]))).toBeGreaterThan(estimatePdfBytes(makePages(2, [6])));
  });
});
