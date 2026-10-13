require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

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

app.use(cors());
app.use(express.json());

// ================================
// RUTA DE PRUEBA
// ================================

app.get("/", (req, res) => {
    res.json({
        mensaje: "Backend de DashGuard funcionando"
    });
});

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

        const nuevaMedicion = {
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

        const { data, error } = await supabase
            .from("mediciones")
            .insert([nuevaMedicion])
            .select()
            .single();

        if (error) {
            console.error("Error de Supabase:", error);

            return res.status(500).json({
                error: "No se pudo guardar la medicion"
            });
        }

        console.log("Medicion guardada en PostgreSQL:");
        console.log(data);

        return res.status(201).json({
            mensaje: "Medicion registrada correctamente",
            medicion: data
        });

    } catch (error) {
        console.error("Error inesperado:", error);

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

app.listen(PORT, () => {
    console.log("-----------------------------------");
    console.log("DashGuard Backend");
    console.log(`Servidor ejecutandose en puerto ${PORT}`);
    console.log(`http://localhost:${PORT}`);
    console.log("Base de datos: Supabase PostgreSQL");
    console.log("-----------------------------------");
});