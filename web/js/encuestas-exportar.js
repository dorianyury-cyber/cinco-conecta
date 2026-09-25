// Exportación de resultados de una encuesta a Excel (ExcelJS). Dos hojas:
//  · "Resumen": conteos y porcentajes por pregunta, con la misma distinción
//    que en pantalla (una opción vs. varias; una respuesta por fila vs. varias).
//  · "Respuestas": una fila por persona (anónima). Casillas y cuadrícula de
//    casillas llevan sus varias opciones separadas por "; "; la cuadrícula
//    tiene UNA columna por fila, así "una por fila" / "varias por fila" se
//    conserva. Sin ningún dato que identifique a quien respondió.
import { ExcelJS, descargarWorkbook, estilizarEncabezado, ajustarAnchoColumnas } from "./excel.js";
import { TIPO_ETIQUETA, normalizarPregunta, esCuadricula, esEncabezado } from "./encuestas-tipos.js";
import { resumirPregunta, formatoFechaIso } from "./encuestas-resumen.js";

const nombreSeguro = (texto) => String(texto).replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "encuesta";
const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

function filasResumen(p, r) {
  const t = TIPO_ETIQUETA[p.tipo];
  const filas = [];
  const agregar = (detalle, n, base) => filas.push([p.texto, t, detalle, n, base === null ? "" : `${pct(n, base)}%`]);

  if (r.opciones) {
    r.opciones.forEach((o) => agregar(o.etiqueta, o.n, r.n));
    if (r.otras) agregar("(opción que ya no existe)", r.otras, null);
  } else if (r.distribucion) {
    r.distribucion.forEach((d) => agregar(`Valor ${d.valor}`, d.n, r.n));
    if (r.promedio !== null) filas.push([p.texto, t, "Promedio", Number(r.promedio.toFixed(2)), ""]);
  } else if (r.celdas) {
    r.filas.forEach((f, j) => r.columnas.forEach((c, k) => agregar(`${f} › ${c}`, r.celdas[j][k], r.respondieronFila[j])));
  } else if (r.archivos) {
    filas.push([p.texto, t, "Archivos recibidos", r.archivos.length, ""]);
  } else {
    filas.push([p.texto, t, "Respuestas recibidas", r.n, ""]);
  }
  return filas;
}

function celdaRespuesta(p, valor) {
  if (valor === undefined || valor === null || valor === "") return "";
  switch (p.tipo) {
    case "casillas":
      return Array.isArray(valor) ? valor.join("; ") : "";
    case "archivos":
      return Array.isArray(valor) ? valor.map((a) => a.nombre).join("; ") : "";
    case "fecha":
      return formatoFechaIso(valor);
    default:
      return valor;
  }
}

export async function exportarResultadosExcel(enc, respuestas) {
  const preguntas = (enc.preguntas || []).map(normalizarPregunta).filter((p) => !esEncabezado(p.tipo));
  const wb = new ExcelJS.Workbook();

  // ---- Resumen ----
  const wsResumen = wb.addWorksheet("Resumen");
  wsResumen.columns = [
    { header: "Pregunta", key: "p" },
    { header: "Tipo", key: "t" },
    { header: "Opción / detalle", key: "d" },
    { header: "Respuestas", key: "n" },
    { header: "%", key: "pc" }
  ];
  preguntas.forEach((p) => filasResumen(p, resumirPregunta(p, respuestas)).forEach((f) => wsResumen.addRow(f)));
  estilizarEncabezado(wsResumen);
  ajustarAnchoColumnas(wsResumen, { max: 60 });
  wsResumen.eachRow((row, i) => {
    if (i > 1) row.alignment = { vertical: "top", wrapText: true };
  });

  // ---- Respuestas (una fila por persona) ----
  const wsResp = wb.addWorksheet("Respuestas");
  const columnas = [{ header: "N.º", key: "n" }, { header: "Fecha", key: "f" }];
  preguntas.forEach((p, i) => {
    if (esCuadricula(p.tipo)) {
      p.filas.forEach((fila, j) => columnas.push({ header: `${p.texto} [${fila}]`, key: `p${i}_${j}` }));
    } else {
      columnas.push({ header: p.texto, key: `p${i}` });
    }
  });
  columnas.push({ header: "Comentario", key: "c" });
  wsResp.columns = columnas;

  respuestas.forEach((r, k) => {
    const fila = { n: k + 1, f: r.creadoEn?.toDate ? r.creadoEn.toDate().toLocaleString("es-CO") : "", c: r.comentario || "" };
    preguntas.forEach((p, i) => {
      const valor = r.respuestas?.[p.id];
      if (esCuadricula(p.tipo)) {
        p.filas.forEach((f, j) => {
          const item = Array.isArray(valor) ? valor.find((x) => x?.fila === f) : null;
          fila[`p${i}_${j}`] = !item ? "" : (p.tipo === "cuadricula_casillas" ? (item.valores || []).join("; ") : item.valor || "");
        });
      } else {
        fila[`p${i}`] = celdaRespuesta(p, valor);
      }
    });
    wsResp.addRow(fila);
  });
  estilizarEncabezado(wsResp);
  ajustarAnchoColumnas(wsResp, { max: 40 });
  wsResp.eachRow((row, i) => {
    if (i > 1) row.alignment = { vertical: "top", wrapText: true };
  });

  await descargarWorkbook(wb, `Resultados - ${nombreSeguro(enc.titulo)}.xlsx`);
}
