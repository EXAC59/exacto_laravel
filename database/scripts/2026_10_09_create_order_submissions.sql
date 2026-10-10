-- Alternativa para phpMyAdmin si no hay Terminal/SSH. Seleccionar primero la BD correcta.
CREATE TABLE IF NOT EXISTS order_submissions (
    submission_key VARCHAR(64) NOT NULL PRIMARY KEY,
    result TEXT NULL,
    created_at TIMESTAMP NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
