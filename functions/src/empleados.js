const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { enviarBienvenidaEmpleado } = require("./email");

function generarPasswordTemporal() {
  return crypto.randomBytes(9).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
}

async function requireAdmin(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const snap = await admin.firestore().collection("staff").doc(request.auth.uid).get();
  const data = snap.exists ? snap.data() : null;
  if (!data || data.rol !== "admin" || data.estado !== "activo") {
    throw new HttpsError("permission-denied", "Solo un administrador puede invitar empleados.");
  }
}

// Los empleados no se autoregistran: un admin los invita desde el panel.
// Se crea la cuenta de Authentication + el documento staff/{uid} con rol
// "empleado", y se envía el correo de bienvenida con una contraseña
// temporal (mismo patrón ya usado en LBDC Neiva para invitar
// colaboradores).
const invitarEmpleado = onCall({ enforceAppCheck: true }, async (request) => {
  await requireAdmin(request);

  const nombre = String(request.data?.nombre || "").trim().slice(0, 100);
  const correo = String(request.data?.correo || "").trim().toLowerCase().slice(0, 120);
  if (!nombre || !correo) {
    throw new HttpsError("invalid-argument", "Falta el nombre o el correo del empleado.");
  }

  const password = generarPasswordTemporal();

  let uid;
  try {
    const usuario = await admin.auth().createUser({ email: correo, password, displayName: nombre });
    uid = usuario.uid;
  } catch (err) {
    if (err.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "Ya existe una cuenta con ese correo.");
    }
    throw new HttpsError("internal", `No se pudo crear la cuenta: ${err.message || err}`);
  }

  await admin.firestore().collection("staff").doc(uid).set({
    nombre,
    estado: "activo",
    rol: "empleado",
    creadoEn: admin.firestore.FieldValue.serverTimestamp()
  });

  try {
    await enviarBienvenidaEmpleado({ nombre, correo, password });
  } catch (err) {
    console.error("No se pudo enviar el correo de bienvenida:", err);
  }

  return { ok: true };
});

module.exports = { invitarEmpleado };
