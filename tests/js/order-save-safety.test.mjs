import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../public/legacy/assets/js/orden_servicio.js', import.meta.url), 'utf8');
function extract(name) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    const end = source.indexOf('\n        }', start);
    assert.ok(end > start, name);
    return source.slice(start, end + '\n        }'.length);
}

function fixture() {
    const inputs = [];
    const elements = new Map();
    const add = (element) => {
        inputs.push(element);
        if (element.id) elements.set(element.id, element);
    };
    const box = { appendChild: add, set innerHTML(_) {
        for (let i = inputs.length - 1; i >= 0; i--) {
            if (inputs[i].dataset?.sersop01Auto === '1') inputs.splice(i, 1);
        }
    } };
    const form = { appendChild: add };
    elements.set('ordenForm', form);
    elements.set('exactoSersop01Campos', box);
    for (const name of ['total', 'saldoPendiente', 'ivaTotal', 'subtotalCombinado']) {
        elements.set(name, { textContent: '0', closest: () => null });
    }
    let prompts = 0;
    const context = vm.createContext({
        console,
        document: {
            getElementById: (id) => elements.get(id) || null,
            createElement: () => ({ dataset: {} }),
            querySelector: () => inputs.find((input) => input.dataset?.sersop01Auto === '1') || null,
            querySelectorAll: (selector) => inputs.filter((input) =>
                input.name?.startsWith('trabajos[') && (!selector.includes('[importe]') || input.name.endsWith('[importe]'))),
        },
        exactoEsOrdenNueva: () => true,
        exactoFormularioYaTieneSersop01Visible: () => false,
        exactoGetServicioSersop01: () => ({ precio: 603.45, descripcion: 'REVISIÓN' }),
        exactoShowConfirm: async () => { prompts++; return true; },
        exactoShowPrompt: async () => 'MF11634',
        exactoSubtotalMaterialesActual: () => 0,
        calcularTotalAnticipos: () => 0,
        exactoSaldoPendienteActual: () => Number(elements.get('saldoPendiente').textContent),
    });
    vm.runInContext(source.slice(source.indexOf('const EXACTO_IVA_RATE'), source.indexOf('/** Materiales')), context);
    vm.runInContext('let exactoSersop01AbonoAplicado = 0;', context);
    for (const name of ['exactoQuitarSersop01Oculto', 'exactoSiguienteIndiceTrabajos',
        'exactoAsegurarCamposAbonoNuevaOrden', 'exactoAgregarSersop01Oculto',
        'exactoConfirmarCobroSersop01RevisionNueva', 'exactoTotalTrabajosSinIva',
        'exactoTotalAbonoSaldo', 'exactoSetAbonoSaldo', 'calcularTotalFactura', 'calcularSaldoPendiente']) {
        vm.runInContext(extract(name), context);
    }
    return { context, elements, inputs, prompts: () => prompts };
}

test('reception counts hidden review and retries keep one charge and one payment', async () => {
    const f = fixture();
    assert.equal(await f.context.exactoConfirmarCobroSersop01RevisionNueva(), true);
    assert.equal(f.elements.get('total').textContent, '700.00');
    assert.equal(f.elements.get('saldoPendiente').textContent, '0.00');
    assert.equal(f.elements.get('abonoSaldoAplicado').value, '603.45');
    for (let i = 0; i < 3; i++) await f.context.exactoConfirmarCobroSersop01RevisionNueva();
    assert.equal(f.prompts(), 1);
    assert.equal(f.inputs.filter((input) => input.name?.endsWith('[importe]')).length, 1);
    assert.equal(f.elements.get('abonoSaldoAplicado').value, '603.45');
    assert.equal(f.elements.get('saldoPendiente').textContent, '0.00');
});

test('removing automatic review removes its payment while preserving other money', async () => {
    const f = fixture();
    f.context.exactoAsegurarCamposAbonoNuevaOrden();
    f.context.exactoSetAbonoSaldo(100);
    await f.context.exactoConfirmarCobroSersop01RevisionNueva();
    f.context.exactoQuitarSersop01Oculto();
    assert.equal(f.elements.get('abonoSaldoAplicado').value, '100.00');
    assert.equal(f.inputs.filter((input) => input.name?.endsWith('[importe]')).length, 0);
});

test('double click prepares once and lost response retries identical payload', async () => {
    let submit;
    let resolvePreparation;
    let preparations = 0;
    const bodies = [];
    const original = { formData: { intent: 'same-order', paid: 603.45 }, salidaTemporalCapturada: null };
    const context = vm.createContext({
        console: { error() {} },
        document: { getElementById: () => ({ addEventListener: (_, handler) => { submit = handler; } }) },
        exactoPrepararGuardadoOrden: () => {
            preparations++;
            return new Promise((resolve) => { resolvePreparation = resolve; });
        },
        exactoUrlApiRegistrar: () => '/api/ordenes/registrar',
        fetch: async (_, options) => { bodies.push(options.body); throw new Error('Lost response'); },
        exactoShowAlert: async () => {},
        exactoMostrarBannerFirmasDeshabilitadasSiAplica: () => {},
        exactoMarcarGuardadoEnCurso: () => vm.runInContext('exactoOrdenSubmitInFlight = true', context),
        exactoLiberarGuardado: () => vm.runInContext('exactoOrdenSubmitInFlight = false', context),
    });
    vm.runInContext('let exactoOrdenSubmitPreparing = false; let exactoOrdenSubmitInFlight = false; let exactoGuardadoPendiente = null;', context);
    const start = source.indexOf("document.getElementById('ordenForm').addEventListener('submit', async function(e) {");
    const end = source.indexOf('\n        });', start);
    vm.runInContext(source.slice(start, end + '\n        });'.length), context);
    const event = { preventDefault() {} };
    const first = submit.call({}, event);
    await submit.call({}, event);
    assert.equal(preparations, 1);
    resolvePreparation(original);
    await first;
    await submit.call({}, event);
    assert.equal(preparations, 1);
    assert.equal(bodies.length, 2);
    assert.strictEqual(bodies[0], original.formData);
    assert.strictEqual(bodies[1], original.formData);
});
