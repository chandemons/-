const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://osxacblrlhbclxrwxlfv.supabase.co').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
const TABLE = process.env.SUPABASE_TABLE || 'apk_config';
const DEVICE_TABLE = process.env.SUPABASE_DEVICE_TABLE || 'dispositivos';
const LINE_TABLE = process.env.SUPABASE_LINE_TABLE || 'lineas';
const PUBLIC_DIR = path.join(__dirname, 'public');
const sessions = new Map();

function send(res, status, body, headers = {}) {
  const isString = typeof body === 'string' || Buffer.isBuffer(body);
  const data = isString ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isString ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(data);
}

function sendJson(res, status, body) {
  send(res, status, body, { 'Content-Type': 'application/json; charset=utf-8' });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function cleanDevice(row) {
  const tipo = row.tipo === 'm3u' ? 'm3u' : 'xtream';
  return {
    device_id: String(row.device_id || '').trim(),
    activo: Boolean(row.activo),
    tipo,
    servidor: String(row.servidor || '').trim(),
    usuario: String(row.usuario || '').trim(),
    password: String(row.password || '').trim(),
    m3u_url: String(row.m3u_url || '').trim(),
    caduca: String(row.caduca || '').trim() || null,
    vpn_enabled: row.vpn_enabled === true,
    vpn_tunnel: String(row.vpn_tunnel || '').trim(),
    vpn_config: String(row.vpn_config || '').trim(),
    line_id: String(row.line_id || '').trim(),
    force_new_line: row.force_new_line === true
  };
}

function cleanLine(row) {
  return {
    activo: row.line_activo === false ? false : true,
    tipo: row.tipo === 'm3u' ? 'm3u' : 'xtream',
    servidor: String(row.servidor || '').trim(),
    usuario: String(row.usuario || '').trim(),
    password: String(row.password || '').trim(),
    m3u_url: String(row.m3u_url || '').trim()
  };
}

function cleanAppLine(row) {
  return {
    activo: true,
    tipo: row.tipo === 'm3u' ? 'm3u' : 'xtream',
    servidor: String(row.servidor || '').trim(),
    usuario: String(row.usuario || '').trim(),
    password: String(row.password || '').trim(),
    m3u_url: String(row.m3u_url || '').trim()
  };
}

function sameLine(a, b) {
  return String(a.tipo || 'xtream') === String(b.tipo || 'xtream')
    && String(a.servidor || '').trim() === String(b.servidor || '').trim()
    && String(a.usuario || '').trim() === String(b.usuario || '').trim()
    && String(a.password || '').trim() === String(b.password || '').trim()
    && String(a.m3u_url || '').trim() === String(b.m3u_url || '').trim();
}

function deviceMessage(row) {
  if (!row.vpn_config) return '';
  return JSON.stringify({
    vpn_enabled: row.vpn_enabled === true,
    vpn_tunnel: row.vpn_tunnel || '',
    vpn_config: row.vpn_config || ''
  });
}

function requireAuth(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !sessions.has(token)) {
    sendJson(res, 401, { ok: false, message: 'Entra otra vez en el panel.' });
    return false;
  }
  sessions.set(token, Date.now());
  return true;
}

async function supabase(pathname, options = {}) {
  if (!SUPABASE_KEY) {
    throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY en el servidor online.');
  }
  const response = await fetch(SUPABASE_URL + pathname, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    data = text;
  }
  if (!response.ok) {
    const detail = data && data.message ? data.message : text || 'Error con Supabase';
    if (/cannot insert into view|cannot update view|cannot delete from view/i.test(detail)) {
      throw new Error('Supabase dice que "' + TABLE + '" es una vista. Pon SUPABASE_TABLE con la tabla real que hay debajo de esa vista.');
    }
    throw new Error(detail);
  }
  return data;
}

function encodedDevice(id) {
  return encodeURIComponent(String(id || '').trim());
}

