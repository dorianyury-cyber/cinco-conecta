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
function calcularAnchosColumna(doc, columnas, filas, margenIzq = 12, margenDer = 12) {
  const anchoDisponible = doc.internal.pageSize.getWidth() - margenIzq - margenDer;

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
  const margin = { left: 12, right: 12, bottom: 18, ...opciones.margin };
  const anchosAutomaticos = calcularAnchosColumna(doc, columnas, filas, margin.left, margin.right);
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
    margin
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

// ---------------------------------------------------------------------
// Informes de interventoría (formato libre) — funciones aditivas, no
// tocan nada de lo anterior. Portada estilo APA + control documental ISO
// 9001, y bloques de contenido (títulos numerados, párrafos, imágenes,
// tablas, gráficos) que el editor de bloques va ensamblando en orden.
// ---------------------------------------------------------------------

const AMBAR = [254, 178, 9];
const AMBAR_OSCURO = [217, 148, 0];
const NAVY = [31, 39, 50];

// Margen real de Norma APA (1 pulgada = 2.54cm) en todo el informe de
// formato libre — a diferencia del resto de reportes de la plataforma
// (auditorías, HSEQ, etc.), que siguen usando 12mm por su propio criterio
// de espacio optimizado y no cambian con esto.
const MARGEN_APA = 25.4;

function colorPaleta(i, total) {
  if (total <= 1) return AMBAR;
  const t = i / (total - 1);
  return AMBAR.map((c, idx) => Math.round(c + (NAVY[idx] - c) * t));
}

function formatearFechaInforme(fecha) {
  if (!fecha) return "—";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? new Date(`${fecha}T12:00:00`) : new Date(fecha);
  if (Number.isNaN(d.getTime())) return String(fecha);
  return d.toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric" });
}

function saltoDePaginaSiNecesario(doc, y, alturaNecesaria) {
  const altoPagina = doc.internal.pageSize.getHeight();
  if (y + alturaNecesaria > altoPagina - MARGEN_APA) {
    doc.addPage();
    return MARGEN_APA; // ya deja espacio de sobra bajo el encabezado de marca (ver agregarEncabezadoPiePaginaInforme)
  }
  return y;
}

/** Nuevo contador { figura, tabla } — pásalo a todas las funciones de bloque de un mismo informe. */
export function crearContadoresInforme() {
  return { figura: 0, tabla: 0 };
}

/**
 * Portada del informe de formato libre: título/cliente/proyecto centrados
 * (estilo APA) + una mini-tabla de control documental (Código/Versión/
 * Fecha/Elaborado por) estilo ISO 9001. Termina la página y devuelve el
 * "y" inicial (20) para que el contenido empiece en una página nueva.
 */
export function agregarPortadaInforme(doc, { titulo, cliente, identificacionCliente, proyecto, codigo, version, autor, fecha }) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  let y = 42;

  doc.setFont("times", "bold");
  doc.setFontSize(20);
  doc.text("Cinco S.A.S.", anchoPagina / 2, y, { align: "center" });

  y += 6;
  doc.setDrawColor(...AMBAR);
  doc.setLineWidth(1);
  doc.line(anchoPagina / 2 - 28, y, anchoPagina / 2 + 28, y);

  y += 18;
  doc.setFont("times", "bold");
  doc.setFontSize(16);
  const lineasTitulo = doc.splitTextToSize(titulo || "Informe de interventoría", anchoPagina - 50);
  doc.text(lineasTitulo, anchoPagina / 2, y, { align: "center" });
  y += lineasTitulo.length * 7 + 8;

  doc.setFont("times", "normal");
  doc.setFontSize(12);
  if (cliente) {
    const sufijoId = identificacionCliente ? ` (${identificacionCliente})` : "";
    doc.text(`Cliente: ${cliente}${sufijoId}`, anchoPagina / 2, y, { align: "center" });
    y += 6.5;
  }
  if (proyecto) {
    doc.text(`Proyecto: ${proyecto}`, anchoPagina / 2, y, { align: "center" });
    y += 6.5;
  }

  y += 8;
  doc.setFont("times", "italic");
  doc.setFontSize(10.5);
  doc.text(`Elaborado por ${autor || "—"} · ${formatearFechaInforme(fecha)}`, anchoPagina / 2, y, { align: "center" });

  const altoPagina = doc.internal.pageSize.getHeight();
  const filasControl = [
    ["Código", codigo || "—"],
    ["Versión", version || "1.0"],
    ["Fecha", formatearFechaInforme(fecha)],
    ["Elaborado por", autor || "—"]
  ];
  const anchoTabla = 100;
  const xTabla = (anchoPagina - anchoTabla) / 2;
  const yTabla = altoPagina - 65;

  doc.setDrawColor(200, 200, 200);
  doc.rect(xTabla, yTabla - 6, anchoTabla, filasControl.length * 7 + 6);
  doc.setFontSize(9);
  filasControl.forEach(([etiqueta, valor], i) => {
    const yFila = yTabla + i * 7;
    doc.setFont("times", "bold");
    doc.text(etiqueta, xTabla + 4, yFila);
    doc.setFont("times", "normal");
    doc.text(String(valor), xTabla + 36, yFila);
  });

  doc.addPage();
  return MARGEN_APA;
}

