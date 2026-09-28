// api/index.js
// Punto de entrada serverless para Vercel.
//
// Vercel trata cualquier archivo bajo /api como una funcion Node.js
// independiente. Exportamos directamente la app de Express (crearApp, ver
// src/server.js) porque Express expone la misma firma (req, res) que Vercel
// espera de un handler — no hace falta ningun wrapper.
//
// La conexion a Turso y la inicializacion de Cloudinary se hacen UNA vez, a
// nivel de modulo, cuando arranca una instancia de la funcion (cold start).
// Instancias "calientes" (requests siguientes a la misma instancia) reusan
// la misma conexion sin recrearla. Esto es lo mismo fail-fast que
// src/server.js::main(): si faltan las variables de entorno de Turso o
// Cloudinary, esto lanza en el cold start y Vercel lo reporta como error de
// la funcion en sus logs — no hay fallback silencioso a disco local (no
// funcionaria en este entorno de todos modos).
//
// vercel.json enruta TODO (/, /admin, /api/*, /css/*, /js/*) hacia esta
// funcion via rewrites, y le indica a Vercel que empaquete src/** junto con
// la funcion: sin eso, las vistas EJS (res.render, leidas de disco en
// runtime) y los estaticos de src/public/ (express.static, idem) no
// estarian presentes en el filesystem de la funcion desplegada, aunque el
// codigo que los usa si se incluya (Vercel solo rastrea automaticamente lo
// que se importa con require/import, no los archivos leidos en runtime).

const { crearApp } = require('../src/server');
const { crearConexionPorDefecto } = require('../src/db/db');
const cloudinaryService = require('../src/services/cloudinaryService');

const dbConexion = crearConexionPorDefecto();
cloudinaryService.inicializar();

module.exports = crearApp(dbConexion);
