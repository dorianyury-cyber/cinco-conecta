const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const InspectModule = require("docxtemplater/js/inspect-module.js");

const TAMANO_MAXIMO_ARCHIVO = 5 * 1024 * 1024; // 5 MB
const TIPOS_FOTO_PERMITIDOS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

// snake_case/camelCase -> "Title Case", solo para sugerir una etiqueta legible;
// el admin puede renombrarla luego con actualizarCamposPlantilla.
// Código de control documental único INT-{año}-{consecutivo}, compartido con
// informesLibres (misma secuencia: son el mismo tipo de documento, un informe
// de interventoría, solo cambia si el formato es propio del cliente o libre).
// El contador se incrementa dentro de una transacción para que dos informes
// generados al mismo tiempo nunca puedan recibir el mismo código.
async function generarCodigoInforme() {
  const anio = new Date().getFullYear();
  const contadorRef = admin.firestore().collection("contadoresCodigo").doc(String(anio));
  return admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(contadorRef);
    const siguiente = (snap.exists ? snap.data().ultimo : 0) + 1;
    tx.set(contadorRef, { ultimo: siguiente });
    return `INT-${anio}-${String(siguiente).padStart(3, "0")}`;
  });
}

function prettificarEtiqueta(clave) {
  const separada = String(clave)
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!separada) return String(clave);
  return separada
    .split(/\s+/)
    .map((palabra) => palabra.charAt(0).toUpperCase() + palabra.slice(1))
    .join(" ");
}

// El admin sube la plantilla .docx real del cliente. Los campos {tag} se
// detectan con el propio InspectModule de docxtemplater (no con una regex
// artesanal sobre el XML) porque Word puede partir un mismo {tag} en varios
// <w:t> internos (autocorrección) y porque los nombres de campo en español
// llevan tildes/ñ que una regex tipo \w+ no reconocería.
const subirPlantilla = onCall({ enforceAppCheck: true }, async (request) => {
  const perfil = await requireAdmin(request);
  const data = request.data || {};

  const nombre = String(data.nombre || "").trim().slice(0, 150);
  const cliente = String(data.cliente || "").trim().slice(0, 150);

  if (!nombre || !cliente || !data.archivoBase64) {
    throw new HttpsError("invalid-argument", "Falta el nombre, el cliente o el archivo.");
  }
  if (data.archivoTipo !== MIME_DOCX) {
    throw new HttpsError("invalid-argument", "La plantilla debe ser un archivo Word (.docx).");
  }

  const buffer = Buffer.from(data.archivoBase64, "base64");
  if (buffer.length > TAMANO_MAXIMO_ARCHIVO) {
    throw new HttpsError("invalid-argument", "El archivo no debe superar 5 MB.");
  }

  let claves;
  try {
    const zip = new PizZip(buffer);
    const inspector = new InspectModule();
    // eslint-disable-next-line no-new
    new Docxtemplater(zip, { modules: [inspector], paragraphLoop: true, linebreaks: true });
    claves = Object.keys(inspector.getAllTags());
  } catch (err) {
    throw new HttpsError("invalid-argument", `No se pudo leer la plantilla: ${err.message || err}`);
  }

  if (claves.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "No se encontró ningún campo {así} en la plantilla. Agrega al menos un campo entre llaves para poder generar informes."
    );
  }

  const campos = claves.map((clave) => ({ clave, etiqueta: prettificarEtiqueta(clave), activo: true }));

  const plantillaRef = admin.firestore().collection("plantillasInforme").doc();
  const path = `plantillasInforme/${plantillaRef.id}/plantilla.docx`;
  await admin.storage().bucket().file(path).save(buffer, { contentType: MIME_DOCX });

  await plantillaRef.set({
    nombre,
    cliente,
    archivo: { nombre: String(data.archivoNombre || "plantilla.docx").slice(0, 150), path, tipo: MIME_DOCX, tamano: buffer.length },
    campos,
    creadoPorNombre: perfil.nombre || "Admin",
    creadoEn: admin.firestore.FieldValue.serverTimestamp()
  });

  return { ok: true, id: plantillaRef.id, campos };
});

// Permite al admin corregir las etiquetas sugeridas o desactivar campos
// falsos-positivos (texto de la plantilla que por casualidad tenía {algo})
// sin tener que volver a subir el archivo.
const actualizarCamposPlantilla = onCall({ enforceAppCheck: true }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  const plantillaId = String(data.plantillaId || "").trim();
  const campos = Array.isArray(data.campos) ? data.campos : null;

  if (!plantillaId || !campos) {
    throw new HttpsError("invalid-argument", "Falta la plantilla o la lista de campos.");
  }

  const camposLimpios = campos
    .filter((c) => c && typeof c.clave === "string")
    .map((c) => ({
      clave: c.clave.slice(0, 100),
      etiqueta: String(c.etiqueta || c.clave).trim().slice(0, 150),
      activo: c.activo !== false
    }));

  const ref = admin.firestore().collection("plantillasInforme").doc(plantillaId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "La plantilla no existe.");
  }

  await ref.update({ campos: camposLimpios });
  return { ok: true };
});

