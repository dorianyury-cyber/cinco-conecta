// Empuja el directorio "staff" de Cinco Conecta hacia Cinco SAS control
// (otro proyecto Firebase), para que esos empleados aparezcan como opción
// al asignar una Orden de Trabajo allá — ver la nota completa en
// cinco-sas/functions/src/recibirStaffConecta.js sobre por qué es un
// puente HTTP con secreto compartido y no una regla de Firestore abierta.
//
// Dos funciones:
// - onStaffWriteSyncOrdenesTrabajo: dispara sola en cada alta/edición/baja
//   de un empleado (trigger de Firestore), para que quede al día sin que
//   nadie tenga que acordarse de sincronizar.
// - backfillStaffOrdenesTrabajo: envío manual de TODO el directorio de una
//   sola vez (gatillado por HTTP con el mismo secreto, no desde la UI) —
//   hace falta una vez al principio, porque el trigger de arriba solo
//   sincroniza cambios A PARTIR de que se desplegó, no lo que ya existía.
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

const CONECTA_SYNC_SECRET = defineSecret("CONECTA_SYNC_SECRET");
// URL real de la función que recibe en Cinco SAS control — confirmada
// contra el resultado del deploy de recibirStaffConecta en ese proyecto
// (las funciones HTTP de firebase-functions v2 exponen esta misma forma
// de URL clásica, no solo la de Cloud Run).
const DESTINO_URL = "https://us-central1-cinco-sas.cloudfunctions.net/recibirStaffConecta";

async function enviarARegistroCincoSAS(registros) {
  const resp = await fetch(DESTINO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-sync-secret": CONECTA_SYNC_SECRET.value() },
    body: JSON.stringify({ registros })
  });
  if (!resp.ok) throw new Error(`recibirStaffConecta respondió ${resp.status}: ${await resp.text()}`);
}

function aRegistro(uid, datos) {
  return {
    uid, nombre: datos.nombre, correo: datos.correo, cargo: datos.cargo || "", estado: datos.estado,
    cedula: datos.cedula || "", telefono: datos.telefono || ""
  };
}

exports.onStaffWriteSyncOrdenesTrabajo = onDocumentWritten(
  { document: "staff/{uid}", secrets: [CONECTA_SYNC_SECRET] },
  async (event) => {
    const uid = event.params.uid;
    const despues = event.data?.after?.exists ? event.data.after.data() : null;
    try {
      if (!despues) await enviarARegistroCincoSAS([{ uid, borrado: true }]);
      else await enviarARegistroCincoSAS([aRegistro(uid, despues)]);
    } catch (err) {
      // No hay nada más que hacer del lado de Conecta si Cinco SAS control
      // está caído en ese momento — el próximo cambio de este empleado (o
      // un backfillStaffOrdenesTrabajo manual) lo pone al día. No se
      // reintenta a mano para no duplicar lógica de reintentos.
      console.error("No se pudo sincronizar staff con Cinco SAS control:", err);
    }
  }
);

exports.backfillStaffOrdenesTrabajo = onRequest({ secrets: [CONECTA_SYNC_SECRET] }, async (req, res) => {
  if (req.get("x-sync-secret") !== CONECTA_SYNC_SECRET.value()) { res.status(401).send("Unauthorized"); return; }
  const snap = await admin.firestore().collection("staff").get();
  const registros = snap.docs.map((d) => aRegistro(d.id, d.data()));
  await enviarARegistroCincoSAS(registros);
  res.status(200).json({ ok: true, enviados: registros.length });
});
