/**
 * 合并导出（多页 PDF / 长 PNG 编码）的纯逻辑测试。
 * - PDF：结构合法（xref 可解析）、页数正确、重复导出字节一致、中止时不产出文件；
 * - PNG 编码器：chunk 结构 / CRC / 尺寸正确、流可解码、确定性、页数缺失即作废。
 */
import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { convertText } from '../src/lib/convert';
import { layoutDocument } from '../src/lib/layout';
import { pagesToPdfBlob, estimatePdfBytes, pageContentStream } from '../src/lib/pdf';
import { encodeGrayscalePng, pngChunk, rawFilteredBytes } from '../src/lib/png-encode';
import { pagesToLongSVG, pagesToLongSVGString, longSVGByteLength } from '../src/lib/svg';
import type { PageSetup, PrinterParams } from '../src/types';

const SETUP: PageSetup = {
  cellsPerLine: 32,
  linesPerPage: 25,
  doubleSided: false,
  marginMm: { top: 20, left: 15, right: 15 },
};
const PRINTER: PrinterParams = {
  dotDiameterMm: 1.5,
  dotPitchMm: 2.5,
  cellPitchMm: 6.2,
  linePitchMm: 10,
  paperWidthMm: 210,
  paperHeightMm: 297,
};
const OPTS = { toneMode: 'all' as const, autoDetectPinyin: true, profile: 'zh-current' as const };

function layoutPages(text: string, pageNumbers = false) {
  const conv = convertText(text, OPTS);
  return layoutDocument(conv.paragraphs, SETUP, pageNumbers).pages;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/* ---------------- PNG 编码器 ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface PngChunk {
  type: string;
  data: Uint8Array;
}

function parsePng(bytes: Uint8Array): PngChunk[] {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect([...bytes.slice(0, 8)]).toEqual(sig);
  const chunks: PngChunk[] = [];
  let off = 8;
  while (off < bytes.length) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + off, 12);
    const len = dv.getUint32(0);
    const type = String.fromCharCode(...bytes.slice(off + 4, off + 8));
    const data = bytes.slice(off + 8, off + 8 + len);
    const crcInput = bytes.slice(off + 4, off + 8 + len);
    expect(new DataView(bytes.buffer, bytes.byteOffset + off + 8 + len, 4).getUint32(0)).toBe(crc32(crcInput));
    chunks.push({ type, data });
    off += 12 + len;
  }
  return chunks;
}

/** 拼接全部 IDAT → 去 zlib 头(2B)尾(4B) → raw inflate → 去掉每行滤镜字节 */
function decodeGray(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const chunks = parsePng(bytes);
  expect(chunks[0].type).toBe('IHDR');
  const ihdr = chunks[0].data;
  expect(new DataView(ihdr.buffer, ihdr.byteOffset).getUint32(0)).toBe(width);
  expect(new DataView(ihdr.buffer, ihdr.byteOffset + 4).getUint32(0)).toBe(height);
  expect(ihdr[8]).toBe(8);
  expect(ihdr[9]).toBe(0);
  expect(chunks[chunks.length - 1].type).toBe('IEND');
  const idat = chunks.filter((c) => c.type === 'IDAT');
  expect(idat.length).toBeGreaterThan(0);
  const total = idat.reduce((s, c) => s + c.data.length, 0);
  const merged = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    merged.set(c.data, o);
    o += c.data.length;
  }
  const raw = inflateRawSync(merged.subarray(2, merged.length - 4)); // 剥 zlib 包装
  expect(raw.length).toBe((width + 1) * height);
  const pixels = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    expect(raw[r * (width + 1)]).toBe(0); // None 滤镜
    pixels.set(raw.subarray(r * (width + 1) + 1, r * (width + 1) + 1 + width), r * width);
  }
  return pixels;
}

