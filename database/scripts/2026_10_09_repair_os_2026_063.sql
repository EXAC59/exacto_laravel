-- Reparación limitada al caso confirmado: total $700, pago duplicado $1,400.
-- Seleccionar la BD correcta y tener respaldo completo antes de ejecutar.
-- Si cambiaron los detalles/importe, no modifica la orden. Es seguro repetirlo.
CREATE TABLE IF NOT EXISTS exacto_os_2026_063_payment_backup (
    id_material INT NOT NULL PRIMARY KEY,
    id_trabajo INT NOT NULL,
    anticipo_anterior DECIMAL(12,2) NOT NULL,
    fecha DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

START TRANSACTION;

SELECT id_orden_c FROM orden_servicio_c
WHERE folio IN ('OS-2026-063', 'OS-2026-0063') FOR UPDATE;
SELECT id_trabajo FROM orden_servicio_t WHERE id_orden_c IN (
    SELECT id_orden_c FROM orden_servicio_c WHERE folio IN ('OS-2026-063', 'OS-2026-0063')
) FOR UPDATE;

INSERT IGNORE INTO exacto_os_2026_063_payment_backup (id_material, id_trabajo, anticipo_anterior, fecha)
SELECT m.id_material, m.id_trabajo, m.anticipo, NOW()
FROM materiales_orden m
JOIN orden_servicio_t t ON t.id_trabajo = m.id_trabajo
JOIN orden_servicio_c c ON c.id_orden_c = t.id_orden_c
WHERE c.folio IN ('OS-2026-063', 'OS-2026-0063')
  AND (SELECT COUNT(*) FROM orden_servicio_c WHERE folio IN ('OS-2026-063', 'OS-2026-0063')) = 1
  AND (SELECT COUNT(*) FROM orden_servicio_t WHERE id_orden_c = c.id_orden_c) = 1
  AND ABS(t.total_pagar - 700) < 0.009 AND ABS(t.subtotal_t - 603.45) < 0.009 AND ABS(t.subtotal_m) < 0.009
  AND ABS(m.anticipo - 1206.90) < 0.009
  AND UPPER(TRIM(m.descripcion)) = 'SALDO LIQUIDADO'
  AND m.cantidad = 0 AND m.precio_unitario = 0 AND m.importe = 0
  AND (SELECT COUNT(*) FROM materiales_orden WHERE id_trabajo = t.id_trabajo) = 1
  AND (SELECT COUNT(*) FROM trabajos_orden WHERE id_trabajo = t.id_trabajo) = 1
  AND EXISTS (SELECT 1 FROM trabajos_orden j WHERE j.id_trabajo = t.id_trabajo AND UPPER(j.clave) = 'SERSOP01' AND ABS(j.importe - 603.45) < 0.009);

UPDATE materiales_orden m
JOIN exacto_os_2026_063_payment_backup b ON b.id_material = m.id_material AND b.id_trabajo = m.id_trabajo
JOIN orden_servicio_t t ON t.id_trabajo = m.id_trabajo
JOIN orden_servicio_c c ON c.id_orden_c = t.id_orden_c
JOIN (SELECT id_trabajo, COUNT(*) AS filas FROM materiales_orden GROUP BY id_trabajo) counts_m
  ON counts_m.id_trabajo = m.id_trabajo AND counts_m.filas = 1
SET m.anticipo = 603.45
WHERE c.folio IN ('OS-2026-063', 'OS-2026-0063')
  AND (SELECT COUNT(*) FROM orden_servicio_c WHERE folio IN ('OS-2026-063', 'OS-2026-0063')) = 1
  AND (SELECT COUNT(*) FROM orden_servicio_t WHERE id_orden_c = c.id_orden_c) = 1
  AND ABS(m.anticipo - 1206.90) < 0.009 AND ABS(b.anticipo_anterior - 1206.90) < 0.009
  AND ABS(t.total_pagar - 700) < 0.009 AND ABS(t.subtotal_t - 603.45) < 0.009 AND ABS(t.subtotal_m) < 0.009
  AND UPPER(TRIM(m.descripcion)) = 'SALDO LIQUIDADO'
  AND m.cantidad = 0 AND m.precio_unitario = 0 AND m.importe = 0
  AND (SELECT COUNT(*) FROM trabajos_orden WHERE id_trabajo = t.id_trabajo) = 1
  AND EXISTS (SELECT 1 FROM trabajos_orden j WHERE j.id_trabajo = t.id_trabajo AND UPPER(j.clave) = 'SERSOP01' AND ABS(j.importe - 603.45) < 0.009);

SELECT ROW_COUNT() AS abonos_corregidos;
COMMIT;

SELECT c.folio, t.total_pagar, ROUND(m.anticipo * 1.16, 2) AS pago_con_iva,
       ROUND(t.total_pagar - ROUND(m.anticipo * 1.16, 2), 2) AS saldo_pendiente
FROM orden_servicio_c c
JOIN orden_servicio_t t ON t.id_orden_c = c.id_orden_c
JOIN materiales_orden m ON m.id_trabajo = t.id_trabajo
WHERE c.folio IN ('OS-2026-063', 'OS-2026-0063');
