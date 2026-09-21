/**
 * 灰度 PNG（8-bit，color type 0）流式编码器。
 * 不使用 canvas.toBlob：浏览器对单个 canvas 有面积上限（约 16384×16384 /
 * 总面积限制），上百页拼一张长图必然超限。这里逐页过滤、写入同一条 zlib 流，
 * 压缩输出按到达顺序切成多个 IDAT chunk，内存里只保留压缩后的小块，
 * 因此高度没有 canvas 级限制。
 * 任何一页缺失或 signal 中止都会抛出，绝不返回半截文件。
 */
import { createZlibStream } from './deflate';

export interface PngEncodeOptions {
  width: number;
  height: number;
  /** 逐页提供原始像素（0=黑，255=白）；每次返回一页（或任意整数行）的灰度数据 */
  pages: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  onProgress?: (pagesDone: number) => void;
  signal?: AbortSignal;
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

/** 拼装一个 PNG chunk（长度 + 类型 + 数据 + CRC） */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)));
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(out.buffer, 4, 4 + data.length);
  dv.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

export async function encodeGrayscalePng(opts: PngEncodeOptions): Promise<Blob> {
  const { width, height } = opts;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('PNG 尺寸无效');
  }
  if (height > 0x7fffffff) throw new Error('图片过高，超出 PNG 格式上限');
  opts.signal?.throwIfAborted();

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 先缓存文件头与所有数据 chunk，全部成功后才 new Blob（失败时不留任何文件）
  const chunks: Uint8Array[] = [PNG_SIGNATURE, pngChunk('IHDR', ihdr)];

  // 所有 IDAT 共同承载一条 zlib 流：压缩块按固定到达顺序各自成为一个 IDAT
  const zs = createZlibStream(opts.signal);

  let rowsConsumed = 0;
  let pagesDone = 0;
  for await (const gray of opts.pages) {
    opts.signal?.throwIfAborted();
    // 每行行首一个 None 滤镜字节（0），内容必须是整行
    if (gray.length === 0 || gray.length % width !== 0) {
      throw new Error(`第 ${pagesDone + 1} 页像素不完整（${gray.length} 字节），导出作废`);
    }
    const rows = gray.length / width;
    if (rowsConsumed + rows > height) throw new Error('像素行数超过声明高度，导出作废');
    const filtered = new Uint8Array(gray.length + rows);
    for (let r = 0; r < rows; r++) {
      const srcOff = r * width;
      const dstOff = r * (width + 1);
      // 滤镜字节已为 0（None）
      filtered.set(gray.subarray(srcOff, srcOff + width), dstOff + 1);
    }
    rowsConsumed += rows;
    await zs.write(filtered);
    pagesDone++;
    opts.onProgress?.(pagesDone);
  }

  if (rowsConsumed !== height) {
    throw new Error(`像素行数不足（${rowsConsumed}/${height}），导出作废`);
  }

  const compressedChunks = await zs.close();
  for (const c of compressedChunks) chunks.push(pngChunk('IDAT', c));
  chunks.push(pngChunk('IEND', new Uint8Array(0)));
  return new Blob(chunks, { type: 'image/png' });
}

/** 估算未压缩的原始像素字节数（每页含行首滤镜字节） */
export function rawFilteredBytes(width: number, height: number): number {
  return (width + 1) * height;
}
