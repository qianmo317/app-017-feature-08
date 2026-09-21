import { useEffect, useMemo, useRef, useState } from 'react';
import type { Doc } from '../types';
import { convertText } from '../lib/convert';
import { layoutDocument } from '../lib/layout';
import { pagesToBRF, validateBRF } from '../lib/brf';
import { pageToSVG, calibrationSVG, pagesToLongSVGString, longSVGByteLength } from '../lib/svg';
import { downloadBlob, downloadText, safeBaseName } from '../lib/png';
import { pagesToPdfBlob, estimatePdfBytes } from '../lib/pdf';
import { pagesToLongPngBlob, estimateLongPngBytes } from '../lib/long-png';
import { getDoc } from '../lib/storage';
import { useSettings } from '../App';
import { navigate } from '../router';

type ExportKind = 'pdf' | 'png' | 'svg';
type Phase = 'estimating' | 'confirm' | 'working' | 'done' | 'error' | 'aborted';

interface ExportState {
  kind: ExportKind;
  phase: Phase;
  /** 预估/实际文件字节数 */
  bytes: number | null;
  donePages: number;
  totalPages: number;
  message: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function PrintPage({ id }: { id: string }) {
  const { settings } = useSettings();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [withCalibration, setWithCalibration] = useState(false);
  const [msg, setMsg] = useState('');
  const [exp, setExp] = useState<ExportState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    getDoc(id).then((d) => {
      if (alive) setDoc(d ?? null);
    });
    return () => {
      alive = false;
      // 离开页面时中止导出，不会留下后台任务
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
  const totalPages = pages.layout.pages.length;
  const baseName = safeBaseName(doc.title);
  const busy = exp?.phase === 'estimating' || exp?.phase === 'working';

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

  /** 第 1 步：先算清楚「几页、多大」，再请用户确认 */
  const prepareExport = async (kind: ExportKind) => {
    if (busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setMsg('');
    setExp({ kind, phase: 'estimating', bytes: null, donePages: 0, totalPages, message: '正在估算文件大小…' });
    try {
      if (kind === 'pdf') {
        const bytes = estimatePdfBytes(pages.layout.pages, setup, settings.printer);
        setExp({ kind, phase: 'confirm', bytes, donePages: 0, totalPages, message: '' });
      } else if (kind === 'svg') {
        const bytes = longSVGByteLength(pages.layout.pages, setup, settings.printer);
        setExp({ kind, phase: 'confirm', bytes, donePages: 0, totalPages, message: '' });
      } else {
        const { bytes } = await estimateLongPngBytes({
          svgs,
          paperWidthMm: settings.printer.paperWidthMm,
          paperHeightMm: settings.printer.paperHeightMm,
          signal: controller.signal,
        });
        setExp({ kind, phase: 'confirm', bytes, donePages: 0, totalPages, message: '' });
      }
    } catch (e) {
      if (controller.signal.aborted) {
        setExp({ kind, phase: 'aborted', bytes: null, donePages: 0, totalPages, message: '已取消。' });
      } else {
        setExp({ kind, phase: 'error', bytes: null, donePages: 0, totalPages, message: (e as Error).message });
      }
    }
  };

  /** 第 2 步：确认后正式导出；所有页都成功才会触发唯一一次下载 */
  const confirmExport = async () => {
    if (!exp || exp.phase !== 'confirm') return;
    const controller = new AbortController();
    abortRef.current = controller;
    const kind = exp.kind;
    setExp({ ...exp, phase: 'working', donePages: 0, message: '正在生成…' });
    try {
      let blob: Blob;
      const onProgress = (done: number, total: number) =>
        setExp((cur) =>
          cur && cur.phase === 'working'
            ? { ...cur, donePages: done, totalPages: total, message: `正在生成第 ${done}/${total} 页…` }
            : cur,
        );
      if (kind === 'pdf') {
        blob = await pagesToPdfBlob(pages.layout.pages, setup, settings.printer, {
          onProgress,
          signal: controller.signal,
        });
      } else if (kind === 'svg') {
        const svg = await pagesToLongSVGString(pages.layout.pages, setup, settings.printer, {
          onProgress,
          signal: controller.signal,
        });
        blob = new Blob([svg], { type: 'image/svg+xml' });
      } else {
        blob = await pagesToLongPngBlob({
          svgs,
          paperWidthMm: settings.printer.paperWidthMm,
          paperHeightMm: settings.printer.paperHeightMm,
          onProgress,
          signal: controller.signal,
        });
      }
      // 全部页面通过、文件完整后才落盘，失败/取消时不会走到这里
      const filename =
        kind === 'pdf' ? `${baseName}.pdf` : kind === 'svg' ? `${baseName}-长图.svg` : `${baseName}-长图.png`;
      downloadBlob(blob, filename);
      setExp({
        kind,
        phase: 'done',
        bytes: blob.size,
        donePages: totalPages,
        totalPages,
        message: `已导出 ${filename}，共 ${totalPages} 页，文件 ${formatBytes(blob.size)}。`,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        setExp({
          kind,
          phase: 'aborted',
          bytes: null,
          donePages: 0,
          totalPages,
          message: '已停止导出，未保存任何文件（已完成的部分已作废）。',
        });
      } else {
        setExp({
          kind,
          phase: 'error',
          bytes: null,
          donePages: 0,
          totalPages,
          message: `导出失败：${(e as Error).message}。整份作废，未保存任何文件。`,
        });
      }
    } finally {
      abortRef.current = null;
    }
  };

  const cancelExport = () => abortRef.current?.abort();
  const dismissExport = () => {
    if (busy) return;
    setExp(null);
  };

  const exportLocked = uncertainCount > 0;

  return (
    <div>
      <div className="print-toolbar no-print">
        <button type="button" onClick={() => navigate(`/editor/${id}`)}>← 返回编辑器</button>
        <button type="button" className="primary" onClick={() => window.print()}>
          打印（请选择「实际大小 / 100%」）
        </button>
        <button type="button" disabled={exportLocked} title={exportLocked ? '存在未确认读音' : ''} onClick={exportBRF}>
          下载 BRF
        </button>
        <button type="button" disabled={exportLocked || busy} title={exportLocked ? '存在未确认读音' : ''} onClick={() => prepareExport('pdf')}>
          导出多页 PDF
        </button>
        <button type="button" disabled={exportLocked || busy} title={exportLocked ? '存在未确认读音' : ''} onClick={() => prepareExport('png')}>
          导出长图 PNG（300 DPI）
        </button>
        <button type="button" disabled={exportLocked || busy} title={exportLocked ? '存在未确认读音' : ''} onClick={() => prepareExport('svg')}>
          导出长图 SVG
        </button>
        <label>
          <input type="checkbox" checked={withCalibration} onChange={(e) => setWithCalibration(e.target.checked)} />{' '}
          附打印校准页
        </label>
        <span className="stats" role="status" aria-live="polite">
          {msg || (exportLocked ? `${uncertainCount} 项读音未确认，导出已锁定` : '')}
        </span>
      </div>

      {exp && (
        <div className="export-panel no-print" role="dialog" aria-label="点阵图导出" aria-busy={busy}>
          {exp.phase === 'estimating' && <p>正在估算文件大小，请稍候…</p>}

          {exp.phase === 'confirm' && (
            <>
              <p>
                将导出 <strong>{totalPages}</strong> 页
                {exp.kind === 'pdf'
                  ? ' 为一个多页 PDF，可在阅读器中连续翻页'
                  : ' 并竖向拼接为一张连续长图' + (exp.kind === 'png' ? ' PNG（300 DPI）' : ' SVG（矢量，可无损缩放打印）')}
                ，{exp.kind === 'pdf' || exp.kind === 'png' ? '预计' : ''}文件大小{exp.kind === 'pdf' || exp.kind === 'png' ? '约' : ''} <strong>{exp.bytes !== null ? formatBytes(exp.bytes) : '—'}</strong>
                {exp.kind === 'pdf' || exp.kind === 'png' ? '（按首页压缩率估算，实际可能略有出入）' : '（文本格式，大小确定）'}。
              </p>
              <div className="row">
                <button type="button" className="primary" onClick={confirmExport}>开始导出</button>
                <button type="button" onClick={dismissExport}>取消</button>
              </div>
            </>
          )}

          {(exp.phase === 'working') && (
            <>
              <div className="export-progress" role="progressbar" aria-valuemin={0} aria-valuemax={exp.totalPages} aria-valuenow={exp.donePages}>
                <div className="export-progress-bar" style={{ width: `${(exp.donePages / Math.max(1, exp.totalPages)) * 100}%` }} />
              </div>
              <p>
                {exp.message}（{Math.round((exp.donePages / Math.max(1, exp.totalPages)) * 100)}%）
              </p>
              <button type="button" className="danger" onClick={cancelExport}>停止导出</button>
            </>
          )}

          {exp.phase === 'done' && (
            <>
              <p className="export-ok">{exp.message}</p>
              <button type="button" onClick={dismissExport}>关闭</button>
            </>
          )}

          {(exp.phase === 'error' || exp.phase === 'aborted') && (
            <>
              <p className={exp.phase === 'error' ? 'export-err' : 'export-muted'}>{exp.message}</p>
              <button type="button" onClick={dismissExport}>关闭</button>
            </>
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
