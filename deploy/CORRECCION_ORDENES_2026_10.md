# Corrección de pagos y guardado de órdenes

El cobro de revisión SERSOP01 incluye el cargo oculto en los totales y conserva
un solo pago al reintentar. Las órdenes nuevas utilizan una clave de envío
persistente para recuperar el resultado de un guardado cuya respuesta se perdió.
Los pagos superiores al total y los importes inválidos se rechazan antes de guardar.

## Instalación

Desplegar juntos los cambios de `app/`, `public/` y la nueva migración.
Antes de crear órdenes nuevas, instalar la tabla `order_submissions` desde la
raíz del proyecto:

```sh
php artisan migrate --path=database/migrations/2026_10_09_170000_create_order_submissions_table.php --force
```

Como alternativa, en phpMyAdmin seleccionar la base del sitio y ejecutar
`database/scripts/2026_10_09_create_order_submissions.sql`.
Ambas opciones instalan la misma tabla; basta con una.
Comprobar que contiene `submission_key`, `result` y `created_at`.
Si falta la tabla, el servidor devuelve HTTP 503 antes de crear la orden y el
formulario conserva el envío para reintentarlo después de instalarla.

## Reparación del pago de OS-2026-063 / OS-2026-0063

Vista previa sin modificar datos:

```sh
php artisan exacto:repair-review-payment
```

Aplicar la reparación con respaldo del registro:

```sh
php artisan exacto:repair-review-payment --apply
```

La reparación sólo aplica al caso confirmado: cargo total de $700 y un abono
duplicado de $1,400. Reduce el abono de 1206.90 a 603.45 sin IVA para dejar un
pago de $700 y saldo de $0. Si los detalles cambiaron, se rechaza la reparación.
El respaldo se guarda en `storage/app/private/repairs`.

La alternativa SQL es `database/scripts/2026_10_09_repair_os_2026_063.sql`,
seleccionando previamente la base del sitio. Repetir la reparación no vuelve
a descontar el pago.

## Eliminación solicitada de la orden 99

`database/scripts/2026_10_10_delete_order_99.sql` es una operación manual
exclusivamente para `joses16_exacto`, `id_orden_c = 99`.
Cerrar los formularios abiertos de esa orden antes de ejecutarlo.
Respalda sus registros en tablas `exacto_bak99_*`, elimina los detalles y la
cabecera, y muestra `ordenes_restantes = 0` al terminar.
No ejecutar este script como parte de una migración o despliegue automático.
Conserva las claves de envío y el consecutivo de folios.

## Validación

```sh
php vendor/bin/phpunit
node --test tests/js/order-save-safety.test.mjs
node --check public/legacy/assets/js/orden_servicio.js
```

Las pruebas cubren el pago de $700, reintentos después de perder la respuesta,
doble clic, reversión de una transacción fallida, rechazo de pagos excesivos,
tabla pendiente de instalación y reparación con respaldo.
