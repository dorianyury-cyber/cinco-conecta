const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { enviarNotificacionEncuesta } = require("./email");

// Notifica en un solo clic a todo el personal activo de que hay una encuesta
// esperando su respuesta — mismo patrón que
// notificarResponsablesInformeGestion (informesGestionNotificar.js): un
// correo por persona, con enlace directo, y deja registro de cuándo/quién
// notificó para que el botón sirva también como "ya avisé a todos"
// verificable. A diferencia de los informes, aquí el destinatario es TODO
// el personal activo (con correo) — cualquiera puede responder una
// encuesta, no solo quien tenga una sección asignada.
const notificarEncuesta = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const db = admin.firestore();
  const staffSnap = await db.collection("staff").doc(request.auth.uid).get();
  const perfil = staffSnap.exists ? staffSnap.data() : null;
  const tienePermiso = perfil?.rol === "admin" || (perfil?.permisos || []).includes("encuestas");
  if (!perfil || !tienePermiso) {
    throw new HttpsError("permission-denied", "No tienes permiso para notificar una encuesta.");
  }

  const encuestaId = String(request.data?.encuestaId || "").trim();
  if (!encuestaId) throw new HttpsError("invalid-argument", "Falta la encuesta.");

  const encuestaRef = db.collection("encuestas").doc(encuestaId);
  const encuestaSnap = await encuestaRef.get();
  if (!encuestaSnap.exists) throw new HttpsError("not-found", "Esa encuesta no existe.");
  const encuesta = encuestaSnap.data();
  if (encuesta.estado !== "activa") {
    throw new HttpsError("failed-precondition", "Esta encuesta ya no está activa.");
  }

  const url = "https://cinco-conecta.web.app/encuestas.html";
  const modoPrueba = request.data?.modoPrueba === true;

  // Modo prueba: un solo correo (con el contenido real) a la cuenta de
  // gerencia, en vez de a todo el personal — para revisar cómo se ve antes
  // de notificar a todos. No marca la encuesta como notificada.
  if (modoPrueba) {
    await enviarNotificacionEncuesta({
      nombre: "equipo",
      correo: "gerencia.cincoltda@hotmail.com",
      titulo: encuesta.titulo,
      descripcion: encuesta.descripcion || "",
      url
    });
    return { ok: true, prueba: true, enviados: 1, sinCorreo: [] };
  }

  // Se incluye también a quien notifica (si está activo): así puede
  // verificar en su propio correo cómo le llegó a los demás.
  const staffActivoSnap = await db.collection("staff").where("estado", "==", "activo").get();
  const destinatarios = staffActivoSnap.docs.map((d) => d.data());

  const enviados = [];
  const sinCorreo = [];
  for (const empleado of destinatarios) {
    if (!empleado.correo) { sinCorreo.push(empleado.nombre || "(sin nombre)"); continue; }
    await enviarNotificacionEncuesta({
      nombre: empleado.nombre || empleado.correo,
      correo: empleado.correo,
      titulo: encuesta.titulo,
      descripcion: encuesta.descripcion || "",
      url
    });
    enviados.push(empleado.nombre || empleado.correo);
  }

  if (enviados.length === 0) {
    throw new HttpsError("failed-precondition", "No hay personal activo con correo registrado para notificar.");
  }

  const nombreQuienEjecuta = perfil.nombre || request.auth.token?.email || "Coordinador";
  await encuestaRef.update({
    notificadoEn: admin.firestore.FieldValue.serverTimestamp(),
    notificadoPor: request.auth.uid,
    notificadoPorNombre: nombreQuienEjecuta
  });

  return { ok: true, prueba: false, enviados, sinCorreo };
});

module.exports = { notificarEncuesta };
