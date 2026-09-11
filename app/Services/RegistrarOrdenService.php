<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\User;
use App\Support\ExactoAuthContext;
use App\Support\OrderStatus;
use App\Support\WhatsappPhone;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Schema;
use RuntimeException;

final class RegistrarOrdenService
{
    private const ANTICIPO_DESCRIPCION = 'ANTICIPO';
    private const ABONO_SALDO_DESCRIPCION = 'SALDO LIQUIDADO';
    private const SUBMIT_LOCK_TTL_SECONDS = 45;
    /** equipos_orden.acciones: 0=pendiente, 1=terminado (interno), 2=entregado */
    private const EQUIPO_ACCION_PENDIENTE = 0;
    private const EQUIPO_ACCION_TERMINADO = 1;
    private const EQUIPO_ACCION_ENTREGADO = 2;

    public function __construct(
        private readonly ExactoVaultService $vault,
        private readonly OrdenPolicyService $policy,
        private readonly OrdenAuditService $audit,
        private readonly OrdenListService $list,
        private readonly OrderEmailService $orderEmail,
        private readonly OrderWhatsappService $orderWhatsapp,
        private readonly OrdenEditLockService $editLocks,
        private readonly FolioSequenceService $folios
    ) {}

    private function textoMayusculas(string $valor): string
    {
        return mb_strtoupper(trim($valor), 'UTF-8');
    }

    private function equiposEnMayusculas(array $equiposIn): array
    {
        $out = [];
        foreach ($equiposIn as $equipo) {
            if (! is_array($equipo)) {
                continue;
            }
            $equipo['marca'] = $this->textoMayusculas((string) ($equipo['marca'] ?? ''));
            $equipo['modelo'] = $this->textoMayusculas((string) ($equipo['modelo'] ?? ''));
            $equipo['serie'] = $this->textoMayusculas((string) ($equipo['serie'] ?? ''));
            $equipo['clave'] = $this->textoMayusculas((string) ($equipo['clave'] ?? ''));
            $equipo['descripcionFalla'] = $this->textoMayusculas((string) ($equipo['descripcionFalla'] ?? ''));
            $out[] = $equipo;
        }

        return $out;
    }

    private function nombreTecnicoOperador(User $user): string
    {
        return ExactoAuthContext::tecnicoRecepcionParaOrden($user);
    }

    private function tecnicoRecibidoLegibleDesdeBd(?string $stored): string
    {
        $raw = trim((string) $stored);
        if ($raw === '') {
            return '';
        }

        $revealed = $this->vault->tecnicoNombreReveal($raw);

        return $revealed !== '' ? $revealed : $raw;
    }

    private function registrarInvolucradoEnLog(int $idOrdenC, string $estatus, string $nombreTecnico): void
    {
        $nombre = trim($nombreTecnico);
        $estatus = trim($estatus);
        if ($nombre === '' || $idOrdenC <= 0 || $estatus === '') {
            return;
        }

        DB::insert(
            'INSERT INTO orden_servicio_tecnico_log (id_orden_c, estatus, nombre_tecnico, fecha) VALUES (?, ?, ?, ?)',
            [$idOrdenC, $estatus, $nombre, now()->format('Y-m-d H:i:s')]
        );
    }

    /**
     * Registra al técnico en involucrados solo si es distinto del último del log
     * (evita duplicar al guardar/abrir varias veces seguidas la misma persona).
     */
    public function registrarInvolucradoSiCambio(int $idOrdenC, string $estatus, string $nombreTecnico): void
    {
        $nombre = trim($nombreTecnico);
        if ($nombre === '' || $idOrdenC <= 0) {
            return;
        }
        if (! Schema::hasTable('orden_servicio_tecnico_log')) {
            return;
        }

        try {
            $ultimo = DB::scalar(
                'SELECT nombre_tecnico FROM orden_servicio_tecnico_log WHERE id_orden_c = ? ORDER BY fecha DESC LIMIT 1',
                [$idOrdenC]
            );
            if ($ultimo !== null && strcasecmp(trim((string) $ultimo), $nombre) === 0) {
                return;
            }

            $estatus = trim($estatus);
            if ($estatus === '') {
                $estatus = 'Edición';
            }

            $this->registrarInvolucradoEnLog($idOrdenC, $estatus, $nombre);
        } catch (\Throwable $e) {
            report($e);
        }
    }

    private function firmasDir(): string
    {
        return public_path('legacy/public/img/firmas');
    }

    /** Ruta relativa bajo /public para sellar y luego asset(). */
    private function firmaPublicRel(string $filename): string
    {
        return 'legacy/public/img/firmas/'.$filename;
    }

    private function ensureSchema(): void
    {
        foreach ([
            'orden_servicio_c',
            'orden_servicio_t',
            'equipos_orden',
            'trabajos_orden',
            'materiales_orden',
            'orden_servicio_tecnico_log',
            'orden_servicio_nombre_busqueda',
            'orden_folio_sequence',
            'order_whatsapp_notifications',
        ] as $table) {
            if (! Schema::hasTable($table)) {
                throw new RuntimeException('Falta la tabla '.$table.'. Ejecuta las migraciones pendientes.');
            }
        }

        foreach (['clave', 'ticket'] as $column) {
            if (! Schema::hasColumn('trabajos_orden', $column)) {
                throw new RuntimeException('Falta la columna trabajos_orden.'.$column.'. Ejecuta las migraciones pendientes.');
            }
        }

        $this->list->ensureSearchTable();
        if (class_exists(\App\Support\EquiposOrdenEntregaSchema::class)) {
            \App\Support\EquiposOrdenEntregaSchema::ensure();
        }
    }

    private function acquireSubmissionLock(string $key): bool
    {
        try {
            return Cache::add($key, 1, now()->addSeconds(self::SUBMIT_LOCK_TTL_SECONDS));
        } catch (\Throwable) {
            return true;
        }
    }

    private function releaseSubmissionLock(string $key): void
    {
        try {
            Cache::forget($key);
        } catch (\Throwable) {
            // ignore cache issues and continue with runtime behavior
        }
    }

