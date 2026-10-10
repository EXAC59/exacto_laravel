<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Http\Controllers\OrderController;
use App\Models\User;
use App\Services\RegistrarOrdenService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use Tests\TestCase;

final class OrderSaveSafetyTest extends TestCase
{
    use RefreshDatabase;

    private function payload(): array
    {
        return [
            'submission_token' => (string) Str::uuid(),
            'nombreCliente' => 'CLIENTE PRUEBA',
            'poblacion' => 'LA PAZ',
            'fechaEntrada' => '2026-10-09 10:09:00',
            'estatus' => 'Recepcion',
            'observaciones' => ['PRUEBA DE RECEPCIÓN'],
            'equipos' => [['marca' => 'EPSON', 'modelo' => 'L3250', 'serie' => 'TEST', 'tipoServicio' => '1. Mantenimiento', 'descripcionFalla' => 'REVISIÓN DE IMPRESIÓN']],
            'trabajos' => [['clave' => 'SERSOP01', 'descripcion' => 'SOPORTE REVISION/VALORACION TECNICA', 'importe' => '603.45', 'ticket' => 'MF11634']],
            'abono_saldo' => '603.45',
            'saldo_pagado_confirmado' => '1',
        ];
    }

    private function save(array $payload, User $user): array
    {
        Bus::fake();
        Http::fake();
        $this->actingAs($user);

        return app(RegistrarOrdenService::class)->handle(Request::create('/api/ordenes/registrar', 'POST', $payload), $user);
    }

    public function test_700_payment_and_retry_recover_same_order_without_duplicate_details(): void
    {
        $user = User::factory()->administrador()->create();
        $payload = $this->payload();
        $first = $this->save($payload, $user);
        $this->assertTrue($first['success'], $first['message']);
        Cache::flush(); // La protección persistente sobrevive a la pérdida del cache/respuesta.
        $payload['_token'] = 'changed-csrf';
        $retry = $this->save($payload, $user);
        $this->assertTrue($retry['success']);
        $this->assertTrue($retry['replayed']);
        $this->assertSame($first['idOrden'], $retry['idOrden']);
        $this->assertDatabaseCount('orden_servicio_c', 1);
        $this->assertDatabaseCount('orden_servicio_t', 1);
        $this->assertDatabaseCount('trabajos_orden', 1);
        $this->assertDatabaseCount('materiales_orden', 1);
        $this->assertDatabaseCount('order_submissions', 1);
        $this->assertEquals(700.0, (float) DB::table('orden_servicio_t')->value('total_pagar'));
        $this->assertEquals(603.45, (float) DB::table('materiales_orden')->value('anticipo'));
    }

    public function test_double_review_payment_is_rejected_before_writing(): void
    {
        $payload = $this->payload();
        $payload['abono_saldo'] = '1206.90';
        $result = $this->save($payload, User::factory()->administrador()->create());
        $this->assertFalse($result['success']);
        $this->assertStringContainsString('exceden', $result['message']);
        $this->assertDatabaseCount('orden_servicio_c', 0);
        $this->assertDatabaseCount('order_submissions', 0);
    }

    public function test_validation_failure_can_be_corrected_and_retried_with_same_token(): void
    {
        $user = User::factory()->administrador()->create();
        $payload = $this->payload();
        $payload['trabajos'][0]['importe'] = 'invalid';
        $this->assertFalse($this->save($payload, $user)['success']);
        $payload['trabajos'][0]['importe'] = '603.45';
        $this->assertTrue($this->save($payload, $user)['success']);
        $this->assertDatabaseCount('orden_servicio_c', 1);
    }

    public function test_database_failure_rolls_back_submission_and_order_then_allows_retry(): void
    {
        $user = User::factory()->administrador()->create();
        $payload = $this->payload();
        DB::statement("CREATE TRIGGER fail_payment BEFORE INSERT ON materiales_orden BEGIN SELECT RAISE(ABORT, 'simulated payment write failure'); END");
        $this->assertFalse($this->save($payload, $user)['success']);
        $this->assertDatabaseCount('orden_servicio_c', 0);
        $this->assertDatabaseCount('order_submissions', 0);
        DB::statement('DROP TRIGGER fail_payment');
        $this->assertTrue($this->save($payload, $user)['success']);
    }

    public function test_new_intent_creates_new_order_and_tokens_are_scoped_to_user(): void
    {
        $user = User::factory()->administrador()->create();
        $payload = $this->payload();
        $this->assertTrue($this->save($payload, $user)['success']);
        $payload['submission_token'] = (string) Str::uuid();
        $this->assertTrue($this->save($payload, $user)['success']);
        $this->assertTrue($this->save($payload, User::factory()->administrador()->create())['success']);
        $this->assertDatabaseCount('orden_servicio_c', 3);
    }

    public function test_creation_without_token_fails_safely(): void
    {
        $payload = $this->payload();
        unset($payload['submission_token']);
        $this->assertFalse($this->save($payload, User::factory()->administrador()->create())['success']);
        $this->assertDatabaseCount('orden_servicio_c', 0);
    }

    public function test_missing_submission_table_is_reported_and_same_order_can_be_saved_after_installation(): void
    {
        $user = User::factory()->administrador()->create();
        $payload = $this->payload();
        $this->actingAs($user);
        Schema::drop('order_submissions');

        $response = app(OrderController::class)->registrar(Request::create('/api/ordenes/registrar', 'POST', $payload));
        $this->assertSame(503, $response->getStatusCode());
        $data = $response->getData(true);
        $this->assertFalse($data['success']);
        $this->assertSame('order_submission_schema_missing', $data['code']);
        $this->assertStringContainsString('actualización de la base de datos', $data['message']);
        $this->assertDatabaseCount('orden_servicio_c', 0);

        $migration = require database_path('migrations/2026_10_09_170000_create_order_submissions_table.php');
        $migration->up();
        $this->assertTrue($this->save($payload, $user)['success']);
        $this->assertDatabaseCount('orden_servicio_c', 1);
    }
}
