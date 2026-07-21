const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

// El navegador no puede descargar un archivo de Storage directo con fetch()
// (el bucket no tiene CORS habilitado para el dominio del sitio) — esta
// función hace la descarga del lado del servidor y la devuelve en base64,
// para que el panel de staff pueda ver la hoja de vida de un candidato.
// Requiere sesión de staff (custom claim "staff", asignado al crear la
// cuenta) — nunca acceso público.
const obtenerArchivoBase64 = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const snap = await admin.firestore().collection("staff").doc(request.auth.uid).get();
  if (!snap.exists || snap.data().estado === "bloqueado") {
    throw new HttpsError("permission-denied", "No tienes acceso.");
  }

  const path = request.data?.path;
  if (!path || typeof path !== "string") {
    throw new HttpsError("invalid-argument", "Falta la ruta del archivo.");
  }

  try {
    const file = admin.storage().bucket().file(path);
    const [buffer] = await file.download();
    const [metadata] = await file.getMetadata();
    return { base64: buffer.toString("base64"), contentType: metadata.contentType || "application/octet-stream" };
  } catch (err) {
    throw new HttpsError("internal", `No se pudo descargar el archivo: ${err.message || err}`);
  }
});

module.exports = { obtenerArchivoBase64 };
