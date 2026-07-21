const admin = require("firebase-admin");
admin.initializeApp();

const { enviarPostulacion, consultarEstado } = require("./src/postulaciones");
const { onCandidatoEtapaCambiada } = require("./src/notificaciones");
const { obtenerArchivoBase64 } = require("./src/storage");
const { invitarEmpleado } = require("./src/empleados");
const { responderEncuesta } = require("./src/encuestas");

exports.enviarPostulacion = enviarPostulacion;
exports.consultarEstado = consultarEstado;
exports.onCandidatoEtapaCambiada = onCandidatoEtapaCambiada;
exports.obtenerArchivoBase64 = obtenerArchivoBase64;
exports.invitarEmpleado = invitarEmpleado;
exports.responderEncuesta = responderEncuesta;
