const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const TAMANO_MAXIMO_ARCHIVO = 5 * 1024 * 1024; // 5 MB
const TIPOS_FOTO_PERMITIDOS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const TIPOS_DOCUMENTO_PERMITIDOS = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"
};

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

// Cualquier empleado puede reportar un incidente o casi-accidente. Pasa por
// Cloud Function (no por escritura directa del cliente) porque la foto se
// sube con el Admin SDK — el bucket de Storage sigue completamente cerrado
// a escritura pública/de cliente, igual que las hojas de vida del módulo
// de contratación.
const reportarIncidente = onCall({ enforceAppCheck: true }, async (request) => {
  const perfil = await requireEmpleado(request);
  const data = request.data || {};

  const titulo = String(data.titulo || "").trim().slice(0, 150);
  const descripcion = String(data.descripcion || "").trim().slice(0, 2000);
  const lugar = String(data.lugar || "").trim().slice(0, 150);
  const fecha = String(data.fecha || "").trim();
  const tipo = ["incidente", "casi_accidente"].includes(data.tipo) ? data.tipo : "incidente";
  const gravedad = ["leve", "moderada", "grave"].includes(data.gravedad) ? data.gravedad : "leve";

  if (!titulo || !descripcion || !lugar || !fecha) {
    throw new HttpsError("invalid-argument", "Faltan datos obligatorios del reporte.");
  }

  const incidenteRef = admin.firestore().collection("incidentes").doc();
  let foto = null;

  if (data.fotoBase64) {
    const extension = TIPOS_FOTO_PERMITIDOS[data.fotoTipo];
    if (!extension) {
      throw new HttpsError("invalid-argument", "La foto debe ser JPG, PNG o WEBP.");
    }
    const buffer = Buffer.from(data.fotoBase64, "base64");
    if (buffer.length > TAMANO_MAXIMO_ARCHIVO) {
      throw new HttpsError("invalid-argument", "La foto no debe superar 5 MB.");
    }
    const path = `incidentes/${incidenteRef.id}/foto.${extension}`;
    await admin.storage().bucket().file(path).save(buffer, { contentType: data.fotoTipo });
    foto = { nombre: `foto.${extension}`, path, tipo: data.fotoTipo, tamano: buffer.length };
  }

  await incidenteRef.set({
    tipo,
    titulo,
    descripcion,
    lugar,
    fecha,
    gravedad,
    foto,
    reportadoPorUid: request.auth.uid,
    reportadoPorNombre: perfil.nombre,
    estado: "abierto",
    creadoEn: admin.firestore.FieldValue.serverTimestamp()
  });

  return { ok: true };
});

// Solo el admin sube documentos del sistema de gestión (procedimientos,
// instructivos, formatos) — mismo motivo: la subida pasa por el Admin SDK
// para no tener que abrir Storage a escritura de cliente.
const subirDocumento = onCall({ enforceAppCheck: true }, async (request) => {
  const perfil = await requireAdmin(request);
  const data = request.data || {};

  const titulo = String(data.titulo || "").trim().slice(0, 150);
  const categoria = ["procedimiento", "instructivo", "formato"].includes(data.categoria) ? data.categoria : "procedimiento";
  const version = String(data.version || "").trim().slice(0, 30);

  if (!titulo || !data.archivoBase64) {
    throw new HttpsError("invalid-argument", "Falta el título o el archivo.");
  }

  const extension = TIPOS_DOCUMENTO_PERMITIDOS[data.archivoTipo];
  if (!extension) {
    throw new HttpsError("invalid-argument", "El archivo debe ser PDF o Word (.doc/.docx).");
  }
  const buffer = Buffer.from(data.archivoBase64, "base64");
  if (buffer.length > TAMANO_MAXIMO_ARCHIVO) {
    throw new HttpsError("invalid-argument", "El archivo no debe superar 5 MB.");
  }

  const documentoRef = admin.firestore().collection("documentos").doc();
  const path = `documentos/${documentoRef.id}/archivo.${extension}`;
  await admin.storage().bucket().file(path).save(buffer, { contentType: data.archivoTipo });

  await documentoRef.set({
    titulo,
    categoria,
    version,
    archivo: { nombre: String(data.archivoNombre || `documento.${extension}`).slice(0, 150), path, tipo: data.archivoTipo, tamano: buffer.length },
    subidoPorNombre: perfil.nombre || "Admin",
    creadoEn: admin.firestore.FieldValue.serverTimestamp()
  });

  return { ok: true };
});

module.exports = { reportarIncidente, subirDocumento };