describe('流式灰度 PNG 编码器', () => {
  it('单页：签名/IHDR/CRC/IEND 合法，像素可还原', async () => {
    const width = 4;
    const height = 3;
    const gray = Uint8Array.from([
      0, 255, 255, 0,
      255, 0, 0, 255,
      10, 20, 30, 40,
    ]);
    const blob = await encodeGrayscalePng({ width, height, pages: (async function* () { yield gray; })() });
    const pixels = decodeGray(await blobBytes(blob), width, height);
    expect([...pixels]).toEqual([...gray]);
  });

  it('多页（多 IDAT）可拼接解码', async () => {
    const width = 5;
    const pages = [new Uint8Array(width * 2).fill(255), new Uint8Array(width * 3).fill(0)];
    const height = 5;
    async function* gen() {
      for (const p of pages) yield p;
    }
    const blob = await encodeGrayscalePng({ width, height, pages: gen() });
    const pixels = decodeGray(await blobBytes(blob), width, height);
    expect(pixels.slice(0, width * 2).every((v) => v === 255)).toBe(true);
    expect(pixels.slice(width * 2).every((v) => v === 0)).toBe(true);
  });

  it('重复编码字节完全一致（无时间戳/随机量）', async () => {
    const width = 16;
    const gray = new Uint8Array(width * 7);
    for (let i = 0; i < gray.length; i++) gray[i] = i % 2 ? 0 : 255;
    async function* gen() { yield gray; }
    const [a, b] = await Promise.all([
      encodeGrayscalePng({ width, height: 7, pages: gen() }).then(blobBytes),
      encodeGrayscalePng({ width, height: 7, pages: gen() }).then(blobBytes),
    ]);
    expect([...a]).toEqual([...b]);
  });

  it('页数缺失（行数不足）→ reject，调用方拿不到文件', async () => {
    async function* gen() {
      yield new Uint8Array(4 * 2).fill(255); // 声明 3 行只给 2 行
    }
    await expect(encodeGrayscalePng({ width: 4, height: 3, pages: gen() })).rejects.toThrow(/不足|作废/);
  });

  it('中途 abort → reject AbortError', async () => {
    const controller = new AbortController();
    async function* gen() {
      yield new Uint8Array(4).fill(0);
      await new Promise((r) => setTimeout(r, 30));
      controller.abort();
      yield new Uint8Array(4).fill(0);
    }
    await expect(
      encodeGrayscalePng({ width: 4, height: 2, pages: gen(), signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('pngChunk 结构与 CRC 正确', () => {
    const data = new TextEncoder().encode('hello');
    const chunk = pngChunk('teSt', data);
    expect(chunk.length).toBe(12 + data.length);
    expect(new DataView(chunk.buffer).getUint32(0)).toBe(data.length);
    expect(String.fromCharCode(...chunk.slice(4, 8))).toBe('teSt');
  });

  it('rawFilteredBytes 计入行首滤镜字节', () => {
    expect(rawFilteredBytes(10, 3)).toBe(33);
  });
});

/* ---------------- 单文件长 SVG ---------------- */

describe('单文件长 SVG', () => {
  const longText = '盲文排版是把文字转成凸点符号的过程，特殊教育学校需要大量点字教材。'.repeat(300);

  it('高度 = 页数 × 单页高，每页一个平移分组且页序正确', () => {
    const pages = layoutPages(longText, true);
    const svg = pagesToLongSVG(pages, SETUP, PRINTER);
    const groups = svg.match(/<g transform="translate\(0,([\d.]+)\)">/g) ?? [];
    expect(groups.length).toBe(pages.length);
    // 宽 210mm，高 = 297mm × 页数
    expect(svg).toContain(`width="210mm" height="${(297 * pages.length).toFixed(3)}mm"`);
    // 第二页起点恰好下移 297mm
    expect(svg).toContain('<g transform="translate(0,297.000)">');
  });

  it('逐页流式构建与一次性构建结果相同，且重复导出字节一致', async () => {
    const pages = layoutPages('你好世界。\n第二段文字，包含数字123和英文Hello。', true);
    const a = pagesToLongSVG(pages, SETUP, PRINTER);
    let progressed = 0;
    const b = await pagesToLongSVGString(pages, SETUP, PRINTER, {
      onProgress: (done, total) => {
        expect(total).toBe(pages.length);
        progressed = done;
      },
    });
    expect(progressed).toBe(pages.length);
    expect(a).toBe(b);
    const again = await pagesToLongSVGString(pages, SETUP, PRINTER);
    expect(again).toBe(a);
  });

  it('中止时 reject，且与单页 SVG 内容一致（页内坐标未被拼接改变）', async () => {
    const pages = layoutPages(longText, true);
    const controller = new AbortController();
    const promise = pagesToLongSVGString(pages, SETUP, PRINTER, {
      signal: controller.signal,
      onProgress: (done) => {
        if (done === 2) controller.abort();
      },
    });
    await expect(promise).rejects.toThrow();

    // 第 2 页（偏移 297mm）分组内的点位坐标与独立单页相同
    const { pageToSVG } = await import('../src/lib/svg');
    const long = pagesToLongSVG(pages, SETUP, PRINTER);
    const start = long.indexOf('<g transform="translate(0,297.000)">') + '<g transform="translate(0,297.000)">'.length;
    const end = long.indexOf('<g transform="translate(0,594.000)">', start) - '</g>'.length;
    const group2 = long.slice(start, end);
    const single = pageToSVG(pages[1], SETUP, PRINTER);
    const singleBody = single.match(/<svg[^>]*>(.*)<\/svg>/)![1];
    expect(group2).toBe(singleBody);
  });

  it('字节数统计与实际 UTF-8 一致', () => {
    const pages = layoutPages('你好', true);
    const svg = pagesToLongSVG(pages, SETUP, PRINTER);
    expect(longSVGByteLength(pages, SETUP, PRINTER)).toBe(new TextEncoder().encode(svg).length);
  });
});

/* ---------------- 多页 PDF ---------------- */

describe('多页矢量 PDF', () => {
  const longText = '盲文排版是把文字转成凸点符号的过程，特殊教育学校需要大量点字教材。'.repeat(300);

  it('页数正确，xref/对象可解析，MediaBox 为 A4 尺寸（pt）', async () => {
    const pages = layoutPages(longText, true);
    expect(pages.length).toBeGreaterThan(10);
    const blob = await pagesToPdfBlob(pages, SETUP, PRINTER);
    const bytes = await blobBytes(blob);
    const text = new TextDecoder('latin1').decode(bytes);

    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.endsWith('%%EOF\n')).toBe(true);

    const startxref = Number(text.slice(text.lastIndexOf('startxref') + 'startxref'.length, text.lastIndexOf('%%EOF')).trim());
    const xref = text.slice(startxref);
    expect(xref).toContain('xref');
    const lines = xref.split('\n');
    // xref 头部行 + free 对象 + 每页 2 个对象 + catalog/pages
    const objCount = 2 + pages.length * 2;
    expect(lines[1].trim()).toBe(`0 ${objCount + 1}`);
    expect(lines.length).toBeGreaterThanOrEqual(objCount + 4);

    // 每个页对象都存在且引用了内容对象
    const pageMatches = text.match(/\/Type \/Page /g) ?? [];
    expect(pageMatches.length).toBe(pages.length);

    // A4: 595.276 x 841.89 pt（保留 3 位小数）
    expect(text).toContain('/MediaBox [0 0 595.276 841.89]');

    // 抽一个内容流做 FlateDecode，应含矢量绘图指令
    const m = text.match(/(\d+) 0 obj\n<< \/Length \d+ \/Filter \/FlateDecode >>\nstream\n/);
    expect(m).not.toBeNull();
    if (!m) return;
    const objHeader = m[0];
    const streamStart = m.index! + objHeader.length;
    const len = Number(objHeader.match(/\/Length (\d+)/)![1]);
    const stream = bytes.subarray(streamStart, streamStart + len);
    const inflated = inflateRawSync(stream.subarray(2, stream.length - 4));
    const content = new TextDecoder('latin1').decode(inflated);
    expect(content).toContain(' re f\n'); // 白底
    expect(content).toMatch(/[\d.]+ [\d.]+ m\n/); // 圆点路径
  });

  it('重复导出字节完全一致（确定性）', async () => {
    const pages = layoutPages('你好世界。\n第二段文字，包含数字123和英文Hello。', true);
    const [a, b] = await Promise.all([
      pagesToPdfBlob(pages, SETUP, PRINTER).then(blobBytes),
      pagesToPdfBlob(pages, SETUP, PRINTER).then(blobBytes),
    ]);
    expect([...a]).toEqual([...b]);
  });

  it('不同文档产出不同的内容流', async () => {
    const a = await pagesToPdfBlob(layoutPages('你好', false), SETUP, PRINTER).then(blobBytes);
    const b = await pagesToPdfBlob(layoutPages('世界', false), SETUP, PRINTER).then(blobBytes);
    expect([...a]).not.toEqual([...b]);
  });

  it('开始前 abort → 不产出任何 blob', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(pagesToPdfBlob(layoutPages('你好'), SETUP, PRINTER, { signal: controller.signal })).rejects.toThrow();
  });

  it('导出途中 abort → reject，且不进入下载阶段', async () => {
    const controller = new AbortController();
    const pages = layoutPages(longText, true);
    let aborted = false;
    const promise = pagesToPdfBlob(pages, SETUP, PRINTER, {
      signal: controller.signal,
      onProgress: (done) => {
        if (!aborted && done >= 2) {
          aborted = true;
          controller.abort();
        }
      },
    });
    await expect(promise).rejects.toThrow();
  });

  it('空页面集拒绝导出', async () => {
    await expect(pagesToPdfBlob([], SETUP, PRINTER)).rejects.toThrow(/没有可导出/);
  });

  it('估算体积为正且随页数增长', () => {
    const one = estimatePdfBytes(layoutPages('你好'), SETUP, PRINTER);
    const many = estimatePdfBytes(layoutPages(longText, true), SETUP, PRINTER);
    expect(one).toBeGreaterThan(0);
    expect(many).toBeGreaterThan(one);
  });

  it('内容流含白底与圆点，且圆心坐标与 SVG 毫米坐标一致', () => {
    // 构造一个含满点方的单页：margin top 20 / left 15，首行首方
    const page: import('../src/lib/layout').LayoutPage = {
      number: 1,
      lines: [{ cells: [{ dots: [1, 2, 3, 4, 5, 6], kind: 'prefix' }] }],
    };
    const raw = pageContentStream(page, SETUP, PRINTER);
    const content = new TextDecoder().decode(raw);
    expect(content.startsWith('0 g\n')).toBe(true);

    const mmToPt = (mm: number) => (mm / 25.4) * 72;
    const r = mmToPt(0.75); // 点径 1.5mm
    const hPt = mmToPt(297);
    // 六个点的圆心（pt）：左列 x=15mm，右列 x=17.5mm；三行 y=20/22.5/25mm（自顶向下）
    const expected = [
      [mmToPt(15), hPt - mmToPt(20)], // 1
      [mmToPt(15), hPt - mmToPt(22.5)], // 2
      [mmToPt(15), hPt - mmToPt(25)], // 3
      [mmToPt(17.5), hPt - mmToPt(20)], // 4
      [mmToPt(17.5), hPt - mmToPt(22.5)], // 5
      [mmToPt(17.5), hPt - mmToPt(25)], // 6
    ];
    // 每个 fillCircle 以 “(cx-r) cy m” 起笔，反推圆心
    const starts = [...content.matchAll(/([\d.]+) ([\d.]+) m\n/g)].map((m) => [
      Number(m[1]) + r,
      Number(m[2]),
    ]);
    expect(starts.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      expect(starts[i][0]).toBeCloseTo(expected[i][0], 2);
      expect(starts[i][1]).toBeCloseTo(expected[i][1], 2);
    }
    // 圆点完整落在纸面内
    expect(starts.every(([x, y]) => x - r >= 0 && x + r <= mmToPt(210) && y - r >= 0 && y + r <= hPt)).toBe(true);
  });
});
