/**
 * 多页点阵 → 单张长 PNG（浏览器端，无第三方依赖）。
 * 所有页按页序竖向拼接成一张连续长图，只下载一个文件。
 * - 300 DPI 逐页栅格化（每页独立 canvas，绕开浏览器单 canvas 面积上限）；
 * - 像素交给流式灰度 PNG 编码器（lib/png-encode.ts），不经过 toBlob；
 * - 任一页栅格化失败 / 像素不完整 / signal 中止都会整体 reject，不留半截文件；
 * - 重复导出：页序、尺寸、像素与压缩全部确定，产物字节一致。
 */
import { encodeGrayscalePng } from './png-encode';
import { loadSvgImage, mmToPx } from './png';
import { zlibDeflate } from './deflate';

const MM_PER_INCH = 25.4;
const DEFAULT_DPI = 300;

export interface LongPngOptions {
  /** 每页一份 SVG（顺序即页序） */
  svgs: string[];
  paperWidthMm: number;
  paperHeightMm: number;
  dpi?: number;
  onProgress?: (pagesDone: number, totalPages: number) => void;
  signal?: AbortSignal;
}

export interface LongPngInfo {
  widthPx: number;
  heightPx: number;
}

export function longPngDimensions(o: Pick<LongPngOptions, 'svgs' | 'paperWidthMm' | 'paperHeightMm' | 'dpi'>): LongPngInfo {
  const dpi = o.dpi ?? DEFAULT_DPI;
  return {
    widthPx: mmToPx(o.paperWidthMm, dpi),
    heightPx: mmToPx(o.paperHeightMm, dpi) * o.svgs.length,
  };
}

/** 单页 SVG → 灰度像素（0=黑，255=白，白底） */
async function rasterPageToGray(svg: string, pxW: number, pxH: number, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const img = await loadSvgImage(svg, signal);
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('点阵图绘制失败（图像尺寸为 0）');
  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = pxH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建画布');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, pxW, pxH);
  ctx.drawImage(img, 0, 0, pxW, pxH);
  signal?.throwIfAborted();
  const rgba = ctx.getImageData(0, 0, pxW, pxH).data;
  // 白底黑点：用亮度公式转灰度；对纯黑/纯白是精确的 0/255
  const gray = new Uint8Array(pxW * pxH);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    gray[j] = Math.round((rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000);
  }
  return gray;
}

export async function pagesToLongPngBlob(o: LongPngOptions): Promise<Blob> {
  const n = o.svgs.length;
  if (n === 0) throw new Error('没有可导出的页面');
  const dims = longPngDimensions(o);
  if (dims.heightPx > 0x7fffffff) throw new Error('页数过多，长图高度超出 PNG 格式上限');
  o.signal?.throwIfAborted();

  let produced = 0;
  async function* genPages(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < n; i++) {
      o.signal?.throwIfAborted();
      const pageH = Math.round((o.paperHeightMm / MM_PER_INCH) * (o.dpi ?? DEFAULT_DPI));
      // 任何一页画不出来都会从这里抛出 → 整体作废，不会得到半截文件
      const gray = await rasterPageToGray(o.svgs[i], dims.widthPx, pageH, o.signal);
      produced = i + 1;
      o.onProgress?.(produced, n);
      yield gray;
    }
  }

  return encodeGrayscalePng({
    width: dims.widthPx,
    height: dims.heightPx,
    pages: genPages(),
    signal: o.signal,
  });
}

/**
 * 体积预估：真实栅格化并压缩第 1 页，按页线性外推（+10% 余量）。
 * 同时也是一次「第 1 页能不能画出来」的提前校验：
 * 首页都渲染不了，直接报错，不进入正式导出。
 */
export async function estimateLongPngBytes(o: LongPngOptions): Promise<{ bytes: number; dims: LongPngInfo }> {
  const n = o.svgs.length;
  if (n === 0) throw new Error('没有可导出的页面');
  const dims = longPngDimensions(o);
  const pageH = Math.round(dims.heightPx / n);
  const firstGray = await rasterPageToGray(o.svgs[0], dims.widthPx, pageH, o.signal);
  const filterByte = 1;
  const filtered = new Uint8Array(firstGray.length + pageH * filterByte);
  for (let r = 0; r < pageH; r++) {
    filtered.set(firstGray.subarray(r * dims.widthPx, (r + 1) * dims.widthPx), r * (dims.widthPx + 1) + 1);
  }
  const firstCompressed = await zlibDeflate(filtered, { signal: o.signal });
  const bytes = Math.ceil(firstCompressed.length * n * 1.1) + (n + 2) * 12 + 33;
  return { bytes, dims };
}
