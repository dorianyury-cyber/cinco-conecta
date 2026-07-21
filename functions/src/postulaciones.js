const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { enviarConfirmacionPostulacion, enviarNotificacionRRHH } = require("./email");

// Formulario público, sin inicio de sesión — igual que el PQR de cinco-sas,
// no hay ninguna regla de Firestore/Storage que permita escribir
// "candidatos" directamente desde el cliente. Todo pasa por esta Cloud
// Function (Admin SDK), con App Check habilitado.
const LIMITE_POSTULACIONES_POR_HORA = 3;
const TAMANO_MAXIMO_HOJA_VIDA = 5 * 1024 * 1024; // 5 MB
const TIPOS_HOJA_VIDA_PERMITIDOS = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"
};

const CAMPOS = { nombres: 80, apellidos: 80, email: 120, telefono: 20, cedula: 20 };
const REQUERIDOS = ["nombres", "apellidos", "email", "telefono", "cedula", "vacanteId"];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function limpiarTexto(valor, maxLargo) {
  return String(valor ?? "").trim().slice(0, maxLargo);
}

async function dentroDelLimite(email) {
  const haceUnaHora = admin.firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
  const snap = await admin.firestore()
    .collection("candidatos")
    .where("email", "==", email)
    .where("creadoEn", ">=", haceUnaHora)
    .count()
    .get();
  return snap.data().count < LIMITE_POSTULACIONES_POR_HORA;
}

const enviarPostulacion = onCall({ enforceAppCheck: true }, async (request) => {
  const data = request.data || {};

  if (data.sitioWeb) {
    return { ok: true };
  }

  for (const campo of REQUERIDOS) {
    if (!String(data[campo] ?? "").trim()) {
      throw new HttpsError("invalid-argument", `Falta el campo obligatorio: ${campo}.`);
    }
  }

  const datos = {};
  for (const [campo, maxLargo] of Object.entries(CAMPOS)) {
    datos[campo] = limpiarTexto(data[campo], maxLargo);
  }
  if (!EMAIL_REGEX.test(datos.email)) {
    throw new HttpsError("invalid-argument", "El email no es válido.");
  }

  const vacanteSnap = await admin.firestore().collection("vacantes").doc(String(data.vacanteId)).get();
  if (!vacanteSnap.exists || vacanteSnap.data().estado !== "abierta") {
    throw new HttpsError("failed-precondition", "Esta vacante ya no está disponible.");
  }
  const tituloVacante = vacanteSnap.data().titulo;

  if (!(await dentroDelLimite(datos.email))) {
    throw new HttpsError("resource-exhausted", "Se alcanzó el límite de postulaciones por hora. Intenta más tarde.");
  }

  let hojaVida = null;
  if (data.hojaVidaBase64) {
    const extension = TIPOS_HOJA_VIDA_PERMITIDOS[data.hojaVidaTipo];
    if (!extension) {
      throw new HttpsError("invalid-argument", "La hoja de vida debe ser PDF o Word (.doc/.docx).");
    }
    const buffer = Buffer.from(data.hojaVidaBase64, "base64");
    if (buffer.length > TAMANO_MAXIMO_HOJA_VIDA) {
      throw new HttpsError("invalid-argument", "La hoja de vida no debe superar 5 MB.");
    }
    const candidatoRef = admin.firestore().collection("candidatos").doc();
    const path = `candidatos/${candidatoRef.id}/hoja-vida.${extension}`;
    await admin.storage().bucket().file(path).save(buffer, { contentType: data.hojaVidaTipo });
    hojaVida = { nombre: limpiarTexto(data.hojaVidaNombre, 150) || `hoja-vida.${extension}`, path, tipo: data.hojaVidaTipo, tamano: buffer.length };

    await candidatoRef.set({
      ...datos,
      vacanteId: String(data.vacanteId),
      vacanteTitulo: tituloVacante,
      hojaVida,
      etapa: "recibido",
      notas: "",
      historialEtapas: [{ etapa: "recibido", fecha: admin.firestore.Timestamp.now() }],
      creadoEn: admin.firestore.FieldValue.serverTimestamp()
    });
  } else {
    throw new HttpsError("invalid-argument", "Falta adjuntar la hoja de vida.");
  }

  try {
    await enviarConfirmacionPostulacion({ nombres: datos.nombres, email: datos.email, tituloVacante });
  } catch (err) {
    console.error("No se pudo enviar la confirmación al candidato:", err);
  }
  try {
    await enviarNotificacionRRHH({ nombres: datos.nombres, apellidos: datos.apellidos, email: datos.email, telefono: datos.telefono, tituloVacante });
  } catch (err) {
    console.error("No se pudo enviar la notificación a RR.HH.:", err);
  }

  return { ok: true };
});

const consultarEstado = onCall({ enforceAppCheck: true }, async (request) => {
  const data = request.data || {};
  const email = limpiarTexto(data.email, 120).toLowerCase();
  const cedula = limpiarTexto(data.cedula, 20);

  if (!email || !cedula) {
    throw new HttpsError("invalid-argument", "Ingresa tu email y tu número de cédula.");
  }

  const snap = await admin.firestore()
    .collection("candidatos")
    .where("email", "==", email)
    .where("cedula", "==", cedula)
    .orderBy("creadoEn", "desc")
    .limit(10)
    .get();

  const postulaciones = snap.docs.map((d) => {
    const c = d.data();
    return {
      vacanteTitulo: c.vacanteTitulo,
      etapa: c.etapa,
      historialEtapas: (c.historialEtapas || []).map((h) => ({
        etapa: h.etapa,
        fecha: h.fecha?.toDate ? h.fecha.toDate().toISOString() : null
      }))
    };
  });

  return { postulaciones };
});

module.exports = { enviarPostulacion, consultarEstado };
