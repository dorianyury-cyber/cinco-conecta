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
