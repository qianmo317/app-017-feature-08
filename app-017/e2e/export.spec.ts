/**
 * 点阵图合并导出 e2e：
 * - 只下载一个文件（不再一页一个文件、不触发浏览器多下载拦截）；
 * - 导出前先展示「共 N 页、预计大小」，确认后才开始；
 * - 进度条随页推进，中途可「停止导出」，取消后没有任何下载；
 * - PDF 为多页文档；长 PNG 为竖向拼接的一张图；
 * - 同一文档重复导出字节完全一致（页序与内容确定）。
 */
import fs from 'node:fs';
import { expect, test } from '@playwright/test';

const NEW_DOC = '＋ 新建盲文文档';

async function createConfirmedDoc(page: import('@playwright/test').Page, text: string) {
  await page.goto('/');
  await page.getByRole('button', { name: NEW_DOC }).click();
  await page.getByLabel('原文输入区').fill(text);
  await expect(page.getByLabel('盲文分页预览')).toBeVisible();
  await page.getByRole('button', { name: '全部按默认读音确认' }).click();
  await expect(page.getByRole('button', { name: '打印与导出 →' })).toBeEnabled();
  await page.getByRole('button', { name: '打印与导出 →' }).click();
  await expect(page).toHaveURL(/\/print$/);
  await expect(page.locator('.print-page-wrap svg').first()).toBeVisible();
}

function readDownload(download: import('@playwright/test').Download): Promise<Buffer> {
  return download.path().then((p) => fs.promises.readFile(p!));
}

test.describe('合并导出：一个文件', () => {
  test('PDF：确认页显示页数与大小 → 单个多页 PDF 下载', async ({ page }) => {
    await createConfirmedDoc(page, '盲文排版是把文字转成凸点符号的过程，特殊教育学校需要大量点字教材。'.repeat(400));

    await page.getByRole('button', { name: '导出多页 PDF' }).click();
    const panel = page.getByRole('dialog', { name: '点阵图导出' });
    await expect(panel).toBeVisible();

    // 导出前讲清楚：共几页、预计文件大小
    await expect(panel.getByText(/将导出 \d+ 页 为一个多页 PDF/)).toBeVisible();
    await expect(panel.getByText(/预计文件大小约/)).toBeVisible();
    const summary = await panel.textContent();
    const nPages = Number(/将导出 (\d+) 页/.exec(summary!)![1]);
    expect(nPages).toBeGreaterThan(1);

    // 没有中途下载：开始导出前监听下载事件
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '开始导出' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    const buf = await readDownload(download);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    // 页数与确认页一致
    const pageCount = (buf.toString('latin1').match(/\/Type \/Page /g) ?? []).length;
    expect(pageCount).toBe(nPages);
    await expect(panel.getByText(new RegExp(`已导出.*共 ${nPages} 页`))).toBeVisible();
  });

  test('长 PNG：单个竖向长图，宽=A4@300DPI，高=页数×页高', async ({ page }) => {
    await createConfirmedDoc(page, '盲文排版是把文字转成凸点符号的过程，特殊教育学校需要大量点字教材。'.repeat(200));

    await page.getByRole('button', { name: '导出长图 PNG（300 DPI）' }).click();
    const panel = page.getByRole('dialog', { name: '点阵图导出' });
    await expect(panel.getByText(/将导出 \d+ 页 并竖向拼接为一张连续长图/)).toBeVisible();
    const summary = await panel.textContent();
    const nPages = Number(/将导出 (\d+) 页/.exec(summary!)![1]);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '开始导出' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.png$/);
    const buf = await readDownload(download);

    // PNG 签名
    expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR：2480 宽（A4 210mm@300DPI），3508 高/页（297mm@300DPI）
    expect(buf.readUInt32BE(16)).toBe(2480);
    expect(buf.readUInt32BE(20)).toBe(3508 * nPages);
  });

  test('导出有进度且可中途停止；停止后不产生任何下载', async ({ page }) => {
    await createConfirmedDoc(page, '盲文排版是把文字转成凸点符号的过程，特殊教育学校需要大量点字教材。'.repeat(400));

    let downloaded = false;
    page.on('download', () => {
      downloaded = true;
    });

    await page.getByRole('button', { name: '导出多页 PDF' }).click();
    const panel = page.getByRole('dialog', { name: '点阵图导出' });
    await expect(panel.getByRole('button', { name: '开始导出' })).toBeVisible();
    await page.getByRole('button', { name: '开始导出' }).click();

    // 进度随页推进：aria-valuenow 从 0 增长到 >0
    const progress = panel.locator('[role="progressbar"]');
    await expect(progress).toBeAttached({ timeout: 15_000 });
    await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow')), { timeout: 15_000 }).toBeGreaterThan(0);

    await page.getByRole('button', { name: '停止导出' }).click();
    await expect(panel.getByText(/已停止导出，未保存任何文件/)).toBeVisible({ timeout: 10_000 });
    // 给点时间确认没有迟到的下载
    await page.waitForTimeout(1500);
    expect(downloaded).toBe(false);
  });

  test('重复导出同一文档：PDF 字节完全一致', async ({ page }) => {
    await createConfirmedDoc(page, '你好世界。\n第二段文字，包含数字123和英文Hello。');

    async function exportOnce() {
      await page.getByRole('button', { name: '导出多页 PDF' }).click();
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: '开始导出' }).click(),
      ]);
      const buf = await readDownload(download);
      await page.getByRole('button', { name: '关闭' }).click();
      return buf;
    }
    const a = await exportOnce();
    const b = await exportOnce();
    expect(a.equals(b)).toBe(true);
  });
});
