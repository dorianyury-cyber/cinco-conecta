const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");

const LIMITE_TEXTO = { corta: 300, parrafo: 2000 };
const TAMANO_MAX_ARCHIVO_MB = 5; // tope duro de la plataforma (el creador puede fijar uno menor)

// Extensiones permitidas por categoría (mismo catálogo que
// web/js/encuestas-tipos.js). El tipo MIME se deduce SIEMPRE de la extensión,
// nunca del que declara el navegador.
const CATEGORIAS_ARCHIVO = {
  pdf: { pdf: "application/pdf" },
  documento: {
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    odt: "application/vnd.oasis.opendocument.text",
    rtf: "application/rtf",
    txt: "text/plain"
  },
  hoja: {
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    csv: "text/csv"
  },
  presentacion: {
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    odp: "application/vnd.oasis.opendocument.presentation"
  },
  imagen: {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic"
  }
};

function extensionesPermitidas(pregunta) {
  const tipos = Array.isArray(pregunta.archivos?.tipos) ? pregunta.archivos.tipos : [];
  const mapa = {};
  tipos.forEach((t) => Object.assign(mapa, CATEGORIAS_ARCHIVO[t] || {}));
  return mapa;
}

function extensionDe(nombre) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(nombre || ""));
  return m ? m[1].toLowerCase() : "";
}

function limiteArchivos(pregunta) {
  const maxArchivos = Math.min(Math.max(parseInt(pregunta.archivos?.maxArchivos, 10) || 1, 1), 10);
  const maxMB = Math.min(Math.max(parseFloat(pregunta.archivos?.maxMB) || TAMANO_MAX_ARCHIVO_MB, 1), TAMANO_MAX_ARCHIVO_MB);
  return { maxArchivos, maxMB };
}

// Las encuestas anteriores guardaban cada pregunta como string; se tratan
// como respuesta corta con el texto como id.
function normalizarPregunta(preg, i) {
  if (typeof preg === "string") return { id: preg, texto: preg, tipo: "corta", obligatoria: true };
  return { id: preg.id || `p${i + 1}`, ...preg };
}

async function requireEmpleado(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const staffSnap = await admin.firestore().collection("staff").doc(request.auth.uid).get();
  if (!staffSnap.exists || staffSnap.data().estado !== "activo") {
    throw new HttpsError("permission-denied", "No tienes acceso.");
  }
  return staffSnap.data();
}

