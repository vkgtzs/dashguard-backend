require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { extras, guardar } = require("./sincronizacion");
const { autenticar, montar } = require('./dashcam');

const app = express();
const PORT = process.env.PORT || 3000;

// ================================
// SUPABASE
// ================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("ERROR: Faltan las variables de Supabase");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ================================
// MIDDLEWARE
// ================================

app.use(cors({origin(origin,callback) {
    if (!origin) return callback(null,true);
    try { const u=new URL(origin); return callback(null,['localhost','127.0.0.1'].includes(u.hostname)); }
    catch { return callback(null,false); }
}}));
app.use(express.json({limit:'2mb'}));

// ================================
// RUTA DE PRUEBA
// ================================

app.get("/", (req, res) => {
    res.json({
        mensaje: "Backend de DashGuard funcionando", version: 'dashcam-offline-v1'
    });
});
app.use(autenticar(process.env));
montar(app,supabase);

// ================================
// POST /mediciones
// ================================

app.post("/mediciones", async (req, res) => {
    try {
        if (
            !req.body ||
            typeof req.body !== "object" ||
            Array.isArray(req.body)
        ) {
            return res.status(400).json({
                error: "Se esperaba un objeto JSON"
            });
        }

        const {
            device_id,
            variable,
            valor,
            unidad,
            source,
            gps_valido = false,
            latitud,
            longitud,
            satelites,
            hdop
        } = req.body;

        // Validar los campos de texto obligatorios
        if (
            typeof device_id !== "string" ||
            !device_id.trim() ||
            typeof variable !== "string" ||
            !variable.trim() ||
            typeof unidad !== "string" ||
            !unidad.trim()
        ) {
            return res.status(400).json({
                error: "device_id, variable y unidad deben ser textos no vacios"
            });
        }

        if (
            typeof valor !== "number" ||
            !Number.isFinite(valor)
        ) {
            return res.status(400).json({
                error: "El valor debe ser un numero finito"
            });
        }

        if (
            source !== undefined &&
            source !== null &&
            typeof source !== "string"
        ) {
            return res.status(400).json({
                error: "source debe ser texto o null"
            });
        }

        if (typeof gps_valido !== "boolean") {
            return res.status(400).json({
                error: "gps_valido debe ser true o false"
            });
        }

        // Validar ubicacion solamente cuando hay GPS valido
        if (gps_valido) {
            if (
                typeof latitud !== "number" ||
                !Number.isFinite(latitud) ||
                latitud < -90 ||
                latitud > 90
            ) {
                return res.status(400).json({
                    error: "Latitud invalida: debe estar entre -90 y 90"
                });
            }

            if (
                typeof longitud !== "number" ||
                !Number.isFinite(longitud) ||
                longitud < -180 ||
                longitud > 180
            ) {
                return res.status(400).json({
                    error: "Longitud invalida: debe estar entre -180 y 180"
                });
            }

            if (
                !Number.isInteger(satelites) ||
                satelites < 1 ||
                satelites > 99
            ) {
                return res.status(400).json({
                    error: "satelites debe ser un entero entre 1 y 99"
                });
            }

            if (
                typeof hdop !== "number" ||
                !Number.isFinite(hdop) ||
                hdop < 0
            ) {
                return res.status(400).json({
                    error: "hdop debe ser un numero finito mayor o igual a 0"
                });
            }
        }

        let camposNuevos;
        try {
            camposNuevos = extras(req.body);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        const nuevaMedicion = {
            ...camposNuevos,
            device_id: device_id.trim(),
            variable: variable.trim(),
            valor,
            unidad: unidad.trim(),
            source: source || null,

            gps_valido,
            latitud: gps_valido ? latitud : null,
            longitud: gps_valido ? longitud : null,
            satelites: gps_valido ? satelites : null,
            hdop: gps_valido ? hdop : null
        };

        const resultado = await guardar(supabase, nuevaMedicion);
        if (resultado.conflicto) {
            return res.status(409).json({
                error: "El UUID ya existe con datos distintos; no se modifico la muestra"
            });
        }
        return res.status(resultado.status).json({
            mensaje: resultado.duplicada ? "Medicion ya registrada" : "Medicion registrada correctamente",
            duplicada: resultado.duplicada,
            medicion: resultado.data
        });

    } catch (error) {
        console.error("Error inesperado:", error);

        if (error.code === '23514' || error.code === '23503') {
            return res.status(422).json({ error: "La medicion no cumple las restricciones de datos o recorrido" });
        }

        return res.status(500).json({
            error: "Error interno del servidor"
        });
    }
});

// ================================
// GET /mediciones
// Incluye los campos GPS
// ================================

app.get("/mediciones", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("mediciones")
            .select("*")
            .order("id", { ascending: true });

        if (error) {
            console.error("Error de Supabase:", error);

            return res.status(500).json({
                error: "No se pudieron consultar las mediciones"
            });
        }

        return res.json({
            mediciones: data
        });

    } catch (error) {
        console.error("Error inesperado:", error);

        return res.status(500).json({
            error: "Error interno del servidor"
        });
    }
});