async function findDevice(deviceId) {
  const rows = await supabase('/rest/v1/' + DEVICE_TABLE + '?device_id=eq.' + encodedDevice(deviceId) + '&select=id,device_id');
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function ensureAppDevice(deviceId) {
  const existing = await findDevice(deviceId);
  if (existing) return existing;
  const rows = await supabase('/rest/v1/' + DEVICE_TABLE, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      device_id: deviceId,
      activo: false,
      caduca: null,
      mensaje: '',
      vpn_enabled: false,
      vpn_tunnel: '',
      vpn_config: ''
    })
  });
  const created = Array.isArray(rows) ? rows[0] : rows;
  if (!created || created.id === undefined || created.id === null) {
    throw new Error('No se pudo crear el dispositivo en el panel.');
  }
  return created;
}

async function appSaveLine(deviceId, input) {
  const line = cleanAppLine(input);
  if (line.tipo === 'm3u' && !line.m3u_url) throw new Error('Falta la URL M3U.');
  if (line.tipo === 'xtream' && (!line.servidor || !line.usuario || !line.password)) {
    throw new Error('Faltan servidor, usuario o contrasena Xtream.');
  }
  const device = await ensureAppDevice(deviceId);
  const rows = await supabase('/rest/v1/' + LINE_TABLE + '?dispositivo_id=eq.' + encodeURIComponent(device.id)
    + '&select=id,activo,tipo,servidor,usuario,password,m3u_url');
  const existing = (Array.isArray(rows) ? rows : []).find(row => sameLine(row, line));
  if (existing) {
    if (!existing.activo) {
      await supabase('/rest/v1/' + LINE_TABLE + '?id=eq.' + encodeURIComponent(existing.id), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ activo: true })
      });
    }
    return existing.id;
  }
  const saved = await supabase('/rest/v1/' + LINE_TABLE, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ dispositivo_id: device.id, ...line })
  });
  const created = Array.isArray(saved) ? saved[0] : saved;
  return created && created.id;
}

