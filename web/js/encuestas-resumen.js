// Resumen estadístico de UNA pregunta a partir de las respuestas recibidas.
// Lo usan tanto la pantalla de resultados como la exportación a Excel, así
// ambas mantienen la misma distinción entre tipos (una opción vs. varias,
// una respuesta por fila vs. varias por fila). Es defensivo: ignora
// respuestas con una forma que no corresponde al tipo actual de la pregunta
// (p. ej. de antes de que el creador cambiara el tipo).
import { tipoConOpciones, esCuadricula } from "./encuestas-tipos.js";

const esTexto = (v) => typeof v === "string" && v !== "";

/**
 * `respuestas`: arreglo de documentos { respuestas: { [idPregunta]: valor } }.
 * Devuelve { tipo, n (personas que respondieron esta pregunta), ...detalle }.
 */
export function resumirPregunta(p, respuestas) {
  const valores = respuestas.map((r) => r.respuestas?.[p.id]).filter((v) => v !== undefined && v !== null && v !== "");
  const base = { tipo: p.tipo };

  if (tipoConOpciones(p.tipo)) {
    const conteo = new Map(p.opciones.map((o) => [o, 0]));
    let otras = 0;
    let n = 0;
    valores.forEach((v) => {
      const lista = p.tipo === "casillas" ? (Array.isArray(v) ? v : null) : (esTexto(v) ? [v] : null);
      if (!lista || lista.length === 0) return;
      n++;
      lista.forEach((o) => {
        if (conteo.has(o)) conteo.set(o, conteo.get(o) + 1);
        else otras++;
      });
    });
    return { ...base, n, opciones: p.opciones.map((o) => ({ etiqueta: o, n: conteo.get(o) })), otras, multiple: p.tipo === "casillas" };
  }

  if (p.tipo === "escala" || p.tipo === "calificacion") {
    const min = p.tipo === "escala" ? p.escala.min : 1;
    const max = p.tipo === "escala" ? p.escala.max : p.calificacion.max;
    const validos = valores.filter((v) => Number.isInteger(v) && v >= min && v <= max);
    const distribucion = [];
    for (let v = min; v <= max; v++) distribucion.push({ valor: v, n: validos.filter((x) => x === v).length });
    const promedio = validos.length ? validos.reduce((a, b) => a + b, 0) / validos.length : null;
    return { ...base, n: validos.length, distribucion, promedio, min, max };
  }

  if (esCuadricula(p.tipo)) {
    const multiple = p.tipo === "cuadricula_casillas";
    const celdas = p.filas.map(() => p.columnas.map(() => 0));
    const respondieronFila = p.filas.map(() => 0);
    let n = 0;
    valores.forEach((v) => {
      if (!Array.isArray(v) || v.length === 0) return;
      n++;
      v.forEach((item) => {
        const j = p.filas.indexOf(item?.fila);
        if (j < 0) return;
        const elegidas = multiple ? (Array.isArray(item.valores) ? item.valores : []) : (esTexto(item.valor) ? [item.valor] : []);
        const validas = elegidas.filter((c) => p.columnas.includes(c));
        if (validas.length === 0) return;
        respondieronFila[j]++;
        validas.forEach((c) => { celdas[j][p.columnas.indexOf(c)]++; });
      });
    });
    return { ...base, n, multiple, filas: p.filas, columnas: p.columnas, celdas, respondieronFila };
  }

  if (p.tipo === "archivos") {
    const archivos = valores.flatMap((v) => (Array.isArray(v) ? v.filter((a) => a && a.path) : []));
    return { ...base, n: valores.filter((v) => Array.isArray(v) && v.length).length, archivos };
  }

  // corta / parrafo / fecha / hora
  const textos = valores.filter(esTexto);
  if (p.tipo === "fecha" || p.tipo === "hora") textos.sort();
  return { ...base, n: textos.length, textos };
}

/** "2026-09-21" → "21/09/2026" (las demás cadenas se devuelven igual). */
export function formatoFechaIso(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : texto;
}

export function formatoTamanoArchivo(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
