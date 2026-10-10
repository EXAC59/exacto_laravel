// JavaScript de la pantalla de orden de servicio. Separado para permitir cache del navegador.

const EXACTO_IVA_RATE = 0.16;
function exactoRound2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function exactoMontoConIva(montoSinIva) { return exactoRound2((Number(montoSinIva) || 0) * (1 + EXACTO_IVA_RATE)); }
function exactoMontoSinIvaDesdeTotal(montoConIva) {
  const p = Number(montoConIva) || 0;
  if (p <= 0) return 0;
  return exactoRound2(p / (1 + EXACTO_IVA_RATE));
}

/** Materiales (precio) y anticipos (monto): se captura precio neto (c/IVA) y se guarda sin IVA. */
function exactoCampoEsNetoConvertible(el) {
    return Boolean(
        el
        && el.tagName === 'INPUT'
        && !el.readOnly
        && !el.disabled
        && (el.classList.contains('precio-input') || el.classList.contains('anticipo-input'))
    );
}

function exactoActualizarHintNetoSinIva(input) {
    if (!exactoCampoEsNetoConvertible(input)) return;
    const raw = String(input.value || '').trim();
    if (raw === '') {
        input.title = 'Escribe el precio neto (con IVA). Se convierte a sin IVA automáticamente.';
        return;
    }
    const monto = Number(raw);
    if (!Number.isFinite(monto) || monto <= 0) {
        input.title = 'Escribe el precio neto (con IVA). Se convierte a sin IVA automáticamente.';
        return;
    }
    if (input.dataset.exactoNetoEditing === '1') {
        const sinIva = exactoMontoSinIvaDesdeTotal(monto);
        input.title = `Neto $${monto.toFixed(2)} → sin IVA $${sinIva.toFixed(2)}`;
        return;
    }
    input.title = `Sin IVA $${exactoRound2(monto).toFixed(2)} (equivale a neto $${exactoMontoConIva(monto).toFixed(2)})`;
}

function exactoIniciarEdicionPrecioNeto(input) {
    if (!exactoCampoEsNetoConvertible(input)) return;
    if (input.dataset.exactoNetoEditing === '1') return;
    input.dataset.exactoNetoEditing = '1';
    const actual = Number(input.value);
    if (Number.isFinite(actual) && actual > 0) {
        // Mostrar el neto (c/IVA) para editar el monto del ticket/factura.
        input.value = exactoMontoConIva(actual).toFixed(2);
        try {
            input.select();
        } catch (e) {
            // ignore
        }
    }
    exactoActualizarHintNetoSinIva(input);
}

function exactoRecalcularTrasConversionNeto(input) {
    if (!input) return;
    if (input.classList.contains('precio-input')) {
        const fila = input.closest('.material-row');
        if (fila) {
            calcularImporte(fila);
            calcularSubtotalMateriales();
            exactoActualizarTicketsMateriales();
        }
        return;
    }
    if (input.classList.contains('anticipo-input')) {
        exactoActualizarTotalesAnticipos();
    }
}

