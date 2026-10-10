-- Ejecutar en phpMyAdmin del servidor. Exclusivamente orden id_orden_c = 99.
-- Cerrar los formularios abiertos de esa orden antes de ejecutar.
-- Las tablas exacto_bak99_* conservan los registros eliminados.
-- No se modifica el consecutivo de folios ni order_submissions:
-- conservar la clave de guardado impide recrear la orden con el mismo reintento.
USE `joses16_exacto`;

CREATE TABLE IF NOT EXISTS exacto_bak99_c LIKE orden_servicio_c;
CREATE TABLE IF NOT EXISTS exacto_bak99_t LIKE orden_servicio_t;
CREATE TABLE IF NOT EXISTS exacto_bak99_equipos LIKE equipos_orden;
CREATE TABLE IF NOT EXISTS exacto_bak99_trabajos LIKE trabajos_orden;
CREATE TABLE IF NOT EXISTS exacto_bak99_materiales LIKE materiales_orden;
CREATE TABLE IF NOT EXISTS exacto_bak99_tecnico_log LIKE orden_servicio_tecnico_log;
CREATE TABLE IF NOT EXISTS exacto_bak99_audit_log LIKE orden_servicio_audit_log;
CREATE TABLE IF NOT EXISTS exacto_bak99_busqueda LIKE orden_servicio_nombre_busqueda;
CREATE TABLE IF NOT EXISTS exacto_bak99_edit_locks LIKE orden_servicio_edit_locks;
CREATE TABLE IF NOT EXISTS exacto_bak99_whatsapp LIKE order_whatsapp_notifications;

START TRANSACTION;

SELECT id_orden_c, folio
FROM orden_servicio_c WHERE id_orden_c = 99 FOR UPDATE;
SELECT id_trabajo
FROM orden_servicio_t WHERE id_orden_c = 99 FOR UPDATE;

INSERT IGNORE INTO exacto_bak99_c
SELECT * FROM orden_servicio_c WHERE id_orden_c = 99;
INSERT IGNORE INTO exacto_bak99_t
SELECT * FROM orden_servicio_t WHERE id_orden_c = 99;
INSERT IGNORE INTO exacto_bak99_equipos
SELECT * FROM equipos_orden WHERE id_orden_c = 99;
INSERT IGNORE INTO exacto_bak99_trabajos
SELECT d.* FROM trabajos_orden d
JOIN orden_servicio_t t ON t.id_trabajo = d.id_trabajo
WHERE t.id_orden_c = 99;
INSERT IGNORE INTO exacto_bak99_materiales
SELECT d.* FROM materiales_orden d
JOIN orden_servicio_t t ON t.id_trabajo = d.id_trabajo
WHERE t.id_orden_c = 99;
INSERT IGNORE INTO exacto_bak99_tecnico_log
SELECT * FROM orden_servicio_tecnico_log WHERE id_orden_c = 99;
INSERT IGNORE INTO exacto_bak99_audit_log
SELECT * FROM orden_servicio_audit_log WHERE id_orden_c = 99;
INSERT IGNORE INTO exacto_bak99_busqueda
SELECT * FROM orden_servicio_nombre_busqueda WHERE id_orden_c = 99;
INSERT IGNORE INTO exacto_bak99_edit_locks
SELECT * FROM orden_servicio_edit_locks WHERE id_orden_c = 99;
INSERT IGNORE INTO exacto_bak99_whatsapp
SELECT * FROM order_whatsapp_notifications WHERE id_orden_c = 99;

DELETE d FROM materiales_orden d
JOIN orden_servicio_t t ON t.id_trabajo = d.id_trabajo
WHERE t.id_orden_c = 99;
DELETE d FROM trabajos_orden d
JOIN orden_servicio_t t ON t.id_trabajo = d.id_trabajo
WHERE t.id_orden_c = 99;
DELETE FROM equipos_orden WHERE id_orden_c = 99;
DELETE FROM orden_servicio_tecnico_log WHERE id_orden_c = 99;
DELETE FROM orden_servicio_audit_log WHERE id_orden_c = 99;
DELETE FROM orden_servicio_nombre_busqueda WHERE id_orden_c = 99;
DELETE FROM orden_servicio_edit_locks WHERE id_orden_c = 99;
DELETE FROM order_whatsapp_notifications WHERE id_orden_c = 99;
DELETE FROM orden_servicio_t WHERE id_orden_c = 99;
DELETE FROM orden_servicio_c WHERE id_orden_c = 99;

COMMIT;

-- Resultado esperado: ordenes_restantes = 0.
SELECT COUNT(*) AS ordenes_restantes
FROM orden_servicio_c WHERE id_orden_c = 99;
SELECT COUNT(*) AS ordenes_respaldadas
FROM exacto_bak99_c WHERE id_orden_c = 99;
