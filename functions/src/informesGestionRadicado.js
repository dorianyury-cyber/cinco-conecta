// Pide el radicado oficial "IG-{año}-###" a Control de Contratos (repo/
// proyecto Firebase distinto, "cinco-sas") para un informe de gestión de
// este módulo, y lo guarda en el propio informe. Reutiliza el mismo puente
// HTTP + secreto compartido que ya existe para sincronizar "staff" hacia
// ese proyecto (ver sincronizarStaffOrdenesTrabajo.js) — el radicado en sí
// se genera y numera allá (misma numeración que usa el módulo "Informes"
// de Control de Contratos), no aquí, para que ambos sistemas nunca
// dupliquen ni salten un número.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

const CONECTA_SYNC_SECRET = defineSecret("CONECTA_SYNC_SECRET");
const DESTINO_URL = "https://us-central1-cinco-sas.cloudfunctions.net/emitirRadicadoInformeGestion";

const obtenerRadicadoInformeGestion = onCall({ enforceAppCheck: true, secrets: [CONECTA_SYNC_SECRET] }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Debes iniciar sesión.");

  const db = admin.firestore();
  const staffSnap = await db.collection("staff").doc(request.auth.uid).get();
  const perfil = staffSnap.exists ? staffSnap.data() : null;
  const tienePermiso = perfil?.rol === "admin" || (perfil?.permisos || []).includes("informesGestion");
  if (!perfil || !tienePermiso) {
    throw new HttpsError("permission-denied", "No tienes permiso para obtener el radicado de un informe de gestión.");
  }

  const informeId = String(request.data?.informeId || "").trim();
  if (!informeId) throw new HttpsError("invalid-argument", "Falta el informe.");

  const informeRef = db.collection("informesGestion").doc(informeId);
  const informeSnap = await informeRef.get();
  if (!informeSnap.exists) throw new HttpsError("not-found", "Ese informe no existe.");
  const informe = informeSnap.data();

  // Ya tiene un radicado obtenido por esta misma vía — se devuelve tal
  // cual en vez de pedir uno nuevo (pediría otro número del contador allá,
  // desperdiciando uno). Si el radicado se escribió a mano (sin
  // radicadoAsignadoEn), sí se permite pedir uno oficial para reemplazarlo.
  if (informe.radicado && informe.radicadoAsignadoEn) {
    return { radicado: informe.radicado, yaExistia: true };
  }

  const contratoCodigo = String(informe.contrato || "").trim();
  if (!contratoCodigo) {
    throw new HttpsError("failed-precondition", "Este informe no tiene un contrato asignado.");
  }

  const titulo = `Informe de gestión — ${informe.periodoLabel || contratoCodigo}`;
  const mes = informe.anio && informe.mes ? `${informe.anio}-${String(informe.mes).padStart(2, "0")}` : null;
  const url = `https://cinco-conecta.web.app/informes-gestion.html?id=${informeId}`;

  let data;
  try {
    const resp = await fetch(DESTINO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sync-secret": CONECTA_SYNC_SECRET.value() },
      body: JSON.stringify({ contratoCodigo, titulo, mes, informeId, url })
    });
    data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data?.error || `Control de Contratos respondió ${resp.status}.`);
  } catch (err) {
    throw new HttpsError("failed-precondition", err.message || "No se pudo obtener el radicado desde Control de Contratos.");
  }

  await informeRef.update({
    radicado: data.radicado,
    radicadoAsignadoEn: admin.firestore.FieldValue.serverTimestamp(),
    radicadoAsignadoPor: request.auth.uid
  });

  return { radicado: data.radicado, yaExistia: false };
});

module.exports = { obtenerRadicadoInformeGestion };