function exactoAplicarConversionNetoASinIva(input) {
    if (!exactoCampoEsNetoConvertible(input)) return false;
    if (input.dataset.exactoNetoEditing !== '1') return false;

    const raw = String(input.value || '').trim();
    if (raw === '') {
        delete input.dataset.exactoNetoEditing;
        delete input.dataset.exactoLastSinIva;
        exactoActualizarHintNetoSinIva(input);
        exactoRecalcularTrasConversionNeto(input);
        return false;
    }

    const neto = Number(raw);
    if (!Number.isFinite(neto) || neto < 0) return false;

    const sinIva = neto === 0 ? 0 : exactoMontoSinIvaDesdeTotal(neto);
    const nuevo = sinIva.toFixed(2);
    const cambio = input.value !== nuevo;
    input.value = nuevo;
    input.dataset.exactoLastSinIva = String(sinIva);
    delete input.dataset.exactoNetoEditing;
    exactoActualizarHintNetoSinIva(input);
    if (cambio) {
        exactoRecalcularTrasConversionNeto(input);
    }
    return cambio;
}

        function toDatetimeLocalValue(mysqlDt) {
            if (!mysqlDt) return '';
            const s = String(mysqlDt).trim();
            if (!s) return '';
            return s.replace(' ', 'T').slice(0, 16);
        }

        function exactoNormalizarEstatusOrden(valor) {
            const key = String(valor || '').trim().toLowerCase();
            // BD/legado: Enproceso sin espacio; canonico UI: En proceso.
            const keyCompact = key.replace(/\s+/g, '');
            const mapa = {
                rojo: 'Recepcion',
                recepcion: 'Recepcion',
                naranja: 'En proceso',
                'en proceso': 'En proceso',
                enproceso: 'En proceso',
                proceso: 'En proceso',
                amarillo: 'Terminado',
                terminado: 'Terminado',
                verde: 'Entregado',
                entregado: 'Entregado',
            };

            return mapa[key] || mapa[keyCompact] || 'Recepcion';
        }

        function exactoTipoServicioKey(valor) {
            const key = String(valor || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase();
            if (key.includes('mantenimiento')) return 'mantenimiento';
            if (key.includes('reparaci') || key.includes('reparacion')) return 'reparacion';
            if (key.includes('instalaci') || key.includes('instalacion')) return 'instalacion';
            if (key.includes('garant')) return 'garantia';
            if (key.includes('revisi') || key.includes('revision')) return 'revision';
            return key.trim();
        }

        function exactoSeleccionarTipoServicio(select, valorGuardado) {
            if (!select) return;
            const valor = String(valorGuardado || '').trim();
            if (valor === '') {
                select.value = '';
                return;
            }
            select.value = valor;
            if (select.value === valor) return;

            const keyGuardada = exactoTipoServicioKey(valor);
            for (const option of select.options) {
                if (exactoTipoServicioKey(option.value || option.textContent) === keyGuardada) {
                    select.value = option.value;
                    return;
                }
            }

            const option = document.createElement('option');
            option.value = valor;
            option.textContent = valor;
            select.appendChild(option);
            select.value = valor;
        }

        function exactoAplicarColorEstatus() {
            const estatusEl = document.getElementById('inputEstatus');
            if (!estatusEl || estatusEl.tagName !== 'SELECT') return;

            const estilos = {
                'Recepcion': { bg: '#fee2e2', color: '#991b1b', border: '#ef4444' },
                'En proceso': { bg: '#ffedd5', color: '#9a3412', border: '#f97316' },
                'Terminado': { bg: '#fef3c7', color: '#92400e', border: '#eab308' },
                'Entregado': { bg: '#dcfce7', color: '#166534', border: '#22c55e' },
            };
            const estilo = estilos[exactoNormalizarEstatusOrden(estatusEl.value)] || estilos['Recepcion'];
            estatusEl.style.backgroundColor = estilo.bg;
            estatusEl.style.color = estilo.color;
            estatusEl.style.borderColor = estilo.border;
        }

        function exactoGetServiciosSersop() {
            return Array.isArray(window.EXACTO_SERVICIOS_SERSOP) ? window.EXACTO_SERVICIOS_SERSOP : [];
        }

        function exactoBaseUrlApp() {
            const b = typeof window.EXACTO_BASE_URL === 'string' ? window.EXACTO_BASE_URL.trim() : '';
            return b.replace(/\/+$/, '');
        }

        function exactoUrlApiRegistrar() {
            const fromPhp = typeof window.EXACTO_REGISTRAR_ORDEN_URL === 'string' ? window.EXACTO_REGISTRAR_ORDEN_URL.trim() : '';
            if (fromPhp) return fromPhp;
            const base = exactoBaseUrlApp();
            return base ? `${base}/api/ordenes/registrar` : '/api/ordenes/registrar';
        }

        function exactoUrlOrdenesIndex() {
            const base = exactoBaseUrlApp();
            return base ? `${base}/ordenes` : '/ordenes';
        }

        function exactoUrlWhatsappEstado(id) {
            const base = exactoBaseUrlApp();
            return base ? `${base}/api/ordenes/whatsapp-estado/${id}` : `/api/ordenes/whatsapp-estado/${id}`;
        }

        function exactoUrlSalidaTemporal(idOrden) {
            const fromPhp = typeof window.EXACTO_SALIDA_TEMPORAL_URL === 'string' ? window.EXACTO_SALIDA_TEMPORAL_URL.trim() : '';
            if (fromPhp && Number(idOrden) > 0 && fromPhp.includes('/' + String(idOrden) + '/')) {
                return fromPhp;
            }
            const base = exactoBaseUrlApp();
            return base
                ? `${base}/api/ordenes/${Number(idOrden)}/salida-temporal`
                : `/api/ordenes/${Number(idOrden)}/salida-temporal`;
        }

        function exactoUrlRegresoTemporal(idOrden) {
            const fromPhp = typeof window.EXACTO_REGRESO_TEMPORAL_URL === 'string' ? window.EXACTO_REGRESO_TEMPORAL_URL.trim() : '';
            if (fromPhp && Number(idOrden) > 0 && fromPhp.includes('/' + String(idOrden) + '/')) {
                return fromPhp;
            }
            const base = exactoBaseUrlApp();
            return base
                ? `${base}/api/ordenes/${Number(idOrden)}/regreso-temporal`
                : `/api/ordenes/${Number(idOrden)}/regreso-temporal`;
        }

        function exactoCsrfToken() {
            return (
                (document.querySelector('meta[name="csrf-token"]') || {}).content
                || window.EXACTO_CSRF_TOKEN
                || document.querySelector('#ordenForm input[name="_token"]')?.value
                || ''
            );
        }
        window.exactoCsrfToken = exactoCsrfToken;

        function exactoEsperar(ms) {
            return new Promise((resolve) => setTimeout(resolve, ms));
        }

        let exactoSalidaTemporalPendienteId = 0;
        /** @type {'post'|'collect'} */
        let exactoSalidaTemporalModo = 'post';

        function exactoDebeOfrecerSalidaTemporal() {
            if (window.EXACTO_ORDEN_SOLO_LECTURA || window.EXACTO_SALIDA_TEMPORAL_ACTIVA) {
                return false;
            }
            const estatusEl = document.getElementById('inputEstatus')
                || document.querySelector('[name="estatus"]');
            return exactoNormalizarEstatusOrden(estatusEl?.value) === 'En proceso';
        }

        function exactoHtmlModalSalidaTemporal() {
            return `
    <div id="modalSalidaTemporal" class="hidden fixed inset-0 z-[10100]" role="dialog" aria-modal="true" aria-labelledby="modalSalidaTemporalTitle" style="display:none;align-items:center;justify-content:center;padding:0.5rem;background:rgba(2,6,23,0.75);z-index:10100;">
        <div id="cardSalidaTemporal" style="display:flex;flex-direction:column;background:#fff;max-width:48rem;width:100%;max-height:min(96dvh,96vh);overflow:hidden;border-radius:1rem;">
            <div id="salidaTempHeaderWrap" style="flex-shrink:0;background:#fff7ed;border-bottom:1px solid #fed7aa;padding:0.5rem 0.75rem;">
                <h3 id="modalSalidaTemporalTitle" style="margin:0;font-size:1.05rem;font-weight:700;color:#7c2d12;">Salida temporal del equipo</h3>
            </div>
            <div id="salidaTempMotivoWrap" style="flex-shrink:0;background:#fff;padding:0.5rem 0.75rem 0.4rem;">
                <label for="motivoSalidaTemporalInput" style="display:block;margin:0 0 0.35rem;font-size:0.9rem;font-weight:700;color:#7c2d12;">Motivo de salida <span style="color:#dc2626;">*</span></label>
                <textarea id="motivoSalidaTemporalInput" rows="2" maxlength="4000" style="width:100%;height:3.6rem;min-height:3.6rem;max-height:3.6rem;resize:none;border:2px solid #fb923c;border-radius:0.5rem;padding:0.4rem 0.65rem;box-sizing:border-box;" placeholder="Escribe aquí el motivo de la salida temporal..."></textarea>
            </div>
            <div id="salidaTempFirmasWrap" style="flex:1 1 auto;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;padding:0.25rem 0.75rem 0.5rem;">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
                    <div style="text-align:center;">
                        <h4 style="margin:0 0 0.35rem;font-size:0.9rem;font-weight:700;color:#1e3a8a;">Firma del cliente</h4>
                        <div style="height:88px;border:2px solid #60a5fa;border-radius:0.5rem;background:#fff;">
                            <canvas id="firmaClienteSalidaTemp" style="display:block;background:white;width:100%;height:100%;"></canvas>
                        </div>
                        <button type="button" id="btnLimpiarFirmaClienteSalidaTemp" style="margin-top:0.35rem;background:#2563eb;color:#fff;border:0;border-radius:0.375rem;padding:0.35rem 0.75rem;font-size:0.8rem;cursor:pointer;">Limpiar</button>
                    </div>
                    <div style="text-align:center;">
                        <h4 style="margin:0 0 0.35rem;font-size:0.9rem;font-weight:700;color:#1e3a8a;">Firma del tecnico</h4>
                        <div style="height:88px;border:2px solid #60a5fa;border-radius:0.5rem;background:#fff;">
                            <canvas id="firmaTecnicoSalidaTemp" style="display:block;background:white;width:100%;height:100%;"></canvas>
                        </div>
                        <button type="button" id="btnLimpiarFirmaTecnicoSalidaTemp" style="margin-top:0.35rem;background:#2563eb;color:#fff;border:0;border-radius:0.375rem;padding:0.35rem 0.75rem;font-size:0.8rem;cursor:pointer;">Limpiar</button>
                    </div>
                </div>
            </div>
            <div id="footerSalidaTemporal" style="flex-shrink:0;display:flex;flex-direction:row;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:0.5rem;border-top:1px solid #e2e8f0;padding:0.55rem 0.75rem;background:#fff;">
                <button type="button" id="btnCancelarSalidaTemporal" style="border:2px solid #cbd5e1;background:#fff;border-radius:0.5rem;padding:0.5rem 1rem;font-weight:700;cursor:pointer;">Cancelar</button>
                <button type="button" id="btnConfirmarSalidaTemporal" style="background:#ea580c;color:#fff;border:0;border-radius:0.5rem;padding:0.5rem 1.1rem;font-weight:700;cursor:pointer;">Guardar</button>
            </div>
        </div>
    </div>`;
        }

        function exactoAsegurarModalSalidaTemporalEnDom() {
            let modal = document.getElementById('modalSalidaTemporal');
            const layoutOk = !!(modal
                && modal.querySelector('#salidaTempMotivoWrap')
                && modal.querySelector('#salidaTempHeaderWrap')
                && modal.querySelector('#motivoSalidaTemporalInput')
                && modal.dataset.exactoLayoutVer === 'tablet-v3');
            if (!layoutOk) {
                // Reemplaza el modal viejo (o incompleto) para que en tableta siempre se vea el motivo.
                if (modal && modal.parentNode) {
                    modal.parentNode.removeChild(modal);
                }
                delete canvasContexts['firmaClienteSalidaTemp'];
                delete canvasContexts['firmaTecnicoSalidaTemp'];
                const wrap = document.createElement('div');
                wrap.innerHTML = exactoHtmlModalSalidaTemporal();
                const node = wrap.firstElementChild;
                if (node) {
                    document.body.appendChild(node);
                    modal = node;
                    modal.dataset.exactoLayoutVer = 'tablet-v3';
                    modal.dataset.exactoBound = '0';
                }
            }
            if (!modal) {
                return null;
            }
            exactoRepararFooterModalSalidaTemporal(modal);
            exactoBindModalSalidaTemporalUi(modal);
            return modal;
        }

        function exactoRepararFooterModalSalidaTemporal(modal) {
            if (!modal) return;
            modal.style.cssText = 'position:fixed;inset:0;z-index:10100;display:none;align-items:center;justify-content:center;padding:0.5rem;background:rgba(2,6,23,0.75);';
            const card = modal.querySelector('#cardSalidaTemporal') || modal.firstElementChild;
            if (card) {
                card.style.cssText = 'display:flex;flex-direction:column;background:#fff;max-width:48rem;width:100%;max-height:min(96dvh,96vh);overflow:hidden;border-radius:1rem;';
            }
            const motivoWrap = modal.querySelector('#salidaTempMotivoWrap');
            const motivoInput = document.getElementById('motivoSalidaTemporalInput');
            if (motivoWrap) {
                motivoWrap.style.cssText = 'flex-shrink:0;background:#fff;padding:0.5rem 0.75rem 0.4rem;';
            }
            if (motivoInput) {
                motivoInput.rows = 2;
                motivoInput.style.cssText = 'width:100%;height:3.6rem;min-height:3.6rem;max-height:3.6rem;resize:none;border:2px solid #fb923c;border-radius:0.5rem;padding:0.4rem 0.65rem;box-sizing:border-box;';
            }
            const firmasWrap = modal.querySelector('#salidaTempFirmasWrap');
            if (firmasWrap) {
                firmasWrap.style.cssText = 'flex:1 1 auto;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;padding:0.25rem 0.75rem 0.5rem;';
                firmasWrap.querySelectorAll('canvas').forEach((canvas) => {
                    const box = canvas.parentElement;
                    if (box) {
                        box.style.height = '88px';
                        box.style.maxHeight = '88px';
                        box.style.minHeight = '88px';
                    }
                    canvas.style.width = '100%';
                    canvas.style.height = '100%';
                    canvas.style.minHeight = '0';
                });
            }
            const footer = modal.querySelector('#footerSalidaTemporal');
            const btnGuardar = document.getElementById('btnConfirmarSalidaTemporal');
            const btnCancelar = document.getElementById('btnCancelarSalidaTemporal');
            if (footer) {
                footer.style.cssText = 'flex-shrink:0;display:flex;flex-direction:row;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:0.5rem;border-top:1px solid #e2e8f0;padding:0.55rem 0.75rem;background:#fff;';
            }
            if (btnCancelar) {
                btnCancelar.style.cssText = 'border:2px solid #cbd5e1;background:#fff;border-radius:0.5rem;padding:0.5rem 1rem;font-weight:700;cursor:pointer;';
            }
            if (btnGuardar) {
                btnGuardar.innerHTML = '<i class="fas fa-save" style="margin-right:0.35rem;"></i>Guardar';
                btnGuardar.style.cssText = 'display:inline-flex;align-items:center;background:#ea580c;color:#fff;border:0;border-radius:0.5rem;padding:0.5rem 1.1rem;font-weight:700;cursor:pointer;';
            }
        }

        function exactoBindModalSalidaTemporalUi(modal) {
            if (!modal) {
                return;
            }
            const btnGuardar = document.getElementById('btnConfirmarSalidaTemporal');
            const btnCancelar = document.getElementById('btnCancelarSalidaTemporal');
            if (modal.dataset.exactoBound === '1' && btnGuardar?.dataset.exactoClickBound === '1') {
                return;
            }
            modal.dataset.exactoBound = '1';
            document.getElementById('btnLimpiarFirmaClienteSalidaTemp')?.addEventListener('click', () => {
                if (!canvasContexts['firmaClienteSalidaTemp']) return;
                const canvas = document.getElementById('firmaClienteSalidaTemp');
                canvasContexts['firmaClienteSalidaTemp'].clearRect(0, 0, canvas.width, canvas.height);
                pintarFondoBlancoFirma('firmaClienteSalidaTemp');
            });
            document.getElementById('btnLimpiarFirmaTecnicoSalidaTemp')?.addEventListener('click', () => {
                if (!canvasContexts['firmaTecnicoSalidaTemp']) return;
                const canvas = document.getElementById('firmaTecnicoSalidaTemp');
                canvasContexts['firmaTecnicoSalidaTemp'].clearRect(0, 0, canvas.width, canvas.height);
                pintarFondoBlancoFirma('firmaTecnicoSalidaTemp');
            });
            if (btnCancelar && btnCancelar.dataset.exactoClickBound !== '1') {
                btnCancelar.dataset.exactoClickBound = '1';
                btnCancelar.addEventListener('click', () => {
                    exactoCerrarModalSalidaTemporal(false);
                });
            }
            if (btnGuardar && btnGuardar.dataset.exactoClickBound !== '1') {
                btnGuardar.dataset.exactoClickBound = '1';
                btnGuardar.addEventListener('click', () => {
                    void exactoConfirmarSalidaTemporalDesdeModal();
                });
            }
        }

        function exactoAbrirModalSalidaTemporal(idOrden, modo) {
            exactoSalidaTemporalPendienteId = Number(idOrden) || 0;
            exactoSalidaTemporalModo = modo === 'collect' ? 'collect' : 'post';
            const modal = exactoAsegurarModalSalidaTemporalEnDom();
            const motivo = document.getElementById('motivoSalidaTemporalInput');
            if (!modal) {
                console.error('modalSalidaTemporal no disponible en el DOM');
                return Promise.resolve({ __openFailed: true });
            }
            if (motivo) {
                motivo.value = '';
            }
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            modal.style.display = 'flex';
            modal.style.alignItems = 'center';
            modal.style.justifyContent = 'center';
            modal.style.overflow = 'hidden';
            modal.style.padding = '0.5rem';
            modal.style.zIndex = '10100';
            document.body.style.overflow = 'hidden';
            // La barra sticky (Cambiar de cuenta / estados WA) usa z-index 9999 y tapaba el motivo.
            const navBar = document.querySelector('nav[aria-label="Navegación principal"]');
            if (navBar) {
                if (navBar.dataset.exactoPrevZ === undefined) {
                    navBar.dataset.exactoPrevZ = navBar.style.zIndex || '9999';
                }
                navBar.style.zIndex = '1';
            }
            exactoRepararFooterModalSalidaTemporal(modal);
            modal.style.display = 'flex';
            modal.style.zIndex = '10100';
            const prepararFirmas = () => {
                try {
                    if (typeof inicializarFirma === 'function') {
                        if (document.getElementById('firmaClienteSalidaTemp') && !canvasContexts['firmaClienteSalidaTemp']) {
                            inicializarFirma('firmaClienteSalidaTemp');
                        }
                        if (document.getElementById('firmaTecnicoSalidaTemp') && !canvasContexts['firmaTecnicoSalidaTemp']) {
                            inicializarFirma('firmaTecnicoSalidaTemp');
                        }
                    }
                    if (typeof exactoPrepararCanvasFirmaVisible === 'function') {
                        exactoPrepararCanvasFirmaVisible('firmaClienteSalidaTemp');
                        exactoPrepararCanvasFirmaVisible('firmaTecnicoSalidaTemp');
                    }
                    if (canvasContexts['firmaClienteSalidaTemp']) {
                        pintarFondoBlancoFirma('firmaClienteSalidaTemp');
                    }
                    if (canvasContexts['firmaTecnicoSalidaTemp']) {
                        pintarFondoBlancoFirma('firmaTecnicoSalidaTemp');
                    }
                } catch (errFirmas) {
                    console.warn('No se pudieron preparar firmas de salida temporal:', errFirmas);
                }
            };
            requestAnimationFrame(prepararFirmas);
            setTimeout(prepararFirmas, 80);
            return new Promise((resolve) => {
                modal._exactoResolve = resolve;
            });
        }

        function exactoCerrarModalSalidaTemporal(resultado) {
            const modal = document.getElementById('modalSalidaTemporal');
            if (!modal) {
                return;
            }
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            modal.style.display = 'none';
            document.body.style.overflow = '';
            const navBar = document.querySelector('nav[aria-label="Navegación principal"]');
            if (navBar) {
                navBar.style.zIndex = navBar.dataset.exactoPrevZ || '9999';
                delete navBar.dataset.exactoPrevZ;
            }
            const resolve = modal._exactoResolve;
            modal._exactoResolve = null;
            exactoSalidaTemporalModo = 'post';
            if (typeof resolve === 'function') {
                resolve(resultado);
            }
        }

        async function exactoEnviarSalidaTemporalCapturada(idOrden, payload) {
            const id = Number(idOrden) || 0;
            if (!id || !payload || typeof payload !== 'object') {
                return false;
            }
            try {
                const res = await fetch(exactoUrlSalidaTemporal(id), {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        'X-CSRF-TOKEN': exactoCsrfToken(),
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: JSON.stringify({
                        motivo: String(payload.motivo || '').trim(),
                        firma_cliente: payload.firma_cliente || '',
                        firma_tecnico: payload.firma_tecnico || '',
                        _token: exactoCsrfToken(),
                    }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) {
                    await exactoShowAlert(data.message || 'No se pudo registrar la salida temporal.', {
                        title: 'Salida temporal',
                        icon: 'error',
                    });
                    return false;
                }
                window.EXACTO_SALIDA_TEMPORAL_ACTIVA = true;
                await exactoShowAlert(data.message || 'Salida temporal registrada.', {
                    title: 'Salida temporal',
                    icon: 'success',
                });
                return true;
            } catch (e) {
                console.error('salida temporal:', e);
                await exactoShowAlert('Error de red al registrar la salida temporal.', {
                    title: 'Salida temporal',
                    icon: 'error',
                });
                return false;
            }
        }

        async function exactoConfirmarSalidaTemporalDesdeModal() {
            const idOrden = exactoSalidaTemporalPendienteId
                || Number(document.getElementById('id_orden_c')?.value || 0);
            const motivo = String(document.getElementById('motivoSalidaTemporalInput')?.value || '').trim();
            if (!motivo) {
                await exactoShowAlert('Escribe el motivo de la salida temporal.', { title: 'Salida temporal', icon: 'warning' });
                return false;
            }
            const firmaCliente = exactoFirmaDataUrlSiHay('firmaClienteSalidaTemp');
            const firmaTecnico = exactoFirmaDataUrlSiHay('firmaTecnicoSalidaTemp');
            if (!firmaCliente || !firmaTecnico) {
                await exactoShowAlert('Se requieren las firmas del cliente y del técnico.', { title: 'Salida temporal', icon: 'warning' });
                return false;
            }

            // Antes de guardar: solo capturar; el POST va después del save exitoso.
            if (exactoSalidaTemporalModo === 'collect') {
                exactoCerrarModalSalidaTemporal({
                    motivo,
                    firma_cliente: firmaCliente,
                    firma_tecnico: firmaTecnico,
                });
                return true;
            }

            if (!idOrden) {
                await exactoShowAlert('No se encontró el ID de la orden.', { title: 'Salida temporal', icon: 'error' });
                return false;
            }

            const btn = document.getElementById('btnConfirmarSalidaTemporal');
            if (btn) {
                btn.disabled = true;
            }
            try {
                const ok = await exactoEnviarSalidaTemporalCapturada(idOrden, {
                    motivo,
                    firma_cliente: firmaCliente,
                    firma_tecnico: firmaTecnico,
                });
                if (ok) {
                    exactoCerrarModalSalidaTemporal(true);
                }
                return ok;
            } finally {
                if (btn) {
                    btn.disabled = false;
                }
            }
        }

        /**
         * Pregunta y, si aplica, abre el modal ANTES de enviar el guardado.
         * @returns {Promise<false|{motivo:string,firma_cliente:string,firma_tecnico:string}|null>}
         *   false = canceló el modal (abortar save);
         *   null = no aplica o eligió No;
         *   objeto = capturado, enviar tras save.
         */
        async function exactoPreguntarSalidaTemporalAntesDeGuardar() {
            if (!exactoDebeOfrecerSalidaTemporal()) {
                return null;
            }
            const quiere = await exactoShowConfirm(
                '¿El equipo saldrá temporalmente del taller?',
                {
                    title: 'Salida temporal',
                    confirmText: 'Sí',
                    cancelText: 'No',
                    icon: 'question',
                }
            );
            if (!quiere) {
                return null;
            }
            // Esperar a que cierre el diálogo Sí/No antes de abrir el modal grande.
            await exactoEsperar(30);
            const idOrden = Number(document.getElementById('id_orden_c')?.value || 0);
            const capturado = await exactoAbrirModalSalidaTemporal(idOrden, 'collect');
            // Falló crear/abrir el modal (no confundir con Cancelar).
            if (capturado && typeof capturado === 'object' && capturado.__openFailed) {
                await exactoShowAlert(
                    'No se pudo abrir el modal de salida temporal. Sube también la vista orden_form.blade.php o recarga con Ctrl+F5.',
                    { title: 'Salida temporal', icon: 'error' }
                );
                return false;
            }
            // Cancelar / cerrar sin confirmar: abortar guardado sin mensaje de error engañoso.
            if (!capturado || typeof capturado !== 'object' || !String(capturado.motivo || '').trim()) {
                return false;
            }
            return capturado;
        }

        async function exactoRegistrarRegresoTemporal() {
            const idOrden = Number(document.getElementById('id_orden_c')?.value || 0);
            if (!idOrden) {
                return;
            }
            const ok = await exactoShowConfirm(
                '¿Confirmas que el cliente regresó el equipo al taller?',
                {
                    title: 'Regreso al taller',
                    confirmText: 'Sí, regresó',
                    cancelText: 'Cancelar',
                    icon: 'question',
                }
            );
            if (!ok) {
                return;
            }
            try {
                const res = await fetch(exactoUrlRegresoTemporal(idOrden), {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        'X-CSRF-TOKEN': exactoCsrfToken(),
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: JSON.stringify({ _token: exactoCsrfToken() }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) {
                    await exactoShowAlert(data.message || 'No se pudo registrar el regreso.', {
                        title: 'Regreso al taller',
                        icon: 'error',
                    });
                    return;
                }
                window.EXACTO_SALIDA_TEMPORAL_ACTIVA = false;
                await exactoShowAlert(data.message || 'Regreso registrado.', {
                    title: 'Regreso al taller',
                    icon: 'success',
                });
                window.location.reload();
            } catch (e) {
                await exactoShowAlert('Error de red al registrar el regreso.', {
                    title: 'Regreso al taller',
                    icon: 'error',
                });
            }
        }

        function exactoAplicarSoloLecturaEntregado() {
            if (!window.EXACTO_ORDEN_SOLO_LECTURA) {
                return;
            }
            const form = document.getElementById('ordenForm');
            if (!form) {
                return;
            }
            form.querySelectorAll('input, select, textarea, button').forEach((el) => {
                if (el.id === 'btnGuardarOrden') {
                    return;
                }
                if (el.type === 'hidden') {
                    return;
                }
                el.disabled = true;
                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT') {
                    el.readOnly = true;
                }
            });
            form.querySelectorAll('canvas').forEach((c) => {
                c.style.pointerEvents = 'none';
                c.style.cursor = 'default';
            });
        }

        async function exactoConfirmarEntregaWhatsapp(data) {
            if (window.EXACTO_WHATSAPP_ENABLED === false) {
                return;
            }
            const notificationId = data && data.whatsapp_notification_id ? Number(data.whatsapp_notification_id) : 0;
            if (!notificationId) {
                return;
            }
            const level = String(data.whatsapp_notice_level || '').trim().toLowerCase();
            if (level === 'error') {
                return;
            }
            const notice = String(data.whatsapp_notice || '').toLowerCase();
            if (notice.includes('programado') || notice.includes('en cola')) {
                return;
            }

            const csrf = window.EXACTO_CSRF_TOKEN || '';
            const maxIntentos = 4;
            for (let intento = 0; intento < maxIntentos; intento++) {
                await exactoEsperar(1500);
                try {
                    const resp = await fetch(exactoUrlWhatsappEstado(notificationId), {
                        method: 'GET',
                        headers: {
                            'Accept': 'application/json',
                            'X-CSRF-TOKEN': csrf,
                            'X-Requested-With': 'XMLHttpRequest',
                        },
                        credentials: 'same-origin',
                    });
                    if (!resp.ok) {
                        continue;
                    }
                    const estado = await resp.json();
                    if (!estado || !estado.success) {
                        continue;
                    }
                    if (estado.settled) {
                        data.whatsapp_notice = String(estado.message || data.whatsapp_notice || '').trim();
                        data.whatsapp_notice_level = String(estado.level || '').trim().toLowerCase();
                        return;
                    }
                } catch (e) {
                    /* reintentar */
                }
            }
        }

        function exactoUrlOrdenLockApi(orderId, action) {
            const base = exactoBaseUrlApp();
            const path = `/api/ordenes/${encodeURIComponent(orderId)}/lock/${action}`;
            return base ? `${base}${path}` : path;
        }

        let exactoOrdenLockHeartbeatTimer = null;

        let exactoOrdenLockPerdido = false;

        function exactoLiberarLockEdicionOrden() {
            const idOc = document.getElementById('id_orden_c');
            const orderId = idOc ? parseInt(String(idOc.value || ''), 10) : 0;
            if (!orderId) {
                return;
            }
            if (exactoOrdenLockHeartbeatTimer) {
                clearInterval(exactoOrdenLockHeartbeatTimer);
                exactoOrdenLockHeartbeatTimer = null;
            }
            const csrf = window.EXACTO_CSRF_TOKEN || '';
            try {
                fetch(exactoUrlOrdenLockApi(orderId, 'release'), {
                    method: 'POST',
                    credentials: 'same-origin',
                    keepalive: true,
                    headers: {
                        'X-CSRF-TOKEN': csrf,
                        'X-Requested-With': 'XMLHttpRequest',
                        Accept: 'application/json',
                    },
                });
            } catch (e) {
                /* ignore */
            }
        }

        async function exactoAvisarLockEdicionPerdido() {
            if (exactoOrdenLockPerdido) {
                return;
            }
            exactoOrdenLockPerdido = true;
            if (exactoOrdenLockHeartbeatTimer) {
                clearInterval(exactoOrdenLockHeartbeatTimer);
                exactoOrdenLockHeartbeatTimer = null;
            }
            await exactoShowAlert(
                'Ya no tienes el bloqueo de esta orden (otro usuario la tomó o expiró). Se abrirá el listado.',
                { title: 'Orden liberada', icon: 'warning' }
            );
            exactoPermitirSalidaOrdenForm();
            window.location.href = exactoUrlOrdenesIndex();
        }

        function exactoIniciarLockEdicionOrden() {
            const idOc = document.getElementById('id_orden_c');
            const orderId = idOc ? parseInt(String(idOc.value || ''), 10) : 0;
            if (!orderId) {
                return;
            }
            exactoOrdenLockPerdido = false;
            const csrf = window.EXACTO_CSRF_TOKEN || '';
            const ping = () => {
                fetch(exactoUrlOrdenLockApi(orderId, 'heartbeat'), {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'X-CSRF-TOKEN': csrf,
                        'X-Requested-With': 'XMLHttpRequest',
                        Accept: 'application/json',
                    },
                })
                    .then((res) => (res.ok ? res.json() : { success: false }))
                    .then((data) => {
                        if (!data || data.success !== true) {
                            exactoAvisarLockEdicionPerdido();
                        }
                    })
                    .catch(() => {});
            };
            ping();
            if (exactoOrdenLockHeartbeatTimer) {
                clearInterval(exactoOrdenLockHeartbeatTimer);
            }
            exactoOrdenLockHeartbeatTimer = setInterval(ping, 30000);
            window.addEventListener('beforeunload', exactoLiberarLockEdicionOrden);
            window.addEventListener('pagehide', exactoLiberarLockEdicionOrden);
        }

        function exactoUiFocusField(target) {
            if (!target || typeof target.focus !== 'function') return;
            try {
                if (typeof target.scrollIntoView === 'function') {
                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                target.focus({ preventScroll: true });
            } catch (err) {
                try {
                    target.focus();
                } catch (innerErr) {
                    console.warn('No se pudo enfocar el campo', innerErr);
                }
            }
        }

        const EXACTO_ETIQUETAS_FIRMA = {
            firmaClienteInicial: 'Firma del cliente',
            firmaTecnicoInicial: 'Firma del tecnico',
            firmaCliente: 'Firma del cliente',
            firmaTecnico: 'Firma del tecnico',
        };

        const EXACTO_NOMBRES_CAMPOS = {
            nombreCliente: 'Nombre o razon social',
            telefono: 'Celular',
            poblacion: 'Poblacion/Ciudad',
            correo: 'Correo electronico',
            direccion: 'Direccion',
            fechaEntrada: 'Fecha de entrada',
            estatus: 'Estatus',
            folio: 'Folio de la orden',
            comentariosTecnico: 'Comentarios del tecnico',
        };

        const EXACTO_SUBCAMPOS_TABLA = {
            marca: 'Marca',
            modelo: 'Modelo o descripcion',
            serie: 'Serie',
            descripcionFalla: 'Descripcion de falla',
            tipoServicio: 'Tipo de servicio',
            clave: 'Clave',
            descripcion: 'Descripcion',
            importe: 'PRECIO SIN IVA',
            precio: 'PRECIO SIN IVA',
            ticket: 'Ticket o factura',
            vale: 'Vale',
            codigo: 'Codigo',
            cant: 'Cantidad',
            monto: 'MONTO SIN IVA',
        };

        function exactoHtmlTicketFacturaInput(name, extraClass, readonly) {
            const cls = 'px-2 py-1 w-full text-sm rounded border border-blue-300 ticket-factura-input'
                + (extraClass ? ' ' + extraClass : '')
                + (readonly ? ' bg-gray-100 text-gray-700 cursor-not-allowed' : '');
            const ro = readonly ? ' readonly' : '';
            return `<input type="text" name="${name}" class="${cls}" placeholder="Ticket, factura o folio"${ro}>`;
        }

        function exactoNumeroEquipos() {
            return document.querySelectorAll('#equiposTableBody .equipo-row').length;
        }

        function exactoHtmlSelectEquipo(name, seleccionado) {
            const numEquipos = Math.max(1, exactoNumeroEquipos());
            const selVal = Number(seleccionado) || 1;
            let opciones = '';
            for (let i = 1; i <= numEquipos; i++) {
                const sel = i === selVal ? ' selected' : '';
                opciones += `<option value="${i}"${sel}>${i}</option>`;
            }
            return `<select name="${name}" class="px-2 py-1 w-full text-sm rounded border border-blue-300">${opciones}</select>`;
        }

        function exactoActualizarSelectsEquipo() {
            const numEquipos = Math.max(1, exactoNumeroEquipos());
            document.querySelectorAll('#trabajosTableBody select[name$="[id_equipo]"], #materialesTableBody select[name$="[id_equipo]"], #anticiposTableBody select[name$="[id_equipo]"]').forEach((select) => {
                const actual = Number(select.value) || 1;
                const target = Math.min(actual, numEquipos);
                let opciones = '';
                for (let i = 1; i <= numEquipos; i++) {
                    const sel = i === target ? ' selected' : '';
                    opciones += `<option value="${i}"${sel}>${i}</option>`;
                }
                select.innerHTML = opciones;
                select.value = String(target);
            });
        }

        // Compatibilidad con llamadas antiguas.
        function exactoHtmlTicketFacturaSelect(name, extraClass, disabled) {
            return exactoHtmlTicketFacturaInput(name, extraClass, Boolean(disabled));
        }

        function exactoCampoDebeMayusculas(el) {
            if (!el || el.disabled || el.readOnly) {
                return false;
            }
            const tag = String(el.tagName || '').toUpperCase();
            if (tag === 'TEXTAREA') {
                return true;
            }
            if (tag !== 'INPUT') {
                return false;
            }
            const type = String(el.type || 'text').toLowerCase();
            if (['email', 'password', 'number', 'hidden', 'date', 'datetime-local', 'checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'range', 'color'].includes(type)) {
                return false;
            }
            const name = String(el.name || '').toLowerCase();
            if (name === 'correo' || name === 'telefono' || name === 'folio' || name === 'fechaentrada') {
                return false;
            }
            if (/(^|\[)(importe|precio|monto|cant|cantidad|abono_saldo)(\]|$)/i.test(name)) {
                return false;
            }
            if (el.classList && (el.classList.contains('precio-input') || el.classList.contains('monto-input') || el.classList.contains('cant-input'))) {
                return false;
            }
            return true;
        }

        function exactoForzarMayusculasCampo(el) {
            if (!exactoCampoDebeMayusculas(el)) {
                return;
            }
            const valor = String(el.value || '');
            const upper = valor.toLocaleUpperCase('es-MX');
            if (valor === upper) {
                return;
            }
            const start = el.selectionStart;
            const end = el.selectionEnd;
            el.value = upper;
            if (typeof start === 'number' && typeof end === 'number' && el === document.activeElement) {
                try {
                    el.setSelectionRange(start, end);
                } catch (e) {
                    // ignore (some input types)
                }
            }
        }

        function exactoConfigurarMayusculasOrdenForm(form) {
            if (!form || form.dataset.exactoMayusculasConfiguradas === '1') {
                return;
            }
            form.dataset.exactoMayusculasConfiguradas = '1';
            const handler = (evento) => {
                const el = evento.target;
                if (!el || !form.contains(el)) {
                    return;
                }
                exactoForzarMayusculasCampo(el);
            };
            form.addEventListener('input', handler, true);
            form.addEventListener('blur', handler, true);
        }

        function exactoHtmlAnticipoTicketSelect(name, extraClass, disabled) {
            return exactoHtmlTicketFacturaInput(name, (extraClass ? extraClass + ' ' : '') + 'anticipo-ticket-input', Boolean(disabled));
        }

        function exactoCampoTicket(row) {
            if (!row) return null;
            return row.querySelector('input[name*="[ticket]"], select[name*="[ticket]"]');
        }

        function exactoAsignarTicketFactura(campo, valor) {
            if (!campo) return;
            campo.value = String(valor || '').trim().toLocaleUpperCase('es-MX');
        }

        function exactoSetCampoTicketFactura(campo, habilitar) {
            if (!campo) return;
            if (campo.tagName === 'SELECT') {
                campo.disabled = !habilitar;
                campo.classList.toggle('bg-gray-100', !habilitar);
                campo.classList.toggle('text-gray-700', !habilitar);
                campo.classList.toggle('cursor-not-allowed', !habilitar);
                if (!habilitar) {
                    campo.value = '';
                }
                return;
            }
            campo.readOnly = !habilitar;
            if (habilitar) {
                campo.removeAttribute('readonly');
            } else {
                campo.setAttribute('readonly', 'readonly');
            }
            campo.classList.toggle('bg-gray-100', !habilitar);
            campo.classList.toggle('text-gray-700', !habilitar);
            campo.classList.toggle('cursor-not-allowed', !habilitar);
            if (!habilitar) {
                campo.value = '';
            }
        }

        function exactoAnticipoTicketSaldoPagoHtml(name, valor) {
            const esc = String(valor || 'PAGO SALDO PENDIENTE')
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;');
            return `<input type="text" class="px-2 py-1 w-full text-sm text-gray-700 bg-gray-100 rounded border border-blue-300 cursor-not-allowed anticipo-ticket-input ticket-factura-input" name="${name}" value="${esc}" readonly>`;
        }

        function exactoNumeroFilaTabla(row) {
            if (!row) {
                return 1;
            }
            const tbody = row.closest('tbody');
            if (!tbody) {
                return 1;
            }
            const filas = Array.from(
                tbody.querySelectorAll('.equipo-row, .trabajo-row, .material-row, .anticipo-row')
            );
            const indice = filas.indexOf(row);

            return indice >= 0 ? indice + 1 : 1;
        }

        function exactoEtiquetaCampo(el) {
            if (!el) {
                return 'Campo';
            }

            const personalizada = el.getAttribute('data-exacto-label');
            if (personalizada && personalizada.trim() !== '') {
                return personalizada.trim();
            }

            if (el.id) {
                const porFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (porFor) {
                    return porFor.textContent
                        .replace(/\s*\*+\s*/g, '')
                        .replace(/\(opcional\)/gi, '')
                        .trim();
                }
            }

            const celda = el.closest('td');
            if (celda) {
                const tabla = el.closest('table');
                const fila = el.closest('tr');
                if (tabla && fila) {
                    const encabezados = tabla.querySelectorAll('thead th');
                    const celdas = Array.from(fila.querySelectorAll('td'));
                    const indice = celdas.indexOf(celda);
                    if (indice >= 0 && encabezados[indice]) {
                        const texto = encabezados[indice].textContent.trim();
                        if (texto !== '') {
                            const filaNum = exactoNumeroFilaTabla(fila);
                            return `${texto} (fila ${filaNum})`;
                        }
                    }
                }
            }

            const contenedor = el.closest('div');
            if (contenedor) {
                const etiquetaCercana = contenedor.querySelector(':scope > label');
                if (etiquetaCercana) {
                    return etiquetaCercana.textContent
                        .replace(/\s*\*+\s*/g, '')
                        .replace(/\(opcional\)/gi, '')
                        .trim();
                }
            }

            const nombre = String(el.getAttribute('name') || '').trim();
            if (EXACTO_NOMBRES_CAMPOS[nombre]) {
                return EXACTO_NOMBRES_CAMPOS[nombre];
            }

            const coincidencia = nombre.match(/^(equipos|trabajos|materiales|anticipos)\[(\d+)\]\[(\w+)\]$/);
            if (coincidencia) {
                const seccion = {
                    equipos: 'Equipo',
                    trabajos: 'Trabajo',
                    materiales: 'Material',
                    anticipos: 'Anticipo',
                }[coincidencia[1]] || 'Registro';
                const fila = Number.parseInt(coincidencia[2], 10) + 1;
                const subcampo = EXACTO_SUBCAMPOS_TABLA[coincidencia[3]] || coincidencia[3];

                return `${seccion} (fila ${fila}): ${subcampo}`;
            }

            if (el.placeholder && String(el.placeholder).trim() !== '') {
                return String(el.placeholder).trim();
            }

            return nombre !== '' ? nombre : 'Campo';
        }

        function exactoMensajeValidacionCampo(el) {
            const etiqueta = exactoEtiquetaCampo(el);
            const validez = el.validity || {};

            if (validez.valueMissing) {
                return `${etiqueta}: este campo es obligatorio.`;
            }
            if (validez.typeMismatch) {
                if (String(el.type || '').toLowerCase() === 'email') {
                    return `${etiqueta}: escribe un correo válido (ejemplo@dominio.com).`;
                }
                return `${etiqueta}: el formato no es válido.`;
            }
            if (validez.patternMismatch) {
                return `${etiqueta}: no cumple el formato requerido.`;
            }
            if (validez.tooShort) {
                return `${etiqueta}: es demasiado corto.`;
            }
            if (validez.tooLong) {
                return `${etiqueta}: es demasiado largo.`;
            }
            if (validez.rangeUnderflow || validez.rangeOverflow) {
                return `${etiqueta}: el valor está fuera del rango permitido.`;
            }

            const mensajeNativo = String(el.validationMessage || '').trim();
            if (mensajeNativo !== '' && !/^please\s/i.test(mensajeNativo)) {
                return `${etiqueta}: ${mensajeNativo}`;
            }

            return `${etiqueta}: revisa el valor capturado.`;
        }

        function exactoConfigurarMensajesValidacionOrden(form) {
            if (!form) {
                return;
            }

            Array.from(form.querySelectorAll('input, select, textarea')).forEach((el) => {
                const limpiar = () => {
                    if (typeof el.setCustomValidity === 'function') {
                        el.setCustomValidity('');
                    }
                };
                el.addEventListener('input', limpiar);
                el.addEventListener('change', limpiar);

                if (el.required && typeof el.setCustomValidity === 'function') {
                    el.addEventListener('invalid', (evento) => {
                        evento.preventDefault();
                        const campo = evento.target;
                        campo.setCustomValidity(exactoMensajeValidacionCampo(campo));
                    });
                }
            });
        }

        function exactoUiDialog(config) {
            const modal = document.getElementById('exactoUiModal');
            const titleEl = document.getElementById('exactoUiModalTitle');
            const iconWrapEl = document.getElementById('exactoUiModalIconWrap');
            const iconCircleEl = document.getElementById('exactoUiModalIconCircle');
            const iconEl = document.getElementById('exactoUiModalIcon');
            const messageEl = document.getElementById('exactoUiModalMessage');
            const confirmBtn = document.getElementById('exactoUiModalConfirm');
            const cancelBtn = document.getElementById('exactoUiModalCancel');
            const inputWrap = document.getElementById('exactoUiModalInputWrap');
            const inputLabel = document.getElementById('exactoUiModalInputLabel');
            const inputEl = document.getElementById('exactoUiModalInput');
            const wantsInput = Boolean(config.showInput);
            if (!modal || !titleEl || !messageEl || !confirmBtn || !cancelBtn || !iconWrapEl || !iconCircleEl || !iconEl) {
                if (wantsInput) {
                    const valor = window.prompt(config.message || 'Captura el valor:', config.inputValue || '');
                    return Promise.resolve(valor === null ? null : valor);
                }
                if (config.showCancel) {
                    return Promise.resolve(window.confirm(config.message || '¿Deseas continuar?'));
                }
                window.alert(config.message || 'Aviso');
                return Promise.resolve(true);
            }

            return new Promise((resolve) => {
                const previousOverflow = document.body.style.overflow;
                titleEl.textContent = config.title || (config.showCancel ? 'Confirmar' : 'Aviso');
                messageEl.textContent = String(config.message || '');
                messageEl.className =
                    'mx-auto max-w-prose text-sm leading-relaxed text-center whitespace-pre-line text-slate-700';
                confirmBtn.textContent = config.confirmText || 'Aceptar';
                cancelBtn.textContent = config.cancelText || 'Cancelar';
                cancelBtn.classList.toggle('hidden', !config.showCancel);
                iconWrapEl.classList.toggle('hidden', !config.icon);
                iconWrapEl.classList.toggle('flex', Boolean(config.icon));
                iconCircleEl.className = 'flex justify-center items-center w-14 h-14 rounded-full bg-slate-100';
                iconEl.className = 'text-2xl fas fa-info-circle text-slate-600';
                if (config.icon === 'success') {
                    iconCircleEl.classList.add('bg-emerald-100');
                    iconEl.className = 'text-2xl text-emerald-600 fas fa-check';
                } else if (config.icon === 'error') {
                    iconCircleEl.classList.add('bg-red-100');
                    iconEl.className = 'text-2xl text-red-600 fas fa-times';
                } else if (config.icon === 'warning') {
                    iconCircleEl.classList.add('bg-amber-100');
                    iconEl.className = 'text-2xl text-amber-600 fas fa-exclamation';
                } else if (config.icon === 'question') {
                    iconCircleEl.classList.add('bg-sky-100');
                    iconEl.className = 'text-2xl text-sky-700 fas fa-question';
                }
                if (inputWrap && inputEl) {
                    inputWrap.classList.toggle('hidden', !wantsInput);
                    if (wantsInput) {
                        if (inputLabel) {
                            inputLabel.textContent = config.inputLabel || 'Ticket / factura';
                        }
                        inputEl.value = String(config.inputValue || '');
                        inputEl.placeholder = config.inputPlaceholder || 'Ticket, factura o folio';
                    } else {
                        inputEl.value = '';
                    }
                }
                // Encima de liquidar/entrega/firmas (20000).
                if (modal.parentNode !== document.body) {
                    document.body.appendChild(modal);
                }
                modal.style.zIndex = '30000';
                modal.classList.remove('hidden');
                modal.classList.add('flex');
                document.body.style.overflow = 'hidden';

                const cleanup = (value) => {
                    modal.classList.add('hidden');
                    modal.classList.remove('flex');
                    document.body.style.overflow = previousOverflow;
                    confirmBtn.removeEventListener('click', onConfirm);
                    cancelBtn.removeEventListener('click', onCancel);
                    modal.removeEventListener('click', onBackdrop);
                    document.removeEventListener('keydown', onKeydown);
                    if (inputEl) {
                        inputEl.removeEventListener('keydown', onInputKeydown);
                    }
                    if (inputWrap) {
                        inputWrap.classList.add('hidden');
                    }
                    resolve(value);
                };
                const onConfirm = () => {
                    if (wantsInput) {
                        const valor = String(inputEl ? inputEl.value : '').trim();
                        if (config.inputRequired && valor === '') {
                            if (inputEl) {
                                inputEl.focus();
                                inputEl.classList.add('border-red-500');
                            }
                            return;
                        }
                        if (inputEl) {
                            inputEl.classList.remove('border-red-500');
                        }
                        cleanup(valor);
                        return;
                    }
                    cleanup(true);
                };
                const onCancel = () => cleanup(wantsInput ? null : false);
                const onBackdrop = (event) => {
                    if (event.target === modal) {
                        cleanup(wantsInput ? null : (config.showCancel ? false : true));
                    }
                };
                const onKeydown = (event) => {
                    if (event.key === 'Escape') {
                        cleanup(wantsInput ? null : (config.showCancel ? false : true));
                    }
                };
                const onInputKeydown = (event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        onConfirm();
                    }
                };

                confirmBtn.addEventListener('click', onConfirm);
                cancelBtn.addEventListener('click', onCancel);
                modal.addEventListener('click', onBackdrop);
                document.addEventListener('keydown', onKeydown);
                if (wantsInput && inputEl) {
                    inputEl.addEventListener('keydown', onInputKeydown);
                    setTimeout(() => inputEl.focus(), 30);
                } else {
                    confirmBtn.focus();
                }
            });
        }

        function exactoShowAlert(message, options = {}) {
            return exactoUiDialog({
                title: options.title || 'Aviso',
                message,
                confirmText: options.confirmText || 'Aceptar',
                showCancel: false,
                icon: options.icon || null,
            });
        }

        function exactoShowConfirm(message, options = {}) {
            return exactoUiDialog({
                title: options.title || 'Confirmar',
                message,
                confirmText: options.confirmText || 'Continuar',
                cancelText: options.cancelText || 'Cancelar',
                showCancel: true,
                icon: options.icon || 'warning',
            });
        }

        function exactoShowPrompt(message, options = {}) {
            return exactoUiDialog({
                title: options.title || 'Captura',
                message,
                confirmText: options.confirmText || 'Aceptar',
                cancelText: options.cancelText || 'Cancelar',
                showCancel: true,
                showInput: true,
                inputLabel: options.inputLabel || 'Ticket / factura',
                inputPlaceholder: options.inputPlaceholder || 'Ticket, factura o folio',
                inputValue: options.inputValue || '',
                inputRequired: options.inputRequired !== false,
                icon: options.icon || 'warning',
            });
        }

        let exactoOrdenSubmitInFlight = false;
        let exactoOrdenSubmitPreparing = false;
        let exactoGuardadoPendiente = null;
        let exactoSubmissionToken = '';
        let exactoSersop01AbonoAplicado = 0;
        let exactoOrdenFormTieneCambios = false;
        let exactoOrdenPermitirSalirSinConfirmar = false;

        function exactoReiniciarEstadoSucioOrdenForm() {
            exactoOrdenFormTieneCambios = false;
        }

        function exactoMarcarOrdenFormSucio() {
            if (exactoOrdenPermitirSalirSinConfirmar || exactoOrdenSubmitInFlight) {
                return;
            }
            exactoOrdenFormTieneCambios = true;
        }

        function exactoPermitirSalidaOrdenForm() {
            exactoOrdenPermitirSalirSinConfirmar = true;
            exactoOrdenFormTieneCambios = false;
            exactoLiberarLockEdicionOrden();
            exactoBorrarBorradorOrdenLocal();
        }
        window.exactoPermitirSalidaOrdenForm = exactoPermitirSalidaOrdenForm;

        const EXACTO_BORRADOR_KEY_PREFIX = 'exacto_orden_borrador_v3:';
        const EXACTO_BORRADOR_LEGACY_KEY_PREFIX = 'exacto_orden_borrador_v2:';
        const EXACTO_BORRADOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
        let exactoBorradorTimer = null;
        let exactoBorradorRestaurando = false;

        function exactoBorradorStorageSuffix() {
            const id = Number(document.getElementById('id_orden_c')?.value || 0);
            const modo = String(document.getElementById('modo_completar')?.value || '0');
            if (id > 0) {
                return 'edit:' + id;
            }
            return 'nueva:' + (modo === '1' ? 'completar' : 'registro');
        }

        function exactoBorradorStorageKey() {
            return EXACTO_BORRADOR_KEY_PREFIX + exactoBorradorStorageSuffix();
        }

        function exactoBorradorSoloParaOrdenNueva() {
            return Number(document.getElementById('id_orden_c')?.value || 0) <= 0;
        }

        function exactoBorradorUiSet(texto, tono) {
            let el = document.getElementById('exactoBorradorEstado');
            if (!el) {
                const form = document.getElementById('ordenForm');
                if (!form) return;
                el = document.createElement('div');
                el.id = 'exactoBorradorEstado';
                el.className = 'mb-4 rounded-lg border px-4 py-2 text-sm font-semibold';
                form.insertBefore(el, form.firstChild);
            }
            el.textContent = texto || '';
            el.classList.toggle('hidden', !texto);
            el.className = 'mb-4 rounded-lg border px-4 py-2 text-sm font-semibold '
                + (tono === 'ok'
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                    : tono === 'warn'
                        ? 'border-amber-300 bg-amber-50 text-amber-950'
                        : 'border-slate-300 bg-slate-50 text-slate-800');
        }

        function exactoFirmaDataUrlSiHay(canvasId) {
            const canvas = document.getElementById(canvasId);
            if (!canvas || !canvasPareceFirmado(canvasId)) {
                return '';
            }
            try {
                return canvas.toDataURL('image/png');
            } catch (_) {
                return '';
            }
        }

        function exactoRecolectarBorradorOrden() {
            const form = document.getElementById('ordenForm');
            if (!form) return null;

            const pick = (selector) => {
                const el = form.querySelector(selector);
                return el ? String(el.value || '') : '';
            };

            const equipos = [];
            document.querySelectorAll('#equiposTableBody .equipo-row').forEach((row) => {
                equipos.push({
                    marca: row.querySelector('[name*="[marca]"]')?.value || '',
                    modelo: row.querySelector('[name*="[modelo]"]')?.value || '',
                    serie: row.querySelector('[name*="[serie]"]')?.value || '',
                    descripcion_falla: row.querySelector('[name*="[descripcionFalla]"]')?.value || '',
                    tipo_servicio: row.querySelector('[name*="[tipoServicio]"]')?.value || '',
                    clave: row.querySelector('[name*="[clave]"]')?.value || '',
                });
            });

            const trabajos = [];
            document.querySelectorAll('#trabajosTableBody .trabajo-row').forEach((row) => {
                if (row.dataset.sersop01Auto === '1') return;
                const ticketEl = exactoCampoTicket(row);
                trabajos.push({
                    clave: row.querySelector('[name*="[clave]"]')?.value || '',
                    descripcion: row.querySelector('[name*="[descripcion]"]')?.value || '',
                    importe: row.querySelector('[name*="[importe]"]')?.value || '',
                    ticket: ticketEl ? String(ticketEl.value || '') : '',
                    id_equipo: row.querySelector('[name*="[id_equipo]"]')?.value || '',
                });
            });

            const materiales = [];
            document.querySelectorAll('#materialesTableBody .material-row').forEach((row) => {
                const ticketEl = exactoCampoTicket(row);
                materiales.push({
                    vale: row.querySelector('[name*="[vale]"]')?.value || '',
                    codigo: row.querySelector('[name*="[codigo]"]')?.value || '',
                    cantidad: row.querySelector('[name*="[cant]"]')?.value || '',
                    descripcion: row.querySelector('[name*="[descripcion]"]')?.value || '',
                    precio_unitario: row.querySelector('[name*="[precio]"]')?.value || '',
                    ticket: ticketEl ? String(ticketEl.value || '') : '',
                    id_equipo: row.querySelector('[name*="[id_equipo]"]')?.value || '',
                });
            });

            const anticipos = [];
            document.querySelectorAll('#anticiposTableBody .anticipo-row').forEach((row) => {
                const ticketEl = exactoCampoTicket(row);
                anticipos.push({
                    folio: row.querySelector('[name*="[folio]"]')?.value || '',
                    descripcion: row.querySelector('[name*="[descripcion]"]')?.value || '',
                    monto: row.querySelector('[name*="[monto]"]')?.value || '',
                    ticket: ticketEl ? String(ticketEl.value || '') : '',
                    id_equipo: row.querySelector('[name*="[id_equipo]"]')?.value || '',
                });
            });

            const sersop01 = {};
            document.querySelectorAll('#exactoSersop01Campos input[data-sersop01-auto="1"]').forEach((input) => {
                const name = String(input.getAttribute('name') || '');
                const m = name.match(/\[(clave|descripcion|importe|ticket)\]$/);
                if (m) sersop01[m[1]] = String(input.value || '');
            });

            return {
                version: 3,
                savedAt: Date.now(),
                id_orden_c: pick('#id_orden_c'),
                cab: {
                    nombre_cliente: pick('[name="nombreCliente"]'),
                    direccion: pick('[name="direccion"]'),
                    telefono: pick('[name="telefono"]'),
                    correo: pick('[name="correo"]'),
                    poblacion: pick('[name="poblacion"]'),
                    folio: pick('[name="folio"]'),
                    fecha_entrada: pick('[name="fechaEntrada"]'),
                    fecha_terminada: pick('[name="fechaTerminada"]'),
                    fecha_salida: pick('[name="fechaSalida"]'),
                    estatus: pick('#inputEstatus') || pick('[name="estatus"]'),
                    entregado_por_tecnico: pick('[name="entregado_por_tecnico"]'),
                    recibido_cliente: pick('[name="recibido_cliente"]'),
                    tecnico_recibido: pick('[name="tecnico_recibido"]'),
                    comentarios_m: pick('[name="comentarios_m"]') || pick('#comentariosTecnico'),
                },
                equipos,
                trabajos,
                materiales,
                anticipos,
                observaciones_items: exactoLeerTextosObservaciones(),
                abono_saldo: pick('#abonoSaldoAplicado'),
                submission_token: exactoSubmissionToken,
                sersop01_abono_auto: exactoSersop01AbonoAplicado,
                saldo_pagado_confirmado: pick('#saldoPagadoConfirmado'),
                sersop01,
                firmas: {
                    firma_c_e: exactoFirmaDataUrlSiHay('firmaClienteInicial'),
                    firma_t_r: exactoFirmaDataUrlSiHay('firmaTecnicoInicial'),
                    firma_c_r: exactoFirmaDataUrlSiHay('firmaCliente'),
                    firma_t_e: exactoFirmaDataUrlSiHay('firmaTecnico'),
                },
            };
        }

        function exactoBorradorTieneContenidoUtil(draft) {
            if (!draft || !draft.cab) return false;
            const cab = draft.cab;
            const textoCab = [cab.nombre_cliente, cab.direccion, cab.telefono, cab.correo, cab.poblacion]
                .map((v) => String(v || '').trim())
                .join('');
            if (textoCab !== '') return true;
            if ((draft.equipos || []).some((e) => String(e.marca || e.modelo || e.serie || e.descripcion_falla || '').trim() !== '')) {
                return true;
            }
            if ((draft.trabajos || []).some((t) => String(t.clave || t.descripcion || t.importe || '').trim() !== '')) {
                return true;
            }
            if ((draft.materiales || []).some((m) => String(m.vale || m.descripcion || m.precio_unitario || '').trim() !== '')) {
                return true;
            }
            if ((draft.anticipos || []).some((a) => String(a.folio || a.descripcion || a.monto || '').trim() !== '')) {
                return true;
            }
            if ((draft.observaciones_items || []).some((o) => String(o || '').trim() !== '')) {
                return true;
            }
            if (draft.sersop01 && String(draft.sersop01.clave || '').trim() !== '') {
                return true;
            }
            const firmas = draft.firmas || {};
            if (firmas.firma_c_e || firmas.firma_t_r || firmas.firma_c_r || firmas.firma_t_e) {
                return true;
            }
            return false;
        }

        function exactoGuardarBorradorOrdenLocal(forzar) {
            if (exactoBorradorRestaurando || exactoOrdenSubmitInFlight) {
                return false;
            }
            // Las órdenes existentes siempre se recuperan desde el servidor. Un snapshot parcial
            // puede borrar IDs, relaciones y estados por equipo al aplicarse encima.
            if (!exactoBorradorSoloParaOrdenNueva()) {
                exactoBorrarBorradorOrdenLocal();
                return false;
            }
            // "forzar" solo adelanta el guardado al ocultar/salir; no crea un borrador
            // si el usuario no hizo ningún cambio real.
            if (!exactoOrdenFormTieneCambios) {
                return false;
            }
            try {
                const draft = exactoRecolectarBorradorOrden();
                if (!draft || !exactoBorradorTieneContenidoUtil(draft)) {
                    exactoBorrarBorradorOrdenLocal();
                    return false;
                }
                localStorage.setItem(exactoBorradorStorageKey(), JSON.stringify(draft));
                const hora = new Date(draft.savedAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
                exactoBorradorUiSet('Borrador local guardado a las ' + hora + ' (se recupera si se recarga o sale el modo PC).', 'ok');
                return true;
            } catch (e) {
                console.warn('No se pudo guardar borrador local', e);
                exactoBorradorUiSet('No se pudo guardar el borrador local (¿almacenamiento lleno?).', 'warn');
                return false;
            }
        }

        function exactoProgramarGuardadoBorradorOrden() {
            if (exactoBorradorRestaurando) return;
            if (exactoBorradorTimer) clearTimeout(exactoBorradorTimer);
            exactoBorradorTimer = setTimeout(() => {
                exactoBorradorTimer = null;
                exactoGuardarBorradorOrdenLocal(false);
            }, 700);
        }

        function exactoLeerBorradorOrdenLocal() {
            try {
                // La versión 2 podía sobrescribir datos del servidor; descartarla al encontrarla.
                localStorage.removeItem(EXACTO_BORRADOR_LEGACY_KEY_PREFIX + exactoBorradorStorageSuffix());
                if (!exactoBorradorSoloParaOrdenNueva()) {
                    exactoBorrarBorradorOrdenLocal();
                    return null;
                }
                const raw = localStorage.getItem(exactoBorradorStorageKey());
                if (!raw) return null;
                const draft = JSON.parse(raw);
                if (!draft || Number(draft.version) !== 3 || !draft.savedAt) {
                    exactoBorrarBorradorOrdenLocal();
                    return null;
                }
                if ((Date.now() - Number(draft.savedAt)) > EXACTO_BORRADOR_TTL_MS) {
                    exactoBorrarBorradorOrdenLocal();
                    return null;
                }
                return draft;
            } catch (_) {
                return null;
            }
        }

        function exactoBorrarBorradorOrdenLocal() {
            try {
                localStorage.removeItem(exactoBorradorStorageKey());
                localStorage.removeItem(EXACTO_BORRADOR_LEGACY_KEY_PREFIX + exactoBorradorStorageSuffix());
            } catch (_) { /* ignore */ }
            const el = document.getElementById('exactoBorradorEstado');
            if (el) el.classList.add('hidden');
        }

        async function exactoAplicarBorradorOrdenLocal(draft) {
            if (!draft) return;
            if (!exactoBorradorSoloParaOrdenNueva()) {
                exactoBorrarBorradorOrdenLocal();
                return;
            }
            exactoBorradorRestaurando = true;
            try {
                const idActual = Number(document.getElementById('id_orden_c')?.value || 0);
                const cab = Object.assign({}, draft.cab || {});

                // En edición: NUNCA sobrescribir estatus ni fechas de taller con el borrador local.
                // Eso provocaba saltos "de la nada" a En proceso/Terminado al pulsar "Sí, recuperar".
                if (idActual > 0) {
                    const estatusEl = document.getElementById('inputEstatus')
                        || document.querySelector('[name="estatus"]');
                    if (estatusEl) {
                        cab.estatus = String(estatusEl.value || '').trim() || cab.estatus;
                    }
                    const folioEl = document.querySelector('[name="folio"]');
                    if (folioEl && String(folioEl.value || '').trim() !== '') {
                        cab.folio = String(folioEl.value || '').trim();
                    }
                    const ftEl = document.querySelector('[name="fechaTerminada"]');
                    const fsEl = document.querySelector('[name="fechaSalida"]');
                    const feEl = document.querySelector('[name="fechaEntrada"]');
                    if (ftEl) cab.fecha_terminada = String(ftEl.value || '');
                    if (fsEl) cab.fecha_salida = String(fsEl.value || '');
                    if (feEl && String(feEl.value || '').trim() !== '') {
                        cab.fecha_entrada = String(feEl.value || '');
                    }
                }

                const payload = {
                    id_orden_c: idActual > 0 ? idActual : (draft.id_orden_c || ''),
                    cab,
                    t: {
                        comentarios_m: cab.comentarios_m || '',
                        recibido_cliente: cab.recibido_cliente || '',
                    },
                    equipos: draft.equipos || [],
                    trabajos: draft.trabajos || [],
                    materiales: draft.materiales || [],
                    anticipos: draft.anticipos || [],
                    observaciones_items: draft.observaciones_items || [],
                    firmas: draft.firmas || {},
                };
                // En orden nueva no sobrescribir folio vacío del servidor con basura.
                if (idActual <= 0) {
                    payload.id_orden_c = '';
                }
                await Promise.resolve(aplicarOrdenExistente(payload));

                // Reafirmar estatus del servidor por si aplicarOrdenExistente lo normalizó mal.
                if (idActual > 0 && cab.estatus) {
                    const estatusEl = document.getElementById('inputEstatus');
                    if (estatusEl) {
                        estatusEl.value = exactoNormalizarEstatusOrden(cab.estatus);
                        if (typeof exactoAplicarColorEstatus === 'function') {
                            exactoAplicarColorEstatus();
                        }
                        if (typeof exactoSincronizarFirmasEntregaPorEstatus === 'function') {
                            exactoSincronizarFirmasEntregaPorEstatus();
                        }
                        if (typeof actualizarColumnaAccionesEquipos === 'function') {
                            actualizarColumnaAccionesEquipos();
                        }
                    }
                }

                exactoAsegurarCamposAbonoNuevaOrden();
                const abonoEl = document.getElementById('abonoSaldoAplicado');
                if (abonoEl && draft.abono_saldo != null) {
                    abonoEl.value = String(draft.abono_saldo || '0');
                }
                const confEl = document.getElementById('saldoPagadoConfirmado');
                if (confEl && draft.saldo_pagado_confirmado != null) {
                    confEl.value = String(draft.saldo_pagado_confirmado || '0');
                }

                if (draft.sersop01 && String(draft.sersop01.clave || '').toUpperCase() === 'SERSOP01') {
                    exactoAgregarSersop01Oculto(draft.sersop01.ticket || '');
                    const box = document.getElementById('exactoSersop01Campos');
                    if (box && draft.sersop01.importe) {
                        const imp = box.querySelector('input[name*="[importe]"]');
                        if (imp) imp.value = String(draft.sersop01.importe);
                    }
                    exactoSersop01AbonoAplicado = Number(draft.sersop01_abono_auto
                        ?? Math.min(Number(draft.sersop01.importe || 603.45), Number(draft.abono_saldo || 0)));
                }
                exactoSubmissionToken = String(draft.submission_token || '');

                if (typeof calcularTotalFactura === 'function') {
                    try { calcularTotalFactura(); } catch (_) { /* ignore */ }
                }
            } finally {
                exactoBorradorRestaurando = false;
                setTimeout(exactoReiniciarEstadoSucioOrdenForm, 80);
            }
        }

        async function exactoOfrecerRestaurarBorradorSiHay() {
            const draft = exactoLeerBorradorOrdenLocal();
            if (!draft || !exactoBorradorTieneContenidoUtil(draft)) {
                return;
            }
            const cuando = new Date(draft.savedAt).toLocaleString('es-MX');
            const restaurar = await exactoShowConfirm(
                'Se encontró un borrador local sin guardar (por ejemplo si la tablet salió del modo PC o se recargó la página).\n\n'
                + 'Guardado: ' + cuando + '\n\n'
                + '¿Quieres recuperar esos datos?\n\n'
                + 'Nota: el estatus de la orden (Recepción / En proceso / Terminado / Entregado) no se cambia; se mantiene el del servidor.',
                {
                    title: 'Recuperar borrador',
                    confirmText: 'Sí, recuperar',
                    cancelText: 'No, descartar',
                    icon: 'warning',
                }
            );
            if (!restaurar) {
                exactoBorrarBorradorOrdenLocal();
                exactoBorradorUiSet('Borrador local descartado.', 'warn');
                return;
            }
            await exactoAplicarBorradorOrdenLocal(draft);
            // Reescribe el borrador ya con el estatus correcto del servidor.
            try { exactoGuardarBorradorOrdenLocal(true); } catch (_) { /* ignore */ }
            exactoBorradorUiSet('Borrador recuperado (estatus del servidor conservado). Recuerda guardar la orden.', 'ok');
            exactoOrdenFormTieneCambios = true;
        }

        function exactoIniciarAutosaveBorradorOrden() {
            const form = document.getElementById('ordenForm');
            if (!form || form.dataset.exactoBorradorConfigurado === '1') {
                return;
            }
            if (!exactoBorradorSoloParaOrdenNueva()) {
                exactoBorrarBorradorOrdenLocal();
                return;
            }
            form.dataset.exactoBorradorConfigurado = '1';

            const onChange = () => {
                exactoMarcarOrdenFormSucio();
                exactoProgramarGuardadoBorradorOrden();
            };
            form.addEventListener('input', onChange, true);
            form.addEventListener('change', onChange, true);

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    exactoGuardarBorradorOrdenLocal(true);
                }
            });
            window.addEventListener('pagehide', () => {
                exactoGuardarBorradorOrdenLocal(true);
            });
            // Tablets: al rotar / cambiar modo a veces solo dispara resize.
            window.addEventListener('orientationchange', () => {
                exactoGuardarBorradorOrdenLocal(true);
            });
        }

        function exactoOrdenDebeConfirmarSalida() {
            return exactoOrdenFormTieneCambios && !exactoOrdenPermitirSalirSinConfirmar && !exactoOrdenSubmitInFlight;
        }

        function exactoConfigurarAvisoSalidaOrdenForm(form) {
            if (!form || form.dataset.exactoSalidaConfigurada === '1') {
                return;
            }
            form.dataset.exactoSalidaConfigurada = '1';

            form.addEventListener('input', exactoMarcarOrdenFormSucio, true);
            form.addEventListener('change', exactoMarcarOrdenFormSucio, true);

            if (!window.EXACTO_ORDEN_AVISO_SALIDA_INSTALADO) {
                window.EXACTO_ORDEN_AVISO_SALIDA_INSTALADO = true;

                window.addEventListener('beforeunload', (evento) => {
                    if (!exactoOrdenDebeConfirmarSalida()) {
                        return;
                    }
                    evento.preventDefault();
                    evento.returnValue = '';
                });

                document.addEventListener(
                    'click',
                    async (evento) => {
                        const enlace = evento.target.closest('a[href]');
                        if (!enlace || !exactoOrdenDebeConfirmarSalida()) {
                            return;
                        }
                        const href = String(enlace.getAttribute('href') || '').trim();
                        if (href === '' || href.startsWith('#') || href.startsWith('javascript:')) {
                            return;
                        }
                        if (enlace.target === '_blank' || enlace.hasAttribute('download')) {
                            return;
                        }
                        if (enlace.closest('#exactoUiModal')) {
                            return;
                        }

                        evento.preventDefault();
                        evento.stopPropagation();

                        const salir = await exactoShowConfirm(
                            'Tienes datos sin guardar en esta orden. Si sales o recargas la página, se perderán.\n\n¿Quieres salir sin guardar?',
                            {
                                title: 'Cambios sin guardar',
                                confirmText: 'Sí, salir',
                                cancelText: 'Seguir editando',
                                icon: 'warning',
                            }
                        );
                        if (salir) {
                            exactoPermitirSalidaOrdenForm();
                            window.location.assign(enlace.href);
                        }
                    },
                    true
                );
            }
        }

        function exactoGuardarStatusElements() {
            return {
                wrap: document.getElementById('ordenSubmitStatus'),
                icon: document.getElementById('ordenSubmitStatusIcon'),
                text: document.getElementById('ordenSubmitStatusText'),
            };
        }

        function exactoMostrarEstadoGuardado(type, message) {
            const { wrap, icon, text } = exactoGuardarStatusElements();
            if (!wrap || !icon || !text) return;

            wrap.classList.remove(
                'hidden',
                'border-blue-200',
                'bg-blue-50',
                'text-blue-900',
                'border-emerald-200',
                'bg-emerald-50',
                'text-emerald-900',
                'border-red-200',
                'bg-red-50',
                'text-red-900',
                'border-amber-200',
                'bg-amber-50',
                'text-amber-900'
            );

            if (type === 'success') {
                wrap.classList.add('border-emerald-200', 'bg-emerald-50', 'text-emerald-900');
                icon.className = 'mt-0.5 text-base text-emerald-700 fas fa-check-circle';
            } else if (type === 'error') {
                wrap.classList.add('border-red-200', 'bg-red-50', 'text-red-900');
                icon.className = 'mt-0.5 text-base text-red-700 fas fa-times-circle';
            } else if (type === 'info') {
                wrap.classList.add('border-amber-200', 'bg-amber-50', 'text-amber-900');
                icon.className = 'mt-0.5 text-base text-amber-700 fas fa-clock';
            } else {
                wrap.classList.add('border-blue-200', 'bg-blue-50', 'text-blue-900');
                icon.className = 'mt-0.5 text-base text-blue-700 fas fa-spinner fa-spin';
            }

            text.textContent = String(message || '');
            text.className = 'w-full font-semibold leading-relaxed text-center whitespace-pre-line';
        }

        function exactoOcultarEstadoGuardado() {
            const { wrap } = exactoGuardarStatusElements();
            if (!wrap) return;
            wrap.classList.add('hidden');
        }

        function exactoToggleBotonGuardar(disabled) {
            const button = document.getElementById('btnGuardarOrden') || document.querySelector('#ordenForm button[type="submit"]');
            if (!button) return;

            if (!button.dataset.originalHtml) {
                button.dataset.originalHtml = button.innerHTML;
            }

            button.disabled = Boolean(disabled);
            button.classList.toggle('opacity-70', Boolean(disabled));
            button.classList.toggle('cursor-not-allowed', Boolean(disabled));
            button.innerHTML = disabled
                ? '<i class="mr-2 fas fa-spinner fa-spin"></i>Guardando y enviando correo...'
                : button.dataset.originalHtml;
        }

        function exactoMarcarGuardadoEnCurso(message) {
            const form = document.getElementById('ordenForm');
            exactoOrdenSubmitInFlight = true;
            if (form) {
                form.setAttribute('aria-busy', 'true');
            }
            exactoToggleBotonGuardar(true);
            exactoMostrarEstadoGuardado('loading', message || 'Guardando orden y enviando correo, espere...');
        }

        function exactoLiberarGuardado(options = {}) {
            const form = document.getElementById('ordenForm');
            if (form) {
                form.setAttribute('aria-busy', 'false');
            }

            exactoOrdenSubmitInFlight = false;
            exactoToggleBotonGuardar(false);

            if (options.keepNotice && options.message) {
                exactoMostrarEstadoGuardado(options.type || 'info', options.message);
                return;
            }

            exactoOcultarEstadoGuardado();
        }

        function exactoEstadoCorreoTexto(data) {
            const notice = String(data && data.email_notice ? data.email_notice : '').trim();
            const level = String(data && data.email_notice_level ? data.email_notice_level : '').trim().toLowerCase();

            if (!notice) {
                return '';
            }

            if (level === 'error') {
                return 'Estado del correo: no enviado.\n' + notice;
            }
            if (level === 'confirmed') {
                return 'Estado del correo: confirmado y enviado.\n' + notice;
            }
            if (level === 'success') {
                return 'Correo enviándose correctamente.\n' + notice;
            }
            if (level === 'warning') {
                return 'Estado del correo: envío no confirmado.\n' + notice;
            }
            if (level === 'info') {
                return notice;
            }

            return 'Estado del correo: enviado.\n' + notice;
        }

        function exactoEstadoWhatsappTexto(data) {
            const notice = String(data && data.whatsapp_notice ? data.whatsapp_notice : '').trim();
            const level = String(data && data.whatsapp_notice_level ? data.whatsapp_notice_level : '').trim().toLowerCase();

            if (!notice) {
                return '';
            }

            if (level === 'error') {
                return 'Estado de WhatsApp: no enviado.\n' + notice;
            }
            if (level === 'success') {
                return 'Estado de WhatsApp: plantilla enviada.\n' + notice;
            }
            if (level === 'info') {
                return 'Estado de WhatsApp: sin nuevo envío.\n' + notice;
            }

            return 'Estado de WhatsApp: ' + notice;
        }

        function exactoResumenGuardado(data) {
            const parts = [];
            const orderMessage = String(data && data.message ? data.message : '').trim();
            const emailMessage = exactoEstadoCorreoTexto(data);
            const whatsappMessage = exactoEstadoWhatsappTexto(data);

            if (orderMessage) {
                parts.push('Estado de la orden: guardada.\n' + orderMessage);
            }
            if (emailMessage) {
                parts.push(emailMessage);
            }
            if (whatsappMessage) {
                parts.push(whatsappMessage);
            }

            return parts.filter(Boolean).join('\n\n');
        }

        function exactoTituloGuardadoOrden(data) {
            const correoLevel = String(data && data.email_notice_level ? data.email_notice_level : '').trim().toLowerCase();
            const whatsappLevel = String(data && data.whatsapp_notice_level ? data.whatsapp_notice_level : '').trim().toLowerCase();
            const correoError = !!(data && data.email_notice && correoLevel === 'error');
            const whatsappError = !!(data && data.whatsapp_notice && whatsappLevel === 'error');
            const correoOk = !!(data && data.email_notice && (correoLevel === 'success' || correoLevel === 'confirmed'));
            const whatsappOk = !!(data && data.whatsapp_notice && whatsappLevel === 'success');
            const correoConfirmado = !!(data && data.email_notice && correoLevel === 'confirmed');
            const correoNoConfirmado = !!(data && data.email_notice && correoLevel === 'warning');

            if (correoError && whatsappError) {
                return 'Orden guardada; correo y WhatsApp no enviados';
            }
            if (correoError) {
                return 'Orden guardada y correo no enviado';
            }
            if (whatsappError) {
                return 'Orden guardada y WhatsApp no enviado';
            }
            if (correoConfirmado && whatsappOk) {
                return 'Orden guardada; correo confirmado y WhatsApp enviado';
            }
            if (correoConfirmado) {
                return 'Orden guardada y correo confirmado';
            }
            if (correoOk && whatsappOk) {
                return 'Orden guardada; correo y WhatsApp enviados';
            }
            if (correoOk) {
                return 'Orden guardada y correo enviado';
            }
            if (whatsappOk) {
                return 'Orden guardada y WhatsApp enviado';
            }
            if (correoNoConfirmado) {
                return 'Orden guardada y correo no confirmado';
            }

            return 'Orden guardada';
        }

        function exactoIconoGuardadoOrden(data) {
            const correoLevel = String(data && data.email_notice_level ? data.email_notice_level : '').trim().toLowerCase();
            const whatsappLevel = String(data && data.whatsapp_notice_level ? data.whatsapp_notice_level : '').trim().toLowerCase();
            const hayErrorCorreo = correoLevel === 'error';
            const hayErrorWhatsapp = whatsappLevel === 'error';
            const hayWarningCorreo = correoLevel === 'warning';

            return (hayErrorCorreo || hayErrorWhatsapp || hayWarningCorreo) ? 'error' : 'success';
        }

        function exactoElementoVisibleParaValidar(el) {
            if (!el || typeof el.checkValidity !== 'function' || el.disabled) return false;
            const type = String(el.type || '').toLowerCase();
            if (['hidden', 'button', 'submit', 'reset'].includes(type)) return false;
            if (el.closest('.hidden, .orden-firmas-skip')) return false;
            if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
            return true;
        }

        function exactoCampoPasaValidacionHtml(el) {
            if (!exactoElementoVisibleParaValidar(el)) {
                return true;
            }
            const pattern = String(el.getAttribute('pattern') || '').trim();
            if (pattern && (el.name === 'poblacion' || el.id === 'poblacion')) {
                const val = String(el.value || '').trim();
                if (val.length < 2 || val.length > 80) {
                    return false;
                }
                return /^[A-Za-z\s.'\-]+$/.test(val);
            }
            try {
                return el.checkValidity();
            } catch (e) {
                console.warn('Validación HTML omitida por patrón inválido:', el.name || el.id, e);
                return true;
            }
        }

        async function exactoValidarFormularioHtml(form) {
            const invalidos = Array.from(form.elements || []).filter(
                (el) => !exactoCampoPasaValidacionHtml(el)
            );
            if (invalidos.length === 0) {
                return true;
            }

            const mensajes = [...new Set(invalidos.map((el) => exactoMensajeValidacionCampo(el)))];
            const texto =
                mensajes.length === 1
                    ? mensajes[0]
                    : 'Corrige los siguientes campos:\n\n' + mensajes.map((m) => `• ${m}`).join('\n');

            await exactoShowAlert(texto, {
                title: 'Faltan datos en la orden',
            });
            exactoUiFocusField(invalidos[0]);

            return false;
        }

        /**
         * Datos del catálogo: primero el arreglo global; si está vacío o no coincide, el option (data-*) del HTML.
         */
        function exactoServicioParaSelect(selectEl) {
            if (!selectEl) {
                return null;
            }
            const clave = String(selectEl.value || '').trim();
            if (clave === '') {
                return null;
            }

            const fromWin = exactoGetServiciosSersop().find(
                (servicio) => String(servicio.clave || '').trim().toUpperCase() === clave.toUpperCase()
            );
            if (fromWin) {
                return {
                    clave: fromWin.clave,
                    descripcion: String(fromWin.descripcion || ''),
                    precio: Number.parseFloat(fromWin.precio || 0),
                    editable: Boolean(fromWin.editable),
                };
            }

            const opt =
                (selectEl.selectedOptions && selectEl.selectedOptions[0])
                    ? selectEl.selectedOptions[0]
                    : selectEl.options[selectEl.selectedIndex];
            if (!opt || String(opt.value || '').trim() !== clave) {
                return null;
            }

            const precioRaw = opt.dataset.precio != null ? String(opt.dataset.precio) : '';
            const precio = Number.parseFloat(precioRaw.replace(',', '.')) || 0;
            const editable = opt.dataset.editable === '1' || opt.getAttribute('data-editable') === '1';

            return {
                clave: opt.value,
                descripcion: String(opt.dataset.descripcion || ''),
                precio,
                editable,
            };
        }

        function exactoEscapeHtml(valor) {
            return String(valor == null ? '' : valor)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        function exactoOpcionesServiciosSersop() {
            const list = exactoGetServiciosSersop();
            if (list.length > 0) {
                return list.map((servicio) => {
                    const clave = String(servicio.clave || '');
                    const descripcion = String(servicio.descripcion || '');
                    const precio = Number.parseFloat(servicio.precio || 0).toFixed(2);
                    const editable = servicio.editable ? '1' : '0';
                    const label = `${clave} - ${descripcion} ($${precio})`;
                    return `<option value="${exactoEscapeHtml(clave)}" data-descripcion="${exactoEscapeHtml(descripcion)}" data-precio="${exactoEscapeHtml(precio)}" data-editable="${editable}">${exactoEscapeHtml(label)}</option>`;
                }).join('');
            }

            const ref = document.querySelector('#trabajosTableBody tr.trabajo-row select[name*="[clave]"]');
            if (!ref || !ref.innerHTML) return '';
            return Array.from(ref.options)
                .filter((opt) => String(opt.value || '').trim() !== '')
                .map((opt) => {
                    const val = exactoEscapeHtml(opt.value || '');
                    const desc = exactoEscapeHtml(opt.dataset.descripcion || '');
                    const precio = exactoEscapeHtml(opt.dataset.precio || '');
                    const editable = opt.dataset.editable === '1' ? '1' : '0';
                    return `<option value="${val}" data-descripcion="${desc}" data-precio="${precio}" data-editable="${editable}">${val}</option>`;
                })
                .join('');
        }

        function exactoAsegurarOpcionClaveGuardada(select, clave) {
            const claveTrim = String(clave || '').trim();
            if (!select || claveTrim === '') return;
            const existe = Array.from(select.options).some((option) => option.value === claveTrim);
            if (existe) return;
            const option = document.createElement('option');
            option.value = claveTrim;
            option.textContent = `${claveTrim} (guardada)`;
            option.dataset.editable = '1';
            select.appendChild(option);
        }

        function exactoCamposTrabajo(fila) {
            if (!fila) return {};
            return {
                clave: fila.querySelector('select[name*="[clave]"]'),
                descripcion: fila.querySelector('input[name*="[descripcion]"]'),
                importe: fila.querySelector('input[name*="[importe]"]'),
                ticket: exactoCampoTicket(fila),
            };
        }

        function exactoTrabajoTieneClave(fila) {
            const campos = exactoCamposTrabajo(fila);
            return Boolean(campos.clave && String(campos.clave.value || '').trim() !== '');
        }

        function exactoActualizarTicketTrabajoFila(fila) {
            const campos = exactoCamposTrabajo(fila);
            if (!campos.ticket) return;
            // Ticket/factura opcional y siempre editable.
            exactoSetCampoTicketFactura(campos.ticket, true);
        }

        function exactoActualizarTicketsTrabajos() {
            document.querySelectorAll('#trabajosTableBody .trabajo-row').forEach(exactoActualizarTicketTrabajoFila);
        }

        function exactoSetReadOnlyServicio(input, bloqueado) {
            if (!input) return;
            input.readOnly = Boolean(bloqueado);
            if (bloqueado) {
                input.setAttribute('readonly', 'readonly');
                input.tabIndex = -1;
                input.title = 'Este campo se toma del catálogo SERSOP.';
            } else {
                input.removeAttribute('readonly');
                input.removeAttribute('tabindex');
                if (input.title === 'Este campo se toma del catálogo SERSOP.') {
                    input.removeAttribute('title');
                }
            }
            input.classList.toggle('bg-gray-100', Boolean(bloqueado));
            input.classList.toggle('text-gray-600', Boolean(bloqueado));
            input.classList.toggle('cursor-not-allowed', Boolean(bloqueado));
        }

        function exactoServicioTrabajoEsEditable(servicio, claveSelect) {
            if (servicio && servicio.editable) {
                return true;
            }
            const clave = String(
                (servicio && servicio.clave) || (claveSelect && claveSelect.value) || ''
            ).trim().toUpperCase();
            return clave === 'SERSOPSA';
        }

        function exactoAplicarBloqueoCamposTrabajo(campos, editable) {
            if (!campos) return;
            // Descripción y precio: editables solo en SERVICIO EXTRA; resto del catálogo bloqueado.
            exactoSetReadOnlyServicio(campos.descripcion, !editable);
            exactoSetReadOnlyServicio(campos.importe, !editable);
        }

        function exactoConfigurarValidacionServicio(campos, editable) {
            if (!campos.descripcion || !campos.importe) return;
            campos.descripcion.required = Boolean(editable);
            campos.importe.required = Boolean(editable);
            campos.importe.removeAttribute('min');
            if (editable) {
                campos.descripcion.placeholder = 'Descripción del servicio extra';
                campos.importe.placeholder = 'PRECIO SIN IVA (SERVICIO EXTRA)';
            }
        }

        function exactoPrevisualizarServicioTrabajo(fila) {
            const campos = exactoCamposTrabajo(fila);
            if (!campos.clave || !campos.descripcion || !campos.importe) return;
            const servicio = exactoServicioParaSelect(campos.clave);
            const editable = exactoServicioTrabajoEsEditable(servicio, campos.clave);
            exactoAplicarBloqueoCamposTrabajo(campos, editable);
            if (!servicio) return;
            if (editable) {
                campos.descripcion.placeholder = 'Descripción del servicio extra';
                campos.importe.placeholder = 'PRECIO SIN IVA (SERVICIO EXTRA)';
            } else {
                campos.descripcion.placeholder = String(servicio.descripcion || servicio.clave || 'Descripción del trabajo');
                campos.importe.placeholder = Number.parseFloat(servicio.precio || 0).toFixed(2);
            }
        }

        function exactoPrevisualizarDesdeOption(optionEl) {
            if (!optionEl || optionEl.tagName !== 'OPTION') return;
            const selectEl = optionEl.parentElement;
            if (!selectEl || selectEl.tagName !== 'SELECT' || !selectEl.matches('select[name*="[clave]"]')) return;
            const fila = selectEl.closest('.trabajo-row');
            if (!fila) return;
            const campos = exactoCamposTrabajo(fila);
            if (!campos.descripcion || !campos.importe) return;

            const valor = String(optionEl.value || '').trim();
            const editable = optionEl.dataset.editable === '1' || valor.toUpperCase() === 'SERSOPSA';
            exactoAplicarBloqueoCamposTrabajo(campos, editable);

            if (valor === '') {
                campos.descripcion.placeholder = 'Descripción del trabajo';
                campos.importe.placeholder = 'PRECIO SIN IVA';
                return;
            }
            if (editable) {
                campos.descripcion.placeholder = 'Descripción del servicio extra';
                campos.importe.placeholder = 'PRECIO SIN IVA (SERVICIO EXTRA)';
                return;
            }
            campos.descripcion.placeholder = String(optionEl.dataset.descripcion || 'Descripción del trabajo');
            campos.importe.placeholder = String(optionEl.dataset.precio || '0.00');
        }

        function exactoAplicarServicioTrabajo(fila, autocompletar, completarSiVacio) {
            const campos = exactoCamposTrabajo(fila);
            if (!campos.clave || !campos.descripcion || !campos.importe) return;

            const servicio = exactoServicioParaSelect(campos.clave);
            if (!servicio) {
                if (autocompletar) {
                    campos.descripcion.value = '';
                    campos.importe.value = '';
                }
                exactoAplicarBloqueoCamposTrabajo(campos, false);
                exactoConfigurarValidacionServicio(campos, false);
                campos.descripcion.placeholder = 'Descripción del trabajo';
                campos.importe.placeholder = 'PRECIO SIN IVA';
                exactoActualizarTicketTrabajoFila(fila);
                calcularSubtotalTrabajos();
                return;
            }

            const editable = exactoServicioTrabajoEsEditable(servicio, campos.clave);
            if (autocompletar) {
                if (editable) {
                    campos.descripcion.value = '';
                    campos.importe.value = '';
                } else {
                    campos.descripcion.value = String(servicio.descripcion || servicio.clave || '');
                    campos.importe.value = Number.parseFloat(servicio.precio || 0).toFixed(2);
                }
            } else if (!editable && completarSiVacio) {
                if (String(campos.descripcion.value || '').trim() === '') {
                    campos.descripcion.value = String(servicio.descripcion || servicio.clave || '');
                }
                if (String(campos.importe.value || '').trim() === '' || (Number.parseFloat(campos.importe.value) || 0) <= 0) {
                    campos.importe.value = Number.parseFloat(servicio.precio || 0).toFixed(2);
                }
            }

            exactoAplicarBloqueoCamposTrabajo(campos, editable);
            exactoConfigurarValidacionServicio(campos, editable);
            exactoPrevisualizarServicioTrabajo(fila);
            exactoActualizarTicketTrabajoFila(fila);
            calcularSubtotalTrabajos();
        }

        async function exactoValidarServiciosSersop(form) {
            const filas = form.querySelectorAll('#trabajosTableBody .trabajo-row');
            for (const fila of filas) {
                const campos = exactoCamposTrabajo(fila);
                if (!campos.clave || !campos.descripcion || !campos.importe) continue;
                const claveUp = String(campos.clave.value || '').trim().toUpperCase();
                const servicio = exactoServicioParaSelect(campos.clave);
                if (!servicio && claveUp !== 'SERSOPSA') {
                    continue;
                }

                const editable = exactoServicioTrabajoEsEditable(servicio, campos.clave);
                exactoAplicarServicioTrabajo(fila, false, !editable);
                exactoAplicarBloqueoCamposTrabajo(campos, editable);

                if (!editable) continue;

                const descripcion = String(campos.descripcion.value || '').trim();
                const precio = Number.parseFloat(campos.importe.value || '0');
                const filaNum = exactoNumeroFilaTabla(fila);
                if (descripcion === '') {
                    await exactoShowAlert(
                        `Trabajo (fila ${filaNum}, SERVICIO EXTRA): captura la descripción.`,
                        { title: 'Faltan datos en la orden' }
                    );
                    exactoUiFocusField(campos.descripcion);
                    return false;
                }
                if (String(campos.importe.value || '').trim() === '' || !Number.isFinite(precio)) {
                    await exactoShowAlert(
                        `Trabajo (fila ${filaNum}, SERVICIO EXTRA): captura un precio sin IVA válido.`,
                        { title: 'Faltan datos en la orden' }
                    );
                    exactoUiFocusField(campos.importe);
                    return false;
                }
            }
            return true;
        }

        function exactoCamposEquipo(fila) {
            return {
                marca: fila.querySelector('[name*="[marca]"]'),
                modelo: fila.querySelector('[name*="[modelo]"]'),
                serie: fila.querySelector('[name*="[serie]"]'),
                descripcionFalla: fila.querySelector('[name*="[descripcionFalla]"]'),
                tipoServicio: fila.querySelector('[name*="[tipoServicio]"]'),
            };
        }

        async function exactoValidarEquipos() {
            const filas = Array.from(document.querySelectorAll('#equiposTableBody .equipo-row'));
            const requeridos = [
                ['marca', 'la marca'],
                ['modelo', 'el modelo o descripción'],
                ['serie', 'el número de serie'],
                ['descripcionFalla', 'la descripción de falla'],
                ['tipoServicio', 'el tipo de servicio'],
            ];
            let filasCompletas = 0;

            for (const fila of filas) {
                const campos = exactoCamposEquipo(fila);
                const valores = {};
                let conAlgo = false;
                let faltantes = 0;
                for (const [clave] of requeridos) {
                    const valor = String(campos[clave] ? campos[clave].value : '').trim();
                    valores[clave] = valor;
                    if (valor !== '') {
                        conAlgo = true;
                    } else {
                        faltantes += 1;
                    }
                }

                if (!conAlgo) {
                    continue;
                }

                const filaNum = exactoNumeroFilaTabla(fila);
                for (const [clave, etiqueta] of requeridos) {
                    if (valores[clave] === '') {
                        await exactoShowAlert(
                            `Equipo (fila ${filaNum}): falta ${etiqueta}. Completa todos los campos de la fila.`,
                            { title: 'Faltan datos en la orden' }
                        );
                        exactoUiFocusField(campos[clave]);
                        return false;
                    }
                }

                if (faltantes === 0) {
                    filasCompletas += 1;
                }
            }

            if (filasCompletas === 0) {
                const primera = filas[0];
                const campos = primera ? exactoCamposEquipo(primera) : null;
                await exactoShowAlert(
                    'Captura al menos un equipo con todos sus campos: marca, modelo, número de serie, descripción de falla y tipo de servicio.',
                    { title: 'Faltan datos en la orden' }
                );
                if (campos && campos.marca) {
                    exactoUiFocusField(campos.marca);
                }
                return false;
            }

            return true;
        }

        function ensureEquipoRowCount(n) {
            const tbody = document.getElementById('equiposTableBody');
            let rows = tbody.querySelectorAll('.equipo-row');
            // Durante la recuperación de un borrador no eliminar filas: solo completar hasta n.
            if (!exactoBorradorRestaurando) {
                while (rows.length > n) {
                    const last = rows[rows.length - 1];
                    if (rows.length <= 1) break;
                    eliminarEquipo(last);
                    rows = tbody.querySelectorAll('.equipo-row');
                }
            }
            while (rows.length < n) {
                agregarEquipo();
                rows = tbody.querySelectorAll('.equipo-row');
            }
            actualizarNumerosEquipos();
        }

        function ensureTrabajoRowCount(n) {
            const tbody = document.getElementById('trabajosTableBody');
            if (!tbody) return;
            let rows = tbody.querySelectorAll('.trabajo-row');
            if (!exactoBorradorRestaurando) {
                while (rows.length > n) {
                    if (rows.length <= 1) break;
                    eliminarTrabajo(rows[rows.length - 1]);
                    rows = tbody.querySelectorAll('.trabajo-row');
                }
            }
            while (rows.length < n) {
                agregarTrabajo();
                rows = tbody.querySelectorAll('.trabajo-row');
            }
            actualizarNumerosTrabajos();
        }

        function ensureMaterialRowCount(n) {
            const tbody = document.getElementById('materialesTableBody');
            if (!tbody) return;
            let rows = tbody.querySelectorAll('.material-row');
            if (!exactoBorradorRestaurando) {
                while (rows.length > n) {
                    if (rows.length <= 1) break;
                    eliminarMaterial(rows[rows.length - 1]);
                    rows = tbody.querySelectorAll('.material-row');
                }
            }
            while (rows.length < n) {
                agregarMaterial();
                rows = tbody.querySelectorAll('.material-row');
            }
        }

        function ensureAnticipoRowCount(n) {
            const tbody = document.getElementById('anticiposTableBody');
            if (!tbody) return;
            let rows = tbody.querySelectorAll('.anticipo-row');
            if (!exactoBorradorRestaurando) {
                while (rows.length > n) {
                    if (rows.length <= 1) break;
                    eliminarAnticipo(rows[rows.length - 1]);
                    rows = tbody.querySelectorAll('.anticipo-row');
                }
            }
            while (rows.length < n) {
                agregarAnticipo();
                rows = tbody.querySelectorAll('.anticipo-row');
            }
        }

        function precargarFirmaEnCanvas(canvasId, url) {
            return new Promise((resolve) => {
                if (!url || typeof url !== 'string') {
                    resolve();
                    return;
                }
                const img = new Image();
                img.onload = () => {
                    const canvas = document.getElementById(canvasId);
                    const ctx = canvasContexts[canvasId];
                    if (!canvas || !ctx) {
                        resolve();
                        return;
                    }
                    try {
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    } catch (e) {
                        console.warn('No se pudo dibujar firma en', canvasId);
                    }
                    resolve();
                };
                img.onerror = () => resolve();
                img.src = url;
            });
        }

        function aplicarOrdenExistente(data) {
            const cab = data.cab || {};
            document.getElementById('id_orden_c').value = String(data.id_orden_c || '');
            document.querySelector('[name="nombreCliente"]').value = cab.nombre_cliente || '';
            document.querySelector('[name="direccion"]').value = cab.direccion || '';
            document.querySelector('[name="telefono"]').value = String(cab.telefono || '').replace(/\D/g, '').slice(0, 20);
            document.querySelector('[name="correo"]').value = cab.correo || '';
            document.querySelector('[name="poblacion"]').value = cab.poblacion || '';
            document.querySelector('[name="folio"]').value = cab.folio || '';
            document.querySelector('[name="fechaEntrada"]').value = toDatetimeLocalValue(cab.fecha_entrada);
            const estatusEl = document.getElementById('inputEstatus');
            if (estatusEl) {
                estatusEl.value = exactoNormalizarEstatusOrden(cab.estatus);
                exactoAplicarColorEstatus();
            }
            exactoSincronizarFirmasEntregaPorEstatus();
            actualizarColumnaAccionesEquipos();
            const ct = document.getElementById('clienteTexto');
            const ct2 = document.getElementById('clienteTexto2');
            if (ct) ct.textContent = cab.nombre_cliente || 'Cliente';
            if (ct2) ct2.textContent = cab.nombre_cliente || 'Cliente';
            const nc = document.querySelector('[name="nombreCliente"]');
            if (nc) {
                nc.dispatchEvent(new Event('input', { bubbles: true }));
            }

            const equipos = data.equipos || [];
            ensureEquipoRowCount(Math.max(1, equipos.length));
            const eqRows = document.querySelectorAll('#equiposTableBody .equipo-row');
            equipos.forEach((eq, i) => {
                const row = eqRows[i];
                if (!row) return;
                const g = (name) => row.querySelector(`[name="equipos[${i}][${name}]"]`);
                const inpMarca = g('marca');
                const inpModelo = g('modelo');
                const inpSerie = g('serie');
                const inpDesc = g('descripcionFalla');
                const selTipo = g('tipoServicio');
                if (inpMarca) inpMarca.value = eq.marca || '';
                if (inpModelo) inpModelo.value = eq.modelo || '';
                if (inpSerie) inpSerie.value = eq.serie || '';
                if (inpDesc) inpDesc.value = eq.descripcion_falla || '';
                exactoSeleccionarTipoServicio(selTipo, eq.tipo_servicio || '');
                const dbId = Number(eq.id_equipo) || 0;
                row.dataset.idEquipoDb = dbId > 0 ? String(dbId) : '';
                row.dataset.acciones = String(Number(eq.acciones) || 0);
                row.dataset.entregaReceptorTipo = String(eq.entrega_receptor_tipo || '');
                row.dataset.entregaRecibidoCliente = String(eq.entrega_recibido_cliente || '');
                row.dataset.entregaFecha = String(eq.entrega_fecha || '');
                row.dataset.entregaTecnico = String(eq.entrega_tecnico || '');
                exactoPintarEstatusEquipoFila(row, Number(eq.acciones) || 0);
                const btnEntrega = row.querySelector('.btn-entrega-equipo-row');
                if (btnEntrega) {
                    btnEntrega.dataset.idEquipo = String(i + 1);
                    if (dbId > 0) {
                        btnEntrega.dataset.idEquipoDb = String(dbId);
                    }
                }
            });
            actualizarNumerosEquipos();
            actualizarColumnaAccionesEquipos();

            const trabajos = data.trabajos || [];
            ensureTrabajoRowCount(Math.max(1, trabajos.length));
            const trRows = document.querySelectorAll('#trabajosTableBody .trabajo-row');
            trabajos.forEach((tr, i) => {
                const row = trRows[i];
                if (!row) return;
                const clave = row.querySelector(`[name="trabajos[${i}][clave]"]`);
                const d = row.querySelector(`[name="trabajos[${i}][descripcion]"]`);
                const imp = row.querySelector(`[name="trabajos[${i}][importe]"]`);
                const claveGuardada = tr.clave || (equipos[i] && equipos[i].clave) || '';
                if (clave) {
                    exactoAsegurarOpcionClaveGuardada(clave, claveGuardada);
                    clave.value = claveGuardada;
                }
                if (d) d.value = tr.descripcion || '';
                if (imp) imp.value = tr.importe != null ? String(tr.importe) : '';
                const ticket = exactoCampoTicket(row);
                exactoAsignarTicketFactura(ticket, tr.ticket || '');
                exactoAplicarServicioTrabajo(row, false, true);
            });
            exactoActualizarSelectsEquipo();
            trRows.forEach((row, i) => {
                const eqSel = row.querySelector(`[name="trabajos[${i}][id_equipo]"]`);
                const eqVal = trabajos[i] ? Number(trabajos[i].id_equipo) || 0 : 0;
                if (eqSel && eqVal > 0) eqSel.value = String(eqVal);
            });

            const mats = data.materiales || [];
            ensureMaterialRowCount(Math.max(1, mats.length));
            const matRows = document.querySelectorAll('#materialesTableBody .material-row');
            mats.forEach((m, i) => {
                const row = matRows[i];
                if (!row) return;
                const q = (k) => row.querySelector(`[name="materiales[${i}][${k}]"]`);
                const sp = row.querySelector('.importe-calc');
                if (q('vale')) q('vale').value = m.vale || '';
                if (q('codigo')) q('codigo').value = m.codigo || '';
                if (q('cant')) q('cant').value = m.cantidad != null ? String(m.cantidad) : '';
                if (q('descripcion')) q('descripcion').value = m.descripcion || '';
                if (q('anticipo')) q('anticipo').value = m.anticipo != null ? String(m.anticipo) : '';
                if (q('precio')) q('precio').value = m.precio_unitario != null ? String(m.precio_unitario) : '';
                exactoAsignarTicketFactura(q('ticket'), m.ticket || '');
                calcularImporte(row);
                if (sp && (!sp.textContent || sp.textContent === '0.00') && m.importe != null) {
                    sp.textContent = parseFloat(m.importe).toFixed(2);
                }
            });
            exactoActualizarSelectsEquipo();
            matRows.forEach((row, i) => {
                const eqSel = row.querySelector(`[name="materiales[${i}][id_equipo]"]`);
                const eqVal = mats[i] ? Number(mats[i].id_equipo) || 0 : 0;
                if (eqSel && eqVal > 0) eqSel.value = String(eqVal);
            });
            exactoActualizarTicketsMateriales();

            const anticipos = data.anticipos || [];
            ensureAnticipoRowCount(Math.max(1, anticipos.length));
            const anticipoRows = document.querySelectorAll('#anticiposTableBody .anticipo-row');
            anticipos.forEach((anticipo, i) => {
                const row = anticipoRows[i];
                if (!row) return;
                const folio = row.querySelector(`[name="anticipos[${i}][folio]"]`);
                const descripcion = row.querySelector(`[name="anticipos[${i}][descripcion]"]`);
                const monto = row.querySelector(`[name="anticipos[${i}][monto]"]`);
                let ticketCell = row.querySelector('td:nth-child(4)');
                const ticketValor = String(anticipo.ticket || '').trim();
                if (folio) folio.value = String(anticipo.folio || '').trim();
                if (descripcion) descripcion.value = String(anticipo.descripcion || '').trim();
                if (ticketValor.toUpperCase() === 'PAGO SALDO PENDIENTE' && ticketCell) {
                    ticketCell.innerHTML = exactoAnticipoTicketSaldoPagoHtml(`anticipos[${i}][ticket]`, ticketValor);
                    row.dataset.saldoPago = '1';
                    if (folio) {
                        folio.readOnly = true;
                        folio.classList.add('bg-gray-100', 'cursor-not-allowed');
                    }
                    if (descripcion) {
                        descripcion.readOnly = true;
                        descripcion.classList.add('bg-gray-100', 'cursor-not-allowed');
                    }
                } else {
                    const ticket = row.querySelector(`[name="anticipos[${i}][ticket]"]`);
                    exactoAsignarTicketFactura(ticket, ticketValor);
                }
                if (monto) {
                    const montoValor = parseFloat(anticipo.monto || '0') || 0;
                    monto.value = Math.abs(montoValor) < 0.009 ? '' : String(anticipo.monto);
                }
            });
            exactoActualizarSelectsEquipo();
            anticipoRows.forEach((row, i) => {
                const eqSel = row.querySelector(`[name="anticipos[${i}][id_equipo]"]`);
                const eqVal = anticipos[i] ? Number(anticipos[i].id_equipo) || 0 : 0;
                if (eqSel && eqVal > 0) eqSel.value = String(eqVal);
            });
            exactoSincronizarTicketsAnticipos();
            exactoActualizarTotalesAnticipos();

            const abonoSaldoAplicado = document.getElementById('abonoSaldoAplicado');
            const abonoSaldoValor = parseFloat(data.abono_saldo || '0') || 0;
            if (abonoSaldoAplicado) abonoSaldoAplicado.value = abonoSaldoValor.toFixed(2);
            // Si la orden ya traía abono/liquidación previa, no volver a pedir "¿Cliente pagó?" al guardar sin cambios de pago.
            const saldoPagadoConfirmado = document.getElementById('saldoPagadoConfirmado');
            if (saldoPagadoConfirmado && abonoSaldoValor > 0.009) {
                saldoPagadoConfirmado.value = '1';
            }

            const obsItems = data.observaciones_items || [];
            const firstObs = document.querySelector('input[name="observaciones[]"]');
            if (firstObs) {
                firstObs.value = obsItems[0] || '';
            }
            document.querySelectorAll('#observacionesContainer .obs-row').forEach((el) => el.remove());
            for (let o = 1; o < obsItems.length; o++) {
                agregarObservacion();
                const inputs = document.querySelectorAll('#observacionesContainer .obs-row input.observacion-input');
                const last = inputs[inputs.length - 1];
                if (last) last.value = obsItems[o];
            }
            actualizarNumerosObservaciones();

            const tx = document.querySelector('[name="comentariosTecnico"]');
            if (tx && data.t) {
                tx.value = data.t.comentarios_m || '';
            }
            const recibidoInput = document.getElementById('inputRecibidoClienteForm')
                || document.querySelector('[name="recibido_cliente"]');
            if (recibidoInput && data.t) {
                const recibido = String(data.t.recibido_cliente || '').trim();
                if (recibido !== '') {
                    recibidoInput.value = recibido.toUpperCase();
                    const titular = String(document.getElementById('nombreCliente')?.value || '').trim().toUpperCase();
                    const esResumen = recibido.toUpperCase() === 'VARIOS RECEPTORES';
                    const esTercero = !esResumen && titular !== '' && recibido.toUpperCase() !== titular;
                    const radioTercero = document.getElementById('formQuienTercero');
                    const radioCliente = document.getElementById('formQuienCliente');
                    if (esTercero && radioTercero) radioTercero.checked = true;
                    else if (radioCliente) radioCliente.checked = true;
                }
            }

            const firmas = data.firmas || {};
            const finCalculos = () => {
                calcularSubtotalTrabajos();
                document.querySelectorAll('#materialesTableBody .material-row').forEach((fila) => calcularImporte(fila));
                calcularSubtotalMateriales();
                exactoActualizarTotalesAnticipos();
                // Orden ya liquidada en BD: no repreguntar "¿Cliente pagó?" si no cambian pagos.
                const confirmadoEl = document.getElementById('saldoPagadoConfirmado');
                const saldoEl = document.getElementById('saldoPendiente');
                const saldo = parseFloat(saldoEl ? saldoEl.textContent : '0') || 0;
                const pagos = calcularTotalAnticipos() + exactoTotalAbonoSaldo();
                if (confirmadoEl && Math.abs(saldo) <= 0.009 && pagos > 0.009) {
                    confirmadoEl.value = '1';
                }
            };
            if (window.EXACTO_ORDEN_FIRMAS_DESHABILITADAS) {
                return Promise.resolve().then(finCalculos);
            }
            return Promise.all([
                precargarFirmaEnCanvas('firmaClienteInicial', firmas.firma_c_e),
                precargarFirmaEnCanvas('firmaTecnicoInicial', firmas.firma_t_r),
                precargarFirmaEnCanvas('firmaCliente', firmas.firma_c_r),
                precargarFirmaEnCanvas('firmaTecnico', firmas.firma_t_e),
            ]).then(finCalculos);
        }

        function canvasPareceFirmado(canvasId) {
            const canvas = document.getElementById(canvasId);
            const ctx = canvasContexts[canvasId];
            if (!canvas || !ctx) return false;
            try {
                const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                for (let i = 0; i < d.length; i += 4) {
                    const r = d[i], g = d[i + 1], b = d[i + 2];
                    if (r < 245 || g < 245 || b < 245) {
                        return true;
                    }
                }
            } catch (e) {
                return true;
            }
            return false;
        }

        function exactoPrepararCanvasFirmaVisible(canvasId) {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            if (!canvasContexts[canvasId]) {
                inicializarFirma(canvasId);
            }

            const rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : null;
            // Modal/sección aún oculta: no fijar tamaño 0 (queda el lienzo negro).
            if (!rect || rect.width < 2 || rect.height < 2) {
                return;
            }
            const ancho = Math.max(1, Math.round(rect.width));
            const alto = Math.max(1, Math.round(rect.height));
            const sizeChanged = canvas.width !== ancho || canvas.height !== alto;
            const wasTiny = canvas.width <= 2 || canvas.height <= 2;
            if (sizeChanged) {
                canvas.width = ancho;
                canvas.height = alto;
            }
            // Tras redimensionar el bitmap queda transparente/negro; si no hay trazo, asegurar blanco.
            if (sizeChanged || wasTiny || !canvasPareceFirmado(canvasId)) {
                pintarFondoBlancoFirma(canvasId);
            }
        }

        function exactoEstatusEsEntregado(valor) {
            return exactoNormalizarEstatusOrden(valor) === 'Entregado';
        }

        /** Firmas de entrega siempre justo encima del botón Guardar. */
        function exactoRestaurarFirmasEntregaAlFinal() {
            const seccion = document.getElementById('ordenSeccionFirmasEntrega');
            const btnGuardar = document.getElementById('btnGuardarOrden');
            const form = document.getElementById('ordenForm');
            if (!seccion || !btnGuardar || !form) return;

            const referencia = btnGuardar.parentElement;
            if (!referencia || referencia.parentElement !== form) return;

            if (seccion.nextElementSibling !== referencia) {
                form.insertBefore(seccion, referencia);
            }

            seccion.classList.add('p-4', 'sm:pl-6', 'bg-blue-50', 'border-l-4', 'border-blue-700', 'rounded-r-lg');
            seccion.classList.remove('bg-transparent', 'p-0', 'pl-0');
        }

        function exactoSincronizarFirmasEntregaPorEstatus() {
            const estatusEl = document.getElementById('inputEstatus');
            const seccionFirmas = document.getElementById('ordenSeccionFirmasEntrega');
            const seccionIniciales = document.getElementById('ordenSeccionFirmasIniciales');
            const idOrdenEl = document.getElementById('id_orden_c');
            if (!estatusEl || !seccionFirmas) return;

            exactoRestaurarFirmasEntregaAlFinal();

            const mostrarFirmasEntrega = exactoEstatusEsEntregado(estatusEl.value);
            const esEdicion = idOrdenEl && String(idOrdenEl.value || '').trim() !== '';

            seccionFirmas.classList.toggle('hidden', !mostrarFirmasEntrega);
            seccionFirmas.classList.toggle('orden-firmas-skip', !mostrarFirmasEntrega);
            seccionFirmas.style.display = mostrarFirmasEntrega ? 'block' : 'none';

            if (seccionIniciales) {
                const ocultarIniciales = esEdicion || mostrarFirmasEntrega || !!window.EXACTO_ORDEN_MODO_COMPLETAR;
                seccionIniciales.classList.toggle('hidden', ocultarIniciales);
                seccionIniciales.classList.toggle('orden-firmas-skip', ocultarIniciales);
                seccionIniciales.style.display = ocultarIniciales ? 'none' : 'block';
            }

            if (typeof window.exactoSyncFirmasEntregaInline === 'function') {
                window.exactoSyncFirmasEntregaInline();
            }

            if (mostrarFirmasEntrega) {
                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        exactoPrepararCanvasFirmaVisible('firmaCliente');
                        exactoPrepararCanvasFirmaVisible('firmaTecnico');
                        try {
                            seccionFirmas.scrollIntoView({ behavior: 'smooth', block: 'end' });
                        } catch (e) {
                            seccionFirmas.scrollIntoView(false);
                        }
                    });
                });
            }
        }

        window.exactoSincronizarFirmasEntregaPorEstatus = exactoSincronizarFirmasEntregaPorEstatus;

        // Establecer fecha de entrada automáticamente (alta) o cargar orden (edición)
        window.addEventListener('load', function() {
            const ordenFormEl = document.getElementById('ordenForm');
            if (ordenFormEl) {
                exactoConfigurarMensajesValidacionOrden(ordenFormEl);
                exactoConfigurarAvisoSalidaOrdenForm(ordenFormEl);
                exactoConfigurarMayusculasOrdenForm(ordenFormEl);
                // Evita que ↑/↓ del teclado incrementen/decrementen type="number"
                ordenFormEl.addEventListener('keydown', function (e) {
                    const t = e.target;
                    if (!t || t.tagName !== 'INPUT' || String(t.type || '').toLowerCase() !== 'number') {
                        return;
                    }
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        e.preventDefault();
                    }
                });
                const correoField = ordenFormEl.querySelector('[name="correo"]');
                if (correoField) {
                    correoField.addEventListener('blur', function () {
                        correoField.value = String(correoField.value || '').trim().toLowerCase();
                    });
                }
            }

            if (!window.EXACTO_ORDEN_FIRMAS_DESHABILITADAS) {
                inicializarFirma('firmaClienteInicial');
                inicializarFirma('firmaTecnicoInicial');
                inicializarFirma('firmaCliente');
                inicializarFirma('firmaTecnico');
            }
            if (document.getElementById('firmaClienteSalidaTemp')) {
                inicializarFirma('firmaClienteSalidaTemp');
            }
            if (document.getElementById('firmaTecnicoSalidaTemp')) {
                inicializarFirma('firmaTecnicoSalidaTemp');
            }

            exactoBindModalSalidaTemporalUi(document.getElementById('modalSalidaTemporal'));
            document.getElementById('btnRegresoTemporal')?.addEventListener('click', () => {
                void exactoRegistrarRegresoTemporal();
            });

            const jsonEl = document.getElementById('ordenExistenteJson');
            let promesaCargaInicial = Promise.resolve();
            if (jsonEl) {
                try {
                    const data = JSON.parse(jsonEl.textContent);
                    promesaCargaInicial = Promise.resolve(aplicarOrdenExistente(data));
                } catch (e) {
                    console.error(e);
                    void exactoShowAlert('No se pudo cargar la orden.', { title: 'Error al cargar' });
                }
            } else {
                const ahora = new Date();
                const offset = ahora.getTimezoneOffset() * 60000;
                const fechaLocal = new Date(ahora - offset).toISOString().slice(0, 16);
                document.querySelector('[name="fechaEntrada"]').value = fechaLocal;
                document.querySelectorAll('#trabajosTableBody .trabajo-row').forEach((fila) => {
                    const sel = fila.querySelector('select[name*="[clave]"]');
                    if (sel && String(sel.value || '').trim() !== '') {
                        exactoAplicarServicioTrabajo(fila, true);
                    } else {
                        exactoAplicarServicioTrabajo(fila, false);
                    }
                });
            }
            exactoSincronizarFirmasEntregaPorEstatus();
            exactoAplicarColorEstatus();
            exactoRepararSelectsTipoServicio();
            exactoActualizarSelectsEquipo();
            promesaCargaInicial.finally(() => {
                exactoRestaurarFirmasEntregaAlFinal();
                exactoSincronizarFirmasEntregaPorEstatus();
                exactoRepararSelectsTipoServicio();
                exactoActualizarSelectsEquipo();
                setTimeout(exactoReiniciarEstadoSucioOrdenForm, 50);
                if (window.EXACTO_ORDEN_SOLO_LECTURA) {
                    exactoAplicarSoloLecturaEntregado();
                    return;
                }
                exactoIniciarLockEdicionOrden();
                exactoIniciarAutosaveBorradorOrden();
                // Ofrecer recuperación después de pintar la orden base.
                setTimeout(() => {
                    void exactoOfrecerRestaurarBorradorSiHay();
                }, 120);
            });
        });

        const exactoSelectorEstatus = document.getElementById('inputEstatus');
        if (exactoSelectorEstatus) {
            const onEstatusOrdenChange = function () {
                exactoSincronizarFirmasEntregaPorEstatus();
                exactoAplicarColorEstatus();
                actualizarColumnaAccionesEquipos();
            };
            exactoSelectorEstatus.addEventListener('change', onEstatusOrdenChange);
            exactoSelectorEstatus.addEventListener('input', onEstatusOrdenChange);
            exactoAplicarColorEstatus();
            actualizarColumnaAccionesEquipos();
        }

        // MANEJO DE EQUIPOS - Agregar filas
        document.addEventListener('click', function(e) {
            const t = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
            if (!t || typeof t.closest !== 'function') {
                return;
            }
            const marcarSucioSiOrdenForm = () => {
                if (t.closest('#ordenForm')) {
                    exactoMarcarOrdenFormSucio();
                }
            };
            if (t.closest('.btn-agregar-equipo')) {
                e.preventDefault();
                agregarEquipo();
                actualizarNumerosEquipos();
                exactoActualizarSelectsEquipo();
                marcarSucioSiOrdenForm();
            }
            if (t.closest('.btn-eliminar-equipo')) {
                e.preventDefault();
                eliminarEquipo(t.closest('.equipo-row'));
                exactoActualizarSelectsEquipo();
                marcarSucioSiOrdenForm();
            }
            if (t.closest('.btn-entrega-equipo-row')) {
                e.preventDefault();
                const btn = t.closest('.btn-entrega-equipo-row');
                // Pasar el botón real para que la función lea la fila (marca/modelo) y resalte la fila
                window.exactoBtnEntregaEquipo.call(btn);
                marcarSucioSiOrdenForm();
            }
            if (t.closest('.btn-agregar-obs')) {
                e.preventDefault();
                agregarObservacion();
                marcarSucioSiOrdenForm();
            }
            if (t.closest('.btn-eliminar-obs')) {
                e.preventDefault();
                eliminarObservacion(t.closest('.obs-row'));
                marcarSucioSiOrdenForm();
            }
            if (t.closest('.btn-agregar-trabajo')) {
                e.preventDefault();
                agregarTrabajo();
                marcarSucioSiOrdenForm();
            }
            if (t.closest('.btn-eliminar-trabajo')) {
                e.preventDefault();
                eliminarTrabajo(t.closest('.trabajo-row'));
                marcarSucioSiOrdenForm();
            }
            if (t.closest('.btn-agregar-material')) {
                e.preventDefault();
                agregarMaterial();
                marcarSucioSiOrdenForm();
            }
            if (t.closest('.btn-eliminar-material')) {
                e.preventDefault();
                eliminarMaterial(t.closest('.material-row'));
                marcarSucioSiOrdenForm();
            }
            if (t.closest('.btn-agregar-anticipo')) {
                e.preventDefault();
                agregarAnticipo();
                marcarSucioSiOrdenForm();
            }
            if (t.closest('.btn-eliminar-anticipo')) {
                e.preventDefault();
                eliminarAnticipo(t.closest('.anticipo-row'));
                marcarSucioSiOrdenForm();
            }
            if (t.closest('#btnPagarSaldoPendiente') || t.closest('#btnLiquidarSaldo') || t.closest('#btnLiquidarAhora')) {
                e.preventDefault();
                if (t.closest('#btnLiquidarAhora')) {
                    const modalEntrega = document.getElementById('modalEntregaEquipo');
                    if (modalEntrega) {
                        modalEntrega.classList.add('hidden');
                        modalEntrega.classList.remove('flex');
                        modalEntrega.style.display = 'none';
                    }
                }
                exactoAbrirModalLiquidarSaldo();
                return;
            }
            if (t.closest('#btnCancelarLiquidarSaldo')) {
                e.preventDefault();
                exactoCerrarModalLiquidarSaldo();
                return;
            }
            if (t.closest('#btnConfirmarLiquidarSaldo')) {
                e.preventDefault();
                void exactoConfirmarLiquidarSaldo();
                return;
            }
        });

        function exactoInfoEstatusEquipo(acciones) {
            const a = Math.max(0, Number(acciones) || 0);
            if (a >= 2) {
                return { text: 'Entregado', cls: 'bg-emerald-600 text-white', style: 'background-color:#059669;color:#ffffff;', acciones: 2 };
            }
            if (a >= 1) {
                return { text: 'Terminado', cls: 'bg-amber-500 text-black', style: 'background-color:#f59e0b;color:#111827;', acciones: 1 };
            }
            return { text: 'Pendiente', cls: 'bg-slate-400 text-white', style: 'background-color:#64748b;color:#ffffff;', acciones: 0 };
        }

        function exactoHtmlCeldaEstatusEquipo(index, acciones) {
            const info = exactoInfoEstatusEquipo(acciones);
            return `<td class="p-3 text-center border equipo-estatus-cell">
                <input type="hidden" name="equipos[${index}][acciones]" class="equipo-acciones-input" value="${info.acciones}">
                <span class="equipo-estatus-badge inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ${info.cls}" style="${info.style}">${info.text}</span>
            </td>`;
        }

        function exactoPintarEstatusEquipoFila(fila, acciones) {
            if (!fila) return;
            const info = exactoInfoEstatusEquipo(acciones);
            fila.dataset.acciones = String(info.acciones);
            const hidden = fila.querySelector('.equipo-acciones-input');
            if (hidden) hidden.value = String(info.acciones);
            const badge = fila.querySelector('.equipo-estatus-badge');
            if (badge) {
                badge.textContent = info.text;
                badge.className = `equipo-estatus-badge inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ${info.cls}`;
                badge.setAttribute('style', info.style);
            }
            const btn = fila.querySelector('.btn-entrega-equipo-row');
            if (btn) {
                btn.classList.toggle('text-green-600', info.acciones < 1);
                btn.classList.toggle('hover:text-green-800', info.acciones < 1);
                btn.classList.toggle('text-amber-500', info.acciones === 1);
                btn.classList.toggle('text-emerald-700', info.acciones >= 2);
                btn.title = info.acciones >= 2
                    ? 'Equipo ya entregado'
                    : (info.acciones === 1 ? 'Equipo terminado — listo para entregar' : 'Terminar y entregar este equipo');
            }
        }

        window.exactoPintarEstatusEquipoFila = exactoPintarEstatusEquipoFila;
        window.exactoInfoEstatusEquipo = exactoInfoEstatusEquipo;

        function agregarEquipo() {
            const tbody = document.getElementById('equiposTableBody');
            const contador = tbody.querySelectorAll('.equipo-row').length + 1;

            // Verificar si el estatus es "En proceso" o "Terminado" para mostrar la columna ACCIONES
            const estatusEl = document.getElementById('inputEstatus');
            const estatus = estatusEl ? estatusEl.value.trim() : '';
            const mostrarAcciones = estatus === 'En proceso' || estatus === 'Terminado';

            const fila = document.createElement('tr');
            fila.className = 'equipo-row hover:bg-blue-100';
            fila.dataset.acciones = '0';

            // Siempre agregar celda AÑADIR vacía para filas nuevas (la primera fila tiene el botón)
            // ESTATUS + ACCIONES cuando estatus es En proceso/Terminado
            let extraCeldasHtml = '';
            if (mostrarAcciones) {
                extraCeldasHtml += exactoHtmlCeldaEstatusEquipo(contador - 1, 0);
            }
            extraCeldasHtml += `
                <td class="p-3 border"></td>
            `;
            if (mostrarAcciones) {
                extraCeldasHtml += `
                <td class="p-3 text-center border">
                    <button type="button" class="font-bold text-green-600 hover:text-green-800 btn-entrega-equipo-row mr-2" title="Terminar y entregar este equipo" data-id-equipo="${contador}">
                        <i class="fas fa-truck"></i>
                    </button>
                    <button type="button" class="font-bold text-red-600 hover:text-red-800 btn-eliminar-equipo" title="Eliminar fila">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>`;
            }

            fila.innerHTML = `
                <td class="p-3 border"><span class="equipo-numero">${contador}</span></td>
                <td class="p-3 border"><input type="text" class="px-2 py-1 w-full rounded border border-blue-300" name="equipos[${contador - 1}][marca]" placeholder="Marca"></td>
                <td class="p-3 border"><input type="text" class="px-2 py-1 w-full rounded border border-blue-300" name="equipos[${contador - 1}][modelo]" placeholder="Modelo o descripción"></td>
                <td class="p-3 border"><input type="text" class="px-2 py-1 w-full rounded border border-blue-300" name="equipos[${contador - 1}][serie]" placeholder="Serie"></td>
                <td class="p-3 border"><input type="text" class="px-2 py-1 w-full rounded border border-blue-300" name="equipos[${contador - 1}][descripcionFalla]" placeholder="Descripción de falla"></td>
                <td class="p-3 border"><select class="px-2 py-1 w-full rounded border border-blue-300" name="equipos[${contador - 1}][tipoServicio]"><option value="">Seleccionar...</option>${exactoBuildTipoServicioOptionsHtml()}</select></td>
                ${extraCeldasHtml}
            `;
            tbody.appendChild(fila);
        }

        function eliminarEquipo(fila) {
            const tbody = document.getElementById('equiposTableBody');
            if (tbody.querySelectorAll('.equipo-row').length > 1) {
                fila.remove();
                actualizarNumerosEquipos();
            } else {
                void exactoShowAlert('Debe haber al menos una fila de equipo.', { title: 'Acción no permitida' });
            }
        }

        function actualizarNumerosEquipos() {
            const filas = document.querySelectorAll('.equipo-row');
            filas.forEach((fila, index) => {
                fila.querySelector('.equipo-numero').textContent = index + 1;
                fila.querySelectorAll('input, select').forEach(input => {
                    const name = input.getAttribute('name');
                    if (name) {
                        input.setAttribute('name', name.replace(/equipos\[\d+\]/, `equipos[${index}]`));
                    }
                });
                // Actualizar data-id-equipo en botón de entrega (número 1..N)
                // Conservar id real de BD si ya venía en la fila.
                const btnEntrega = fila.querySelector('.btn-entrega-equipo-row');
                if (btnEntrega) {
                    btnEntrega.dataset.idEquipo = String(index + 1);
                    const dbId = fila.dataset.idEquipoDb || btnEntrega.dataset.idEquipoDb || '';
                    if (dbId) {
                        fila.dataset.idEquipoDb = String(dbId);
                        btnEntrega.dataset.idEquipoDb = String(dbId);
                    }
                }
            });
        }

        function actualizarColumnaAccionesEquipos() {
            const estatusEl = document.getElementById('inputEstatus');
            const estatus = estatusEl ? estatusEl.value.trim() : '';
            const mostrarAcciones = estatus === 'En proceso' || estatus === 'Terminado';

            const table = document.querySelector('#equiposTableBody')?.closest('table');
            const thead = table ? table.querySelector('thead') : null;
            const headerRow = thead ? thead.querySelector('tr') : null;
            const filas = document.querySelectorAll('#equiposTableBody .equipo-row');

            if (headerRow) {
                let thEstatus = Array.from(headerRow.querySelectorAll('th')).find((th) => th.textContent.trim() === 'ESTATUS');
                let thAcciones = Array.from(headerRow.querySelectorAll('th')).find((th) => th.textContent.trim() === 'ACCIONES');
                const thAnadir = Array.from(headerRow.querySelectorAll('th')).find((th) => {
                    const t = th.textContent.trim().toUpperCase();
                    return t === 'ANADIR' || t === 'AÑADIR' || t === 'AÃ‘ADIR';
                });

                if (mostrarAcciones && !thEstatus) {
                    thEstatus = document.createElement('th');
                    thEstatus.className = 'p-3 text-center border';
                    thEstatus.textContent = 'ESTATUS';
                    if (thAnadir) {
                        headerRow.insertBefore(thEstatus, thAnadir);
                    } else {
                        headerRow.appendChild(thEstatus);
                    }
                } else if (!mostrarAcciones && thEstatus) {
                    thEstatus.remove();
                }

                if (mostrarAcciones && !thAcciones) {
                    thAcciones = document.createElement('th');
                    thAcciones.className = 'p-3 text-center border';
                    thAcciones.textContent = 'ACCIONES';
                    headerRow.appendChild(thAcciones);
                } else if (!mostrarAcciones && thAcciones) {
                    thAcciones.remove();
                }
            }

            filas.forEach((fila, index) => {
                const tieneEstatus = Boolean(fila.querySelector('.equipo-estatus-cell'));
                const tieneAcciones = Boolean(fila.querySelector('.btn-eliminar-equipo'));
                const tdAnadir = Array.from(fila.querySelectorAll('td')).find((td) => td.querySelector('.btn-agregar-equipo'))
                    || Array.from(fila.querySelectorAll('td'))[mostrarAcciones && tieneEstatus ? 7 : 6];

                if (mostrarAcciones && !tieneEstatus) {
                    const wrap = document.createElement('tbody');
                    wrap.innerHTML = exactoHtmlCeldaEstatusEquipo(index, Number(fila.dataset.acciones) || 0);
                    const tdEst = wrap.firstElementChild;
                    if (tdEst && tdAnadir) {
                        fila.insertBefore(tdEst, tdAnadir);
                    } else if (tdEst) {
                        fila.appendChild(tdEst);
                    }
                } else if (!mostrarAcciones && tieneEstatus) {
                    fila.querySelector('.equipo-estatus-cell')?.remove();
                } else if (mostrarAcciones && tieneEstatus) {
                    exactoPintarEstatusEquipoFila(fila, Number(fila.dataset.acciones) || 0);
                }

                if (mostrarAcciones && !tieneAcciones) {
                    const dbId = fila.dataset.idEquipoDb || '';
                    const tdAcciones = document.createElement('td');
                    tdAcciones.className = 'p-3 text-center border';
                    tdAcciones.innerHTML = `
                        <button type="button" class="font-bold text-green-600 hover:text-green-800 btn-entrega-equipo-row mr-2" title="Terminar y entregar este equipo" data-id-equipo="${index + 1}"${dbId ? ` data-id-equipo-db="${dbId}"` : ''}>
                            <i class="fas fa-truck"></i>
                        </button>
                        <button type="button" class="font-bold text-red-600 hover:text-red-800 btn-eliminar-equipo" title="Eliminar fila">
                            <i class="fas fa-trash"></i>
                        </button>`;
                    fila.appendChild(tdAcciones);
                    exactoPintarEstatusEquipoFila(fila, Number(fila.dataset.acciones) || 0);
                } else if (!mostrarAcciones && tieneAcciones) {
                    fila.querySelector('.btn-eliminar-equipo')?.closest('td')?.remove();
                }
            });
        }

        // MANEJO DE OBSERVACIONES
        let obsContador = 1;

        function agregarObservacion() {
            obsContador++;
            const container = document.getElementById('observacionesContainer');
            
            const div = document.createElement('div');
            div.className = 'flex items-start obs-row';
            div.innerHTML = `
                <span
                  class="mr-3 font-bold text-blue-700"
                >${obsContador}.</span>
                <input type="text"
                  class="flex-1 px-3 py-2 rounded-lg border border-blue-300  observacion-input"
                  name="observaciones[]"
                 placeholder="Observación ${obsContador}">
                <button type="button"
                  class="ml-2 font-bold text-blue-600  hover:text-blue-800 btn-eliminar-obs"
                 title="Eliminar observación">
                    <i
                      class="fas fa-trash"
                    ></i>
                </button>
            `;
            container.appendChild(div);
        }

        function eliminarObservacion(fila) {
            fila.remove();
            actualizarNumerosObservaciones();
        }

        function actualizarNumerosObservaciones() {
            const filas = document.querySelectorAll('.obs-row');
            obsContador = filas.length + 1;
            let num = 2;
            filas.forEach(fila => {
                fila.querySelector('span').textContent = num + '.';
                num++;
            });
        }

        // SISTEMA DE FIRMAS CON CANVAS
        let canvasContexts = {};
        let isDrawing = {};
        let firmaScrollLock = 0;
        let firmaPointerActivo = {};

        function exactoFirmaBloquearScroll() {
            firmaScrollLock += 1;
            if (firmaScrollLock === 1) {
                document.documentElement.style.overflow = 'hidden';
                document.body.style.overflow = 'hidden';
            }
        }

        function exactoFirmaDesbloquearScroll() {
            firmaScrollLock = Math.max(0, firmaScrollLock - 1);
            if (firmaScrollLock === 0) {
                document.documentElement.style.overflow = '';
                document.body.style.overflow = '';
            }
        }

        function exactoFirmaPuntoCanvas(e, canvas) {
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / Math.max(rect.width, 1);
            const scaleY = canvas.height / Math.max(rect.height, 1);
            let clientX;
            let clientY;
            if (e.touches && e.touches.length > 0) {
                clientX = e.touches[0].clientX;
                clientY = e.touches[0].clientY;
            } else {
                clientX = e.clientX;
                clientY = e.clientY;
            }

            return {
                x: (clientX - rect.left) * scaleX,
                y: (clientY - rect.top) * scaleY,
            };
        }

        function pintarFondoBlancoFirma(canvasId) {
            const ctx = canvasContexts[canvasId];
            const canvas = document.getElementById(canvasId);
            if (!ctx || !canvas) return;
            ctx.save();
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.restore();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = '#000000';
        }

        function inicializarFirma(canvasId) {
            const canvas = document.getElementById(canvasId);
            if (!canvas || canvas.dataset.exactoFirmaInicializada === '1') {
                return;
            }
            const pad = canvas.parentElement;
            if (pad) {
                pad.classList.add('exacto-firma-pad');
            }
            canvas.classList.add('exacto-firma-canvas');

            const rect = pad ? pad.getBoundingClientRect() : canvas.getBoundingClientRect();
            canvas.width = Math.max(1, Math.round(rect.width));
            canvas.height = Math.max(1, Math.round(rect.height));

            const ctx = canvas.getContext('2d');
            canvasContexts[canvasId] = ctx;
            pintarFondoBlancoFirma(canvasId);

            isDrawing[canvasId] = false;
            firmaPointerActivo[canvasId] = false;

            const finalizarTrazo = () => {
                exactoFirmaDesbloquearScroll();
                stopDrawing(canvasId);
                firmaPointerActivo[canvasId] = false;
            };

            canvas.addEventListener('mousedown', (e) => {
                if (e.button !== 0) {
                    return;
                }
                e.preventDefault();
                startDrawing(e, canvasId);
            });
            canvas.addEventListener('mousemove', (e) => {
                if (!isDrawing[canvasId]) {
                    return;
                }
                e.preventDefault();
                draw(e, canvasId);
            });
            canvas.addEventListener('mouseup', finalizarTrazo);
            canvas.addEventListener('mouseleave', finalizarTrazo);

            canvas.addEventListener('pointerdown', (e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) {
                    return;
                }
                e.preventDefault();
                firmaPointerActivo[canvasId] = true;
                try {
                    canvas.setPointerCapture(e.pointerId);
                } catch (err) {
                    /* ignore */
                }
                exactoFirmaBloquearScroll();
                startDrawing(e, canvasId);
            });
            canvas.addEventListener('pointermove', (e) => {
                if (!isDrawing[canvasId]) {
                    return;
                }
                e.preventDefault();
                draw(e, canvasId);
            });
            canvas.addEventListener('pointerup', (e) => {
                if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
                    canvas.releasePointerCapture(e.pointerId);
                }
                finalizarTrazo();
            });
            canvas.addEventListener('pointercancel', finalizarTrazo);

            canvas.addEventListener('touchstart', (e) => {
                if (firmaPointerActivo[canvasId]) {
                    return;
                }
                if (e.cancelable) {
                    e.preventDefault();
                }
                exactoFirmaBloquearScroll();
                startDrawing(e, canvasId);
            }, { passive: false });
            canvas.addEventListener('touchmove', (e) => {
                if (!isDrawing[canvasId]) {
                    return;
                }
                if (e.cancelable) {
                    e.preventDefault();
                }
                draw(e, canvasId);
            }, { passive: false });
            canvas.addEventListener('touchend', (e) => {
                if (firmaPointerActivo[canvasId]) {
                    return;
                }
                if (e.cancelable) {
                    e.preventDefault();
                }
                finalizarTrazo();
            }, { passive: false });
            canvas.addEventListener('touchcancel', finalizarTrazo, { passive: false });

            canvas.dataset.exactoFirmaInicializada = '1';
        }

        function limpiarFirma(canvasId) {
            const canvas = document.getElementById(canvasId);
            const ctx = canvasContexts[canvasId];
            if (!canvas || !ctx) {
                return;
            }
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            pintarFondoBlancoFirma(canvasId);
        }

        window.inicializarFirma = inicializarFirma;
        window.pintarFondoBlancoFirma = pintarFondoBlancoFirma;
        window.exactoPrepararCanvasFirmaVisible = exactoPrepararCanvasFirmaVisible;
        window.limpiarFirma = limpiarFirma;
        window.exactoFirmaDataUrlSiHay = exactoFirmaDataUrlSiHay;

        function startDrawing(e, canvasId) {
            const canvas = document.getElementById(canvasId);
            const ctx = canvasContexts[canvasId];
            if (!canvas || !ctx) {
                return;
            }
            isDrawing[canvasId] = true;
            const { x, y } = exactoFirmaPuntoCanvas(e, canvas);

            ctx.beginPath();
            ctx.moveTo(x, y);
        }

        function draw(e, canvasId) {
            if (!isDrawing[canvasId]) {
                return;
            }

            const canvas = document.getElementById(canvasId);
            const ctx = canvasContexts[canvasId];
            if (!canvas || !ctx) {
                return;
            }
            const { x, y } = exactoFirmaPuntoCanvas(e, canvas);

            ctx.lineTo(x, y);
            ctx.stroke();
            exactoMarcarOrdenFormSucio();
        }

        function stopDrawing(canvasId) {
            isDrawing[canvasId] = false;
        }

        function limpiarFirmaCliente() {
            if (!canvasContexts['firmaCliente']) return;
            const canvas = document.getElementById('firmaCliente');
            canvasContexts['firmaCliente'].clearRect(0, 0, canvas.width, canvas.height);
            pintarFondoBlancoFirma('firmaCliente');
            exactoMarcarOrdenFormSucio();
        }

        function limpiarFirmaTecnico() {
            if (!canvasContexts['firmaTecnico']) return;
            const canvas = document.getElementById('firmaTecnico');
            canvasContexts['firmaTecnico'].clearRect(0, 0, canvas.width, canvas.height);
            pintarFondoBlancoFirma('firmaTecnico');
            exactoMarcarOrdenFormSucio();
        }

        function limpiarFirmaClienteInicial() {
            if (!canvasContexts['firmaClienteInicial']) return;
            const canvas = document.getElementById('firmaClienteInicial');
            canvasContexts['firmaClienteInicial'].clearRect(0, 0, canvas.width, canvas.height);
            pintarFondoBlancoFirma('firmaClienteInicial');
        }

        function limpiarFirmaTecnicoInicial() {
            if (!canvasContexts['firmaTecnicoInicial']) return;
            const canvas = document.getElementById('firmaTecnicoInicial');
            canvasContexts['firmaTecnicoInicial'].clearRect(0, 0, canvas.width, canvas.height);
            pintarFondoBlancoFirma('firmaTecnicoInicial');
        }

        // IMPRIMIR
        function imprimirOrden() {
            window.print();
        }

        function exactoEsOrdenNueva() {
            return Number(document.getElementById('id_orden_c')?.value || 0) <= 0;
        }

        function exactoGetServicioSersop01() {
            const fromWin = exactoGetServiciosSersop().find(
                (servicio) => String(servicio.clave || '').trim().toUpperCase() === 'SERSOP01'
            );
            if (fromWin) {
                return {
                    clave: 'SERSOP01',
                    descripcion: String(fromWin.descripcion || 'SOPORTE REVISION/VALORACION TECNICA'),
                    precio: Number.parseFloat(fromWin.precio || 603.45) || 603.45,
                };
            }
            return {
                clave: 'SERSOP01',
                descripcion: 'SOPORTE REVISION/VALORACION TECNICA',
                precio: 603.45,
            };
        }

        function exactoFormularioYaTieneSersop01Visible() {
            const filas = document.querySelectorAll('#trabajosTableBody .trabajo-row:not([data-sersop01-auto="1"])');
            for (const fila of filas) {
                const clave = fila.querySelector('select[name*="[clave]"]');
                if (clave && String(clave.value || '').trim().toUpperCase() === 'SERSOP01') {
                    return true;
                }
            }
            return false;
        }

        function exactoQuitarSersop01Oculto() {
            if (exactoSersop01AbonoAplicado > 0) {
                exactoSetAbonoSaldo(exactoTotalAbonoSaldo() - exactoSersop01AbonoAplicado);
                exactoSersop01AbonoAplicado = 0;
                const confirmado = document.getElementById('saldoPagadoConfirmado');
                if (confirmado) confirmado.value = '0';
            }
            const box = document.getElementById('exactoSersop01Campos');
            if (box) {
                box.innerHTML = '';
            }
            const tbody = document.getElementById('trabajosTableBody');
            if (!tbody) return;
            tbody.querySelectorAll('.trabajo-row[data-sersop01-auto="1"]').forEach((fila) => {
                fila.remove();
            });
            tbody.querySelectorAll('.trabajo-row').forEach((fila, index) => {
                const num = fila.querySelector('.trabajo-numero');
                if (num) num.textContent = String(index + 1);
                fila.querySelectorAll('input, select').forEach((input) => {
                    const name = input.getAttribute('name');
                    if (name) {
                        input.setAttribute('name', name.replace(/trabajos\[\d+\]/, `trabajos[${index}]`));
                    }
                });
            });
            if (typeof calcularSubtotalTrabajos === 'function') {
                try { calcularSubtotalTrabajos(); } catch (_) { /* ignore */ }
            }
        }

        function exactoSiguienteIndiceTrabajos() {
            let max = -1;
            document.querySelectorAll('#ordenForm [name^="trabajos["]').forEach((el) => {
                const m = String(el.getAttribute('name') || '').match(/^trabajos\[(\d+)\]/);
                if (m) {
                    max = Math.max(max, Number.parseInt(m[1], 10) || 0);
                }
            });
            return max + 1;
        }

        function exactoAsegurarCamposAbonoNuevaOrden() {
            const form = document.getElementById('ordenForm');
            if (!form) return;
            if (!document.getElementById('abonoSaldoAplicado')) {
                const abono = document.createElement('input');
                abono.type = 'hidden';
                abono.name = 'abono_saldo';
                abono.id = 'abonoSaldoAplicado';
                abono.value = '0';
                form.appendChild(abono);
            }
            if (!document.getElementById('abonoSaldoEquiposJson')) {
                const abonoEq = document.createElement('input');
                abonoEq.type = 'hidden';
                abonoEq.name = 'abono_saldo_equipos';
                abonoEq.id = 'abonoSaldoEquiposJson';
                abonoEq.value = '{}';
                form.appendChild(abonoEq);
            }
            if (!document.getElementById('saldoPagadoConfirmado')) {
                const conf = document.createElement('input');
                conf.type = 'hidden';
                conf.name = 'saldo_pagado_confirmado';
                conf.id = 'saldoPagadoConfirmado';
                conf.value = '0';
                form.appendChild(conf);
            }
        }

        function exactoAgregarSersop01Oculto(ticket) {
            exactoQuitarSersop01Oculto();
            exactoAsegurarCamposAbonoNuevaOrden();
            const servicio = exactoGetServicioSersop01();
            const ticketNorm = String(ticket || '').trim().toUpperCase();
            const precio = Number(servicio.precio || 603.45).toFixed(2);
            const descripcion = String(servicio.descripcion || 'SOPORTE REVISION/VALORACION TECNICA');
            const tbody = document.getElementById('trabajosTableBody');

            // Camino preferido: fila oculta en la tabla (cuando existe, ej. edición).
            if (tbody) {
                const indice = tbody.querySelectorAll('.trabajo-row').length;
                const fila = document.createElement('tr');
                fila.className = 'trabajo-row';
                fila.dataset.sersop01Auto = '1';
                fila.style.display = 'none';
                fila.setAttribute('aria-hidden', 'true');
                const ticketSafe = exactoEscapeHtml(ticketNorm);
                const descSafe = exactoEscapeHtml(descripcion);
                fila.innerHTML = `
                    <td class="p-3 border"><span class="trabajo-numero">${indice + 1}</span></td>
                    <td class="p-3 border">
                        <select class="px-2 py-1 w-full rounded border border-blue-300" name="trabajos[${indice}][clave]">
                            <option value="">Clave...</option>
                            ${exactoOpcionesServiciosSersop()}
                        </select>
                    </td>
                    <td class="p-3 border">
                        <input type="text" class="px-2 py-1 w-full rounded border border-blue-300" name="trabajos[${indice}][descripcion]" value="${descSafe}" readonly>
                    </td>
                    <td class="p-3 border">
                        <div class="exacto-money-field"><span class="exacto-money-prefix">$</span>
                        <input type="number" step="0.01" class="px-2 py-1 w-full rounded border border-blue-300 importe-input" name="trabajos[${indice}][importe]" value="${precio}" readonly>
                        </div>
                    </td>
                    <td class="p-3 border">
                        <input type="text" class="px-2 py-1 w-full rounded border border-blue-300 ticket-factura-input" name="trabajos[${indice}][ticket]" value="${ticketSafe}">
                    </td>
                    <td class="p-3 text-center border"></td>
                `;
                tbody.appendChild(fila);
                const select = fila.querySelector('select[name*="[clave]"]');
                if (select) {
                    select.value = 'SERSOP01';
                    if (select.value !== 'SERSOP01') {
                        exactoAsegurarOpcionClaveGuardada(select, 'SERSOP01');
                        select.value = 'SERSOP01';
                    }
                }
                calcularSubtotalTrabajos();
                return fila;
            }

            // Orden nueva (Recepción): no hay tabla de trabajos en el DOM → campos ocultos.
            const box = document.getElementById('exactoSersop01Campos');
            if (!box) {
                console.error('exactoSersop01Campos no existe; no se pudo registrar SERSOP01');
                return null;
            }
            const indice = exactoSiguienteIndiceTrabajos();
            const mk = (name, value) => {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = `trabajos[${indice}][${name}]`;
                input.value = value;
                input.dataset.sersop01Auto = '1';
                return input;
            };
            box.appendChild(mk('clave', 'SERSOP01'));
            box.appendChild(mk('descripcion', descripcion));
            box.appendChild(mk('importe', precio));
            box.appendChild(mk('ticket', ticketNorm));
            calcularTotalFactura();
            return box;
        }

        /**
         * Orden nueva: cobro oculto SERSOP01 (revisión).
         * - Si el cliente no pagó: no se registra SERSOP01.
         * - Si pagó: pide ticket/factura y registra SERSOP01 oculto.
         */
        async function exactoConfirmarCobroSersop01RevisionNueva() {
            if (!exactoEsOrdenNueva()) {
                return true;
            }
            // Conservar la elección de pago al reintentar; no volver a sumar el mismo abono.
            if (exactoSersop01AbonoAplicado > 0
                && document.querySelector('#ordenForm [data-sersop01-auto="1"]')) {
                return true;
            }
            exactoQuitarSersop01Oculto();
            // Si el técnico ya eligió SERSOP01 a mano, no duplicar el cobro oculto.
            if (exactoFormularioYaTieneSersop01Visible()) {
                return true;
            }

            const servicio = exactoGetServicioSersop01();
            const precioSinIva = Number(servicio.precio || 603.45);
            const precioConIva = exactoMontoConIva(precioSinIva);
            const clientePago = await exactoShowConfirm(
                `COBRO POR DEFECTO EN ESTA ORDEN NUEVA\n\n`
                + `SERSOP01 — ${servicio.descripcion}\n`
                + `$${precioSinIva.toFixed(2)} sin IVA ($${precioConIva.toFixed(2)} con IVA).\n\n`
                + `¿El cliente ya pagó este cobro de revisión?\n\n`
                + `• Sí: se pedirá ticket/factura y se registrará SERSOP01 en la orden.\n`
                + `• No: no se registrará nada de SERSOP01.`,
                {
                    title: 'Cobro revisión SERSOP01',
                    confirmText: 'Sí, pagó',
                    cancelText: 'No, no registrar',
                    icon: 'warning',
                }
            );

            if (!clientePago) {
                // No se registra nada de SERSOP01.
                return true;
            }

            const ticket = await exactoShowPrompt(
                'Captura el ticket / factura del pago de SERSOP01 para registrarlo en la orden.',
                {
                    title: 'Ticket / Factura SERSOP01',
                    inputLabel: 'Ticket / factura',
                    inputPlaceholder: 'Ticket, factura o folio',
                    confirmText: 'Registrar cobro',
                    cancelText: 'Cancelar guardado',
                    inputRequired: true,
                }
            );

            if (ticket === null) {
                await exactoShowAlert('Guardado cancelado. Sin ticket/factura no se registra el cobro SERSOP01.', {
                    title: 'Operación cancelada',
                });
                return false;
            }

            const ticketNorm = String(ticket || '').trim().toUpperCase();
            if (ticketNorm === '') {
                await exactoShowAlert('Debes capturar ticket o factura para registrar SERSOP01.', {
                    title: 'Falta ticket / factura',
                });
                return false;
            }

            const agregado = exactoAgregarSersop01Oculto(ticketNorm);
            if (!agregado) {
                await exactoShowAlert(
                    'No se pudo preparar el cobro SERSOP01 en el formulario. Recarga la página (Ctrl+F5) e intenta de nuevo.',
                    { title: 'Error al registrar SERSOP01', icon: 'error' }
                );
                return false;
            }

            // Cliente pagó la revisión: abonar el monto sin IVA para que el saldo refleje el pago.
            exactoAsegurarCamposAbonoNuevaOrden();
            exactoSetAbonoSaldo(exactoTotalAbonoSaldo() + precioSinIva);
            exactoSersop01AbonoAplicado = precioSinIva;
            if (typeof calcularSaldoPendiente === 'function') {
                try { calcularSaldoPendiente(); } catch (_) { /* ignore */ }
            }
            const saldoTrasCobro = typeof exactoSaldoPendienteActual === 'function'
                ? exactoSaldoPendienteActual()
                : 0;
            const confirmadoEl = document.getElementById('saldoPagadoConfirmado');
            if (confirmadoEl && Math.abs(saldoTrasCobro) <= 0.009) {
                confirmadoEl.value = '1';
            }
            return true;
        }

        function exactoUrlPdfOrden(idOrden) {
            const base = exactoBaseUrlApp();
            const id = encodeURIComponent(String(idOrden || ''));
            const bust = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const path = `/pdf/orden/${id}?inline=1&refresh_pdf=1&nocache=1&_=${bust}`;
            return base ? `${base}${path}` : path;
        }

        async function exactoAbrirReportePdfOrden(idOrden) {
            const id = Number(idOrden || 0);
            if (id <= 0) return;
            const url = exactoUrlPdfOrden(id);
            try {
                const res = await fetch(url, {
                    method: 'GET',
                    credentials: 'same-origin',
                    cache: 'no-store',
                    headers: {
                        Accept: 'application/pdf',
                        'Cache-Control': 'no-cache',
                        Pragma: 'no-cache',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                });
                if (!res.ok) {
                    throw new Error('HTTP ' + res.status);
                }
                const raw = await res.blob();
                const pdfBlob = raw.type && raw.type.includes('pdf')
                    ? raw
                    : new Blob([raw], { type: 'application/pdf' });
                const objUrl = URL.createObjectURL(pdfBlob);
                const ventana = window.open(objUrl, '_blank');
                if (ventana) {
                    try { ventana.opener = null; } catch (_) { /* ignore */ }
                } else {
                    window.open(url, '_blank');
                }
                setTimeout(() => {
                    try { URL.revokeObjectURL(objUrl); } catch (_) { /* ignore */ }
                }, 180000);
            } catch (_) {
                try {
                    const ventana = window.open(url, '_blank');
                    if (ventana) {
                        try { ventana.opener = null; } catch (e2) { /* ignore */ }
                    }
                } catch (e3) {
                    // ignore
                }
            }
        }

        // MANEJO DE TRABAJOS
        let trabajoContador = 1;
        function agregarTrabajo() {
            const tbody = document.getElementById('trabajosTableBody');
            if (!tbody) return;
            const contador = tbody.querySelectorAll('.trabajo-row').length + 1;
            
            const fila = document.createElement('tr');
            fila.className = 'trabajo-row hover:bg-blue-100';
            fila.innerHTML = `
                <td
                  class="p-3 border"
                ><span class="trabajo-numero">${contador}</span></td>
                <td
                  class="p-3 border"
                ><select
                  class="px-2 py-1 w-full rounded border border-blue-300"
                 name="trabajos[${contador - 1}][clave]">
                  <option value="">Clave...</option>
                  ${exactoOpcionesServiciosSersop()}
                </select></td>
                <td
                  class="p-3 border"
                ><input type="text"
                  class="px-2 py-1 w-full rounded border border-blue-300 bg-gray-100 text-gray-600 cursor-not-allowed"
                 name="trabajos[${contador - 1}][descripcion]" placeholder="Trabajo ${contador}" readonly title="Este campo se toma del catálogo SERSOP."></td>
                <td
                  class="p-3 border"
                ><div class="exacto-money-field"><span class="exacto-money-prefix">$</span><input type="number" step="0.01"
                  class="px-2 py-1 w-full rounded border border-blue-300 importe-input bg-gray-100 text-gray-600 cursor-not-allowed"
                 name="trabajos[${contador - 1}][importe]" placeholder="PRECIO SIN IVA" readonly title="Este campo se toma del catálogo SERSOP."></div></td>
                <td
                  class="p-3 border"
                >${exactoHtmlTicketFacturaInput(`trabajos[${contador - 1}][ticket]`, '', false)}</td>
                <td
                  class="p-3 border"
                >${exactoHtmlSelectEquipo(`trabajos[${contador - 1}][id_equipo]`)}</td>
                <td
                  class="p-3 text-center border"
                >
                    <button type="button"
                      class="font-bold text-blue-600  hover:text-blue-800 btn-eliminar-trabajo"
                     title="Eliminar fila">
                        <i
                          class="fas fa-trash"
                        ></i>
                    </button>
                </td>
            `;
            tbody.appendChild(fila);
            exactoAplicarServicioTrabajo(fila, false);
        }
        function eliminarTrabajo(fila) {
            const tbody = document.getElementById('trabajosTableBody');
            if (!tbody) return;
            if (tbody.querySelectorAll('.trabajo-row').length > 1) {
                fila.remove();
                actualizarNumerosTrabajos();
                calcularSubtotalTrabajos();
            } else {
                void exactoShowAlert('Debe haber al menos una fila de trabajo.', { title: 'Acción no permitida' });
            }
        }
        function actualizarNumerosTrabajos() {
            const filas = document.querySelectorAll('.trabajo-row');
            filas.forEach((fila, index) => {
                fila.querySelector('.trabajo-numero').textContent = index + 1;
                fila.querySelectorAll('input, select').forEach(input => {
                    const name = input.getAttribute('name');
                    if (name) {
                        input.setAttribute('name', name.replace(/trabajos\[\d+\]/, `trabajos[${index}]`));
                    }
                });
                exactoAplicarServicioTrabajo(fila, false);
            });
        }
        function exactoTotalTrabajosSinIva() {
            let total = 0;
            // Incluye SERSOP01 oculto en recepción, donde no existe tabla de trabajos.
            document.querySelectorAll('#ordenForm [name^="trabajos["][name$="[importe]"]').forEach((input) => {
                if (!input.disabled) total += parseFloat(input.value) || 0;
            });
            return total;
        }

        function calcularSubtotalTrabajos() {
            calcularTotalFactura();
        }

        // MANEJO DE MATERIALES
        function agregarMaterial() {
            const tbody = document.getElementById('materialesTableBody');
            if (!tbody) return;
            const rows = tbody.querySelectorAll('.material-row');
            const indice = rows.length;

            const fila = document.createElement('tr');
            fila.className = 'material-row hover:bg-blue-100';
            fila.innerHTML = `
                <td class="p-2 border sm:p-3"><input type="text" class="px-2 py-1 w-full text-sm rounded border border-blue-300" name="materiales[${indice}][vale]" placeholder="Vale"></td>
                <td class="p-2 border sm:p-3"><input type="text" class="px-2 py-1 w-full text-sm rounded border border-blue-300" name="materiales[${indice}][codigo]" placeholder="Código"></td>
                <td class="p-2 border sm:p-3"><input type="number" min="0" class="px-2 py-1 w-full text-sm rounded border border-blue-300 cant-input" name="materiales[${indice}][cant]" placeholder="Cant"></td>
                <td class="p-2 border sm:p-3"><input type="text" class="px-2 py-1 w-full text-sm rounded border border-blue-300" name="materiales[${indice}][descripcion]" placeholder="Descripción"></td>
                <td class="p-2 border sm:p-3"><div class="exacto-money-field"><span class="exacto-money-prefix">$</span><input type="number" step="0.01" min="0" class="px-2 py-1 w-full text-sm rounded border border-blue-300 precio-input" name="materiales[${indice}][precio]" placeholder="Neto c/IVA" title="Escribe el precio neto (con IVA). Se convierte a sin IVA automáticamente."></div></td>
                <td class="p-2 border sm:p-3"><span class="exacto-money-prefix">$</span><span class="text-sm importe-calc">0.00</span></td>
                <td class="p-2 border sm:p-3">${exactoHtmlTicketFacturaInput(`materiales[${indice}][ticket]`, 'text-sm', false)}</td>
                <td class="p-2 border sm:p-3">${exactoHtmlSelectEquipo(`materiales[${indice}][id_equipo]`)}</td>
                <td class="p-3 text-center border">
                    <button type="button" class="font-bold text-blue-600 hover:text-blue-800 btn-eliminar-material" title="Eliminar fila">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            `;
            tbody.appendChild(fila);
            exactoActualizarTicketMaterialFila(fila);
            calcularSubtotalMateriales();
        }
        function eliminarMaterial(fila) {
            const tbody = document.getElementById('materialesTableBody');
            if (!tbody) return;
            if (tbody.querySelectorAll('.material-row').length > 1) {
                fila.remove();
                calcularSubtotalMateriales();
            } else {
                void exactoShowAlert('Debe haber al menos una fila de material.', { title: 'Acción no permitida' });
            }
        }

        function agregarAnticipo() {
            const tbody = document.getElementById('anticiposTableBody');
            if (!tbody) return;
            const rows = tbody.querySelectorAll('.anticipo-row');
            const indice = rows.length;
            const fila = document.createElement('tr');
            fila.className = 'anticipo-row hover:bg-blue-100';
            fila.innerHTML = `
                <td class="p-2 border sm:p-3"><input type="text" class="px-2 py-1 w-full text-sm rounded border border-blue-300" name="anticipos[${indice}][folio]" placeholder="Folio pedido"></td>
                <td class="p-2 border sm:p-3"><input type="text" class="px-2 py-1 w-full text-sm rounded border border-blue-300" name="anticipos[${indice}][descripcion]" placeholder="Descripcion de refaccion"></td>
                <td class="p-2 border sm:p-3"><div class="exacto-money-field"><span class="exacto-money-prefix">$</span><input type="number" step="0.01" class="px-2 py-1 w-full text-sm rounded border border-blue-300 anticipo-input" name="anticipos[${indice}][monto]" value="" placeholder="Neto c/IVA" title="Escribe el monto neto (con IVA). Se convierte a sin IVA automáticamente."></div></td>
                <td class="p-2 border sm:p-3">${exactoHtmlTicketFacturaInput(`anticipos[${indice}][ticket]`, 'anticipo-ticket-input', false)}</td>
                <td class="p-2 border sm:p-3">${exactoHtmlSelectEquipo(`anticipos[${indice}][id_equipo]`)}</td>
                <td class="p-3 text-center border">
                    <button type="button" class="font-bold text-blue-600 hover:text-blue-800 btn-eliminar-anticipo" title="Eliminar anticipo">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            `;
            tbody.appendChild(fila);
            exactoSincronizarTicketsAnticipos();
            exactoActualizarTotalesAnticipos();
        }

        function eliminarAnticipo(fila) {
            const tbody = document.getElementById('anticiposTableBody');
            if (!tbody) return;
            if (tbody.querySelectorAll('.anticipo-row').length > 1) {
                fila.remove();
                exactoActualizarTotalesAnticipos();
            } else {
                const folio = fila.querySelector('[name*="[folio]"]');
                const descripcion = fila.querySelector('[name*="[descripcion]"]');
                const monto = fila.querySelector('[name*="[monto]"]');
                const ticket = exactoCampoTicket(fila);
                if (folio) folio.value = '';
                if (descripcion) descripcion.value = '';
                if (monto) monto.value = '';
                if (ticket) exactoAsignarTicketFactura(ticket, '');
                exactoActualizarTotalesAnticipos();
            }
        }

        function calcularImporte(fila) {
            if (!fila) return;
            const cant = parseFloat(fila.querySelector('.cant-input').value) || 0;
            const precioInput = fila.querySelector('.precio-input');
            let precio = parseFloat(precioInput && precioInput.value) || 0;
            // Mientras se captura el neto (c/IVA), el importe usa ya el sin IVA.
            if (precioInput && precioInput.dataset.exactoNetoEditing === '1') {
                precio = exactoMontoSinIvaDesdeTotal(precio);
            }
            const importe = exactoRound2(cant * precio);
            fila.querySelector('.importe-calc').textContent = importe.toFixed(2);
        }
        function exactoSubtotalMaterialesActual() {
            const importes = document.querySelectorAll('.importe-calc');
            let subtotal = 0;
            importes.forEach(span => {
                subtotal += parseFloat(span.textContent) || 0;
            });
            return subtotal;
        }

        function calcularSubtotalMateriales() {
            calcularTotalFactura();
        }

        function exactoCamposMaterial(row) {
            if (!row) return {};
            return {
                vale: row.querySelector('input[name*="[vale]"]'),
                cantidad: row.querySelector('input[name*="[cant]"]'),
                descripcion: row.querySelector('input[name*="[descripcion]"]'),
                precio: row.querySelector('input[name*="[precio]"]'),
                ticket: exactoCampoTicket(row),
            };
        }

        function exactoMaterialRequeridosCompletos(row) {
            const campos = exactoCamposMaterial(row);
            return Boolean(
                campos.vale && String(campos.vale.value || '').trim() !== ''
                && campos.cantidad && String(campos.cantidad.value || '').trim() !== ''
                && campos.descripcion && String(campos.descripcion.value || '').trim() !== ''
                && campos.precio && String(campos.precio.value || '').trim() !== ''
            );
        }

        function exactoActualizarTicketMaterialFila(row) {
            const campos = exactoCamposMaterial(row);
            if (!campos.ticket) return;
            // Ticket/factura opcional y siempre editable.
            exactoSetCampoTicketFactura(campos.ticket, true);
        }

        function exactoActualizarTicketsMateriales() {
            document.querySelectorAll('#materialesTableBody .material-row').forEach(exactoActualizarTicketMaterialFila);
            exactoSincronizarTicketsAnticipos();
        }

        function calcularTotalAnticipos() {
            const anticipos = document.querySelectorAll('#anticiposTableBody .anticipo-input');
            let total = 0;
            anticipos.forEach(input => {
                let monto = parseFloat(input.value) || 0;
                if (input.dataset.exactoNetoEditing === '1') {
                    monto = exactoMontoSinIvaDesdeTotal(monto);
                }
                total += monto;
            });
            return total;
        }

        function exactoTotalAbonoSaldo() {
            const input = document.getElementById('abonoSaldoAplicado');
            return parseFloat(input ? input.value : '0') || 0;
        }

        function exactoSetAbonoSaldo(value) {
            const safeValue = Math.max(0, Number.parseFloat(value || '0') || 0);
            const input = document.getElementById('abonoSaldoAplicado');
            if (input) input.value = safeValue.toFixed(2);
        }

        function exactoSincronizarTicketsAnticipos() {
            document.querySelectorAll('#anticiposTableBody .anticipo-ticket-input').forEach((campo) => {
                const fila = campo.closest('.anticipo-row');
                const esSaldoPago = fila && fila.dataset.saldoPago === '1';
                if (!esSaldoPago || campo.tagName !== 'INPUT') {
                    return;
                }
                campo.readOnly = true;
                campo.classList.add('bg-gray-100', 'text-gray-700', 'cursor-not-allowed');
            });
        }

        function exactoActualizarTotalesAnticipos() {
            exactoRenderListaAnticipos();
            calcularSaldoPendiente();
        }

        function exactoEsEdicionOrden() {
            return Number(document.getElementById('id_orden_c')?.value || 0) > 0;
        }

        function exactoRenderListaAnticipos() {
            const cont = document.getElementById('anticiposListaTotales');
            if (!cont) return;
            const filas = document.querySelectorAll('#anticiposTableBody .anticipo-row');
            let html = '';
            let nro = 0;
            filas.forEach((row) => {
                const inputMonto = row.querySelector('.anticipo-input');
                const inputTicket = row.querySelector('.anticipo-ticket-input, [name*="[ticket]"]');
                const inputFolio = row.querySelector('[name*="[folio]"]');
                const inputDesc = row.querySelector('[name*="[descripcion]"]');
                const montoTexto = String(inputMonto ? inputMonto.value : '').trim();
                const monto = montoTexto === '' ? 0 : (parseFloat(montoTexto) || 0);
                const folio = inputFolio ? String(inputFolio.value || '').trim() : '';
                const desc = inputDesc ? String(inputDesc.value || '').trim() : '';
                const ticket = inputTicket ? String(inputTicket.value || '').trim() : '';
                if (folio === '' && desc === '' && ticket === '' && montoTexto === '') {
                    return;
                }
                nro += 1;
                const partes = [];
                if (folio !== '') partes.push(`Folio: ${exactoEscapeHtml(folio)}`);
                if (desc !== '') partes.push(exactoEscapeHtml(desc));
                if (ticket !== '') partes.push(`Ticket/Factura: ${exactoEscapeHtml(ticket)}`);
                const extra = partes.length ? ` - ${partes.join(' | ')}` : '';
                html += `<strong>ANTICIPO ${nro}${extra}: $${monto.toFixed(2)} (SIN IVA)</strong><br>`;
            });
            cont.innerHTML = html;
        }

        function calcularTotalFactura() {
            const elTot = document.getElementById('total');
            if (!elTot) return;
            const subtotalCombinado = exactoRound2(exactoTotalTrabajosSinIva() + exactoSubtotalMaterialesActual());
            const ivaTotal = exactoRound2(subtotalCombinado * EXACTO_IVA_RATE);
            const total = exactoRound2(subtotalCombinado + ivaTotal);

            const elSubtotalCombinado = document.getElementById('subtotalCombinado');
            const elIvaTotal = document.getElementById('ivaTotal');
            if (elSubtotalCombinado) elSubtotalCombinado.textContent = subtotalCombinado.toFixed(2);
            if (elIvaTotal) elIvaTotal.textContent = ivaTotal.toFixed(2);
            elTot.textContent = total.toFixed(2);

            calcularSaldoPendiente();
        }

        function calcularSaldoPendiente() {
            const elTot = document.getElementById('total');
            const elSal = document.getElementById('saldoPendiente');
            if (!elTot || !elSal) return;
            const total = parseFloat(elTot.textContent) || 0;
            const anticipos = calcularTotalAnticipos();
            const abonoEl = document.getElementById('abonoSaldoAplicado');
            const abono = exactoTotalAbonoSaldo();
            const pagosSinIva = anticipos + abono;
            let saldo = exactoRound2(total - exactoMontoConIva(pagosSinIva));

            // Al liquidar (o al recargar una orden ya liquidada, donde el abono
            // vuelve redondeado a 2 decimales) el ida-vuelta del IVA deja un
            // residuo de ±$0.01. Con pagos ya hechos, se ajusta el abono con
            // precisión completa para que el saldo quede en $0.00 exacto y
            // coincida con el cálculo del servidor (tolerancia 0.009).
            if (abonoEl && Math.abs(saldo) > 0.004 && Math.abs(saldo) <= 0.011 && pagosSinIva > 0.009) {
                const abonoExacto = Math.max(0, total / (1 + EXACTO_IVA_RATE) - anticipos);
                abonoEl.value = String(abonoExacto);
                saldo = exactoRound2(total - exactoMontoConIva(anticipos + abonoExacto));
            }

            elSal.textContent = saldo.toFixed(2);

            const badge = elSal.closest('strong');
            const btnLiquidar = document.getElementById('btnPagarSaldoPendiente');
            const liquidado = Math.abs(saldo) <= 0.009;
            if (badge) {
                badge.style.backgroundColor = liquidado ? '#16a34a' : '#dc2626';
            }
            if (btnLiquidar) {
                btnLiquidar.classList.toggle('hidden', liquidado);
                btnLiquidar.disabled = liquidado;
            }
        }

        function exactoIdEquipoDeFilaLiquidar(row) {
            return Number(row.querySelector('select[name*="[id_equipo]"]')?.value) || 1;
        }

        function exactoCalcularSaldoEquipo(numEquipo) {
            let trabajos = 0;
            document.querySelectorAll('#trabajosTableBody .trabajo-row').forEach((row) => {
                if (exactoIdEquipoDeFilaLiquidar(row) !== numEquipo) return;
                trabajos += parseFloat(row.querySelector('.importe-input')?.value) || 0;
            });
            let materiales = 0;
            document.querySelectorAll('#materialesTableBody .material-row').forEach((row) => {
                if (exactoIdEquipoDeFilaLiquidar(row) !== numEquipo) return;
                materiales += parseFloat(row.querySelector('.importe-calc')?.textContent) || 0;
            });
            let anticipos = 0;
            document.querySelectorAll('#anticiposTableBody .anticipo-row').forEach((row) => {
                if (exactoIdEquipoDeFilaLiquidar(row) !== numEquipo) return;
                const input = row.querySelector('.anticipo-input');
                let monto = parseFloat(input?.value) || 0;
                if (input && input.dataset.exactoNetoEditing === '1') {
                    monto = exactoMontoSinIvaDesdeTotal(monto);
                }
                anticipos += monto;
            });
            const map = exactoLeerAbonoEquiposMap();
            const yaLiquidado = parseFloat(map[String(numEquipo)] || map[numEquipo] || 0) || 0;
            const saldoSinIva = Math.max(0, exactoRound2(trabajos + materiales - anticipos - yaLiquidado));
            return exactoMontoConIva(saldoSinIva);
        }

        function exactoLeerEquiposParaLiquidar() {
            const filas = document.querySelectorAll('#equiposTableBody .equipo-row');
            if (filas.length) {
                return Array.from(filas).map((fila, idx) => {
                    const num = idx + 1;
                    return {
                        num,
                        marca: String(fila.querySelector('[name*="[marca]"]')?.value || '').trim() || 'Sin marca',
                        modelo: String(fila.querySelector('[name*="[modelo]"]')?.value || '').trim() || 'Sin modelo',
                        serie: String(fila.querySelector('[name*="[serie]"]')?.value || '').trim(),
                        saldo: exactoCalcularSaldoEquipo(num),
                    };
                });
            }
            let ordenJson = {};
            const jsonEl = document.getElementById('ordenExistenteJson');
            if (jsonEl) {
                try { ordenJson = JSON.parse(jsonEl.textContent || '{}'); } catch (e) { ordenJson = {}; }
            }
            return (ordenJson.equipos || []).map((eq, idx) => {
                const num = idx + 1;
                return {
                    num,
                    marca: eq.marca || 'Sin marca',
                    modelo: eq.modelo || 'Sin modelo',
                    serie: eq.serie || '',
                    saldo: exactoCalcularSaldoEquipo(num),
                };
            });
        }

        function exactoCerrarModalLiquidarSaldo() {
            const modal = document.getElementById('modalLiquidarSaldo');
            if (!modal) return;
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            modal.style.display = 'none';
            document.body.style.overflow = '';
        }

        function exactoAbrirModalLiquidarSaldo() {
            const modal = document.getElementById('modalLiquidarSaldo');
            if (!modal) {
                void exactoShowAlert('No se encontró la ventana de liquidar saldo.', { title: 'Error', icon: 'error' });
                return;
            }
            if (modal.parentNode !== document.body) {
                document.body.appendChild(modal);
            }
            const container = document.getElementById('equiposLiquidarSaldoContainer');
            if (container) {
                container.innerHTML = '';
                const equipos = exactoLeerEquiposParaLiquidar();
                if (!equipos.length) {
                    container.innerHTML = '<p class="text-slate-500">No hay equipos registrados en esta orden.</p>';
                } else {
                    equipos.forEach((eq) => {
                        const serieTxt = eq.serie ? ` · Serie: ${exactoEscapeHtml(eq.serie)}` : '';
                        const row = document.createElement('div');
                        row.className = 'p-3 border-2 border-blue-200 rounded-lg bg-blue-50';
                        row.innerHTML = `
                            <label class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between cursor-pointer">
                                <span class="flex items-start gap-2 min-w-0">
                                    <input type="checkbox" class="mt-1 w-4 h-4 rounded border-blue-600" name="equipo_liquidar[]" value="${eq.num}" data-saldo="${eq.saldo}">
                                    <span class="text-sm text-blue-900">
                                        <span class="font-bold">Equipo ${eq.num}:</span> ${exactoEscapeHtml(eq.marca)} - ${exactoEscapeHtml(eq.modelo)}${serieTxt}
                                    </span>
                                </span>
                                <span class="rounded-lg bg-red-600 px-3 py-2 text-center text-sm font-bold text-white sm:min-w-[10rem]">
                                    SALDO: $${eq.saldo.toFixed(2)}
                                </span>
                            </label>
                        `;
                        container.appendChild(row);
                    });
                }
            }
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            modal.style.cssText = 'position:fixed;inset:0;z-index:20000;display:flex !important;align-items:center;justify-content:center;padding:1rem;background:rgba(2,6,23,0.8);';
            document.body.style.overflow = 'hidden';
        }

        async function exactoConfirmarLiquidarSaldo() {
            const checkboxes = document.querySelectorAll('#modalLiquidarSaldo input[name="equipo_liquidar[]"]:checked');
            const items = Array.from(checkboxes).map((c) => ({
                num: Number(c.value),
                saldoConIva: parseFloat(c.dataset.saldo) || 0,
            }));
            if (!items.length) {
                await exactoShowAlert('Selecciona al menos un equipo', { title: 'Error', icon: 'error' });
                return;
            }
            const saldoSeleccionado = items.reduce((acc, it) => acc + it.saldoConIva, 0);
            const confirmar = await exactoShowConfirm(
                `¿Liquidar el saldo de $${saldoSeleccionado.toFixed(2)} de ${items.length} equipo(s) seleccionado(s)? El resto de la orden puede seguir con saldo.`,
                {
                    title: 'Confirmar liquidación',
                    confirmText: 'Sí, liquidar',
                    cancelText: 'Cancelar',
                    icon: 'warning',
                }
            );
            if (!confirmar) {
                return;
            }
            const ok = await window.exactoAplicarLiquidacionEquipos(items);
            if (ok) {
                exactoCerrarModalLiquidarSaldo();
            }
        }

        window.exactoBtnLiquidarSaldo = exactoAbrirModalLiquidarSaldo;

        function exactoLeerAbonoEquiposMap() {
            const el = document.getElementById('abonoSaldoEquiposJson');
            if (!el) return {};
            try {
                const parsed = JSON.parse(String(el.value || '{}'));
                return parsed && typeof parsed === 'object' ? parsed : {};
            } catch (e) {
                return {};
            }
        }

        function exactoGuardarAbonoEquiposMap(map) {
            const el = document.getElementById('abonoSaldoEquiposJson');
            if (el) el.value = JSON.stringify(map || {});
        }

        window.exactoAbonoLiquidadoEquipoSinIva = function (numEquipo) {
            const map = exactoLeerAbonoEquiposMap();
            return parseFloat(map[String(numEquipo)] || map[numEquipo] || 0) || 0;
        };

        window.exactoAplicarLiquidacionEquipos = async function (items) {
            calcularTotalFactura();
            let restanteOrden = exactoSaldoPendienteActual();
            if (restanteOrden <= 0.009) {
                await exactoShowAlert('No hay saldo pendiente por pagar.', { title: 'Saldo pendiente' });
                return false;
            }

            const map = exactoLeerAbonoEquiposMap();
            let aAplicar = 0;
            (items || []).forEach((it) => {
                const num = Number(it.num) || 0;
                const pedido = Math.max(0, parseFloat(it.saldoConIva) || 0);
                const parte = exactoRound2(Math.min(pedido, restanteOrden - aAplicar));
                if (num <= 0 || parte <= 0.009) return;
                aAplicar = exactoRound2(aAplicar + parte);
                const key = String(num);
                map[key] = exactoRound2((parseFloat(map[key]) || 0) + exactoMontoSinIvaDesdeTotal(parte));
            });

            if (aAplicar <= 0.009) {
                await exactoShowAlert('El equipo seleccionado no tiene saldo pendiente según sus cálculos.', {
                    title: 'Sin saldo',
                });
                return false;
            }

            exactoGuardarAbonoEquiposMap(map);
            exactoSetAbonoSaldo(exactoTotalAbonoSaldo() + exactoMontoSinIvaDesdeTotal(aAplicar));
            calcularSaldoPendiente();
            const restante = exactoSaldoPendienteActual();
            const confirmado = document.getElementById('saldoPagadoConfirmado');
            if (confirmado) confirmado.value = restante <= 0.009 ? '1' : '0';
            exactoMarcarOrdenFormSucio();
            await exactoShowAlert(
                `Se liquidó $${aAplicar.toFixed(2)} del equipo seleccionado.\nSaldo restante de la orden: $${restante.toFixed(2)}.`,
                { title: 'Pago aplicado', icon: 'success' }
            );
            return true;
        };

        async function exactoPagarSaldoPendiente() {
            exactoAbrirModalLiquidarSaldo();
        }

        /** Solo dígitos y un punto decimal (evita letras y notación científica en type="number"). */
        function sanitizarDecimal(val) {
            if (val == null || val === '') return '';
            const negativo = String(val).trim().startsWith('-');
            let s = String(val).replace(/[^\d.]/g, '');
            const i = s.indexOf('.');
            if (i !== -1) {
                s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '');
            }
            return negativo ? `-${s}` : s;
        }

        function exactoFilaTrabajoUsada(row) {
            return ['clave', 'descripcion', 'importe'].some((campo) => {
                const input = row.querySelector(`[name*="[${campo}]"]`);
                return input && String(input.value || '').trim() !== '';
            });
        }

        function exactoFilaMaterialUsada(row) {
            return ['vale', 'codigo', 'cant', 'descripcion', 'precio'].some((campo) => {
                const input = row.querySelector(`[name*="[${campo}]"]`);
                return input && String(input.value || '').trim() !== '';
            });
        }

        function exactoHayNumerosNegativos() {
            const inputs = document.querySelectorAll(
                '#trabajosTableBody input[name*="[importe]"], #materialesTableBody input[name*="[cant]"], #materialesTableBody input[name*="[precio]"], #anticiposTableBody input[name*="[monto]"]'
            );
            for (const input of inputs) {
                if ((parseFloat(input.value) || 0) < 0) {
                    return true;
                }
            }

            return false;
        }

        function exactoSaldoPendienteActual() {
            calcularTotalFactura();
            const saldoEl = document.getElementById('saldoPendiente');
            return parseFloat(saldoEl ? saldoEl.textContent : '0') || 0;
        }

        function exactoHabilitarCamposTicketParaEnvio() {
            document.querySelectorAll('#ordenForm .ticket-factura-input, #ordenForm .ticket-factura-select').forEach((campo) => {
                campo.disabled = false;
                if (campo.tagName === 'INPUT') {
                    campo.readOnly = false;
                    campo.removeAttribute('readonly');
                }
            });
        }

        async function exactoValidarCargosYAnticipos() {
            exactoActualizarTotalesAnticipos();
            // Ticket/factura es opcional en trabajos, materiales y anticipos.

            const materialRows = document.querySelectorAll('#materialesTableBody .material-row');
            for (const row of materialRows) {
                if (!exactoFilaMaterialUsada(row)) continue;
                const campos = exactoCamposMaterial(row);
                const filaNum = exactoNumeroFilaTabla(row);
                const requeridos = [
                    [campos.vale, `Material (fila ${filaNum}): falta el vale.`],
                    [campos.cantidad, `Material (fila ${filaNum}): falta la cantidad.`],
                    [campos.descripcion, `Material (fila ${filaNum}): falta la descripción.`],
                    [campos.precio, `Material (fila ${filaNum}): falta el precio unitario.`],
                ];
                for (const [input, mensaje] of requeridos) {
                    if (!input || String(input.value || '').trim() === '') {
                        await exactoShowAlert(mensaje, { title: 'Faltan datos en la orden' });
                        exactoUiFocusField(input);
                        return false;
                    }
                }
                if ((parseFloat(campos.cantidad.value) || 0) < 0) {
                    await exactoShowAlert(`Material (fila ${filaNum}): la cantidad no puede ser negativa.`, {
                        title: 'Faltan datos en la orden',
                    });
                    exactoUiFocusField(campos.cantidad);
                    return false;
                }
                if ((parseFloat(campos.precio.value) || 0) < 0) {
                    await exactoShowAlert(`Material (fila ${filaNum}): el precio unitario no puede ser negativo.`, {
                        title: 'Faltan datos en la orden',
                    });
                    exactoUiFocusField(campos.precio);
                    return false;
                }
            }

            const anticipoRows = document.querySelectorAll('#anticiposTableBody .anticipo-row');
            for (const row of anticipoRows) {
                const folioInput = row.querySelector('[name*="[folio]"]');
                const descInput = row.querySelector('[name*="[descripcion]"]');
                const montoInput = row.querySelector('[name*="[monto]"]');
                const ticketInput = exactoCampoTicket(row);
                const folioTexto = String(folioInput ? folioInput.value : '').trim();
                const descTexto = String(descInput ? descInput.value : '').trim();
                const montoTexto = String(montoInput ? montoInput.value : '').trim();
                const ticketTexto = String(ticketInput ? ticketInput.value : '').trim();
                const montoNum = montoTexto === '' ? NaN : parseFloat(montoTexto);
                const filaUsada = folioTexto !== '' || descTexto !== '' || ticketTexto !== ''
                    || (montoTexto !== '' && (!Number.isFinite(montoNum) || Math.abs(montoNum) >= 0.009));
                if (!filaUsada) continue;
                const filaNum = exactoNumeroFilaTabla(row);
                if (folioTexto === '') {
                    await exactoShowAlert(`Anticipo (fila ${filaNum}): captura el folio del pedido.`, {
                        title: 'Faltan datos en la orden',
                    });
                    exactoUiFocusField(folioInput);
                    return false;
                }
                if (descTexto === '') {
                    await exactoShowAlert(`Anticipo (fila ${filaNum}): captura la descripción de refacción.`, {
                        title: 'Faltan datos en la orden',
                    });
                    exactoUiFocusField(descInput);
                    return false;
                }
                if (montoTexto === '') {
                    await exactoShowAlert(`Anticipo (fila ${filaNum}): captura el monto pagado (puede ser 0).`, {
                        title: 'Faltan datos en la orden',
                    });
                    exactoUiFocusField(montoInput);
                    return false;
                }
                if (!Number.isFinite(parseFloat(montoTexto))) {
                    await exactoShowAlert(`Anticipo (fila ${filaNum}): el monto pagado no es válido.`, {
                        title: 'Faltan datos en la orden',
                    });
                    exactoUiFocusField(montoInput);
                    return false;
                }
            }

            return true;
        }

        async function exactoValidarEntregadoLiquidado() {
            const estatusEl = document.getElementById('inputEstatus');
            if (!estatusEl || exactoNormalizarEstatusOrden(estatusEl.value) !== 'Entregado') {
                return true;
            }
            calcularTotalFactura();
            const saldoEl = document.getElementById('saldoPendiente');
            const saldo = parseFloat(saldoEl ? saldoEl.textContent : '0') || 0;
            if (Math.abs(saldo) > 0.009) {
                await exactoShowAlert('Para marcar como Entregado, el saldo pendiente debe quedar liquidado en $0.00.', {
                    title: 'Saldo pendiente',
                });
                exactoUiFocusField(saldoEl);
                return false;
            }

            return true;
        }

        async function exactoConfirmarSaldoLiquidadoAlGuardar() {
            calcularTotalFactura();
            const totalEl = document.getElementById('total');
            const saldoEl = document.getElementById('saldoPendiente');
            const confirmadoEl = document.getElementById('saldoPagadoConfirmado');
            const total = parseFloat(totalEl ? totalEl.textContent : '0') || 0;
            const saldo = parseFloat(saldoEl ? saldoEl.textContent : '0') || 0;
            const yaConfirmado = confirmadoEl && confirmadoEl.value === '1';
            const anticipos = calcularTotalAnticipos();
            const abono = exactoTotalAbonoSaldo();
            const huboPago = (anticipos + abono) > 0.009;

            if (total <= 0.009) {
                return true;
            }

            // Hay saldo pendiente: preguntar si el cliente ya pagó.
            if (saldo > 0.009) {
                const clientePago = await exactoShowConfirm(
                    `Hay saldo pendiente de $${saldo.toFixed(2)}. ¿El cliente ya pagó?`,
                    {
                        title: 'Confirmar pago',
                        confirmText: 'Sí, liquidar y guardar',
                        cancelText: 'No, guardar con saldo',
                    }
                );
                if (clientePago) {
                    if (confirmadoEl) confirmadoEl.value = '1';
                    exactoSetAbonoSaldo(abono + exactoMontoSinIvaDesdeTotal(saldo));
                    calcularSaldoPendiente();
                }
                return true;
            }

            // Saldo liquidado (0) con anticipos/abono: exigir confirmación "cliente pagó".
            if (Math.abs(saldo) <= 0.009 && huboPago && !yaConfirmado) {
                const clientePago = await exactoShowConfirm(
                    'El saldo pendiente quedó en $0.00. ¿Confirmas que el cliente pagó?',
                    {
                        title: 'Confirmar pago',
                        confirmText: 'Sí, cliente pagó',
                        cancelText: 'Cancelar',
                    }
                );
                if (!clientePago) {
                    await exactoShowAlert('Guardado cancelado. Confirma el pago del cliente para continuar.', {
                        title: 'Operación cancelada',
                    });
                    exactoUiFocusField(saldoEl);
                    return false;
                }
                if (confirmadoEl) confirmadoEl.value = '1';
            }

            return true;
        }

        const ordenFormEl = document.getElementById('ordenForm');
        if (ordenFormEl) {
            ordenFormEl.addEventListener('keydown', function (e) {
                const el = e.target;
                if (!el || el.tagName !== 'INPUT' || el.type !== 'number' || el.readOnly) return;
                if (['e', 'E', '+'].includes(e.key)) {
                    e.preventDefault();
                }
            });
        }

        // Event listeners adicionales
        document.addEventListener('focusin', function (e) {
            if (exactoCampoEsNetoConvertible(e.target)) {
                exactoIniciarEdicionPrecioNeto(e.target);
            }
        });

        document.addEventListener('keydown', function (e) {
            if (!exactoCampoEsNetoConvertible(e.target)) return;
            if (e.key !== 'Enter') return;
            e.preventDefault();
            exactoAplicarConversionNetoASinIva(e.target);
            e.target.blur();
        });

        document.addEventListener('input', function(e) {
            if (e.target.tagName === 'INPUT' && e.target.type === 'number' && !e.target.readOnly && e.target.closest('#ordenForm')) {
                const cleaned = sanitizarDecimal(e.target.value);
                if (cleaned !== e.target.value) {
                    e.target.value = cleaned;
                }
            }
            if (exactoCampoEsNetoConvertible(e.target)) {
                exactoActualizarHintNetoSinIva(e.target);
            }
            const cls = e.target && e.target.classList;
            if (cls && (cls.contains('cant-input') || cls.contains('precio-input'))) {
                calcularImporte(e.target.closest('.material-row'));
                calcularSubtotalMateriales();
            }
            if (e.target && e.target.closest && e.target.closest('#materialesTableBody')) {
                exactoActualizarTicketsMateriales();
            }
            if (e.target && e.target.closest && e.target.closest('#materialesTableBody') && e.target.name && e.target.name.includes('[ticket]')) {
                exactoSincronizarTicketsAnticipos();
            }
            if (cls && cls.contains('importe-input')) {
                calcularSubtotalTrabajos();
            }
        });

        document.addEventListener('blur', function (e) {
            if (exactoCampoEsNetoConvertible(e.target)) {
                exactoAplicarConversionNetoASinIva(e.target);
            }
            if (e.target && e.target.classList && e.target.classList.contains('anticipo-input')) {
                exactoActualizarTotalesAnticipos();
            }
        }, true);

        document.addEventListener('input', function (e) {
            if (!e.target.closest('#anticiposTableBody')) {
                return;
            }
            const name = String(e.target.name || '');
            if (name.includes('[folio]') || name.includes('[descripcion]') || name.includes('[monto]') || name.includes('[ticket]')) {
                exactoActualizarTotalesAnticipos();
            }
        });

        document.addEventListener('change', function(e) {
            if (
                e.target
                && e.target.closest
                && e.target.closest('#anticiposTableBody')
                && e.target.classList
                && e.target.classList.contains('anticipo-ticket-input')
            ) {
                exactoActualizarTotalesAnticipos();
            }
            if (e.target.matches('select[name*="[clave]"]') && e.target.closest('#trabajosTableBody')) {
                const fila = e.target.closest('.trabajo-row');
                exactoAplicarServicioTrabajo(fila, true);
            }
        });

        // Descripción y precio bloqueados salvo SERVICIO EXTRA.
        document.addEventListener('focusin', function (e) {
            const input = e.target;
            if (!input || input.tagName !== 'INPUT') return;
            const fila = input.closest('#trabajosTableBody .trabajo-row');
            if (!fila) return;
            const name = String(input.name || '');
            if (!name.includes('[descripcion]') && !name.includes('[importe]')) return;
            const campos = exactoCamposTrabajo(fila);
            const servicio = exactoServicioParaSelect(campos.clave);
            const editable = exactoServicioTrabajoEsEditable(servicio, campos.clave);
            exactoAplicarBloqueoCamposTrabajo(campos, editable);
            if (!editable) {
                input.blur();
            }
        }, true);

        document.addEventListener('input', function(e) {
            if (e.target.matches('select[name*="[clave]"]') && e.target.closest('#trabajosTableBody')) {
                exactoPrevisualizarServicioTrabajo(e.target.closest('.trabajo-row'));
            }
        });

        document.addEventListener('mouseover', function(e) {
            const sel = e.target && e.target.closest && e.target.closest('select[name*="[clave]"]');
            if (!sel || !sel.closest('#trabajosTableBody')) return;
            exactoPrevisualizarServicioTrabajo(sel.closest('.trabajo-row'));
        }, true);

        document.addEventListener('focusin', function(e) {
            if (e.target.matches('select[name*="[clave]"]') && e.target.closest('#trabajosTableBody')) {
                exactoPrevisualizarServicioTrabajo(e.target.closest('.trabajo-row'));
            }
            if (e.target.tagName === 'OPTION') {
                exactoPrevisualizarDesdeOption(e.target);
            }
        });

        document.addEventListener('mouseover', function(e) {
            if (e.target.tagName === 'OPTION') {
                exactoPrevisualizarDesdeOption(e.target);
            }
        });

        function exactoMostrarBannerFirmasDeshabilitadasSiAplica() {
            const wrap = document.getElementById('wrapBannerFirmasDeshabilitadas');
            if (!wrap || !window.EXACTO_ORDEN_FIRMAS_DESHABILITADAS) {
                return;
            }
            wrap.classList.remove('hidden');
            wrap.classList.add('flex');
            const wrapLink = document.getElementById('wrapLinkMostrarFirmas');
            if (wrapLink) wrapLink.classList.add('hidden');
            try {
                wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } catch (err) {
                wrap.scrollIntoView();
            }
        }

        function exactoLeerTextosObservaciones() {
            const form = document.getElementById('ordenForm');
            if (!form) {
                return [];
            }
            const vistos = new Set();
            const textos = [];
            form.querySelectorAll('input[name="observaciones[]"], input.observacion-input').forEach((el) => {
                if (!(el instanceof HTMLInputElement) || vistos.has(el)) {
                    return;
                }
                vistos.add(el);
                const texto = String(el.value || '').trim();
                if (texto !== '') {
                    textos.push(texto);
                }
            });
            return textos;
        }

        const EXACTO_MSG_OBS = 'Atención: el campo observaciones está vacío. Escriba al menos una observación.';

        async function exactoValidarObservaciones() {
            const idOrden = Number(document.getElementById('id_orden_c')?.value || 0);
            if (idOrden > 0 || window.EXACTO_ORDEN_MODO_COMPLETAR) {
                return true;
            }
            if (exactoLeerTextosObservaciones().length > 0) {
                return true;
            }
            await exactoShowAlert(EXACTO_MSG_OBS, { title: 'Observaciones' });
            const form = document.getElementById('ordenForm');
            const first = form?.querySelector('input[name="observaciones[]"], input.observacion-input');
            if (first) {
                exactoUiFocusField(first);
            }
            return false;
        }

        function exactoBuildTipoServicioOptionsHtml() {
            const tipos = Array.isArray(window.EXACTO_TIPOS_SERVICIO) ? window.EXACTO_TIPOS_SERVICIO : [
                '1. Mantenimiento', '2. Reparacion', '3. Instalacion', '4. Garantia', '5. Revision',
            ];
            return tipos.map((v) => {
                const esc = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
                return `<option value="${esc}">${esc}</option>`;
            }).join('');
        }

        /** Reconstruye selects de tipo de servicio desde EXACTO_TIPOS_SERVICIO (corrige mojibake del HTML en servidor). */
        function exactoRepararSelectsTipoServicio() {
            document.querySelectorAll('select[name*="[tipoServicio]"]').forEach((select) => {
                const valorGuardado = select.value;
                select.innerHTML = `<option value="">Seleccionar...</option>${exactoBuildTipoServicioOptionsHtml()}`;
                exactoSeleccionarTipoServicio(select, valorGuardado);
            });
        }

        // ENVÍO DEL FORMULARIO
        async function exactoPrepararGuardadoOrden(form) {

            // Si el usuario guarda con el cursor aún en precio/monto neto, convertir antes de validar/enviar.
            form.querySelectorAll('.precio-input, .anticipo-input').forEach((input) => {
                exactoAplicarConversionNetoASinIva(input);
            });

            exactoOcultarEstadoGuardado();

            if (!await exactoValidarEquipos()) {
                exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                return;
            }

            if (!await exactoConfirmarCobroSersop01RevisionNueva()) {
                exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                return;
            }

            if (!await exactoValidarServiciosSersop(form)) {
                exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                return;
            }

            if (!await exactoValidarCargosYAnticipos()) {
                exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                return;
            }

            if (!await exactoValidarEntregadoLiquidado()) {
                exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                return;
            }

            if (!await exactoConfirmarSaldoLiquidadoAlGuardar()) {
                exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                return;
            }

            if (!await exactoValidarObservaciones()) {
                exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                return;
            }

            if (exactoHayNumerosNegativos()) {
                await exactoShowAlert('Los importes no pueden ser negativos. Revisa los cargos y pagos.', { title: 'Revisar importes' });
                exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                return;
            }
            const saldoPendiente = exactoSaldoPendienteActual();
            if (saldoPendiente < -0.011) {
                await exactoShowAlert('Los pagos exceden el total de la orden. Revisa el abono y los anticipos antes de guardar.', { title: 'Revisar pagos' });
                exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                return;
            }

            if (!await exactoValidarFormularioHtml(form)) {
                exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                return;
            }

            // Celular y correo son opcionales: no bloqueamos el guardado si vienen vacios o mal.
            // Solo se normalizan; si el dato no es valido, la orden se guarda y el backend
            // omite el envio mostrando una alerta de "WhatsApp/correo no enviado".
            const telInput = document.getElementById('telefono');
            if (telInput) {
                telInput.value = String(telInput.value || '').replace(/\D/g, '').slice(0, 20);
            }

            const correoInput = form.querySelector('[name="correo"]');
            if (correoInput) {
                correoInput.value = String(correoInput.value || '').trim().toLowerCase();
            }

            const poblacionInput = form.querySelector('[name="poblacion"]');
            if (poblacionInput) {
                const poblacion = String(poblacionInput.value || '').trim().replace(/\s+/g, ' ');
                poblacionInput.value = poblacion;
                if (
                    poblacion.length < 2 ||
                    poblacion.length > 80 ||
                    /\d{4,}/.test(poblacion) ||
                    !/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s.'-]+$/.test(poblacion)
                ) {
                    await exactoShowAlert(
                        'Población/Ciudad: usa solo letras, espacios, puntos, apóstrofes o guiones (sin números largos).',
                        { title: 'Faltan datos en la orden' }
                    );
                    exactoUiFocusField(poblacionInput);
                    exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                    return;
                }
            }

            exactoHabilitarCamposTicketParaEnvio();
            const formData = new FormData(form);
            formData.delete('observaciones[]');
            exactoLeerTextosObservaciones().forEach((texto) => {
                formData.append('observaciones[]', texto);
            });
            const firmaPngVacia = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

            if (window.EXACTO_ORDEN_FIRMAS_DESHABILITADAS) {
                formData.append('firmaClienteInicial', firmaPngVacia);
                formData.append('firmaTecnicoInicial', firmaPngVacia);
                formData.append('firmaCliente', firmaPngVacia);
                formData.append('firmaTecnico', firmaPngVacia);
            } else {
                const firmaVisible = (id) => {
                    const canvas = document.getElementById(id);
                    if (!canvas) return false;
                    const bloque = canvas.closest('section');
                    if (!bloque) return true;
                    return !bloque.classList.contains('hidden') && !bloque.classList.contains('orden-firmas-skip');
                };
                const idsBase = window.EXACTO_ORDEN_MODO_COMPLETAR
                    ? ['firmaCliente', 'firmaTecnico']
                    : ['firmaClienteInicial', 'firmaTecnicoInicial', 'firmaCliente', 'firmaTecnico'];
                const idsFirma = idsBase.filter(firmaVisible);
                const firmasFaltantes = idsFirma.filter((id) => !canvasPareceFirmado(id));
                if (!idsFirma.every((id) => document.getElementById(id) && canvasContexts[id])) {
                    const lista = idsFirma
                        .map((id) => EXACTO_ETIQUETAS_FIRMA[id] || id)
                        .join('\n• ');
                    await exactoShowAlert(`Faltan estas firmas:\n\n• ${lista}`, {
                        title: 'Firmas requeridas',
                    });
                    exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                    return;
                }
                if (firmasFaltantes.length > 0) {
                    const lista = firmasFaltantes
                        .map((id) => EXACTO_ETIQUETAS_FIRMA[id] || id)
                        .join('\n• ');
                    await exactoShowAlert(`Debes firmar en:\n\n• ${lista}`, {
                        title: 'Firmas requeridas',
                    });
                    const primera = document.getElementById(firmasFaltantes[0]);
                    if (primera) {
                        exactoUiFocusField(primera);
                    }
                    exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                    return;
                }
                idsFirma.forEach((id) => {
                    const campo = (
                        id === 'firmaClienteInicial' ? 'firmaClienteInicial' :
                        id === 'firmaTecnicoInicial' ? 'firmaTecnicoInicial' :
                        id === 'firmaCliente' ? 'firmaCliente' :
                        'firmaTecnico'
                    );
                    const canvas = document.getElementById(id);
                    if (canvas) formData.append(campo, canvas.toDataURL('image/png'));
                });
            }

            // Salida temporal: aviso + modal ANTES de enviar el guardado.
            const salidaTemporalCapturada = await exactoPreguntarSalidaTemporalAntesDeGuardar();
            if (salidaTemporalCapturada === false) {
                exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                return;
            }

            if (exactoEsOrdenNueva()) {
                if (!exactoSubmissionToken) {
                    exactoSubmissionToken = globalThis.crypto.randomUUID
                        ? globalThis.crypto.randomUUID()
                        : Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, '0')).join('');
                }
                formData.set('submission_token', exactoSubmissionToken);
            }
            exactoGuardarBorradorOrdenLocal();
            return { formData, salidaTemporalCapturada };
        }

        document.getElementById('ordenForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            if (exactoOrdenSubmitPreparing || exactoOrdenSubmitInFlight) return;
            exactoOrdenSubmitPreparing = true;
            let pendiente;
            try {
                pendiente = exactoGuardadoPendiente || await exactoPrepararGuardadoOrden(this);
                if (!pendiente) return;
                exactoGuardadoPendiente = pendiente;
            } finally {
                exactoOrdenSubmitPreparing = false;
            }
            const { formData, salidaTemporalCapturada } = pendiente;
            exactoMarcarGuardadoEnCurso('Guardando orden, espere...');
            let requiereLiberarGuardado = true;

            try {
                const registrarUrl = exactoUrlApiRegistrar();
                const response = await fetch(registrarUrl, {
                    method: 'POST',
                    body: formData,
                    credentials: 'same-origin',
                    headers: {
                        Accept: 'application/json',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                });
                const raw = await response.text();
                let data;
                try {
                    data = raw.trim() === '' ? {} : JSON.parse(raw);
                } catch (parseErr) {
                    exactoLiberarGuardado({
                        keepNotice: true,
                        type: 'error',
                        message: 'No se pudo confirmar el guardado. Reintenta desde este formulario para recuperar la orden.',
                    });
                    requiereLiberarGuardado = false;
                    await exactoShowAlert(
                        'No se pudo confirmar el guardado. Reintenta desde este formulario; se recuperará la orden si ya fue registrada.',
                        { title: 'Error al guardar', icon: 'error' }
                    );
                    console.error('Respuesta de guardado inválida, HTTP', response.status);
                    exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                    return;
                }

                if (data.success) {
                    exactoGuardadoPendiente = null;
                    // Bloquear una segunda creación incluso si falla el PDF o una acción posterior.
                    const idGuardado = Number(data.idOrden || data.id_orden_c || 0);
                    const campoId = this.querySelector('[name="id_orden_c"]');
                    if (campoId && idGuardado > 0) campoId.value = String(idGuardado);
                    const estadoCorreo = String(data.email_notice_level || '').toLowerCase();
                    const hayAvisoCorreo = Boolean(String(data.email_notice || '').trim());
                    const hayCorreoCliente = Boolean(
                        String(document.querySelector('[name="correo"]')?.value || '').trim()
                    );
                    const hayAvisoWhatsapp = Boolean(String(data.whatsapp_notice || '').trim());
                    const whatsappAplica = Boolean(data.whatsapp_applicable);
                    const hayTelefonoCliente = Boolean(
                        String(document.querySelector('[name="telefono"]')?.value || '').trim()
                    );
                    if ((hayAvisoCorreo && estadoCorreo !== 'info') || hayCorreoCliente) {
                        exactoMostrarEstadoGuardado('loading', 'Enviando correo, espere...');
                        await exactoEsperar(1500);
                    }
                    if (whatsappAplica && (hayAvisoWhatsapp || hayTelefonoCliente)) {
                        exactoMostrarEstadoGuardado('loading', 'Enviando plantilla de WhatsApp, espere...');
                        await exactoEsperar(800);
                    }
                    if (data.whatsapp_notification_id && hayAvisoWhatsapp && String(data.whatsapp_notice_level || '').toLowerCase() !== 'error') {
                        exactoMostrarEstadoGuardado('loading', 'Confirmando entrega de WhatsApp...');
                        try {
                            await exactoConfirmarEntregaWhatsapp(data);
                        } catch (waErr) {
                            console.warn('No se pudo confirmar entrega WhatsApp:', waErr);
                        }
                    }
                    const estadoWhatsapp = String(data.whatsapp_notice_level || '').toLowerCase();
                    const correoNoEnviado = data.email_notice && estadoCorreo === 'error';
                    const whatsappNoEnviado = data.whatsapp_notice && estadoWhatsapp === 'error';
                    const correoConfirmado = data.email_notice && estadoCorreo === 'confirmed';
                    const correoAceptado = data.email_notice && estadoCorreo === 'success';
                    const correoNoConfirmado = data.email_notice && estadoCorreo === 'warning';
                    const correoOpcionalSinEnviar = data.email_notice && estadoCorreo === 'info';
                    const whatsappAceptado = data.whatsapp_notice && estadoWhatsapp === 'success';
                    const avisoPartes = [data.email_notice];
                    if (data.whatsapp_notice) {
                        avisoPartes.push(data.whatsapp_notice);
                    }
                    const avisoGuardado = avisoPartes.filter(Boolean).join('\n\n');
                    if (correoNoEnviado || whatsappNoEnviado) {
                        exactoLiberarGuardado({
                            keepNotice: true,
                            type: 'error',
                            message: avisoGuardado || data.message,
                        });
                        requiereLiberarGuardado = false;
                    } else if (correoAceptado || whatsappAceptado || correoConfirmado || correoOpcionalSinEnviar) {
                        exactoLiberarGuardado({
                            keepNotice: true,
                            type: 'success',
                            message: avisoGuardado || data.message,
                        });
                        requiereLiberarGuardado = false;
                    } else if (correoNoConfirmado) {
                        exactoLiberarGuardado({
                            keepNotice: true,
                            type: 'info',
                            message: avisoGuardado || data.message,
                        });
                        requiereLiberarGuardado = false;
                    }
                    await exactoShowAlert(exactoResumenGuardado(data), {
                        title: exactoTituloGuardadoOrden(data),
                        icon: exactoIconoGuardadoOrden(data),
                    });
                    const idOrdenGuardada = Number(data.idOrden || data.id_orden_c || 0);
                    if (
                        salidaTemporalCapturada
                        && typeof salidaTemporalCapturada === 'object'
                        && idOrdenGuardada > 0
                    ) {
                        exactoMostrarEstadoGuardado('loading', 'Registrando salida temporal...');
                        await exactoEnviarSalidaTemporalCapturada(idOrdenGuardada, salidaTemporalCapturada);
                    }
                    // Limpiar formulario
                    document.getElementById('ordenForm').reset();
                    if (!window.EXACTO_ORDEN_FIRMAS_DESHABILITADAS) {
                        limpiarFirmaClienteInicial();
                        limpiarFirmaTecnicoInicial();
                        limpiarFirmaCliente();
                        limpiarFirmaTecnico();
                    }
                    exactoPermitirSalidaOrdenForm();
                    exactoBorrarBorradorOrdenLocal();
                    if (idOrdenGuardada > 0) {
                        exactoAbrirReportePdfOrden(idOrdenGuardada);
                    }
                    window.location.href = exactoUrlOrdenesIndex();
                } else if (data.processing || data.duplicate_submit) {
                    exactoLiberarGuardado({
                        keepNotice: true,
                        type: 'info',
                        message: data.message || 'La orden ya se está guardando. Espera a que termine el proceso actual.',
                    });
                    requiereLiberarGuardado = false;
                } else {
                    // Solo una respuesta de validación permite preparar un envío distinto.
                    if (response.status === 400 || response.status === 422) exactoGuardadoPendiente = null;
                    const mensajeError = String(data.message || '').trim()
                        || (data.email_notice_level === 'error' && data.email_notice ? data.email_notice : '')
                        || 'No se pudo guardar la orden. Revisa el aviso e intenta nuevamente.';
                    exactoLiberarGuardado({
                        keepNotice: true,
                        type: 'error',
                        message: mensajeError,
                    });
                    requiereLiberarGuardado = false;
                    const avisosError = [data.message];
                    if (data.email_notice) {
                        avisosError.push(data.email_notice);
                    }
                    if (data.whatsapp_notice) {
                        avisosError.push(data.whatsapp_notice);
                    }
                    await exactoShowAlert(avisosError.filter(Boolean).join('\n\n'), {
                        title: 'No se pudo guardar',
                        icon: 'error',
                    });
                    exactoMostrarBannerFirmasDeshabilitadasSiAplica();
                }
            } catch (error) {
                exactoLiberarGuardado({
                    keepNotice: true,
                    type: 'error',
                    message: 'No se pudo confirmar el guardado. Reintenta desde este formulario; se recuperará la orden si ya fue registrada.',
                });
                requiereLiberarGuardado = false;
                await exactoShowAlert('No se pudo confirmar el guardado. Verifica la conexión y reintenta desde este formulario para recuperar la misma orden.', {
                    title: 'Error al guardar',
                    icon: 'error',
                });
                console.error('Error:', error);
                exactoMostrarBannerFirmasDeshabilitadasSiAplica();
            } finally {
                if (requiereLiberarGuardado && exactoOrdenSubmitInFlight) {
                    exactoLiberarGuardado();
                }
            }
        });

        // Editar datos del cliente + Reenviar WhatsApp/correo (modo completar)
        (function () {
            const btnEditar = document.getElementById('btnEditarDatosCliente');
            const seccion = document.getElementById('seccionDatosCliente');
            if (btnEditar && seccion) {
                btnEditar.addEventListener('click', function () {
                    seccion.classList.remove('hidden');
                    seccion.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    const nombre = document.getElementById('nombreCliente');
                    if (nombre) {
                        try { nombre.focus(); } catch (e) {}
                    }
                });
            }

            const btnReenviar = document.getElementById('btnReenviarRecepcion');
            if (!btnReenviar) return;

            btnReenviar.addEventListener('click', async function () {
                const url = typeof window.EXACTO_REENVIAR_URL === 'string' ? window.EXACTO_REENVIAR_URL.trim() : '';
                if (!url) {
                    await exactoShowAlert('No se pudo determinar la orden a reenviar.', { title: 'Reenviar', icon: 'error' });
                    return;
                }

                const telEl = document.getElementById('telefono');
                if (telEl) {
                    telEl.value = String(telEl.value || '').replace(/\D/g, '').slice(0, 20);
                }
                const correoEl = document.getElementById('correo');
                if (correoEl) {
                    correoEl.value = String(correoEl.value || '').trim().toLowerCase();
                }

                const valorCampo = (sel) => {
                    const el = document.querySelector(sel);
                    return el ? String(el.value || '').trim() : '';
                };

                const formData = new FormData();
                formData.append('_token', String(window.EXACTO_CSRF_TOKEN || ''));
                formData.append('nombreCliente', valorCampo('[name="nombreCliente"]'));
                formData.append('telefono', valorCampo('[name="telefono"]'));
                formData.append('correo', valorCampo('[name="correo"]'));
                formData.append('direccion', valorCampo('[name="direccion"]'));
                formData.append('poblacion', valorCampo('[name="poblacion"]'));

                const textoOriginal = btnReenviar.innerHTML;
                btnReenviar.disabled = true;
                btnReenviar.innerHTML = '<i class="mr-2 fas fa-spinner fa-spin"></i>Reenviando...';
                exactoMostrarEstadoGuardado('loading', 'Reenviando WhatsApp y correo, espere...');

                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        body: formData,
                        credentials: 'same-origin',
                        headers: {
                            Accept: 'application/json',
                            'X-Requested-With': 'XMLHttpRequest',
                            'X-CSRF-TOKEN': String(window.EXACTO_CSRF_TOKEN || ''),
                        },
                    });
                    const raw = await response.text();
                    let data;
                    try {
                        data = raw.trim() === '' ? {} : JSON.parse(raw);
                    } catch (parseErr) {
                        await exactoShowAlert('El servidor devolvió una respuesta inválida al reenviar (HTTP ' + response.status + ').', {
                            title: 'No se pudo reenviar',
                            icon: 'error',
                        });
                        return;
                    }

                    if (!response.ok || data.success === false) {
                        const msgErr = String(data.message || '').trim() || 'No se pudo reenviar la orden.';
                        exactoMostrarEstadoGuardado('error', msgErr);
                        await exactoShowAlert(msgErr, { title: 'No se pudo reenviar', icon: 'error' });
                        return;
                    }

                    const avisos = [data.email_notice, data.whatsapp_notice].filter(Boolean).join('\n\n');
                    const icono = exactoIconoGuardadoOrden(data);
                    const titulo = icono === 'error' ? 'Reenvío con avisos' : 'Reenviado';
                    exactoMostrarEstadoGuardado(icono === 'error' ? 'error' : 'success', avisos || 'Reenvío realizado.');
                    await exactoShowAlert(avisos || 'Se reenvió la orden de servicio como Recepción.', {
                        title: titulo,
                        icon: icono,
                    });

                    // Volver al estado original: ocultar la seccion de datos del cliente.
                    if (seccion) {
                        seccion.classList.add('hidden');
                    }
                    exactoOcultarEstadoGuardado();
                } catch (error) {
                    await exactoShowAlert('No se pudo reenviar. Verifica la conexión e intenta de nuevo.', {
                        title: 'Error al reenviar',
                        icon: 'error',
                    });
                    console.error('reenviar_orden error:', error);
                } finally {
                    btnReenviar.disabled = false;
                    btnReenviar.innerHTML = textoOriginal;
                }
            });
        })();

        (function () {
            const btn = document.getElementById('btnVolverLlenarActivarFirmas');
            if (!btn) return;
            btn.addEventListener('click', function () {
                const form = document.getElementById('ordenForm');
                if (!form) return;

                const idOc = document.getElementById('id_orden_c');
                const idVal = idOc ? String(idOc.value || '') : '';
                const folioInp = document.querySelector('[name="folio"]');
                const folioVal = folioInp ? String(folioInp.value || '') : '';
                const feInp = document.querySelector('[name="fechaEntrada"]');
                const feVal = feInp ? String(feInp.value || '') : '';
                const estInp = document.getElementById('inputEstatus');
                const estVal = estInp ? String(estInp.value || '') : '';

                window.EXACTO_ORDEN_FIRMAS_DESHABILITADAS = false;
                const wrap = document.getElementById('wrapBannerFirmasDeshabilitadas');
                if (wrap) {
                    wrap.classList.add('hidden');
                    wrap.classList.remove('flex');
                }
                const wrapLink = document.getElementById('wrapLinkMostrarFirmas');
                if (wrapLink) wrapLink.classList.add('hidden');

                const elIni = document.getElementById('ordenSeccionFirmasIniciales');
                const elFin = document.getElementById('ordenSeccionFirmasEntrega');
                if (window.EXACTO_ORDEN_MODO_COMPLETAR) {
                    if (elIni) {
                        elIni.classList.add('hidden');
                        elIni.classList.add('orden-firmas-skip');
                    }
                    if (elFin) elFin.classList.remove('orden-firmas-skip');
                } else {
                    if (elIni) {
                        elIni.classList.remove('hidden');
                        elIni.classList.remove('orden-firmas-skip');
                    }
                    if (elFin) elFin.classList.remove('orden-firmas-skip');
                }

                form.reset();

                if (idOc && idVal !== '') idOc.value = idVal;
                if (folioInp && folioVal !== '') folioInp.value = folioVal;
                if (feInp && feVal !== '') feInp.value = feVal;
                if (estInp && estVal !== '') estInp.value = estVal;
                exactoSincronizarFirmasEntregaPorEstatus();

                if (feInp && idVal === '' && !feInp.readOnly) {
                    const ahora = new Date();
                    const offset = ahora.getTimezoneOffset() * 60000;
                    feInp.value = new Date(ahora - offset).toISOString().slice(0, 16);
                }

                const nombreCli = document.querySelector('[name="nombreCliente"]');
                if (nombreCli) nombreCli.dispatchEvent(new Event('input', { bubbles: true }));

                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        const ids = window.EXACTO_ORDEN_MODO_COMPLETAR
                            ? ['firmaCliente', 'firmaTecnico']
                            : ['firmaClienteInicial', 'firmaTecnicoInicial', 'firmaCliente', 'firmaTecnico'];
                        ids.forEach(function (cid) {
                            if (!document.getElementById(cid)) return;
                            if (!canvasContexts[cid]) {
                                inicializarFirma(cid);
                            } else if (cid === 'firmaClienteInicial') {
                                limpiarFirmaClienteInicial();
                            } else if (cid === 'firmaTecnicoInicial') {
                                limpiarFirmaTecnicoInicial();
                            } else if (cid === 'firmaCliente') {
                                limpiarFirmaCliente();
                            } else if (cid === 'firmaTecnico') {
                                limpiarFirmaTecnico();
                            }
                        });
                    });
                });
            });
        })();

    const input = document.getElementById("nombreCliente");
    const texto = document.getElementById("clienteTexto");
    const texto2 = document.getElementById("clienteTexto2");
    if (input && texto && texto2) {
      input.addEventListener("input", function () {
        texto.textContent = this.value || "Cliente";
        texto2.textContent = this.value || "Cliente";
      });
    }

    (function () {
      const tel = document.getElementById("telefono");
      if (!tel) return;
      tel.addEventListener("input", function () {
        this.value = String(this.value).replace(/\D/g, "").slice(0, 20);
      });
    })();
