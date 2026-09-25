// HTML de los resultados de una encuesta (solo quien tiene el permiso
// "encuestas" los ve). Cada tipo se muestra según su naturaleza: opciones con
// barras (una vs. varias), promedio y distribución en escalas/calificaciones,
// matriz fila × columna en las cuadrículas, lista de archivos, etc.
import { esc, TIPO_ETIQUETA, normalizarPregunta, esEncabezado } from "./encuestas-tipos.js";
import { resumirPregunta, formatoFechaIso, formatoTamanoArchivo } from "./encuestas-resumen.js";

const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

function htmlBarras(items, base) {
  return items.map(({ etiqueta, n }) => `
    <div class="resultado-opcion">
      ${esc(etiqueta)} — <strong>${n}</strong> <span class="text-muted">(${pct(n, base)}%)</span>
      <div class="progreso-bar"><div class="progreso-fill" style="width:${pct(n, base)}%"></div></div>
    </div>`).join("");
}

function htmlDetalle(r) {
  switch (r.tipo) {
    case "opcion_multiple":
    case "desplegable":
    case "casillas":
      return `${htmlBarras(r.opciones, r.n)}
        ${r.otras ? `<p class="text-muted text-sm m-0">${r.otras} respuesta(s) a opciones que ya no existen en la encuesta.</p>` : ""}
        ${r.multiple ? '<p class="text-muted text-sm m-0">Selección múltiple: cada persona pudo marcar varias opciones, por eso los porcentajes pueden sumar más de 100%.</p>' : ""}`;

    case "escala":
    case "calificacion": {
      const etiqueta = (v) => (r.tipo === "calificacion" ? `${v} ${v === 1 ? "estrella" : "estrellas"}` : String(v));
      return `${r.promedio === null ? "" : `<p class="resultado-promedio">Promedio: <strong>${r.promedio.toFixed(2)}</strong> <span class="text-muted">de ${r.max}</span></p>`}
        ${htmlBarras(r.distribucion.map((d) => ({ etiqueta: etiqueta(d.valor), n: d.n })), r.n)}`;
    }

    case "cuadricula_opciones":
    case "cuadricula_casillas": {
      const maximo = Math.max(1, ...r.celdas.flat());
      return `<div class="cuadricula-wrap"><table class="tabla-resultados">
        <colgroup><col style="width:28%">${r.columnas.map(() => "<col>").join("")}</colgroup>
        <thead><tr><th></th>${r.columnas.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>${r.filas.map((f, j) => `<tr><th scope="row">${esc(f)}</th>${r.columnas.map((c, k) => {
          const n = r.celdas[j][k];
          return `<td style="--intensidad:${(n / maximo).toFixed(2)}"><strong>${n}</strong> <span class="text-muted">(${pct(n, r.respondieronFila[j])}%)</span></td>`;
        }).join("")}</tr>`).join("")}</tbody>
      </table></div>
      <p class="text-muted text-sm m-0">${r.multiple
        ? "Cada persona pudo marcar varias opciones por fila; el porcentaje es sobre las personas que respondieron esa fila."
        : "Una opción por fila; el porcentaje es sobre las personas que respondieron esa fila."}</p>`;
    }

    case "archivos":
      return r.archivos.length === 0
        ? '<p class="text-muted text-sm">Sin archivos.</p>'
        : `<ul class="lista-simple">${r.archivos.map((a) => `
            <li><button type="button" class="link-btn" data-accion="descargar-archivo" data-path="${esc(a.path)}" data-nombre="${esc(a.nombre)}">${esc(a.nombre)}</button>
              <span class="text-muted text-sm">${formatoTamanoArchivo(a.tamano)}</span></li>`).join("")}</ul>`;

    default:
      return r.textos.length === 0
        ? '<p class="text-muted text-sm">Sin respuestas.</p>'
        : `<ul class="lista-simple">${r.textos.map((t) => `<li>${esc(r.tipo === "fecha" ? formatoFechaIso(t) : t)}</li>`).join("")}</ul>`;
  }
}

function htmlPregunta(p, respuestas) {
  const r = resumirPregunta(p, respuestas);
  const sub = r.tipo === "archivos" ? `${r.archivos.length} archivo(s)` : `${r.n} respuesta(s)`;
  return `
    <div class="resultado-pregunta">
      <strong>${esc(p.texto)}</strong>
      <span class="text-muted text-sm"> · ${TIPO_ETIQUETA[p.tipo]} · ${sub}</span>
      ${htmlDetalle(r)}
    </div>`;
}

// Las encuestas antiguas guardaban cada pregunta como texto con una escala 1-5.
function htmlPromediosAntiguos(respuestas) {
  const sumas = {};
  const conteos = {};
  respuestas.forEach((r) => {
    Object.entries(r.respuestas || {}).forEach(([pregunta, valor]) => {
      if (typeof valor !== "number") return;
      sumas[pregunta] = (sumas[pregunta] || 0) + valor;
      conteos[pregunta] = (conteos[pregunta] || 0) + 1;
    });
  });
  return `<ul class="lista-simple">
    ${Object.keys(sumas).map((p) => `<li>${esc(p)}: <strong>${(sumas[p] / conteos[p]).toFixed(1)} / 5</strong></li>`).join("")}
  </ul>`;
}

export function htmlResultados(enc, respuestas) {
  const preguntasEnc = enc.preguntas || [];
  const detalle = preguntasEnc.length && typeof preguntasEnc[0] === "string"
    ? htmlPromediosAntiguos(respuestas)
    : preguntasEnc.map(normalizarPregunta).filter((p) => !esEncabezado(p.tipo)).map((p) => htmlPregunta(p, respuestas)).join("");
  const comentarios = respuestas.map((r) => r.comentario).filter(Boolean);
  return `
    <p class="text-muted text-sm">${respuestas.length} respuesta(s) en total</p>
    ${detalle}
    ${comentarios.length ? `
      <div class="resultado-pregunta"><strong>Comentarios</strong>
        <ul class="lista-simple">${comentarios.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      </div>` : ""}`;
}
