const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.json());

// ==========================================
// CONFIGURACIÓN
// ==========================================

const PORT = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false
});

pool.query(`
SELECT
    current_database() AS bd,
    current_schema() AS esquema
`)
.then(r => console.log(r.rows));

pool.query(`
SELECT table_name
FROM information_schema.tables
WHERE table_schema='public'
`)
.then(r => console.log(r.rows));
// ==========================================
// VERIFICAR CONEXIÓN
// ==========================================

pool.connect()
    .then(() => {
        console.log("✅ PostgreSQL conectado");
    })
    .catch(err => {
        console.error("❌ Error PostgreSQL:", err.message);
    });

// ==========================================
// LOGIN
// ==========================================

app.post("/login", async (req, res) => {

    try {

        const { codigo, password } = req.body;

        if (!codigo || !password) {

            return res.status(400).json({
                ok: false,
                mensaje: "Código y contraseña son obligatorios"
            });

        }

        // Regla actual:
        // contraseña = código

        if (codigo !== password) {

            return res.json({
                ok: false,
                mensaje: "Credenciales incorrectas"
            });

        }

        // Consultar API UNDAC

        const respuesta = await axios.get(
            `http://api.undac.edu.pe/tasks/a3945a7384cbdcd33f49e8f5b8ec29f5/91f33e2776c526b9cca723a63476f028/${codigo}`,
            {
                timeout: 10000
            }
        );

        const alumno = respuesta.data;

        if (!alumno || !alumno.Nombres) {

            return res.json({
                ok: false,
                mensaje: "Alumno no encontrado"
            });

        }

        // Solo alumnos

        if (alumno.Rol !== "AL") {

            return res.json({
                ok: false,
                mensaje: "Solo los alumnos pueden iniciar sesión"
            });

        }

        const nombreCompleto = [
            alumno.Nombres,
            alumno["Apellido paterno"],
            alumno["Apellido materno"]
        ]
            .filter(Boolean)
            .join(" ");

        // Buscar usuario

        let usuario = await pool.query(
            "SELECT * FROM usuarios WHERE codigo = $1",
            [codigo]
        );

        // Crear automáticamente

        if (usuario.rows.length === 0) {

            usuario = await pool.query(
            `
            INSERT INTO usuarios
            (codigo, nombre, password)
            VALUES ($1,$2,$3)
            RETURNING *
            `,
            [
                codigo,
                nombreCompleto,
                codigo
            ]
            );

        } else {

            // Actualizar nombre si cambia

            usuario = await pool.query(
                `
                UPDATE usuarios
                SET nombre = $1
                WHERE codigo = $2
                RETURNING *
                `,
                [
                    nombreCompleto,
                    codigo
                ]
            );

        }

        return res.json({

            ok: true,

            usuario: {

                id: usuario.rows[0].id,
                codigo: usuario.rows[0].codigo,
                nombre: usuario.rows[0].nombre

            }

        });

    } catch (error) {

        console.error("ERROR LOGIN:", error.message);

        return res.status(500).json({

            ok: false,
            mensaje: "Error al iniciar sesión"

        });

    }

});

// ==========================================
// INICIAR SESIÓN
// ==========================================

app.post("/iniciar", async (req, res) => {
  console.log("================================");
console.log("SE LLAMÓ AL ENDPOINT /iniciar");
console.log(req.body);
console.log("================================");

    try {

        const { usuario_id, pc_id } = req.body;

        if (!usuario_id || !pc_id) {

            return res.status(400).json({
                ok: false,
                mensaje: "Datos incompletos"
            });

        }

        // Verificar sesión activa

        const sesionActiva = await pool.query(
            `
            SELECT *
            FROM sesiones
            WHERE pc_id = $1
            AND hora_fin IS NULL
            `,
            [pc_id]
        );

        if (sesionActiva.rows.length > 0) {

            return res.json({
                ok: false,
                mensaje: "La PC ya tiene una sesión activa"
            });

        }

        // Obtener los datos del usuario
const usuario = await pool.query(
    `
    SELECT codigo, nombre
    FROM usuarios
    WHERE id = $1
    `,
    [usuario_id]
);

if (usuario.rows.length === 0) {
    return res.json({
        ok: false,
        mensaje: "Usuario no existe"
    });
}

// Registrar sesión
await pool.query(
    `
    INSERT INTO sesiones
    (codigo, nombre, pc_id, hora_inicio)
    VALUES ($1, $2, $3, NOW())
    `,
    [
        usuario.rows[0].codigo,
        usuario.rows[0].nombre,
        pc_id
    ]
);

        await pool.query(
            `
            UPDATE pcs
            SET estado='libre'
            WHERE id=$1
            `,
            [pc_id]
        );

        res.json({
            ok: true,
            mensaje: "Sesión iniciada"
        });

    } catch (error) {

        console.error("ERROR INICIAR:", error.message);

        res.status(500).json({
            ok: false
        });

    }

});

// ==========================================
// FINALIZAR SESIÓN
// ==========================================

app.post("/finalizar", async (req, res) => {

    try {

        const { pc_id } = req.body;

        await pool.query(
            `
            UPDATE sesiones
            SET hora_fin = NOW()
            WHERE pc_id = $1
            AND hora_fin IS NULL
            `,
            [pc_id]
        );

        await pool.query(
            `
            UPDATE pcs
            SET estado = 'bloqueada'
            WHERE id = $1
            `,
            [pc_id]
        );

        res.json({
            ok: true,
            mensaje: "Sesión finalizada"
        });

    } catch (error) {

        console.error("ERROR FINALIZAR:", error.message);

        res.status(500).json({
            ok: false
        });

    }

});

// ==========================================
// LISTA DE PCS
// ==========================================

app.get("/pcs", async (req, res) => {

    try {

        const resultado = await pool.query(
            "SELECT * FROM pcs ORDER BY id"
        );

        res.json(resultado.rows);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            ok: false
        });

    }

});

// ==========================================
// HISTORIAL DE SESIONES
// ==========================================

app.get("/sesiones", async (req, res) => {

    try {

        const resultado = await pool.query(
            `
            SELECT
    s.id,
    s.codigo,
    s.nombre,
    p.nombre AS pc,
    TO_CHAR(s.hora_inicio,'HH24:MI:SS') AS hora_inicio,
    TO_CHAR(s.hora_fin,'HH24:MI:SS') AS hora_fin
    FROM sesiones s
    INNER JOIN pcs p
    ON p.id=s.pc_id
    ORDER BY s.id DESC
            `
        );

        res.json(resultado.rows);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            ok: false
        });

    }

});

// ==========================================
// ESTADO DEL SERVIDOR
// ==========================================

app.get("/", (req, res) => {

    res.json({
        ok: true,
        mensaje: "Backend Lab funcionando"
    });

});
// ==========================================
// INICIAR SERVIDOR
// ==========================================
app.get("/healthz", (req, res) => {
    res.status(200).send("OK");
});

app.listen(PORT, () => {

    console.log("");
    console.log("=================================");
    console.log("🚀 Backend Lab iniciado");
    console.log(`🌐 Puerto: ${PORT}`);
    console.log("=================================");
    console.log("");

});