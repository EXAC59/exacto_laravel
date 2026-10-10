<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Requests\UpdateOrderStatusRequest;
use App\Models\User;
use App\Services\EquipoEntregaResolver;
use App\Services\OrdenListService;
use App\Services\OrdenStatusService;
use App\Services\RegistrarOrdenService;
use App\Support\ExactoAuthContext;
use App\Support\ExactoUtf8;
use App\Support\MaterialesOrdenClassifier;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;
use Illuminate\View\View;

class OrderController extends Controller
{
    public function __construct(
        private readonly OrdenListService $listService,
        private readonly OrdenStatusService $statusService,
        private readonly RegistrarOrdenService $registrarService,
        private readonly EquipoEntregaResolver $entregaResolver
    ) {}

    public function index(): View
    {
        $user = Auth::user();
        abort_unless($user, 403);

        $nombreTecnico = htmlspecialchars(
            (string) (session('nombre_tecnico') ?? $user->nombre_tecnico ?? ''),
            ENT_QUOTES,
            'UTF-8'
        );
        $nav_activo = 'ordenes';
        $pageTitle = ExactoUtf8::fromCodepoint(0x00D3).'rdenes de Servicio - Exacto';
        $pageHeadExtra = '';

        return view('orders.index', compact(
            'nombreTecnico',
            'nav_activo',
            'pageTitle',
            'pageHeadExtra'
        ));
    }

    public function list(Request $request): JsonResponse
    {
        $user = ExactoAuthContext::currentUser();
        if (! $user instanceof User) {
            return response()->json(['success' => false, 'message' => 'No autorizado'], 401);
        }

        $search = trim((string) $request->query('search', ''));
        $startDate = trim((string) $request->query('startDate', ''));
        $endDate = trim((string) $request->query('endDate', ''));
        $estatus = trim((string) $request->query('estatus', 'todos'));
        $page = max(1, (int) $request->query('page', 1));
        $perPage = (int) $request->query('perPage', 10);
        $sortRaw = trim((string) $request->query('sort', 'fecha'));
        $sort = $sortRaw === 'estatus' ? 'estatus' : 'fecha';

        try {
            $result = $this->listService->listForRequest($user, $search, $startDate, $endDate, $estatus, $page, $perPage, $sort);
        } catch (\Throwable $e) {
            report($e);

            return response()->json([
                'success' => false,
                'message' => 'No se pudo cargar el listado de órdenes. Revisa que estén subidos OrderStatus.php y OrdenListService.php actualizados.',
            ], 500);
        }

        return response()->json(
            $result,
            200,
            ['Content-Type' => 'application/json; charset=UTF-8'],
            JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
        );
    }

