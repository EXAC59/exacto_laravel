<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Services\EquipoEntregaResolver;
use App\Services\ExactoVaultService;
use App\Services\OrdenPolicyService;
use App\Services\PdfCondicionesService;
use App\Support\MaterialesOrdenClassifier;
use App\Support\TipoServicioCatalog;
use Dompdf\Dompdf;
use Dompdf\Options;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Gate;

class OrderPdfController extends Controller
{
    public function __construct(
        private readonly ExactoVaultService $vault,
        private readonly OrdenPolicyService $policy,
        private readonly PdfCondicionesService $pdfCondiciones,
        private readonly EquipoEntregaResolver $entregaResolver
    ) {}

    private function normalizeTipoServicio(string $value): string
    {
        $trimmed = trim($value);
        if ($trimmed === '') {
            return '';
        }

        foreach (TipoServicioCatalog::values() as $canonical) {
            if (strcasecmp($trimmed, $canonical) === 0) {
                return $canonical;
            }
        }

        $ascii = mb_strtolower($trimmed, 'UTF-8');
        $ascii = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $ascii) ?: $ascii;
        $ascii = preg_replace('/[^a-z0-9 ]+/', '', $ascii) ?? $ascii;

        $map = [
            'mantenimiento' => '1. Mantenimiento',
            'reparacion' => '2. Reparación',
            'reparaci' => '2. Reparación',
            'instalacion' => '3. Instalación',
            'instalaci' => '3. Instalación',
            'garantia' => '4. Garantía',
            'garant' => '4. Garantía',
            'revision' => '5. Revisión',
            'revisi' => '5. Revisión',
        ];

        foreach ($map as $fragment => $label) {
            if (str_contains($ascii, $fragment)) {
                return $label;
            }
        }

        if (preg_match('/reparaci[oóÃƒÂ³n]+/iu', $trimmed)) {
            return '2. Reparación';
        }
        if (preg_match('/instalaci[oóÃƒÂ³n]+/iu', $trimmed)) {
            return '3. Instalación';
        }
        if (preg_match('/garant[iíÃƒÂ­a]+/iu', $trimmed)) {
            return '4. Garantía';
        }
        if (preg_match('/revisi[oóÃƒÂ³n]+/iu', $trimmed)) {
            return '5. Revisión';
        }

