/**
 * SVG → PNG（浏览器端，300 DPI）与多页长图合成。仅使用 DOM / 标准 Web API，无第三方依赖。
 *
 * 多页合并不依赖单张超大 canvas（浏览器对单边像素普遍有约 8192px 限制，
 * 一本 A4/300DPI 的书十几页就会触顶）：每页在自己的离屏画布上渲染，
 * 再以流式 zlib 手工拼接同一个 PNG 的 IDAT 数据，长度只受内存限制。
 */

const MM_PER_INCH = 25.4;
const enc = new TextEncoder();

export function mmToPx(mm: number, dpi: number): number {
  return Math.round((mm / MM_PER_INCH) * dpi);
}

/** 把一页 SVG 渲染到离屏画布；失败（解码失败 / 画布创建失败）时抛错 */
async function renderPageCanvas(svg: string, pxW: number, pxH: number): Promise<HTMLCanvasElement> {
  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('SVG 加载失败'));
      el.src = url;
    });
    // SVG 解码后无任何有效像素（如解析出 0×0）即视为本页没画出来
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('SVG 尺寸无效');
    const canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = pxH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, pxW, pxH);
    ctx.drawImage(img, 0, 0, pxW, pxH);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function svgToPngBlob(svg: string, widthMm: number, heightMm: number, dpi = 300): Promise<Blob> {
  const pxW = mmToPx(widthMm, dpi);
  const pxH = mmToPx(heightMm, dpi);
  const canvas = await renderPageCanvas(svg, pxW, pxH);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 导出失败'))), 'image/png');
  });
}

/** 触发浏览器下载（仅在整份文件构造成功后调用） */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadText(text: string, filename: string, mime = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

/* ----------------------------- PNG 字节级工具 ----------------------------- */

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

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(enc.encode(type), 4);
  out.set(data, 8);
  dv.setUint32(data.length + 8, crc32(out.subarray(4, data.length + 8)));
  return out;
}

/** 读取一页画布的像素，返回含每行过滤字节的原始扫描线（RGB，filter type 0） */
function canvasToRawRows(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // 每行起始：过滤器类型 0（None）
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) *4;
      const d = y * (stride + 1) + 1 + x * 3;
      raw[d] = imageData.data[s];
      raw[d + 1] = imageData.data[s + 1];
      raw[d + 2] = imageData.data[s + 2];
    }
  }
  return raw;
}

export interface LongPngOptions {
  /** 每页完成后的回调（0 → total） */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * 多页 SVG → 单个竖向拼接的长 PNG。
 * 逐页渲染、逐页压缩，任何一页渲染失败或被取消都会整体抛错，
 * 不会返回半截数据；调用方只有在本函数成功返回后才应创建/下载文件。
 */
export async function pagesToLongPng(
  pages: string[],
  widthMm: number,
  heightMm: number,
  dpi = 300,
  opts: LongPngOptions = {},
): Promise<Blob> {
  if (pages.length === 0) throw new Error('没有可导出的页面');
  const pxW = mmToPx(widthMm, dpi);
  const pxH = mmToPx(heightMm, dpi);
  if (pxW <= 0 || pxH <= 0) throw new Error('页面尺寸无效');

  async function* rawPageRows(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < pages.length; i++) {
      if (opts.signal?.aborted) throw new DOMException('导出已停止', 'AbortError');
      // 任一页渲染失败 → 整体作废（错误向上抛给 encodeLongPng，绝不产出半截文件）
      // eslint-disable-next-line no-await-in-loop
      const canvas = await renderPageCanvas(pages[i], pxW, pxH);
      if (opts.signal?.aborted) throw new DOMException('导出已停止', 'AbortError');
      yield canvasToRawRows(canvas);
      opts.onProgress?.(i + 1, pages.length);
    }
  }

  return encodeLongPng(pxW, pxH, pages.length, rawPageRows(), dpi, opts.signal);
}