const eliminarPlantilla = onCall({ enforceAppCheck: true }, async (request) => {
  await requireAdmin(request);
  const plantillaId = String(request.data?.plantillaId || "").trim();
  if (!plantillaId) {
    throw new HttpsError("invalid-argument", "Falta la plantilla a eliminar.");
  }

  const ref = admin.firestore().collection("plantillasInforme").doc(plantillaId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "La plantilla no existe.");
  }

  const path = snap.data()?.archivo?.path;
  if (path) {
    await admin.storage().bucket().file(path).delete({ ignoreNotFound: true });
  }
  await ref.delete();

  return { ok: true };
});

// Cualquier empleado activo puede diligenciar un informe a partir de una
// plantilla ya subida (no solo el admin) — quien va a campo no siempre es
// el mismo que administra las plantillas.
const generarInformePlantilla = onCall({ enforceAppCheck: true }, async (request) => {
  const perfil = await requireEmpleado(request);
  const data = request.data || {};

  const plantillaId = String(data.plantillaId || "").trim();
  const valoresCrudos = data.valores && typeof data.valores === "object" ? data.valores : null;
  if (!plantillaId || !valoresCrudos) {
    throw new HttpsError("invalid-argument", "Falta la plantilla o los valores del informe.");
  }

  const plantillaSnap = await admin.firestore().collection("plantillasInforme").doc(plantillaId).get();
  if (!plantillaSnap.exists) {
    throw new HttpsError("not-found", "La plantilla no existe.");
  }
  const plantilla = plantillaSnap.data();

  const valores = {};
  for (const campo of plantilla.campos || []) {
    valores[campo.clave] = String(valoresCrudos[campo.clave] || "").trim().slice(0, 2000);
  }

  const [bufferPlantilla] = await admin.storage().bucket().file(plantilla.archivo.path).download();

  let bufferGenerado;
  try {
    const zip = new PizZip(bufferPlantilla);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, nullGetter: () => "" });
    doc.render(valores);
    bufferGenerado = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
  } catch (err) {
    throw new HttpsError("internal", `No se pudo generar el informe: ${err.message || err}`);
  }

  const informeRef = admin.firestore().collection("informesPlantilla").doc();
  const path = `informesPlantilla/${informeRef.id}/informe.docx`;
  await admin.storage().bucket().file(path).save(bufferGenerado, { contentType: MIME_DOCX });
  const codigo = await generarCodigoInforme();

  await informeRef.set({
    plantillaId,
    plantillaNombre: plantilla.nombre,
    cliente: plantilla.cliente,
    codigo,
    valores,
    archivoGenerado: { nombre: `${plantilla.nombre || "informe"}.docx`.slice(0, 150), path, tipo: MIME_DOCX, tamano: bufferGenerado.length },
    generadoPorNombre: perfil.nombre || "Empleado",
    creadoEn: admin.firestore.FieldValue.serverTimestamp()
  });

  return { ok: true };
});

// Sube una foto para un bloque "imagen" de un informe de formato libre.
// El bloque en sí (con el path devuelto aquí) se guarda en el arreglo
// `bloques` mediante una escritura directa de Firestore desde el cliente
// (informesLibres no es una colección "con archivo" en sí misma).
const subirImagenInforme = onCall({ enforceAppCheck: true }, async (request) => {
  await requireEmpleado(request);
  const data = request.data || {};

  const informeId = String(data.informeId || "").trim();
  const extension = TIPOS_FOTO_PERMITIDOS[data.tipo];
  if (!informeId || !data.archivoBase64 || !extension) {
    throw new HttpsError("invalid-argument", "Falta el informe o la imagen debe ser JPG, PNG o WEBP.");
  }

  const buffer = Buffer.from(data.archivoBase64, "base64");
  if (buffer.length > TAMANO_MAXIMO_ARCHIVO) {
    throw new HttpsError("invalid-argument", "La imagen no debe superar 5 MB.");
  }

  const imagenId = crypto.randomBytes(12).toString("hex");
  const path = `informesLibres/${informeId}/imagenes/${imagenId}.${extension}`;
  await admin.storage().bucket().file(path).save(buffer, { contentType: data.tipo });

  return { ok: true, path };
});

module.exports = {
  subirPlantilla,
  actualizarCamposPlantilla,
  eliminarPlantilla,
  generarInformePlantilla,
  subirImagenInforme
};
