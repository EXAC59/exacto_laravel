<?php

declare(strict_types=1);

namespace Tests\Unit;

use App\Support\OrderMoney;
use PHPUnit\Framework\TestCase;

final class OrderMoneyTest extends TestCase
{
    public function test_rejects_invalid_negative_and_nonfinite_payments(): void
    {
        foreach (['text', -1, INF, NAN, '1e999', [], true, 10000000] as $amount) {
            $this->assertNotNull(OrderMoney::validatePayload(['abono_saldo' => $amount]));
        }
    }

    public function test_accepts_empty_fields_and_decimal_money(): void
    {
        $this->assertNull(OrderMoney::validatePayload(['trabajos' => [['importe' => '']], 'abono_saldo' => '603.45']));
        $this->assertNull(OrderMoney::validatePayload(['anticipos' => [['monto' => '0']]]));
    }

    public function test_rejects_fractional_material_quantity_and_malformed_sections(): void
    {
        $this->assertNotNull(OrderMoney::validatePayload(['materiales' => [['cant' => '1.5', 'precio' => '10']]]));
        $this->assertNotNull(OrderMoney::validatePayload(['trabajos' => 'invalid']));
    }
}
