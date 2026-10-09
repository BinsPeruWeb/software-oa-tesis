// Run only inside an isolated presentation container configured with the local
// provider below. Real CNN, Grad-CAM, XGBoost, LSTM and PostgreSQL are exercised;
// OpenRouter responses are simulated without external calls or credits.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';

const base = process.env.BILATERAL_TEST_URL ?? 'http://127.0.0.1:3000';
let providerFailure = false;
let rejectedImage = false;
const providerInputs = [];
const provider = http.createServer(async (req, res) => {
  let bytes = '';
  for await (const part of req) bytes += part;
  const request = JSON.parse(bytes);
  if (providerFailure && request.model === 'isolated-recommendation') {
    res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}'); return;
  }
  let content;
  if (request.model === 'isolated-vision') {
    content = { is_radiograph: !rejectedImage, anatomy: rejectedImage ? 'other' : 'knee', view: 'frontal_ap',
      coverage: 'bilateral', laterality: 'bilateral', weight_bearing: 'unknown', quality: 'adequate', confidence: .95, reason_codes: [] };
  } else {
    const input = JSON.parse(request.messages[1].content);
    providerInputs.push(input);
    const sides = [...new Set(input.studies.map((study) => study.knee_side))];
    const label = sides.length > 1 ? 'derecha e izquierda' : sides[0] === 'R' ? 'derecha' : 'izquierda';
    content = { headline: `Osteoartritis de rodilla ${label}`,
      summary: `Interpretación ${input.scope === 'PATIENT' ? 'general' : 'individual'} de rodilla ${label}, basada en ${input.studies.length} análisis. Las comparaciones se mantienen dentro de la misma lateralidad.`,
      recommendation: `Se recomienda revisar la rodilla ${label} y acordar el seguimiento según los hallazgos registrados.`, priority: 'routine' };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'isolated-provider', model: request.model, usage: { cost: 0 }, choices: [{ message: { content: JSON.stringify(content) } }] }));
});

function syntheticPng() {
  const width = 640, height = 320;
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    for (let bit = 0; bit < 8; bit++) index = index & 1 ? 0xedb88320 ^ index >>> 1 : index >>> 1;
    return index >>> 0;
  });
  const chunk = (type, data) => {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); bytes.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8;
  const pixels = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = ((x % 320) - 160) / 105;
    const joint = Math.exp(-Math.pow((y - 160) / 13, 2));
    const bone = Math.exp(-dx * dx) * (y < 150 || y > 170 ? 105 : 25);
    pixels[y * (width + 1) + x + 1] = Math.min(255, Math.round(35 + bone + 70 * joint + 20 * (x % 320) / 320));
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function session(email, password) {
  const result = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(result.status, 201);
  assert.equal((await result.json()).authenticated, true);
  const cookies = result.headers.getSetCookie().map((cookie) => cookie.split(';')[0]);
  const csrf = cookies.find((cookie) => cookie.startsWith('oa_csrf=')).slice(8);
  return async (path, { method = 'GET', body, form, status } = {}) => {
    const headers = { cookie: cookies.join('; '), 'x-csrf-token': csrf };
    if (body) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined) });
    const value = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    if (status) assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`);
    else assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`);
    return value;
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(test, message) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) { const value = await test(); if (value) return value; await delay(500); }
  throw new Error(`Timed out: ${message}`);
}

function pdfPageText(pdf) {
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const source = pdf.toString('latin1');
  const pages = [...source.matchAll(/\d+ 0 obj\s*<<\s*\/Type \/Page\b([\s\S]*?)endobj/g)];
  return pages.map((page) => {
    const reference = page[1].match(/\/Contents (\d+) 0 R/)[1];
    const object = new RegExp(`(?:^|\\n)${reference} 0 obj\\s*([\\s\\S]*?)endobj`).exec(source)[1];
    const start = object.indexOf('stream\n') + 7;
    const length = Number(object.match(/\/Length (\d+)/)[1]);
    const stream = zlib.inflateSync(Buffer.from(object.slice(start, start + length), 'latin1')).toString();
    return [...stream.matchAll(/<([a-f\d]+)>/gi)].map((match) => Buffer.from(match[1], 'hex').toString('latin1')).join('');
  });
}

