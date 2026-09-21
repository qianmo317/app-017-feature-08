/**
 * zlib（RFC 1950）压缩工具。
 * 基于浏览器内置 CompressionStream('deflate')（该格式即 zlib 包装的 raw deflate，
 * 正是 PNG/zlib 流所需），无第三方依赖。PDF FlateDecode 与 PNG IDAT 共用。
 */

export interface CompressOptions {
  signal?: AbortSignal;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function bytesFromBlob(blob: Blob): Promise<Uint8Array> {
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/** 压缩整段数据；signal 中止时 reject（AbortError），不会产生半截结果 */
export async function zlibDeflate(data: Uint8Array, opts: CompressOptions = {}): Promise<Uint8Array> {
  const zs = createZlibStream(opts.signal);
  await zs.write(data);
  return concatBytes(await zs.close());
}

export interface ZlibStream {
  /** 追加一段数据（多次写入属于同一个 zlib 流，PNG 多 IDAT 需要） */
  write(data: Uint8Array): Promise<void>;
  /** 结束流并返回压缩后的全部块（顺序确定） */
  close(): Promise<Uint8Array[]>;
}

/**
 * 创建单个 zlib 流，可分段写入。
 * 用途：PNG 的多个 IDAT chunk 必须共同承载一条 zlib 流，不能每页各自加头/尾。
 */
export function createZlibStream(signal?: AbortSignal): ZlibStream {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const chunks: Uint8Array[] = [];
  let pumpError: unknown = null;

  const pump = (async () => {
    const reader = cs.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(new Uint8Array(value));
      }
    } catch (e) {
      pumpError = e;
    }
  })();

  const abort = () => {
    writer.abort(new DOMException('压缩已取消', 'AbortError')).catch(() => {});
  };
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  return {
    async write(data: Uint8Array) {
      try {
        await writer.write(data);
      } catch (e) {
        throw signal?.aborted ? new DOMException('压缩已取消', 'AbortError') : (e as Error);
      }
    },
    async close() {
      try {
        await writer.close();
      } catch (e) {
        throw signal?.aborted ? new DOMException('压缩已取消', 'AbortError') : (e as Error);
      } finally {
        signal?.removeEventListener('abort', abort);
      }
      await pump;
      if (pumpError) throw pumpError;
      return chunks;
    },
  };
}
