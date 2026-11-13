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
    `SELECT p.*, l.nombre AS licenciado_nombre,
            c.nombre AS consultorio_actual_nombre, c.numero AS consultorio_actual_numero
     FROM pacientes_dia p
     JOIN licenciados l ON p.licenciado_id = l.id
     LEFT JOIN consultorios c ON p.consultorio_actual = c.id
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
    const { nombre } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO licenciados (nombre) VALUES ($1) RETURNING *',
      [nombre]
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

// ── CONSULTORIOS ─────────────────────────────────────────────────────────────

app.get('/api/consultorios', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM consultorios ORDER BY numero, id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/consultorios/disponibles', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM consultorios
       WHERE id NOT IN (
         SELECT consultorio_actual FROM pacientes_dia
         WHERE estado = 'llamado' AND consultorio_actual IS NOT NULL
       )
       ORDER BY numero, id`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/consultorios', async (req, res) => {
  try {
    const { nombre, numero } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO consultorios (nombre, numero) VALUES ($1,$2) RETURNING *',
      [nombre, numero]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/consultorios/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM consultorios WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PACIENTES ─────────────────────────────────────────────────────────────────

app.get('/api/pacientes/calendar', async (req, res) => {
  try {
    const { month } = req.query;
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

app.get('/api/pacientes/historial', async (req, res) => {
  try {
    const { desde, hasta, licenciado_id } = req.query;
    const params = [];
    let where = `WHERE p.estado = 'atendido'`;
    if (desde) { params.push(desde); where += ` AND p.fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta); where += ` AND p.fecha <= $${params.length}`; }
    if (licenciado_id) { params.push(licenciado_id); where += ` AND p.licenciado_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT p.*, l.nombre AS licenciado_nombre,
              c.nombre AS consultorio_actual_nombre,
              EXTRACT(EPOCH FROM (p.hora_atendido - p.hora_llamado))::int AS duracion_seg
       FROM pacientes_dia p
       JOIN licenciados l ON p.licenciado_id = l.id
       LEFT JOIN consultorios c ON p.consultorio_actual = c.id
       ${where}
       ORDER BY p.fecha DESC, p.hora_atendido DESC NULLS LAST`,
      params
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pacientes', async (req, res) => {
  try {
    const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
    const lic   = req.query.licenciado_id;
    let q = `SELECT p.*, l.nombre AS licenciado_nombre,
                     c.nombre AS consultorio_actual_nombre, c.numero AS consultorio_actual_numero
             FROM pacientes_dia p
             JOIN licenciados l ON p.licenciado_id = l.id
             LEFT JOIN consultorios c ON p.consultorio_actual = c.id
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

const ALLOWED_FIELDS = [
  'nombre','licenciado_id','fecha','hora_turno','estado',
  'hora_llegada','hora_llamado','hora_atendido','consultorio_actual'
];

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
      let consultorioNombre = '';
      if (p.consultorio_actual) {
        const { rows: con } = await pool.query('SELECT * FROM consultorios WHERE id=$1', [p.consultorio_actual]);
        if (con.length) consultorioNombre = con[0].nombre;
      }
      if (lic.length) {
        io.emit('paciente:llamado', {
          nombre:      p.nombre,
          consultorio: consultorioNombre,
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

// ── TIMEOUT AUTOMÁTICO ────────────────────────────────────────────────────────

const TIMEOUT_MIN = parseInt(process.env.TIMEOUT_CONSULTORIO_MIN || '30', 10);

setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - TIMEOUT_MIN * 60 * 1000).toISOString();
    const { rows } = await pool.query(
      `UPDATE pacientes_dia
       SET estado='atendido', hora_atendido=NOW(), consultorio_actual=NULL
       WHERE estado='llamado' AND hora_llamado < $1
       RETURNING fecha`,
      [cutoff]
    );
    const fechas = [...new Set(rows.map(r => toDate(r.fecha)))];
    for (const f of fechas) await emitPacientes(f);
  } catch (e) { console.error('timeout check error:', e.message); }
}, 60 * 1000);

// ── START ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`KinesioGold → http://localhost:${PORT}`));
