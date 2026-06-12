require('dotenv').config();
const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const { Pool }  = require('pg');
const multer    = require('multer');
const csv       = require('csv-parser');
const { PassThrough } = require('stream');
const path      = require('path');
const gtts      = require('node-gtts')('es');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const dbUrl = process.env.DATABASE_URL || '';
const pool  = new Pool({
  connectionString: dbUrl,
  ssl: (process.env.NODE_ENV === 'production' && !dbUrl.includes('.railway.internal'))
    ? { rejectUnauthorized: false }
    : false
});
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve logos from project root
['LogoKinesioGoldBlanco.jpeg', 'LogoKinesioGoldNegro.jpeg'].forEach(f =>
  app.get(`/${f}`, (req, res) => res.sendFile(path.join(__dirname, f)))
);

const toDate = (v) => {
  if (!v) return new Date().toISOString().slice(0, 10);
  if (typeof v === 'string') return v.slice(0, 10);
  return (v.toISOString ? v.toISOString() : String(v)).slice(0, 10);
};

async function emitPacientes(fecha) {
  const { rows } = await pool.query(
    `SELECT p.*, l.nombre AS licenciado_nombre, l.consultorio
     FROM pacientes_dia p JOIN licenciados l ON p.licenciado_id = l.id
     WHERE p.fecha = $1
     ORDER BY p.hora_turno NULLS LAST, p.id`,
    [fecha]
  );
  io.emit('pacientes:updated', { fecha, pacientes: rows });
}

// ── LICENCIADOS ──────────────────────────────────────────────────────────────

app.get('/api/licenciados', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM licenciados ORDER BY nombre');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/licenciados', async (req, res) => {
  try {
    const { nombre, consultorio } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO licenciados (nombre, consultorio) VALUES ($1,$2) RETURNING *',
      [nombre, consultorio]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/licenciados/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM licenciados WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PACIENTES ─────────────────────────────────────────────────────────────────
// Calendar endpoint must come BEFORE /:id

app.get('/api/pacientes/calendar', async (req, res) => {
  try {
    const { month } = req.query; // YYYY-MM
    if (!month) return res.status(400).json({ error: 'month required' });
    const start = `${month}-01`;
    const d = new Date(start + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + 1);
    const end = d.toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT fecha::text, COUNT(*)::int AS count
       FROM pacientes_dia WHERE fecha >= $1 AND fecha < $2
       GROUP BY fecha`,
      [start, end]
    );
    const map = {};
    rows.forEach(r => { map[r.fecha] = r.count; });
    res.json(map);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pacientes', async (req, res) => {
  try {
    const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
    const lic   = req.query.licenciado_id;
    let q = `SELECT p.*, l.nombre AS licenciado_nombre, l.consultorio
             FROM pacientes_dia p JOIN licenciados l ON p.licenciado_id = l.id
             WHERE p.fecha = $1`;
    const params = [fecha];
    if (lic) { q += ` AND p.licenciado_id = $2`; params.push(lic); }
    q += ' ORDER BY p.hora_turno NULLS LAST, p.id';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pacientes', async (req, res) => {
  try {
    const { nombre, licenciado_id, fecha, hora_turno } = req.body;
    const f = fecha || new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `INSERT INTO pacientes_dia (nombre,licenciado_id,fecha,hora_turno)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [nombre, licenciado_id, f, hora_turno || null]
    );
    await emitPacientes(f);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const ALLOWED_FIELDS = ['nombre','licenciado_id','fecha','hora_turno','estado','hora_llegada','hora_llamado'];

app.put('/api/pacientes/:id', async (req, res) => {
  try {
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => ALLOWED_FIELDS.includes(k))
    );
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });
    const keys = Object.keys(updates);
    const vals = Object.values(updates);
    const set  = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE pacientes_dia SET ${set} WHERE id = $${vals.length + 1} RETURNING *`,
      [...vals, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const p     = rows[0];
    const fecha = toDate(p.fecha);
    await emitPacientes(fecha);
    if (p.estado === 'llamado') {
      const { rows: lic } = await pool.query('SELECT * FROM licenciados WHERE id=$1', [p.licenciado_id]);
      if (lic.length) {
        io.emit('paciente:llamado', {
          nombre:      p.nombre,
          consultorio: lic[0].consultorio,
          licenciado:  lic[0].nombre
        });
      }
    }
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/pacientes/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM pacientes_dia WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await emitPacientes(toDate(rows[0].fecha));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CSV IMPORT ────────────────────────────────────────────────────────────────

app.post('/api/turnos/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const rows = [];
  const pass = new PassThrough();
  pass.end(req.file.buffer);
  pass.pipe(csv())
    .on('data', r => rows.push(r))
    .on('end', async () => {
      try {
        let imported = 0;
        for (const row of rows) {
          const nombre    = row.nombre?.trim();
          const licNombre = row.licenciado?.trim();
          const fecha     = row.fecha?.trim();
          const hora      = row.hora_turno?.trim() || null;
          if (!nombre || !licNombre || !fecha) continue;
          const { rows: lic } = await pool.query(
            'SELECT id FROM licenciados WHERE LOWER(nombre)=LOWER($1)', [licNombre]
          );
          if (!lic.length) continue;
          await pool.query(
            `INSERT INTO pacientes_dia (nombre,licenciado_id,fecha,hora_turno) VALUES ($1,$2,$3,$4)`,
            [nombre, lic[0].id, fecha, hora]
          );
          imported++;
        }
        res.json({ imported, total: rows.length });
      } catch (e) { res.status(500).json({ error: e.message }); }
    })
    .on('error', e => res.status(500).json({ error: e.message }));
});

// ── TTS ───────────────────────────────────────────────────────────────────────

app.get('/api/tts', (req, res) => {
  const text = (req.query.text || '').slice(0, 300);
  if (!text) return res.status(400).end();
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  gtts.stream(text).pipe(res);
});

// ── VIDEOS ────────────────────────────────────────────────────────────────────

app.get('/api/videos', async (req, res) => {
  try {
    const only = req.query.activo === 'true';
    let q = 'SELECT * FROM videos';
    if (only) q += ' WHERE activo = true';
    q += ' ORDER BY orden, id';
    const { rows } = await pool.query(q);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/videos', async (req, res) => {
  try {
    const { url, orden, activo } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO videos (url,orden,activo) VALUES ($1,$2,$3) RETURNING *',
      [url, orden ?? 0, activo ?? true]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/videos/:id', async (req, res) => {
  try {
    const { url, orden, activo } = req.body;
    const { rows } = await pool.query(
      'UPDATE videos SET url=$1,orden=$2,activo=$3 WHERE id=$4 RETURNING *',
      [url, orden, activo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/videos/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM videos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`KinesioGold → http://localhost:${PORT}`));