/**
 * Encabezado y pie de página de marca en todas las páginas de contenido
 * (no en la portada, que ya tiene su propio diseño) — logo de Cinco a la
 * izquierda, título abreviado tipo "running head" de APA a la derecha, y
 * en el pie el código de control documental + numeración de página.
 * `logoImg` es opcional (un HTMLImageElement ya cargado); si no se pasa,
 * simplemente no se dibuja el logo.
 */
export function agregarEncabezadoPiePaginaInforme(doc, { logoImg, titulo, codigo }) {
  const totalPaginas = doc.internal.getNumberOfPages();
  const anchoPagina = doc.internal.pageSize.getWidth();
  const altoPagina = doc.internal.pageSize.getHeight();
  const tituloBase = (titulo || "").toUpperCase();
  const tituloCorto = tituloBase.length > 60 ? `${tituloBase.slice(0, 60)}…` : tituloBase;

  for (let i = 2; i <= totalPaginas; i++) {
    doc.setPage(i);

    if (logoImg) {
      const altoLogo = 8;
      const proporcion = (logoImg.naturalWidth || 900) / (logoImg.naturalHeight || 433);
      doc.addImage(logoImg, "PNG", 12, 7, altoLogo * proporcion, altoLogo);
    }
    doc.setFont("times", "bold");
    doc.setFontSize(8);
    doc.setTextColor(90);
    doc.text(tituloCorto, anchoPagina - 12, 11, { align: "right" });
    doc.setTextColor(0);
    doc.setDrawColor(...AMBAR);
    doc.setLineWidth(0.5);
    doc.line(12, 18, anchoPagina - 12, 18);

    doc.setDrawColor(...AMBAR);
    doc.setLineWidth(0.5);
    doc.line(12, altoPagina - 14, anchoPagina - 12, altoPagina - 14);
    doc.setFont("times", "italic");
    doc.setFontSize(8.5);
    doc.setTextColor(90);
    doc.text(`Cinco S.A.S. · ${codigo || ""}`, 12, altoPagina - 9);
    doc.setFont("times", "normal");
    doc.text(`Página ${i - 1} de ${totalPaginas - 1}`, anchoPagina - 12, altoPagina - 9, { align: "right" });
    doc.setTextColor(0);
  }
}

/**
 * Sección de Referencias en formato APA (orden alfabético, sangría
 * francesa), siempre en página nueva al final del informe — se agrega
 * incluso si el usuario no escribió ninguna referencia propia, porque el
 * arreglo `referencias` siempre trae por defecto las normas técnicas base
 * de Cinco S.A.S. (ver REFERENCIAS_POR_DEFECTO en informes-libres.js).
 */
