-- PROPUESTA, NO APLICADA (12 nov 2026). No la corre el arranque del servicio.
--
-- Un solo creador por número de recluso y estado, también en la base, para
-- cerrar la carrera de dos registros simultáneos que la regla del servidor
-- (services/inmate_number_guard.go) no puede ver.
--
-- Hoy NO se puede aplicar: en producción hay creadores con el mismo número
-- (consulta de solo lectura del 12 nov 2026):
--   * CT, un mismo número: 153 suicideking, 213 lawrence.perry, 281 westcol
--     (todos gestionados; representantes 152, 212 y 280).
--   * sin estado, un mismo número: 265 voss203 y 308 mr.voss225 (el caso del
--     6 nov; los dos son cuentas propias, sin representante).
-- CREATE UNIQUE INDEX fallaría. Antes hay que decidir con David qué cuenta se
-- queda en cada grupo (y qué se hace con las otras) y volver a correr el paso 1
-- hasta que no devuelva filas.
--
-- Limitación: el índice compara el estado tal cual (vacío con vacío, CT con
-- CT). La regla del servidor es más estricta: un creador sin estado bloquea el
-- número en cualquier estado. El índice es la red de seguridad, no la regla.

-- 1. Comprobación previa (solo lectura). Tiene que devolver 0 filas.
SELECT ltrim(regexp_replace(upper(inmate_number), '[^A-Z0-9]', '', 'g'), '0') AS numero_normalizado,
       upper(btrim(coalesce(inmate_state, ''))) AS estado,
       array_agg(id ORDER BY id) AS ids,
       array_agg(username ORDER BY id) AS usuarios
FROM users
WHERE role = 'creator'
  AND deleted_at IS NULL
  AND inmate_number IS NOT NULL
  AND ltrim(regexp_replace(upper(inmate_number), '[^A-Z0-9]', '', 'g'), '0') <> ''
GROUP BY 1, 2
HAVING count(*) > 1;

-- 2. El índice (CONCURRENTLY: no bloquea escrituras; no va dentro de una transacción).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_creator_inmate_number_state_unique
    ON users (
        ltrim(regexp_replace(upper(inmate_number), '[^A-Z0-9]', '', 'g'), '0'),
        upper(btrim(coalesce(inmate_state, '')))
    )
    WHERE role = 'creator'
      AND deleted_at IS NULL
      AND inmate_number IS NOT NULL
      AND ltrim(regexp_replace(upper(inmate_number), '[^A-Z0-9]', '', 'g'), '0') <> '';

-- Vuelta atrás:
-- DROP INDEX CONCURRENTLY IF EXISTS users_creator_inmate_number_state_unique;
