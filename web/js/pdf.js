// Generación de PDF con formato cuidado (tipo APA) para los informes y
// programaciones imprimibles de la app. Usa jsPDF + jspdf-autotable,
// cargados como <script> clásicos (no ES modules) en cada página que los
// necesita — ver las etiquetas <script> antes del script type="module" en
// el HTML — porque el plugin autoTable necesita parchar el mismo jsPDF
// global, cosa que no es confiable si cada uno se importa como módulo
// aparte desde un CDN.

const PIE_PAGINA_TEXTO = "Cinco S.A.S. — Cinco Conecta";

export function crearDocumentoPDF(orientacion = "landscape") {
  const { jsPDF } = window.jspdf;
  return new jsPDF({ orientation: orientacion, unit: "mm", format: "letter" });
}

/**
 * Encabezado tipo portada APA (institución en negrita, título centrado,
 * una línea que exprese el propósito/amor por la obra, y la fecha de
 * generación). Devuelve el "y" donde debería empezar el contenido/tabla.
 */
export function agregarEncabezado(doc, institucion, titulo, subtitulo) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  let y = 16;

  doc.setFont("times", "bold");
  doc.setFontSize(16);
  doc.text(institucion, anchoPagina / 2, y, { align: "center" });

  y += 8;
  doc.setFontSize(13);
  doc.text(titulo, anchoPagina / 2, y, { align: "center" });

  y += 7;
  doc.setFont("times", "italic");
  doc.setFontSize(10.5);
  doc.text(subtitulo, anchoPagina / 2, y, { align: "center" });

  y += 6;
  doc.setFont("times", "normal");
  doc.setFontSize(9);
  const fecha = new Date().toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric" });
  doc.text(`Generado el ${fecha}`, anchoPagina / 2, y, { align: "center" });

  return y + 7;
}

const TABLA_FONT = "times"; // Times en toda la tabla (formato APA), compacto por tamaño/relleno reducidos, no por cambio de tipografía
const TABLA_FONT_SIZE = 8;
const TABLA_CELL_PADDING = 1.8;
const ANCHO_MIN_COLUMNA = 14; // mm — nunca más angosta que esto (evita partir "No"/"Sí" letra por letra)
const ANCHO_MAX_COLUMNA = 70; // mm — techo por columna: pasado esto, mejor que el texto haga salto de línea
const UMBRAL_COLUMNA_CORTA = 26; // mm — columnas que ya caben solas (fechas, números, "Sí/No") no se comprimen

/**
 * Calcula, columna por columna, el ancho mínimo real que necesita su
 * contenido más largo (encabezado o cualquier fila, línea por línea si trae
 * saltos de línea) — así cada informe se ajusta solo, sin tener que fijar
 * anchos a mano por reporte. Las columnas "cortas" (fechas, números,
 * Sí/No...) conservan su ancho exacto; el espacio restante de la página se
 * reparte entre las columnas de texto largo, en proporción a cuánto
 * necesita cada una — si no alcanza, esas absorben el recorte (con salto de
 * línea) en vez de angostar las columnas cortas.
 */
