# KinesioGold — Sistema de Llamado de Pacientes

Stack: Node.js · Express · Socket.io · PostgreSQL (Railway)

## Setup local

```bash
npm install
cp .env.example .env
# editar .env con tu DATABASE_URL
psql $DATABASE_URL -f schema.sql
npm run dev
```

Abrir → http://localhost:3000/admin.html

## Deploy Railway

1. Crear proyecto en Railway → agregar PostgreSQL plugin
2. Copiar `DATABASE_URL` del plugin como variable del servicio
3. Agregar variable `NODE_ENV=production`
4. Push al repo → Railway detecta `railway.json` y despliega automáticamente

```bash
# Aplicar schema en Railway (una sola vez)
railway run psql $DATABASE_URL -f schema.sql
```

## Carga inicial de licenciados

```bash
# Opción A — API
curl -X POST http://localhost:3000/api/licenciados \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Lic. Ana Torres","consultorio":"Consultorio 1"}'

# Opción B — SQL directo
psql $DATABASE_URL -c "INSERT INTO licenciados (nombre, consultorio) VALUES ('Lic. Ana Torres', 'Consultorio 1');"
```

O usar el tab **Licenciados** en `/admin.html`.

## URLs

| URL | Descripción |
|---|---|
| `/admin.html` | Panel principal: turnos, calendario, CSV import |
| `/display.html` | Display kiosko fullscreen |
| `/licenciado.html?id=X` | Panel del licenciado X |
| `/admin-videos.html` | CRUD de videos del carrusel |

## Flujo de estados

```
pendiente → (Marcó llegada) → esperando → (Llamar) → llamado
```

## CSV import

Formato del archivo (con header):
```
nombre,licenciado,fecha,hora_turno
Juan Pérez,Lic. Ana Torres,2026-06-15,09:00
María López,Lic. Ana Torres,2026-06-15,10:30
```

- `licenciado`: debe coincidir (case-insensitive) con un licenciado existente
- `hora_turno`: opcional, formato HH:MM
