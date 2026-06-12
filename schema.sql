CREATE TABLE IF NOT EXISTS licenciados (
  id         SERIAL PRIMARY KEY,
  nombre     TEXT NOT NULL,
  consultorio TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pacientes_dia (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT NOT NULL,
  licenciado_id INTEGER REFERENCES licenciados(id) ON DELETE CASCADE,
  fecha         DATE NOT NULL DEFAULT CURRENT_DATE,
  hora_turno    TIME,
  estado        TEXT NOT NULL DEFAULT 'pendiente',
  hora_llegada  TIMESTAMP,
  hora_llamado  TIMESTAMP
);

CREATE TABLE IF NOT EXISTS videos (
  id     SERIAL PRIMARY KEY,
  url    TEXT NOT NULL,
  orden  INTEGER NOT NULL DEFAULT 0,
  activo BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_pacientes_fecha ON pacientes_dia(fecha);
CREATE INDEX IF NOT EXISTS idx_pacientes_licenciado ON pacientes_dia(licenciado_id);
