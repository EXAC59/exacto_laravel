<?php

declare(strict_types=1);

namespace App\Support;

final class OrderMoney
{
    /** Validar antes de convertir a float; PHP convertiría texto inválido a cero. */
    public static function validatePayload(array $payload): ?string
    {
        foreach (['trabajos' => ['importe'], 'materiales' => ['cant', 'precio'], 'anticipos' => ['monto']] as $section => $fields) {
            $rows = $payload[$section] ?? [];
            if (! is_array($rows)) {
                return 'Los datos de '.$section.' no son válidos.';
            }
            foreach ($rows as $row) {
                if (! is_array($row)) {
                    return 'Los datos de '.$section.' no son válidos.';
                }
                foreach ($fields as $field) {
                    if (! self::validAmount($row[$field] ?? '')) {
                        return 'El importe de '.$section.' no es válido. Usa un número positivo.';
                    }
                    if ($field === 'cant' && (float) ($row[$field] ?? 0) !== floor((float) ($row[$field] ?? 0))) {
                        return 'La cantidad de materiales debe ser un número entero.';
                    }
                }
            }
        }
        if (! self::validAmount($payload['abono_saldo'] ?? '')) {
            return 'El abono de saldo no es válido. Usa un número positivo.';
        }

        return null;
    }

    private static function validAmount(mixed $value): bool
    {
        if ($value === '' || $value === null) {
            return true;
        }

        return is_scalar($value) && ! is_bool($value) && is_numeric($value)
            && is_finite((float) $value) && (float) $value >= 0 && (float) $value <= 9999999.99;
    }
}
