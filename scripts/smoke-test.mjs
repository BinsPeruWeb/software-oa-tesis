import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';

function readEnv() {
  const values = {};
  for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1).replace(/^"|"$/g, '');
  }
  return values;
}

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of value.replace(/=+$/g, '').toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('Secreto MFA base32 inválido');
    bits += index.toString(2).padStart(5, '0');
  }
  return Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
}

function totp(secret) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[19] & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return number.toString().padStart(6, '0');
}

const crcTable = Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const content = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of content) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return result;
}

function syntheticKneePng() {
  const width = 320;
  const height = 320;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const pixels = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width + 1);
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const dx = (x - 160) / 105;
      const joint = Math.exp(-Math.pow((y - 160) / 13, 2));
      const bone = Math.exp(-(dx * dx)) * (y < 150 || y > 170 ? 105 : 25);
      pixels[row + x + 1] = Math.max(0, Math.min(255, Math.round(35 + bone + 70 * joint + 20 * x / width)));
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}

async function responseBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  const env = readEnv();
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD }),
  });
  const login = await responseBody(loginResponse);
  if (!loginResponse.ok) throw new Error(`Login HTTP ${loginResponse.status}`);
  const secret = process.env.SMOKE_TOTP_SECRET ?? login.enrollment?.secret;
  const enrolledBySmoke = Boolean(login.enrollment?.secret && !process.env.SMOKE_TOTP_SECRET);
  if (!secret) throw new Error('MFA ya está habilitado: defina SMOKE_TOTP_SECRET con el secreto del autenticador');
  const verifyResponse = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeToken: login.challengeToken, code: totp(secret) }),
  });
  const verified = await responseBody(verifyResponse);
  if (!verifyResponse.ok || !verified.authenticated) throw new Error(`MFA HTTP ${verifyResponse.status}`);
  const challengePayload = JSON.parse(Buffer.from(login.challengeToken.split('.')[1], 'base64url').toString('utf8'));
  const cleanupUserId = challengePayload.sub;
  let resetRequired = enrolledBySmoke && env.DEPLOYMENT_ENV === 'local' && process.env.SMOKE_KEEP_MFA !== 'true';
  function resetDevelopmentMfa() {
    if (!resetRequired) return false;
    if (!/^[0-9a-f-]{36}$/i.test(cleanupUserId)) throw new Error('Identificador de usuario inesperado');
    const reset = spawnSync('docker', [
      'compose', 'exec', '-T', 'postgres', 'psql', '-U', 'oa_app', '-d', 'oa_app',
      '-v', 'ON_ERROR_STOP=1', '-c',
      `UPDATE mfa_credentials SET enabled=false, verified_at=NULL WHERE user_id='${cleanupUserId}'::uuid;`,
    ], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
    if (reset.status !== 0) throw new Error('No se pudo restaurar el enrolamiento MFA de desarrollo');
    resetRequired = false;
    return true;
  }
  process.once('exit', () => {
    if (resetRequired) {
      try { resetDevelopmentMfa(); } catch { /* el error original conserva prioridad */ }
    }
  });
  const cookies = verifyResponse.headers.getSetCookie().map((value) => value.split(';', 1)[0]);
  const cookie = cookies.join('; ');
  const csrf = cookies.find((value) => value.startsWith('oa_csrf='))?.slice('oa_csrf='.length);
  if (!csrf) throw new Error('La API no emitió la cookie CSRF');

  async function request(path, { method = 'GET', body, form } = {}) {
    const headers = { cookie };
    if (method !== 'GET') headers['x-csrf-token'] = csrf;
    if (!form && body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const result = await responseBody(response);
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(result)}`);
    return { response, result };
  }

  const me = (await request('/api/auth/me')).result;
  const unique = Date.now().toString();
  const syntheticDni = unique.slice(-8);
  const patient = (await request('/api/patients', { method: 'POST', body: {
    medicalRecordNumber: `SMOKE-HC-${unique}`, dni: syntheticDni,
    names: 'Paciente', surnames: 'Sintético', birthDate: '1960-01-15', sex: 'female',
    phone: '912345678', email: null,
  } })).result;
  const search = (await request(`/api/patients/search?identifier=${syntheticDni}`)).result;
  const episode = (await request(`/api/patients/${patient.id}/episodes`, {
    method: 'POST', body: { openedAt: '2026-09-04' },
  })).result;
  const syntheticImage = syntheticKneePng();
  const checkForm = new FormData();
  checkForm.append('image', new Blob([syntheticImage], { type: 'image/png' }), 'synthetic-knee.png');
  const preflight = (await request('/api/studies/preflight', { method: 'POST', form: checkForm })).result;
  const form = new FormData();
  form.append('image', new Blob([syntheticImage], { type: 'image/png' }), 'synthetic-knee.png');
  form.append('preflightId', preflight.preflightId);
  form.append('imageLayout', preflight.suggestedLayout === 'bilateral' ? 'bilateral' : 'single');
  form.append('kneeSide', 'R'); form.append('examDate', '2026-09-04');
  form.append('acquisitionConfirmed', 'true'); form.append('invertPolarity', 'false'); form.append('swapSides', 'false');
  if (preflight.reviewStatus === 'REJECTED') form.append('manualOverrideReason', 'Imagen sintética controlada para la prueba automatizada');
  const study = (await request(`/api/episodes/${episode.id}/studies`, { method: 'POST', form })).result;
  const queued = (await request(`/api/observations/${study.observationId}/inference`, {
    method: 'POST', body: { idempotencyKey: unique },
  })).result;

  let job;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    job = (await request(`/api/inference-jobs/${queued.id}`)).result;
    if (job.status === 'SUCCEEDED' || job.status === 'FAILED') break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (job?.status !== 'SUCCEEDED' || !job.predictionId) throw new Error(`Inferencia KL terminó en ${job?.status ?? 'TIMEOUT'} (${job?.errorCode ?? 'sin código'})`);
  const predictedKl = job.probabilities.predictedKl;
  await request(`/api/predictions/${job.predictionId}/review`, {
    method: 'POST', body: { decision: 'CONFIRMED', confirmedKl: predictedKl, reason: 'Prueba sintética automatizada' },
  });
  await request(`/api/observations/${study.observationId}/clinical`, { method: 'POST', body: {
    painScore: null, obesity: false, diabetes: false, hypertension: true,
    nicotineUse: false, traumaLowerExtremity: false,
  } });
  await request(`/api/patients/${patient.id}/prior-exams`, { method: 'POST', body: {
    kneeSide: 'R', examDate: '2025-06-01', confirmedKl: Math.max(0, predictedKl - 1), painScore: 4,
    obesity: false, diabetes: false, hypertension: true, nicotineUse: false, traumaLowerExtremity: false,
  } });
  const arthroplasty = (await request(`/api/observations/${study.observationId}/risks/arthroplasty`, { method: 'POST', body: {} })).result;
  const progression = (await request(`/api/observations/${study.observationId}/risks/progression`, { method: 'POST', body: {} })).result;

  let explanations = [];
  for (let attempt = 0; attempt < 180; attempt += 1) {
    explanations = (await request(`/api/predictions/${job.predictionId}/explanations`)).result;
    if (explanations.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const report = (await request(`/api/episodes/${episode.id}/reports`, { method: 'POST', body: {} })).result;
  const download = await fetch(`${baseUrl}/api/reports/${report.id}/download`, { headers: { cookie } });
  const pdf = Buffer.from(await download.arrayBuffer());
  if (!download.ok || pdf.subarray(0, 4).toString() !== '%PDF') throw new Error(`Descarga PDF HTTP ${download.status}`);

  await request('/api/auth/logout', { method: 'POST', body: {} });
  const mfaResetForManualEnrollment = resetDevelopmentMfa();
  console.log(JSON.stringify({
    ok: true, role: me.role, patientSearch: search?.id === patient.id,
    imagePreflight: { status: preflight.reviewStatus, model: preflight.model, costReported: preflight.costUsd !== null },
    kl: { status: job.status, predicted: predictedKl, probabilities: Object.keys(job.probabilities.ensemble ?? {}).length, device: job.device },
    gradCamCount: explanations.length,
    xgboost: { probability: arthroplasty.probability, featureCount: Object.keys(arthroplasty.features ?? {}).length, threshold: arthroplasty.threshold },
    lstm: { available: progression.available, probability: progression.probability, threshold: progression.threshold },
    report: { status: report.status, pdfBytes: pdf.length },
    mfaResetForManualEnrollment,
  }, null, 2));
}

main().catch((error) => {
  console.error(`SMOKE FAILED: ${error.message}`);
  process.exitCode = 1;
});
