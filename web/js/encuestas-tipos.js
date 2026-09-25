// Catálogo de tipos de pregunta de Encuestas + normalización/validación del
// diseño de una pregunta. Sin dependencias (ni Firebase ni DOM) para poder
// usarse igual en el editor, el formulario de respuesta y los resultados.
//
// Forma GUARDADA de una pregunta (Firestore, encuestas/{id}.preguntas[]):
//   { id, texto, descripcion?, tipo, obligatoria,
//     opciones[]                       (opcion_multiple, casillas, desplegable)
//     minSeleccion, maxSeleccion|null  (casillas)
//     archivos: { tipos[], maxArchivos, maxMB }
//     escala: { min, max, etiquetaMin, etiquetaMax }
//     calificacion: { max }
//     filas[], columnas[]              (cuadrículas) }
// Las encuestas antiguas guardaban cada pregunta como un string; se leen como
// respuesta corta con el texto como id.

export function esc(texto) {
  return String(texto ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const TIPOS = [
  { valor: "corta", etiqueta: "Respuesta corta", icono: "Aa" },
  { valor: "parrafo", etiqueta: "Párrafo", icono: "¶" },
  { valor: "opcion_multiple", etiqueta: "Varias opciones", icono: "◉" },
  { valor: "casillas", etiqueta: "Casillas", icono: "☑" },
  { valor: "desplegable", etiqueta: "Desplegable", icono: "▾" },
  { valor: "archivos", etiqueta: "Subir archivos", icono: "⇪" },
  { valor: "escala", etiqueta: "Escala lineal", icono: "↔" },
  { valor: "calificacion", etiqueta: "Calificación", icono: "★" },
  { valor: "cuadricula_opciones", etiqueta: "Cuadrícula de varias opciones", icono: "▦" },
  { valor: "cuadricula_casillas", etiqueta: "Cuadrícula de casillas", icono: "▩" },
  { valor: "fecha", etiqueta: "Fecha", icono: "31" },
  { valor: "hora", etiqueta: "Hora", icono: "◔" }
];
export const TIPO_ETIQUETA = Object.fromEntries(TIPOS.map((t) => [t.valor, t.etiqueta]));
export const TIPO_ICONO = Object.fromEntries(TIPOS.map((t) => [t.valor, t.icono]));

export const LIMITES = {
  opciones: 30,
  filas: 20,
  columnas: 10,
  cantidadesArchivos: [1, 2, 3, 5, 10],
  tamanosMB: [1, 2, 5] // tope de la plataforma: 5 MB por archivo (viaja por Cloud Function)
};

export const CATEGORIAS_ARCHIVO = {
  pdf: { etiqueta: "PDF", exts: ["pdf"] },
  documento: { etiqueta: "Documento", exts: ["doc", "docx", "odt", "rtf", "txt"] },
  hoja: { etiqueta: "Hoja de cálculo", exts: ["xls", "xlsx", "ods", "csv"] },
  presentacion: { etiqueta: "Presentación", exts: ["ppt", "pptx", "odp"] },
  imagen: { etiqueta: "Imagen", exts: ["jpg", "jpeg", "png", "gif", "webp", "heic"] }
};

export const tipoConOpciones = (tipo) => tipo === "opcion_multiple" || tipo === "casillas" || tipo === "desplegable";
export const esCuadricula = (tipo) => tipo === "cuadricula_opciones" || tipo === "cuadricula_casillas";
// "encabezado" es un bloque de texto (título + descripción) entre preguntas,
// no una pregunta: no aparece en el selector "Tipo de pregunta" (no está en
// TIPOS) ni en formularios de respuesta/resultados/exportación.
export const esEncabezado = (tipo) => tipo === "encabezado";

// Tipos cuya respuesta guardada tiene la MISMA forma: al cambiar entre ellos,
// las respuestas ya recibidas siguen siendo válidas y la pregunta conserva su id.
const FAMILIA_RESPUESTA = {
  corta: "texto", parrafo: "texto",
  opcion_multiple: "una_opcion", desplegable: "una_opcion"
};
const familia = (tipo) => FAMILIA_RESPUESTA[tipo] || tipo;
export const mismaFamiliaRespuesta = (a, b) => familia(a) === familia(b);

export function nuevoId() {
  return "q" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

const lista = (v) => (Array.isArray(v) ? v.map(String) : []);

/** Completa cualquier pregunta (guardada o antigua) con todos sus campos por defecto. */
export function normalizarPregunta(p, i = 0) {
  if (typeof p === "string") p = { id: p, texto: p, tipo: "corta" };
  const tipo = p.tipo === "encabezado" || TIPO_ETIQUETA[p.tipo] ? p.tipo : "corta";
  const arc = p.archivos || {};
  const esca = p.escala || {};
  const tiposArchivo = lista(arc.tipos).filter((t) => CATEGORIAS_ARCHIVO[t]);
  return {
    id: p.id || `p${i + 1}`,
    texto: String(p.texto || ""),
    descripcion: String(p.descripcion || ""),
    tipo,
    obligatoria: p.obligatoria !== false,
    opciones: lista(p.opciones),
    filas: lista(p.filas),
    columnas: lista(p.columnas),
    minSeleccion: Number.isInteger(p.minSeleccion) ? p.minSeleccion : 0,
    maxSeleccion: Number.isInteger(p.maxSeleccion) ? p.maxSeleccion : null,
    archivos: {
      tipos: tiposArchivo.length ? tiposArchivo : ["pdf", "imagen", "documento"],
      maxArchivos: Number(arc.maxArchivos) || 1,
      maxMB: Number(arc.maxMB) || 5
    },
    escala: {
      min: esca.min === 0 ? 0 : 1,
      max: Number.isInteger(esca.max) ? esca.max : 5,
      etiquetaMin: String(esca.etiquetaMin || ""),
      etiquetaMax: String(esca.etiquetaMax || "")
    },
    calificacion: { max: Number.isInteger(p.calificacion?.max) ? p.calificacion.max : 5 }
  };
}

/** Deja listas las listas que el tipo necesita (opciones / filas / columnas). */
export function asegurarEstructura(q) {
  if (tipoConOpciones(q.tipo) && q.opciones.length === 0) q.opciones = ["Opción 1", "Opción 2"];
  if (esCuadricula(q.tipo)) {
    if (q.filas.length === 0) q.filas = ["Fila 1", "Fila 2"];
    if (q.columnas.length === 0) q.columnas = ["Columna 1", "Columna 2"];
  }
}

export function preguntaNueva(tipo = "corta") {
  const q = normalizarPregunta({ id: nuevoId(), tipo });
  asegurarEstructura(q);
  return q;
}

export function encabezadoNuevo() {
  return normalizarPregunta({ id: nuevoId(), tipo: "encabezado", obligatoria: false });
}

/**
 * Cambia el tipo de una pregunta del editor. Si la pregunta ya existía
 * (q.origen) y la forma de su respuesta cambia, recibe un id nuevo: así las
 * respuestas anteriores nunca se interpretan con la forma equivocada. Si el
 * creador vuelve al tipo original, recupera su id.
 */
export function cambiarTipo(q, tipo) {
  q.tipo = tipo;
  asegurarEstructura(q);
  if (q.origen) {
    q.id = familia(tipo) === familia(q.origen.tipo) ? q.origen.id : nuevoId();
  }
}

const enteroEntre = (v, min, max) => Math.min(Math.max(Number.isInteger(v) ? v : min, min), max);

/**
 * Convierte la pregunta del editor a su forma guardada. Con `estricto`,
 * lanza Error con un mensaje claro por lo que falte; sin él (borradores y
 * vista previa) corrige lo que pueda y sigue.
 */
export function serializarPregunta(q, estricto, i) {
  const falla = (mensaje) => {
    if (estricto) throw new Error(`Pregunta ${i + 1}: ${mensaje}`);
  };
  const limpiar = (items) => items.map((o) => o.trim()).filter(Boolean);
  const sinRepetidos = (items, nombre) => {
    if (new Set(items).size !== items.length) falla(`hay ${nombre} repetidas.`);
    return [...new Set(items)];
  };

  const texto = q.texto.trim();
  if (!texto) falla(q.tipo === "encabezado" ? "escribe el título del encabezado." : "escribe el enunciado.");
  const salida = { id: q.id, texto, tipo: q.tipo, obligatoria: !!q.obligatoria };
  const descripcion = q.descripcion.trim();
  if (descripcion) salida.descripcion = descripcion;

  if (q.tipo === "encabezado") return salida; // sin opciones/campos: solo título + descripción.

  if (tipoConOpciones(q.tipo)) {
    const opciones = sinRepetidos(limpiar(q.opciones), "opciones");
    if (opciones.length < 2) falla("necesita al menos 2 opciones.");
    salida.opciones = opciones;
    if (q.tipo === "casillas") {
      if (q.minSeleccion > opciones.length) falla(`el mínimo de respuestas no puede superar el número de opciones (${opciones.length}).`);
      const min = enteroEntre(q.minSeleccion, 0, opciones.length);
      let max = q.maxSeleccion;
      if (max !== null) {
        if (!Number.isInteger(max) || max < 1 || max > opciones.length) falla(`el máximo de respuestas debe estar entre 1 y ${opciones.length}.`);
        if (max < min) falla("el mínimo de respuestas no puede superar al máximo.");
        max = Math.max(enteroEntre(max, 1, opciones.length), min);
      }
      salida.minSeleccion = min;
      salida.maxSeleccion = max;
    }
  } else if (esCuadricula(q.tipo)) {
    const filas = sinRepetidos(limpiar(q.filas), "filas");
    const columnas = sinRepetidos(limpiar(q.columnas), "columnas");
    if (filas.length < 1) falla("agrega al menos una fila.");
    if (columnas.length < 2) falla("agrega al menos 2 columnas.");
    salida.filas = filas;
    salida.columnas = columnas;
  } else if (q.tipo === "archivos") {
    const tipos = q.archivos.tipos.filter((t) => CATEGORIAS_ARCHIVO[t]);
    if (tipos.length === 0) falla("elige al menos un tipo de archivo permitido.");
    salida.archivos = {
      tipos,
      maxArchivos: LIMITES.cantidadesArchivos.includes(q.archivos.maxArchivos) ? q.archivos.maxArchivos : 1,
      maxMB: LIMITES.tamanosMB.includes(q.archivos.maxMB) ? q.archivos.maxMB : 5
    };
  } else if (q.tipo === "escala") {
    const min = q.escala.min === 0 ? 0 : 1;
    const max = enteroEntre(q.escala.max, min + 1, 10);
    if (max <= min) falla("el máximo de la escala debe ser mayor que el mínimo.");
    salida.escala = {
      min,
      max,
      etiquetaMin: q.escala.etiquetaMin.trim().slice(0, 60),
      etiquetaMax: q.escala.etiquetaMax.trim().slice(0, 60)
    };
  } else if (q.tipo === "calificacion") {
    salida.calificacion = { max: enteroEntre(q.calificacion.max, 3, 10) };
  }
  return salida;
}

export function serializarPreguntas(borrador, estricto) {
  return borrador.map((q, i) => serializarPregunta(q, estricto, i));
}

export function textoLimitesCasillas(p) {
  const min = p.minSeleccion || 0;
  const max = p.maxSeleccion;
  if (min && max !== null) return min === max ? `Selecciona exactamente ${min}.` : `Selecciona entre ${min} y ${max}.`;
  if (min) return `Selecciona al menos ${min}.`;
  if (max !== null) return `Selecciona como máximo ${max}.`;
  return "";
}
