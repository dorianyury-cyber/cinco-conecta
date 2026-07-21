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

/**
 * Número de página tal como lo ve el lector en el pie de página real
 * (agregarEncabezadoPiePaginaInforme numera "Página 1 de N" empezando en
 * la primera página de CONTENIDO, sin contar la portada) — hay que usar
 * este mismo número al registrar en qué página cae cada título/figura/
 * tabla para la Tabla de Contenido e Índices; si se usara el número de
 * página FÍSICO de jsPDF (que sí cuenta la portada), la Tabla de
 * Contenido señalaría una página distinta a la que el lector encuentra
 * al buscar ese mismo número en el pie de página real.
 */
function paginaVisible(doc) {
  return doc.internal.getNumberOfPages() - 1;
}

/** Fecha corta DD/MM/AAAA, como la lleva la portada (colofón ciudad + fecha). */
function formatearFechaCorta(fecha) {
  if (!fecha) return "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? new Date(`${fecha}T12:00:00`) : new Date(fecha);
  if (Number.isNaN(d.getTime())) return String(fecha);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function saltoDePaginaSiNecesario(doc, y, alturaNecesaria) {
  const altoPagina = doc.internal.pageSize.getHeight();
  if (y + alturaNecesaria > altoPagina - MARGEN_APA) {
    doc.addPage();
    return MARGEN_APA; // ya deja espacio de sobra bajo el encabezado de marca (ver agregarEncabezadoPiePaginaInforme)
  }
  return y;
}

/**
 * Nuevo contador de figuras/tablas + las listas de entradas de la Tabla de
 * Contenido e Índices de Imágenes/Tablas (se van llenando con la página
 * real en la que cae cada título/figura/tabla a medida que se dibuja el
 * cuerpo del informe) — pásalo a todas las funciones de bloque de un mismo
 * informe.
 */
export function crearContadoresInforme() {
  return { figura: 0, tabla: 0, indiceTitulos: [], indiceFiguras: [], indiceTablas: [] };
}

// ---------------------------------------------------------------------
// Tabla de Contenido e Índices de Imágenes/Tablas (estilo Word: título
// centrado, lista con puntos guía hasta el número de página a la derecha).
//
// jsPDF no permite "insertar" páginas en la mitad del documento — addPage()
// siempre agrega al final — así que estas páginas se generan en dos
// pasadas: 1) una pasada de solo-conteo (con un documento de descarte) para
// saber cuántas páginas ocupará cada sección ANTES de dibujar el cuerpo, así
// se pueden reservar esas páginas justo después de la portada; 2) una vez
// dibujado el cuerpo real (que ya sabe en qué página real cayó cada
// título/figura/tabla), se vuelve atrás con doc.setPage() a rellenar esas
// páginas reservadas — pasando `opciones.nuevaPagina` para que en vez de
// doc.addPage() se use doc.setPage() al siguiente hueco ya reservado. Como
// el algoritmo de paginado es el mismo en las dos pasadas y las entradas no
// cambian, consume exactamente la misma cantidad de páginas las dos veces.
// ---------------------------------------------------------------------

const ANCHO_COLUMNA_PAGINA_INDICE = 10; // mm reservados para el número de página (hasta 3 dígitos) — fijo en ambas pasadas para que el partido de línea sea idéntico

function truncarConPuntosSuspensivos(doc, texto, anchoMax) {
  if (doc.getTextWidth(texto) <= anchoMax) return texto;
  let t = texto;
  while (t.length > 4 && doc.getTextWidth(`${t}…`) > anchoMax) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function dibujarEntradaIndice(doc, { x, y, anchoPagina, texto, pagina, anchoDisponibleTexto }) {
  const etiquetaFinal = truncarConPuntosSuspensivos(doc, texto, anchoDisponibleTexto);
  doc.text(etiquetaFinal, x, y);

  const anchoTextoReal = doc.getTextWidth(etiquetaFinal);
  const xPuntosInicio = x + anchoTextoReal + 2;
  const xPuntosFin = anchoPagina - MARGEN_APA - ANCHO_COLUMNA_PAGINA_INDICE;
  if (xPuntosFin > xPuntosInicio) {
    const anchoPunto = doc.getTextWidth(".") || 1;
    const numPuntos = Math.max(0, Math.floor((xPuntosFin - xPuntosInicio) / anchoPunto));
    doc.setTextColor(150);
    doc.text(".".repeat(numPuntos), xPuntosInicio, y);
    doc.setTextColor(0);
  }
  doc.setFont("times", "normal");
  doc.text(String(pagina ?? ""), anchoPagina - MARGEN_APA, y, { align: "right" });
}

/**
 * Cuenta cuántas páginas ocupará una función de listado (Tabla de
 * Contenido o Índice de Imágenes/Tablas) dibujándola en un documento de
 * descarte — ver nota arriba sobre por qué se necesita esta pasada previa.
 */
export function contarPaginasDeListado(dibujarFn) {
  const scratch = crearDocumentoPDF("portrait");
  dibujarFn(scratch);
  return scratch.internal.getNumberOfPages();
}

/**
 * Tabla de Contenido jerárquica (nivel 1/2/3, igual que la numeración de
 * los bloques de título). `entradas` es `contadores.indiceTitulos` (o, para
 * la pasada de conteo, una lista equivalente sin página real todavía).
 * `opciones.nuevaPagina` (por defecto doc.addPage()) permite reutilizar
 * esta misma función tanto para contar páginas como para rellenar las ya
 * reservadas — ver nota arriba.
 */
export function agregarTablaDeContenido(doc, entradas, opciones = {}) {
  if (!entradas || !entradas.length) return;
  const nuevaPagina = opciones.nuevaPagina || (() => doc.addPage());
  const anchoPagina = doc.internal.pageSize.getWidth();
  const altoPagina = doc.internal.pageSize.getHeight();
  const anchoContenido = anchoPagina - MARGEN_APA * 2;
  let y = MARGEN_APA;

  doc.setFont("times", "bold");
  doc.setFontSize(13);
  doc.text("Tabla de Contenido", anchoPagina / 2, y, { align: "center" });
  y += 12;

  const sangriaPorNivel = { 1: 0, 2: 8, 3: 16 };
  const tamanoPorNivel = { 1: 10.5, 2: 10, 3: 9.5 };
  const alturaLinea = 6.5;

  entradas.forEach((e) => {
    if (y + alturaLinea > altoPagina - MARGEN_APA) { nuevaPagina(); y = MARGEN_APA; }
    const sangria = sangriaPorNivel[e.nivel] || 0;
    doc.setFont("times", e.nivel === 1 ? "bold" : "normal");
    doc.setFontSize(tamanoPorNivel[e.nivel] || 10);
    dibujarEntradaIndice(doc, {
      x: MARGEN_APA + sangria,
      y,
      anchoPagina,
      texto: `${e.numero}. ${e.texto || ""}`,
      pagina: e.pagina,
      anchoDisponibleTexto: anchoContenido - sangria - ANCHO_COLUMNA_PAGINA_INDICE - 4
    });
    y += alturaLinea;
  });
}

/**
 * Índice de Imágenes o Índice de Tablas (lista plana, sin niveles) — se
 * usa para ambos según `etiqueta` ("Imagen"/"Tabla"). Mismo mecanismo de
 * `opciones.nuevaPagina` que agregarTablaDeContenido.
 */
export function agregarIndiceElementos(doc, tituloSeccion, entradas, etiqueta, opciones = {}) {
  if (!entradas || !entradas.length) return;
  const nuevaPagina = opciones.nuevaPagina || (() => doc.addPage());
  const anchoPagina = doc.internal.pageSize.getWidth();
  const altoPagina = doc.internal.pageSize.getHeight();
  const anchoContenido = anchoPagina - MARGEN_APA * 2;
  let y = MARGEN_APA;

  doc.setFont("times", "bold");
  doc.setFontSize(13);
  doc.text(tituloSeccion, anchoPagina / 2, y, { align: "center" });
  y += 12;

  const alturaLinea = 6.5;
  doc.setFontSize(10);

  entradas.forEach((e) => {
    if (y + alturaLinea > altoPagina - MARGEN_APA) { nuevaPagina(); y = MARGEN_APA; }
    doc.setFont("times", "normal");
    dibujarEntradaIndice(doc, {
      x: MARGEN_APA,
      y,
      anchoPagina,
      texto: `${etiqueta} ${e.numero}.${e.titulo ? " " + e.titulo : ""}`,
      pagina: e.pagina,
      anchoDisponibleTexto: anchoContenido - ANCHO_COLUMNA_PAGINA_INDICE - 4
    });
    y += alturaLinea;
  });
}

/**
 * Portada del informe de formato libre: título centrado en mayúsculas con
 * una regla debajo, "Elaboró"/"Aprobó" centrados, la mini-tabla de control
 * documental (Código/Versión/Fecha/Elaborado por, estilo ISO 9001) y un
 * colofón de ciudad + fecha al pie. Termina la página y devuelve el "y"
 * inicial para que el contenido empiece en una página nueva.
 */
export function agregarPortadaInforme(doc, { titulo, autor, aprobador, ciudad, fecha, codigo, version }) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const altoPagina = doc.internal.pageSize.getHeight();
  const anchoContenido = anchoPagina - MARGEN_APA * 2;
  let y = 60;

  doc.setFont("times", "bold");
  doc.setFontSize(18);
  const lineasTitulo = doc.splitTextToSize((titulo || "Informe").toUpperCase(), anchoContenido);
  doc.text(lineasTitulo, anchoPagina / 2, y, { align: "center" });
  y += lineasTitulo.length * 7.5 + 5;

  doc.setDrawColor(...AMBAR);
  doc.setLineWidth(0.8);
  doc.line(anchoPagina / 2 - 35, y, anchoPagina / 2 + 35, y);

  y += 20;
  doc.setFont("times", "normal");
  doc.setFontSize(12);
  doc.text(`Elaboró: ${autor || "—"}`, anchoPagina / 2, y, { align: "center" });

  if (aprobador) {
    y += 14;
    doc.text(`Aprobó: ${aprobador}`, anchoPagina / 2, y, { align: "center" });
  }

  y += 24;
  const filasControl = [
    ["Código", codigo || "—"],
    ["Versión", version || "1.0"],
    ["Fecha", formatearFechaInforme(fecha)],
    ["Elaborado por", autor || "—"]
  ];
  const anchoTabla = 100;
  const xTabla = (anchoPagina - anchoTabla) / 2;
  const altoFila = 8;
  const altoTabla = filasControl.length * altoFila + 6;

  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.3);
  doc.roundedRect(xTabla, y, anchoTabla, altoTabla, 2, 2);
  doc.setFontSize(9.5);
  filasControl.forEach(([etiqueta, valor], i) => {
    const yFila = y + 8 + i * altoFila;
    doc.setFont("times", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(etiqueta, xTabla + 5, yFila);
    doc.setFont("times", "normal");
    doc.setTextColor(37, 99, 235);
    doc.text(String(valor), xTabla + 38, yFila);
  });
  doc.setTextColor(0);
  y += altoTabla;

  doc.setFont("times", "bold");
  doc.setFontSize(11);
  doc.text(`${ciudad || "Neiva"} ${formatearFechaCorta(fecha)}`.trim(), anchoPagina - MARGEN_APA, altoPagina - MARGEN_APA, { align: "right" });

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
export function agregarBloqueTitulo(doc, y, nivel, numero, texto, contadores) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const anchoContenido = anchoPagina - MARGEN_APA * 2;
  let yActual = saltoDePaginaSiNecesario(doc, y, 14);
  if (contadores) contadores.indiceTitulos.push({ nivel, numero, texto, pagina: paginaVisible(doc) });

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
      const entradaIndice = { numero, titulo: titulo || "", pagina: paginaVisible(doc) };
      if (etiqueta === "Tabla") contadores.indiceTablas.push(entradaIndice); else contadores.indiceFiguras.push(entradaIndice);
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
 * Tabla con rótulo "Tabla N." numerado ARRIBA (título tal cual, centrado)
 * y, si hay nota/fuente ("pie"), debajo — la nota va en la esquina
 * inferior derecha (no centrada: en una tabla ancha, un texto corto como
 * "Elaboración propia" centrado en toda la página queda flotando sin
 * relación visual con la tabla; en la esquina se lee como una anotación de
 * la tabla misma). Reutiliza agregarTabla tal cual, solo con los márgenes
 * de este informe (1 pulgada) en vez de los 12mm del resto de la
 * plataforma.
 */
export function agregarBloqueTabla(doc, y, columnas, filas, tituloTabla, pie, contadores) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const centroX = anchoPagina / 2;
  contadores.tabla += 1;
  let yActual = saltoDePaginaSiNecesario(doc, y, 20);
  contadores.indiceTablas.push({ numero: contadores.tabla, titulo: tituloTabla || "", pagina: paginaVisible(doc) });
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
    doc.text(lineasPie, anchoPagina - MARGEN_APA, yActual, { align: "right" });
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
  const paginaEntrada = paginaVisible(doc);
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
  contadores.indiceFiguras.push({ numero: contadores.figura, titulo: titulo || "", pagina: paginaEntrada });
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
  const paginaEntrada = paginaVisible(doc);
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
  contadores.indiceFiguras.push({ numero: contadores.figura, titulo: titulo || "", pagina: paginaEntrada });
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
  const paginaEntrada = paginaVisible(doc);
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
  contadores.indiceFiguras.push({ numero: contadores.figura, titulo: titulo || "", pagina: paginaEntrada });
  doc.setFont("times", "italic");
  doc.setFontSize(9);
  doc.text(`Figura ${contadores.figura}.${titulo ? " " + titulo : ""}`, anchoPagina / 2, yFinal, { align: "center" });
  return yFinal + 6;
}
