const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EJES = ['ax_ms2', 'ay_ms2', 'az_ms2', 'gx_grados_s', 'gy_grados_s', 'gz_grados_s'];
const DECIMALES = new Set([...EJES, 'valor', 'latitud', 'longitud', 'hdop', 'velocidad_kmh']);

function extras(body) {
    const sincronizada = body.muestra_id !== undefined && body.muestra_id !== null;
    const resultado = {};
    if (sincronizada) {
        if (typeof body.muestra_id !== 'string' || !UUID.test(body.muestra_id))
            throw new Error('muestra_id debe ser UUID');
        // Exigir zona horaria y una fecha de calendario real.
        const fecha = body.fecha_hora;
        const formato = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
        if (typeof fecha !== 'string' || !formato.test(fecha) || !Number.isFinite(Date.parse(fecha)))
            throw new Error('fecha_hora debe ser ISO UTC, por ejemplo 2026-10-21T18:29:45Z');
        const normalizada = new Date(fecha).toISOString();
        if (normalizada.slice(0, 19) !== fecha.slice(0, 19))
            throw new Error('fecha_hora contiene una fecha invalida');
        if (body.recorrido_id !== undefined && body.recorrido_id !== null &&
            (typeof body.recorrido_id !== 'string' || !UUID.test(body.recorrido_id)))
            throw new Error('recorrido_id debe ser UUID o null');
        resultado.muestra_id = body.muestra_id.toLowerCase();
        resultado.fecha_hora = normalizada;
        resultado.recorrido_id = body.recorrido_id?.toLowerCase() ?? null;
    } else if (body.fecha_hora !== undefined || body.recorrido_id !== undefined) {
        throw new Error('Para enviar fecha_hora o recorrido_id debes incluir muestra_id');
    }
    for (const campo of [...EJES, 'velocidad_kmh']) {
        const valor = body[campo];
        if (valor !== undefined && valor !== null &&
            (typeof valor !== 'number' || !Number.isFinite(valor)))
            throw new Error(`${campo} debe ser numero finito o null`);
        if (campo === 'velocidad_kmh' && valor != null && valor < 0)
            throw new Error('velocidad_kmh no puede ser negativa');
        resultado[campo] = valor ?? null;
    }
    if (body.gps_valido !== true) resultado.velocidad_kmh = null;
    return resultado;
}

async function guardar(supabase, medicion) {
    // INSERT y UNIQUE resuelven tambien reintentos simultaneos. Nunca sobrescribir.
    const insertada = await supabase.from('mediciones').insert([medicion]).select().single();
    if (!insertada.error) return { status: 201, data: insertada.data, duplicada: false };

    if (insertada.error.code === '23505' && medicion.muestra_id) {
        const existente = await supabase.from('mediciones').select('*')
            .eq('device_id', medicion.device_id).eq('muestra_id', medicion.muestra_id).maybeSingle();
        if (existente.error) throw existente.error;
        if (existente.data) {
            const coincide = Object.entries(medicion).every(([campo, valor]) => {
                const previo = existente.data[campo];
                if (campo === 'fecha_hora') return Date.parse(previo) === Date.parse(valor);
                // La representacion JSON de float8 puede perder ultimos decimales.
                // Solo tolerar redondeo minimo en mediciones, nunca en IDs o satelites.
                if (DECIMALES.has(campo) && Number.isFinite(previo) && Number.isFinite(valor)) {
                    return Math.abs(previo - valor) <= 1e-12 * Math.max(1, Math.abs(previo), Math.abs(valor));
                }
                return previo === valor;
            });
            if (!coincide) return { status: 409, conflicto: true };
            return { status: 200, data: existente.data, duplicada: true };
        }
    }
    throw insertada.error;
}

module.exports = { extras, guardar };