export function agregarSeccionReferencias(doc, referencias) {
  const lista = (referencias || []).filter((r) => r && r.trim());
  if (lista.length === 0) return;

  doc.addPage();
  const anchoPagina = doc.internal.pageSize.getWidth();
  let y = 25;
  doc.setFont("times", "bold");
  doc.setFontSize(13);
  doc.text("Referencias", anchoPagina / 2, y, { align: "center" });
  y += 12;

  doc.setFont("times", "normal");
  doc.setFontSize(10.5);
  const sangria = 8;
  const anchoContenido = anchoPagina - MARGEN_APA * 2 - sangria;
  const ordenadas = [...lista].sort((a, b) => a.localeCompare(b, "es"));
  ordenadas.forEach((ref) => {
    const lineas = doc.splitTextToSize(ref.trim(), anchoContenido);
    lineas.forEach((linea, i) => {
      y = saltoDePaginaSiNecesario(doc, y, 6);
      doc.text(linea, i === 0 ? MARGEN_APA : MARGEN_APA + sangria, y);
      y += 5.8;
    });
    y += 3;
  });
}

/** Título de nivel 1/2/3 ya numerado (ej. "2.1. Hallazgos"). Nivel 1
 * centrado y nivel 2/3 alineados a la izquierda, siguiendo la jerarquía
 * visual de los niveles de encabezado de APA (adaptada a la numeración
 * que pidió el usuario, que APA en sí no usa). */
export function agregarBloqueTitulo(doc, y, nivel, numero, texto) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const anchoContenido = anchoPagina - MARGEN_APA * 2;
  let yActual = saltoDePaginaSiNecesario(doc, y, 14);

  const tamanos = { 1: 14, 2: 12, 3: 11 };
  doc.setFont("times", nivel === 3 ? "bolditalic" : "bold");
  doc.setFontSize(tamanos[nivel] || 11);
  const textoCompleto = numero ? `${numero}. ${texto || ""}` : String(texto || "");
  const lineas = doc.splitTextToSize(textoCompleto, anchoContenido);
  if (nivel === 1) {
    doc.text(lineas, anchoPagina / 2, yActual, { align: "center" });
  } else {
    doc.text(lineas, MARGEN_APA, yActual);
  }
  yActual += lineas.length * ((tamanos[nivel] || 11) / 2.1) + 3;

  if (nivel === 1) {
    doc.setDrawColor(...AMBAR);
    doc.setLineWidth(0.6);
    doc.line(MARGEN_APA, yActual - 2, MARGEN_APA + anchoContenido, yActual - 2);
    yActual += 3;
  }
  return yActual;
}

/** Párrafo de texto libre, con salto de página automático línea por línea. */
export function agregarBloqueParrafo(doc, y, texto) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const anchoContenido = anchoPagina - MARGEN_APA * 2;
  doc.setFont("times", "normal");
  doc.setFontSize(10.5);
  const lineas = doc.splitTextToSize(texto || "", anchoContenido);
  const alturaLinea = 5.2;
  let yActual = y;
  lineas.forEach((linea) => {
    yActual = saltoDePaginaSiNecesario(doc, yActual, alturaLinea);
    doc.text(linea, MARGEN_APA, yActual);
    yActual += alturaLinea;
  });
  return yActual + 3;
}

/**
 * Imagen escalada al ancho del contenido preservando proporción,
 * centrada, con "Figura N. {título}" centrado ARRIBA y, si hay nota/
 * fuente ("pie"), centrada debajo en cursiva — estilo APA. También se usa
 * para tablas que el usuario sube como imagen (screenshot de Excel/Word)
 * en vez de datos estructurados: pasa `etiqueta="Tabla"` para que use el
 * contador y el rótulo de tabla en lugar de figura. Es async porque
 * necesita cargar la imagen para leer sus dimensiones naturales antes de
 * calcular el alto final.
 */
export function agregarBloqueImagen(doc, y, dataUrl, titulo, pie, contadores, etiqueta = "Figura") {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const anchoPagina = doc.internal.pageSize.getWidth();
      const anchoContenido = anchoPagina - MARGEN_APA * 2;
      const centroX = anchoPagina / 2;
      const escala = Math.min(anchoContenido / img.naturalWidth, 1);
      const anchoFinal = img.naturalWidth * escala;
      const altoFinal = img.naturalHeight * escala;

      const numero = etiqueta === "Tabla" ? (contadores.tabla += 1) : (contadores.figura += 1);
      let yActual = saltoDePaginaSiNecesario(doc, y, altoFinal + 20);
      doc.setFont("times", "bold");
      doc.setFontSize(10);
      doc.text(`${etiqueta} ${numero}.${titulo ? " " + titulo : ""}`, centroX, yActual, { align: "center" });
      yActual += 6;

      const x = MARGEN_APA + (anchoContenido - anchoFinal) / 2;
      const formato = dataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
      doc.addImage(dataUrl, formato, x, yActual, anchoFinal, altoFinal);
      yActual += altoFinal + 5;

      if (pie) {
        doc.setFont("times", "italic");
        doc.setFontSize(9);
        const lineasPie = doc.splitTextToSize(pie, anchoContenido);
        doc.text(lineasPie, centroX, yActual, { align: "center" });
        yActual += lineasPie.length * 4.5 + 3;
      }
      resolve(yActual + 4);
    };
    img.onerror = () => resolve(y);
    img.src = dataUrl;
  });
}