// ================================
// INICIAR SERVIDOR
// ================================


// Recorridos controlados con los botones del ESP32.
app.post('/recorridos/:accion', async (req, res) => {
    const b = req.body;
    const accion = req.params.accion;
    if (!['iniciar', 'finalizar'].includes(accion)) return res.status(404).json({error:'Accion desconocida'});
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!b || Array.isArray(b) || typeof b.device_id !== 'string' ||
        !b.device_id.trim() || b.device_id.length > 100 ||
        typeof b.request_id !== 'string' || !uuid.test(b.request_id) ||
        b.gps_valido !== true || typeof b.latitud !== 'number' || !Number.isFinite(b.latitud) ||
        b.latitud < -90 || b.latitud > 90 || typeof b.longitud !== 'number' ||
        !Number.isFinite(b.longitud) || b.longitud < -180 || b.longitud > 180 ||
        !Number.isInteger(b.edad_ms) || b.edad_ms < 0 || b.edad_ms > 2147483647) {
        return res.status(400).json({error:'Solicitud de recorrido invalida'});
    }
    try {
        const {data, error} = await supabase.rpc('dashguard_comando_recorrido', {
            p_request_id:b.request_id, p_device_id:b.device_id.trim(), p_accion:accion,
            p_latitud:b.latitud, p_longitud:b.longitud, p_edad_ms:b.edad_ms
        });
        if (error) { console.error(error); return res.status(500).json({error:'No se pudo guardar el recorrido'}); }
        if (!data || !Number.isInteger(data.status)) throw new Error('Respuesta RPC invalida');
        return res.status(data.status).json(data);
    } catch (error) { console.error(error); return res.status(500).json({error:'Error de recorridos'}); }
});
app.get('/recorridos', async (req, res) => {
    const device = req.query.device_id;
    if (typeof device !== 'string' || !device.trim() || device.length > 100)
        return res.status(400).json({error:'device_id requerido'});
    try {
        const {data,error} = await supabase.from('recorridos').select('*')
            .eq('device_id',device.trim()).order('inicio_fecha',{ascending:false}).limit(100);
        if (error) throw error;
        return res.json({recorridos:data});
    } catch (error) { console.error(error); return res.status(500).json({error:'No se pudieron consultar recorridos'}); }
});

if (require.main === module) app.listen(PORT, () => {
    console.log("-----------------------------------");
    console.log("DashGuard Backend");
    console.log(`Servidor ejecutandose en puerto ${PORT}`);
    console.log(`http://localhost:${PORT}`);
    console.log("Base de datos: Supabase PostgreSQL");
    console.log("-----------------------------------");
});
module.exports = app;
