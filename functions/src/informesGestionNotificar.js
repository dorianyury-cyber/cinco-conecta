const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { enviarAsignacionInformeGestion } = require("./email");

// Notifica en un solo clic a TODOS los responsables de un informe de
// gestión — un correo por persona (no uno por estrategia), agrupando ahí
// todas las secciones que tiene asignadas, junto con la fecha límite. Guarda
// esa fecha límite en el informe y deja registro de cuándo/quién notificó,
// para que el botón sirva también como "ya avisé a todos" verificable.
const notificarResponsablesInformeGestion = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const db = admin.firestore();
  const staffSnap = await db.collection("staff").doc(request.auth.uid).get();
  const perfil = staffSnap.exists ? staffSnap.data() : null;
  const tienePermiso = perfil?.rol === "admin" || (perfil?.permisos || []).includes("informesGestion");
  if (!perfil || !tienePermiso) {
    throw new HttpsError("permission-denied", "No tienes permiso para notificar responsables de informes de gestión.");
  }

  const informeId = String(request.data?.informeId || "").trim();
  const fechaLimite = String(request.data?.fechaLimite || "").trim();
  if (!informeId) throw new HttpsError("invalid-argument", "Falta el informe.");
  if (!fechaLimite || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(fechaLimite)) {
    throw new HttpsError("invalid-argument", "La fecha y hora límite son obligatorias.");
  }

  const informeRef = db.collection("informesGestion").doc(informeId);
  const informeSnap = await informeRef.get();
  if (!informeSnap.exists) throw new HttpsError("not-found", "Ese informe no existe.");
  const informe = informeSnap.data();

  const estrategiasSnap = await informeRef.collection("estrategias").get();
  const estrategias = estrategiasSnap.docs.map((d) => d.data());

  // Agrupa por uid de responsable: cada persona recibe UN correo con todas
  // sus secciones, no uno por cada estrategia/zona que tenga asignada.
  const seccionesPorUid = new Map();
  estrategias.forEach((e) => {
    if (!e.responsables || !e.responsables.length) return; // encabezados de zonas (ej. "Brigadas") no tienen responsable propio
    e.responsables.forEach((uid) => {
      if (!seccionesPorUid.has(uid)) seccionesPorUid.set(uid, []);
      seccionesPorUid.get(uid).push(e.nombre);
    });
  });

  if (seccionesPorUid.size === 0) {
    throw new HttpsError("failed-precondition", "Este informe todavía no tiene estrategias con responsable asignado.");
  }

  // Modo prueba: solo envía UN correo (con el contenido real de la primera
  // persona con secciones asignadas) a la cuenta del coordinador, en vez de
  // mandarle a cada responsable real — para revisar cómo se ve antes de
  // notificar a todos. No guarda fechaLimite ni marca el informe como
  // notificado, porque no fue una notificación real.
  const modoPrueba = request.data?.modoPrueba === true;
  const url = `https://cinco-conecta.web.app/informes-gestion.html?id=${informeId}`;

  if (modoPrueba) {
    const [uidPrueba, seccionesPrueba] = seccionesPorUid.entries().next().value;
    const empleadoSnap = await db.collection("staff").doc(uidPrueba).get();
    const empleado = empleadoSnap.exists ? empleadoSnap.data() : null;
    await enviarAsignacionInformeGestion({
      nombre: empleado?.nombre || "Responsable",
      correo: "gerencia.cincoltda@hotmail.com",
      contrato: informe.contrato,
      periodoLabel: informe.periodoLabel,
      secciones: seccionesPrueba,
      fechaLimite,
      url
    });
    return { ok: true, prueba: true, enviados: ["gerencia.cincoltda@hotmail.com"], sinCorreo: [] };
  }

  const enviados = [];
  const sinCorreo = [];
  for (const [uid, secciones] of seccionesPorUid.entries()) {
    const empleadoSnap = await db.collection("staff").doc(uid).get();
    const empleado = empleadoSnap.exists ? empleadoSnap.data() : null;
    if (!empleado || !empleado.correo) { sinCorreo.push(empleado?.nombre || uid); continue; }
    await enviarAsignacionInformeGestion({
      nombre: empleado.nombre || empleado.correo,
      correo: empleado.correo,
      contrato: informe.contrato,
      periodoLabel: informe.periodoLabel,
      secciones,
      fechaLimite,
      url
    });
    enviados.push(empleado.nombre || empleado.correo);
  }

  const nombreQuienEjecuta = perfil.nombre || request.auth.token?.email || "Coordinador";
  await informeRef.update({
    fechaLimite,
    notificadoEn: admin.firestore.FieldValue.serverTimestamp(),
    notificadoPor: request.auth.uid,
    notificadoPorNombre: nombreQuienEjecuta
  });

  return { ok: true, prueba: false, enviados, sinCorreo };
});

module.exports = { notificarResponsablesInformeGestion };
