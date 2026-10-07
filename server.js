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
    console.error("ERROR: Faltan las variables de Supabase en .env");
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
// Recibe mediciones y las guarda
// en PostgreSQL
// ================================

app.post("/mediciones", async (req, res) => {

    try {

        const {
            device_id,
            variable,
            valor,
            unidad,
            source
        } = req.body;

        // Validar campos obligatorios
        if (
            !device_id ||
            !variable ||
            valor === undefined ||
            !unidad
        ) {
            return res.status(400).json({
                error: "Faltan campos obligatorios"
            });
        }

        // Validar que valor sea numérico
        if (typeof valor !== "number") {
            return res.status(400).json({
                error: "El valor debe ser numerico"
            });
        }

        const nuevaMedicion = {
            device_id: device_id,
            variable: variable,
            valor: valor,
            unidad: unidad,
            source: source || null
        };

        // Guardar en PostgreSQL
        const { data, error } = await supabase
            .from("mediciones")
            .insert([nuevaMedicion])
            .select();

        if (error) {
            console.error("Error de Supabase:", error);

            return res.status(500).json({
                error: "No se pudo guardar la medicion"
            });
        }

        console.log("Medicion guardada en PostgreSQL:");
        console.log(data[0]);

        return res.status(201).json({
            mensaje: "Medicion registrada correctamente",
            medicion: data[0]
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
// Consulta las mediciones guardadas
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