    public function updateStatus(UpdateOrderStatusRequest $request): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['success' => false, 'message' => 'No autorizado'], 401);
        }

        $id = (int) $request->input('id', 0);
        $estatus = trim((string) $request->input('estatus', ''));
        if ($id > 0) {
            Gate::authorize('order-access', $id);
        }
        $result = $this->statusService->updateStatus($user, $id, $estatus);

        return response()->json($result, $result['success'] ? 200 : 400);
    }

    public function registrar(Request $request): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['success' => false, 'message' => 'No autorizado'], 401);
        }

        try {
            $result = $this->registrarService->handle($request, $user);
        } catch (\Throwable $e) {
            Log::channel('exacto_ops')->error('order_registrar_exception', [
                'user_id' => $user->id_tecnico ?? null,
                'error' => $e->getMessage(),
                'exception' => $e::class,
            ]);

            return response()->json([
                'success' => false,
                'message' => 'No se pudo confirmar el guardado. Reintenta desde este formulario; se recuperará la orden si ya fue registrada.',
            ], 500);
        }

        $statusCode = $result['success'] ? 200 : 400;
        if (($result['code'] ?? '') === 'order_submission_schema_missing') {
            $statusCode = 503;
        }
        if (($result['processing'] ?? false) || ($result['duplicate_submit'] ?? false)) {
            $statusCode = 202;
        }

        return response()->json($result, $statusCode);
    }

    public function whatsappEstado(int $id): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['success' => false, 'message' => 'No autorizado'], 401);
        }

        $row = DB::table('order_whatsapp_notifications')->where('id', $id)->first();
        if (! $row) {
            return response()->json([
                'success' => false,
                'message' => 'Notificación de WhatsApp no encontrada.',
                'settled' => true,
            ], 404);
        }

        Gate::authorize('order-access', (int) ($row->id_orden_c ?? 0));

        $status = trim((string) ($row->status ?? ''));
        $providerMessage = trim((string) ($row->message ?? ''));

        if (in_array($status, ['delivered', 'read'], true)) {
            return response()->json([
                'success' => true,
                'status' => $status,
                'level' => 'success',
                'message' => 'WhatsApp entregado al cliente.',
                'settled' => true,
            ]);
        }

        if ($status === 'failed') {
            return response()->json([
                'success' => true,
                'status' => $status,
                'level' => 'error',
                'message' => $providerMessage !== ''
                    ? '✖ WhatsApp no entregado: '.$providerMessage
                    : '✖ El número no existe o no recibió el mensaje en WhatsApp.',
                'settled' => true,
            ]);
        }

        return response()->json([
            'success' => true,
            'status' => $status !== '' ? $status : 'accepted',
            'level' => 'success',
            'message' => 'WhatsApp enviado. Pendiente de confirmación de entrega.',
            'settled' => false,
        ]);
    }

    public function reenviar(Request $request, int $id): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['success' => false, 'message' => 'No autorizado'], 401);
        }

        Gate::authorize('order-access', $id);

        try {
            $result = $this->registrarService->reenviarRecepcion($id, $request);
        } catch (\Throwable $e) {
            Log::channel('exacto_ops')->error('order_reenviar_exception', [
                'id_orden_c' => $id,
                'user_id' => $user->id_tecnico ?? null,
                'error' => $e->getMessage(),
                'exception' => $e::class,
            ]);

            return response()->json([
                'success' => false,
                'message' => '❌ Error al reenviar: '.$e->getMessage(),
            ], 500);
        }

        $statusCode = ($result['success'] ?? false) ? 200 : 400;

        return response()->json($result, $statusCode);
    }

    public function salidaTemporal(Request $request, int $id): JsonResponse
    {
        $user = Auth::user();
        if (! $user instanceof User) {
            return response()->json(['success' => false, 'message' => 'No autorizado'], 401);
        }

        Gate::authorize('order-access', $id);

        $result = $this->registrarService->confirmarSalidaTemporal(
            $user,
            $id,
            (string) $request->input('motivo', ''),
            $request->input('firma_cliente'),
            $request->input('firma_tecnico')
        );

        return response()->json($result, ($result['success'] ?? false) ? 200 : 422);
    }

    public function regresoTemporal(int $id): JsonResponse
    {
        $user = Auth::user();
        if (! $user instanceof User) {
            return response()->json(['success' => false, 'message' => 'No autorizado'], 401);
        }

        Gate::authorize('order-access', $id);

        $result = $this->registrarService->registrarRegresoTemporal($user, $id);

        return response()->json($result, ($result['success'] ?? false) ? 200 : 422);
    }

    public function validarSaldo(Request $request): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['success' => false, 'message' => 'No autorizado'], 401);
        }

        $id = (int) $request->input('id_orden', 0);
        if ($id <= 0) {
            return response()->json(['success' => false, 'message' => 'Orden inválida.'], 400);
        }

        Gate::authorize('order-access', $id);

        // Consultar datos de la orden
        $cabecera = DB::table('orden_servicio_c')->where('id_orden_c', $id)->first();
        $trabajos = DB::table('orden_servicio_t')->where('id_orden_c', $id)->first();

        if (! $cabecera || ! $trabajos) {
            return response()->json(['success' => false, 'message' => 'Orden no encontrada.'], 404);
        }

        // Lógica de cálculo idéntica a RegistrarOrdenService.php
        // Todo el formulario captura montos SIN IVA. El 16% solo se aplica en totales.
        $subtotalNeto = (float) ($trabajos->subtotal_t + $trabajos->subtotal_m);
        $ivaTotal = round($subtotalNeto * 0.16, 2);
        $totalPagar = round($subtotalNeto + $ivaTotal, 2);

        // Obtener anticipos y abono saldo desde materiales_orden (única fuente persistida de pagos)
        $anticipoTotal = 0.0;
        $abonoSaldoTotal = 0.0;
        $materialesRaw = DB::table('materiales_orden')->where('id_trabajo', $trabajos->id_trabajo)->get();
        foreach ($materialesRaw as $materialRaw) {
            $materialArr = (array) $materialRaw;
            $anticipoMaterial = (float) ($materialArr['anticipo'] ?? 0);
            $tipoFila = class_exists(MaterialesOrdenClassifier::class)
                ? MaterialesOrdenClassifier::classify($materialArr)
                : 'material';
            if ($tipoFila === 'abono') {
                $abonoSaldoTotal += $anticipoMaterial;
            } elseif ($tipoFila === 'anticipo') {
                $anticipoTotal += $anticipoMaterial;
            }
        }

        // Calcular total recibido (anticipos + abono) con IVA
        $totalRecibido = round(($anticipoTotal + $abonoSaldoTotal) * 1.16, 2);

        // Calcular saldo pendiente
        $saldoPendiente = round($totalPagar - $totalRecibido, 2);
        if (abs($saldoPendiente) <= 0.011) {
            $saldoPendiente = 0.0;
        }

        // Tolerancia de redondeo de $0.01
        $valid = abs($saldoPendiente) <= 0.009;

        return response()->json([
            'success' => true,
            'valid' => $valid,
            'saldo_pendiente' => number_format($saldoPendiente, 2),
            'message' => $valid ? 'Saldo liquidado' : ($saldoPendiente < 0
                ? 'Los pagos exceden el total de la orden. Revisa los pagos registrados.'
                : 'Queda un saldo pendiente de $'.number_format($saldoPendiente, 2)),
            'total_pagar' => number_format($totalPagar, 2),
            'total_recibido' => number_format($totalRecibido, 2),
            'subtotal' => number_format($subtotalNeto, 2),
            'iva' => number_format($ivaTotal, 2),
        ]);
    }

    public function equiposEntregados(int $id): JsonResponse
    {
        if ($id <= 0) {
            return response()->json(['success' => false, 'message' => 'Orden inválida.'], 400);
        }

        Gate::authorize('order-access', $id);

        $orden = DB::selectOne(
            'SELECT c.fecha_salida, c.nombre_cliente, t.recibido_cliente, t.entregado_por_tecnico
             FROM orden_servicio_c c
             LEFT JOIN orden_servicio_t t ON t.id_trabajo = (
                 SELECT MIN(t2.id_trabajo) FROM orden_servicio_t t2 WHERE t2.id_orden_c = c.id_orden_c
             )
             WHERE c.id_orden_c = ?',
            [$id]
        );
        if (! $orden) {
            return response()->json(['success' => false, 'message' => 'Orden no encontrada.'], 404);
        }

        $equipos = DB::select(
            'SELECT * FROM equipos_orden WHERE id_orden_c = ? ORDER BY id_equipo ASC',
            [$id]
        );
        $entregas = $this->entregaResolver->resolveAll($id, $equipos, (array) $orden);
        $resultado = [];
        foreach ($equipos as $idx => $equipo) {
            if ((int) ($equipo->acciones ?? 0) !== 2) {
                continue;
            }

            $indice = $idx + 1;
            $entrega = $entregas[$indice] ?? [];

            $resultado[] = [
                'indice' => $indice,
                'marca' => trim((string) ($equipo->marca ?? '')),
                'modelo' => trim((string) ($equipo->modelo ?? '')),
                'serie' => trim((string) ($equipo->serie ?? '')),
                'receptor' => (string) ($entrega['receptor'] ?? ''),
                'receptor_tipo' => (string) ($entrega['receptor_tipo'] ?? 'cliente'),
                'fecha_entrega' => $entrega['fecha_entrega'] ?? null,
                'tecnico' => (string) ($entrega['tecnico'] ?? ''),
                'pdf_url' => route('pdf.orden', [
                    'id' => $id,
                    'eq' => $indice,
                    'inline' => 1,
                    'refresh_pdf' => 1,
                    'nocache' => 1,
                ]),
            ];
        }
        return response()->json([
            'success' => true,
            'data' => $resultado,
        ]);
    }

    public function liquidarSaldoEquipo(Request $request): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['success' => false, 'message' => 'No autorizado'], 401);
        }

        $id = (int) $request->input('id_orden', 0);

        if ($id <= 0) {
            return response()->json(['success' => false, 'message' => 'Orden inválida.'], 400);
        }
        Gate::authorize('order-access', $id);

        // Este endpoint legado no registra pagos y no lo usa el formulario actual.
        // La liquidación se guarda mediante registrar, que valida pagos y firmas.
        return response()->json([
            'success' => false,
            'message' => 'Liquida el saldo y guarda desde el formulario de la orden de servicio.',
        ], 409);
    }
}
