import { useEffect, useMemo, useRef, useState } from 'react';
import type { Doc } from '../types';
import { convertText } from '../lib/convert';
import { layoutDocument } from '../lib/layout';
import { pagesToBRF, validateBRF } from '../lib/brf';
import { pageToSVG, calibrationSVG } from '../lib/svg';
import { pagesToPdfBlob, estimatePdfBytes } from '../lib/pdf';
import { pagesToLongPng, estimateLongPngBytes, downloadBlob, downloadText } from '../lib/png';
import { getDoc } from '../lib/storage';
import { useSettings } from '../App';
import { navigate } from '../router';

type ExportKind = 'pdf' | 'png';
type Phase = 'idle' | 'confirm' | 'running' | 'done' | 'error' | 'cancelled';

interface ExportState {
  kind: ExportKind;
  phase: Phase;
  done: number;
  total: number;
  /** 预估大小（字节，确认阶段展示） */
  estimated: number;
  /** 实际大小（字节，完成后展示） */
  actual: number;
  message: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 文件名安全化：去掉路径分隔符与控制字符，空标题回退 document */
export function safeFileName(title: string): string {
  const t = title.trim().replace(/[-\\/:*?"<>|\x00-\x1f]/g, '').slice(0, 80);
  return t || 'document';
}

export default function PrintPage({ id }: { id: string }) {
  const { settings } = useSettings();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [withCalibration, setWithCalibration] = useState(false);
  const [msg, setMsg] = useState('');
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    getDoc(id).then((d) => {
      if (alive) setDoc(d ?? null);
    });
    return () => {
      alive = false;
      abortRef.current?.abort();
    };
  }, [id]);

  const pages = useMemo(() => {
    if (!doc) return null;
    // 与编辑器一致：使用文档的读音覆盖/确认记录与页面设置，避免打印页重新出现未确认项
    const conv = convertText(doc.raw, {
      toneMode: settings.toneMode,
      autoDetectPinyin: settings.autoDetectPinyin,
      profile: doc.ruleProfile,
      overrides: doc.overrides,
      confirmed: doc.confirmed,
      dictEntries: settings.dictEntries,
    });
    return {
      conv,
      layout: layoutDocument(conv.paragraphs, doc.setup, settings.showPageNumbers),
    };
  }, [doc, settings.toneMode, settings.autoDetectPinyin, settings.showPageNumbers, settings.dictEntries]);

  const svgs = useMemo(
    () => (pages && doc ? pages.layout.pages.map((p) => pageToSVG(p, doc.setup, settings.printer)) : []),
    [pages, doc, settings.printer],
  );

  if (!doc) {
    return (
      <p>
        文档不存在。<button type="button" onClick={() => navigate('/')}>返回首页</button>
      </p>
    );
  }
  if (!pages) return <p>加载中…</p>;

  const uncertainCount = pages.conv.uncertain.length;
  const setup = doc.setup;
  const pageCount = pages.layout.pages.length;
  const baseName = safeFileName(doc.title);

  const exportBRF = () => {
    const brf = pagesToBRF(pages.layout.pages);
    const v = validateBRF(brf, setup.cellsPerLine, setup.linesPerPage);
    if (!v.ok) {
      setMsg(`BRF 校验未通过：${v.issues[0]}`);
      return;
    }
    downloadText(brf, `${baseName}.brf`, 'application/octet-stream');
    setMsg('BRF 已导出并通过结构校验。');
  };

  /** 第一步：弹出导出前说明（格式、总页数、预估文件大小） */
  const askExport = (kind: ExportKind) => {
    abortRef.current?.abort();
    const estimated =
      kind === 'pdf'
        ? estimatePdfBytes(pages.layout.pages)
        : estimateLongPngBytes(pageCount, settings.printer.paperWidthMm, settings.printer.paperHeightMm);
    setExportState({ kind, phase: 'confirm', done: 0, total: pageCount, estimated, actual: 0, message: '' });
  };

  const cancelConfirm = () => setExportState(null);

  /** 第二步：实际生成（有进度、可停止；任何一页失败整体作废，不落文件） */
  const startExport = async () => {
    if (!exportState) return;
    const kind = exportState.kind;
    const controller = new AbortController();
    abortRef.current = controller;
    setExportState((s) => (s ? { ...s, phase: 'running', done: 0, message: '' } : s));

    const onProgress = (done: number, total: number) =>
      setExportState((s) => (s ? { ...s, done, total } : s));

    try {
      let blob: Blob;
      if (kind === 'pdf') {
        blob = await pagesToPdfBlob(pages.layout.pages, setup, settings.printer, {
          onProgress,
          signal: controller.signal,
        });
      } else {
        blob = await pagesToLongPng(
          svgs,
          settings.printer.paperWidthMm,
          settings.printer.paperHeightMm,
          300,
          { onProgress, signal: controller.signal },
        );
      }
      // 只有全部页成功、整份文件构造完毕后才触发这唯一一次下载
      downloadBlob(blob, `${baseName}.${kind}`);
      setExportState((s) =>
        s ? { ...s, phase: 'done', done: s.total, actual: blob.size, message: '已开始下载' } : s,
      );
    } catch (e) {
      const cancelled = controller.signal.aborted || (e as DOMException)?.name === 'AbortError';
      setExportState((s) =>
        s
          ? {
              ...s,
              phase: cancelled ? 'cancelled' : 'error',
              message: cancelled ? '已停止，未生成任何文件。' : `导出失败，文件已作废：${(e as Error).message}`,
            }
          : s,
      );
    } finally {
      abortRef.current = null;
    }
  };

  /** 中途停止：标记取消后生成器在下一页边界退出，不触发下载 */
  const stopExport = () => abortRef.current?.abort();

  const running = exportState?.phase === 'running';
  const kindLabel = exportState?.kind === 'pdf' ? 'PDF 多页文档' : 'PNG 长图（300 DPI）';

  return (
    <div>
      <div className="print-toolbar no-print">
        <button type="button" onClick={() => navigate(`/editor/${id}`)}>← 返回编辑器</button>
        <button type="button" className="primary" onClick={() => window.print()}>
          打印（请选择「实际大小 / 100%」）
        </button>
        <button type="button" disabled={uncertainCount > 0} title={uncertainCount > 0 ? '存在未确认读音' : ''} onClick={exportBRF}>
          下载 BRF
        </button>
        <button type="button" disabled={uncertainCount > 0 || running} onClick={() => askExport('pdf')}>
          导出 PDF（全部页 · 一个文件）
        </button>
        <button type="button" disabled={uncertainCount > 0 || running} onClick={() => askExport('png')}>
          导出 PNG 长图（全部页 · 一个文件）
        </button>
        <label>
          <input type="checkbox" checked={withCalibration} onChange={(e) => setWithCalibration(e.target.checked)} />{' '}
          附打印校准页
        </label>
        <span className="stats" role="status" aria-live="polite">
          {msg || (uncertainCount > 0 ? `${uncertainCount} 项读音未确认，导出已锁定` : '')}
        </span>
      </div>

      {exportState && (
        <div className="export-panel no-print" role="dialog" aria-label="导出点阵图">
          {exportState.phase === 'confirm' && (
            <>
              <p>
                将导出 <strong>{exportState.total}</strong> 页为{kindLabel}，共 1 个文件，
                预估大小约 <strong>{formatBytes(exportState.estimated)}</strong>
                （压缩后实际大小可能略有出入）。页序与屏幕预览一致。
              </p>
              <div className="export-actions">
                <button type="button" className="primary" onClick={startExport}>开始导出</button>
                <button type="button" onClick={cancelConfirm}>取消</button>
              </div>
            </>
          )}
          {running && (
            <>
              <p>
                正在导出{kindLabel}：第 {exportState.done} / {exportState.total} 页
              </p>
              <progress value={exportState.done} max={exportState.total} aria-label="导出进度" />
              <div className="export-actions">
                <button type="button" onClick={stopExport}>停止</button>
              </div>
            </>
          )}
          {exportState.phase === 'done' && (
            <div className="export-result">
              <p>
                导出完成：{exportState.total} 页，实际大小 {formatBytes(exportState.actual)}，浏览器应已开始下载
                {kindLabel}。
              </p>
              <div className="export-actions">
                <button type="button" onClick={() => setExportState(null)}>关闭</button>
              </div>
            </div>
          )}
          {(exportState.phase === 'error' || exportState.phase === 'cancelled') && (
            <div className="export-result">
              <p role="alert">{exportState.message}</p>
              <div className="export-actions">
                <button type="button" onClick={() => askExport(exportState.kind)}>重试</button>
                <button type="button" onClick={() => setExportState(null)}>关闭</button>
              </div>
            </div>
          )}
        </div>
      )}

      <p className="calibration-note no-print">
        打印提示：请务必在打印对话框选择「实际大小 / 100%」，任何缩放都会改变点距导致无法触摸阅读。
        打印后可用校准页量测：横向 10 方 ≈ {(9 * settings.printer.cellPitchMm + settings.printer.dotPitchMm).toFixed(1)}mm。
      </p>

      {withCalibration && (
        <div
          className="print-page-wrap"
          // 校准页 SVG
          dangerouslySetInnerHTML={{ __html: calibrationSVG(settings.printer, setup) }}
        />
      )}
      {svgs.map((svg, i) => (
        <div className="print-page-wrap" key={i} dangerouslySetInnerHTML={{ __html: svg }} aria-label={`第 ${i + 1} 页点阵图`} />
      ))}
    </div>
  );
}