    private function submissionLockKey(Request $request, User $user): string
    {
        $userId = trim((string) ($user->getAuthIdentifier() ?? $user->id_tecnico ?? 'guest'));
        $payload = $request->except('_token');
        $normalized = $this->normalizePayloadForLock($payload);
        $json = json_encode($normalized, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        return 'exacto:registrar-orden:submit:'.$userId.':'.sha1((string) $json);
    }

    private function normalizePayloadForLock(mixed $value): mixed
    {
        if (! is_array($value)) {
            return $value;
        }

        if (array_is_list($value)) {
            return array_map(fn (mixed $item): mixed => $this->normalizePayloadForLock($item), $value);
        }

        ksort($value);
        foreach ($value as $key => $item) {
            $value[$key] = $this->normalizePayloadForLock($item);
        }

        return $value;
    }

    /** @var list<string> */
    private const ESTATUS_NOTIFICACION_CLIENTE = ['Recepción', 'Terminado', 'Entregado'];

    /**
     * @return array{status: string, email: string, message: string}
     */
    private function probeCorreoRegistrado(string $correoPlano): array
    {
        $correoPlano = $this->normalizeCorreoPlano($correoPlano);
        if ($correoPlano === '') {
            return [
                'status' => 'missing',
                'email' => '',
                'message' => 'No se registró un correo electrónico válido para enviar la notificación.',
            ];
        }

        if (! filter_var($correoPlano, FILTER_VALIDATE_EMAIL)) {
            return [
                'status' => 'invalid',
                'email' => $correoPlano,
                'message' => 'El correo registrado no tiene un formato válido.',
            ];
        }

        return $this->orderEmail->probeRecipient($correoPlano);
    }

    /**
     * Validación rápida de correo (sin sondeo SMTP) para no bloquear el guardado de la orden.
     *
     * @return array{status: string, email: string, message: string}
     */
    private function probeCorreoFormatoLocal(string $correoPlano): array
    {
        $correoPlano = $this->normalizeCorreoPlano($correoPlano);
        if ($correoPlano === '') {
            return [
                'status' => 'missing',
                'email' => '',
                'message' => 'No se registró un correo electrónico válido para enviar la notificación.',
            ];
        }

        if (! filter_var($correoPlano, FILTER_VALIDATE_EMAIL)) {
            return [
                'status' => 'invalid',
                'email' => $correoPlano,
                'message' => 'El correo registrado no tiene un formato válido.',
            ];
        }

        return [
            'status' => 'unverifiable',
            'email' => $correoPlano,
            'message' => 'Formato válido; la entrega se confirmará al enviar el correo.',
        ];
    }

    private function normalizeCorreoPlano(string $correo): string
    {
        return mb_strtolower(trim($correo), 'UTF-8');
    }

    private function normalizeTelefonoClientePlano(string $digits): string
    {
        if ($digits === '') {
            return '';
        }

        if (class_exists('App\\Support\\WhatsappPhone', true)) {
            return WhatsappPhone::localMexicoDigits($digits);
        }

        if (preg_match('/^\d{10}$/', $digits)) {
            return $digits;
        }

        if (strlen($digits) > 10) {
            $last10 = substr($digits, -10);
            if (preg_match('/^\d{10}$/', $last10)) {
                return $last10;
            }
        }

        return $digits;
    }

    /**
     * @param  array<mixed>  $equiposIn
     * @return array{
     *     email: array{message: ?string, level: ?string},
     *     whatsapp: array{message: ?string, level: ?string}
     * }
     */
    private function dispatchStatusNotifications(
        int $idOrdenC,
        string $estatusCanon,
        string $folio,
        string $nombreClientePlano,
        string $telefono,
        string $correoPlano,
        string $poblacionPlano,
        float $totalPagar,
        array $equiposIn,
        bool $sendEmail = true,
        bool $forceWhatsapp = false,
        array $payloadExtra = []
    ): array {
        if (! in_array($estatusCanon, self::ESTATUS_NOTIFICACION_CLIENTE, true)) {
            return [
                'email' => ['message' => null, 'level' => null],
                'whatsapp' => ['message' => null, 'level' => null],
                'whatsapp_notification_id' => null,
                'whatsapp_applicable' => false,
            ];
        }
        // Entrega por equipo: Terminado es solo uso interno; Entregado notifica en rama aparte.
        if (
            $estatusCanon === 'Terminado'
            && (int) ($payloadExtra['entrega_por_equipo'] ?? 0) === 1
        ) {
            return [
                'email' => ['message' => null, 'level' => null],
                'whatsapp' => ['message' => null, 'level' => null],
                'whatsapp_notification_id' => null,
                'whatsapp_applicable' => false,
            ];
        }

        $notificationPayload = $this->buildEmailPayload(
            $folio,
            $estatusCanon,
            $nombreClientePlano,
            $telefono,
            $correoPlano,
            $poblacionPlano,
            $totalPagar,
            $equiposIn
        );
        $notificationPayload['id_orden_c'] ??= $idOrdenC;
        if ($payloadExtra !== []) {
            $notificationPayload = array_merge($notificationPayload, $payloadExtra);
        }
        $emailNotice = ['message' => null, 'level' => null];
        if ($sendEmail) {
            $emailProbe = $this->probeCorreoFormatoLocal($correoPlano);
            $emailResult = $this->orderEmail->queueForStatusWithResult(
                $idOrdenC,
                $estatusCanon,
                $emailProbe,
                $notificationPayload
            );
            $emailNotice = $this->emailNoticeData($emailResult, $emailProbe);
        }

        $waProbe = ['status' => 'skipped', 'phone' => '', 'message' => ''];
        $waResult = null;
        $waFeatureOn = config('exacto.whatsapp_notifications_enabled', false)
            && filter_var(config('services.whatsapp.enabled', false), FILTER_VALIDATE_BOOL);
        try {
            $waProbe = $this->orderWhatsapp->probePhone($telefono);
            if ($waFeatureOn) {
                $waResult = $this->orderWhatsapp->queueForStatusWithResult(
                    $idOrdenC,
                    $estatusCanon,
                    $notificationPayload,
                    true,
                    $forceWhatsapp
                );
                Log::channel('exacto_ops')->info('order_whatsapp_dispatch_on_save', [
                    'id_orden_c' => $idOrdenC,
                    'folio' => $folio,
                    'estatus' => $estatusCanon,
                    'wa_status' => $waResult['status'] ?? null,
                    'wa_sent' => $waResult['sent'] ?? false,
                    'notification_id' => $waResult['notification_id'] ?? null,
                ]);
            } else {
                Log::channel('exacto_ops')->warning('order_whatsapp_dispatch_skipped', [
                    'id_orden_c' => $idOrdenC,
                    'folio' => $folio,
                    'estatus' => $estatusCanon,
                    'exacto_flag' => config('exacto.whatsapp_notifications_enabled'),
                    'whatsapp_cloud' => config('services.whatsapp.enabled'),
                ]);
            }
        } catch (\Throwable $e) {
            Log::channel('exacto_ops')->error('order_whatsapp_dispatch_exception', [
                'id_orden_c' => $idOrdenC,
                'folio' => $folio,
                'estatus' => $estatusCanon,
                'error' => $e->getMessage(),
                'exception' => $e::class,
            ]);
            $waResult = [
                'sent' => false,
                'status' => 'failed',
                'message' => 'WhatsApp no enviado. Error al procesar: '.mb_substr($e->getMessage(), 0, 200),
                'phone' => (string) ($waProbe['phone'] ?? ''),
                'notification_id' => null,
            ];
        }

        return [
            'email' => $emailNotice,
            'whatsapp' => $this->whatsappNoticeData($waResult, $waProbe, true),
            'whatsapp_notification_id' => is_array($waResult) ? ($waResult['notification_id'] ?? null) : null,
            'whatsapp_applicable' => true,
        ];
    }

    /**
     * Reenvía la notificación de una orden ya registrada (cuando el WhatsApp/correo
     * no llegó por número/correo equivocado). Primero guarda los datos del cliente
     * editados y luego fuerza el reenvío como "Recepción" (ignora el dedup de WhatsApp).
     *
     * @return array<string, mixed>
     */
    public function reenviarRecepcion(int $idOrdenC, Request $request): array
    {
        $row = DB::table('orden_servicio_c')->where('id_orden_c', $idOrdenC)->first();
        if (! $row) {
            return ['success' => false, 'message' => 'Orden no encontrada.'];
        }

        $nombreClientePlano = $this->textoMayusculas((string) $request->input('nombreCliente', ''));
        $direccionPlano = $this->textoMayusculas((string) $request->input('direccion', ''));
        $telefono = $this->normalizeTelefonoClientePlano(
            $this->vault->normalizeDigits(trim((string) $request->input('telefono', '')))
        );
        $correoPlano = $this->normalizeCorreoPlano((string) $request->input('correo', ''));
        $poblacionPlano = $this->textoMayusculas((string) $request->input('poblacion', ''));

        // Guardar datos del cliente (sellados). Se permiten vacíos/invalidos: el envío
        // se omite avisando, no bloquea (igual que el guardado normal).
        try {
            DB::beginTransaction();
            DB::update(
                'UPDATE orden_servicio_c SET `nombre_cliente` = ?, `direccion` = ?, `telefono` = ?, `correo` = ?, `poblacion` = ? WHERE id_orden_c = ?',
                [
                    $this->vault->nombreClienteSeal($nombreClientePlano),
                    $this->vault->direccionSeal($direccionPlano),
                    $this->vault->telefonoSeal($telefono),
                    $this->vault->correoSeal($correoPlano),
                    $this->vault->poblacionSeal($poblacionPlano),
                    $idOrdenC,
                ]
            );
            $this->rebuildSearchIndex($idOrdenC, $nombreClientePlano, $telefono, $correoPlano);
            DB::commit();
        } catch (\Throwable $e) {
            DB::rollBack();

            return ['success' => false, 'message' => '❌ Error al guardar datos del cliente: '.$e->getMessage()];
        }

        // Reenviar correo forzado como Recepción (el payload se arma desde la BD ya actualizada).
        $emailProbe = $this->probeCorreoFormatoLocal($correoPlano);
        $emailResult = $this->orderEmail->queueForStatusWithResult($idOrdenC, 'Recepción', $emailProbe, null);

        // Reenviar WhatsApp forzado (ignora el dedup de "ya enviado").
        $waProbe = $this->orderWhatsapp->probePhone($telefono);
        $waResult = null;
        $waFeatureOn = config('exacto.whatsapp_notifications_enabled', false)
            && filter_var(config('services.whatsapp.enabled', false), FILTER_VALIDATE_BOOL);
        if ($waFeatureOn) {
            try {
                $waResult = $this->orderWhatsapp->queueForStatusWithResult($idOrdenC, 'Recepción', null, true, true);
            } catch (\Throwable $e) {
                Log::channel('exacto_ops')->error('order_reenviar_whatsapp_exception', [
                    'id_orden_c' => $idOrdenC,
                    'error' => $e->getMessage(),
                    'exception' => $e::class,
                ]);
                $waResult = [
                    'sent' => false,
                    'status' => 'failed',
                    'message' => 'WhatsApp no enviado. Error al procesar: '.mb_substr($e->getMessage(), 0, 200),
                    'phone' => (string) ($waProbe['phone'] ?? ''),
                    'notification_id' => null,
                ];
            }
        }

        // Diagnostico: deja claro en el log por que el WhatsApp se envio o no (duplicate,
        // failed, rejected, accepted, feature off, celular vacio/invalido, etc.).
        Log::channel('exacto_ops')->info('order_reenviar_whatsapp_result', [
            'id_orden_c' => $idOrdenC,
            'wa_feature_on' => $waFeatureOn,
            'tel_len' => strlen($telefono),
            'wa_probe_status' => $waProbe['status'] ?? null,
            'wa_status' => is_array($waResult) ? ($waResult['status'] ?? null) : null,
            'wa_sent' => is_array($waResult) ? ($waResult['sent'] ?? null) : null,
            'wa_message' => is_array($waResult) ? ($waResult['message'] ?? null) : null,
            'notification_id' => is_array($waResult) ? ($waResult['notification_id'] ?? null) : null,
        ]);

        $emailNotice = $this->emailNoticeData($emailResult, $emailProbe);
        $whatsappNotice = $this->whatsappNoticeData($waResult, $waProbe, true);

        return [
            'success' => true,
            'message' => '✅ Reenvío de la orden procesado como Recepción.',
            'email_notice' => $emailNotice['message'],
            'email_notice_level' => $emailNotice['level'],
            'whatsapp_notice' => $whatsappNotice['message'],
            'whatsapp_notice_level' => $whatsappNotice['level'],
            'whatsapp_notification_id' => is_array($waResult) ? ($waResult['notification_id'] ?? null) : null,
            'whatsapp_applicable' => true,
        ];
    }

    /**
     * @param  array{sent: bool, status: string, message: string, phone: string, notification_id: int|null}|null  $waResult
     * @param  array{status: string, phone: string, message: string}  $probe
     * @return array{message: ?string, level: ?string}
     */
    private function whatsappNoticeData(?array $waResult, array $probe, bool $applicable = false): array
    {
        if (! $applicable) {
            return ['message' => null, 'level' => null];
        }

        $featureOn = config('exacto.whatsapp_notifications_enabled', false)
            && filter_var(config('services.whatsapp.enabled', false), FILTER_VALIDATE_BOOL);

        if (! $featureOn) {
            return [
                'message' => '✖ WhatsApp no enviado. Activa EXACTO_WHATSAPP_NOTIFICATIONS=true o WHATSAPP_CLOUD_ENABLED=true en el servidor.',
                'level' => 'error',
            ];
        }

        $probeStatus = (string) ($probe['status'] ?? '');

        // Celular vacío (campo opcional): aviso suave informativo, no error.
        if ($probeStatus === 'missing') {
            return [
                'message' => 'WhatsApp no enviado: no se capturó un celular (campo opcional).',
                'level' => 'info',
            ];
        }

        // Celular capturado pero con formato inválido: error claro de "no enviado".
        if ($probeStatus === 'invalid') {
            return [
                'message' => '✖ WhatsApp no enviado: el celular no es válido. '.trim((string) ($probe['message'] ?? '')),
                'level' => 'error',
            ];
        }

        if ($waResult === null) {
            return ['message' => null, 'level' => null];
        }

        $status = trim((string) ($waResult['status'] ?? ''));
        $message = trim((string) ($waResult['message'] ?? ''));
        $phone = trim((string) ($waResult['phone'] ?? ''));

        if ($status === 'skipped') {
            if ($message !== '') {
                return ['message' => '✖ '.$message, 'level' => 'error'];
            }

            return ['message' => null, 'level' => null];
        }

        if ($status === '') {
            return ['message' => null, 'level' => null];
        }

        if ($status === 'accepted') {
            $destino = $phone !== '' ? $phone : 'WhatsApp';

            return [
                'message' => 'Plantilla enviada a '.$destino.' con PDF de la orden. Meta aceptó el mensaje.',
                'level' => 'success',
            ];
        }

        if ($status === 'queued') {
            return [
                'message' => 'Programado: se enviará en unos segundos a '.($phone !== '' ? $phone : 'WhatsApp').' (con PDF).',
                'level' => 'success',
            ];
        }

        if ($status === 'duplicate') {
            return [
                'message' => 'WhatsApp ya enviado para este estatus.',
                'level' => 'info',
            ];
        }

        if (in_array($status, ['failed', 'rejected'], true)) {
            return [
                'message' => '✖ '.($message !== '' ? $message : 'WhatsApp no enviado. El número no es válido o Meta rechazó el envío.'),
                'level' => 'error',
            ];
        }

        return [
            'message' => '✖ '.($message !== '' ? $message : 'WhatsApp no enviado.'),
            'level' => 'error',
        ];
    }

    /**
     * @param  array{sent: bool, status: string, message: string, email: string, probe: array{status: string, email: string, message: string}|null}|null  $emailResult
     * @param  array{status: string, email: string, message: string}  $probeResult
     * @return array{message: ?string, level: ?string}
     */
    private function emailNoticeData(?array $emailResult, array $probeResult): array
    {
        $probeStatus = trim((string) ($probeResult['status'] ?? ''));

        if ($probeStatus === 'missing') {
            return [
                'message' => 'Correo no enviado (opcional): no se registró correo electrónico.',
                'level' => 'info',
            ];
        }

        $status = trim((string) ($emailResult['status'] ?? ''));
        $message = trim((string) ($emailResult['message'] ?? ''));

        if ($message === '' && $probeStatus === 'invalid') {
            $status = 'rejected';
            $message = 'Correo no enviado. '.trim((string) ($probeResult['message'] ?? ''));
        }

        if ($message === '' && ($probeResult['status'] ?? '') === 'rejected') {
            $status = 'rejected';
            $message = 'Correo no enviado. El servidor destino rechazó la dirección de correo.';
        }

        if ($message === '' || $status === 'skipped') {
            return ['message' => null, 'level' => null];
        }

        if ($status === 'confirmed') {
            return ['message' => 'Confirmado: '.$message, 'level' => 'confirmed'];
        }

        if ($status === 'queued_confirmed') {
            return ['message' => 'Enviando correo (confirmado): '.$message, 'level' => 'confirmed'];
        }

        if ($status === 'queued') {
            $correo = trim((string) ($emailResult['email'] ?? ''));
            $destino = $correo !== '' ? ' a '.$correo : '';

            return ['message' => 'Enviando correo'.$destino.'…', 'level' => 'success'];
        }

        if ($status === 'accepted') {
            return ['message' => 'Enviado: '.$message, 'level' => 'success'];
        }

        return ['message' => '✖ '.$message, 'level' => 'error'];
    }

    private function guardarFirma(?string $dataUrl, string $tipo, string $folio): ?string
    {
        if ($dataUrl === null || $dataUrl === '' || ! str_starts_with($dataUrl, 'data:image')) {
            return null;
        }
        if (! $this->firmaDataUrlTieneTrazos($dataUrl)) {
            return null;
        }
        try {
            $data = explode(',', $dataUrl);
            if (count($data) < 2) {
                return null;
            }
            $imagenData = base64_decode($data[1], true);
            if ($imagenData === false) {
                return null;
            }
            $ext = 'jpg';
            if (preg_match('#^data:image/(png|jpeg|jpg);#i', $data[0], $mimeMatch)) {
                $mime = strtolower($mimeMatch[1]);
                $ext = ($mime === 'png') ? 'png' : 'jpg';
            }
            $dir = $this->firmasDir();
            if (! is_dir($dir)) {
                mkdir($dir, 0755, true);
            }
            $timestamp = time();
            $nombreArchivo = "{$tipo}_{$folio}_{$timestamp}.{$ext}";
            $rutaArchivo = $dir.DIRECTORY_SEPARATOR.$nombreArchivo;
            if (file_put_contents($rutaArchivo, $imagenData) !== false) {
                return $this->firmaPublicRel($nombreArchivo);
            }
        } catch (\Throwable) {
            // ignore
        }

        return null;
    }

    private function mergeFirma(?string $dataUrl, string $tipoFirma, string $folio, ?string $existente): ?string
    {
        if (! empty($dataUrl) && str_starts_with($dataUrl, 'data:image')) {
            $nueva = $this->guardarFirma($dataUrl, $tipoFirma, $folio);
            if ($nueva !== null) {
                return $nueva;
            }
        }

        return $existente;
    }

    public function hasSalidaTemporalColumns(): bool
    {
        static $cached = null;
        if ($cached !== null) {
            return $cached;
        }

        try {
            $cached = Schema::hasTable('orden_servicio_c')
                && Schema::hasColumn('orden_servicio_c', 'salida_temporal_activa');
        } catch (\Throwable) {
            $cached = false;
        }

        return $cached;
    }

    public function isSalidaTemporalActiva(int $idOrdenC): bool
    {
        if (! $this->hasSalidaTemporalColumns() || $idOrdenC <= 0) {
            return false;
        }

        return (int) (DB::scalar(
            'SELECT salida_temporal_activa FROM orden_servicio_c WHERE id_orden_c = ?',
            [$idOrdenC]
        ) ?? 0) === 1;
    }

    /**
     * @return array{success: bool, message: string, ask_salida_temporal?: bool}
     */
    public function confirmarSalidaTemporal(
        User $user,
        int $idOrdenC,
        string $motivo,
        ?string $firmaClienteDataUrl,
        ?string $firmaTecnicoDataUrl
    ): array {
        if (! $this->hasSalidaTemporalColumns()) {
            return ['success' => false, 'message' => 'Faltan columnas de salida temporal en la base de datos. Ejecuta la migración.'];
        }
        if ($idOrdenC <= 0) {
            return ['success' => false, 'message' => 'Orden inválida.'];
        }
        if (! $this->policy->userCanAccessOrder($user, $idOrdenC)) {
            return ['success' => false, 'message' => 'No autorizado para modificar esta orden.'];
        }

        $motivo = trim($motivo);
        if ($motivo === '') {
            return ['success' => false, 'message' => 'Escribe el motivo de la salida temporal.'];
        }
        if (mb_strlen($motivo) > 4000) {
            $motivo = mb_substr($motivo, 0, 4000);
        }

        $row = DB::selectOne('SELECT * FROM orden_servicio_c WHERE id_orden_c = ?', [$idOrdenC]);
        if (! $row) {
            return ['success' => false, 'message' => 'Orden no encontrada.'];
        }
        if (! OrderStatus::isEnProceso((string) ($row->estatus ?? ''))) {
            return ['success' => false, 'message' => 'La salida temporal solo aplica cuando la orden está en En proceso.'];
        }
        if ((int) ($row->salida_temporal_activa ?? 0) === 1) {
            return ['success' => false, 'message' => 'Esta orden ya tiene una salida temporal activa. Registra el regreso primero.'];
        }
        if (OrderStatus::isEntregado((string) ($row->estatus ?? ''))) {
            return ['success' => false, 'message' => 'Esta orden ya fue entregada y no se puede modificar.'];
        }

        $folio = (string) ($row->folio ?? ('orden_'.$idOrdenC));
        $firmaClientePlano = $this->guardarFirma($firmaClienteDataUrl, 'firma_cliente_salida_temp', $folio);
        $firmaTecnicoPlano = $this->guardarFirma($firmaTecnicoDataUrl, 'firma_tecnico_salida_temp', $folio);
        if ($firmaClientePlano === null || $firmaTecnicoPlano === null) {
            return ['success' => false, 'message' => 'Se requieren las firmas del cliente y del técnico para la salida temporal.'];
        }

        $now = now()->format('Y-m-d H:i:s');
        DB::update(
            'UPDATE orden_servicio_c SET
                salida_temporal_activa = 1,
                fecha_salida_temporal = ?,
                fecha_regreso_temporal = NULL,
                motivo_salida_temporal = ?,
                firma_c_salida_temp = ?,
                firma_t_salida_temp = ?
             WHERE id_orden_c = ?',
            [
                $now,
                $motivo,
                $this->vault->firmaRutaSeal($firmaClientePlano),
                $this->vault->firmaRutaSeal($firmaTecnicoPlano),
                $idOrdenC,
            ]
        );

        try {
            $nombre = ExactoAuthContext::nombreTecnicoSesionActual($user);
            if ($nombre !== '') {
                $this->registrarInvolucradoSiCambio($idOrdenC, 'Salida temporal', $nombre);
            }
        } catch (\Throwable $e) {
            report($e);
        }

        return [
            'success' => true,
            'message' => 'Salida temporal registrada. El equipo queda fuera del taller.',
            'ask_salida_temporal' => false,
            'fecha_salida_temporal' => $now,
        ];
    }

    /**
     * @return array{success: bool, message: string}
     */
    public function registrarRegresoTemporal(User $user, int $idOrdenC): array
    {
        if (! $this->hasSalidaTemporalColumns()) {
            return ['success' => false, 'message' => 'Faltan columnas de salida temporal en la base de datos. Ejecuta la migración.'];
        }
        if ($idOrdenC <= 0) {
            return ['success' => false, 'message' => 'Orden inválida.'];
        }
        if (! $this->policy->userCanAccessOrder($user, $idOrdenC)) {
            return ['success' => false, 'message' => 'No autorizado para modificar esta orden.'];
        }

        $row = DB::selectOne(
            'SELECT id_orden_c, estatus, salida_temporal_activa FROM orden_servicio_c WHERE id_orden_c = ?',
            [$idOrdenC]
        );
        if (! $row) {
            return ['success' => false, 'message' => 'Orden no encontrada.'];
        }
        if (OrderStatus::isEntregado((string) ($row->estatus ?? ''))) {
            return ['success' => false, 'message' => 'Esta orden ya fue entregada y no se puede modificar.'];
        }
        if ((int) ($row->salida_temporal_activa ?? 0) !== 1) {
            return ['success' => false, 'message' => 'Esta orden no tiene una salida temporal activa.'];
        }

        $now = now()->format('Y-m-d H:i:s');
        DB::update(
            'UPDATE orden_servicio_c SET salida_temporal_activa = 0, fecha_regreso_temporal = ? WHERE id_orden_c = ?',
            [$now, $idOrdenC]
        );

        try {
            $nombre = ExactoAuthContext::nombreTecnicoSesionActual($user);
            if ($nombre !== '') {
                $this->registrarInvolucradoSiCambio($idOrdenC, 'Regreso taller', $nombre);
            }
        } catch (\Throwable $e) {
            report($e);
        }

        return [
            'success' => true,
            'message' => 'Regreso del equipo registrado. Puedes continuar en En proceso.',
            'fecha_regreso_temporal' => $now,
        ];
    }

    private function askSalidaTemporalFlag(int $idOrdenC, string $estatusCanon): bool
    {
        if (! $this->hasSalidaTemporalColumns() || $idOrdenC <= 0) {
            return false;
        }
        if (! OrderStatus::isEnProceso($estatusCanon)) {
            return false;
        }

        return ! $this->isSalidaTemporalActiva($idOrdenC);
    }

    private function mensajeBloqueoSalidaTemporalActiva(): string
    {
        return 'Esta orden tiene una salida temporal activa. Registra el regreso del equipo al taller antes de pasarla a Terminado o Entregado.';
    }

    private function firmaDataUrlTieneTrazos(?string $dataUrl): bool
    {
        $dataUrl = trim((string) $dataUrl);
        if ($dataUrl === '' || ! str_starts_with($dataUrl, 'data:image')) {
            return false;
        }
        $partes = explode(',', $dataUrl, 2);
        if (count($partes) < 2) {
            return false;
        }
        $binary = base64_decode($partes[1], true);
        if ($binary === false || $binary === '') {
            return false;
        }

        return $this->firmaImagenTieneTrazos($binary);
    }

    private function firmaGuardadaTieneTrazos(?string $firma): bool
    {
        $firma = trim((string) $firma);
        if ($firma === '') {
            return false;
        }
        if (str_starts_with($firma, 'data:image')) {
            return $this->firmaDataUrlTieneTrazos($firma);
        }

        $absolutePath = $this->firmaPathToAbsolute($firma);
        if ($absolutePath === null) {
            return true;
        }

        $binary = @file_get_contents($absolutePath);
        if ($binary === false || $binary === '') {
            return false;
        }

        return $this->firmaImagenTieneTrazos($binary);
    }

    private function firmaPathToAbsolute(?string $path): ?string
    {
        $path = trim((string) $path);
        if ($path === '' || str_starts_with($path, 'data:image')) {
            return null;
        }

        $normalized = str_replace('\\', '/', $path);
        if (preg_match('#^https?://[^/]+/(.*)$#i', $normalized, $matches)) {
            $normalized = $matches[1];
        }
        $normalized = ltrim($normalized, '/');

        $absolutePath = public_path(str_replace('/', DIRECTORY_SEPARATOR, $normalized));
        $real = realpath($absolutePath);
        if ($real !== false && is_file($real)) {
            return $real;
        }

        return is_file($absolutePath) ? $absolutePath : null;
    }

    private function firmaImagenTieneTrazos(string $binary): bool
    {
        if ($binary === '') {
            return false;
        }
        if (! function_exists('imagecreatefromstring')) {
            return true;
        }

        $image = @imagecreatefromstring($binary);
        if ($image === false) {
            return true;
        }

        try {
            $width = imagesx($image);
            $height = imagesy($image);
            if ($width < 8 || $height < 8) {
                return false;
            }
            for ($y = 0; $y < $height; $y++) {
                for ($x = 0; $x < $width; $x++) {
                    $rgba = imagecolorat($image, $x, $y);
                    $alpha = ($rgba >> 24) & 0x7F;
                    $red = ($rgba >> 16) & 0xFF;
                    $green = ($rgba >> 8) & 0xFF;
                    $blue = $rgba & 0xFF;

                    if ($alpha < 120 && ($red < 245 || $green < 245 || $blue < 245)) {
                        return true;
                    }
                }
            }
        } finally {
            imagedestroy($image);
        }

        return false;
    }

    private function folioYearFromValue(?string $folio): int
    {
        if (is_string($folio) && preg_match('/^OS-(\d{4})-\d+$/', $folio, $m)) {
            return (int) $m[1];
        }

        return (int) date('Y');
    }

    /**
     * Debe llamarse dentro de una transacción activa (FOR UPDATE).
     *
     * @return array{folio: string, numero: int, anio: int, reutilizado: bool}
     */
    private function reservarFolio(int $anio): array
    {
        return $this->folios->reservarFolio($anio);
    }

    private function poblacionValida(string $poblacion): bool
    {
        $poblacion = trim($poblacion);
        if ($poblacion === '') {
            return false;
        }
        if (mb_strlen($poblacion, 'UTF-8') < 2 || mb_strlen($poblacion, 'UTF-8') > 80) {
            return false;
        }
        if (preg_match('/\d{4,}/', $poblacion)) {
            return false;
        }

        return (bool) preg_match('/^[\p{L}\p{M}\s.\'-]+$/u', $poblacion);
    }

    private function rebuildSearchIndex(int $idOrdenC, string $nombrePlano, string $telefonoDigits, string $correoPlano): void
    {
        $tokens = array_values(array_unique($this->vault->ordenClienteSearchTokens($nombrePlano, $telefonoDigits, $correoPlano)));
        DB::delete('DELETE FROM `orden_servicio_nombre_busqueda` WHERE `id_orden_c` = ?', [$idOrdenC]);
        $rows = [];
        foreach ($tokens as $token) {
            $rows[] = [$idOrdenC, $token];
        }
        $this->batchInsert('orden_servicio_nombre_busqueda', ['id_orden_c', 'token'], $rows, true);
    }

    /**
     * @param  list<array<int, mixed>>  $rows
     */
    private function batchInsert(string $table, array $columns, array $rows, bool $ignore = false, int $chunkSize = 150): void
    {
        if ($rows === []) {
            return;
        }

        $safeColumns = array_map(
            static fn (string $column): string => '`'.str_replace('`', '', $column).'`',
            $columns
        );
        $rowPlaceholder = '('.implode(', ', array_fill(0, count($columns), '?')).')';

        foreach (array_chunk($rows, $chunkSize) as $chunk) {
            $bindings = [];
            foreach ($chunk as $row) {
                foreach ($row as $value) {
                    $bindings[] = $value;
                }
            }

            $sql = 'INSERT '.($ignore ? 'IGNORE ' : '')
                .'INTO `'.str_replace('`', '', $table).'` ('.implode(', ', $safeColumns).') VALUES '
                .implode(', ', array_fill(0, count($chunk), $rowPlaceholder));

            DB::insert($sql, $bindings);
        }
    }

    /**
     * @param  array<mixed>  $equiposIn
     * @param  list<int>|null  $accionesPorIndice acciones previas 0..N-1 (se preservan al reinsertar)
     * @param  array<int, array{tipo?: string|null, nombre?: string|null, firma_cliente?: string|null, firma_tecnico?: string|null, tecnico?: string|null, fecha?: string|null}>|null  $entregaPorIndice datos cifrados previos por equipo
     * @return list<array<int, mixed>>
     */
    private function equipoInsertRows(
        int $idOrdenC,
        array $equiposIn,
        ?array $accionesPorIndice = null,
        ?array $entregaPorIndice = null
    ): array
    {
        $rows = [];
        $indice = 0;
        $conAcciones = Schema::hasTable('equipos_orden') && Schema::hasColumn('equipos_orden', 'acciones');
        $conReceptorEquipo = Schema::hasTable('equipos_orden')
            && Schema::hasColumn('equipos_orden', 'entrega_receptor_tipo')
            && Schema::hasColumn('equipos_orden', 'entrega_recibido_cliente');
        $conDetalleEntregaEquipo = Schema::hasTable('equipos_orden')
            && Schema::hasColumn('equipos_orden', 'entrega_firma_cliente')
            && Schema::hasColumn('equipos_orden', 'entrega_firma_tecnico')
            && Schema::hasColumn('equipos_orden', 'entrega_tecnico')
            && Schema::hasColumn('equipos_orden', 'entrega_fecha');
        foreach ($equiposIn as $equipo) {
            if (! is_array($equipo)) {
                continue;
            }

            $marca = trim((string) ($equipo['marca'] ?? ''));
            $modelo = trim((string) ($equipo['modelo'] ?? ''));
            $serie = trim((string) ($equipo['serie'] ?? ''));
            $claveEquipo = trim((string) ($equipo['clave'] ?? ''));
            $descripcionFallaEquipo = trim((string) ($equipo['descripcionFalla'] ?? ''));
            $tipoServicioEquipo = trim((string) ($equipo['tipoServicio'] ?? ''));

            $requeridos = [$marca, $modelo, $serie, $descripcionFallaEquipo, $tipoServicioEquipo];
            $llenos = array_filter($requeridos, static fn (string $valor): bool => $valor !== '');

            if (count($llenos) === 0) {
                continue;
            }

            if (count($llenos) < count($requeridos)) {
                throw new RuntimeException('Cada equipo debe tener marca, modelo, número de serie, descripción de falla y tipo de servicio. Completa todos los campos de la fila.');
            }

            $acciones = self::EQUIPO_ACCION_PENDIENTE;
            if (is_array($accionesPorIndice) && array_key_exists($indice, $accionesPorIndice)) {
                $acciones = max($acciones, (int) $accionesPorIndice[$indice]);
            }
            if (isset($equipo['acciones'])) {
                $acciones = max($acciones, (int) $equipo['acciones']);
            }

            $row = [$idOrdenC, $marca, $modelo, $serie, $claveEquipo, $tipoServicioEquipo, $descripcionFallaEquipo];
            $entregaEquipo = is_array($entregaPorIndice[$indice] ?? null)
                ? $entregaPorIndice[$indice]
                : [];
            if ($conAcciones) {
                $row[] = $acciones;
            }
            if ($conReceptorEquipo) {
                $tipoReceptor = mb_strtolower(trim((string) ($entregaEquipo['tipo'] ?? '')), 'UTF-8');
                $row[] = in_array($tipoReceptor, ['cliente', 'tercero'], true) ? $tipoReceptor : null;
                $nombreReceptor = trim((string) ($entregaEquipo['nombre'] ?? ''));
                $row[] = $nombreReceptor !== '' ? $nombreReceptor : null;
            }
            if ($conDetalleEntregaEquipo) {
                foreach (['firma_cliente', 'firma_tecnico', 'tecnico', 'fecha'] as $campoEntrega) {
                    $valorEntrega = trim((string) ($entregaEquipo[$campoEntrega] ?? ''));
                    $row[] = $valorEntrega !== '' ? $valorEntrega : null;
                }
            }
            $rows[] = $row;
            $indice++;
        }

        if ($rows === []) {
            throw new RuntimeException('Captura al menos un equipo con todos sus campos: marca, modelo, número de serie, descripción de falla y tipo de servicio.');
        }

        return $rows;
    }

    /**
     * @param  list<array<string, mixed>>  $trabajosIn
     * @return list<array<int, mixed>>
     */
    private function trabajoInsertRows(int $idTrabajo, array $trabajosIn, ?int $idEquipo = null): array
    {
        $rows = [];
        foreach ($trabajosIn as $trabajo) {
            $claveTrabajo = trim((string) ($trabajo['clave'] ?? ''));
            $descripcionTrabajo = trim((string) ($trabajo['descripcion'] ?? ''));
            if ($descripcionTrabajo === '' && $claveTrabajo === '') {
                continue;
            }

            $idEquipoFila = $this->normalizarIdEquipo($trabajo['id_equipo'] ?? $idEquipo);

            $rows[] = [
                $idTrabajo,
                $claveTrabajo,
                $descripcionTrabajo,
                (float) ($trabajo['importe'] ?? 0),
                $trabajo['ticket'] ?? null,
                $idEquipoFila,
            ];
        }

        return $rows;
    }

/**
     * @param  list<array<string, mixed>>  $materialesIn
     * @param  list<array{folio: string, descripcion: string, monto: float, ticket: string}>  $anticiposIn
     * @param  int|null  $idEquipo
     * @return list<array<int, mixed>>
     */
    private function materialInsertRows(int $idTrabajo, array $materialesIn, array $anticiposIn, float $abonoSaldoTotal, ?int $idEquipo = null): array
    {
        $rows = [];

        foreach ($materialesIn as $material) {
            $rows[] = [
                $idTrabajo,
                $material['vale'] ?? null,
                $material['codigo'] ?? null,
                (float) ($material['cant'] ?? 0),
                $material['descripcion'] ?? '',
                0,
                (float) ($material['precio'] ?? 0),
                (float) ($material['importe'] ?? 0),
                $material['ticket'] ?? null,
                $this->normalizarIdEquipo($material['id_equipo'] ?? $idEquipo),
            ];
        }

        foreach ($anticiposIn as $anticipo) {
            $rows[] = [
                $idTrabajo,
                $anticipo['folio'] ?? null,
                self::ANTICIPO_DESCRIPCION,
                0,
                $anticipo['descripcion'] ?? self::ANTICIPO_DESCRIPCION,
                (float) $anticipo['monto'],
                0,
                0,
                $anticipo['ticket'],
                $this->normalizarIdEquipo($anticipo['id_equipo'] ?? $idEquipo),
            ];
        }

        if ($abonoSaldoTotal > 0.009) {
            $rows[] = [
                $idTrabajo,
                null,
                null,
                0,
                self::ABONO_SALDO_DESCRIPCION,
                $abonoSaldoTotal,
                0,
                0,
                self::ABONO_SALDO_DESCRIPCION,
                null,
            ];
        }

        return $rows;
    }

    /**
     * @param  array<mixed>  $equiposIn
     * @return array<string, mixed>
     */
    private function buildEmailPayload(
        string $folio,
        string $estatus,
        string $nombreClientePlano,
        string $telefono,
        string $correoPlano,
        string $poblacionPlano,
        float $totalPagar,
        array $equiposIn
    ): array {
        $equipos = [];
        foreach ($equiposIn as $equipo) {
            if (! is_array($equipo)) {
                continue;
            }

            $marca = trim((string) ($equipo['marca'] ?? ''));
            $modelo = trim((string) ($equipo['modelo'] ?? ''));
            $serie = trim((string) ($equipo['serie'] ?? ''));
            $clave = trim((string) ($equipo['clave'] ?? ''));
            $tipoServicio = trim((string) ($equipo['tipoServicio'] ?? ''));
            $descripcionFalla = trim((string) ($equipo['descripcionFalla'] ?? ''));

            if ($marca === '' && $modelo === '' && $serie === '' && $clave === '' && $tipoServicio === '' && $descripcionFalla === '') {
                continue;
            }

            $equipos[] = [
                'marca' => $marca,
                'modelo' => $modelo,
                'serie' => $serie,
                'clave' => $clave,
                'tipo_servicio' => $tipoServicio,
                'descripcion_falla' => $descripcionFalla,
            ];
        }

        return [
            'folio' => trim($folio),
            'estatus' => OrderStatus::map($estatus),
            'saludo' => 'Hola, qué tal',
            'nombre_cliente' => trim($nombreClientePlano),
            'telefono' => trim($telefono),
            'correo' => trim($correoPlano),
            'poblacion' => trim($poblacionPlano),
            'total_pagar' => $totalPagar,
            'equipos' => $equipos,
        ];
    }

    private function mapEstatusCanon(string $s): string
    {
        return OrderStatus::map($s);
    }

    private function materialCampo(array $material, string $campo): string
    {
        return trim((string) ($material[$campo] ?? ''));
    }

    private function materialTieneDatos(array $material): bool
    {
        foreach (['vale', 'codigo', 'cant', 'descripcion', 'precio', 'ticket'] as $campo) {
            if ($this->materialCampo($material, $campo) !== '') {
                return true;
            }
        }

        return false;
    }

    private function trabajoCampo(array $trabajo, string $campo): string
    {
        return trim((string) ($trabajo[$campo] ?? ''));
    }

    private function trabajoTieneDatos(array $trabajo): bool
    {
        foreach (['clave', 'descripcion', 'importe', 'ticket'] as $campo) {
            if ($this->trabajoCampo($trabajo, $campo) !== '') {
                return true;
            }
        }

        return false;
    }

    private function esTicketSistema(string $ticket): bool
    {
        return in_array(mb_strtoupper(trim($ticket), 'UTF-8'), [
            'SALDO LIQUIDADO',
            'ABONO SALDO',
            'ABONO SALDO PENDIENTE',
            'PAGO SALDO PENDIENTE',
        ], true);
    }

    /**
     * Ticket/factura abierto opcional: texto libre en mayúsculas (salvo tickets de sistema).
     *
     * @return array{success: bool, message?: string, ticket: string}
     */
    private function normalizarTicketFactura(string $ticket, int $fila, string $contexto): array
    {
        $ticket = trim($ticket);
        if ($ticket === '') {
            return ['success' => true, 'ticket' => ''];
        }

        if ($this->esTicketSistema($ticket)) {
            return ['success' => true, 'ticket' => mb_strtoupper($ticket, 'UTF-8')];
        }

        $ticket = mb_strtoupper($ticket, 'UTF-8');
        if (mb_strlen($ticket, 'UTF-8') > 80) {
            return [
                'success' => false,
                'message' => $contexto.' (fila '.$fila.'): ticket/factura no debe superar 80 caracteres.',
                'ticket' => '',
            ];
        }

        return ['success' => true, 'ticket' => $ticket];
    }

    /**
     * @param  array<mixed>  $trabajosIn
     * @return array{success: bool, message?: string, trabajos: list<array<string, mixed>>}
     */
    private function normalizarTrabajos(array $trabajosIn): array
    {
        $trabajos = [];
        $filaTrabajo = 0;
        foreach ($trabajosIn as $trabajo) {
            if (! is_array($trabajo) || ! $this->trabajoTieneDatos($trabajo)) {
                continue;
            }
            $filaTrabajo++;
            $ticketNorm = $this->normalizarTicketFactura($this->trabajoCampo($trabajo, 'ticket'), $filaTrabajo, 'Trabajo');
            if (! $ticketNorm['success']) {
                return ['success' => false, 'message' => (string) ($ticketNorm['message'] ?? 'Ticket o factura inválido.'), 'trabajos' => []];
            }
            $ticket = $ticketNorm['ticket'];
            $clave = $this->trabajoCampo($trabajo, 'clave');
            $descripcion = mb_strtoupper($this->trabajoCampo($trabajo, 'descripcion'), 'UTF-8');
            if ($descripcion === '' && $clave === '') {
                continue;
            }
            $trabajos[] = [
                'clave' => $clave,
                'descripcion' => $descripcion,
                'importe' => (float) ($trabajo['importe'] ?? 0),
                'ticket' => $ticket,
                'id_equipo' => $this->normalizarIdEquipo($trabajo['id_equipo'] ?? null),
            ];
        }

        return ['success' => true, 'trabajos' => $trabajos];
    }

    /**
     * @param  array<mixed>  $materialesIn
     * @return array{success: bool, message?: string, materiales: list<array<string, mixed>>}
     */
    private function normalizarMateriales(array $materialesIn): array
    {
        $materiales = [];
        $filaMaterial = 0;
        foreach ($materialesIn as $material) {
            if (! is_array($material) || ! $this->materialTieneDatos($material)) {
                continue;
            }
            $filaMaterial++;
            $vale = mb_strtoupper($this->materialCampo($material, 'vale'), 'UTF-8');
            $descripcion = mb_strtoupper($this->materialCampo($material, 'descripcion'), 'UTF-8');
            $cantidadRaw = $this->materialCampo($material, 'cant');
            $precioRaw = $this->materialCampo($material, 'precio');
            if ($vale === '') {
                return ['success' => false, 'message' => 'Material (fila '.$filaMaterial.'): falta el vale.', 'materiales' => []];
            }
            if ($cantidadRaw === '') {
                return ['success' => false, 'message' => 'Material (fila '.$filaMaterial.'): falta la cantidad.', 'materiales' => []];
            }
            if ($descripcion === '') {
                return ['success' => false, 'message' => 'Material (fila '.$filaMaterial.'): falta la descripción.', 'materiales' => []];
            }
            if ($precioRaw === '') {
                return ['success' => false, 'message' => 'Material (fila '.$filaMaterial.'): falta el precio unitario.', 'materiales' => []];
            }
            $ticketNorm = $this->normalizarTicketFactura($this->materialCampo($material, 'ticket'), $filaMaterial, 'Material');
            if (! $ticketNorm['success']) {
                return ['success' => false, 'message' => (string) ($ticketNorm['message'] ?? 'Ticket o factura inválido.'), 'materiales' => []];
            }
            $ticket = $ticketNorm['ticket'];
            $cant = (float) ($material['cant'] ?? 0);
            $precio = (float) ($material['precio'] ?? 0);
            if ($cant < 0) {
                return ['success' => false, 'message' => 'Material (fila '.$filaMaterial.'): la cantidad no puede ser negativa.', 'materiales' => []];
            }
            if ($precio < 0) {
                return ['success' => false, 'message' => 'Material (fila '.$filaMaterial.'): el precio unitario no puede ser negativo.', 'materiales' => []];
            }
            $materiales[] = [
                'vale' => $vale,
                'codigo' => mb_strtoupper($this->materialCampo($material, 'codigo'), 'UTF-8'),
                'cant' => $cant,
                'descripcion' => $descripcion,
                'precio' => $precio,
                'importe' => round($cant * $precio, 2),
                'ticket' => $ticket,
                'id_equipo' => $this->normalizarIdEquipo($material['id_equipo'] ?? null),
            ];
        }

        return ['success' => true, 'materiales' => $materiales];
    }

    /**
     * @param  array<mixed>  $anticiposIn
     * @return array{success: bool, message?: string, anticipos: list<array{folio: string, descripcion: string, monto: float, ticket: string}>}
     */
    private function normalizarAnticipos(array $anticiposIn): array
    {
        $anticipos = [];
        $filaAnticipo = 0;
        foreach ($anticiposIn as $anticipo) {
            if (! is_array($anticipo)) {
                continue;
            }
            $folio = mb_strtoupper(trim((string) ($anticipo['folio'] ?? '')), 'UTF-8');
            $descripcion = mb_strtoupper(trim((string) ($anticipo['descripcion'] ?? '')), 'UTF-8');
            $montoRaw = trim((string) ($anticipo['monto'] ?? ''));
            $ticket = trim((string) ($anticipo['ticket'] ?? ''));
            $montoEsCero = $montoRaw !== '' && is_numeric($montoRaw) && abs((float) $montoRaw) < 0.009;
            if ($folio === '' && $descripcion === '' && ($montoRaw === '' || $montoEsCero) && $ticket === '') {
                continue;
            }
            $filaAnticipo++;
            if ($folio === '') {
                return ['success' => false, 'message' => 'Anticipo (fila '.$filaAnticipo.'): captura el folio del pedido.', 'anticipos' => []];
            }
            if (mb_strlen($folio, 'UTF-8') > 80) {
                return ['success' => false, 'message' => 'Anticipo (fila '.$filaAnticipo.'): el folio no debe superar 80 caracteres.', 'anticipos' => []];
            }
            if ($descripcion === '') {
                return ['success' => false, 'message' => 'Anticipo (fila '.$filaAnticipo.'): captura la descripción de refacción.', 'anticipos' => []];
            }
            if (mb_strlen($descripcion, 'UTF-8') > 255) {
                return ['success' => false, 'message' => 'Anticipo (fila '.$filaAnticipo.'): la descripción no debe superar 255 caracteres.', 'anticipos' => []];
            }
            if ($montoRaw === '') {
                return ['success' => false, 'message' => 'Anticipo (fila '.$filaAnticipo.'): captura el monto pagado (puede ser 0).', 'anticipos' => []];
            }
            if (! is_numeric($montoRaw)) {
                return ['success' => false, 'message' => 'Anticipo (fila '.$filaAnticipo.'): el monto pagado no es válido.', 'anticipos' => []];
            }
            $monto = (float) $montoRaw;
            $ticketNorm = $this->normalizarTicketFactura($ticket, $filaAnticipo, 'Anticipo');
            if (! $ticketNorm['success']) {
                return ['success' => false, 'message' => (string) ($ticketNorm['message'] ?? 'Ticket o factura inválido.'), 'anticipos' => []];
            }
            $anticipos[] = [
                'folio' => $folio,
                'descripcion' => $descripcion,
                'monto' => $monto,
                'ticket' => $ticketNorm['ticket'],
                'id_equipo' => $this->normalizarIdEquipo($anticipo['id_equipo'] ?? null),
            ];
        }

        return ['success' => true, 'anticipos' => $anticipos];
    }

    private function normalizarIdEquipo(mixed $idEquipo): ?int
    {
        if ($idEquipo === null || $idEquipo === '') {
            return null;
        }
        $idEquipoInt = (int) $idEquipo;
        if ($idEquipoInt <= 0) {
            return null;
        }

        return $idEquipoInt;
    }

    /**
     * Resuelve el equipo de una entrega parcial.
     * Acepta el id real (equipos_orden.id_equipo) o el índice de fila 1..N.
     */
    private function resolverIdEquipoEntrega(int $idOrden, int $idEquipoReq, int $equipoIndice = 0): ?int
    {
        if ($idOrden <= 0) {
            return null;
        }

        $equiposDb = DB::select(
            'SELECT id_equipo FROM equipos_orden WHERE id_orden_c = ? ORDER BY id_equipo ASC',
            [$idOrden]
        );
        if ($equiposDb === []) {
            return null;
        }

        $ids = [];
        foreach ($equiposDb as $eq) {
            $ids[] = (int) ($eq->id_equipo ?? 0);
        }
        $ids = array_values(array_filter($ids, static fn (int $id): bool => $id > 0));
        if ($ids === []) {
            return null;
        }

        if ($idEquipoReq > 0 && in_array($idEquipoReq, $ids, true)) {
            return $idEquipoReq;
        }

        if ($equipoIndice >= 1 && $equipoIndice <= count($ids)) {
            return $ids[$equipoIndice - 1];
        }

        // Cliente legado: a veces manda el número de fila (1..N) en id_equipo.
        if ($idEquipoReq >= 1 && $idEquipoReq <= count($ids)) {
            return $ids[$idEquipoReq - 1];
        }

        return null;
    }

    private function fechasTallerSegunEstatus(string $estatusCanon, mixed $fechaTerminadaActual, mixed $fechaSalidaActual): array
    {
        $nowSql = now()->format('Y-m-d H:i:s');
        $ft = $fechaTerminadaActual;
        $fs = $fechaSalidaActual;
        $ftStr = $ft !== null && $ft !== '' ? trim((string) $ft) : '';
        $fsStr = $fs !== null && $fs !== '' ? trim((string) $fs) : '';

        if ($estatusCanon === 'Terminado') {
            // Guardar/confirmar Terminado reemplaza la fecha y hora anterior.
            $ft = $nowSql;
        } elseif ($estatusCanon === 'Entregado' && $ftStr === '') {
            $ft = $nowSql;
        }
        if ($estatusCanon === 'Entregado' && $fsStr === '') {
            $fs = $nowSql;
        }

        return [$ft, $fs];
    }

    /**
     * @return array{success: bool, message: string, folio?: string, idOrden?: int}
     */
    public function handle(Request $request, User $user): array
    {
        $lockKey = $this->submissionLockKey($request, $user);
        if (! $this->acquireSubmissionLock($lockKey)) {
            return [
                'success' => false,
                'processing' => true,
                'duplicate_submit' => true,
                'message' => 'La orden ya se está guardando. Espera a que termine el proceso actual.',
            ];
        }

        try {
            $this->ensureSchema();

            $idOrdenEditar = (int) $request->input('id_orden_c', 0);
            $modoCompletar = (string) $request->input('modo_completar', '') === '1';
            $folio = $request->input('folio');
            $nombreClientePlano = $this->textoMayusculas((string) $request->input('nombreCliente', ''));
            if (! $modoCompletar && $nombreClientePlano === '') {
                return ['success' => false, 'message' => 'Nombre o razón social: este campo es obligatorio.'];
            }
            $clienteRecibidoPlano = $nombreClientePlano;
            $nombreCliente = $this->vault->nombreClienteSeal($nombreClientePlano);
            $clienteRecibido = $this->vault->nombreClienteSeal($clienteRecibidoPlano);
            $direccion = $this->textoMayusculas((string) $request->input('direccion', ''));
            // Celular opcional: no bloquea el guardado. Si viene vacío o con formato no
            // válido, la orden se guarda igual y dispatchStatusNotifications omite el envío
            // de WhatsApp mostrando la alerta de "no enviado".
            $telefono = $this->normalizeTelefonoClientePlano(
                $this->vault->normalizeDigits(trim((string) $request->input('telefono', '')))
            );
            $telefonoParaBd = $this->vault->telefonoSeal($telefono);
            $direccionParaBd = $this->vault->direccionSeal($direccion);
            // Correo opcional: tampoco bloquea. Si el formato es inválido, se guarda la orden
            // y el envío de correo se omite avisando "correo no enviado".
            $correoPlano = $this->normalizeCorreoPlano((string) $request->input('correo', ''));
            $correo = $this->vault->correoSeal($correoPlano);
            $poblacionPlano = $this->textoMayusculas((string) $request->input('poblacion', ''));
            if (! $modoCompletar && $poblacionPlano === '') {
                return ['success' => false, 'message' => 'Población/Ciudad: este campo es obligatorio.'];
            }
            if (! $modoCompletar && ! $this->poblacionValida($poblacionPlano)) {
                return ['success' => false, 'message' => 'Población/Ciudad: usa solo letras, espacios, puntos, apóstrofes o guiones (sin números largos).'];
            }
            $poblacion = $this->vault->poblacionSeal($poblacionPlano);
            $fechaEntrada = $request->input('fechaEntrada') ?: null;
            $fechaTerminadaPost = null;
            $fechaSalidaPost = null;
            $estatus = (string) $request->input('estatus', 'Recepción');
            $permitirNegativos = (string) $request->input('permitir_negativos', '') === '1';
            $permitirSaldoNegativo = (string) $request->input('permitir_saldo_negativo', '') === '1';
            $tecnicoRecibido = '';
            if ($idOrdenEditar <= 0) {
                $tecnicoRecibido = ExactoAuthContext::tecnicoRecepcionParaOrden($user);
            }

        $observaciones = '';
        $obsList = $request->input('observaciones', []);
        if (is_array($obsList)) {
            $observacionesList = array_values(array_filter($obsList, fn ($obs) => trim((string) $obs) !== ''));
            $observaciones = implode(', ', array_map(function ($index, $obs) {
                return ($index + 1).'. '.$this->textoMayusculas((string) $obs);
            }, array_keys($observacionesList), $observacionesList));
        }

            if ($idOrdenEditar <= 0 && ! $modoCompletar) {
                $obsError = \App\Support\OrdenObservacionesValidator::validate($obsList ?? []);
                if ($obsError !== null) {
                    return ['success' => false, 'message' => $obsError];
                }
            }

        $noEquipo = 0;
        $tipoServicioOrden = '';
        $equiposIn = $request->input('equipos', []);
        if (! is_array($equiposIn)) {
            $equiposIn = [];
        }
        $equiposIn = $this->equiposEnMayusculas($equiposIn);
        if (is_array($equiposIn)) {
            foreach ($equiposIn as $equipo) {
                if (! is_array($equipo)) {
                    continue;
                }
                $marca = trim((string) ($equipo['marca'] ?? ''));
                $modelo = trim((string) ($equipo['modelo'] ?? ''));
                $serie = trim((string) ($equipo['serie'] ?? ''));
                $claveEquipo = trim((string) ($equipo['clave'] ?? ''));
                $descripcionFallaEquipo = trim((string) ($equipo['descripcionFalla'] ?? ''));
                $tipoServicioEquipo = trim((string) ($equipo['tipoServicio'] ?? ''));
                if ($marca !== '' || $modelo !== '' || $serie !== '' || $claveEquipo !== '' || $descripcionFallaEquipo !== '' || $tipoServicioEquipo !== '') {
                    $noEquipo++;
                }
                if ($tipoServicioOrden === '' && $tipoServicioEquipo !== '') {
                    $tipoServicioOrden = $tipoServicioEquipo;
                }
            }
        }

        $subtotalTrabajos = 0.0;
        $subtotalMateriales = 0.0;
        $subtotalMaterialesBruto = 0.0;
        $trabajosRaw = $request->input('trabajos', []);
        $trabajosIn = [];
        if (is_array($trabajosRaw)) {
            $trabajosNormalizados = $this->normalizarTrabajos($trabajosRaw);
            if (! $trabajosNormalizados['success']) {
                return ['success' => false, 'message' => (string) ($trabajosNormalizados['message'] ?? 'Trabajos inválidos.')];
            }
            $trabajosIn = $trabajosNormalizados['trabajos'];
            foreach ($trabajosIn as $trabajo) {
                $subtotalTrabajos += (float) ($trabajo['importe'] ?? 0);
            }
        }
        $materialesRaw = $request->input('materiales', []);
        $materialesIn = [];
        if (is_array($materialesRaw)) {
            $materialesNormalizados = $this->normalizarMateriales($materialesRaw);
            if (! $materialesNormalizados['success']) {
                return ['success' => false, 'message' => (string) ($materialesNormalizados['message'] ?? 'Materiales inválidos.')];
            }
            $materialesIn = $materialesNormalizados['materiales'];
            $subtotalMaterialesBruto = 0.0;
            foreach ($materialesIn as $material) {
                $subtotalMaterialesBruto += (float) ($material['importe'] ?? 0);
                $subtotalMateriales += (float) ($material['cant'] ?? 0) * (float) ($material['precio'] ?? 0);
            }
            $subtotalMateriales = round($subtotalMateriales, 2);
        }
        $anticiposRaw = $request->input('anticipos', []);
        $anticiposIn = [];
        if (is_array($anticiposRaw)) {
            $anticiposNormalizados = $this->normalizarAnticipos($anticiposRaw);
            if (! $anticiposNormalizados['success']) {
                return ['success' => false, 'message' => (string) ($anticiposNormalizados['message'] ?? 'Anticipos inválidos.')];
            }
            $anticiposIn = $anticiposNormalizados['anticipos'];
        }
        $abonoSaldoTotal = max(0.0, (float) $request->input('abono_saldo', 0));

        // Todo el formulario captura montos SIN IVA. El 16% solo se aplica en totales y en el crédito de pagos.
        $subtotalNeto = round($subtotalTrabajos + $subtotalMateriales, 2);
        $ivaTotal = round($subtotalNeto * 0.16, 2);
        $totalPagar = round($subtotalNeto + $ivaTotal, 2);
        $anticipoTotal = array_reduce($anticiposIn, static fn (float $carry, array $anticipo): float => $carry + (float) ($anticipo['monto'] ?? 0), 0.0);
        $totalRecibido = round(($anticipoTotal + $abonoSaldoTotal) * 1.16, 2);
        $hayNegativos = false;
        foreach ($trabajosIn as $trabajo) {
            $hayNegativos = $hayNegativos || (float) ($trabajo['importe'] ?? 0) < 0;
        }
        foreach ($materialesIn as $material) {
            $hayNegativos = $hayNegativos
                || (float) ($material['cant'] ?? 0) < 0
                || (float) ($material['precio'] ?? 0) < 0;
        }
        foreach ($anticiposIn as $anticipo) {
            $hayNegativos = $hayNegativos || (float) ($anticipo['monto'] ?? 0) < 0;
        }
$hayNegativos = $hayNegativos || $abonoSaldoTotal < 0;
$saldoPendienteCalc = round($totalPagar - $totalRecibido, 2);
// Si el total recibido cubre o supera el total a pagar, saldo = 0
if ($totalRecibido >= $totalPagar) {
    $saldoPendienteCalc = 0;
}
$saldoPagadoConfirmado = (string) $request->input('saldo_pagado_confirmado', '') === '1'
            || (string) $request->input('saldoPagadoConfirmado', '') === '1';
        // Si la orden queda liquidada con pagos (anticipos/abono), exigir confirmación "cliente pagó".
        if ($totalPagar > 0.009 && abs($saldoPendienteCalc) <= 0.009 && $totalRecibido > 0.009 && ! $saldoPagadoConfirmado) {
            return [
                'success' => false,
                'message' => 'El saldo pendiente fue liquidado. Confirma en pantalla si el cliente pagó para guardar.',
            ];
        }
        $estatusCanon = OrderStatus::map($estatus);
        $entregaPorEquipoReq = (string) $request->input('entrega_por_equipo', '') === '1';
        // Entrega por equipo: el saldo se valida por equipo en UI; no exigir liquidación de toda la orden.
        if (
            $estatusCanon === 'Entregado'
            && ! $entregaPorEquipoReq
            && abs($totalPagar - $totalRecibido) > 0.009
        ) {
            return ['success' => false, 'message' => 'Para guardar como Entregado, el saldo pendiente debe quedar liquidado en $0.00.'];
        }
        if ($idOrdenEditar <= 0 && in_array($estatusCanon, ['En proceso', 'Terminado', 'Entregado'], true)) {
            if (
                ! $this->firmaDataUrlTieneTrazos($request->input('firmaClienteInicial'))
                || ! $this->firmaDataUrlTieneTrazos($request->input('firmaTecnicoInicial'))
            ) {
                return ['success' => false, 'message' => 'No se puede guardar la orden en ese estatus sin las firmas de Cliente y Técnico.'];
            }
        }
        if ($idOrdenEditar <= 0 && $estatusCanon === 'Entregado') {
            if (
                ! $this->firmaDataUrlTieneTrazos($request->input('firmaCliente'))
                || ! $this->firmaDataUrlTieneTrazos($request->input('firmaTecnico'))
            ) {
                return ['success' => false, 'message' => 'Para guardar como Entregado, deben estar firmadas Cliente y Técnico.'];
            }
        }
        $comentariosTecnico = $this->textoMayusculas((string) $request->input('comentariosTecnico', ''));
        if ($comentariosTecnico === '') {
            $comentariosTecnico = null;
        }

        if ($idOrdenEditar > 0) {
            return $this->handleUpdate(
                $request,
                $user,
                $idOrdenEditar,
                $modoCompletar,
                $folio,
                $nombreClientePlano,
                $clienteRecibidoPlano,
                $nombreCliente,
                $clienteRecibido,
                $direccionParaBd,
                $telefono,
                $telefonoParaBd,
                $correoPlano,
                $correo,
                $poblacionPlano,
                $poblacion,
                $fechaEntrada,
                $estatus,
                $tecnicoRecibido,
                $tipoServicioOrden,
                $noEquipo,
                $observaciones,
                $subtotalTrabajos,
                $subtotalMateriales,
                $ivaTotal,
                $totalPagar,
                $comentariosTecnico,
                $equiposIn,
                $trabajosIn,
                $materialesIn,
                $anticiposIn,
                $abonoSaldoTotal
            );
        }

            return $this->handleInsert(
                $request,
                $folio,
                $nombreCliente,
                $clienteRecibido,
                $tecnicoRecibido,
                $tipoServicioOrden,
                $direccionParaBd,
                $telefonoParaBd,
                $correo,
                $poblacion,
                $fechaEntrada,
                $fechaTerminadaPost,
                $fechaSalidaPost,
                $noEquipo,
                $observaciones,
                $estatus,
                $subtotalTrabajos,
                $subtotalMateriales,
                $ivaTotal,
                $totalPagar,
                $comentariosTecnico,
                $nombreClientePlano,
                $telefono,
                $correoPlano,
                $poblacionPlano,
                $equiposIn,
                $trabajosIn,
                $materialesIn,
                $anticiposIn,
                $abonoSaldoTotal
            );
        } finally {
            $this->releaseSubmissionLock($lockKey);
        }
    }

    /**
     * @param  array<mixed>  $equiposIn
     * @param  array<mixed>  $trabajosIn
     * @param  list<array<string, mixed>>  $materialesIn
     * @param  list<array{folio: string, descripcion: string, monto: float, ticket: string}>  $anticiposIn
     * @return array{success: bool, message: string, folio?: string, idOrden?: int}
     */
    private function handleUpdate(
        Request $request,
        User $user,
        int $idOrdenEditar,
        bool $modoCompletar,
        mixed $folio,
        string $nombreClientePlano,
        string $clienteRecibidoPlano,
        string $nombreCliente,
        string $clienteRecibido,
        string $direccionParaBd,
        string $telefono,
        string $telefonoParaBd,
        string $correoPlano,
        string $correo,
        string $poblacionPlano,
        string $poblacion,
        mixed $fechaEntrada,
        string $estatus,
        string $tecnicoRecibido,
        string $tipoServicioOrden,
        int $noEquipo,
        string $observaciones,
        float $subtotalTrabajos,
        float $subtotalMateriales,
        float $ivaTotal,
        float $totalPagar,
        mixed $comentariosTecnico,
        array $equiposIn,
        array $trabajosIn,
        array $materialesIn,
        array $anticiposIn,
        float $abonoSaldoTotal
    ): array {
        $existenteC = DB::selectOne('SELECT * FROM orden_servicio_c WHERE id_orden_c = ?', [$idOrdenEditar]);
        if (! $existenteC) {
            return ['success' => false, 'message' => 'Orden no encontrada.'];
        }
        $ex = (array) $existenteC;
        if (! $this->policy->userCanAccessOrder($user, $idOrdenEditar)) {
            return ['success' => false, 'message' => 'No autorizado para editar esta orden.'];
        }
        if (OrderStatus::isEntregado((string) ($ex['estatus'] ?? ''))) {
            return ['success' => false, 'message' => 'Esta orden ya fue entregada y no se puede editar.'];
        }
        if ((string) $ex['folio'] !== (string) $folio) {
            return ['success' => false, 'message' => 'El folio no coincide con la orden.'];
        }

        // Entrega por equipo: aceptar id real de BD o índice 1..N de la fila.
        $entregaPorEquipo = (string) $request->input('entrega_por_equipo', '') === '1';
        $idEquipoEntregaResuelto = null;
        $equipoIndiceEntrega = 0;
        $estatusEquipoSolicitado = null;
        if ($entregaPorEquipo) {
            $estatusEquipoSolicitado = $this->mapEstatusCanon($estatus);
            $equipoIndiceEntrega = (int) $request->input('equipo_indice', 0);
            $resuelto = $this->resolverIdEquipoEntrega(
                $idOrdenEditar,
                (int) $request->input('id_equipo', 0),
                $equipoIndiceEntrega
            );
            if ($resuelto === null) {
                return ['success' => false, 'message' => 'Ese equipo no pertenece a esta orden.'];
            }
            $idEquipoEntregaResuelto = $resuelto;
            if ($equipoIndiceEntrega < 1) {
                $equiposOrdenados = DB::select(
                    'SELECT id_equipo FROM equipos_orden WHERE id_orden_c = ? ORDER BY id_equipo ASC',
                    [$idOrdenEditar]
                );
                foreach ($equiposOrdenados as $idx => $eqRow) {
                    if ((int) ($eqRow->id_equipo ?? 0) === $idEquipoEntregaResuelto) {
                        $equipoIndiceEntrega = $idx + 1;
                        break;
                    }
                }
            }
            $request->merge([
                'id_equipo' => $idEquipoEntregaResuelto,
                'equipo_indice' => $equipoIndiceEntrega,
            ]);
        }

        if ($this->editLocks->tableExists() && ! $this->editLocks->assertHolder($idOrdenEditar, null, $user)) {
            $lock = $this->editLocks->activeLockForOrder($idOrdenEditar);
            $holder = $lock ? (string) $lock->locked_by_nombre : 'otro usuario';

            return [
                'success' => false,
                'message' => 'Esta orden está en edición por '.$holder.'. No se puede guardar hasta que libere la orden.',
            ];
        }
        if ($modoCompletar) {
            $nombreClientePlano = $this->vault->nombreClienteReveal($ex['nombre_cliente'] ?? null);
            $clienteRecibidoPlano = $this->vault->nombreClienteReveal($ex['cliente_recibido'] ?? null);
            if ($clienteRecibidoPlano === '') {
                $clienteRecibidoPlano = $nombreClientePlano;
            }
            $nombreCliente = (string) ($ex['nombre_cliente'] ?? $this->vault->nombreClienteSeal($nombreClientePlano));
            $clienteRecibido = (string) ($ex['cliente_recibido'] ?? $this->vault->nombreClienteSeal($clienteRecibidoPlano));
            $direccionParaBd = (string) ($ex['direccion'] ?? '');
            $telefonoParaBd = (string) ($ex['telefono'] ?? '');
            $correoPlano = $this->vault->correoReveal($ex['correo'] ?? null);
            $correo = (string) ($ex['correo'] ?? $this->vault->correoSeal($correoPlano));
            $poblacionPlano = $this->vault->poblacionReveal($ex['poblacion'] ?? null);
            $poblacion = (string) ($ex['poblacion'] ?? $this->vault->poblacionSeal($poblacionPlano));
            $fechaEntrada = $ex['fecha_entrada'] ?? null;
            $telefono = $this->vault->telefonoReveal($ex['telefono'] ?? null);
        }

        $existenteT = DB::selectOne('SELECT * FROM orden_servicio_t WHERE id_orden_c = ? ORDER BY id_trabajo ASC LIMIT 1', [$idOrdenEditar]);
        $exT = $existenteT ? (array) $existenteT : null;

        $fechaTerminada = $ex['fecha_terminada'] ?? null;
        $fechaSalida = $ex['fecha_salida'] ?? null;

        $folioStr = (string) $folio;
        $firmaClienteInicialPlano = $this->mergeFirma(
            $request->input('firmaClienteInicial'),
            'firma_cliente_inicial',
            $folioStr,
            $this->vault->firmaRutaReveal($ex['firma_c_e'] ?? null)
        );
        $firmaTecnicoInicialPlano = $this->mergeFirma(
            $request->input('firmaTecnicoInicial'),
            'firma_tecnico_inicial',
            $folioStr,
            $this->vault->firmaRutaReveal($ex['firma_t_r'] ?? null)
        );
        $esEntregaIndividual = $entregaPorEquipo
            && $estatusEquipoSolicitado === 'Entregado'
            && $equipoIndiceEntrega >= 1;
        $firmaClienteFinalExistente = null;
        $firmaTecnicoFinalExistente = null;
        if (! $esEntregaIndividual && $exT) {
            $firmaClienteFinalExistente = $this->vault->firmaRutaReveal($exT['firma_c_r'] ?? null);
            $firmaTecnicoFinalExistente = $this->vault->firmaRutaReveal($exT['firma_t_e'] ?? null);
        }
        if (
            $esEntregaIndividual
            && $idEquipoEntregaResuelto
            && Schema::hasColumn('equipos_orden', 'entrega_firma_cliente')
            && Schema::hasColumn('equipos_orden', 'entrega_firma_tecnico')
        ) {
            $equipoFirmasExistentes = DB::selectOne(
                'SELECT entrega_firma_cliente, entrega_firma_tecnico
                 FROM equipos_orden WHERE id_equipo = ? AND id_orden_c = ?',
                [$idEquipoEntregaResuelto, $idOrdenEditar]
            );
            if ($equipoFirmasExistentes) {
                $firmaClienteEquipo = $this->vault->firmaRutaReveal(
                    $equipoFirmasExistentes->entrega_firma_cliente ?? null
                );
                $firmaTecnicoEquipo = $this->vault->firmaRutaReveal(
                    $equipoFirmasExistentes->entrega_firma_tecnico ?? null
                );
                if ($firmaClienteEquipo !== '') {
                    $firmaClienteFinalExistente = $firmaClienteEquipo;
                }
                if ($firmaTecnicoEquipo !== '') {
                    $firmaTecnicoFinalExistente = $firmaTecnicoEquipo;
                }
            }
        }
        $firmaClienteFinalPlano = $this->mergeFirma(
            $request->input('firmaCliente'),
            $esEntregaIndividual ? 'firma_cliente_equipo_'.$equipoIndiceEntrega.'_final' : 'firma_cliente_final',
            $folioStr,
            $firmaClienteFinalExistente
        );
        $firmaTecnicoFinalPlano = $this->mergeFirma(
            $request->input('firmaTecnico'),
            $esEntregaIndividual ? 'firma_tecnico_equipo_'.$equipoIndiceEntrega.'_final' : 'firma_tecnico_final',
            $folioStr,
            $firmaTecnicoFinalExistente
        );
        $firmaClienteInicial = $this->vault->firmaRutaSeal($firmaClienteInicialPlano);
        $firmaTecnicoInicial = $this->vault->firmaRutaSeal($firmaTecnicoInicialPlano);
        $firmaClienteFinal = $this->vault->firmaRutaSeal($firmaClienteFinalPlano);
        $firmaTecnicoFinal = $this->vault->firmaRutaSeal($firmaTecnicoFinalPlano);

        $tecnicoRecepcion = $this->nombreTecnicoOperador($user);
        $tecnicoInvolucrado = ExactoAuthContext::nombreTecnicoSesionActual($user);
        $tecnicoRecibidoUpdate = $this->tecnicoRecibidoLegibleDesdeBd($ex['tecnico_recibido'] ?? null);
        if ($tecnicoRecibidoUpdate === '' && $exT && isset($exT['tecnico_recibido'])) {
            $tecnicoRecibidoUpdate = $this->tecnicoRecibidoLegibleDesdeBd((string) $exT['tecnico_recibido']);
        }

        $actCanon = $this->mapEstatusCanon((string) ($ex['estatus'] ?? ''));
        $nuevCanon = $this->mapEstatusCanon($estatus);
        $estatusOrdenFlujo = ['Recepción', 'En proceso', 'Terminado', 'Entregado'];
        $estatusOrdenIndice = array_flip($estatusOrdenFlujo);

        // Entrega por equipo: NO cambia el estatus de la orden; solo el equipo (acciones).
        if ($entregaPorEquipo && $estatusEquipoSolicitado !== null) {
            $accionesActual = 0;
            if (Schema::hasColumn('equipos_orden', 'acciones')) {
                // Preferir índice 1..N (estable tras reinsert); fallback por id_equipo.
                if ($equipoIndiceEntrega >= 1) {
                    $eqAccRows = DB::select(
                        'SELECT acciones FROM equipos_orden WHERE id_orden_c = ? ORDER BY id_equipo ASC',
                        [$idOrdenEditar]
                    );
                    $idxAcc = $equipoIndiceEntrega - 1;
                    if (isset($eqAccRows[$idxAcc])) {
                        $accionesActual = (int) ($eqAccRows[$idxAcc]->acciones ?? 0);
                    }
                }
                if ($accionesActual < 1 && $idEquipoEntregaResuelto) {
                    $accionesActual = (int) (DB::scalar(
                        'SELECT acciones FROM equipos_orden WHERE id_equipo = ? AND id_orden_c = ?',
                        [$idEquipoEntregaResuelto, $idOrdenEditar]
                    ) ?? 0);
                }
            }
            // Legado: si la orden ya está Terminado/Entregado a nivel global, el equipo se considera terminado.
            if ($accionesActual < self::EQUIPO_ACCION_TERMINADO
                && in_array($actCanon, ['Terminado', 'Entregado'], true)) {
                $accionesActual = self::EQUIPO_ACCION_TERMINADO;
            }
            if ($estatusEquipoSolicitado === 'Entregado' && $accionesActual < self::EQUIPO_ACCION_TERMINADO) {
                return [
                    'success' => false,
                    'message' => 'Primero marca este equipo como Terminado (uso interno). Después podrás marcarlo como Entregado y notificar al cliente.',
                ];
            }
            if ($estatusEquipoSolicitado === 'Terminado' && $accionesActual >= self::EQUIPO_ACCION_ENTREGADO) {
                return [
                    'success' => false,
                    'message' => 'Este equipo ya fue entregado.',
                ];
            }
            if ($estatusEquipoSolicitado === 'Entregado' && $accionesActual >= self::EQUIPO_ACCION_ENTREGADO) {
                return [
                    'success' => false,
                    'message' => 'Este equipo ya fue entregado.',
                ];
            }
            // La orden conserva su estatus actual.
            $nuevCanon = $actCanon;
            $estatus = $actCanon;
        }

        if (
            isset($estatusOrdenIndice[$actCanon], $estatusOrdenIndice[$nuevCanon])
            && $estatusOrdenIndice[$nuevCanon] < $estatusOrdenIndice[$actCanon]
        ) {
            return ['success' => false, 'message' => 'No se puede regresar el estatus de la orden a una etapa anterior.'];
        }
        if (isset($estatusOrdenIndice[$nuevCanon])) {
            $estatus = $nuevCanon;
        }
        $cambiaEstatusOrden = ($actCanon !== $nuevCanon);
        if ($tecnicoRecibidoUpdate === '' && in_array($nuevCanon, ['En proceso', 'Terminado', 'Entregado'], true)) {
            $tecnicoRecibidoUpdate = $tecnicoRecepcion;
        }
        if ($cambiaEstatusOrden && in_array($nuevCanon, ['En proceso', 'Terminado'], true)) {
            if (
                ! $this->firmaGuardadaTieneTrazos($firmaClienteInicialPlano)
                || ! $this->firmaGuardadaTieneTrazos($firmaTecnicoInicialPlano)
            ) {
                return ['success' => false, 'message' => 'No se puede poner en En proceso o Terminado sin las firmas de Cliente y Técnico. Complétalas en la orden y guarda.'];
            }
        }
        if ($nuevCanon === 'Entregado' || ($entregaPorEquipo && $estatusEquipoSolicitado === 'Entregado')) {
            if (
                ! $this->firmaGuardadaTieneTrazos($firmaClienteFinalPlano)
                || ! $this->firmaGuardadaTieneTrazos($firmaTecnicoFinalPlano)
            ) {
                return ['success' => false, 'message' => 'Para guardar como Entregado, deben estar firmadas Cliente y Técnico.'];
            }
        }

        $recibidoClienteSolicitadoPlano = $this->textoMayusculas(trim((string) $request->input(
            'recibido_cliente',
            $request->input('recibidoCliente', '')
        )));
        $entregaQuienRecibe = mb_strtolower(trim((string) $request->input('entrega_quien_recibe', 'cliente')), 'UTF-8');
        if (
            $entregaPorEquipo
            && $estatusEquipoSolicitado === 'Entregado'
            && $entregaQuienRecibe === 'tercero'
            && mb_strlen($recibidoClienteSolicitadoPlano) < 3
        ) {
            return [
                'success' => false,
                'message' => 'Escribe el nombre completo del tercero que recoge el equipo.',
            ];
        }
        $recibidoClienteTPlano = $recibidoClienteSolicitadoPlano;
        if ($recibidoClienteTPlano === '') {
            $recibidoClienteTPlano = ($exT && isset($exT['recibido_cliente']))
                ? $this->vault->nombreClienteReveal($exT['recibido_cliente'])
                : $clienteRecibidoPlano;
        }
        if ($recibidoClienteTPlano === '') {
            $recibidoClienteTPlano = $clienteRecibidoPlano;
        }
        if (
            ($nuevCanon === 'Entregado' || ($entregaPorEquipo && $estatusEquipoSolicitado === 'Entregado'))
            && mb_strlen($recibidoClienteTPlano) < 3
        ) {
            return [
                'success' => false,
                'message' => 'Indica el nombre de quien recibe el equipo (cliente titular o tercero).',
            ];
        }

        if (
            $this->hasSalidaTemporalColumns()
            && in_array($nuevCanon, ['Terminado', 'Entregado'], true)
            && $this->isSalidaTemporalActiva($idOrdenEditar)
        ) {
            return ['success' => false, 'message' => $this->mensajeBloqueoSalidaTemporalActiva()];
        }

        [$fechaTerminada, $fechaSalida] = $this->fechasTallerSegunEstatus($nuevCanon, $fechaTerminada, $fechaSalida);

        try {
            DB::beginTransaction();

            $columns = [
                'folio', 'nombre_cliente', 'cliente_recibido', 'tecnico_recibido', 'tipo_servicio',
                'direccion', 'telefono', 'correo', 'poblacion',
                'fecha_entrada', 'fecha_terminada', 'fecha_salida', 'no_equipo',
                'observaciones', 'firma_c_e', 'firma_t_r', 'estatus',
            ];
            $values = [
                $folioStr, $nombreCliente, $clienteRecibido, $tecnicoRecibidoUpdate, $tipoServicioOrden,
                $direccionParaBd, $telefonoParaBd, $correo, $poblacion,
                $fechaEntrada, $fechaTerminada, $fechaSalida, $noEquipo,
                $observaciones, $firmaClienteInicial, $firmaTecnicoInicial, $estatus,
            ];
            $setParts = [];
            foreach ($columns as $col) {
                $setParts[] = '`'.str_replace('`', '', $col).'` = ?';
            }
            $sqlUpd = 'UPDATE orden_servicio_c SET '.implode(', ', $setParts).' WHERE id_orden_c = ?';
            $values[] = $idOrdenEditar;
            DB::update($sqlUpd, $values);

            $accionesPreviasEquipos = [];
            $entregaPreviaEquipos = [];
            $conAccionesEquipo = Schema::hasColumn('equipos_orden', 'acciones');
            $conReceptorEquipo = Schema::hasColumn('equipos_orden', 'entrega_receptor_tipo')
                && Schema::hasColumn('equipos_orden', 'entrega_recibido_cliente');
            $conDetalleEntregaEquipo = Schema::hasColumn('equipos_orden', 'entrega_firma_cliente')
                && Schema::hasColumn('equipos_orden', 'entrega_firma_tecnico')
                && Schema::hasColumn('equipos_orden', 'entrega_tecnico')
                && Schema::hasColumn('equipos_orden', 'entrega_fecha');
            if ($conAccionesEquipo || $conReceptorEquipo || $conDetalleEntregaEquipo) {
                $columnasPrevias = ['id_equipo'];
                if ($conAccionesEquipo) {
                    $columnasPrevias[] = 'acciones';
                }
                if ($conReceptorEquipo) {
                    $columnasPrevias[] = 'entrega_receptor_tipo';
                    $columnasPrevias[] = 'entrega_recibido_cliente';
                }
                if ($conDetalleEntregaEquipo) {
                    $columnasPrevias[] = 'entrega_firma_cliente';
                    $columnasPrevias[] = 'entrega_firma_tecnico';
                    $columnasPrevias[] = 'entrega_tecnico';
                    $columnasPrevias[] = 'entrega_fecha';
                }
                $eqPrev = DB::select(
                    'SELECT '.implode(', ', $columnasPrevias).' FROM equipos_orden WHERE id_orden_c = ? ORDER BY id_equipo ASC',
                    [$idOrdenEditar]
                );
                foreach ($eqPrev as $idx => $eqRow) {
                    if ($conAccionesEquipo) {
                        $accionesPreviasEquipos[$idx] = (int) ($eqRow->acciones ?? 0);
                    }
                    if ($conReceptorEquipo) {
                        $entregaPreviaEquipos[$idx] = [
                            'tipo' => $eqRow->entrega_receptor_tipo ?? null,
                            'nombre' => $eqRow->entrega_recibido_cliente ?? null,
                        ];
                    }
                    if ($conDetalleEntregaEquipo) {
                        $entregaPreviaEquipos[$idx] = array_merge(
                            $entregaPreviaEquipos[$idx] ?? [],
                            [
                                'firma_cliente' => $eqRow->entrega_firma_cliente ?? null,
                                'firma_tecnico' => $eqRow->entrega_firma_tecnico ?? null,
                                'tecnico' => $eqRow->entrega_tecnico ?? null,
                                'fecha' => $eqRow->entrega_fecha ?? null,
                            ]
                        );
                    }
                }
                // Aplicar estatus del equipo seleccionado (sin tocar el estatus de la orden).
                if ($entregaPorEquipo && $estatusEquipoSolicitado !== null && $equipoIndiceEntrega >= 1) {
                    $idxEntrega = $equipoIndiceEntrega - 1;
                    if ($estatusEquipoSolicitado === 'Terminado' && $conAccionesEquipo) {
                        $accionesPreviasEquipos[$idxEntrega] = max(
                            (int) ($accionesPreviasEquipos[$idxEntrega] ?? 0),
                            self::EQUIPO_ACCION_TERMINADO
                        );
                    } elseif ($estatusEquipoSolicitado === 'Entregado') {
                        if ($conAccionesEquipo) {
                            $accionesPreviasEquipos[$idxEntrega] = self::EQUIPO_ACCION_ENTREGADO;
                        }
                        if ($conReceptorEquipo) {
                            $entregaPreviaEquipos[$idxEntrega] = array_merge(
                                $entregaPreviaEquipos[$idxEntrega] ?? [],
                                [
                                    'tipo' => $entregaQuienRecibe === 'tercero' ? 'tercero' : 'cliente',
                                    'nombre' => $this->vault->nombreClienteSeal($recibidoClienteTPlano),
                                ]
                            );
                        }
                        if ($conDetalleEntregaEquipo) {
                            $entregaPreviaEquipos[$idxEntrega] = array_merge(
                                $entregaPreviaEquipos[$idxEntrega] ?? [],
                                [
                                    'firma_cliente' => $firmaClienteFinal,
                                    'firma_tecnico' => $firmaTecnicoFinal,
                                    'tecnico' => $this->vault->tecnicoNombreSeal($tecnicoInvolucrado),
                                    'fecha' => now()->format('Y-m-d H:i:s'),
                                ]
                            );
                        }
                    }
                }
            }

            DB::delete('DELETE FROM equipos_orden WHERE id_orden_c = ?', [$idOrdenEditar]);
            $equipoCols = ['id_orden_c', 'marca', 'modelo', 'serie', 'clave', 'tipo_servicio', 'descripcion_falla'];
            if (Schema::hasColumn('equipos_orden', 'acciones')) {
                $equipoCols[] = 'acciones';
            }
            if ($conReceptorEquipo) {
                $equipoCols[] = 'entrega_receptor_tipo';
                $equipoCols[] = 'entrega_recibido_cliente';
            }
            if ($conDetalleEntregaEquipo) {
                $equipoCols[] = 'entrega_firma_cliente';
                $equipoCols[] = 'entrega_firma_tecnico';
                $equipoCols[] = 'entrega_tecnico';
                $equipoCols[] = 'entrega_fecha';
            }
            $this->batchInsert(
                'equipos_orden',
                $equipoCols,
                $this->equipoInsertRows(
                    $idOrdenEditar,
                    $equiposIn,
                    $accionesPreviasEquipos,
                    $entregaPreviaEquipos
                )
            );

            // Asegurar acciones del equipo de entrega tras el reinsert (por índice 1..N).
            if (
                $entregaPorEquipo
                && $estatusEquipoSolicitado !== null
                && $equipoIndiceEntrega >= 1
                && Schema::hasColumn('equipos_orden', 'acciones')
            ) {
                $targetAccion = $estatusEquipoSolicitado === 'Entregado'
                    ? self::EQUIPO_ACCION_ENTREGADO
                    : ($estatusEquipoSolicitado === 'Terminado' ? self::EQUIPO_ACCION_TERMINADO : null);
                if ($targetAccion !== null) {
                    $equiposNuevos = DB::select(
                        'SELECT id_equipo, acciones FROM equipos_orden WHERE id_orden_c = ? ORDER BY id_equipo ASC',
                        [$idOrdenEditar]
                    );
                    $idx = $equipoIndiceEntrega - 1;
                    if (isset($equiposNuevos[$idx])) {
                        $idEqNuevo = (int) ($equiposNuevos[$idx]->id_equipo ?? 0);
                        $accAntes = (int) ($equiposNuevos[$idx]->acciones ?? 0);
                        $accFinal = max($accAntes, $targetAccion);
                        if ($idEqNuevo > 0) {
                            if ($estatusEquipoSolicitado === 'Entregado' && $conDetalleEntregaEquipo) {
                                DB::update(
                                    'UPDATE equipos_orden
                                     SET acciones = ?, entrega_firma_cliente = ?, entrega_firma_tecnico = ?,
                                         entrega_tecnico = ?, entrega_fecha = ?
                                     WHERE id_equipo = ? AND id_orden_c = ?',
                                    [
                                        $accFinal,
                                        $firmaClienteFinal,
                                        $firmaTecnicoFinal,
                                        $this->vault->tecnicoNombreSeal($tecnicoInvolucrado),
                                        now()->format('Y-m-d H:i:s'),
                                        $idEqNuevo,
                                        $idOrdenEditar,
                                    ]
                                );
                            } else {
                                DB::update(
                                    'UPDATE equipos_orden SET acciones = ? WHERE id_equipo = ? AND id_orden_c = ?',
                                    [$accFinal, $idEqNuevo, $idOrdenEditar]
                                );
                            }
                        }
                    }
                }
            }

            $idTrabajo = null;
            if ($exT && isset($exT['id_trabajo'])) {
                $idTrabajo = (int) $exT['id_trabajo'];
            } else {
                DB::insert(
                    'INSERT INTO orden_servicio_t (id_orden_c, tecnico_recibido, subtotal_t, subtotal_m, iva, total_pagar, firma_c_r, firma_t_e, comentarios_m) VALUES (?, ?, 0, 0, 0, 0, NULL, NULL, NULL)',
                    [$idOrdenEditar, $tecnicoRecibidoUpdate]
                );
                $idTrabajo = (int) DB::getPdo()->lastInsertId();
            }

            DB::delete('DELETE FROM trabajos_orden WHERE id_trabajo = ?', [$idTrabajo]);
            DB::delete('DELETE FROM materiales_orden WHERE id_trabajo = ?', [$idTrabajo]);

            $recibidoClienteT = $this->vault->nombreClienteSeal($recibidoClienteTPlano);
            $tecnicoRecibidoT = ($exT && isset($exT['tecnico_recibido']))
                ? $this->tecnicoRecibidoLegibleDesdeBd((string) $exT['tecnico_recibido'])
                : '';
            if ($tecnicoRecibidoT === '') {
                $tecnicoRecibidoT = $tecnicoRecibidoUpdate;
            }
            $entregadoPorTecnicoT = ($exT && array_key_exists('entregado_por_tecnico', $exT))
                ? $this->tecnicoRecibidoLegibleDesdeBd((string) $exT['entregado_por_tecnico'])
                : '';
            if ($nuevCanon === 'Entregado' || ($entregaPorEquipo && $estatusEquipoSolicitado === 'Entregado')) {
                $entregadoPorTecnicoT = $tecnicoInvolucrado;
            }

            // Entrega individual: receptor y firmas solo en equipos_orden, no pisar orden_servicio_t.
            $recibidoClienteParaTablaT = $recibidoClienteT;
            if ($esEntregaIndividual && $exT) {
                $recibidoClienteParaTablaT = $exT['recibido_cliente'] ?? null;
            }

            $tColumnsUpd = [
                'recibido_cliente',
                'tecnico_recibido',
                'entregado_por_tecnico',
                'subtotal_t',
                'subtotal_m',
                'iva',
                'total_pagar',
                'comentarios_m',
            ];
            $tValuesUpd = [
                $recibidoClienteParaTablaT,
                $tecnicoRecibidoT,
                $entregadoPorTecnicoT,
                $subtotalTrabajos,
                $subtotalMateriales,
                $ivaTotal,
                $totalPagar,
                $comentariosTecnico,
            ];
            if (! $esEntregaIndividual) {
                $tColumnsUpd[] = 'firma_c_r';
                $tColumnsUpd[] = 'firma_t_e';
                $tValuesUpd[] = $firmaClienteFinal;
                $tValuesUpd[] = $firmaTecnicoFinal;
            }
            $setT = implode(', ', array_map(fn ($c) => '`'.str_replace('`', '', $c).'` = ?', $tColumnsUpd));
            $tValuesUpd[] = $idTrabajo;
            DB::update("UPDATE orden_servicio_t SET $setT WHERE id_trabajo = ?", $tValuesUpd);
            $this->batchInsert(
                'trabajos_orden',
                ['id_trabajo', 'clave', 'descripcion', 'importe', 'ticket', 'id_equipo'],
                $this->trabajoInsertRows($idTrabajo, $trabajosIn, null)
            );
            $this->batchInsert(
                'materiales_orden',
                ['id_trabajo', 'vale', 'codigo', 'cantidad', 'descripcion', 'anticipo', 'precio_unitario', 'importe', 'ticket', 'id_equipo'],
                $this->materialInsertRows($idTrabajo, $materialesIn, $anticiposIn, $abonoSaldoTotal, null)
            );

            // Cada técnico que guarda/edita entra a Involucrados (sin repetir el mismo seguido).
            if ($tecnicoInvolucrado !== '') {
                $this->registrarInvolucradoSiCambio($idOrdenEditar, $estatus, $tecnicoInvolucrado);
            }

            $this->rebuildSearchIndex($idOrdenEditar, $nombreClientePlano, $telefono, $correoPlano);

            DB::commit();
        } catch (\Throwable $e) {
            if (DB::transactionLevel() > 0) {
                DB::rollBack();
            }

            return ['success' => false, 'message' => '❌ Error: '.$e->getMessage()];
        }

        $this->audit->log($idOrdenEditar, $folioStr, 'orden_actualizada', [
            'estatus_anterior' => $actCanon,
            'estatus_nuevo' => $estatus,
            'modo_completar' => $modoCompletar,
            'equipos' => $noEquipo,
            'subtotal_trabajos' => $subtotalTrabajos,
            'subtotal_materiales' => $subtotalMateriales,
            'total' => $totalPagar,
        ]);

        $notificaciones = [
            'email' => ['message' => null, 'level' => null],
            'whatsapp' => ['message' => null, 'level' => null],
            'whatsapp_notification_id' => null,
            'whatsapp_applicable' => false,
        ];
        // Entrega por equipo Entregado: notifica solo ese equipo (PDF filtrado). No cambia estatus de orden.
        if ($entregaPorEquipo && $estatusEquipoSolicitado === 'Entregado' && $equipoIndiceEntrega >= 1) {
            $equiposFiltrados = [];
            $i = 0;
            foreach ($equiposIn as $eqItem) {
                if (! is_array($eqItem)) {
                    continue;
                }
                $i++;
                if ($i === $equipoIndiceEntrega) {
                    $equiposFiltrados = [$eqItem];
                    break;
                }
            }
            if ($equiposFiltrados === []) {
                return [
                    'success' => false,
                    'message' => 'No se encontró el equipo seleccionado para notificar. Revisa la fila del camión e inténtalo de nuevo.',
                ];
            }
            $notificaciones = $this->dispatchStatusNotifications(
                $idOrdenEditar,
                'Entregado',
                $folioStr,
                $nombreClientePlano,
                $telefono,
                $correoPlano,
                $poblacionPlano,
                $totalPagar,
                $equiposFiltrados,
                true,
                true,
                [
                    'equipo_indice' => $equipoIndiceEntrega,
                    'id_equipo' => $idEquipoEntregaResuelto,
                    'entrega_por_equipo' => 1,
                    'recibido_cliente' => $recibidoClienteTPlano,
                ]
            );
        } else {
            $confirmaTerminado = $nuevCanon === 'Terminado';
            $debeNotificarCliente = ($cambiaEstatusOrden || $confirmaTerminado)
                && in_array($nuevCanon, self::ESTATUS_NOTIFICACION_CLIENTE, true)
                && ! ($entregaPorEquipo && $estatusEquipoSolicitado === 'Terminado');
            if ($debeNotificarCliente) {
                $notificaciones = $this->dispatchStatusNotifications(
                    $idOrdenEditar,
                    $nuevCanon,
                    $folioStr,
                    $nombreClientePlano,
                    $telefono,
                    $correoPlano,
                    $poblacionPlano,
                    $totalPagar,
                    $equiposIn,
                    $cambiaEstatusOrden,
                    $confirmaTerminado
                );
            }
        }

        $mensajeOk = "✅ Orden $folioStr actualizada correctamente";
        if ($entregaPorEquipo && $estatusEquipoSolicitado === 'Terminado') {
            $mensajeOk = "✅ Equipo marcado como Terminado (uso interno). La orden sigue en «{$actCanon}».";
        } elseif ($entregaPorEquipo && $estatusEquipoSolicitado === 'Entregado') {
            $mensajeOk = "✅ Equipo entregado. Se envió la orden de servicio solo de ese equipo. La orden sigue en «{$actCanon}».";
        }

        $emailNotice = $notificaciones['email'];
        $whatsappNotice = $notificaciones['whatsapp'];

        try {
            $this->editLocks->release($idOrdenEditar);
        } catch (\Throwable $e) {
            report($e);
        }

        return [
            'success' => true,
            'message' => $mensajeOk,
            'folio' => $folioStr,
            'idOrden' => $idOrdenEditar,
            'estatus_orden' => $actCanon,
            'equipo_indice' => $entregaPorEquipo ? $equipoIndiceEntrega : null,
            'equipo_acciones' => ($entregaPorEquipo && $estatusEquipoSolicitado === 'Entregado')
                ? self::EQUIPO_ACCION_ENTREGADO
                : (($entregaPorEquipo && $estatusEquipoSolicitado === 'Terminado') ? self::EQUIPO_ACCION_TERMINADO : null),
            'reporte_url' => ($entregaPorEquipo && $estatusEquipoSolicitado === 'Entregado' && $equipoIndiceEntrega >= 1)
                ? url('/pdf/orden/'.$idOrdenEditar).'?'.http_build_query([
                    'eq' => $equipoIndiceEntrega,
                    'inline' => 1,
                    '_' => time(),
                ])
                : null,
            'email_notice' => $emailNotice['message'],
            'email_notice_level' => $emailNotice['level'],
            'whatsapp_notice' => $whatsappNotice['message'],
            'whatsapp_notice_level' => $whatsappNotice['level'],
            'whatsapp_notification_id' => $notificaciones['whatsapp_notification_id'] ?? null,
            'whatsapp_applicable' => (bool) ($notificaciones['whatsapp_applicable'] ?? false),
            'ask_salida_temporal' => $this->askSalidaTemporalFlag($idOrdenEditar, $nuevCanon),
            'salida_temporal_activa' => $this->isSalidaTemporalActiva($idOrdenEditar),
        ];
    }

    /**
     * @param  array<mixed>  $equiposIn
     * @param  array<mixed>  $trabajosIn
     * @param  list<array<string, mixed>>  $materialesIn
     * @param  list<array{folio: string, descripcion: string, monto: float, ticket: string}>  $anticiposIn
     * @return array{success: bool, message: string, folio?: string, idOrden?: int}
     */
    private function handleInsert(
        Request $request,
        mixed $folio,
        string $nombreCliente,
        string $clienteRecibido,
        string $tecnicoRecibido,
        string $tipoServicioOrden,
        string $direccionParaBd,
        string $telefonoParaBd,
        string $correo,
        string $poblacion,
        mixed $fechaEntrada,
        mixed $fechaTerminadaPost,
        mixed $fechaSalidaPost,
        int $noEquipo,
        string $observaciones,
        string $estatus,
        float $subtotalTrabajos,
        float $subtotalMateriales,
        float $ivaTotal,
        float $totalPagar,
        mixed $comentariosTecnico,
        string $nombreClientePlano,
        string $telefono,
        string $correoPlano,
        string $poblacionPlano,
        array $equiposIn,
        array $trabajosIn,
        array $materialesIn,
        array $anticiposIn,
        float $abonoSaldoTotal
    ): array {
        try {
            $insertResult = DB::transaction(function () use (
                $folio,
                $nombreCliente,
                $clienteRecibido,
                $tecnicoRecibido,
                $tipoServicioOrden,
                $direccionParaBd,
                $telefonoParaBd,
                $correo,
                $poblacion,
                $fechaEntrada,
                $fechaTerminadaPost,
                $fechaSalidaPost,
                $noEquipo,
                $observaciones,
                $estatus,
                $subtotalTrabajos,
                $subtotalMateriales,
                $ivaTotal,
                $totalPagar,
                $comentariosTecnico,
                $request,
                $nombreClientePlano,
                $telefono,
                $correoPlano,
                $equiposIn,
                $trabajosIn,
                $materialesIn,
                $anticiposIn,
                $abonoSaldoTotal
            ) {
                $estCanonIns = $this->mapEstatusCanon($estatus);
                [$fechaTerminadaPost, $fechaSalidaPost] = $this->fechasTallerSegunEstatus($estCanonIns, $fechaTerminadaPost, $fechaSalidaPost);

                $folioReserva = $this->reservarFolio($this->folioYearFromValue(is_string($folio) ? $folio : null));
                $folioNuevo = $folioReserva['folio'];

                $firmaClienteInicial = $this->vault->firmaRutaSeal($this->guardarFirma($request->input('firmaClienteInicial'), 'firma_cliente_inicial', $folioNuevo));
                $firmaTecnicoInicial = $this->vault->firmaRutaSeal($this->guardarFirma($request->input('firmaTecnicoInicial'), 'firma_tecnico_inicial', $folioNuevo));

                $columns = [
                    'folio', 'nombre_cliente', 'cliente_recibido', 'tecnico_recibido', 'tipo_servicio',
                    'direccion', 'telefono', 'correo', 'poblacion',
                    'fecha_entrada', 'fecha_terminada', 'fecha_salida', 'no_equipo',
                    'observaciones', 'firma_c_e', 'firma_t_r', 'estatus',
                ];
                $values = [
                    $folioNuevo, $nombreCliente, $clienteRecibido, $tecnicoRecibido, $tipoServicioOrden,
                    $direccionParaBd, $telefonoParaBd, $correo, $poblacion,
                    $fechaEntrada, $fechaTerminadaPost, $fechaSalidaPost, $noEquipo,
                    $observaciones, $firmaClienteInicial, $firmaTecnicoInicial, $estatus,
                ];
                $placeholders = implode(', ', array_fill(0, count($columns), '?'));
                $sqlC = 'INSERT INTO orden_servicio_c ('.implode(', ', $columns).") VALUES ($placeholders)";
                DB::insert($sqlC, $values);
                $idOrdenC = (int) DB::getPdo()->lastInsertId();

                $this->rebuildSearchIndex($idOrdenC, $nombreClientePlano, $telefono, $correoPlano);
                $equipoColsIns = ['id_orden_c', 'marca', 'modelo', 'serie', 'clave', 'tipo_servicio', 'descripcion_falla'];
                if (Schema::hasColumn('equipos_orden', 'acciones')) {
                    $equipoColsIns[] = 'acciones';
                }
                if (
                    Schema::hasColumn('equipos_orden', 'entrega_receptor_tipo')
                    && Schema::hasColumn('equipos_orden', 'entrega_recibido_cliente')
                ) {
                    $equipoColsIns[] = 'entrega_receptor_tipo';
                    $equipoColsIns[] = 'entrega_recibido_cliente';
                }
                if (
                    Schema::hasColumn('equipos_orden', 'entrega_firma_cliente')
                    && Schema::hasColumn('equipos_orden', 'entrega_firma_tecnico')
                    && Schema::hasColumn('equipos_orden', 'entrega_tecnico')
                    && Schema::hasColumn('equipos_orden', 'entrega_fecha')
                ) {
                    $equipoColsIns[] = 'entrega_firma_cliente';
                    $equipoColsIns[] = 'entrega_firma_tecnico';
                    $equipoColsIns[] = 'entrega_tecnico';
                    $equipoColsIns[] = 'entrega_fecha';
                }
                $this->batchInsert(
                    'equipos_orden',
                    $equipoColsIns,
                    $this->equipoInsertRows($idOrdenC, $equiposIn)
                );

                $firmaClienteFinal = $this->vault->firmaRutaSeal($this->guardarFirma($request->input('firmaCliente'), 'firma_cliente_final', $folioNuevo));
                $firmaTecnicoFinal = $this->vault->firmaRutaSeal($this->guardarFirma($request->input('firmaTecnico'), 'firma_tecnico_final', $folioNuevo));

                $entregadoPorNuevo = ($estCanonIns === 'Entregado')
                    ? trim(ExactoAuthContext::nombreTecnicoSesionActual())
                    : null;

                $tColumns = [
                    'id_orden_c', 'recibido_cliente', 'tecnico_recibido', 'entregado_por_tecnico',
                    'subtotal_t', 'subtotal_m', 'iva', 'total_pagar', 'firma_c_r', 'firma_t_e', 'comentarios_m',
                ];
                $tValues = [
                    $idOrdenC, $clienteRecibido, $tecnicoRecibido, $entregadoPorNuevo,
                    $subtotalTrabajos, $subtotalMateriales, $ivaTotal, $totalPagar,
                    $firmaClienteFinal, $firmaTecnicoFinal, $comentariosTecnico,
                ];
                $placeholdersT = implode(', ', array_fill(0, count($tColumns), '?'));
                $sqlT = 'INSERT INTO orden_servicio_t ('.implode(', ', $tColumns).") VALUES ($placeholdersT)";
                DB::insert($sqlT, $tValues);
                $idTrabajo = (int) DB::getPdo()->lastInsertId();
                $this->batchInsert(
                    'trabajos_orden',
                    ['id_trabajo', 'clave', 'descripcion', 'importe', 'ticket', 'id_equipo'],
                    $this->trabajoInsertRows($idTrabajo, $trabajosIn, null)
                );
                $this->batchInsert(
                    'materiales_orden',
                    ['id_trabajo', 'vale', 'codigo', 'cantidad', 'descripcion', 'anticipo', 'precio_unitario', 'importe', 'ticket', 'id_equipo'],
                    $this->materialInsertRows($idTrabajo, $materialesIn, $anticiposIn, $abonoSaldoTotal, null)
                );

                // 1) Técnico de recepción; 2) quien capturó si es otra persona.
                if (trim($tecnicoRecibido) !== '') {
                    $this->registrarInvolucradoEnLog($idOrdenC, $estatus, trim($tecnicoRecibido));
                }
                $tecnicoLog = trim(ExactoAuthContext::nombreTecnicoSesionActual());
                if ($tecnicoLog !== '' && strcasecmp($tecnicoLog, trim($tecnicoRecibido)) !== 0) {
                    $this->registrarInvolucradoSiCambio($idOrdenC, $estatus, $tecnicoLog);
                }

                return [
                    'folio' => $folioNuevo,
                    'idOrden' => $idOrdenC,
                    'folio_reutilizado' => (bool) ($folioReserva['reutilizado'] ?? false),
                    'folio_numero' => (int) ($folioReserva['numero'] ?? 0),
                    'folio_anio' => (int) ($folioReserva['anio'] ?? 0),
                ];
            });
        } catch (\Throwable $e) {
            return ['success' => false, 'message' => '❌ Error: '.$e->getMessage()];
        }

        $this->audit->log((int) $insertResult['idOrden'], $insertResult['folio'], 'orden_creada', [
            'estatus' => $estatus,
            'equipos' => $noEquipo,
            'subtotal_trabajos' => $subtotalTrabajos,
            'subtotal_materiales' => $subtotalMateriales,
            'total' => $totalPagar,
        ]);
        if (! empty($insertResult['folio_reutilizado'])) {
            $this->audit->log((int) $insertResult['idOrden'], $insertResult['folio'], 'folio_reutilizado', [
                'anio' => (int) ($insertResult['folio_anio'] ?? 0),
                'numero' => (int) ($insertResult['folio_numero'] ?? 0),
                'motivo' => 'Hueco libre reutilizado al crear la orden',
            ]);
        }

        $estatusCanonIns = $this->mapEstatusCanon($estatus);
        $notificaciones = in_array($estatusCanonIns, self::ESTATUS_NOTIFICACION_CLIENTE, true)
            ? $this->dispatchStatusNotifications(
                (int) $insertResult['idOrden'],
                $estatusCanonIns,
                (string) $insertResult['folio'],
                $nombreClientePlano,
                $telefono,
                $correoPlano,
                $poblacionPlano,
                $totalPagar,
                $equiposIn
            )
            : [
                'email' => ['message' => null, 'level' => null],
                'whatsapp' => ['message' => null, 'level' => null],
                'whatsapp_notification_id' => null,
                'whatsapp_applicable' => false,
            ];
        $emailNotice = $notificaciones['email'];
        $whatsappNotice = $notificaciones['whatsapp'];

        $idInsertado = (int) $insertResult['idOrden'];
        $estatusInsert = OrderStatus::map((string) $estatus);

        return [
            'success' => true,
            'message' => '✅ Orden de servicio '.$insertResult['folio'].' registrada correctamente',
            'folio' => $insertResult['folio'],
            'idOrden' => $idInsertado,
            'email_notice' => $emailNotice['message'],
            'email_notice_level' => $emailNotice['level'],
            'whatsapp_notice' => $whatsappNotice['message'],
            'whatsapp_notice_level' => $whatsappNotice['level'],
            'whatsapp_notification_id' => $notificaciones['whatsapp_notification_id'] ?? null,
            'whatsapp_applicable' => (bool) ($notificaciones['whatsapp_applicable'] ?? false),
            'ask_salida_temporal' => $this->askSalidaTemporalFlag($idInsertado, $estatusInsert),
            'salida_temporal_activa' => $this->isSalidaTemporalActiva($idInsertado),
        ];
    }
}