function fechaValida(texto) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const d = new Date(`${texto}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

const horaValida = (texto) => /^([01]\d|2[0-3]):[0-5]\d$/.test(texto);

const listaDe = (valor) => (Array.isArray(valor) ? valor.map(String) : []);

// Valida cada respuesta contra el tipo/configuración que el creador definió
// en la encuesta (el cliente no es de fiar) y devuelve SOLO las respuestas de
// las preguntas de la encuesta, indexadas por id de pregunta. Forma guardada
// según el tipo:
//   corta / parrafo / fecha ("AAAA-MM-DD") / hora ("HH:MM") → string
//   opcion_multiple / desplegable                          → string (UNA opción)
//   casillas                                               → string[] (una o varias)
//   escala / calificacion                                  → número entero
//   cuadricula_opciones                                    → [{ fila, valor }]   (UNA por fila)
//   cuadricula_casillas                                    → [{ fila, valores }] (VARIAS por fila)
//   archivos                                               → [{ nombre, path, tipo, tamano }]
async function validarRespuestas(encuestaId, preguntas, respuestas, bucket) {
  const limpias = {};
  for (let i = 0; i < preguntas.length; i++) {
    const p = normalizarPregunta(preguntas[i], i);
    const obligatoria = p.obligatoria !== false;
    const bruto = respuestas[p.id];
    const faltante = () => new HttpsError("invalid-argument", `Responde la pregunta: ${p.texto}`);
    const invalida = (detalle) => new HttpsError("invalid-argument", `${detalle} en: ${p.texto}`);
    const opciones = listaDe(p.opciones);
    const filas = listaDe(p.filas);
    const columnas = listaDe(p.columnas);

    switch (p.tipo) {
      case "casillas": {
        const marcadas = Array.isArray(bruto) ? [...new Set(bruto.map(String))] : [];
        if (marcadas.some((o) => !opciones.includes(o))) throw invalida("Opción no válida");
        if (marcadas.length === 0) {
          if (obligatoria) throw faltante();
          break;
        }
        const min = Number.isInteger(p.minSeleccion) ? p.minSeleccion : 0;
        const max = Number.isInteger(p.maxSeleccion) ? p.maxSeleccion : null;
        if (marcadas.length < min) throw invalida(`Selecciona al menos ${min} opción(es)`);
        if (max !== null && marcadas.length > max) throw invalida(`Selecciona como máximo ${max} opción(es)`);
        limpias[p.id] = marcadas;
        break;
      }
      case "opcion_multiple":
      case "desplegable": {
        const elegida = typeof bruto === "string" ? bruto : "";
        if (!elegida) {
          if (obligatoria) throw faltante();
          break;
        }
        if (!opciones.includes(elegida)) throw invalida("Opción no válida");
        limpias[p.id] = elegida;
        break;
      }
      case "escala":
      case "calificacion": {
        const esEscala = p.tipo === "escala";
        const min = esEscala ? (p.escala?.min === 0 ? 0 : 1) : 1;
        const max = esEscala ? (Number.isInteger(p.escala?.max) ? p.escala.max : 5) : (Number.isInteger(p.calificacion?.max) ? p.calificacion.max : 5);
        if (bruto === undefined || bruto === null || bruto === "") {
          if (obligatoria) throw faltante();
          break;
        }
        if (!Number.isInteger(bruto) || bruto < min || bruto > max) throw invalida("Valor fuera de rango");
        limpias[p.id] = bruto;
        break;
      }
      case "cuadricula_opciones": {
        const items = Array.isArray(bruto) ? bruto : [];
        const porFila = new Map();
        items.forEach((it) => {
          const fila = String(it?.fila ?? "");
          const valor = String(it?.valor ?? "");
          if (!filas.includes(fila) || !columnas.includes(valor) || porFila.has(fila)) throw invalida("Respuesta no válida");
          porFila.set(fila, valor);
        });
        if (porFila.size === 0) {
          if (obligatoria) throw faltante();
          break;
        }
        if (obligatoria && porFila.size < filas.length) throw invalida("Falta responder alguna fila");
        limpias[p.id] = filas.filter((f) => porFila.has(f)).map((fila) => ({ fila, valor: porFila.get(fila) }));
        break;
      }
      case "cuadricula_casillas": {
        const items = Array.isArray(bruto) ? bruto : [];
        const porFila = new Map();
        items.forEach((it) => {
          const fila = String(it?.fila ?? "");
          const valores = [...new Set(listaDe(it?.valores))];
          if (!filas.includes(fila) || porFila.has(fila) || valores.some((v) => !columnas.includes(v))) throw invalida("Respuesta no válida");
          if (valores.length > 0) porFila.set(fila, valores);
        });
        if (porFila.size === 0) {
          if (obligatoria) throw faltante();
          break;
        }
        if (obligatoria && porFila.size < filas.length) throw invalida("Falta responder alguna fila");
        limpias[p.id] = filas.filter((f) => porFila.has(f)).map((fila) => ({
          fila,
          valores: columnas.filter((c) => porFila.get(fila).includes(c))
        }));
        break;
      }
      case "fecha": {
        const v = typeof bruto === "string" ? bruto.trim() : "";
        if (!v) {
          if (obligatoria) throw faltante();
          break;
        }
        if (!fechaValida(v)) throw invalida("Fecha no válida");
        limpias[p.id] = v;
        break;
      }
      case "hora": {
        const v = typeof bruto === "string" ? bruto.trim() : "";
        if (!v) {
          if (obligatoria) throw faltante();
          break;
        }
        if (!horaValida(v)) throw invalida("Hora no válida");
        limpias[p.id] = v;
        break;
      }
      case "archivos": {
        const items = Array.isArray(bruto) ? bruto : [];
        if (items.length === 0) {
          if (obligatoria) throw faltante();
          break;
        }
        const { maxArchivos, maxMB } = limiteArchivos(p);
        if (items.length > maxArchivos) throw invalida(`Máximo ${maxArchivos} archivo(s)`);
        const permitidas = extensionesPermitidas(p);
        const prefijo = `encuestaArchivos/${encuestaId}/${p.id}/`;
        const vistos = new Set();
        const archivos = [];
        for (const it of items) {
          const path = String(it?.path || "");
          if (!path.startsWith(prefijo) || path.includes("..") || vistos.has(path)) throw invalida("Archivo no válido");
          vistos.add(path);
          let metadata;
          try {
            [metadata] = await bucket.file(path).getMetadata();
          } catch {
            throw invalida("No se encontró un archivo subido; vuelve a adjuntarlo");
          }
          const ext = extensionDe(path);
          if (!permitidas[ext] || Number(metadata.size) > maxMB * 1024 * 1024) throw invalida("Archivo no válido");
          archivos.push({
            nombre: String(metadata.metadata?.nombreOriginal || `archivo.${ext}`).slice(0, 150),
            path,
            tipo: permitidas[ext],
            tamano: Number(metadata.size)
          });
        }
        limpias[p.id] = archivos;
        break;
      }
      default: {
        // corta / parrafo (y cualquier tipo desconocido, tratado como texto)
        const texto = typeof bruto === "string" ? bruto.trim().slice(0, LIMITE_TEXTO[p.tipo] || LIMITE_TEXTO.corta) : "";
        if (!texto) {
          if (obligatoria) throw faltante();
          break;
        }
        limpias[p.id] = texto;
      }
    }
  }
  return limpias;
}

// Las respuestas de encuesta deben ser genuinamente anónimas (sin uid) para
// que la gente conteste con honestidad, pero igual hay que impedir que la
// misma persona vote dos veces — por eso el "voto ya emitido" se marca en
// una colección aparte (encuestaVotos), sin ningún dato de la respuesta, y
// todo ocurre en una transacción para que sea atómico.
const responderEncuesta = onCall({ enforceAppCheck: true }, async (request) => {
  await requireEmpleado(request);

  const encuestaId = String(request.data?.encuestaId || "");
  const respuestas = request.data?.respuestas;
  const comentario = String(request.data?.comentario || "").trim().slice(0, 500);

  if (!encuestaId || !respuestas || typeof respuestas !== "object") {
    throw new HttpsError("invalid-argument", "Faltan las respuestas de la encuesta.");
  }

  const db = admin.firestore();
  const bucket = admin.storage().bucket();
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
    const respuestasLimpias = await validarRespuestas(encuestaId, encuestaDoc.data().preguntas || [], respuestas, bucket);
    tx.set(votoRef, { creadoEn: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(db.collection("encuestaRespuestas").doc(), {
      encuestaId,
      respuestas: respuestasLimpias,
      comentario,
      creadoEn: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return { ok: true };
});

// Sube UN archivo de una pregunta tipo "Subir archivos" (el bucket sigue
// cerrado a escritura de cliente, igual que en hseq.js). No guarda el uid de
// quien sube: la ruta lleva un id aleatorio, así la respuesta sigue siendo
// anónima. responderEncuesta luego solo acepta rutas de esta misma
// encuesta/pregunta que existan realmente en Storage.
const subirArchivoEncuesta = onCall({ enforceAppCheck: true }, async (request) => {
  await requireEmpleado(request);
  const data = request.data || {};
  const encuestaId = String(data.encuestaId || "");
  const preguntaId = String(data.preguntaId || "");
  const nombre = String(data.nombre || "").replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 150);

  if (!encuestaId || !preguntaId || !nombre || typeof data.base64 !== "string" || !data.base64) {
    throw new HttpsError("invalid-argument", "Falta el archivo.");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(preguntaId)) {
    throw new HttpsError("invalid-argument", "Pregunta no válida.");
  }

  const db = admin.firestore();
  const encuestaRef = db.collection("encuestas").doc(encuestaId);
  const [encuestaDoc, votoDoc] = await Promise.all([
    encuestaRef.get(),
    encuestaRef.collection("votos").doc(request.auth.uid).get()
  ]);
  if (!encuestaDoc.exists || encuestaDoc.data().estado !== "activa") {
    throw new HttpsError("failed-precondition", "Esta encuesta ya no está activa.");
  }
  if (votoDoc.exists) {
    throw new HttpsError("already-exists", "Ya respondiste esta encuesta.");
  }

  const pregunta = (encuestaDoc.data().preguntas || []).map(normalizarPregunta).find((p) => p.id === preguntaId && p.tipo === "archivos");
  if (!pregunta) {
    throw new HttpsError("invalid-argument", "Esta pregunta no admite archivos.");
  }

  const ext = extensionDe(nombre);
  const mime = extensionesPermitidas(pregunta)[ext];
  if (!mime) {
    throw new HttpsError("invalid-argument", "Tipo de archivo no permitido en esta pregunta.");
  }

  const buffer = Buffer.from(data.base64, "base64");
  const { maxMB } = limiteArchivos(pregunta);
  if (buffer.length === 0) {
    throw new HttpsError("invalid-argument", "El archivo está vacío.");
  }
  if (buffer.length > maxMB * 1024 * 1024) {
    throw new HttpsError("invalid-argument", `El archivo no debe superar ${maxMB} MB.`);
  }

  const path = `encuestaArchivos/${encuestaId}/${preguntaId}/${crypto.randomBytes(16).toString("hex")}.${ext}`;
  await admin.storage().bucket().file(path).save(buffer, {
    contentType: mime,
    metadata: { metadata: { nombreOriginal: nombre } }
  });

  return { path, nombre, tipo: mime, tamano: buffer.length };
});

module.exports = { responderEncuesta, subirArchivoEncuesta, validarRespuestas };