async function main() {
  const config = fs.readFileSync('/opt/oa/config/presentation.env', 'utf8');
  assert.match(config, /OPENROUTER_BASE_URL=http:\/\/127\.0\.0\.1:8090\/v1/, 'Use an isolated test container, never the user database');
  await new Promise((resolve) => provider.listen(8090, '127.0.0.1', resolve));
  if (process.env.BILATERAL_PROVIDER_ONLY === 'true') {
    console.log('Isolated OpenRouter fixture listening on 8090');
    return;
  }
  const admin = await session('admin@local.com', 'admin12345');
  const suffix = Date.now().toString().slice(-8);
  const email = `bilateral-${suffix}@local.com`;
  await admin('/api/admin/clinicians', { method: 'POST', body: { email, password: 'Test12345', displayName: 'Médico de pruebas bilaterales', dni: suffix, cmp: '123456', healthEstablishment: 'Establecimiento sintético' } });
  const request = await session(email, 'Test12345');
  const patient = await request('/api/patients', { method: 'POST', body: { dni: suffix, names: 'Paciente', surnames: 'Bilateral sintético', birthDate: '1960-01-15', sex: 'female', phone: '912345678', email: null } });
  await request(`/api/patients/${patient.id}/clinical-profile`, { method: 'PATCH', body: { painScore: 4, obesity: false, diabetes: false, hypertension: true, nicotineUse: false, traumaLowerExtremity: false } });
  const image = syntheticPng();
  const preflightForm = new FormData(); preflightForm.append('image', new Blob([image], { type: 'image/png' }), 'synthetic-bilateral.png');
  const preflight = await request('/api/studies/preflight', { method: 'POST', form: preflightForm });
  assert.equal(preflight.reviewStatus, 'ACCEPTED');
  const upload = async (date, layout = 'bilateral', selection = 'BOTH', expectedStatus) => {
    const episode = await request(`/api/patients/${patient.id}/episodes`, { method: 'POST', body: { openedAt: date } });
    const form = new FormData();
    form.append('image', new Blob([image], { type: 'image/png' }), 'synthetic-bilateral.png');
    for (const [name, value] of Object.entries({ examDate: date, preflightId: preflight.preflightId, imageLayout: layout, kneeSide: selection, invertPolarity: 'false', swapSides: 'false' })) form.append(name, value);
    return request(`/api/episodes/${episode.id}/studies`, { method: 'POST', form, status: expectedStatus });
  };
  await upload('2026-09-20', 'single', 'BOTH', 400);
  const latest = await upload('2026-09-20');
  const older = await upload('2026-06-20');
  const all = [...latest.analyses, ...older.analyses];
  assert.equal(all.length, 4);
  assert.equal(new Set(all.map((item) => item.episodeId)).size, 4);
  assert.notEqual(latest.bilateralGroupId, older.bilateralGroupId);
  for (const item of all) {
    const job = await waitFor(async () => { const job = await request(`/api/inference-jobs/${item.jobId}`); assert.notEqual(job.status, 'FAILED'); return job.status === 'SUCCEEDED' ? job : null; }, 'CNN');
    assert.equal(Object.keys(job.probabilities.ensemble).length, 5);
    assert.ok(Math.abs(Object.values(job.probabilities.ensemble).reduce((a,b) => a+b,0) - 1) < 1e-6);
    await waitFor(async () => (await request(`/api/predictions/${job.predictionId}/explanations`)).length === 2, 'Grad-CAM');
    const kl = latest.analyses.includes(item) ? 2 : 1;
    await request(`/api/predictions/${job.predictionId}/review`, { method: 'POST', body: { decision: kl === job.probabilities.predictedKl ? 'CONFIRMED' : 'CORRECTED', confirmedKl: kl } });
    const xgb = await request(`/api/observations/${item.observationId}/risks/arthroplasty`, { method: 'POST', body: {} });
    assert.equal(Object.keys(xgb.features).length, 19);
    assert.equal(xgb.features.knee_left, item.kneeSide === 'L' ? 1 : 0);
    await request(`/api/observations/${item.observationId}/risks/progression`, { method: 'POST', body: {} });
    await request(`/api/observations/${item.observationId}/recommendations`, { method: 'POST', body: {} });
    await request(`/api/observations/${item.observationId}/clinical-note`, { method: 'PATCH', body: { content: `Nota propia ${item.kneeSide} ${item.observationId}` } });
  }
  await request(`/api/patients/${patient.id}/clinical-note`, { method: 'PATCH', body: { content: 'Nota general bilateral del paciente.' } });
  for (const item of latest.analyses) {
    const progression = await request(`/api/observations/${item.observationId}/risks/progression`, { method: 'POST', body: {} });
    assert.equal(progression.threshold, 0.4802020202);
    assert.ok(progression.probability >= 0 && progression.probability <= 1);
    const summary = await request(`/api/episodes/${item.episodeId}/analysis`);
    assert.equal(summary.studies.length, 2);
    assert.equal(summary.studies.find((study) => study.episodeId === item.episodeId).kneeSide, item.kneeSide);
  }
  await request(`/api/observations/${latest.analyses[1].observationId}/recommendations`, { method: 'POST', body: {} });
  const general = await request(`/api/patients/${patient.id}/recommendation`);
  assert.match(general.content.summary, /4 análisis/);
  assert.match(general.content.summary, /derecha e izquierda/);
  const analyses = await request(`/api/patients/${patient.id}/analyses`);
  assert.equal(analyses.length, 4);
  assert.ok(analyses.every((study) => study.recommendation && study.note));
  assert.ok(analyses[0].examDate >= analyses.at(-1).examDate);

  const pdfResults = [];
  for (const item of latest.analyses) {
    const report = await request(`/api/episodes/${item.episodeId}/reports`, { method: 'POST', body: { reportType: 'EPISODE', kneeSide: item.kneeSide } });
    const pdf = await request(`/api/reports/${report.id}/download`);
    const pages = pdfPageText(pdf);
    assert.equal(pages.length, 2);
    assert.match(pages[0], new RegExp(item.kneeSide === 'R' ? 'Derecha' : 'Izquierda', 'i'));
    assert.ok(pages[1].includes(item.observationId));
    assert.ok(!pages[1].includes(latest.analyses.find((other) => other !== item).observationId));
    pdfResults.push({ type: 'EPISODE', side: item.kneeSide, pages: pages.length });
  }
  for (const side of ['R', 'L', 'ALL']) {
    const report = await request(`/api/episodes/${latest.analyses[0].episodeId}/reports`, { method: 'POST', body: { reportType: 'LONGITUDINAL', kneeSide: side } });
    const pages = pdfPageText(await request(`/api/reports/${report.id}/download`));
    assert.equal(pages.length, side === 'ALL' ? 5 : 3);
    if (side !== 'ALL') for (const page of pages.slice(0, -1)) {
      assert.match(page, new RegExp(side === 'R' ? 'Derecha' : 'Izquierda', 'i'));
      assert.ok(!new RegExp(side === 'R' ? 'Izquierda' : 'Derecha', 'i').test(page));
    }
    assert.match(pages.at(-1), /derecha e izquierda/);
    assert.match(pages.at(-1), /Nota general bilateral/);
    pdfResults.push({ type: 'LONGITUDINAL', side, pages: pages.length });
  }
  providerFailure = true;
  const job = await request(`/api/inference-jobs/${latest.analyses[0].jobId}`);
  await request(`/api/predictions/${job.predictionId}/review`, { method: 'POST', body: { decision: 'CORRECTED', confirmedKl: 3 } });
  const failed = await request(`/api/observations/${latest.analyses[0].observationId}/recommendations`, { method: 'POST', body: {} });
  assert.ok(failed.errors.some((item) => item.code === 'OPENROUTER_UNAUTHORIZED'));
  assert.ok(failed.individual && failed.general, 'previous interpretations must remain available');
  providerFailure = false;
  rejectedImage = true;
  const rejectForm = new FormData(); rejectForm.append('image', new Blob([image], { type: 'image/png' }), 'rejected.png');
  assert.equal((await request('/api/studies/preflight', { method: 'POST', form: rejectForm })).reviewStatus, 'REJECTED');
  rejectedImage = false;
  const roi = await upload('2026-09-25', 'single', 'L');
  assert.equal(roi.analyses.length, 1); assert.equal(roi.bilateralGroupId, null);
  const reportList = await request('/api/reports');
  assert.ok(reportList.items.some((item) => item.kneeSide === 'L'));
  assert.ok(providerInputs.some((input) => input.scope === 'PATIENT' && input.studies.length === 4));
  const result = { ok: true, patientId: patient.id, clinicianEmail: email, episodes: 4, independentInterpretations: 4, independentNotes: 4,
    xgboostFeatures: 19, lstmBothKneesAfterOutOfOrderUpload: true, pdfResults, providerFailurePreservesSavedInterpretation: true, singleKneeCompatibility: true };
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  if (process.env.BILATERAL_PROVIDER_ONLY !== 'true') provider.close();
});