async function appDeleteLine(deviceId, input) {
  const device = await findDevice(deviceId);
  if (!device) return 0;
  const line = cleanAppLine(input);
  const rows = await supabase('/rest/v1/' + LINE_TABLE + '?dispositivo_id=eq.' + encodeURIComponent(device.id)
    + '&select=id,activo,tipo,servidor,usuario,password,m3u_url');
  const matches = (Array.isArray(rows) ? rows : []).filter(row => sameLine(row, line));
  for (const match of matches) {
    await supabase('/rest/v1/' + LINE_TABLE + '?id=eq.' + encodeURIComponent(match.id), {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
  }
  return matches.length;
}

async function listDevicesWithLines() {
  const deviceRows = await supabase('/rest/v1/' + DEVICE_TABLE + '?select=*');
  const lineRows = await supabase('/rest/v1/' + LINE_TABLE + '?select=id,dispositivo_id,activo,tipo,servidor,usuario,password,m3u_url');
  const byId = new Map();
  for (const d of Array.isArray(deviceRows) ? deviceRows : []) {
    byId.set(String(d.id), {
      id: d.id,
      device_id: d.device_id || '',
      activo: Boolean(d.activo),
      caduca: d.caduca || '',
      vpn_enabled: d.vpn_enabled === true,
      vpn_tunnel: d.vpn_tunnel || '',
      vpn_config: d.vpn_config || '',
      lines: []
    });
  }
  for (const l of Array.isArray(lineRows) ? lineRows : []) {
    const device = byId.get(String(l.dispositivo_id));
    if (!device) continue;
    device.lines.push({
      id: l.id,
      activo: Boolean(l.activo),
      tipo: l.tipo || 'xtream',
      servidor: l.servidor || '',
      usuario: l.usuario || '',
      password: l.password || '',
      m3u_url: l.m3u_url || ''
    });
  }
  return Array.from(byId.values()).sort((a, b) => String(a.device_id).localeCompare(String(b.device_id)));
}

async function saveDeviceAndLine(row) {
  const existing = await findDevice(row.device_id);
  const devicePayload = {
    device_id: row.device_id,
    activo: row.activo,
    caduca: row.caduca,
    mensaje: deviceMessage(row),
    vpn_enabled: row.vpn_enabled,
    vpn_tunnel: row.vpn_tunnel,
    vpn_config: row.vpn_config
  };
  const savedDevice = existing
    ? await supabase('/rest/v1/' + DEVICE_TABLE + '?id=eq.' + encodeURIComponent(existing.id), {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(devicePayload)
      })
    : await supabase('/rest/v1/' + DEVICE_TABLE, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(devicePayload)
      });
  const device = Array.isArray(savedDevice) ? savedDevice[0] : savedDevice;
  if (!device || device.id === undefined || device.id === null) {
    throw new Error('No se pudo obtener el ID interno del dispositivo.');
  }

  const linePayload = {
    dispositivo_id: device.id,
    ...cleanLine(row)
  };

  let shouldUpdateLine = Boolean(row.line_id && !row.force_new_line);
  if (shouldUpdateLine) {
    const currentLine = await supabase('/rest/v1/' + LINE_TABLE + '?id=eq.' + encodeURIComponent(row.line_id) + '&select=id,dispositivo_id');
    const currentDeviceId = Array.isArray(currentLine) && currentLine[0] ? String(currentLine[0].dispositivo_id) : '';
    if (currentDeviceId && currentDeviceId !== String(device.id)) shouldUpdateLine = false;
  }

  if (shouldUpdateLine) {
    await supabase('/rest/v1/' + LINE_TABLE + '?id=eq.' + encodeURIComponent(row.line_id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(linePayload)
    });
  } else {
    await supabase('/rest/v1/' + LINE_TABLE, {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(linePayload)
    });
  }

  await syncLegacyApkConfig(row);
  return row;
}

async function renameDevice(oldDeviceId, newDeviceId) {
  const oldId = String(oldDeviceId || '').trim();
  const newId = String(newDeviceId || '').trim();
  if (!oldId || !newId) throw new Error('Falta el ID antiguo o el ID nuevo.');
  if (oldId === newId) return { oldDeviceId: oldId, newDeviceId: newId };

  const oldDevice = await findDevice(oldId);
  if (!oldDevice) throw new Error('No se encontro el dispositivo antiguo.');

  const existingNew = await findDevice(newId);
  if (existingNew && String(existingNew.id) !== String(oldDevice.id)) {
    await supabase('/rest/v1/' + LINE_TABLE + '?dispositivo_id=eq.' + encodeURIComponent(oldDevice.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ dispositivo_id: existingNew.id })
    });
    await supabase('/rest/v1/' + DEVICE_TABLE + '?id=eq.' + encodeURIComponent(oldDevice.id), {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
  } else {
    await supabase('/rest/v1/' + DEVICE_TABLE + '?id=eq.' + encodeURIComponent(oldDevice.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ device_id: newId })
    });
  }

  if (TABLE) {
    try {
      await supabase('/rest/v1/' + TABLE + '?device_id=eq.' + encodedDevice(oldId), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ device_id: newId })
      });
    } catch (err) {
      if (!/cannot update view|column .*device_id|could not find .*device_id/i.test(String(err.message || ''))) {
        throw err;
      }
    }
  }

  return { oldDeviceId: oldId, newDeviceId: newId };
}

