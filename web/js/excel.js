// Helpers compartidos para plantillas/carga masiva/exportación a Excel.
// Usa ExcelJS por CDN, sin build step (mismo patrón ya probado en LBDC Neiva).
import * as ExcelJSModule from "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/+esm";
export const ExcelJS = ExcelJSModule.default || ExcelJSModule;

export async function descargarWorkbook(wb, nombreArchivo) {
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombreArchivo;
  a.click();
  URL.revokeObjectURL(url);
}

export function estilizarEncabezado(ws) {
  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEB209" } };
    cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
  headerRow.height = 24;
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

const ANCHO_MIN_COLUMNA_EXCEL = 10;
const ANCHO_MAX_COLUMNA_EXCEL = 45;

/**
 * Ajusta el ancho de cada columna a su contenido real (encabezado + todas
 * las filas ya cargadas) — mismo criterio que calcularAnchosColumna() en
 * pdf.js para los informes en PDF: nunca una columna corta (Estado, Sí/No)
 * desperdiciando el mismo espacio que una de texto libre (Notas,
 * Propósitos). Se llama DESPUÉS de agregar todas las filas con
 * ws.addRow(...), nunca antes.
 */
export function ajustarAnchoColumnas(ws, opciones = {}) {
  const min = opciones.min ?? ANCHO_MIN_COLUMNA_EXCEL;
  const max = opciones.max ?? ANCHO_MAX_COLUMNA_EXCEL;
  ws.columns.forEach((columna) => {
    let ancho = String(columna.header || "").length;
    columna.eachCell({ includeEmpty: false }, (cell) => {
      const valor = cell.value;
      const texto = valor && typeof valor === "object" && Array.isArray(valor.richText)
        ? valor.richText.map((p) => p.text).join("")
        : String(valor ?? "");
      texto.split("\n").forEach((linea) => {
        if (linea.length > ancho) ancho = linea.length;
      });
    });
    columna.width = Math.min(Math.max(ancho + 2, min), max);
  });
}

export async function leerWorkbook(file) {
  const buffer = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

export function mapaEncabezados(ws) {
  const encabezados = {};
  ws.getRow(1).eachCell((cell, colNumber) => {
    encabezados[String(cell.value || "").trim().toLowerCase()] = colNumber;
  });
  return encabezados;
}

export function valorCelda(row, colNumber) {
  if (!colNumber) return "";
  const v = row.getCell(colNumber).value;
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && v.text != null) return String(v.text).trim();
  if (typeof v === "object" && v.result != null) return String(v.result).trim();
  return String(v).trim();
}

/**
 * Recorre todas las filas de datos (desde la fila 2) de una hoja y devuelve
 * un arreglo de { rowNumber, row } saltando las filas completamente vacías.
 */
export function filasConDatos(ws) {
  const filas = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const vacia = row.values.every((v) => v == null || String(v).trim() === "");
    if (!vacia) filas.push({ rowNumber, row });
  });
  return filas;
}