function calcularAnchosColumna(doc, columnas, filas) {
  const anchoDisponible = doc.internal.pageSize.getWidth() - 24; // margen izq. 12 + der. 12

  doc.setFont(TABLA_FONT, "bold");
  doc.setFontSize(TABLA_FONT_SIZE);
  const ideales = columnas.map((titulo) => doc.getTextWidth(String(titulo ?? "")) + 6);

  doc.setFont(TABLA_FONT, "normal");
  // Las filas con celdas fusionadas (rowSpan, ej. Cita diaria cuando una
  // cita tiene varios pasajes) traen menos celdas que columnas — no se
  // puede saber a qué columna corresponde cada una sin repetir la lógica de
  // rowSpan del informe, así que solo se miden las filas completas; es
  // información de sobra para calcular un ancho razonable por columna.
  filas.forEach((fila) => {
    if (fila.length !== columnas.length) return;
    fila.forEach((valor, i) => {
      const contenido = valor && typeof valor === "object" ? valor.content : valor;
      if (contenido === undefined || contenido === null) return;
      String(contenido).split("\n").forEach((linea) => {
        const ancho = doc.getTextWidth(linea) + 6;
        if (ancho > ideales[i]) ideales[i] = ancho;
      });
    });
  });

  const anchos = ideales.map((a) => Math.min(Math.max(a, ANCHO_MIN_COLUMNA), ANCHO_MAX_COLUMNA));
  const esCorta = anchos.map((a) => a <= UMBRAL_COLUMNA_CORTA);
  const anchoCortas = anchos.reduce((suma, a, i) => suma + (esCorta[i] ? a : 0), 0);
  const idealLargas = anchos.reduce((suma, a, i) => suma + (esCorta[i] ? 0 : a), 0);
  const disponibleParaLargas = Math.max(anchoDisponible - anchoCortas, 0);
  const factorLargas = idealLargas > 0 ? Math.min(disponibleParaLargas / idealLargas, 1) : 1;

  const anchosFinales = anchos.map((ancho, i) => (esCorta[i] ? ancho : ancho * factorLargas));

  // Si ninguna columna larga absorbió el espacio sobrante (ej. una tabla con
  // solo columnas cortas, como "Campo/Detalle" de una sola fila), la tabla
  // quedaría angosta y dejaría un vacío a la derecha en vez de llenar la
  // página de borde a borde — se reparte ese sobrante proporcionalmente
  // entre todas las columnas para que toda tabla, sin importar su
  // contenido, ocupe siempre el ancho completo disponible.
  const anchoUsado = anchosFinales.reduce((suma, a) => suma + a, 0);
  const sobra = anchoDisponible - anchoUsado;
  if (sobra > 0.5 && anchoUsado > 0) {
    anchosFinales.forEach((ancho, i) => {
      anchosFinales[i] = ancho + sobra * (ancho / anchoUsado);
    });
  }

  const columnStyles = {};
  anchosFinales.forEach((ancho, i) => {
    columnStyles[i] = { cellWidth: ancho };
  });
  return columnStyles;
}

/**
 * `opciones.columnStyles` (opcional) fuerza el ancho de alguna columna en
 * particular si hiciera falta un caso especial — por defecto los anchos se
 * calculan solos con calcularAnchosColumna() según el contenido real de
 * cada informe, así ninguno queda desperdiciando espacio ni demasiado largo.
 * `opciones.headStyles`/`alternateRowStyles` permiten variar la paleta de
 * color de una tabla puntual (ej. la sección dorada de "Resumen general" en
 * el plan de actividades) sin perder el cálculo automático de anchos.
 */
export function agregarTabla(doc, columnas, filas, startY, opciones = {}) {
  const anchosAutomaticos = calcularAnchosColumna(doc, columnas, filas);
  const columnStyles = { ...anchosAutomaticos };
  Object.entries(opciones.columnStyles || {}).forEach(([i, estilo]) => {
    columnStyles[i] = { ...columnStyles[i], ...estilo };
  });

  doc.autoTable({
    startY,
    head: [columnas],
    body: filas,
    styles: { font: TABLA_FONT, fontSize: TABLA_FONT_SIZE, cellPadding: TABLA_CELL_PADDING, valign: "top", lineColor: [200, 200, 200], overflow: "linebreak" },
    headStyles: { fillColor: [31, 39, 50], textColor: 255, fontStyle: "bold", ...opciones.headStyles },
    alternateRowStyles: { fillColor: [244, 245, 247], ...opciones.alternateRowStyles },
    columnStyles,
    margin: { left: 12, right: 12, bottom: 18 }
  });
}

/** Pie de página en todas las hojas: "Colombia para Cristo" + número de página. */
export function agregarPiePagina(doc) {
  const totalPaginas = doc.internal.getNumberOfPages();
  const anchoPagina = doc.internal.pageSize.getWidth();
  const altoPagina = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= totalPaginas; i++) {
    doc.setPage(i);
    doc.setFont("times", "italic");
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(PIE_PAGINA_TEXTO, anchoPagina / 2, altoPagina - 8, { align: "center" });
    doc.setFont("times", "normal");
    doc.text(`Página ${i} de ${totalPaginas}`, anchoPagina - 12, altoPagina - 8, { align: "right" });
    doc.setTextColor(0);
  }
}

export function descargarPDF(doc, nombreArchivo) {
  doc.save(nombreArchivo);
}
