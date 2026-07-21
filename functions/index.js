const admin = require("firebase-admin");
admin.initializeApp();

const { enviarPostulacion, consultarEstado } = require("./src/postulaciones");
const { onCandidatoEtapaCambiada } = require("./src/notificaciones");
const { obtenerArchivoBase64 } = require("./src/storage");

exports.enviarPostulacion = enviarPostulacion;
exports.consultarEstado = consultarEstado;
exports.onCandidatoEtapaCambiada = onCandidatoEtapaCambiada;
exports.obtenerArchivoBase64 = obtenerArchivoBase64;
