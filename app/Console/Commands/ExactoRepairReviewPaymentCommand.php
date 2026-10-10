<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\OrdenAuditService;
use App\Support\MaterialesOrdenClassifier;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

final class ExactoRepairReviewPaymentCommand extends Command
{
    protected $signature = 'exacto:repair-review-payment {--apply : Corregir después de respaldar el registro}';

    protected $description = 'Verifica y repara únicamente el abono duplicado de OS-2026-063/0063';

    public function handle(OrdenAuditService $audit): int
    {
        try {
            return DB::transaction(function () use ($audit): int {
                $orders = DB::table('orden_servicio_c')->whereIn('folio', ['OS-2026-063', 'OS-2026-0063'])->lockForUpdate()->get();
                if ($orders->count() !== 1) {
                    throw new \RuntimeException('Debe existir exactamente una orden OS-2026-063/0063. No se modificó ningún registro.');
                }
                $order = $orders->first();
                $totals = DB::table('orden_servicio_t')->where('id_orden_c', $order->id_orden_c)->lockForUpdate()->get();
                if ($totals->count() !== 1 || abs((float) $totals->first()->total_pagar - 700) > 0.009) {
                    throw new \RuntimeException('Los totales cambiaron o están duplicados. No se modificó ningún registro.');
                }
                $total = $totals->first();
                $jobs = DB::table('trabajos_orden')->where('id_trabajo', $total->id_trabajo)->lockForUpdate()->get();
                $materials = DB::table('materiales_orden')->where('id_trabajo', $total->id_trabajo)->lockForUpdate()->get();
                if ($jobs->count() !== 1 || strtoupper((string) $jobs->first()->clave) !== 'SERSOP01'
                    || abs((float) $jobs->first()->importe - 603.45) > 0.009
                    || abs((float) $total->subtotal_t - 603.45) > 0.009
                    || abs((float) $total->subtotal_m) > 0.009
                    || $materials->count() !== 1
                    || MaterialesOrdenClassifier::classify((array) $materials->first()) !== 'abono') {
                    throw new \RuntimeException('El detalle no coincide con el caso de revisión de $700. No se modificó ningún registro.');
                }
                $payment = $materials->first();
                if (abs((float) $payment->anticipo - 603.45) <= 0.009) {
                    $this->info('El abono ya es correcto: pago $700.00, saldo $0.00.');

                    return self::SUCCESS;
                }
                if (abs((float) $payment->anticipo - 1206.90) > 0.009) {
                    throw new \RuntimeException('El abono cambió; se esperaba 1206.90 sin IVA. No se modificó ningún registro.');
                }
                $this->line('Orden '.$order->folio.': total $700.00; pago registrado $1,400.00; saldo -$700.00.');
                if (! $this->option('apply')) {
                    $this->info('Vista previa: el abono será 603.45 sin IVA, pago $700.00 y saldo $0.00. Usa --apply para aplicar.');

                    return self::SUCCESS;
                }

                $directory = storage_path('app/private/repairs');
                File::ensureDirectoryExists($directory, 0700);
                $path = $directory.'/OS-2026-063-'.now()->format('Ymd-His').'-'.bin2hex(random_bytes(4)).'.json';
                $backup = json_encode(['folio' => $order->folio, 'totals' => $total, 'payment' => $payment], JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR);
                if (File::put($path, $backup) !== strlen($backup)) {
                    throw new \RuntimeException('No se pudo guardar el respaldo. No se aplicó la reparación.');
                }
                DB::table('materiales_orden')->where('id_material', $payment->id_material)->update(['anticipo' => 603.45]);
                $audit->log((int) $order->id_orden_c, $order->folio, 'abono_duplicado_corregido', [
                    'id_material' => $payment->id_material,
                    'anterior_sin_iva' => (float) $payment->anticipo,
                    'nuevo_sin_iva' => 603.45,
                    'pago_confirmado_con_iva' => 700,
                    'backup' => basename($path),
                ]);
                $this->info('Corregido: pago $700.00, saldo $0.00. Respaldo: '.$path);

                return self::SUCCESS;
            });
        } catch (\Throwable $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }
    }
}
