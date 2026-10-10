<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('order_submissions')) {
            Schema::create('order_submissions', function (Blueprint $table) {
                $table->string('submission_key', 64)->primary();
                $table->text('result')->nullable();
                $table->timestamp('created_at');
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('order_submissions');
    }
};
