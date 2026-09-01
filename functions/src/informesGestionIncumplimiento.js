const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { enviarIncumplimientoInformeGestion } = require("./email");

// Aviso de incumplimiento — disparo MANUAL (botón "Notificar
// incumplimientos" en informes-gestion.js), a propósito: es un correo con
// peso disciplinario ("constancia de incumplimiento laboral"), así que el
// coordinador decide cuándo revisarlo y enviarlo en vez de que salga solo
// con una función programada. Envía un correo por persona (agrupando todas
// sus secciones pendientes) a quien todavía tenga alguna sección sin
// completar después de vencida la fecha límite, con copia a RRHH/gerencia,
// y deja registrado en cada estrategia cuándo y quién lo notificó.
const notificarIncumplimientosInformeGestion = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const db = admin.firestore();
  const staffSnap = await db.collection("staff").doc(request.auth.uid).get();
  const perfil = staffSnap.exists ? staffSnap.data() : null;
  const tienePermiso = perfil?.rol === "admin" || (perfil?.permisos || []).includes("informesGestion");
  if (!perfil || !tienePermiso) {
    throw new HttpsError("permission-denied", "No tienes permiso para notificar incumplimientos de informes de gestión.");
  }

  const informeId = String(request.data?.informeId || "").trim();
  const modoPrueba = request.data?.modoPrueba === true;
  if (!informeId) throw new HttpsError("invalid-argument", "Falta el informe.");

  const informeRef = db.collection("informesGestion").doc(informeId);
  const informeSnap = await informeRef.get();
  if (!informeSnap.exists) throw new HttpsError("not-found", "Ese informe no existe.");
  const informe = informeSnap.data();

  // El modo prueba se deja pasar sin estas dos validaciones a propósito —
  // sirve para que el coordinador vea cómo queda el correo ANTES de que se
  // venza la fecha límite, no solo después.
  if (!modoPrueba) {
    if (!informe.fechaLimite) {
      throw new HttpsError("failed-precondition", 'Este informe todavía no tiene fecha límite — primero usa "Notificar a responsables".');
    }
    if (new Date(informe.fechaLimite).getTime() > Date.now()) {
      throw new HttpsError("failed-precondition", "La fecha límite todavía no se ha vencido.");
    }
  }

  const estrategiasSnap = await informeRef.collection("estrategias").get();
  // Agrupa por uid de responsable: cada persona recibe UN correo con todas
  // sus secciones pendientes, no uno por cada estrategia/zona.
  const pendientesPorUid = new Map();
  estrategiasSnap.docs.forEach((docSnap) => {
    const e = docSnap.data();
    if (!e.responsables || !e.responsables.length) return; // encabezados de zonas no tienen responsable propio
    if (!modoPrueba && e.estado === "completo") return;
    e.responsables.forEach((uid) => {
      if (!pendientesPorUid.has(uid)) pendientesPorUid.set(uid, []);
      pendientesPorUid.get(uid).push({ nombre: e.nombre, ref: docSnap.ref });
    });
  });

  if (!modoPrueba && pendientesPorUid.size === 0) {
    throw new HttpsError("failed-precondition", "No hay secciones pendientes en este informe — todas están completas.");
  }

  const url = `https://cinco-conecta.web.app/informes-gestion.html?id=${informeId}`;

  if (modoPrueba) {
    let nombrePrueba, seccionesPrueba;
    if (pendientesPorUid.size > 0) {
      const [uidPrueba, secciones] = pendientesPorUid.entries().next().value;
      const empleadoSnap = await db.collection("staff").doc(uidPrueba).get();
      nombrePrueba = (empleadoSnap.exists ? empleadoSnap.data().nombre : null) || "Responsable";
      seccionesPrueba = secciones.map((s) => s.nombre);
    } else {
      // Este informe no tiene ninguna sección pendiente ahora mismo — se
      // arma un ejemplo genérico para que el coordinador pueda ver el
      // diseño del correo de todos modos, sin esperar a que algo se venza.
      nombrePrueba = "Responsable de ejemplo";
      seccionesPrueba = ["Sección de ejemplo (este informe no tiene ninguna pendiente ahora mismo)"];
    }
    await enviarIncumplimientoInformeGestion({
      nombre: nombrePrueba,
      correo: "gerencia.cincoltda@hotmail.com",
      contrato: informe.contrato,
      periodoLabel: informe.periodoLabel,
      secciones: seccionesPrueba,
      fechaLimite: informe.fechaLimite || new Date().toISOString(),
      url
    });
    return { ok: true, prueba: true, enviados: ["gerencia.cincoltda@hotmail.com"], sinCorreo: [] };
  }

  const enviados = [];
  const sinCorreo = [];
  const ahora = admin.firestore.FieldValue.serverTimestamp();
  const nombreQuienEjecuta = perfil.nombre || request.auth.token?.email || "Coordinador";
  for (const [uid, secciones] of pendientesPorUid.entries()) {
    const empleadoSnap = await db.collection("staff").doc(uid).get();
    const empleado = empleadoSnap.exists ? empleadoSnap.data() : null;
    if (!empleado || !empleado.correo) { sinCorreo.push(empleado?.nombre || uid); continue; }
    await enviarIncumplimientoInformeGestion({
      nombre: empleado.nombre || empleado.correo,
      correo: empleado.correo,
      contrato: informe.contrato,
      periodoLabel: informe.periodoLabel,
      secciones: secciones.map((s) => s.nombre),
      fechaLimite: informe.fechaLimite,
      url
    });
    enviados.push(empleado.nombre || empleado.correo);
    await Promise.all(secciones.map((s) => s.ref.update({
      incumplimientoNotificadoEn: ahora,
      incumplimientoNotificadoPor: request.auth.uid,
      incumplimientoNotificadoPorNombre: nombreQuienEjecuta
    })));
  }

  return { ok: true, prueba: false, enviados, sinCorreo };
});

module.exports = { notificarIncumplimientosInformeGestion };