/**
 * Tabla con rótulo "Tabla N." numerado ARRIBA (título tal cual, sin
 * alterarlo) y, si hay nota/fuente ("pie"), debajo en cursiva — estilo
 * APA de tabla. Reutiliza agregarTabla tal cual, solo con los márgenes de
 * este informe (1 pulgada) en vez de los 12mm del resto de la plataforma.
 */
export function agregarBloqueTabla(doc, y, columnas, filas, tituloTabla, pie, contadores) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const centroX = anchoPagina / 2;
  contadores.tabla += 1;
  let yActual = saltoDePaginaSiNecesario(doc, y, 20);
  doc.setFont("times", "bold");
  doc.setFontSize(10);
  doc.text(`Tabla ${contadores.tabla}.${tituloTabla ? " " + tituloTabla : ""}`, centroX, yActual, { align: "center" });
  yActual += 5;
  agregarTabla(doc, columnas, filas, yActual, { margin: { left: MARGEN_APA, right: MARGEN_APA, bottom: MARGEN_APA } });
  yActual = doc.lastAutoTable.finalY + 4;

  if (pie) {
    const anchoContenido = anchoPagina - MARGEN_APA * 2;
    doc.setFont("times", "italic");
    doc.setFontSize(9);
    const lineasPie = doc.splitTextToSize(pie, anchoContenido);
    yActual = saltoDePaginaSiNecesario(doc, yActual, lineasPie.length * 4.5);
    doc.text(lineasPie, centroX, yActual, { align: "center" });
    yActual += lineasPie.length * 4.5 + 3;
  }
  return yActual + 4;
}

/** Gráfico de barras vectorial (una sola serie etiqueta/valor). */
export function agregarBloqueGraficoBarras(doc, y, { titulo, etiquetas, valores }, contadores) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const anchoContenido = anchoPagina - MARGEN_APA * 2;
  const altoGrafico = 60;
  let yActual = saltoDePaginaSiNecesario(doc, y, altoGrafico + 20);
  const yBase = yActual + altoGrafico;
  const maxValor = Math.max(...valores, 1);
  const anchoBarra = anchoContenido / valores.length;

  doc.setDrawColor(180, 180, 180);
  doc.line(MARGEN_APA, yBase, MARGEN_APA + anchoContenido, yBase);

  valores.forEach((valor, i) => {
    const alturaBarra = (valor / maxValor) * (altoGrafico - 12);
    const x = MARGEN_APA + i * anchoBarra + anchoBarra * 0.15;
    const anchoBarraReal = anchoBarra * 0.7;
    doc.setFillColor(...colorPaleta(i, valores.length));
    doc.rect(x, yBase - alturaBarra, anchoBarraReal, alturaBarra, "F");
    doc.setFont("times", "normal");
    doc.setFontSize(7.5);
    doc.text(String(valor), x + anchoBarraReal / 2, yBase - alturaBarra - 2, { align: "center" });
    doc.text(String(etiquetas[i] ?? ""), x + anchoBarraReal / 2, yBase + 5, { align: "center", maxWidth: anchoBarra });
  });

  let yFinal = yBase + 10;
  contadores.figura += 1;
  doc.setFont("times", "italic");
  doc.setFontSize(9);
  doc.text(`Figura ${contadores.figura}.${titulo ? " " + titulo : ""}`, anchoPagina / 2, yFinal, { align: "center" });
  return yFinal + 6;
}