async function syncLegacyApkConfig(row) {
  if (!TABLE) return;
  const payload = {
    activo: row.activo,
    caduca: row.caduca,
    mensaje: deviceMessage(row)
  };
  try {
    await supabase('/rest/v1/' + TABLE + '?device_id=eq.' + encodedDevice(row.device_id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    if (!/column .*mensaje|could not find .*mensaje|cannot update view/i.test(String(err.message || ''))) {
      throw err;
    }
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readJson(req);
    const user = String(body.user || '').trim();
    const pass = String(body.password || '');
    if (user !== ADMIN_USER || pass !== ADMIN_PASSWORD) {
      return sendJson(res, 401, { ok: false, message: 'Usuario o contrasena incorrectos.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now());
    return sendJson(res, 200, { ok: true, token, user: ADMIN_USER });
  }

  const appLineMatch = url.pathname.match(/^\/api\/app\/devices\/([^/]+)\/lines$/);
  if (appLineMatch && (req.method === 'POST' || req.method === 'DELETE')) {
    const deviceId = decodeURIComponent(appLineMatch[1]).trim();
    if (!deviceId || deviceId === 'unknown') {
      return sendJson(res, 400, { ok: false, message: 'ID de dispositivo no valido.' });
    }
    const body = await readJson(req);
    if (req.method === 'POST') {
      const lineId = await appSaveLine(deviceId, body);
      return sendJson(res, 200, { ok: true, line_id: lineId });
    }
    const deleted = await appDeleteLine(deviceId, body);
    return sendJson(res, 200, { ok: true, deleted });
  }

  if (!requireAuth(req, res)) return;

  if (url.pathname === '/api/me' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, user: ADMIN_USER });
  }

  if (url.pathname === '/api/devices' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, devices: await listDevicesWithLines() });
  }

  if (url.pathname === '/api/devices' && req.method === 'POST') {
    const row = cleanDevice(await readJson(req));
    if (!row.device_id) return sendJson(res, 400, { ok: false, message: 'Falta el ID del dispositivo.' });
    const saved = await saveDeviceAndLine(row);
    return sendJson(res, 200, { ok: true, device: saved });
  }

  const match = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
  if (match && req.method === 'PATCH') {
    const id = decodeURIComponent(match[1]);
    const body = await readJson(req);
    if (body.device_only) {
      const existing = await findDevice(id);
      if (!existing) return sendJson(res, 404, { ok: false, message: 'Dispositivo no encontrado.' });
      await supabase('/rest/v1/' + DEVICE_TABLE + '?id=eq.' + encodeURIComponent(existing.id), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ activo: Boolean(body.activo), caduca: String(body.caduca || '').trim() || null })
      });
      return sendJson(res, 200, { ok: true });
    }
    const row = cleanDevice({ ...body, device_id: id });
    const saved = await saveDeviceAndLine(row);
    return sendJson(res, 200, { ok: true, device: saved });
  }

  const renameMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/rename$/);
  if (renameMatch && req.method === 'POST') {
    const oldId = decodeURIComponent(renameMatch[1]);
    const body = await readJson(req);
    const renamed = await renameDevice(oldId, body.new_device_id);
    return sendJson(res, 200, { ok: true, ...renamed });
  }

  if (match && req.method === 'DELETE') {
    const id = decodeURIComponent(match[1]);
    const device = await findDevice(id);
    if (device && device.id !== undefined && device.id !== null) {
      await supabase('/rest/v1/' + LINE_TABLE + '?dispositivo_id=eq.' + encodeURIComponent(device.id), {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' }
      });
    }
    await supabase('/rest/v1/' + DEVICE_TABLE + '?device_id=eq.' + encodedDevice(id), {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
    return sendJson(res, 200, { ok: true });
  }

  const lineMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/lines\/([^/]+)$/);
  if (lineMatch && req.method === 'DELETE') {
    const lineId = decodeURIComponent(lineMatch[2]);
    await supabase('/rest/v1/' + LINE_TABLE + '?id=eq.' + encodeURIComponent(lineId), {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, message: 'Ruta no encontrada.' });
}

function serveStatic(req, res, url) {
  const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const target = path.normalize(path.join(PUBLIC_DIR, file));
  if (!target.startsWith(PUBLIC_DIR)) return send(res, 403, 'No permitido');
  fs.readFile(target, (err, data) => {
    if (err) return send(res, 404, 'No encontrado');
    const ext = path.extname(target).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };
    send(res, 200, data, { 'Content-Type': types[ext] || 'application/octet-stream' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    return sendJson(res, 500, { ok: false, message: err.message || 'Error interno.' });
  }
});

server.listen(PORT, () => {
  console.log('Panel de activacion online activo en puerto ' + PORT);
});
