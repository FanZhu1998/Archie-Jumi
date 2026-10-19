/** Run `node tests/ui-browser.ts`; optionally set UI_TEST_URL to use an existing preview server. */
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const browser = await chromium.launch({ channel: process.env.UI_TEST_BROWSER ?? 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const errors: string[] = [];
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const base = process.env.UI_TEST_URL ?? 'http://127.0.0.1:5184';
const previewServer = process.env.UI_TEST_URL ? null : spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5184', '--strictPort'], { stdio: 'ignore', windowsHide: true });
const key = 'archie-jumi.preview.state.v1';
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(base)).ok) break; } catch { /* Wait for the local test server. */ }
    if (attempt === 49) throw new Error('The local preview server did not start.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await page.goto(`${base}/?view=settings`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Archie');
  await expect(page.getByRole('heading', { name: 'Archie', exact: true })).toBeVisible();
  await expect(page.locator('.portrait-image')).toHaveCount(2);
  await expect.poll(() => page.locator('.portrait-image').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);

  await page.getByRole('button', { name: "Edit Archie's name" }).click();
  await page.getByRole('textbox', { name: 'Name for Archie' }).fill('Archibald');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('heading', { name: 'Archibald', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Archibald', exact: true })).toBeVisible();

  const card = page.locator('#pet-archie');
  await card.getByText('Personality & size').click();
  const size = card.getByRole('slider', { name: 'Size' });
  await size.focus();
  await page.keyboard.press('End');
  await expect(size).toHaveValue('192');
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).preferences.pets.archie.size, key)).toBe(192);
  await card.getByRole('checkbox', { name: 'Automatic toy' }).uncheck();
  await card.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('status').last()).toContainText("Archibald's playtime");

  const before = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).preferences.pets.archie.position.x, key);
  await card.getByRole('button', { name: 'Move Archibald right' }).click();
  await card.getByRole('button', { name: 'Move Archibald right' }).click();
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).preferences.pets.archie.position.x, key)).toBeCloseTo(before + 0.08);

  await page.getByRole('checkbox', { name: 'Quiet mode' }).check();
  await expect(card.getByRole('button', { name: 'Pet', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Nose boop' })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Quiet mode' }).uncheck();
  await expect(card.getByRole('button', { name: 'Pet', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Hide companions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show companions', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show companions', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Little sounds' }).check();
  await expect(page.getByRole('slider', { name: 'Volume' })).toBeEnabled();
  await page.getByRole('checkbox', { name: 'Gentler motion' }).check();
  await expect(page.locator('.companion-app')).toHaveClass(/reduced-motion/);

  // Curious about the cursor: on by default, saved across a reload, and disabled while Quiet Mode is on.
  const curious = page.getByRole('checkbox', { name: 'Curious about the cursor' });
  const savedCurious = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).preferences.curious, key);
  await expect(curious).toBeChecked();
  await expect(page.getByText('Kittens notice a resting cursor and may wander over.')).toBeVisible();
  await curious.uncheck();
  await expect.poll(savedCurious).toBe(false);
  await page.reload();
  await expect(curious).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Quiet mode' }).check();
  await expect(curious).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Quiet mode' }).uncheck();
  await expect(curious).toBeEnabled();
  await curious.check();
  await expect.poll(savedCurious).toBe(true);

  const playground = await context.newPage();
  playground.on('pageerror', error => errors.push(error.message));
  await playground.goto(`${base}/?view=overlay`);
  await expect(playground.getByLabel('Archie and Jumi desktop companions')).toBeVisible();
  await expect(playground.locator('[data-error]')).toHaveCount(0);
  await expect.poll(() => playground.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await page.getByRole('button', { name: 'Hide companions', exact: true }).click();
  await expect(playground.getByLabel('Archie and Jumi desktop companions')).toBeHidden();
  await page.getByRole('button', { name: 'Show companions', exact: true }).click();
  await expect(playground.getByLabel('Archie and Jumi desktop companions')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Quiet mode' }).check();
  await expect.poll(() => playground.evaluate(key => JSON.parse(localStorage.getItem(key)!).preferences.quiet, key)).toBe(true);
  await page.getByRole('checkbox', { name: 'Quiet mode' }).uncheck();
  await page.getByRole('button', { name: 'Nose boop' }).click();
  await expect(page.getByRole('status').last()).toContainText('nose-to-nose');
  await page.getByRole('button', { name: 'End play' }).click();

  // The motion layer's canvases are attached, and hold-to-pet works with the real mouse: a press on
  // Archie that stays put for 350 ms becomes a held pet, and its release ends it (he sits).
  await expect.poll(() => playground.locator('canvas').count()).toBeGreaterThanOrEqual(2);
  type KittenSummary = { id: string; x: number; y: number; size: number; action: string; held: boolean };
  const archie = () => playground.evaluate(() => (window as unknown as { __archieJumi: { scene: { pets: KittenSummary[] } } }).__archieJumi.scene.pets.find(pet => pet.id === 'archie')!);
  await card.getByRole('button', { name: 'Pet', exact: true }).click();
  await expect.poll(async () => (await archie()).action).toBe('pet');
  const pressed = await archie();
  await playground.mouse.move(pressed.x, pressed.y + pressed.size * 0.1);
  await playground.mouse.down();
  await expect.poll(async () => (await archie()).held).toBe(true);
  await playground.mouse.up();
  await expect.poll(async () => { const now = await archie(); return now.action === 'sit' && !now.held; }).toBe(true);
  await playground.mouse.move(5, 5);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.locator('#pet-archie summary').click();
  await page.getByRole('button', { name: "Edit Archibald's name" }).click();
  await page.getByRole('textbox', { name: 'Name for Archibald' }).fill('Archie');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('heading', { name: 'Archie', exact: true })).toBeVisible();
  await page.reload();
  await expect.poll(() => page.locator('.portrait-image').evaluateAll(images => images.length === 2 && images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/browser-control-panel.png', fullPage: true });
  expect(errors).toEqual([]);
  console.log('Browser UI passed: artwork, rename/reload, keyboard slider, play, repeated reposition, quiet, visibility, sound, reduced motion, curious toggle, live playground, hold-to-pet, mobile layout, and no page errors.');
} finally {
  await browser.close();
  previewServer?.kill();
}
