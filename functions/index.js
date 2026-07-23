const admin = require("firebase-admin");
admin.initializeApp();

const { enviarPostulacion, consultarEstado } = require("./src/postulaciones");
const { onCandidatoEtapaCambiada } = require("./src/notificaciones");
const { obtenerArchivoBase64 } = require("./src/storage");
const {
  invitarEmpleado,
  cambiarEstadoEmpleado,
  cambiarRolEmpleado,
  renombrarEmpleado,
  actualizarDatosEmpleado,
  reenviarInvitacion,
  eliminarEmpleado,
  confirmarCambioPassword
} = require("./src/empleados");
const { responderEncuesta } = require("./src/encuestas");
const { reportarIncidente, subirDocumento } = require("./src/hseq");
const {
  subirPlantilla,
  actualizarCamposPlantilla,
  eliminarPlantilla,
  generarInformePlantilla,
  subirImagenInforme
} = require("./src/informes");

exports.enviarPostulacion = enviarPostulacion;
exports.consultarEstado = consultarEstado;
exports.onCandidatoEtapaCambiada = onCandidatoEtapaCambiada;
exports.obtenerArchivoBase64 = obtenerArchivoBase64;
exports.invitarEmpleado = invitarEmpleado;
exports.cambiarEstadoEmpleado = cambiarEstadoEmpleado;
exports.cambiarRolEmpleado = cambiarRolEmpleado;
exports.renombrarEmpleado = renombrarEmpleado;
exports.actualizarDatosEmpleado = actualizarDatosEmpleado;
exports.reenviarInvitacion = reenviarInvitacion;
exports.eliminarEmpleado = eliminarEmpleado;
exports.confirmarCambioPassword = confirmarCambioPassword;
exports.responderEncuesta = responderEncuesta;
exports.reportarIncidente = reportarIncidente;
exports.subirDocumento = subirDocumento;
exports.subirPlantilla = subirPlantilla;
exports.actualizarCamposPlantilla = actualizarCamposPlantilla;
exports.eliminarPlantilla = eliminarPlantilla;
exports.generarInformePlantilla = generarInformePlantilla;
exports.subirImagenInforme = subirImagenInforme;
