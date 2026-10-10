<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\DB;

/** La reserva y el resultado se confirman en la misma transacción que la orden. */
final class OrderSubmissionService
{
    public function completed(string $key): ?array
    {
        $result = DB::table('order_submissions')->where('submission_key', $key)->value('result');

        return $result === null ? null : json_decode($result, true, 512, JSON_THROW_ON_ERROR);
    }

    public function claim(string $key): ?array
    {
        // El upsert toma un lock exclusivo también en reintentos; INSERT IGNORE
        // tomaría locks compartidos que pueden interbloquearse al pasar a FOR UPDATE.
        DB::table('order_submissions')->upsert([[
            'submission_key' => $key,
            'created_at' => now(),
        ]], ['submission_key'], ['submission_key']);
        $row = DB::table('order_submissions')->where('submission_key', $key)->lockForUpdate()->first();
        if ($row === null) {
            throw new \RuntimeException('No se pudo reservar el guardado de la orden.');
        }

        return $row->result === null ? null : json_decode($row->result, true, 512, JSON_THROW_ON_ERROR);
    }

    public function complete(string $key, array $result): void
    {
        DB::table('order_submissions')->where('submission_key', $key)->update([
            'result' => json_encode($result, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
        ]);
    }

    public function replay(array $result): array
    {
        return array_merge($result, [
            'success' => true,
            'replayed' => true,
            'message' => 'La orden '.$result['folio'].' ya fue registrada. Se recuperó el guardado anterior.',
        ]);
    }
}
