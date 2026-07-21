const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

// Las respuestas de encuesta deben ser genuinamente anónimas (sin uid) para
// que la gente conteste con honestidad, pero igual hay que impedir que la
// misma persona vote dos veces — por eso el "voto ya emitido" se marca en
// una colección aparte (encuestaVotos), sin ningún dato de la respuesta, y
// todo ocurre en una transacción para que sea atómico.
const responderEncuesta = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const staffSnap = await admin.firestore().collection("staff").doc(request.auth.uid).get();
  if (!staffSnap.exists || staffSnap.data().estado !== "activo") {
    throw new HttpsError("permission-denied", "No tienes acceso.");
  }

  const encuestaId = String(request.data?.encuestaId || "");
  const respuestas = request.data?.respuestas;
  const comentario = String(request.data?.comentario || "").trim().slice(0, 500);

  if (!encuestaId || !respuestas || typeof respuestas !== "object") {
    throw new HttpsError("invalid-argument", "Faltan las respuestas de la encuesta.");
  }

  const db = admin.firestore();
  const encuestaRef = db.collection("encuestas").doc(encuestaId);
  const votoRef = encuestaRef.collection("votos").doc(request.auth.uid);

  await db.runTransaction(async (tx) => {
    const [encuestaDoc, votoDoc] = await Promise.all([tx.get(encuestaRef), tx.get(votoRef)]);
    if (!encuestaDoc.exists || encuestaDoc.data().estado !== "activa") {
      throw new HttpsError("failed-precondition", "Esta encuesta ya no está activa.");
    }
    if (votoDoc.exists) {
      throw new HttpsError("already-exists", "Ya respondiste esta encuesta.");
    }
    tx.set(votoRef, { creadoEn: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(db.collection("encuestaRespuestas").doc(), {
      encuestaId,
      respuestas,
      comentario,
      creadoEn: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return { ok: true };
});

module.exports = { responderEncuesta };