/** Gráfico de líneas vectorial (una sola serie etiqueta/valor). */
export function agregarBloqueGraficoLineas(doc, y, { titulo, etiquetas, valores }, contadores) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const anchoContenido = anchoPagina - MARGEN_APA * 2;
  const altoGrafico = 60;
  let yActual = saltoDePaginaSiNecesario(doc, y, altoGrafico + 20);
  const yBase = yActual + altoGrafico;
  const maxValor = Math.max(...valores, 1);
  const paso = valores.length > 1 ? anchoContenido / (valores.length - 1) : 0;
  const puntos = valores.map((v, i) => ({ x: MARGEN_APA + i * paso, y: yBase - (v / maxValor) * (altoGrafico - 12) }));

  doc.setDrawColor(180, 180, 180);
  doc.line(MARGEN_APA, yBase, MARGEN_APA + anchoContenido, yBase);

  doc.setDrawColor(...AMBAR_OSCURO);
  doc.setLineWidth(0.8);
  for (let i = 0; i < puntos.length - 1; i++) {
    doc.line(puntos[i].x, puntos[i].y, puntos[i + 1].x, puntos[i + 1].y);
  }
  puntos.forEach((p, i) => {
    doc.setFillColor(...AMBAR);
    doc.circle(p.x, p.y, 1.4, "F");
    doc.setFont("times", "normal");
    doc.setFontSize(7.5);
    doc.text(String(valores[i]), p.x, p.y - 3, { align: "center" });
    doc.text(String(etiquetas[i] ?? ""), p.x, yBase + 5, { align: "center" });
  });

  let yFinal = yBase + 10;
  contadores.figura += 1;
  doc.setFont("times", "italic");
  doc.setFontSize(9);
  doc.text(`Figura ${contadores.figura}.${titulo ? " " + titulo : ""}`, anchoPagina / 2, yFinal, { align: "center" });
  return yFinal + 6;
}

/** Gráfico de pastel vectorial (abanico de triángulos, sin librería de gráficos). */
export function agregarBloqueGraficoPastel(doc, y, { titulo, etiquetas, valores }, contadores) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const radio = 26;
  const cx = anchoPagina / 2 - 30;
  const alturaBloque = radio * 2 + 14;
  let yActual = saltoDePaginaSiNecesario(doc, y, alturaBloque + 20);
  const cy = yActual + radio;

  const total = valores.reduce((s, v) => s + v, 0) || 1;
  let anguloInicio = -Math.PI / 2;
  const gradosPorPaso = 3;

  valores.forEach((valor, i) => {
    const anguloBarrido = (valor / total) * Math.PI * 2;
    doc.setFillColor(...colorPaleta(i, valores.length));
    const pasos = Math.max(2, Math.ceil(((anguloBarrido * 180) / Math.PI) / gradosPorPaso));
    for (let s = 0; s < pasos; s++) {
      const a1 = anguloInicio + (anguloBarrido * s) / pasos;
      const a2 = anguloInicio + (anguloBarrido * (s + 1)) / pasos;
      const x1 = cx + radio * Math.cos(a1);
      const y1 = cy + radio * Math.sin(a1);
      const x2 = cx + radio * Math.cos(a2);
      const y2 = cy + radio * Math.sin(a2);
      doc.triangle(cx, cy, x1, y1, x2, y2, "F");
    }
    anguloInicio += anguloBarrido;
  });

  const xLeyenda = cx + radio + 14;
  let yLeyenda = yActual + 4;
  valores.forEach((valor, i) => {
    doc.setFillColor(...colorPaleta(i, valores.length));
    doc.rect(xLeyenda, yLeyenda - 3, 4, 4, "F");
    doc.setFont("times", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(0);
    const porcentaje = Math.round((valor / total) * 100);
    doc.text(`${etiquetas[i] ?? ""} (${porcentaje}%)`, xLeyenda + 6, yLeyenda);
    yLeyenda += 6;
  });

  let yFinal = yActual + alturaBloque;
  contadores.figura += 1;
  doc.setFont("times", "italic");
  doc.setFontSize(9);
  doc.text(`Figura ${contadores.figura}.${titulo ? " " + titulo : ""}`, anchoPagina / 2, yFinal, { align: "center" });
  return yFinal + 6;
}
