const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extras, guardar } = require('./sincronizacion');
const uuid = '318cc36d-a96d-40b2-b168-6eb13e130adc';
const body = { muestra_id: uuid, fecha_hora: '2026-10-21T18:29:45Z', gps_valido: true };

function baseSimulada() {
    const filas = [];
    let errorForzado;
    return {
        filas,
        fallar(error) { errorForzado = error; },
        from(tabla) {
            assert.equal(tabla, 'mediciones');
            let nueva;
            const filtros = {};
            const consulta = {
                insert(datos) { nueva = datos[0]; return this; },
                select() { return this; },
                eq(campo, valor) { filtros[campo] = valor; return this; },
                async single() {
                    if (errorForzado) return { error: errorForzado };
                    if (nueva.muestra_id && filas.some(f => f.device_id === nueva.device_id && f.muestra_id === nueva.muestra_id))
                        return { error: { code: '23505' } };
                    const data = { id: filas.length + 1, ...nueva };
                    filas.push(data);
                    return { data, error: null };
                },
                async maybeSingle() {
                    return { data: filas.find(f => Object.entries(filtros).every(([k,v]) => f[k] === v)) ?? null, error: null };
                }
            };
            return consulta;
        }
    };
}

test('ESP32 conserva envios sin UUID ni fecha explicita', async () => {
    const campos = extras({});
    assert.equal('muestra_id' in campos, false);
    assert.equal('fecha_hora' in campos, false);
    assert.equal('recorrido_id' in campos, false);
    const db = baseSimulada();
    assert.equal((await guardar(db, { device_id: 'esp32', ...campos })).status, 201);
    assert.equal((await guardar(db, { device_id: 'esp32', ...campos })).status, 201);
    assert.equal(db.filas.length, 2);
});

test('valida UUID, fecha UTC real, ejes, recorrido y velocidad', () => {
    for (const cambios of [
        { muestra_id: 'incorrecto' }, { fecha_hora: undefined },
        { fecha_hora: '2026-02-30T00:00:00Z' },
        { fecha_hora: '2026-10-21T18:29:45' },
        { ax_ms2: Infinity }, { gx_grados_s: '1' },
        { velocidad_kmh: -1 }, { recorrido_id: 'incorrecto' }
    ]) assert.throws(() => extras({ ...body, ...cambios }));
    assert.throws(() => extras({ fecha_hora: body.fecha_hora }));
    assert.equal(extras(body).fecha_hora, '2026-10-21T18:29:45.000Z');
    assert.equal(extras(body).recorrido_id, null);
    assert.equal(extras({ ...body, gps_valido: false, velocidad_kmh: 30 }).velocidad_kmh, null);
});

test('reintentos simultaneos y posteriores conservan una sola fila', async () => {
    const db = baseSimulada();
    const muestra = { device_id: 'pi', valor: 9.8, ...extras(body) };
    const respuestas = await Promise.all([guardar(db, muestra), guardar(db, muestra)]);
    assert.deepEqual(respuestas.map(r => r.status).sort(), [200, 201]);
    assert.equal((await guardar(db, muestra)).duplicada, true);
    assert.equal(db.filas.length, 1);
    assert.equal(db.filas[0].fecha_hora, '2026-10-21T18:29:45.000Z');
    assert.equal(db.filas[0].recorrido_id, null);
});

test('UUID repetido con contenido diferente devuelve conflicto sin sobrescribir', async () => {
    const db = baseSimulada();
    const muestra = { device_id: 'pi', valor: 9.8, ...extras(body) };
    await guardar(db, muestra);
    assert.equal((await guardar(db, { ...muestra, valor: 15 })).status, 409);
    assert.equal(db.filas[0].valor, 9.8);
    assert.equal((await guardar(db, { ...muestra, device_id: 'otra-pi' })).status, 201);
});

test('fallos de base y otras violaciones UNIQUE no confirman guardado', async () => {
    const db = baseSimulada();
    db.fallar({ code: '08006' });
    await assert.rejects(guardar(db, { device_id: 'pi', ...extras(body) }));
    db.fallar({ code: '23505' });
    await assert.rejects(guardar(db, { device_id: 'pi', ...extras(body) }));
});

test('redondeo float8 observado no bloquea reintento; cambios reales siguen en conflicto', async () => {
    const db = baseSimulada();
    const muestra = { device_id: 'pi', valor: 9.81, ...extras({ ...body,
        ax_ms2: -1.9871873779296874, gx_grados_s: 0.18361832061068703,
        gy_grados_s: -0.009160305343502984, gz_grados_s: -0.11581679389312932,
        velocidad_kmh: 0.8019160000000001 }), satelites: 10 };
    await guardar(db, muestra);
    Object.assign(db.filas[0], { ax_ms2: -1.98718737792969,
        gx_grados_s: 0.183618320610687, gy_grados_s: -0.00916030534350298,
        gz_grados_s: -0.115816793893129, velocidad_kmh: 0.801916 });
    assert.equal((await guardar(db, muestra)).status, 200);
    assert.equal(db.filas.length, 1);
    for (const cambios of [{ ax_ms2: -1.98718 }, { velocidad_kmh: 0.802 },
        { satelites: 11 }, { fecha_hora: '2026-10-21T18:29:46.000Z' }, { source: 'otro' }]) {
        assert.equal((await guardar(db, { ...muestra, ...cambios })).status, 409);
    }
});
