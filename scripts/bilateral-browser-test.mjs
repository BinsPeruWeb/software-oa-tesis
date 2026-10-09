import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
fs.mkdirSync('.local-validation', { recursive: true });
const base = process.env.BILATERAL_TEST_URL ?? 'http://127.0.0.1:3011';
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(base);
const admin = await context.request.post(`${base}/api/auth/login`, { data: { email: 'admin@local.com', password: 'admin12345' } });
assert.ok(admin.ok());
const clinicians = await (await context.request.get(`${base}/api/admin/clinicians`)).json();
const doctor = clinicians.items.find((item) => item.email.startsWith('bilateral-'));
assert.ok(doctor);
await context.clearCookies();
await page.reload();
await page.getByLabel('Correo electrónico', { exact: true }).fill(doctor.email);
await page.getByLabel('Contraseña', { exact: true }).fill('Test12345');
await page.getByRole('button', { name: 'Ingresar al panel' }).click();
await page.getByRole('button', { name: 'Mis pacientes', exact: true }).click();
await page.getByRole('button', { name: 'Ver ficha' }).first().click();
await page.getByRole('heading', { name: 'Rodilla Derecha', exact: true }).waitFor();
await page.getByRole('heading', { name: 'Rodilla Izquierda', exact: true }).waitFor();
assert.equal(await page.locator('.knee-timeline-group').count(), 2);
assert.ok(await page.locator('.knee-timeline-group').first().locator('.study-summary-card').count() >= 2);
assert.ok(await page.locator('.knee-timeline-group').nth(1).locator('.study-summary-card').count() >= 2);
await page.locator('.report-menu summary').click();
for (const name of ['General', 'Rodilla Derecha', 'Rodilla Izquierda']) assert.ok(await page.locator('.report-menu-options').getByRole('button', { name, exact: true }).isVisible());
await page.locator('.report-menu summary').click();
await page.locator('.knee-timeline-group').first().getByRole('button', { name: /Ver análisis/i }).first().click();
await page.getByRole('tab', { name: 'Rodilla derecha' }).waitFor();
assert.equal(await page.locator('.episode-study').count(), 1);
assert.match(await page.locator('.episode-result .overline').textContent(), /derecha/);
await page.getByRole('tab', { name: 'Rodilla izquierda' }).click();
await page.getByRole('tab', { name: 'Rodilla izquierda', selected: true }).waitFor();
assert.equal(await page.locator('.episode-study').count(), 1);
assert.match(await page.locator('.episode-result .overline').textContent(), /izquierda/);
const reports = [];
page.on('request', (request) => { if (request.url().endsWith('/reports') && request.method() === 'POST') reports.push(request.postDataJSON()); });
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: 'Descargar PDF del episodio', exact: true }).click(),
]);
assert.match(download.suggestedFilename(), /izquierda/);
assert.equal(reports.at(-1).kneeSide, 'L');
await page.getByRole('button', { name: /Volver a la ficha/ }).click();
await page.getByRole('heading', { name: 'Rodilla Derecha', exact: true }).waitFor();
await page.screenshot({ path: '.local-validation/bilateral-desktop.png', fullPage: true });
for (const width of [390, 360, 768]) {
  await page.setViewportSize({ width, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `horizontal overflow at ${width}px`);
  if (width === 390) await page.screenshot({ path: '.local-validation/bilateral-mobile.png', fullPage: true });
}
await page.setViewportSize({ width: 1440, height: 1000 });
await page.getByRole('button', { name: /Nuevo análisis/ }).click();
await page.locator('input[type=file]').waitFor();
await page.route('**/api/studies/preflight', async (route) => route.fulfill({ json: {
  preflightId: '22222222-2222-4222-8222-222222222222', fileKind: 'RASTER', reviewStatus: 'ACCEPTED', suggestedLayout: 'bilateral', supported: true,
  previewDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', assessment: { laterality: 'bilateral' },
} }));
await page.locator('input[type=file]').setInputFiles({ name: 'bilateral.png', mimeType: 'image/png', buffer: Buffer.from('fixture') });
await page.getByRole('button', { name: 'Ambas', exact: true }).waitFor();
await page.getByRole('button', { name: 'Ambas', exact: true }).click();
assert.ok(await page.getByText('Se registrará un episodio independiente por rodilla', { exact: false }).isVisible());
await page.getByRole('button', { name: 'Una rodilla', exact: true }).click();
assert.equal(await page.getByRole('button', { name: 'Ambas', exact: true }).count(), 0);
await page.setViewportSize({ width: 360, height: 844 });
await page.screenshot({ path: '.local-validation/bilateral-upload-mobile.png', fullPage: true });
assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
await page.setViewportSize({ width: 1440, height: 1000 });
await page.unroute('**/api/studies/preflight');
const patientList = await (await context.request.get(`${base}/api/patients`)).json();
const patientId = patientList.items[0].id;
const studies = await (await context.request.get(`${base}/api/patients/${patientId}/analyses`)).json();
const radiograph = await (await context.request.get(`${base}${studies[0].previewUrl}`)).body();
await page.locator('input[type=file]').setInputFiles({ name: 'bilateral-real-pipeline.png', mimeType: 'image/png', buffer: radiograph });
await page.getByRole('button', { name: 'Ambas', exact: true }).waitFor();
await page.getByRole('button', { name: 'Ambas', exact: true }).click();
await page.locator('input[type=date]').fill('2026-09-28');
await page.getByRole('button', { name: 'Guardar e iniciar análisis' }).click();
await page.getByRole('tab', { name: 'Rodilla derecha' }).waitFor();
assert.equal(await page.locator('[role=tabpanel]').count(), 2);
await page.waitForFunction(() => [...document.querySelectorAll('.processing-head h2')].filter((element) => element.textContent.startsWith('Análisis completo')).length === 2, null, { timeout: 180000 });
await page.getByRole('tab', { name: 'Rodilla izquierda' }).click();
assert.equal(await page.locator('[role=tabpanel]:not([hidden]) .risk-card').count(), 2);
assert.ok(await page.locator('[role=tabpanel]:not([hidden]) .workflow-recommendation').isVisible());
for (const width of [360, 390, 768]) {
  await page.setViewportSize({ width, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `workflow overflow at ${width}px`);
}
const general = await (await context.request.get(`${base}/api/patients/${patientId}/recommendation`)).json();
assert.ok(general.content.summary.includes(`${studies.length + 2} análisis`));
assert.deepEqual(errors, []);
console.log(JSON.stringify({ ok: true, desktop: true, mobileWidths: [360,390,768], groupedCarousels: true, siblingTabs: true, selectedKneePdf: true, singleRoiSelection: true, automaticBilateralWorkflow: true, generalInterpretationUpdated: true, consoleErrors: errors.length }));
await browser.close();
