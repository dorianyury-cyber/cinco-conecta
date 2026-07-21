const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { enviarBienvenidaEmpleado, enviarNuevaPasswordEmpleado } = require("./email");

function generarPasswordTemporal() {
  return crypto.randomBytes(9).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
}

async function requireEmpleado(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const snap = await admin.firestore().collection("staff").doc(request.auth.uid).get();
  const data = snap.exists ? snap.data() : null;
  if (!data || data.estado !== "activo") {
    throw new HttpsError("permission-denied", "No tienes acceso.");
  }
  return data;
}

async function requireAdmin(request) {
  const perfil = await requireEmpleado(request);
  if (perfil.rol !== "admin") {
    throw new HttpsError("permission-denied", "Solo un administrador puede hacer esto.");
  }
  return perfil;
}

// Los empleados no se autoregistran: un admin los invita desde el panel.
// Se crea la cuenta de Authentication + el documento staff/{uid} con rol
// "empleado", y se envía el correo de bienvenida con una contraseña
// temporal (mismo patrón ya usado en LBDC Neiva para invitar
// colaboradores). `debeCambiarPassword: true` obliga a cambiarla en el
// primer ingreso (ver requireAuth() en utils.js).
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
    correo,
    estado: "activo",
    rol: "empleado",
    debeCambiarPassword: true,
    creadoEn: admin.firestore.FieldValue.serverTimestamp()
  });

  try {
    await enviarBienvenidaEmpleado({ nombre, correo, password });
  } catch (err) {
    console.error("No se pudo enviar el correo de bienvenida:", err);
  }

  return { ok: true };
});

// `staff/{uid}` es de solo-lectura para todo cliente (allow write: if false
// en firestore.rules) — cualquier cambio administrativo pasa por aquí, con
// el Admin SDK. Un admin nunca puede aplicarse estas acciones a sí mismo
// (bloquearse, cambiarse el rol o eliminarse) para evitar quedar sin acceso
// por accidente; tendría que hacerlo otro administrador.
const cambiarEstadoEmpleado = onCall({ enforceAppCheck: true }, async (request) => {
  await requireAdmin(request);
  const uid = String(request.data?.uid || "").trim();
  const estado = request.data?.estado;
  if (!uid || !["activo", "bloqueado"].includes(estado)) {
    throw new HttpsError("invalid-argument", "Falta el empleado o el estado no es válido.");
  }
  if (uid === request.auth.uid) {
    throw new HttpsError("invalid-argument", "No puedes cambiar tu propio estado — pídeselo a otro administrador.");
  }
  const ref = admin.firestore().collection("staff").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Ese empleado ya no existe.");
  }
  await ref.update({ estado });
  return { ok: true };
});

const cambiarRolEmpleado = onCall({ enforceAppCheck: true }, async (request) => {
  await requireAdmin(request);
  const uid = String(request.data?.uid || "").trim();
  const rol = request.data?.rol;
  if (!uid || !["admin", "empleado"].includes(rol)) {
    throw new HttpsError("invalid-argument", "Falta el empleado o el rol no es válido.");
  }
  if (uid === request.auth.uid) {
    throw new HttpsError("invalid-argument", "No puedes cambiar tu propio rol — pídeselo a otro administrador.");
  }
  const ref = admin.firestore().collection("staff").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Ese empleado ya no existe.");
  }
  await ref.update({ rol });
  return { ok: true };
});

const renombrarEmpleado = onCall({ enforceAppCheck: true }, async (request) => {
  await requireAdmin(request);
  const uid = String(request.data?.uid || "").trim();
  const nombre = String(request.data?.nombre || "").trim().slice(0, 100);
  if (!uid || !nombre) {
    throw new HttpsError("invalid-argument", "Falta el empleado o el nombre.");
  }
  const ref = admin.firestore().collection("staff").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Ese empleado ya no existe.");
  }
  await ref.update({ nombre });
  try {
    await admin.auth().updateUser(uid, { displayName: nombre });
  } catch (err) {
    console.error("No se pudo actualizar el nombre en Authentication:", err);
  }
  return { ok: true };
});

// Genera una nueva contraseña temporal (ej. el empleado la olvidó) y vuelve
// a exigir el cambio en el próximo ingreso.
const reenviarInvitacion = onCall({ enforceAppCheck: true }, async (request) => {
  await requireAdmin(request);
  const uid = String(request.data?.uid || "").trim();
  if (!uid) {
    throw new HttpsError("invalid-argument", "Falta el empleado.");
  }
  const ref = admin.firestore().collection("staff").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Ese empleado ya no existe.");
  }
  const { nombre, correo } = snap.data();
  if (!correo) {
    throw new HttpsError("failed-precondition", "Ese empleado no tiene correo registrado — no se puede reenviar.");
  }

  const password = generarPasswordTemporal();
  await admin.auth().updateUser(uid, { password });
  await ref.update({ debeCambiarPassword: true });

  try {
    await enviarNuevaPasswordEmpleado({ nombre: nombre || "", correo, password });
  } catch (err) {
    console.error("No se pudo enviar el correo de nueva contraseña:", err);
  }

  return { ok: true };
});

const eliminarEmpleado = onCall({ enforceAppCheck: true }, async (request) => {
  await requireAdmin(request);
  const uid = String(request.data?.uid || "").trim();
  if (!uid) {
    throw new HttpsError("invalid-argument", "Falta el empleado a eliminar.");
  }
  if (uid === request.auth.uid) {
    throw new HttpsError("invalid-argument", "No puedes eliminar tu propia cuenta.");
  }
  const ref = admin.firestore().collection("staff").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Ese empleado ya no existe.");
  }
  try {
    await admin.auth().deleteUser(uid);
  } catch (err) {
    if (err.code !== "auth/user-not-found") {
      throw new HttpsError("internal", `No se pudo eliminar la cuenta: ${err.message || err}`);
    }
  }
  await ref.delete();
  return { ok: true };
});

// Cualquier empleado activo puede confirmar que YA cambió su propia
// contraseña (limpia el flag debeCambiarPassword de su propio doc — nunca
// del de otra persona, uid siempre sale de request.auth, nunca del cliente).
const confirmarCambioPassword = onCall({ enforceAppCheck: true }, async (request) => {
  await requireEmpleado(request);
  await admin.firestore().collection("staff").doc(request.auth.uid).update({ debeCambiarPassword: false });
  return { ok: true };
});

module.exports = {
  invitarEmpleado,
  cambiarEstadoEmpleado,
  cambiarRolEmpleado,
  renombrarEmpleado,
  reenviarInvitacion,
  eliminarEmpleado,
  confirmarCambioPassword
};