        return $trimmed;
    }

    private function short(string $v, int $max = 90, string $empty = '-'): string
    {
        $t = trim($v);
        if ($t === '') {
            return e($empty);
        }
        if (mb_strlen($t, 'UTF-8') > $max) {
            $t = mb_substr($t, 0, $max - 1, 'UTF-8').'...';
        }

        return e($t);
    }

    private function equipoTerceroFirmaLine(?object $equipo, string $receptorTipo): string
    {
        if ($equipo === null || mb_strtolower(trim($receptorTipo), 'UTF-8') !== 'tercero') {
            return '';
        }

        $marca = trim((string) ($equipo->marca ?? ''));
        $modelo = trim((string) ($equipo->modelo ?? ''));
        $partes = array_values(array_filter([$marca, $modelo], static fn (string $parte): bool => $parte !== ''));
        $equipoTexto = $partes !== [] ? implode(' ', $partes) : '-';

        return '<div class="sig-equipo">SE ENTREGÓ EL: '.$this->short(
            mb_strtoupper($equipoTexto, 'UTF-8'),
            70
        ).'</div>';
    }

    private function receptorEsTercero(string $tipo, string $receptor, string $titular): bool
    {
        $tipoNormalizado = mb_strtolower(trim($tipo), 'UTF-8');
        if ($tipoNormalizado !== '') {
            return $tipoNormalizado === 'tercero';
        }

        $normalizarNombre = static fn (string $nombre): string => mb_strtolower(
            trim((string) preg_replace('/\s+/u', ' ', $nombre)),
            'UTF-8'
        );
        $titularNormalizado = $normalizarNombre($titular);
        $receptorNormalizado = $normalizarNombre($receptor);

        return $titularNormalizado !== ''
            && $receptorNormalizado !== ''
            && $titularNormalizado !== $receptorNormalizado;
    }

    /**
     * Desglose de trabajos: los precios SERSOP ya incluyen IVA, así que se separa
     * la base (sin IVA) y el IVA incluido para combinarlo con materiales.
     *
     * @return array{base: float, iva: float}
     */
    private function desgloseTrabajosSinIva(float $brutoTrabajos): array
    {
        if ($brutoTrabajos <= 0) {
            return ['base' => 0.0, 'iva' => 0.0];
        }
        $base = round($brutoTrabajos / 1.16, 2);
        $iva = round($brutoTrabajos - $base, 2);

        return ['base' => $base, 'iva' => $iva];
    }

    private function sealPathToAbsolute(?string $path): ?string
    {
        $path = trim((string) $path);
        if ($path === '') {
            return null;
        }
        $norm = str_replace('\\', '/', $path);
        if (preg_match('#^https?://[^/]+(/.*)$#i', $norm, $m)) {
            $norm = $m[1];
        }
        $norm = ltrim($norm, '/');

        $idx = mb_stripos($norm, 'legacy/public/img/firmas/');
        if ($idx !== false) {
            $tail = substr($norm, $idx);
            $abs = public_path(str_replace('/', DIRECTORY_SEPARATOR, $tail));

            return $this->existingSignatureFile($abs);
        }
        $idx = mb_stripos($norm, 'img/firmas/');
        if ($idx !== false) {
            $tail = 'legacy/public'.substr($norm, $idx);
            $abs = public_path(str_replace('/', DIRECTORY_SEPARATOR, $tail));

            return $this->existingSignatureFile($abs);
        }
        $candidate = public_path(str_replace('/', DIRECTORY_SEPARATOR, ltrim($norm, '/')));
        $found = $this->existingSignatureFile($candidate);
        if ($found !== null) {
            return $found;
        }

        // Solo nombre de archivo (p. ej. firma_cliente_inicial_FOLIO_123.png)
        if (! str_contains($norm, '/')) {
            return $this->existingSignatureFile(
                public_path('legacy/public/img/firmas'.DIRECTORY_SEPARATOR.$norm)
            );
        }

        return null;
    }

    private function existingSignatureFile(string $absolutePath): ?string
    {
        $real = realpath($absolutePath);
        if ($real !== false && is_file($real)) {
            return $real;
        }

        return is_file($absolutePath) ? $absolutePath : null;
    }

    private function firmaPathCandidates(?string $storedDb): array
    {
        if ($storedDb === null) {
            return [];
        }
        $raw = trim((string) $storedDb);
        if ($raw === '') {
            return [];
        }
        $out = [];
        $revealed = trim($this->vault->firmaRutaReveal($raw));
        if ($revealed !== '' && ! in_array($revealed, $out, true)) {
            $out[] = $revealed;
        }
        if (! $this->vault->isSealed($raw) && ! in_array($raw, $out, true)) {
            $out[] = $raw;
        }

        return $out;
    }

    private function resolveFirmaAbsolutePath(?string $storedDb): ?string
    {
        foreach ($this->firmaPathCandidates($storedDb) as $cand) {
            if (str_starts_with($cand, 'data:image')) {
                continue;
            }
            $abs = $this->sealPathToAbsolute($cand);
            if ($abs !== null) {
                return $abs;
            }
        }

        return null;
    }

    private function signatureImageSrcForPdf(?string $storedDb): string
    {
        foreach ($this->firmaPathCandidates($storedDb) as $cand) {
            if (str_starts_with($cand, 'data:image')) {
                return $cand;
            }
        }
        $abs = $this->resolveFirmaAbsolutePath($storedDb);
        if ($abs === null || ! is_readable($abs)) {
            return '';
        }

        $binary = @file_get_contents($abs);
        if ($binary === false || $binary === '') {
            return '';
        }

        // Dompdf no resuelve bien rutas relativas en cola/correo; base64 es fiable.
        $mime = File::mimeType($abs) ?: 'image/png';

        return 'data:'.$mime.';base64,'.base64_encode($binary);
    }

    /**
     * Genera el PDF de la orden sin requerir sesión (correos en cola, jobs).
     */
    public function renderOrderPdfBinary(int $id, bool $refreshCache = true, ?int $equipoIndice = null): string
    {
        if ($id <= 0) {
            throw new \InvalidArgumentException('ID de orden inválido para PDF.');
        }

        if (class_exists(\App\Support\EquiposOrdenEntregaSchema::class)) {
            \App\Support\EquiposOrdenEntregaSchema::ensure();
        }

        $orden = DB::selectOne(
            'SELECT c.*, t.subtotal_t, t.subtotal_m, t.iva, t.total_pagar, t.tecnico_recibido AS tecnico_recibido_t, t.entregado_por_tecnico, t.recibido_cliente, t.firma_c_r, t.firma_t_e, t.comentarios_m
            FROM orden_servicio_c c
            LEFT JOIN orden_servicio_t t ON t.id_trabajo = (
                SELECT MIN(t2.id_trabajo) FROM orden_servicio_t t2 WHERE t2.id_orden_c = c.id_orden_c
            )
            WHERE c.id_orden_c = ?',
            [$id]
        );
        if (! $orden) {
            throw new \RuntimeException('Orden no encontrada para PDF.');
        }
        $o = (array) $orden;
        $o['telefono'] = $this->vault->telefonoReveal($o['telefono'] ?? null);
        $o['direccion'] = $this->vault->direccionReveal($o['direccion'] ?? null);
        $o['correo'] = $this->vault->correoReveal($o['correo'] ?? null);
        $o['poblacion'] = $this->vault->poblacionReveal($o['poblacion'] ?? null);
        $o['nombre_cliente'] = $this->vault->nombreClienteReveal($o['nombre_cliente'] ?? null);
        $o['cliente_recibido'] = $this->vault->nombreClienteReveal($o['cliente_recibido'] ?? null);
        $o['recibido_cliente'] = $this->vault->nombreClienteReveal($o['recibido_cliente'] ?? null);
        $o['tecnico_recibido'] = $this->vault->tecnicoNombreReveal($o['tecnico_recibido'] ?? null);
        $o['tecnico_recibido_t'] = $this->vault->tecnicoNombreReveal($o['tecnico_recibido_t'] ?? null);
        $o['entregado_por_tecnico'] = $this->vault->tecnicoNombreReveal($o['entregado_por_tecnico'] ?? null);

        $equipos = DB::select('SELECT * FROM equipos_orden WHERE id_orden_c = ? ORDER BY id_equipo ASC', [$id]);
        $totalEquiposOrden = count($equipos);
        $filtraEquipo = $equipoIndice !== null && $equipoIndice >= 1;
        $entregasResueltas = $this->entregaResolver->resolveAll($id, $equipos, $o);
        $entregaEquipo = $filtraEquipo ? ($entregasResueltas[$equipoIndice] ?? null) : null;
        $idEquipoDbSeleccionado = 0;
        if ($filtraEquipo) {
            $equipos = array_values(array_filter(
                $equipos,
                static fn ($eq, $idx): bool => ($idx + 1) === $equipoIndice,
                ARRAY_FILTER_USE_BOTH
            ));
            if ($equipos === []) {
                throw new \RuntimeException('Equipo no encontrado para PDF parcial.');
            }
            $idEquipoDbSeleccionado = (int) ($equipos[0]->id_equipo ?? 0);
            // PDF de entrega parcial: mostrar Entregado en encabezado.
            $o['estatus'] = 'Entregado';
        }
        $idTrabajo = DB::scalar('SELECT MIN(id_trabajo) FROM orden_servicio_t WHERE id_orden_c = ?', [$id]);
        $trabajos = $idTrabajo
            ? DB::select(
                'SELECT id_trabajo_detalle, clave, descripcion, importe, ticket, id_equipo FROM trabajos_orden WHERE id_trabajo = ? ORDER BY id_trabajo_detalle ASC',
                [$idTrabajo]
            )
            : [];
        $materialesRaw = $idTrabajo ? DB::select('SELECT vale, codigo, descripcion, cantidad, precio_unitario, importe, anticipo, ticket, id_equipo FROM materiales_orden WHERE id_trabajo = ? ORDER BY id_material ASC', [$idTrabajo]) : [];
        if ($filtraEquipo) {
            $matchEquipo = static function (int $idEq) use ($equipoIndice, $idEquipoDbSeleccionado, $totalEquiposOrden): bool {
                if ($idEq === (int) $equipoIndice) {
                    return true;
                }
                if ($idEquipoDbSeleccionado > 0 && $idEq === $idEquipoDbSeleccionado) {
                    return true;
                }

                return $idEq <= 0 && $totalEquiposOrden <= 1;
            };
            $trabajos = array_values(array_filter(
                $trabajos,
                static function ($tr) use ($matchEquipo): bool {
                    return $matchEquipo((int) ($tr->id_equipo ?? 0));
                }
            ));
            $materialesRaw = array_values(array_filter(
                $materialesRaw,
                static function ($m) use ($matchEquipo): bool {
                    $tipo = MaterialesOrdenClassifier::classify((array) $m);
                    if ($tipo === 'abono') {
                        return false;
                    }

                    return $matchEquipo((int) ($m->id_equipo ?? 0));
                }
            ));
        }
        $materiales = [];
        $anticipos = [];
        $abonoSaldoTotal = 0.0;
        foreach ($materialesRaw as $m) {
            $materialArr = (array) $m;
            $anticipo = (float) ($m->anticipo ?? 0);
            $tipoFila = MaterialesOrdenClassifier::classify($materialArr);
            if ($tipoFila === 'abono') {
                $abonoSaldoTotal += $anticipo;
            } elseif ($tipoFila === 'anticipo') {
                $anticipos[] = $m;
            } else {
                if ($anticipo > 0.009) {
                    $anticipos[] = $m;
                }
                $codigoMaterial = trim((string) ($m->codigo ?? ''));
                $descripcionMaterial = trim((string) ($m->descripcion ?? ''));
                $tieneMaterialReal = trim((string) ($m->vale ?? '')) !== ''
                    || (trim($codigoMaterial) !== '' && mb_strtoupper($codigoMaterial, 'UTF-8') !== 'ANTICIPO')
                    || (trim($descripcionMaterial) !== '' && mb_strtoupper($descripcionMaterial, 'UTF-8') !== 'ANTICIPO')
                    || (float) ($m->cantidad ?? 0) != 0.0
                    || (float) ($m->precio_unitario ?? 0) != 0.0
                    || (float) ($m->importe ?? 0) != 0.0;
                if ($tieneMaterialReal) {
                    $materiales[] = $m;
                }
            }
        }
        $anticipoTotal = 0.0;
        foreach ($anticipos as $m) {
            $anticipoTotal += (float) ($m->anticipo ?? 0);
        }
        $totalConIva = (float) ($o['total_pagar'] ?? 0);
        $pagosConIva = round(($anticipoTotal + $abonoSaldoTotal) * 1.16, 2);
        $saldoPagar = round($totalConIva - $pagosConIva, 2);

        // subtotal_t / subtotal_m / iva ya vienen en modelo SIN IVA (neto + IVA de ambos).
        $subtotalCombinado = round((float) ($o['subtotal_t'] ?? 0) + (float) ($o['subtotal_m'] ?? 0), 2);
        $ivaTotal = (float) ($o['iva'] ?? 0);
        if ($ivaTotal <= 0.009 && $subtotalCombinado > 0.009) {
            $ivaTotal = round($subtotalCombinado * 0.16, 2);
        }
        // PDF parcial por equipo: recalcular totales solo con líneas del equipo.
        if ($filtraEquipo) {
            $subT = 0.0;
            foreach ($trabajos as $tr) {
                $subT += (float) ($tr->importe ?? 0);
            }
            $subM = 0.0;
            foreach ($materiales as $mat) {
                $subM += (float) ($mat->importe ?? 0);
            }
            $subtotalCombinado = round($subT + $subM, 2);
            $ivaTotal = round($subtotalCombinado * 0.16, 2);
            $totalConIva = round($subtotalCombinado + $ivaTotal, 2);
            $pagosConIva = round(($anticipoTotal + $abonoSaldoTotal) * 1.16, 2);
            $saldoPagar = round(max(0, $totalConIva - $pagosConIva), 2);
        }
        $anticipoTotalConIva = round($anticipoTotal * 1.16, 2);
        $abonoSaldoConIva = round($abonoSaldoTotal * 1.16, 2);

        $firmaEntregaClienteImg = $this->signatureImageSrcForPdf($o['firma_c_e'] ?? null);
        $firmaEntregaTecnicoImg = $this->signatureImageSrcForPdf($o['firma_t_r'] ?? null);
        if ($filtraEquipo) {
            $firmaRecibidoClienteImg = '';
            $firmaRecibidoTecnicoImg = '';
        } else {
            $firmaRecibidoClienteImg = $this->signatureImageSrcForPdf($o['firma_c_r'] ?? null);
            $firmaRecibidoTecnicoImg = $this->signatureImageSrcForPdf($o['firma_t_e'] ?? null);
        }
        if ($entregaEquipo !== null) {
            $firmaClienteEquipo = $this->signatureImageSrcForPdf(
                $entregaEquipo['firma_cliente'] ?? null
            );
            $firmaTecnicoEquipo = $this->signatureImageSrcForPdf(
                $entregaEquipo['firma_tecnico'] ?? null
            );
            if ($firmaClienteEquipo !== '') {
                $firmaRecibidoClienteImg = $firmaClienteEquipo;
            }
            if ($firmaTecnicoEquipo !== '') {
                $firmaRecibidoTecnicoImg = $firmaTecnicoEquipo;
            }
        }

        $status = trim((string) ($o['estatus'] ?? ''));
        $statusClass = match (mb_strtolower($status, 'UTF-8')) {
            'recepción', 'recepcion' => 'status-recepcion',
            'en proceso', 'proceso' => 'status-proceso',
            'terminado' => 'status-terminado',
            'entregado' => 'status-entregado',
            default => 'status-proceso',
        };

        $fechaEntrada = ! empty($o['fecha_entrada']) ? date('d/m/Y H:i', strtotime((string) $o['fecha_entrada'])) : '-';
        $fechaTerminada = ! empty($o['fecha_terminada']) ? date('d/m/Y H:i', strtotime((string) $o['fecha_terminada'])) : '-';
        $fechaSalidaValor = $o['fecha_salida'] ?? null;
        if ($entregaEquipo !== null && ! empty($entregaEquipo['fecha_entrega'])) {
            $fechaSalidaValor = $entregaEquipo['fecha_entrega'];
        }
        $fechaSalida = ! empty($fechaSalidaValor) ? date('d/m/Y H:i', strtotime((string) $fechaSalidaValor)) : '-';
        $clienteQueEntrega = trim((string) ($o['nombre_cliente'] ?? '')) !== '' ? (string) $o['nombre_cliente'] : '-';
        $clienteQueRecibe = trim((string) ($o['recibido_cliente'] ?? ''));
        if ($clienteQueRecibe === '') {
            $clienteQueRecibe = trim((string) ($o['cliente_recibido'] ?? $o['nombre_cliente'] ?? '-'));
        }
        $receptorEquipoTipo = '';
        if ($entregaEquipo !== null) {
            $receptorEquipoTipo = (string) ($entregaEquipo['receptor_tipo'] ?? '');
            $receptorEquipoNombre = (string) ($entregaEquipo['receptor'] ?? '');
            if (trim($receptorEquipoNombre) !== '') {
                $clienteQueRecibe = trim($receptorEquipoNombre);
            }
        }

        $tecnicoAtiende = trim((string) ($o['tecnico_recibido'] ?? $o['tecnico_recibido_t'] ?? ''));
        if ($tecnicoAtiende === '') {
            $tecnicoAtiende = $this->vault->tecnicoNombreReveal((string) (DB::scalar('SELECT tecnico_recibido FROM orden_servicio_t WHERE id_orden_c = ? AND TRIM(COALESCE(tecnico_recibido, "")) <> "" ORDER BY id_trabajo ASC LIMIT 1', [$id]) ?? ''));
        }
        $tecnicoEntrega = trim((string) ($o['entregado_por_tecnico'] ?? ''));
        if ($entregaEquipo !== null) {
            $tecnicoEquipo = (string) ($entregaEquipo['tecnico'] ?? '');
            if (trim($tecnicoEquipo) !== '') {
                $tecnicoEntrega = trim($tecnicoEquipo);
            }
        }
        if ($tecnicoEntrega === '') {
            $tecnicoEntrega = $this->vault->tecnicoNombreReveal((string) (DB::scalar('SELECT entregado_por_tecnico FROM orden_servicio_t WHERE id_orden_c = ? AND TRIM(COALESCE(entregado_por_tecnico, "")) <> "" ORDER BY id_trabajo DESC LIMIT 1', [$id]) ?? ''));
        }

        $esEntregado = mb_strtolower($status, 'UTF-8') === 'entregado';
        $motivoSalidaTemp = trim((string) ($o['motivo_salida_temporal'] ?? ''));
        $salidaTempActiva = (int) ($o['salida_temporal_activa'] ?? 0) === 1;
        // Solo entrega real: estatus Entregado o firmas de entrega capturadas.
        // Nunca inventar cajas vacías, ni mostrarlas si hay salida temporal activa (aún no es entrega).
        $mostrarFirmasEntrega = ($esEntregado
            || $firmaRecibidoClienteImg !== ''
            || $firmaRecibidoTecnicoImg !== '')
            && ! ($salidaTempActiva && ! $esEntregado);
        $tecnicoEntregaPdf = ($esEntregado || $tecnicoEntrega !== '') ? $tecnicoEntrega : '-';

        $firmaBoxHtml = static function (string $imgSrc): string {
            return '<div class="sig-box">'
                .($imgSrc !== '' ? '<img src="'.htmlspecialchars($imgSrc, ENT_QUOTES | ENT_HTML5, 'UTF-8').'" alt="">' : '&nbsp;')
                .'</div>';
        };

        // Orden fijo del pie del PDF (NO cambiar sin bump de cache):
        // TOTALES → CONDICIONES → FIRMAS RECEPCIÓN → FIRMAS ENTREGA (solo si aplica) → SALIDA TEMPORAL (siempre último).
        $firmasRecepcionBlock = '<h2>Firmas de recepción del equipo</h2><div class="sig-outer"><table class="signature-grid"><tr><td>'
            .$firmaBoxHtml($firmaEntregaClienteImg)
            .'<div class="sig-label">Firma del cliente que entrega: '.$this->short($clienteQueEntrega, 34).'</div></td><td>'
            .$firmaBoxHtml($firmaEntregaTecnicoImg)
            .'<div class="sig-label">Firma del técnico que recibe: '.$this->short($tecnicoAtiende, 34).'</div></td></tr></table></div>';

        $firmasEntregaBlock = '';
        if ($mostrarFirmasEntrega) {
            $equipoTerceroLine = $this->equipoTerceroFirmaLine(
                $filtraEquipo && isset($equipos[0]) ? $equipos[0] : null,
                $receptorEquipoTipo
            );
            $firmasEntregaBlock = '<h2>Firmas de entrega del equipo</h2><div class="sig-outer"><table class="signature-grid'
                .($equipoTerceroLine !== '' ? ' signature-grid-eq' : '')
                .'"><tr><td>'
                .$firmaBoxHtml($firmaRecibidoClienteImg)
                .'<div class="sig-label">Firma del cliente que recibe: '.$this->short($clienteQueRecibe, 34).'</div>'
                .$equipoTerceroLine
                .'</td><td>'
                .$firmaBoxHtml($firmaRecibidoTecnicoImg)
                .'<div class="sig-label">Firma del técnico que entrega: '.$this->short($tecnicoEntregaPdf, 34).'</div>'
                .'</td></tr></table></div>';
        }

        $salidaTemporalBlock = '';
        if ($motivoSalidaTemp !== '') {
            $firmaSalidaClienteImg = $this->signatureImageSrcForPdf($o['firma_c_salida_temp'] ?? null);
            $firmaSalidaTecnicoImg = $this->signatureImageSrcForPdf($o['firma_t_salida_temp'] ?? null);
            $fechaSalidaTempFmt = ! empty($o['fecha_salida_temporal'])
                ? date('d/m/Y H:i', strtotime((string) $o['fecha_salida_temporal']))
                : '-';
            $fechaRegresoTempFmt = ! empty($o['fecha_regreso_temporal'])
                ? date('d/m/Y H:i', strtotime((string) $o['fecha_regreso_temporal']))
                : '';
            $estadoSalidaLabel = $salidaTempActiva ? 'Activa (equipo fuera del taller)' : 'Equipo regresó al taller';
            $metaSalidaHtml = '<strong>Fecha de salida:</strong> '
                .htmlspecialchars($fechaSalidaTempFmt, ENT_QUOTES | ENT_HTML5, 'UTF-8');
            if (! $salidaTempActiva && $fechaRegresoTempFmt !== '') {
                $metaSalidaHtml .= ' &nbsp;|&nbsp; <strong>Fecha de regreso:</strong> '
                    .htmlspecialchars($fechaRegresoTempFmt, ENT_QUOTES | ENT_HTML5, 'UTF-8');
            }
            $metaSalidaHtml .= ' &nbsp;|&nbsp; <strong>Estado:</strong> '
                .htmlspecialchars($estadoSalidaLabel, ENT_QUOTES | ENT_HTML5, 'UTF-8');
            // Mismo tamaño que firmas de recepción; cajas separadas (no pegadas al panel ni entre sí).
            $salidaTemporalBlock = '<div style="clear:both;width:100%;margin-top:8px;page-break-before:avoid;">'
                .'<h2 style="margin-bottom:3px;">Salida temporal del equipo</h2>'
                .'<div style="width:100%;border:1px solid #c2410c;background:#fff7ed;padding:5px 8px;box-sizing:border-box;text-align:left;margin:0 0 8px;">'
                .'<div style="font-size:7.4px;color:#9a3412;margin:0 0 3px;line-height:1.15;">'
                .$metaSalidaHtml
                .'</div>'
                .'<div style="font-size:7.6px;font-weight:700;color:#7c2d12;margin:0 0 2px;">Motivo de salida temporal</div>'
                .'<div style="font-size:7.6px;line-height:1.2;color:#1c1917;white-space:pre-wrap;">'
                .nl2br(e($motivoSalidaTemp))
                .'</div></div>'
                .'<table width="100%" style="width:100%;border-collapse:collapse;table-layout:fixed;margin:2px 0 0;">'
                .'<tr>'
                .'<td width="46%" style="border:1px solid #999;padding:3px;vertical-align:top;width:46%;height:58px;text-align:center;box-sizing:border-box;">'
                .$firmaBoxHtml($firmaSalidaClienteImg)
                .'<div class="sig-label">Firma del cliente (salida temporal)</div>'
                .'</td>'
                .'<td width="8%" style="border:none !important;width:8%;padding:0;margin:0;background:#fff;font-size:8px;line-height:58px;">&nbsp;&nbsp;</td>'
                .'<td width="46%" style="border:1px solid #999;padding:3px;vertical-align:top;width:46%;height:58px;text-align:center;box-sizing:border-box;">'
                .$firmaBoxHtml($firmaSalidaTecnicoImg)
                .'<div class="sig-label">Firma del técnico (salida temporal)</div>'
                .'</td></tr></table>'
                .'</div>';
        }

        $logoPath = public_path('legacy/public/img/logo.jpeg');
        $logoData = '';
        if (File::exists($logoPath)) {
            $logoData = 'data:image/jpeg;base64,'.base64_encode((string) File::get($logoPath));
        }

        $obs = trim((string) ($o['observaciones'] ?? ''));
        $obsHtml = $obs !== '' ? nl2br(e($obs)) : '-';
        $comentariosTecnico = trim((string) ($o['comentarios_m'] ?? ''));
        $comentariosTecnicoHtml = $comentariosTecnico !== '' ? nl2br(e($comentariosTecnico)) : '-';
        $rowsEquipos = '';
        foreach ($equipos as $eq) {
            $tipoServicio = $this->normalizeTipoServicio((string) ($eq->tipo_servicio ?? ''));
            $rowsEquipos .= '<tr><td>'.$this->short((string) ($eq->marca ?? ''), 20, '').'</td><td>'.$this->short((string) ($eq->modelo ?? ''), 20, '').'</td><td>'.$this->short((string) ($eq->serie ?? ''), 20, '').'</td><td>'.$this->short($tipoServicio, 25, 'Sin especificar').'</td><td>'.$this->short((string) ($eq->descripcion_falla ?? ''), 55, '').'</td></tr>';
        }
        if ($rowsEquipos === '') {
            $rowsEquipos = '<tr><td colspan="5">No hay equipos registrados</td></tr>';
        }
        $rowsTrab = '';
        foreach ($trabajos as $idx => $tr) {
            $rowsTrab .= '<tr><td class="td-num">'.($idx + 1).'</td><td>'.$this->short((string) ($tr->clave ?? ''), 20, '-').'</td><td>'.$this->short((string) ($tr->descripcion ?? ''), 62, '').'</td><td class="td-num">$'.number_format((float) ($tr->importe ?? 0), 2).'</td><td>'.$this->short((string) ($tr->ticket ?? ''), 24, '-').'</td></tr>';
        }
        if ($rowsTrab === '') {
            $rowsTrab = '<tr><td colspan="5">No hay trabajos registrados</td></tr>';
        }
        $rowsMat = '';
        foreach ($materiales as $mat) {
            $vale = trim((string) ($mat->vale ?? '')) !== '' ? (string) $mat->vale : (string) ($mat->codigo ?? '');
            $rowsMat .= '<tr><td>'.$this->short($vale, 18, '-').'</td><td>'.$this->short((string) ($mat->descripcion ?? ''), 45, '').'</td><td class="td-num">'.number_format((float) ($mat->cantidad ?? 0), 0).'</td><td class="td-num">$'.number_format((float) ($mat->precio_unitario ?? 0), 2).'</td><td class="td-num">$'.number_format((float) ($mat->importe ?? 0), 2).'</td><td>'.$this->short((string) ($mat->ticket ?? ''), 24, '-').'</td></tr>';
        }
        if ($rowsMat === '') {
            $rowsMat = '<tr><td colspan="6">No hay materiales registrados</td></tr>';
        }
        $rowsAnticipos = '';
        foreach ($anticipos as $idx => $anticipo) {
            $payload = MaterialesOrdenClassifier::toAnticipoPayload((array) $anticipo);
            $rowsAnticipos .= '<tr>'
                .'<td class="td-num">'.($idx + 1).'</td>'
                .'<td>'.$this->short($payload['folio'], 24, '-').'</td>'
                .'<td>'.$this->short($payload['descripcion'], 40, '-').'</td>'
                .'<td class="td-num">$'.number_format($payload['monto'], 2).'</td>'
                .'<td>'.$this->short($payload['ticket'], 24, '-').'</td>'
                .'</tr>';
        }

        $condicionesHtml = $this->pdfCondiciones->toPdfPanelHtml();

        $html = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><style>
@page { size: letter portrait; margin: 5mm 5mm; }
body{font-family:Arial,Helvetica,sans-serif;font-size:8.1px;line-height:1.06;text-transform:uppercase;text-align:center;margin:0;padding:0;}
.header-table{width:100%;border-collapse:collapse;margin:0 0 3px;table-layout:fixed}.header-table td{vertical-align:top;padding:0 4px 0 0}
.header-col-logo{width:22%}.header-col-title{width:28%}.header-col-client{width:50%}
.logo img{max-width:96px;height:auto;display:block;margin:0 auto} h1{margin:0 0 1px;font-size:13px;line-height:1.08} h2{font-size:10.5px;margin:5px 0 3px}
.info,.section{width:100%;margin:0 0 2px;border-collapse:collapse;table-layout:fixed}.info td,.section th,.section td{border:1px solid #999;padding:1.7px 3.5px;vertical-align:middle}
.info td,.section th,.section td{text-align:center}
.section-text-left td{text-align:left!important;vertical-align:top}
.section th{background:#e6eef7;font-size:7.8px}.td-num{text-align:center!important;white-space:nowrap}.status{display:inline-block;padding:0 3px;border-radius:2px;color:#fff;font-weight:bold;font-size:7.8px}
.status-recepcion{background:#dc2626}.status-proceso{background:#ea580c}.status-terminado{background:#eab308;color:#000}.status-entregado{background:#16a34a}
.saldo-row td{background:#dc2626;color:#fff;font-weight:bold}
.totales-sep td{padding:0;border-left:none;border-right:none;border-top:3px solid #111;border-bottom:3px solid #111;background:#111;height:5px;line-height:0;font-size:0;}
.totales-sep td + td{border-left:none;}
.cond-panel{border-left:4px solid #1e3a8a;background:#dbeafe;padding:5px 8px 5px 10px;margin:6px 0 0;width:100%;max-width:100%;box-sizing:border-box;text-align:left;text-transform:uppercase}
.cond-panel-head{color:#1e3a8a;font-weight:bold;font-size:7.6px;margin:0 0 4px;line-height:1.1;text-align:left}
.cond-panel-icon{display:inline-block;width:9px;height:9px;line-height:9px;border-radius:50%;background:#1d4ed8;color:#fff;font-size:6px;font-weight:bold;text-align:center;font-style:normal;margin:0 4px 0 0;vertical-align:middle}
.cond-panel-body{color:#1e40af;font-style:italic;font-size:5.9px;line-height:1.12;margin:0;padding:0}
.cond-par{margin:0 0 2px;padding:0}
.cond-par:last-child{margin-bottom:0}
.sig-outer{width:100%;max-width:100%;margin:4px 0;text-align:center}
.signature-grid{width:100%;border-collapse:collapse;table-layout:fixed;margin:0 auto}
.signature-grid td{border:1px solid #999;padding:3px;vertical-align:top;width:50%;height:58px;text-align:center;box-sizing:border-box}
.signature-grid-eq td{height:78px}
.sig-label{height:14px;margin:2px 0 0;font-size:6.4px;line-height:1.05;overflow:hidden;text-align:center}
.sig-equipo{margin:3px 2px 0;padding:3px 2px;border:1px solid #1e3a8a;background:#eff6ff;font-size:8px;line-height:1.2;text-align:center;font-weight:bold;color:#1e3a8a}
.sig-box{border:1px solid #333;height:38px;line-height:38px;padding:0;background:#fff;margin:0 auto;width:100%;max-width:100%;text-align:center;box-sizing:border-box;overflow:hidden}
.sig-box img{display:inline-block;margin:0 auto;max-height:34px;max-width:95%;width:auto;height:auto;vertical-align:middle;object-fit:contain}
</style></head><body><table class="header-table"><tr><td class="header-col-logo"><div class="logo">'.($logoData !== '' ? '<img src="'.$logoData.'" alt="Logo">' : '&nbsp;').'</div></td><td class="header-col-title"><h1>Orden de Servicio</h1><div><strong>Folio:</strong> '.e((string) ($o['folio'] ?? '')).'</div></td><td class="header-col-client"><div><strong>Cliente:</strong> '.$this->short((string) ($o['nombre_cliente'] ?? ''), 80).'</div><div><strong>Atención (recepción):</strong> '.$this->short($tecnicoAtiende, 55).'</div><div><strong>Entrega al cliente:</strong> '.$this->short($tecnicoEntregaPdf, 55).'</div></td></tr></table>
<table class="info"><tr><td colspan="2"><strong>Dirección:</strong> '.$this->short((string) ($o['direccion'] ?? ''), 150).'</td></tr><tr><td><strong>Teléfono:</strong> '.$this->short((string) ($o['telefono'] ?? ''), 30).'</td><td><strong>Correo:</strong> '.$this->short((string) ($o['correo'] ?? ''), 70).'</td></tr><tr><td><strong>Población:</strong> '.$this->short((string) ($o['poblacion'] ?? ''), 50).'</td><td><strong>Estatus:</strong> <span class="status '.$statusClass.'">'.e($status !== '' ? $status : '-').'</span></td></tr><tr><td><strong>Fecha entrada:</strong> '.e($fechaEntrada).'</td><td><strong>Fecha terminado:</strong> '.e($fechaTerminada).' | <strong>Fecha entrega:</strong> '.e($fechaSalida).'</td></tr></table>
<h2>EQUIPOS</h2><table class="section"><thead><tr><th>MARCA</th><th>MODELO</th><th>SERIE</th><th>TIPO DE SERVICIO</th><th>DESCRIPCION</th></tr></thead><tbody>'.$rowsEquipos.'</tbody></table>
<h2>Observaciones</h2><table class="section section-text-left"><tbody><tr><td>'.$obsHtml.'</td></tr></tbody></table>
<h2>Comentarios técnicos</h2><table class="section section-text-left"><tbody><tr><td>'.$comentariosTecnicoHtml.'</td></tr></tbody></table>
<h2>TRABAJOS</h2><table class="section"><thead><tr><th>ID</th><th>CLAVE</th><th>DESCRIPCION</th><th>PRECIO SIN IVA</th><th>TICKET O FACTURA</th></tr></thead><tbody>'.$rowsTrab.'</tbody></table>
<h2>MATERIALES</h2><table class="section"><thead><tr><th>VALE NO.</th><th>DESCRIPCION</th><th>CANTIDAD</th><th>PRECIO SIN IVA</th><th>IMPORTE</th><th>TICKET O FACTURA</th></tr></thead><tbody>'.$rowsMat.'</tbody></table>
'.($rowsAnticipos !== '' ? '<h2>ANTICIPOS</h2><table class="section"><thead><tr><th>ID</th><th>FOLIO</th><th>DESCRIPCION</th><th>MONTO SIN IVA</th><th>TICKET/FACTURA</th></tr></thead><tbody>'.$rowsAnticipos.'</tbody></table>' : '').'
<h2>TOTALES</h2><table class="section"><tbody>
<tr><td><strong>ANTICIPO</strong></td><td class="td-num">$'.number_format($anticipoTotalConIva, 2).'</td></tr>
<tr><td><strong>SALDO LIQUIDADO</strong></td><td class="td-num">$'.number_format($abonoSaldoConIva, 2).'</td></tr>
<tr class="saldo-row"><td><strong>SALDO PENDIENTE</strong></td><td class="td-num"><strong>$'.number_format($saldoPagar, 2).'</strong></td></tr>
<tr class="totales-sep"><td colspan="2">&nbsp;</td></tr>
<tr><td><strong>SUBTOTAL DE TRABAJOS Y MATERIALES</strong></td><td class="td-num">$'.number_format($subtotalCombinado, 2).'</td></tr>
<tr><td><strong>IVA (16%)</strong></td><td class="td-num">$'.number_format($ivaTotal, 2).'</td></tr>
<tr><td><strong>TOTAL</strong></td><td class="td-num">$'.number_format($totalConIva, 2).'</td></tr>
</tbody></table>
'.$condicionesHtml
.'<!--PDF_BLOQUE_RECEPCION-->'.$firmasRecepcionBlock
.($firmasEntregaBlock !== '' ? '<!--PDF_BLOQUE_ENTREGA-->'.$firmasEntregaBlock : '')
.($salidaTemporalBlock !== '' ? '<!--PDF_BLOQUE_SALIDA_TEMPORAL-->'.$salidaTemporalBlock : '')
.'</body></html>';

        $options = new Options;
        $options->set('isHtml5ParserEnabled', true);
        $options->set('isRemoteEnabled', true);
        $options->set('chroot', public_path());

        $cacheDir = storage_path('app/pdf_cache');
        if (! File::isDirectory($cacheDir)) {
            File::makeDirectory($cacheDir, 0755, true);
        }
        // Bump este prefijo al cambiar layout del PDF para invalidar cache en disco.
        $eqSuffix = $filtraEquipo ? ('|eq'.$equipoIndice) : '';
        $cacheKey = hash('sha256', 'orden_pdf_v35_entrega_resuelta|'.$id.$eqSuffix.'|'.$html);
        $cachePath = $cacheDir.'/orden_'.$id.($filtraEquipo ? '_eq'.$equipoIndice : '').'_'.$cacheKey.'.pdf';
        if (! $refreshCache && File::exists($cachePath)) {
            return (string) File::get($cachePath);
        }
        $dompdf = new Dompdf($options);
        $dompdf->loadHtml($html);
        $dompdf->setPaper('letter', 'portrait');
        $dompdf->render();
        $pdfOutput = $dompdf->output();
        foreach (File::glob($cacheDir.'/orden_'.$id.'_*.pdf') as $old) {
            if ($old !== $cachePath) {
                @unlink($old);
            }
        }
        @File::put($cachePath, $pdfOutput);

        return $pdfOutput;
    }

    public function show(Request $request, int $id): Response
    {
        abort_unless(Auth::check(), 403);
        if ($id <= 0) {
            abort(404);
        }
        Gate::authorize('order-access', $id);

        // Siempre regenerar desde BD al abrir en navegador (evita PDF viejo tras vaciar BD o editar orden).
        $equipoIndice = (int) $request->query('eq', 0);
        $pdfOutput = $this->renderOrderPdfBinary($id, true, $equipoIndice > 0 ? $equipoIndice : null);
        $folio = (string) (DB::scalar('SELECT folio FROM orden_servicio_c WHERE id_orden_c = ?', [$id]) ?? '');
        $baseName = preg_replace('/[^a-zA-Z0-9_-]/', '_', $folio !== '' ? $folio : 'orden_'.$id);
        // Nombre único por request: Firefox/Chrome cachean PDF por URL+filename.
        $bust = preg_replace('/\D+/', '', (string) $request->query('_', '')) ?: (string) time();
        $filename = $baseName.'_'.$bust.'.pdf';
        $inline = (string) $request->query('inline', '') === '1';

        $response = response($pdfOutput, 200, [
            'Content-Type' => 'application/pdf',
            'Content-Disposition' => ($inline ? 'inline' : 'attachment').'; filename="'.$filename.'"',
            'Cache-Control' => 'private, no-store, no-cache, must-revalidate, max-age=0, post-check=0, pre-check=0',
            'Pragma' => 'no-cache',
            'Expires' => '0',
            'Last-Modified' => gmdate('D, d M Y H:i:s').' GMT',
            'X-Accel-Expires' => '0',
            'Vary' => '*',
            // Para verificar en DevTools → Network que el servidor ya tiene este PHP.
            'X-Exacto-Pdf-Ver' => 'v35-entrega-resuelta',
        ]);
        $response->headers->remove('ETag');
        $response->setPrivate();
        $response->setMaxAge(0);
        $response->headers->addCacheControlDirective('no-store');
        $response->headers->addCacheControlDirective('no-cache');
        $response->headers->addCacheControlDirective('must-revalidate');

        return $response;
    }

    /** PDF con URL firmada para que Meta Cloud API descargue el documento (WhatsApp). */
    public function showSigned(Request $request, int $id): Response
    {
        if ($id <= 0) {
            abort(404);
        }

        $equipoIndice = (int) $request->query('eq', 0);
        $pdfOutput = $this->renderOrderPdfBinary($id, false, $equipoIndice > 0 ? $equipoIndice : null);
        $folio = (string) (DB::scalar('SELECT folio FROM orden_servicio_c WHERE id_orden_c = ?', [$id]) ?? '');
        $filename = preg_replace('/[^a-zA-Z0-9_-]/', '_', $folio !== '' ? $folio : 'orden_'.$id);
        if ($equipoIndice > 0) {
            $filename .= '_eq'.$equipoIndice;
        }
        $filename .= '.pdf';

        return response($pdfOutput, 200, [
            'Content-Type' => 'application/pdf',
            'Content-Disposition' => 'inline; filename="'.$filename.'"',
            'Cache-Control' => 'private, max-age=3600',
        ]);
    }
}
