<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Http\Controllers\OrderController;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Tests\TestCase;

final class ReviewPaymentRepairTest extends TestCase
{
    use RefreshDatabase;

    private function seedPayment(float $amount = 1206.90): void
    {
        DB::table('orden_servicio_c')->insert(['id_orden_c' => 97, 'folio' => 'OS-2026-063', 'nombre_cliente' => 'TEST', 'estatus' => 'En proceso']);
        DB::table('orden_servicio_t')->insert(['id_trabajo' => 93, 'id_orden_c' => 97, 'subtotal_t' => 603.45, 'subtotal_m' => 0, 'iva' => 96.55, 'total_pagar' => 700]);
        DB::table('trabajos_orden')->insert(['id_trabajo' => 93, 'clave' => 'SERSOP01', 'importe' => 603.45]);
        DB::table('materiales_orden')->insert(['id_material' => 458, 'id_trabajo' => 93, 'cantidad' => 0, 'descripcion' => 'SALDO LIQUIDADO', 'anticipo' => $amount, 'precio_unitario' => 0, 'importe' => 0, 'ticket' => 'SALDO LIQUIDADO']);
    }

    public function test_preview_does_not_change_payment(): void
    {
        $this->seedPayment();
        $this->artisan('exacto:repair-review-payment')->assertSuccessful();
        $this->assertEquals(1206.90, (float) DB::table('materiales_orden')->value('anticipo'));
    }

    public function test_apply_backs_up_repairs_and_is_idempotent(): void
    {
        $this->seedPayment();
        $directory = storage_path('app/private/repairs');
        $existing = File::exists($directory) ? File::glob($directory.'/OS-2026-063-*.json') : [];
        try {
            $this->artisan('exacto:repair-review-payment --apply')->assertSuccessful();
            $this->assertEquals(603.45, (float) DB::table('materiales_orden')->value('anticipo'));
            $this->assertDatabaseCount('orden_servicio_audit_log', 1);
            $backups = array_values(array_diff(File::glob($directory.'/OS-2026-063-*.json'), $existing));
            $this->assertCount(1, $backups);
            $backup = json_decode(File::get($backups[0]), true, 512, JSON_THROW_ON_ERROR);
            $this->assertEquals(1206.90, $backup['payment']['anticipo']);
            $this->artisan('exacto:repair-review-payment --apply')->assertSuccessful();
            $this->assertDatabaseCount('orden_servicio_audit_log', 1);
        } finally {
            foreach (array_diff(File::glob($directory.'/OS-2026-063-*.json'), $existing) as $file) {
                File::delete($file);
            }
        }
    }

    public function test_apply_refuses_changed_payment_or_new_details(): void
    {
        $this->seedPayment(800);
        $this->artisan('exacto:repair-review-payment --apply')->assertFailed();
        $this->assertEquals(800, (float) DB::table('materiales_orden')->value('anticipo'));
        DB::table('materiales_orden')->update(['anticipo' => 1206.90]);
        DB::table('trabajos_orden')->insert(['id_trabajo' => 93, 'clave' => 'OTHER', 'importe' => 100]);
        $this->artisan('exacto:repair-review-payment --apply')->assertFailed();
        $this->assertEquals(1206.90, (float) DB::table('materiales_orden')->where('id_material', 458)->value('anticipo'));
    }

    public function test_balance_validation_does_not_hide_overpayment_and_accepts_repair(): void
    {
        $this->seedPayment();
        $this->actingAs(User::factory()->administrador()->create());
        $request = Request::create('/api/ordenes/validar-saldo', 'POST', ['id_orden' => 97]);
        $controller = app(OrderController::class);
        $before = $controller->validarSaldo($request)->getData(true);
        $this->assertFalse($before['valid']);
        $this->assertSame('-700.00', $before['saldo_pendiente']);
        DB::table('materiales_orden')->update(['anticipo' => 603.45]);
        $after = $controller->validarSaldo($request)->getData(true);
        $this->assertTrue($after['valid']);
        $this->assertSame('0.00', $after['saldo_pendiente']);
    }

    public function test_legacy_liquidation_cannot_mark_unpaid_order_delivered(): void
    {
        $this->seedPayment(0);
        $this->actingAs(User::factory()->administrador()->create());
        $request = Request::create('/api/ordenes/liquidar-saldo-equipo', 'POST', ['id_orden' => 97, 'ids_equipo' => [1]]);
        $response = app(OrderController::class)->liquidarSaldoEquipo($request);
        $this->assertSame(409, $response->getStatusCode());
        $this->assertDatabaseHas('orden_servicio_c', ['id_orden_c' => 97, 'estatus' => 'En proceso', 'fecha_salida' => null]);
    }
}