/**
 * 字节级长 PNG 组装：消费每页的 RGBA 原始扫描线（含行首过滤字节），
 * 所有页写入同一段连续 zlib 流。纯函数（无 DOM 依赖），便于测试。
 */
export async function encodeLongPng(
  pxW: number,
  pxH: number,
  pageCount: number,
  pageRows: AsyncIterable<Uint8Array>,
  dpi = 300,
  signal?: AbortSignal,
): Promise<Blob> {
  const totalH = pxH * pageCount;
  if (totalH > 0x7fffffff) throw new Error('长图总高度超过 PNG 限制');

  // IDAT 必须是同一段连续 zlib 流的分块：逐页渲染 → 原始扫描线写入压缩器，
  // 另起一个读循环持续排空压缩输出，避免写入端背压阻塞。
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  void writer.ready.catch(() => {});
  const reader = cs.readable.getReader();

  const idatParts: Uint8Array[] = [];
  // 读取循环自身兜底异常，确保压缩流异常不会产生 unhandled rejection；
  // 真正的成败由写入路径的 await 与最后的 pump 决定。
  let pumpError: unknown = null;
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) idatParts.push(value);
      }
    } catch (e) {
      pumpError = e;
    }
  })();

  const onAbort = () => {
    void writer.abort(signal?.reason ?? new DOMException('导出已停止', 'AbortError')).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  let received = 0;
  if (signal?.aborted) throw new DOMException('导出已停止', 'AbortError');
  try {
    for await (const rows of pageRows) {
      if (pumpError) throw pumpError;
      if (signal?.aborted) throw new DOMException('导出已停止', 'AbortError');
      await writer.write(rows);
      received++;
    }
    if (received !== pageCount) throw new Error(`应导出 ${pageCount} 页，实际仅生成 ${received} 页`);
    await writer.close();
  } catch (e) {
    void writer.abort(e instanceof Error ? e : undefined).catch(() => {});
    void reader.cancel().catch(() => {});
    void pump.catch(() => {});
    throw e instanceof Error ? e : new Error('PNG 导出失败');
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  await pump;
  if (pumpError) throw pumpError instanceof Error ? pumpError : new Error('PNG 压缩失败');

  // pHYs：像素密度（像素/米），保证打印软件按 300 DPI 还原真实尺寸
  const ppm = Math.round((dpi / MM_PER_INCH) * 1000);
  const phys = new Uint8Array(9);
  new DataView(phys.buffer).setUint32(0, ppm);
  new DataView(phys.buffer).setUint32(4, ppm);
  phys[8] = 1; // 单位：米

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, pxW);
  dv.setUint32(4, totalH);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 真彩色 RGB（盲文页无需透明通道，原始数据比 RGBA 少 25%）
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  let idatLen = 0;
  for (const p of idatParts) idatLen += p.length;
  const idat = new Uint8Array(idatLen);
  let off = 0;
  for (const p of idatParts) {
    idat.set(p, off);
    off += p.length;
  }

  return new Blob(
    [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('pHYs', phys),
      chunk('IDAT', idat),
      chunk('IEND', new Uint8Array(0)),
    ],
    { type: 'image/png' },
  );
}

/**
 * 长 PNG 文件大小预估（字节）。
 * 按「每扫描线 1 过滤字节 + RGBA 四通道」的原始量，结合典型盲文页的压缩率估计，
 * 仅用于导出前告知，实际大小以编码完成为准。
 */
export function estimateLongPngBytes(pageCount: number, widthMm: number, heightMm: number, dpi = 300): number {
  const pxW = mmToPx(widthMm, dpi);
  const pxH = mmToPx(heightMm, dpi);
  const raw = (pxW * 3 + 1) * pxH * pageCount;
  // 盲文页几乎全白 + 过滤字节 0：zlib 对这种数据压缩率约 5%，再叠加 zlib/PNG 固定开销
  return Math.round(raw * 0.05) + 2048;
}
