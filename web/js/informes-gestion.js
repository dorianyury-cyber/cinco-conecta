// Informes de Gestión mensuales por contrato (ej. PER-2026-001), compendiados
// a partir de "estrategias" — cada una es un documento independiente en la
// subcolección `informesGestion/{id}/estrategias`, nunca un bloque de texto
// compartido, para que el guardado de una persona jamás pise el de otra y
// cada quien solo pueda escribir en la(s) suya(s) (reforzado también en
// firestore.rules, que es la seguridad real). Una estrategia puede además
// dividirse en "subtítulos/zonas" (ej. Brigadas → Zona Norte, Zona Sur):
// cada subtítulo es OTRO documento en la misma subcolección, con
// `padreId` apuntando a la estrategia que agrupa — así una estrategia con
// subtítulos se convierte en un simple encabezado (sin responsable ni
// contenido propio) y cada subtítulo se edita de forma tan independiente
// como cualquier estrategia normal.
//
// El "contenido" de cada estrategia/subtítulo es un arreglo de bloques
// (párrafo/título/tabla/imagen) — mismo concepto que el editor de informes
// de Cinco SAS control (web/js/control/informes.js), portado aquí con el
// mismo nivel de control en tablas (combinar celdas, negrilla, color,
// listas por columna, ver ./tabla-celdas.js) e imágenes (con subida a
// Storage). El bloque "titulo" (niveles 1-4) es propio de este módulo — no
// existe en Cinco SAS control — y sirve para encabezados de subsección
// dentro de una misma estrategia (ej. "4.7.1. Identificación de..."), tanto
// en la vista de solo lectura como en el PDF. El campo sigue llamándose
// "contenido" — la regla de Firestore (firestore.rules) filtra por nombre
// de campo, no por tipo, así que un responsable normal sigue pudiendo
// guardar sin tocar esa regla. Lo que NO se portó: historial de "Deshacer"
// y texto con formato rico (negrilla/color dentro de un párrafo).
import { collection, doc, addDoc, updateDoc, deleteDoc, setDoc, getDoc, onSnapshot, query, orderBy, serverTimestamp, arrayUnion } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { db, storage, functions, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, formatDate, tienePermiso } from "./utils.js";
import { crearDocumentoPDF, agregarPiePagina, descargarPDF } from "./pdf.js";
import {
  normalizarMerges, celdaCombinada, expandirRangoConMerges, quitarMergesQueIntersectan,
  celdaCentrada, normalizarCentrados, centrarRango, alinearIzquierdaRango, anchosColumnaEditor,
  celdaCentradaVertical, normalizarCentradosVertical, centrarVerticalRango, alinearArribaRango,
  redimensionarFilas, celdaNegrita, normalizarNegritas, negritaRango, quitarNegritaRango,
  colorCelda, normalizarColoresCelda, colorearRango, normalizarOpcionesColumna,
  insertarFilaEnBloque, eliminarFilaEnBloque, filasEncabezadoAutomatico
} from "./tabla-celdas.js";
import { crearCampoTextoRico, htmlParaCampoRico, parsearHtmlARuns, MARCADORES_VINETA } from "./texto-rico.js";

const { user, perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

const esCoordinador = tienePermiso(perfil, "informesGestion");
const params = new URLSearchParams(window.location.search);
const informeId = params.get("id");

const ESTADO_INFORME_TEXTO = { borrador: "Borrador", consolidado: "Consolidado" };
const ESTADO_ESTRATEGIA_TEXTO = { pendiente: "Pendiente", en_progreso: "En progreso", completo: "Completo" };
const ESTADO_ESTRATEGIA_BADGE = { pendiente: "warn", en_progreso: "gold", completo: "ok" };

// ---- Empleados activos (para los selects de responsables) ----
let empleadosActivos = [];
function opcionesEmpleados(seleccionados = []) {
  return empleadosActivos
    .map((p) => `<option value="${p.id}" ${seleccionados.includes(p.id) ? "selected" : ""}>${p.nombre || p.correo}</option>`)
    .join("");
}
onSnapshot(collection(db, "staff"), (snap) => {
  empleadosActivos = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.estado === "activo")
    .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
  document.querySelectorAll("select[data-fila-responsables], select[data-subfila-responsables]").forEach((sel) => {
    sel.innerHTML = opcionesEmpleados();
  });
  const nuevaSel = document.getElementById("nuevaEstrategiaResponsables");
  if (nuevaSel) nuevaSel.innerHTML = opcionesEmpleados();
});

function nombrePorUid(uid) {
  return empleadosActivos.find((p) => p.id === uid)?.nombre || "";
}

// ======================================================================
// Bloques de contenido (párrafo/tabla/imagen) — modelo de datos y helpers
// ======================================================================

// Firestore no permite arrays anidados, así que las filas de una tabla se
// guardan envueltas en {celdas:[...]} por fila.
function filasParaGuardar(filas) {
  return filas.map((fila) => ({ celdas: fila }));
}
function filasParaEditar(filas) {
  return filas.map((fila) => (Array.isArray(fila) ? fila : fila.celdas || []));
}

// Comparación profunda por contenido, sin importar el orden en que estén
// las propiedades de cada objeto — JSON.stringify() sí es sensible a ese
// orden, y Firestore no garantiza devolver las propiedades de un objeto
// exactamente en el mismo orden en que se guardaron, así que comparar con
// JSON.stringify() podía marcar como "distinto" un bloque idéntico solo
// por eso. Los arreglos sí se comparan en orden (ahí sí importa).
function sonIguales(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sonIguales(v, b[i]));
  }
  if (typeof a === "object") {
    const clavesA = Object.keys(a);
    const clavesB = Object.keys(b);
    return clavesA.length === clavesB.length && clavesA.every((k) => sonIguales(a[k], b[k]));
  }
  return a === b;
}

// Compatibilidad hacia atrás: las estrategias creadas antes de este cambio
// tienen "contenido" como string plano — se tratan como un solo bloque de
// párrafo, sin necesidad de migrar nada a mano en Firestore.
function contenidoABloques(contenido) {
  if (Array.isArray(contenido)) {
    return contenido.map((b) => (b.tipo === "tabla" ? { ...b, filas: filasParaEditar(b.filas || []) } : { ...b }));
  }
  if (typeof contenido === "string" && contenido) return [{ tipo: "parrafo", texto: contenido }];
  return [];
}

function nuevaTablaBloque() {
  return { tipo: "tabla", titulo: "", nota: "", filas: [["", ""], ["", ""]], merges: [], centrados: [], negritas: [], coloresCelda: [], opcionesColumna: {}, filasEncabezado: 1 };
}

function nuevaImagenBloque() {
  return { tipo: "imagen", url: null, blob: null, previewUrl: null, nombre: "", pieDeFoto: "", tamano: 85 };
}

// Bloque de firma — mismo diseño que en Cinco SAS control (informes.js /
// informes-pdf.js): etiqueta (Elaboró/Aprobó/Revisó...) + uno o varios
// firmantes en fila, cada uno con nombre, cargo y, opcionalmente, una
// imagen de firma digital que se dibuja arriba de la línea de firma en el
// PDF (ver dibujarFirmaBloque).
function nuevaFirmaBloque() {
  return { tipo: "firma", etiqueta: "Aprobó", firmantes: [{ nombre: "", cargo: "" }] };
}

// Borrador local de "contenido" (bloques) por estrategia mientras se
// edita — separado de estrategiasActuales (lo último sincronizado desde
// Firestore) para que un snapshot ajeno (otra persona guardando SU propia
// estrategia) no pise una tabla o imagen a medio construir antes de
// "Guardar avance". Se resincroniza desde Firestore cada vez que la
// estrategia NO está "en edición" (ver render()).
const borradorContenido = new Map();

// Pila de "Deshacer" por estrategia — guarda una foto de sus bloques justo
// ANTES de una acción destructiva/estructural fácil de disparar por error y
// difícil de notar/revertir a mano (quitar un bloque/fila/columna/firmante,
// combinar celdas, vaciar una tabla, borrar varias celdas de un tirón). No
// cubre cada tecla escrita en un texto (sería una pila enorme que no
// aporta — un texto mal escrito se corrige retipeando, y el campo rico de
// párrafo ya trae su propio Ctrl+Z nativo del navegador).
const historialBloques = new Map();
const MAX_HISTORIAL_BLOQUES = 20;

function clonarBloques(lista) {
  return lista.map((b) => {
    if (b.tipo === "tabla") {
      return {
        ...b,
        filas: b.filas.map((fila) => [...fila]),
        merges: (b.merges || []).map((m) => ({ ...m })),
        centrados: (b.centrados || []).map((c) => ({ ...c })),
        negritas: (b.negritas || []).map((n) => ({ ...n })),
        coloresCelda: (b.coloresCelda || []).map((c) => ({ ...c })),
        opcionesColumna: { ...(b.opcionesColumna || {}) }
      };
    }
    if (b.tipo === "firma") {
      return { ...b, firmantes: (b.firmantes || []).map((f) => ({ ...f })) };
    }
    return { ...b };
  });
}

function guardarHistorial(estrategiaId) {
  const bloques = borradorContenido.get(estrategiaId);
  if (!bloques) return;
  const pila = historialBloques.get(estrategiaId) || [];
  pila.push(clonarBloques(bloques));
  if (pila.length > MAX_HISTORIAL_BLOQUES) pila.shift();
  historialBloques.set(estrategiaId, pila);
}

// ids de estrategias donde render() detectó que el borrador local (sin
// guardar) ya no coincide con lo último guardado en el servidor, mientras
// la tarjeta ya no se consideraba "en edición" — ver el comentario largo
// en render(). Se muestra un banner (cardHTML) en vez de descartar en
// silencio esos cambios.
const estrategiasConCambiosSinGuardar = new Set();

// ids que acabamos de guardar nosotros mismos con éxito, a la espera de
// que el onSnapshot de "estrategias" (que puede tardar un instante en
// reflejar el guardado) se ponga al día — el render() que se llama justo
// después de "Guardar avance" todavía ve estrategiasActuales con el
// contenido VIEJO, y sin este aviso se confundía con "cambios sin
// guardar" recién guardados. Se consume (borra) apenas render() lo ve una
// vez, dejando pasar de largo esa comparación puntual sin marcar nada.
const estrategiasRecienGuardadas = new Set();

// id de la estrategia que la persona está editando activamente ahora mismo
// — a nivel de módulo (no solo dentro del bloque "vista detalle") para que
// los botones de agregar/quitar/mover un bloque (crearBarraInsertar, etc.)
// puedan marcarlo directo en el momento del clic, sin depender únicamente
// de que el mousedown delegado alcance a correr primero. Evita que un
// snapshot de Firestore que llegue justo después de agregar un bloque
// resincronice el contenido desde lo último guardado y borre ese bloque
// recién agregado (que todavía no se ha guardado).
let estrategiaEnEdicionGlobal = null;

// Índice del bloque recién agregado (por + Párrafo/Título/Tabla/Imagen) al
// que hay que devolverle el foco apenas se reconstruya el editor — dos
// motivos: (1) deja el cursor listo para escribir de una, y (2) evita un
// bug real: al agregar un bloque, el botón que se clickeó queda enfocado y
// se elimina del DOM al reconstruir el editor, lo que dispara un
// "focusout" que el listener de abajo interpreta como "la persona salió de
// la tarjeta" — soltando el congelado y resincronizando desde Firestore,
// borrando el bloque que se acababa de agregar (confirmado con una prueba
// aislada). Devolver el foco a algo DENTRO de la tarjeta evita ese falso
// "salió de la tarjeta".
let indicePendienteDeEnfocar = null;

// Red de seguridad general (cubre TODO control del editor que dispare
// onChange() — no solo agregar bloques: mover ↑/↓, Quitar, nivel de
// título, y cada botón del editor de tabla): mientras esto es true, el
// listener de "focusout" (más abajo) ignora el falso "la persona salió de
// la tarjeta" que dispara el propio re-render al eliminar el control que
// tenía el foco. Se activa al empezar onChange() y se apaga en el siguiente
// tick — después de que el setTimeout(0) del focusout ya alcanzó a
// revisarla (los timers se disparan en el orden en que se programan).
let bloqueSeAcabaDeActualizar = false;

// Redimensiona una imagen en el navegador antes de subirla (máx. 1600px de
// ancho, JPEG calidad 0.86) — igual que en Cinco SAS control.
function redimensionarImagen(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const escala = Math.min(1, 1600 / img.naturalWidth);
        const ancho = Math.round(img.naturalWidth * escala);
        const alto = Math.round(img.naturalHeight * escala);
        const canvas = document.createElement("canvas");
        canvas.width = ancho;
        canvas.height = alto;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, ancho, alto);
        ctx.drawImage(img, 0, 0, ancho, alto);
        canvas.toBlob(
          (blob) => resolve({ blob, previewUrl: canvas.toDataURL("image/jpeg", 0.86), ancho, alto }),
          "image/jpeg", 0.86
        );
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Saca la ruta real dentro del bucket (ej. "informesGestion/abc/xyz.jpg") a
// partir de una URL de descarga de Firebase Storage (".../o/informesGestion
// %2Fabc%2Fxyz.jpg?alt=media&token=..."). Devuelve null si no tiene esa
// forma (ej. ya es una ruta local de assets/).
function extraerPathStorage(url) {
  const m = String(url || "").match(/\/o\/([^?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Convierte una URL de imagen (típicamente de Storage) a data URL para
// poder incrustarla en el PDF — jsPDF no puede cargar imágenes por URL.
// Para URLs de Storage, leer los píxeles en un <canvas> desde el navegador
// (con crossOrigin="anonymous") resultó poco confiable — a veces el
// navegador rechaza la respuesta con "blocked by CORS policy" aunque el
// archivo sea público y accesible (mismo problema documentado en
// obtenerArchivoBase64, usado para las hojas de vida: "el bucket no tiene
// CORS habilitado para el dominio del sitio" de forma consistente). En vez
// de depender de eso, el archivo se descarga del lado del servidor (Admin
// SDK, sin CORS de por medio) y se arma un data URL local con esos bytes —
// un data URL nunca tiene problema de CORS al leerlo en un canvas.
async function cargarImagenComoDataURL(url, colorFondo = "#ffffff", formato = "JPEG") {
  let src = url;
  const path = extraerPathStorage(url);
  if (path) {
    const llamada = httpsCallable(functions, "obtenerArchivoBase64");
    const { data } = await llamada({ path });
    src = `data:${data.contentType};base64,${data.base64}`;
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = colorFondo;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const dataUrl = formato === "JPEG" ? canvas.toDataURL("image/jpeg", 0.82) : canvas.toDataURL("image/png");
      resolve({ dataUrl, ancho: img.naturalWidth, alto: img.naturalHeight });
    };
    img.onerror = reject;
    img.src = src;
  });
}

function rangoOrdenado(a, b) {
  return { fMin: Math.min(a.fi, b.fi), fMax: Math.max(a.fi, b.fi), cMin: Math.min(a.ci, b.ci), cMax: Math.max(a.ci, b.ci) };
}

// Rellena una tabla desde texto copiado de Excel (celdas separadas por
// tabulador, filas por salto de línea) o de una tabla de Word.
function pegarEnTabla(bloque, filaInicio, colInicio, texto, onChange) {
  const filas = texto.replace(/\r/g, "").split("\n");
  while (filas.length > 1 && filas[filas.length - 1] === "") filas.pop();
  const datos = filas.map((fila) => fila.split("\t"));

  const colsNecesarias = colInicio + Math.max(...datos.map((f) => f.length));
  const filasNecesarias = filaInicio + datos.length;
  while (bloque.filas[0].length < colsNecesarias) bloque.filas.forEach((fila) => fila.push(""));
  while (bloque.filas.length < filasNecesarias) bloque.filas.push(bloque.filas[0].map(() => ""));

  bloque.merges = quitarMergesQueIntersectan(
    bloque.merges || [], filaInicio, filaInicio + datos.length - 1, colInicio, colsNecesarias - 1
  );

  datos.forEach((fila, fi) => {
    fila.forEach((valor, ci) => { bloque.filas[filaInicio + fi][colInicio + ci] = valor; });
  });
  onChange();
}

// ---- editor de una tabla (bloque) — mismo nivel de control que Cinco SAS
// control: combinar/separar celdas, centrar, negrilla, color, listas por
// columna, pegar desde Excel/Word. Reutiliza tabla-celdas.js. ----
function renderTablaEditorBloque(bloque, onChange, numero, estrategiaId) {
  const cont = document.createElement("div");
  cont.className = "control-tabla-editor";

  const filaTitulo = document.createElement("div");
  filaTitulo.style.display = "flex";
  filaTitulo.style.gap = "8px";
  filaTitulo.style.alignItems = "center";
  const numeroSpan = document.createElement("span");
  numeroSpan.className = "control-numero-indicativo";
  numeroSpan.textContent = numero ? `Tabla ${numero}.` : "";
  numeroSpan.title = "Numeral indicativo — se calcula solo y no se puede cambiar aquí. Es solo una guía de referencia; el número real se recalcula al generar el informe en PDF.";
  const tituloInput = document.createElement("input");
  tituloInput.type = "text";
  tituloInput.maxLength = 200;
  tituloInput.placeholder = "Título de la tabla (opcional) — sin \"Tabla N.\", eso se agrega solo al generar el PDF";
  tituloInput.value = bloque.titulo || "";
  tituloInput.style.flex = "1";
  tituloInput.style.width = "auto";
  tituloInput.addEventListener("input", () => { bloque.titulo = tituloInput.value; });
  filaTitulo.append(numeroSpan, tituloInput);
  cont.appendChild(filaTitulo);

  const numFilas = bloque.filas.length;
  const numCols = Math.max(...bloque.filas.map((f) => f.length));
  bloque.filas.forEach((fila) => { while (fila.length < numCols) fila.push(""); });
  bloque.merges = normalizarMerges(bloque.merges || [], numFilas, numCols);
  bloque.centrados = normalizarCentrados(bloque.centrados || [], numFilas, numCols);
  bloque.centradosVertical = normalizarCentradosVertical(bloque.centradosVertical || [], numFilas, numCols);
  bloque.negritas = normalizarNegritas(bloque.negritas || [], numFilas, numCols);
  bloque.coloresCelda = normalizarColoresCelda(bloque.coloresCelda || [], numFilas, numCols);
  bloque.opcionesColumna = normalizarOpcionesColumna(bloque.opcionesColumna || {}, numCols);

  const tamanoDiv = document.createElement("div");
  tamanoDiv.className = "control-tabla-tamano";
  const filasSizeInput = document.createElement("input");
  filasSizeInput.type = "number";
  filasSizeInput.min = "1";
  filasSizeInput.value = numFilas;
  const colsSizeInput = document.createElement("input");
  colsSizeInput.type = "number";
  colsSizeInput.min = "1";
  colsSizeInput.value = numCols;
  const labelFilas = document.createElement("label");
  labelFilas.textContent = "Filas";
  labelFilas.appendChild(filasSizeInput);
  const labelCols = document.createElement("label");
  labelCols.textContent = "Columnas";
  labelCols.appendChild(colsSizeInput);
  const tamanoBtn = document.createElement("button");
  tamanoBtn.type = "button";
  tamanoBtn.className = "control-btn-mini";
  tamanoBtn.textContent = "↕ Cambiar tamaño";
  tamanoBtn.title = "Ajusta la tabla al número de filas y columnas escrito";
  tamanoBtn.addEventListener("click", () => {
    const nf = Math.max(1, parseInt(filasSizeInput.value, 10) || numFilas);
    const nc = Math.max(1, parseInt(colsSizeInput.value, 10) || numCols);
    if (nf === numFilas && nc === numCols) return;
    redimensionarFilas(bloque.filas, nf, nc);
    onChange();
  });
  tamanoDiv.append(labelFilas, labelCols, tamanoBtn);
  cont.appendChild(tamanoDiv);

  const encabezadoDiv = document.createElement("div");
  encabezadoDiv.className = "control-tabla-tamano";
  const encabezadoInput = document.createElement("input");
  encabezadoInput.type = "number";
  encabezadoInput.min = "1";
  encabezadoInput.max = String(Math.max(1, numFilas - 1));
  encabezadoInput.value = bloque.filasEncabezado || filasEncabezadoAutomatico(numFilas, bloque.merges);
  encabezadoInput.title = "Se calcula solo según si la fila 0 tiene columnas combinadas — cámbialo aquí solo si necesitas forzar otro número";
  encabezadoInput.addEventListener("input", () => {
    bloque.filasEncabezado = Math.max(1, Math.min(parseInt(encabezadoInput.value, 10) || 1, Math.max(1, numFilas - 1)));
  });
  const labelEncabezado = document.createElement("label");
  labelEncabezado.textContent = "Filas de encabezado";
  labelEncabezado.appendChild(encabezadoInput);
  encabezadoDiv.appendChild(labelEncabezado);
  cont.appendChild(encabezadoDiv);

  const grid = document.createElement("div");
  grid.className = "control-tabla-grid";
  const pesosCol = anchosColumnaEditor(bloque.filas, bloque.merges, numFilas, numCols);
  grid.style.gridTemplateColumns = pesosCol.map((p) => `minmax(90px, ${p}fr)`).join(" ");

  // Barra flotante — aparece pegada a la última celda seleccionada con las
  // acciones más usadas (negrilla, alinear, combinar), para no tener que
  // bajar hasta la barra fija de abajo cada vez (pedido explícito: "así
  // como sucede en Excel"). Sus botones se llenan más abajo, una vez que
  // negritaBtn/combinarBtn/etc. ya existen — solo repiten el clic de esos
  // mismos botones, no duplican la lógica.
  const flotante = document.createElement("div");
  flotante.className = "control-tabla-flotante hidden";
  cont.style.position = "relative";
  cont.appendChild(flotante);

  function actualizarResaltado() {
    const rango = bloque._selA && bloque._selB ? rangoOrdenado(bloque._selA, bloque._selB) : null;
    grid.querySelectorAll("input, select, textarea").forEach((campo) => {
      const fi = Number(campo.dataset.fi);
      const ci = Number(campo.dataset.ci);
      const sel = !!rango && fi >= rango.fMin && fi <= rango.fMax && ci >= rango.cMin && ci <= rango.cMax;
      campo.classList.toggle("control-celda-sel", sel);
    });
    if (!rango) { flotante.classList.add("hidden"); return; }
    const celdaB = bloque._selB && grid.querySelector(`[data-fi="${bloque._selB.fi}"][data-ci="${bloque._selB.ci}"]`);
    if (!celdaB) { flotante.classList.add("hidden"); return; }
    flotante.classList.remove("hidden");
    const rectCelda = celdaB.getBoundingClientRect();
    const rectCont = cont.getBoundingClientRect();
    flotante.style.top = `${rectCelda.bottom - rectCont.top + 4}px`;
    flotante.style.left = `${Math.max(0, rectCelda.left - rectCont.left)}px`;
  }

  bloque.filas.forEach((fila, fi) => {
    fila.forEach((celda, ci) => {
      const info = celdaCombinada(bloque.merges, fi, ci);
      if (info && !info.esAncla) return;

      const opciones = fi > 0 ? bloque.opcionesColumna[ci] : null;
      const celdaInput = document.createElement(opciones ? "select" : "textarea");
      if (opciones) {
        [["", "—"], ...opciones.map((o) => [o, o])].forEach(([valor, texto]) => {
          const opt = document.createElement("option");
          opt.value = valor;
          opt.textContent = texto;
          celdaInput.appendChild(opt);
        });
        celdaInput.value = celda;
        celdaInput.addEventListener("change", () => { bloque.filas[fi][ci] = celdaInput.value; });
      } else {
        celdaInput.rows = 1;
        celdaInput.maxLength = 300;
        celdaInput.value = celda;
        celdaInput.placeholder = fi === 0 ? `Columna ${ci + 1}` : "";
        const autoAltura = () => { celdaInput.style.height = "auto"; celdaInput.style.height = `${celdaInput.scrollHeight}px`; };
        celdaInput.addEventListener("input", () => { bloque.filas[fi][ci] = celdaInput.value; autoAltura(); });
        setTimeout(autoAltura, 0);
        // Un salto de línea escrito o pegado DENTRO de una celda debe quedarse
        // en esa misma celda (el textarea ya lo permite de por sí) — solo un
        // TAB en el texto pegado señala de verdad un rango de Excel de varias
        // columnas, así que solo ESE caso se reparte en celdas nuevas. Antes
        // cualquier salto de línea pegado (ej. un párrafo copiado de Word) se
        // repartía como si fueran filas nuevas, sin forma de pegarlo tal cual
        // en una sola celda.
        celdaInput.addEventListener("paste", (e) => {
          const texto = e.clipboardData?.getData("text/plain") ?? "";
          if (texto.includes("\t")) { e.preventDefault(); guardarHistorial(estrategiaId); pegarEnTabla(bloque, fi, ci, texto, onChange); }
        });
      }
      celdaInput.dataset.fi = fi;
      celdaInput.dataset.ci = ci;
      celdaInput.style.gridColumn = info ? `${ci + 1} / span ${info.merge.cols}` : `${ci + 1}`;
      celdaInput.style.gridRow = info ? `${fi + 1} / span ${info.merge.filas}` : `${fi + 1}`;
      celdaInput.style.textAlign = celdaCentrada(bloque.centrados, fi, ci) ? "center" : "left";
      // Cada celda es un ítem de grid por su cuenta (el <textarea>/<select>
      // directo, sin envoltorio) — alignSelf es el equivalente en grid de
      // vertical-align en una tabla real. Sin esto, "Centrar vertical" solo
      // se veía reflejado en la vista de solo lectura y en el PDF (donde sí
      // se usa celdaCentradaVertical), nunca en este editor.
      celdaInput.style.alignSelf = celdaCentradaVertical(bloque.centradosVertical, fi, ci) ? "center" : "start";
      if (celdaNegrita(bloque.negritas, fi, ci)) celdaInput.style.fontWeight = "700";
      const colorTexto = colorCelda(bloque.coloresCelda, fi, ci);
      if (colorTexto) celdaInput.style.color = colorTexto;
      celdaInput.addEventListener("focus", () => { bloque._filaFoco = fi; bloque._colFoco = ci; });
      celdaInput.addEventListener("mousedown", () => {
        bloque._selA = { fi, ci };
        bloque._selB = { fi, ci };
        actualizarResaltado();
      });
      celdaInput.addEventListener("mouseenter", (e) => {
        if (e.buttons === 1 && bloque._selA) {
          bloque._selB = { fi, ci };
          actualizarResaltado();
        }
      });
      grid.appendChild(celdaInput);
    });
  });
  cont.appendChild(grid);
  actualizarResaltado();

  // Suprimir/Retroceso con varias celdas seleccionadas (arrastrando, como en
  // Excel) borra el texto de TODAS las celdas de ese rango de una vez — si
  // el rango es una sola celda, se deja el comportamiento normal de la
  // tecla (borrar un carácter) sin interceptarla.
  grid.addEventListener("keydown", (e) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const rango = bloque._selA && bloque._selB ? rangoOrdenado(bloque._selA, bloque._selB) : null;
    if (!rango || (rango.fMin === rango.fMax && rango.cMin === rango.cMax)) return;
    e.preventDefault();
    guardarHistorial(estrategiaId);
    for (let fi = rango.fMin; fi <= rango.fMax; fi++) {
      for (let ci = rango.cMin; ci <= rango.cMax; ci++) {
        const info = celdaCombinada(bloque.merges, fi, ci);
        if (info && !info.esAncla) continue;
        bloque.filas[fi][ci] = "";
      }
    }
    onChange();
  });

  const agregarFilaArriba = document.createElement("button");
  agregarFilaArriba.type = "button";
  agregarFilaArriba.className = "control-btn-mini";
  agregarFilaArriba.textContent = "+ Fila arriba";
  agregarFilaArriba.addEventListener("click", () => {
    guardarHistorial(estrategiaId);
    const indice = bloque._filaFoco ?? bloque.filas.length;
    insertarFilaEnBloque(bloque, indice, numCols);
    onChange();
  });
  const agregarFilaAbajo = document.createElement("button");
  agregarFilaAbajo.type = "button";
  agregarFilaAbajo.className = "control-btn-mini";
  agregarFilaAbajo.textContent = "+ Fila abajo";
  agregarFilaAbajo.addEventListener("click", () => {
    guardarHistorial(estrategiaId);
    const indice = bloque._filaFoco === undefined ? bloque.filas.length : bloque._filaFoco + 1;
    insertarFilaEnBloque(bloque, indice, numCols);
    onChange();
  });
  const quitarFila = document.createElement("button");
  quitarFila.type = "button";
  quitarFila.className = "control-btn-mini";
  quitarFila.textContent = "- Fila";
  quitarFila.disabled = bloque.filas.length <= 1;
  quitarFila.addEventListener("click", () => {
    if (bloque.filas.length <= 1) return;
    guardarHistorial(estrategiaId);
    const indice = Math.min(bloque._filaFoco ?? bloque.filas.length - 1, bloque.filas.length - 1);
    eliminarFilaEnBloque(bloque, indice);
    onChange();
  });
  const agregarCol = document.createElement("button");
  agregarCol.type = "button";
  agregarCol.className = "control-btn-mini";
  agregarCol.textContent = "+ Columna";
  agregarCol.addEventListener("click", () => {
    guardarHistorial(estrategiaId);
    bloque.filas.forEach((fila) => fila.push(""));
    onChange();
  });
  const quitarCol = document.createElement("button");
  quitarCol.type = "button";
  quitarCol.className = "control-btn-mini";
  quitarCol.textContent = "- Columna";
  quitarCol.disabled = numCols <= 1;
  quitarCol.addEventListener("click", () => {
    if (numCols > 1) { guardarHistorial(estrategiaId); bloque.filas.forEach((fila) => fila.pop()); onChange(); }
  });
  const vaciarBtn = document.createElement("button");
  vaciarBtn.type = "button";
  vaciarBtn.className = "control-btn-mini";
  vaciarBtn.textContent = "🧹 Vaciar tabla";
  vaciarBtn.title = "Borra todas las filas/columnas y combinaciones para empezar una tabla nueva — el título de la tabla (arriba) NO se borra";
  vaciarBtn.addEventListener("click", () => {
    if (!confirm("¿Vaciar esta tabla? Se borra todo su contenido (filas, columnas, combinaciones) para empezar de cero. El título de la tabla no se borra.")) return;
    guardarHistorial(estrategiaId);
    bloque.filas = [["", ""], ["", ""]];
    bloque.merges = [];
    bloque.centrados = [];
    bloque.centradosVertical = [];
    bloque.negritas = [];
    bloque.coloresCelda = [];
    bloque.opcionesColumna = {};
    bloque.filasEncabezado = 1;
    bloque._selA = null;
    bloque._selB = null;
    onChange();
  });
  const pegarBtn = document.createElement("button");
  pegarBtn.type = "button";
  pegarBtn.className = "control-btn-mini";
  pegarBtn.textContent = "📋 Pegar desde Excel/Word";
  pegarBtn.title = "Copia el rango en Excel (o la tabla en Word) y haz clic aquí — también puedes pegar (Ctrl+V) directo sobre cualquier celda";
  pegarBtn.addEventListener("click", async () => {
    const fi = bloque._filaFoco ?? 0;
    const ci = bloque._colFoco ?? 0;
    try {
      const texto = await navigator.clipboard.readText();
      if (!texto) { alert("El portapapeles está vacío. Copia primero el rango en Excel o la tabla en Word."); return; }
      guardarHistorial(estrategiaId);
      pegarEnTabla(bloque, fi, ci, texto, onChange);
    } catch (e) {
      alert("El navegador no dejó leer el portapapeles automáticamente. Haz clic en la celda donde quieres empezar y pega con Ctrl+V — funciona igual.");
    }
  });
  const combinarBtn = document.createElement("button");
  combinarBtn.type = "button";
  combinarBtn.className = "control-btn-mini";
  combinarBtn.textContent = "🔗 Combinar celdas";
  combinarBtn.title = "Arrastra sobre las celdas que quieras combinar y haz clic aquí";
  combinarBtn.addEventListener("click", () => {
    if (!bloque._selA || !bloque._selB) { alert("Arrastra sobre las celdas que quieras combinar antes de hacer clic aquí."); return; }
    let { fMin, fMax, cMin, cMax } = expandirRangoConMerges(bloque.merges, rangoOrdenado(bloque._selA, bloque._selB));
    if (fMin === fMax && cMin === cMax) { alert("Selecciona al menos 2 celdas para combinar."); return; }
    guardarHistorial(estrategiaId);
    const textos = [];
    for (let fi = fMin; fi <= fMax; fi++) {
      for (let ci = cMin; ci <= cMax; ci++) {
        if (bloque.filas[fi][ci]) textos.push(bloque.filas[fi][ci]);
      }
    }
    bloque.filas[fMin][cMin] = textos.join(" ").trim();
    for (let fi = fMin; fi <= fMax; fi++) {
      for (let ci = cMin; ci <= cMax; ci++) {
        if (fi !== fMin || ci !== cMin) bloque.filas[fi][ci] = "";
      }
    }
    bloque.merges = quitarMergesQueIntersectan(bloque.merges, fMin, fMax, cMin, cMax);
    bloque.merges.push({ fila: fMin, col: cMin, filas: fMax - fMin + 1, cols: cMax - cMin + 1 });
    // Una combinación vertical (más de una fila) queda mucho más alta que
    // el texto que le cabe — se ve raro pegado arriba, así que se centra
    // verticalmente sola. Una combinación solo horizontal no cambia de
    // alto, así que no hace falta tocarle la alineación vertical.
    if (fMax > fMin) {
      bloque.centradosVertical = centrarVerticalRango(bloque.centradosVertical, fMin, fMin, cMin, cMin);
    }
    bloque._selA = { fi: fMin, ci: cMin };
    bloque._selB = { fi: fMin, ci: cMin };
    onChange();
  });
  const separarBtn = document.createElement("button");
  separarBtn.type = "button";
  separarBtn.className = "control-btn-mini";
  separarBtn.textContent = "✂ Separar celdas";
  separarBtn.title = "Selecciona (o haz clic sobre) una celda combinada y haz clic aquí para deshacer la combinación";
  separarBtn.addEventListener("click", () => {
    if (!bloque._selA || !bloque._selB) { alert("Haz clic sobre la celda combinada que quieras separar."); return; }
    const { fMin, fMax, cMin, cMax } = expandirRangoConMerges(bloque.merges, rangoOrdenado(bloque._selA, bloque._selB));
    const quedan = quitarMergesQueIntersectan(bloque.merges, fMin, fMax, cMin, cMax);
    if (quedan.length === bloque.merges.length) { alert("No hay celdas combinadas en la selección."); return; }
    guardarHistorial(estrategiaId);
    bloque.merges = quedan;
    onChange();
  });
  const centrarBtn = document.createElement("button");
  centrarBtn.type = "button";
  centrarBtn.className = "control-btn-mini";
  centrarBtn.textContent = "↔ Centrar";
  centrarBtn.addEventListener("click", () => {
    if (!bloque._selA || !bloque._selB) { alert("Arrastra sobre las celdas que quieras centrar antes de hacer clic aquí."); return; }
    const { fMin, fMax, cMin, cMax } = rangoOrdenado(bloque._selA, bloque._selB);
    bloque.centrados = centrarRango(bloque.centrados, fMin, fMax, cMin, cMax);
    onChange();
  });
  const izquierdaBtn = document.createElement("button");
  izquierdaBtn.type = "button";
  izquierdaBtn.className = "control-btn-mini";
  izquierdaBtn.textContent = "⇤ Izquierda";
  izquierdaBtn.addEventListener("click", () => {
    if (!bloque._selA || !bloque._selB) { alert("Arrastra sobre las celdas que quieras alinear a la izquierda antes de hacer clic aquí."); return; }
    const { fMin, fMax, cMin, cMax } = rangoOrdenado(bloque._selA, bloque._selB);
    bloque.centrados = alinearIzquierdaRango(bloque.centrados, fMin, fMax, cMin, cMax);
    onChange();
  });
  // Centrado VERTICAL (dentro del alto de la fila) — independiente del
  // centrado horizontal de arriba: una celda corta al lado de otra con
  // varias líneas queda con su texto pegado arriba por defecto; este botón
  // la centra en la mitad del alto real de esa fila, tanto en el PDF como
  // en la vista de solo lectura.
  const centrarVerticalBtn = document.createElement("button");
  centrarVerticalBtn.type = "button";
  centrarVerticalBtn.className = "control-btn-mini";
  centrarVerticalBtn.textContent = "↕ Centrar vertical";
  centrarVerticalBtn.title = "Centra el texto en la mitad del alto de la fila (útil cuando una celda de al lado tiene varias líneas y esta queda corta)";
  centrarVerticalBtn.addEventListener("click", () => {
    if (!bloque._selA || !bloque._selB) { alert("Arrastra sobre las celdas que quieras centrar verticalmente antes de hacer clic aquí."); return; }
    const { fMin, fMax, cMin, cMax } = rangoOrdenado(bloque._selA, bloque._selB);
    bloque.centradosVertical = centrarVerticalRango(bloque.centradosVertical, fMin, fMax, cMin, cMax);
    onChange();
  });
  const arribaBtn = document.createElement("button");
  arribaBtn.type = "button";
  arribaBtn.className = "control-btn-mini";
  arribaBtn.textContent = "⬆ Arriba";
  arribaBtn.title = "Vuelve a dejar el texto arriba de la celda (el valor por defecto)";
  arribaBtn.addEventListener("click", () => {
    if (!bloque._selA || !bloque._selB) { alert("Arrastra sobre las celdas antes de hacer clic aquí."); return; }
    const { fMin, fMax, cMin, cMax } = rangoOrdenado(bloque._selA, bloque._selB);
    bloque.centradosVertical = alinearArribaRango(bloque.centradosVertical, fMin, fMax, cMin, cMax);
    onChange();
  });
  const negritaBtn = document.createElement("button");
  negritaBtn.type = "button";
  negritaBtn.className = "control-btn-mini";
  negritaBtn.textContent = "N Negrilla";
  negritaBtn.addEventListener("click", () => {
    if (!bloque._selA || !bloque._selB) { alert("Arrastra sobre las celdas que quieras poner en negrilla antes de hacer clic aquí."); return; }
    const { fMin, fMax, cMin, cMax } = rangoOrdenado(bloque._selA, bloque._selB);
    const yaNegrita = celdaNegrita(bloque.negritas, fMin, cMin);
    bloque.negritas = yaNegrita
      ? quitarNegritaRango(bloque.negritas, fMin, fMax, cMin, cMax)
      : negritaRango(bloque.negritas, fMin, fMax, cMin, cMax);
    onChange();
  });
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.className = "control-tabla-color";
  colorInput.title = "Arrastra sobre las celdas y elige un color para su letra";
  colorInput.value = "#1a1e20";
  colorInput.addEventListener("input", () => {
    if (!bloque._selA || !bloque._selB) return;
    const { fMin, fMax, cMin, cMax } = rangoOrdenado(bloque._selA, bloque._selB);
    bloque.coloresCelda = colorearRango(bloque.coloresCelda, fMin, fMax, cMin, cMax, colorInput.value);
    onChange();
  });
  const colorQuitarBtn = document.createElement("button");
  colorQuitarBtn.type = "button";
  colorQuitarBtn.className = "control-btn-mini";
  colorQuitarBtn.textContent = "Quitar color";
  colorQuitarBtn.addEventListener("click", () => {
    if (!bloque._selA || !bloque._selB) { alert("Arrastra sobre las celdas antes de hacer clic aquí."); return; }
    const { fMin, fMax, cMin, cMax } = rangoOrdenado(bloque._selA, bloque._selB);
    bloque.coloresCelda = colorearRango(bloque.coloresCelda, fMin, fMax, cMin, cMax, null);
    onChange();
  });
  const opcionesBtn = document.createElement("button");
  opcionesBtn.type = "button";
  opcionesBtn.className = "control-btn-mini";
  opcionesBtn.textContent = "☰ Opciones de columna";
  opcionesBtn.title = "Haz clic en una celda de la columna y define una lista fija separada por comas (ej. Sí, No, N.A.) para que esa columna se edite con un desplegable";
  opcionesBtn.addEventListener("click", () => {
    if (!bloque._selA) { alert("Haz clic en una celda de la columna que quieras convertir en lista de opciones."); return; }
    const ci = bloque._selA.ci;
    const actuales = (bloque.opcionesColumna[ci] || []).join(", ");
    const texto = window.prompt("Opciones separadas por coma para esta columna (déjalo vacío para quitar la lista):", actuales);
    if (texto === null) return;
    const opciones = texto.split(",").map((o) => o.trim()).filter(Boolean);
    if (opciones.length) bloque.opcionesColumna[ci] = opciones;
    else delete bloque.opcionesColumna[ci];
    onChange();
  });
  // Agrupa los botones en "tarjeticas" con título propio (en vez de una
  // sola fila corrida de 14 botones) — así se ve de una qué hace cada uno
  // sin tener que leerlos todos.
  function grupoBotones(titulo, elementos) {
    const grupo = document.createElement("div");
    grupo.className = "control-tabla-grupo";
    const tituloEl = document.createElement("div");
    tituloEl.className = "control-tabla-grupo-titulo";
    tituloEl.textContent = titulo;
    const fila = document.createElement("div");
    fila.className = "control-tabla-grupo-botones";
    fila.append(...elementos);
    grupo.append(tituloEl, fila);
    return grupo;
  }
  const grupos = document.createElement("div");
  grupos.className = "control-tabla-grupos";
  grupos.append(
    grupoBotones("Filas y columnas", [agregarFilaArriba, agregarFilaAbajo, quitarFila, agregarCol, quitarCol]),
    grupoBotones("Vaciar tabla", [vaciarBtn]),
    grupoBotones("Pegar datos", [pegarBtn]),
    grupoBotones("Combinar celdas", [combinarBtn, separarBtn]),
    grupoBotones("Alineación y negrilla", [centrarBtn, izquierdaBtn, centrarVerticalBtn, arribaBtn, negritaBtn]),
    grupoBotones("Color de letra", [colorInput, colorQuitarBtn]),
    grupoBotones("Lista desplegable por columna", [opcionesBtn])
  );
  cont.appendChild(grupos);

  const notaInput = document.createElement("input");
  notaInput.type = "text";
  notaInput.maxLength = 200;
  notaInput.placeholder = "Nota / pie de tabla (opcional)";
  notaInput.value = bloque.nota || "";
  notaInput.addEventListener("input", () => { bloque.nota = notaInput.value; });
  cont.appendChild(notaInput);

  // Botones de la barra flotante — cada uno solo repite el clic del botón
  // fijo correspondiente (misma lógica, sin duplicarla), para que se pueda
  // usar la acción sin bajar hasta la barra de grupos de abajo.
  [
    [negritaBtn, "N", "Negrilla"],
    [centrarBtn, "↔", "Centrar"],
    [izquierdaBtn, "⇤", "Izquierda"],
    [combinarBtn, "🔗", "Combinar celdas"],
    [separarBtn, "✂", "Separar celdas"]
  ].forEach(([btnOriginal, texto, titulo]) => {
    const mini = document.createElement("button");
    mini.type = "button";
    mini.className = "control-btn-mini";
    mini.textContent = texto;
    mini.title = titulo;
    mini.addEventListener("mousedown", (e) => e.preventDefault()); // no perder la selección de celdas al hacer clic
    mini.addEventListener("click", () => btnOriginal.click());
    flotante.appendChild(mini);
  });

  return cont;
}

// ---- editor de una imagen (bloque) ----
function renderImagenEditorBloque(bloque, onChange, numero, estrategiaId) {
  const cont = document.createElement("div");

  const filaNombre = document.createElement("div");
  filaNombre.style.display = "flex";
  filaNombre.style.gap = "8px";
  filaNombre.style.alignItems = "center";
  const numeroSpan = document.createElement("span");
  numeroSpan.className = "control-numero-indicativo";
  numeroSpan.textContent = numero ? `Figura ${numero}.` : "";
  numeroSpan.title = "Numeral indicativo — se calcula solo y no se puede cambiar aquí. Es solo una guía de referencia; el número real se recalcula al generar el informe en PDF.";
  const nombre = document.createElement("input");
  nombre.type = "text";
  nombre.maxLength = 200;
  nombre.placeholder = "Nombre de la gráfica/foto (aparece arriba, centrado) — sin \"Figura N.\", eso se agrega solo al generar el PDF";
  nombre.value = bloque.nombre || "";
  nombre.style.flex = "1";
  nombre.style.width = "auto";
  nombre.addEventListener("input", () => { bloque.nombre = nombre.value; });
  filaNombre.append(numeroSpan, nombre);
  cont.appendChild(filaNombre);

  const previewSrc = bloque.previewUrl || bloque.url;
  if (previewSrc) {
    const img = document.createElement("img");
    img.src = previewSrc;
    img.className = "control-bloque-imagen";
    img.style.width = `${bloque.tamano || 85}%`;
    cont.appendChild(img);

    const tamanoFila = document.createElement("div");
    tamanoFila.className = "control-imagen-tamano";
    const tamanoTexto = document.createElement("span");
    tamanoTexto.textContent = `Tamaño en el informe: ${bloque.tamano || 85}%`;
    const tamano = document.createElement("input");
    tamano.type = "range";
    tamano.min = "30";
    tamano.max = "100";
    tamano.step = "5";
    tamano.value = String(bloque.tamano || 85);
    tamano.addEventListener("input", () => {
      bloque.tamano = Number(tamano.value);
      tamanoTexto.textContent = `Tamaño en el informe: ${tamano.value}%`;
      img.style.width = `${tamano.value}%`;
    });
    tamanoFila.append(tamanoTexto, tamano);
    cont.appendChild(tamanoFila);
  } else {
    const aviso = document.createElement("p");
    aviso.className = "text-muted text-sm";
    aviso.textContent = "Todavía no has elegido una imagen.";
    cont.appendChild(aviso);
  }

  const inputArchivo = document.createElement("input");
  inputArchivo.type = "file";
  inputArchivo.accept = "image/*";
  inputArchivo.hidden = true;
  inputArchivo.addEventListener("change", async () => {
    const archivo = inputArchivo.files[0];
    if (!archivo) return;
    try {
      const { blob, previewUrl } = await redimensionarImagen(archivo);
      guardarHistorial(estrategiaId);
      bloque.blob = blob;
      bloque.previewUrl = previewUrl;
      bloque.url = null;
      onChange();
    } catch (e) {
      alert("No se pudo leer esa imagen. Si es una foto de iPhone en formato HEIC, conviértela a JPG o PNG antes de subirla.");
    }
  });
  const btnArchivo = document.createElement("button");
  btnArchivo.type = "button";
  btnArchivo.className = "control-btn-mini";
  btnArchivo.textContent = previewSrc ? "Cambiar imagen" : "+ Elegir imagen";
  btnArchivo.addEventListener("click", () => inputArchivo.click());
  cont.append(btnArchivo, inputArchivo);

  const pie = document.createElement("input");
  pie.type = "text";
  pie.maxLength = 200;
  pie.placeholder = "Pie de foto (aparece abajo, alineado a la derecha)";
  pie.value = bloque.pieDeFoto || "";
  pie.style.marginTop = "8px";
  pie.addEventListener("input", () => { bloque.pieDeFoto = pie.value; });
  cont.appendChild(pie);

  return cont;
}

// ---- editor de un bloque de firma — portado de Cinco SAS control
// (informes.js): etiqueta (Elaboró/Aprobó/Revisó...) + uno o varios
// firmantes en fila, cada uno con nombre, cargo y una imagen de firma
// digital opcional (ver dibujarFirmaBloque en la generación del PDF). ----
function renderFirmaEditorBloque(bloque, onChange, estrategiaId) {
  const cont = document.createElement("div");
  cont.className = "control-firma-editor";

  const etiquetaInput = document.createElement("input");
  etiquetaInput.type = "text";
  etiquetaInput.maxLength = 40;
  etiquetaInput.placeholder = "Etiqueta (ej. Elaboró, Aprobó, Revisó)";
  etiquetaInput.value = bloque.etiqueta || "";
  etiquetaInput.addEventListener("input", () => { bloque.etiqueta = etiquetaInput.value; });
  cont.appendChild(etiquetaInput);

  if (!bloque.firmantes || !bloque.firmantes.length) bloque.firmantes = [{ nombre: "", cargo: "" }];

  const lista = document.createElement("div");
  lista.className = "control-firma-firmantes";
  bloque.firmantes.forEach((firmante, fi) => {
    const filaFirmante = document.createElement("div");
    filaFirmante.className = "control-firma-firmante";

    const nombreInput = document.createElement("input");
    nombreInput.type = "text";
    nombreInput.maxLength = 120;
    nombreInput.placeholder = "Nombre";
    nombreInput.value = firmante.nombre || "";
    nombreInput.addEventListener("input", () => { firmante.nombre = nombreInput.value; });

    const cargoInput = document.createElement("input");
    cargoInput.type = "text";
    cargoInput.maxLength = 120;
    cargoInput.placeholder = "Cargo";
    cargoInput.value = firmante.cargo || "";
    cargoInput.addEventListener("input", () => { firmante.cargo = cargoInput.value; });

    filaFirmante.append(nombreInput, cargoInput);

    const firmaWrap = document.createElement("div");
    firmaWrap.className = "control-firma-imagen-wrap";
    const previewFirma = firmante.firmaPreviewUrl || firmante.firmaUrl;
    if (previewFirma) {
      const imgFirma = document.createElement("img");
      imgFirma.src = previewFirma;
      imgFirma.className = "control-firma-imagen-preview";
      firmaWrap.appendChild(imgFirma);

      const tamanoLabel = document.createElement("label");
      tamanoLabel.className = "control-firma-tamano";
      tamanoLabel.textContent = "Tamaño (mm): ";
      const tamanoInput = document.createElement("input");
      tamanoInput.type = "number";
      tamanoInput.min = "6";
      tamanoInput.max = "60";
      tamanoInput.step = "1";
      tamanoInput.value = firmante.altoFirma || 14;
      tamanoInput.title = "Alto de la firma en mm. Pasado el tamaño normal, la firma empieza a montarse sobre el contenido de arriba (como un sello real) en vez de solo ocupar más espacio en blanco.";
      tamanoInput.addEventListener("input", () => { firmante.altoFirma = Number(tamanoInput.value) || 14; });
      tamanoLabel.appendChild(tamanoInput);
      firmaWrap.appendChild(tamanoLabel);
    }
    const inputFirmaImg = document.createElement("input");
    inputFirmaImg.type = "file";
    inputFirmaImg.accept = "image/*";
    inputFirmaImg.hidden = true;
    inputFirmaImg.addEventListener("change", () => {
      const archivo = inputFirmaImg.files[0];
      if (!archivo) return;
      guardarHistorial(estrategiaId);
      firmante.firmaBlob = archivo;
      firmante.firmaPreviewUrl = URL.createObjectURL(archivo);
      firmante.firmaUrl = null;
      onChange();
    });
    const btnFirmaImg = document.createElement("button");
    btnFirmaImg.type = "button";
    btnFirmaImg.className = "control-btn-mini";
    btnFirmaImg.textContent = previewFirma ? "Cambiar firma digital" : "+ Firma digital";
    btnFirmaImg.title = "Sube una imagen de la firma (ej. escaneada, o una foto de la firma sobre fondo blanco) para que salga arriba del nombre, en vez de dejar el espacio en blanco para firmar a mano";
    btnFirmaImg.addEventListener("click", () => inputFirmaImg.click());
    firmaWrap.append(btnFirmaImg, inputFirmaImg);
    if (previewFirma) {
      const quitarFirmaImgBtn = document.createElement("button");
      quitarFirmaImgBtn.type = "button";
      quitarFirmaImgBtn.className = "control-btn-mini";
      quitarFirmaImgBtn.textContent = "Quitar firma digital";
      quitarFirmaImgBtn.addEventListener("click", () => {
        guardarHistorial(estrategiaId);
        firmante.firmaBlob = null;
        firmante.firmaPreviewUrl = null;
        firmante.firmaUrl = null;
        onChange();
      });
      firmaWrap.appendChild(quitarFirmaImgBtn);
    }
    filaFirmante.appendChild(firmaWrap);

    if (bloque.firmantes.length > 1) {
      const quitarBtn = document.createElement("button");
      quitarBtn.type = "button";
      quitarBtn.className = "control-btn-mini";
      quitarBtn.textContent = "Quitar firmante";
      quitarBtn.addEventListener("click", () => { guardarHistorial(estrategiaId); bloque.firmantes.splice(fi, 1); onChange(); });
      filaFirmante.appendChild(quitarBtn);
    }

    lista.appendChild(filaFirmante);
  });
  cont.appendChild(lista);

  const agregarBtn = document.createElement("button");
  agregarBtn.type = "button";
  agregarBtn.className = "control-btn-mini";
  agregarBtn.textContent = "+ Firmante";
  agregarBtn.title = "Para varios firmantes en la misma fila (ej. todo el equipo que elaboró)";
  agregarBtn.addEventListener("click", () => { guardarHistorial(estrategiaId); bloque.firmantes.push({ nombre: "", cargo: "" }); onChange(); });
  cont.appendChild(agregarBtn);

  return cont;
}

// ---- editor completo de bloques de una estrategia: +Párrafo/+Tabla/
// +Imagen, cada bloque con ↑/↓/Quitar. Se re-renderiza imperativamente
// (no vía innerHTML) para que la cuadrícula de tabla pueda usar mousedown/
// mouseenter (selección tipo Excel) sin depender de atributos onclick en
// el HTML, que la CSP del sitio no permitiría. ----
function renderEditorBloques(estrategiaId, contenedor, inicioNumeracion) {
  const bloques = borradorContenido.get(estrategiaId) || [];
  const numeros = calcularNumerosLocales(bloques, inicioNumeracion);

  function onChange() {
    // Marca esta estrategia como "en edición" ANTES de re-renderizar, para
    // que si un snapshot de Firestore llega justo en este momento, render()
    // no resincronice el contenido desde lo último guardado y borre el
    // bloque que se acaba de agregar/mover/editar (que todavía es solo
    // local, no se ha guardado). No depende de que el mousedown delegado
    // haya alcanzado a marcarlo primero.
    estrategiaEnEdicionGlobal = estrategiaId;
    bloqueSeAcabaDeActualizar = true;
    renderEditorBloques(estrategiaId, contenedor, inicioNumeracion);
    // Se apaga en el siguiente tick — después de que el "focusout" que
    // este mismo render pudo haber disparado (al eliminar el control que
    // tenía el foco) ya alcanzó a revisarla en SU propio setTimeout(0).
    setTimeout(() => { bloqueSeAcabaDeActualizar = false; }, 0);
  }

  contenedor.innerHTML = "";

  // Barra de inserción entre bloques — los mismos 4 botones que la barra de
  // arriba, pero insertan justo en esa posición (índice) en vez de al
  // final, para no depender de mover con ↑/↓ cada vez que hace falta un
  // bloque en medio del contenido.
  function crearBarraInsertar(indice) {
    const barra = document.createElement("div");
    barra.className = "control-bloques-botones control-bloque-gap";
    const btns = [
      ["+ Párrafo", () => ({ tipo: "parrafo", texto: "" })],
      // Título 1 queda reservado al coordinador/administrador — son los
      // encabezados de sección que agrupan varias estrategias (ej.
      // "ESTRATEGIAS DE GESTIÓN"), no algo que cada responsable deba crear
      // dentro de su propio contenido.
      ...(esCoordinador ? [["+ Título 1", () => ({ tipo: "titulo", nivel: 1, texto: "" })]] : []),
      ["+ Título 2", () => ({ tipo: "titulo", nivel: 2, texto: "" })],
      ["+ Título 3", () => ({ tipo: "titulo", nivel: 3, texto: "" })],
      ["+ Título 4", () => ({ tipo: "titulo", nivel: 4, texto: "" })],
      ["+ Tabla", () => nuevaTablaBloque()],
      ["+ Imagen", () => nuevaImagenBloque()],
      ["+ Firma", () => nuevaFirmaBloque()]
    ];
    btns.forEach(([texto, fabrica]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "control-btn-mini";
      btn.textContent = texto;
      btn.addEventListener("click", () => { guardarHistorial(estrategiaId); indicePendienteDeEnfocar = indice; bloques.splice(indice, 0, fabrica()); onChange(); });
      barra.appendChild(btn);
    });
    return barra;
  }

  const lista = document.createElement("div");
  lista.className = "control-bloques";

  const pilaDeshacer = historialBloques.get(estrategiaId) || [];
  const deshacerBtn = document.createElement("button");
  deshacerBtn.type = "button";
  deshacerBtn.className = "control-btn-mini";
  deshacerBtn.textContent = "↩️ Deshacer";
  deshacerBtn.title = "Deshace la última acción que agregó, quitó o cambió la estructura de un bloque/fila/columna/celda en esta sección";
  deshacerBtn.disabled = pilaDeshacer.length === 0;
  deshacerBtn.addEventListener("click", () => {
    const pila = historialBloques.get(estrategiaId);
    if (!pila || !pila.length) return;
    const anterior = pila.pop();
    estrategiaEnEdicionGlobal = estrategiaId;
    bloqueSeAcabaDeActualizar = true;
    borradorContenido.set(estrategiaId, anterior);
    renderEditorBloques(estrategiaId, contenedor, inicioNumeracion);
    setTimeout(() => { bloqueSeAcabaDeActualizar = false; }, 0);
  });
  lista.appendChild(deshacerBtn);
  lista.appendChild(crearBarraInsertar(0));

  let elementoParaEnfocar = null;
  bloques.forEach((bloque, i) => {
    const fila = document.createElement("div");
    fila.className = "control-bloque";

    const contenidoDiv = document.createElement("div");
    contenidoDiv.className = "control-bloque-contenido";

    const etiqueta = document.createElement("span");
    etiqueta.className = "control-bloque-etiqueta";
    etiqueta.textContent = bloque.tipo === "parrafo" ? "Párrafo" : bloque.tipo === "titulo" ? "Título" : bloque.tipo === "tabla" ? "Tabla" : bloque.tipo === "imagen" ? "Imagen" : "Firma";
    contenidoDiv.appendChild(etiqueta);

    if (bloque.tipo === "parrafo") {
      const campo = crearCampoTextoRico({
        valor: bloque.texto || "",
        placeholder: "Gestión realizada en esta estrategia durante el periodo...",
        onInput: (html) => { bloque.texto = html; }
      });
      contenidoDiv.appendChild(campo);
    } else if (bloque.tipo === "titulo") {
      const filaTitulo = document.createElement("div");
      filaTitulo.style.display = "flex";
      filaTitulo.style.gap = "8px";
      filaTitulo.style.alignItems = "center";
      const nivelSel = document.createElement("select");
      nivelSel.style.flex = "0 0 auto";
      nivelSel.style.width = "auto"; // la regla global "select { width:100% }" si no se anula aquí, se come todo el ancho de la fila
      // Título 1 queda reservado al coordinador/administrador. Un
      // responsable normal NO ve "Título 1" entre las opciones para crear
      // uno nuevo (ver crearBarraInsertar más arriba) — pero si el bloque
      // YA es nivel 1 (lo creó el administrador), hay que seguir
      // ofreciendo esa opción para que el desplegable lo muestre bien
      // ("Título 1", no un valor por defecto equivocado como "Título 2"
      // si esa opción no estuviera en la lista) y además BLOQUEARLO
      // (disabled) para que ese responsable no pueda cambiarlo ni por
      // accidente — solo el administrador puede tocar un título 1.
      const esTitulo1Ajeno = !esCoordinador && (bloque.nivel || 1) === 1;
      const nivelesDisponibles = esCoordinador ? [1, 2, 3, 4] : esTitulo1Ajeno ? [1] : [2, 3, 4];
      nivelesDisponibles.forEach((n) => {
        const opt = document.createElement("option");
        opt.value = String(n);
        opt.textContent = `Título ${n}`;
        if ((bloque.nivel || 1) === n) opt.selected = true;
        nivelSel.appendChild(opt);
      });
      if (esTitulo1Ajeno) {
        nivelSel.disabled = true;
        nivelSel.title = "Este título de nivel 1 lo creó el administrador — solo el administrador puede cambiarlo.";
      }
      nivelSel.addEventListener("change", () => { bloque.nivel = Number(nivelSel.value); onChange(); });
      const numeroSpan = document.createElement("span");
      numeroSpan.className = "control-numero-indicativo";
      numeroSpan.textContent = numeros[i] ? `${numeros[i]}.` : "";
      numeroSpan.title = "Numeral indicativo — se calcula solo y no se puede cambiar aquí. Es solo una guía de referencia; el número real se recalcula al generar el informe en PDF.";
      const textoInput = document.createElement("input");
      textoInput.type = "text";
      textoInput.maxLength = 300;
      textoInput.placeholder = "Texto del título/subtítulo, ej. \"Identificación de...\" — sin numerar, el número se agrega solo al generar el PDF";
      textoInput.value = bloque.texto || "";
      textoInput.style.flex = "1";
      textoInput.style.width = "auto"; // idem — deja que "flex:1" reparta el espacio, no "width:100%"
      textoInput.addEventListener("input", () => { bloque.texto = textoInput.value; });
      filaTitulo.append(nivelSel, numeroSpan, textoInput);
      contenidoDiv.appendChild(filaTitulo);
    } else if (bloque.tipo === "tabla") {
      contenidoDiv.appendChild(renderTablaEditorBloque(bloque, onChange, numeros[i], estrategiaId));
    } else if (bloque.tipo === "imagen") {
      contenidoDiv.appendChild(renderImagenEditorBloque(bloque, onChange, numeros[i], estrategiaId));
    } else if (bloque.tipo === "firma") {
      contenidoDiv.appendChild(renderFirmaEditorBloque(bloque, onChange, estrategiaId));
    }
    fila.appendChild(contenidoDiv);

    if (i === indicePendienteDeEnfocar) {
      indicePendienteDeEnfocar = null;
      elementoParaEnfocar = contenidoDiv.querySelector("textarea, input, select, button");
    }

    const controles = document.createElement("div");
    controles.className = "control-bloque-controles";
    const subir = document.createElement("button");
    subir.type = "button";
    subir.className = "control-btn-mini";
    subir.textContent = "↑";
    subir.disabled = i === 0;
    subir.addEventListener("click", () => { guardarHistorial(estrategiaId); [bloques[i - 1], bloques[i]] = [bloques[i], bloques[i - 1]]; onChange(); });
    const bajar = document.createElement("button");
    bajar.type = "button";
    bajar.className = "control-btn-mini";
    bajar.textContent = "↓";
    bajar.disabled = i === bloques.length - 1;
    bajar.addEventListener("click", () => { guardarHistorial(estrategiaId); [bloques[i], bloques[i + 1]] = [bloques[i + 1], bloques[i]]; onChange(); });
    const quitar = document.createElement("button");
    quitar.type = "button";
    quitar.className = "control-btn-danger";
    quitar.textContent = "Quitar";
    quitar.addEventListener("click", () => { guardarHistorial(estrategiaId); bloques.splice(i, 1); onChange(); });
    // "Guardar avance" también junto a cada bloque (no solo arriba/abajo de
    // toda la tarjeta) — a pedido del usuario, para poder guardar justo
    // después de agregar/editar un bloque puntual sin tener que ubicar el
    // botón general. Mismo data-guardar que los otros: el click delegado en
    // listaEstrategiasEl ya sabe manejarlo sin importar cuántos botones haya.
    const guardarAqui = document.createElement("button");
    guardarAqui.type = "button";
    guardarAqui.className = "control-btn-mini";
    guardarAqui.textContent = "💾 Guardar avance";
    guardarAqui.dataset.guardar = estrategiaId;
    controles.append(subir, bajar);
    controles.appendChild(quitar);
    controles.appendChild(guardarAqui);
    fila.appendChild(controles);

    lista.appendChild(fila);
    lista.appendChild(crearBarraInsertar(i + 1));
  });

  contenedor.appendChild(lista);
  elementoParaEnfocar?.focus();
}

// ---- vista de solo lectura de los bloques (para quien no puede editar) ----
function bloquesASoloLecturaHTML(bloques) {
  if (!bloques.length) return '<p class="text-muted text-sm">Sin contenido registrado.</p>';
  return bloques.map((b) => {
    if (b.tipo === "parrafo") {
      const html = htmlParaCampoRico(b.texto);
      return `<div class="m-0">${html || '<span class="text-muted">Sin contenido registrado.</span>'}</div>`;
    }
    if (b.tipo === "titulo") {
      const nivel = Math.min(4, Math.max(1, Number(b.nivel) || 1));
      const TAMANOS = { 1: "14.5px", 2: "13.5px", 3: "12.5px", 4: "12.5px" };
      const estilo = nivel <= 2 ? "font-weight:700" : "font-weight:700;font-style:italic";
      const texto = (b.texto || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
      return `<p class="m-0" style="font-size:${TAMANOS[nivel]};${estilo};margin-top:8px">${texto}</p>`;
    }
    if (b.tipo === "imagen") {
      if (!b.url && !b.previewUrl) return "";
      return `
        <figure class="m-0">
          <img src="${b.url || b.previewUrl}" style="width:${b.tamano || 85}%;max-width:100%;border-radius:6px;display:block;">
          ${b.nombre ? `<figcaption style="text-align:center;font-weight:600;font-size:12.5px;margin-top:4px;">${b.nombre}</figcaption>` : ""}
          ${b.pieDeFoto ? `<figcaption style="text-align:right;font-style:italic;font-size:11.5px;color:var(--text-muted);">${b.pieDeFoto}</figcaption>` : ""}
        </figure>`;
    }
    if (b.tipo === "tabla") {
      const numFilas = b.filas.length;
      const numCols = Math.max(...b.filas.map((f) => f.length));
      const merges = normalizarMerges(b.merges || [], numFilas, numCols);
      let filasHTML = "";
      b.filas.forEach((fila, fi) => {
        let celdasHTML = "";
        for (let ci = 0; ci < numCols; ci++) {
          const info = celdaCombinada(merges, fi, ci);
          if (info && !info.esAncla) continue;
          const rowspan = info ? info.merge.filas : 1;
          const colspan = info ? info.merge.cols : 1;
          const negrita = fi === 0 || celdaNegrita(b.negritas, fi, ci);
          const centrado = celdaCentrada(b.centrados, fi, ci);
          const centradoV = celdaCentradaVertical(b.centradosVertical, fi, ci);
          const color = colorCelda(b.coloresCelda, fi, ci);
          const estilos = [
            "border:1px solid var(--border)", "padding:5px 8px", "font-size:12.5px",
            negrita ? "font-weight:700" : "", centrado ? "text-align:center" : "text-align:left",
            `vertical-align:${centradoV ? "middle" : "top"}`,
            color ? `color:${color}` : "", fi === 0 ? "background:rgba(0,0,0,0.03)" : ""
          ].filter(Boolean).join(";");
          const valor = String(fila[ci] || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
          celdasHTML += `<td rowspan="${rowspan}" colspan="${colspan}" style="${estilos}">${valor}</td>`;
        }
        filasHTML += `<tr>${celdasHTML}</tr>`;
      });
      return `
        <div>
          ${b.titulo ? `<p style="text-align:center;font-weight:700;font-size:12.5px;margin:0 0 4px;">${b.titulo}</p>` : ""}
          <div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%">${filasHTML}</table></div>
          ${b.nota ? `<p style="text-align:right;font-style:italic;font-size:11.5px;color:var(--text-muted);margin:2px 0 0;">${b.nota}</p>` : ""}
        </div>`;
    }
    if (b.tipo === "firma") {
      const firmantes = b.firmantes && b.firmantes.length ? b.firmantes : [{ nombre: "", cargo: "" }];
      const columnas = firmantes.map((f) => `
        <div style="flex:1;text-align:center;min-width:120px;">
          ${f.firmaUrl ? `<img src="${f.firmaUrl}" style="max-height:60px;max-width:90%;display:block;margin:0 auto 4px;">` : ""}
          <p class="m-0" style="font-weight:700;font-size:12.5px;border-top:1px solid var(--border);padding-top:3px;">${(f.nombre || "&nbsp;").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>
          ${f.cargo ? `<p class="m-0 text-muted" style="font-size:11.5px;">${f.cargo.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>` : ""}
        </div>`).join("");
      return `
        <div>
          ${b.etiqueta ? `<p class="m-0" style="font-weight:700;font-size:12.5px;">${b.etiqueta.toUpperCase()}</p>` : ""}
          <div style="display:flex;gap:12px;margin-top:20px;flex-wrap:wrap;">${columnas}</div>
        </div>`;
    }
    return "";
  }).join('<div style="height:10px"></div>');
}

// ======================================================================
// Catálogo de nombres de estrategia/subtítulo ya usados (autocompletar)
// ======================================================================
const catalogoDatalist = document.getElementById("catalogoEstrategiasList");
async function cargarCatalogoEstrategias() {
  try {
    const snap = await getDoc(doc(db, "configuracion", "informesGestion"));
    const nombres = snap.exists() ? (snap.data().catalogoEstrategias || []) : [];
    catalogoDatalist.innerHTML = nombres.map((n) => `<option value="${String(n).replace(/"/g, "&quot;")}"></option>`).join("");
  } catch {
    // Autocompletar es cosmético — si falla la lectura, los campos siguen siendo de texto libre.
  }
}
async function guardarEnCatalogo(nombres) {
  const lista = Array.from(nombres).map((n) => (n || "").trim()).filter(Boolean);
  if (lista.length === 0) return;
  try {
    await setDoc(doc(db, "configuracion", "informesGestion"), { catalogoEstrategias: arrayUnion(...lista) }, { merge: true });
  } catch {
    // No bloquea el flujo si falla — es solo para que el próximo informe sugiera estos nombres.
  }
}
if (esCoordinador) await cargarCatalogoEstrategias();

// ======================================================================
// Vista listado (sin ?id= en la URL)
// ======================================================================
if (!informeId) {
  document.getElementById("vistaListado").classList.remove("hidden");
  if (esCoordinador) {
    document.getElementById("crearCard").classList.remove("hidden");
  }

  let filaContador = 0;
  function actualizarNotaSubtitulos(filaId) {
    const cont = document.querySelector(`[data-fila-subtitulos="${filaId}"]`);
    const sel = document.querySelector(`[data-fila-responsables="${filaId}"]`);
    const nota = document.querySelector(`[data-fila-nota="${filaId}"]`);
    if (!cont || !sel || !nota) return;
    const tieneSubs = cont.children.length > 0;
    sel.disabled = tieneSubs;
    sel.required = !tieneSubs;
    if (tieneSubs) Array.from(sel.options).forEach((o) => { o.selected = false; });
    nota.classList.toggle("hidden", !tieneSubs);
  }

  function agregarSubfila(filaId) {
    const cont = document.querySelector(`[data-fila-subtitulos="${filaId}"]`);
    if (!cont) return;
    const subId = `${filaId}-${cont.children.length + 1}-${Date.now()}`;
    const div = document.createElement("div");
    div.className = "item-card estrategia-hija";
    div.dataset.subfila = subId;
    div.dataset.filaPadre = filaId;
    div.innerHTML = `
      <div class="toolbar">
        <input type="text" list="catalogoEstrategiasList" placeholder="Nombre del subtítulo/zona" data-subfila-nombre="${subId}" required maxlength="200" style="flex:1;min-width:200px">
        <button type="button" class="btn secondary btn-auto" data-subfila-quitar="${subId}">🗑️</button>
      </div>
      <select multiple size="3" data-subfila-responsables="${subId}" required>${opcionesEmpleados()}</select>
    `;
    cont.appendChild(div);
    actualizarNotaSubtitulos(filaId);
  }

  function agregarFilaEstrategia() {
    filaContador++;
    const id = filaContador;
    const div = document.createElement("div");
    div.className = "card item-card bloque-card";
    div.dataset.fila = id;
    div.innerHTML = `
      <div class="toolbar">
        <input type="text" list="catalogoEstrategiasList" placeholder="Nombre de la estrategia" data-fila-nombre="${id}" required maxlength="200" style="flex:1;min-width:220px">
        <button type="button" class="btn secondary btn-auto" data-fila-quitar="${id}">🗑️ Quitar</button>
      </div>
      <label>Responsable(s) — Ctrl/Cmd+clic para elegir varios</label>
      <select multiple size="4" data-fila-responsables="${id}" required>${opcionesEmpleados()}</select>
      <p class="text-muted text-sm m-0 hidden" data-fila-nota="${id}">Esta estrategia se editará por subtítulos/zonas — no necesita responsable propio.</p>
      <div data-fila-subtitulos="${id}"></div>
      <button type="button" class="btn secondary btn-auto mt-4" data-fila-agregar-sub="${id}">+ Agregar subtítulo/zona</button>
    `;
    document.getElementById("estrategiasFilas").appendChild(div);
  }
  document.getElementById("agregarEstrategiaBtn").addEventListener("click", agregarFilaEstrategia);
  agregarFilaEstrategia();

  document.getElementById("estrategiasFilas").addEventListener("click", (e) => {
    const filaId = e.target.dataset.filaQuitar;
    if (filaId) { document.querySelector(`[data-fila="${filaId}"]`)?.remove(); return; }

    const agregarSubId = e.target.dataset.filaAgregarSub;
    if (agregarSubId) { agregarSubfila(agregarSubId); return; }

    const subQuitarId = e.target.dataset.subfilaQuitar;
    if (subQuitarId) {
      const padreId = document.querySelector(`[data-subfila="${subQuitarId}"]`)?.dataset.filaPadre;
      document.querySelector(`[data-subfila="${subQuitarId}"]`)?.remove();
      if (padreId) actualizarNotaSubtitulos(padreId);
    }
  });

  let informesCache = [];
  const listaEl = document.getElementById("listaInformes");
  onSnapshot(query(collection(db, "informesGestion"), orderBy("creadoEn", "desc")), (snap) => {
    informesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (informesCache.length === 0) {
      listaEl.innerHTML = '<p class="text-muted text-center">Aún no hay informes de gestión creados.</p>';
      return;
    }
    listaEl.innerHTML = `<div class="informes-grid">${informesCache.map((i) => `
      <a href="informes-gestion.html?id=${i.id}" class="informe-card">
        <h3>${i.contrato}</h3>
        <div class="informe-card-badges">
          <span class="badge muted">${i.periodoLabel}</span>
          <span class="badge ${i.estado === "consolidado" ? "ok" : "warn"}">${ESTADO_INFORME_TEXTO[i.estado] || i.estado}</span>
        </div>
        <p class="informe-card-meta">Creado por ${i.creadoPorNombre || "-"} · ${formatDate(i.creadoEn)}</p>
      </a>
    `).join("")}</div>`;
  }, (err) => {
    listaEl.innerHTML = `<p class="text-muted text-center">${friendlyError(err)}</p>`;
  });

  if (esCoordinador) {
    document.getElementById("crearForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const alertBox = document.getElementById("crearAlertBox");
      const btn = document.getElementById("crearBtn");
      clearAlert(alertBox);

      const contrato = document.getElementById("contrato").value.trim();
      const periodo = document.getElementById("periodo").value; // "YYYY-MM"
      const filas = Array.from(document.querySelectorAll("#estrategiasFilas [data-fila]")).map((div) => {
        const filaId = div.dataset.fila;
        const nombre = div.querySelector(`[data-fila-nombre="${filaId}"]`).value.trim();
        const subfilas = Array.from(div.querySelectorAll("[data-subfila]")).map((subdiv) => {
          const subId = subdiv.dataset.subfila;
          return {
            nombre: subdiv.querySelector(`[data-subfila-nombre="${subId}"]`).value.trim(),
            responsables: Array.from(subdiv.querySelector(`[data-subfila-responsables="${subId}"]`).selectedOptions).map((o) => o.value)
          };
        });
        const responsables = subfilas.length === 0
          ? Array.from(div.querySelector(`[data-fila-responsables="${filaId}"]`).selectedOptions).map((o) => o.value)
          : [];
        return { nombre, responsables, subfilas };
      });

      if (!contrato || !periodo) {
        showAlert(alertBox, "Completa el contrato y el periodo.", "error");
        return;
      }
      if (filas.length === 0 || filas.some((f) => !f.nombre)) {
        showAlert(alertBox, "Cada estrategia necesita un nombre.", "error");
        return;
      }
      if (filas.some((f) => f.subfilas.length === 0 && f.responsables.length === 0)) {
        showAlert(alertBox, "Cada estrategia sin subtítulos necesita al menos un responsable.", "error");
        return;
      }
      if (filas.some((f) => f.subfilas.some((sf) => !sf.nombre || sf.responsables.length === 0))) {
        showAlert(alertBox, "Cada subtítulo/zona necesita nombre y al menos un responsable.", "error");
        return;
      }
      const [anio, mes] = periodo.split("-").map(Number);
      const periodoLabel = new Date(anio, mes - 1, 1).toLocaleDateString("es-CO", { year: "numeric", month: "long" });
      const yaExiste = informesCache.some((i) => i.contrato.toLowerCase() === contrato.toLowerCase() && i.anio === anio && i.mes === mes);
      if (yaExiste && !confirm(`Ya existe un informe de gestión para ${contrato} en ${periodoLabel}. ¿Crear otro de todas formas?`)) {
        return;
      }

      btn.disabled = true;
      btn.textContent = "Creando...";
      try {
        const nuevoInforme = await addDoc(collection(db, "informesGestion"), {
          contrato,
          periodoLabel,
          anio,
          mes,
          prefijoNumeracion: "",
          estado: "borrador",
          creadoPor: user.uid,
          creadoPorNombre: perfil.nombre || user.email,
          creadoEn: serverTimestamp(),
          consolidadoEn: null,
          consolidadoPor: null
        });

        const nombresUsados = new Set();
        for (const [i, f] of filas.entries()) {
          nombresUsados.add(f.nombre);
          const padre = await addDoc(collection(db, "informesGestion", nuevoInforme.id, "estrategias"), {
            nombre: f.nombre,
            orden: i,
            padreId: null,
            responsables: f.responsables,
            responsablesNombres: f.responsables.map(nombrePorUid),
            contenido: "",
            estado: "pendiente",
            actualizadoEn: null,
            actualizadoPor: null,
            actualizadoPorNombre: null,
            creadoEn: serverTimestamp()
          });
          await Promise.all(f.subfilas.map((sf, j) => {
            nombresUsados.add(sf.nombre);
            return addDoc(collection(db, "informesGestion", nuevoInforme.id, "estrategias"), {
              nombre: sf.nombre,
              orden: j,
              padreId: padre.id,
              responsables: sf.responsables,
              responsablesNombres: sf.responsables.map(nombrePorUid),
              contenido: "",
              estado: "pendiente",
              actualizadoEn: null,
              actualizadoPor: null,
              actualizadoPorNombre: null,
              creadoEn: serverTimestamp()
            });
          }));
        }
        await guardarEnCatalogo(nombresUsados);
        window.location.href = `informes-gestion.html?id=${nuevoInforme.id}`;
      } catch (err) {
        showAlert(alertBox, friendlyError(err), "error");
        btn.disabled = false;
        btn.textContent = "Crear informe";
      }
    });
  }
}

// ======================================================================
// Vista detalle (?id=xxx)
// ======================================================================
if (informeId) {
  document.getElementById("vistaDetalle").classList.remove("hidden");
  if (esCoordinador) document.getElementById("agregarEstrategiaCard").classList.remove("hidden");

  const informeRef = doc(db, "informesGestion", informeId);
  let informeActual = null;
  let estrategiasActuales = [];
  let focoActualizadoEnInicial = null; // "actualizadoEn" que traía la estrategia al entrar en foco (para detectar cambios ajenos)
  // ids de estrategias/zonas desplegadas (acordeón) — todas arrancan
  // colapsadas; se guarda aparte del DOM porque render() reconstruye
  // el.className en cada snapshot y lo perdería si solo viviera como clase.
  const estrategiasExpandidas = new Set();

  const esEncabezado = (id) => estrategiasActuales.some((x) => x.padreId === id);

  function misEstrategiasNombres() {
    return estrategiasActuales.filter((e) => (e.responsables || []).includes(user.uid) && !esEncabezado(e.id)).map((e) => e.nombre);
  }

  // Orden visual de las estrategias/subtítulos (principal, luego sus
  // hijos) según su campo "orden" — sin número calculado: a pedido del
  // usuario, ni las tarjetas ni los títulos internos llevan numeración
  // automática (venía duplicando el número que la persona ya escribía a
  // mano en el texto, arrastrado del informe extraído de Word).
  function ordenVisual() {
    const principales = estrategiasActuales.filter((x) => !x.padreId).sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
    const lista = [];
    principales.forEach((p) => {
      lista.push({ ...p });
      estrategiasActuales.filter((x) => x.padreId === p.id).sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0)).forEach((h) => {
        lista.push({ ...h });
      });
    });
    const idsVisibles = new Set(lista.map((x) => x.id));
    estrategiasActuales.forEach((x) => { if (!idsVisibles.has(x.id)) lista.push({ ...x }); });
    return lista;
  }

  function renderCabecera() {
    if (!informeActual) return;
    document.getElementById("detalleTitulo").textContent = `${informeActual.contrato} — ${informeActual.periodoLabel}`;
    document.getElementById("detalleSubtitulo").innerHTML =
      `<span class="badge ${informeActual.estado === "consolidado" ? "ok" : "warn"}">${ESTADO_INFORME_TEXTO[informeActual.estado]}</span> Creado por ${informeActual.creadoPorNombre || "-"} · ${formatDate(informeActual.creadoEn)}`;

    const evaluables = estrategiasActuales.filter((e) => !esEncabezado(e.id));
    const total = evaluables.length;
    const completas = evaluables.filter((e) => e.estado === "completo").length;
    const pct = total ? Math.round((completas / total) * 100) : 0;
    document.getElementById("progresoFill").style.width = `${pct}%`;
    document.getElementById("progresoTexto").textContent = `${completas} de ${total} estrategias/zonas completas (${pct}%)`;

    const consolidarBtn = document.getElementById("consolidarBtn");
    if (esCoordinador) {
      consolidarBtn.classList.remove("hidden");
      consolidarBtn.textContent = informeActual.estado === "consolidado" ? "🔓 Reabrir informe" : "🔒 Consolidar informe";
      document.getElementById("eliminarInformeBtn").classList.remove("hidden");
      document.getElementById("duplicarInformeToggleBtn").classList.remove("hidden");
      document.getElementById("portadaToggleBtn").classList.remove("hidden");
      document.getElementById("notificarToggleBtn").classList.remove("hidden");
      document.getElementById("incumplimientoToggleBtn").classList.remove("hidden");
      document.getElementById("editarInformeToggleBtn").classList.remove("hidden");
    }

    const notificadoTexto = document.getElementById("notificadoTexto");
    if (informeActual.notificadoEn) {
      notificadoTexto.textContent = `📧 Responsables notificados: ${informeActual.notificadoPorNombre || "-"} · ${formatDate(informeActual.notificadoEn)}${informeActual.fechaLimite ? ` · Fecha límite: ${new Date(informeActual.fechaLimite).toLocaleString("es-CO", { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}` : ""}`;
      notificadoTexto.classList.remove("hidden");
    } else {
      notificadoTexto.classList.add("hidden");
    }
  }

  function panelesCoordinador(e) {
    if (!esCoordinador) return "";
    const hermanos = estrategiasActuales.filter((x) => x.padreId === e.padreId).sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
    const posicion = hermanos.findIndex((x) => x.id === e.id);
    return `
      <div class="toolbar">
        <button type="button" class="btn secondary btn-auto" data-mover="${e.id}" data-direccion="-1" title="Mover arriba" ${posicion <= 0 ? "disabled" : ""}>↑</button>
        <button type="button" class="btn secondary btn-auto" data-mover="${e.id}" data-direccion="1" title="Mover abajo" ${posicion === hermanos.length - 1 ? "disabled" : ""}>↓</button>
        <button type="button" class="btn secondary btn-auto" data-reasignar-toggle="${e.id}">✏️ ${esEncabezado(e.id) ? "Renombrar" : "Reasignar"}: ${e.nombre}</button>
        <button type="button" class="btn secondary btn-auto danger" data-eliminar-estrategia="${e.id}">🗑️ Eliminar</button>
      </div>
      <div class="hidden" data-reasignar-panel="${e.id}">
        <label>Nombre</label>
        <input type="text" data-reasignar-nombre="${e.id}" value="${(e.nombre || "").replace(/"/g, "&quot;")}" maxlength="200">
        ${esEncabezado(e.id) ? "" : `
        <label>Responsable(s)</label>
        <select multiple size="4" data-reasignar-responsables="${e.id}">${opcionesEmpleados(e.responsables || [])}</select>`}
        <button type="button" class="btn secondary btn-auto mt-4" data-reasignar-guardar="${e.id}">Guardar</button>
      </div>
    `;
  }

  function cardHTML(e) {
    if (esEncabezado(e.id)) {
      // Un encabezado no tiene responsable propio, pero sí puede necesitar
      // contenido propio (ej. un título que introduzca el grupo antes de
      // sus zonas) — solo el coordinador lo edita, ya que no hay a quién
      // más asignárselo.
      return `
        <div class="toolbar collapsible-toggle" data-toggle-card="${e.id}">
          <h3 class="m-0">${e.nombre}</h3>
          <span class="badge muted">Grupo de subtítulos/zonas</span>
          <span class="collapsible-chevron">▾</span>
        </div>
        <div class="collapsible-form"><div class="collapsible-form-inner">
          ${panelesCoordinador(e)}
          <p class="text-muted text-sm m-0">Esta estrategia se reporta por subtítulos/zonas — cada una la edita su propio responsable, justo debajo. ${esCoordinador ? "Como coordinador, puedes agregar aquí un título/párrafo/tabla/imagen que introduzca el grupo." : ""}</p>
          ${esCoordinador ? `
            <div data-bloques="${e.id}"></div>
            <div class="toolbar">
              <button type="button" class="btn secondary btn-auto" data-guardar="${e.id}">💾 Guardar avance</button>
            </div>
          ` : ""}
          <div class="toolbar">
            <button type="button" class="control-btn-mini" data-toggle-card="${e.id}">🔼 Cerrar esta sección</button>
          </div>
        </div></div>
      `;
    }

    const esResponsable = (e.responsables || []).includes(user.uid);
    const puedeEditar = esCoordinador || (esResponsable && informeActual?.estado !== "consolidado");
    const soloLecturaPorConsolidado = esResponsable && !esCoordinador && informeActual?.estado === "consolidado";
    const responsablesTexto = (e.responsablesNombres || []).join(", ") || "sin asignar";
    const ultimaEdicion = e.actualizadoEn ? `Última edición: ${e.actualizadoPorNombre || "-"} · ${formatDate(e.actualizadoEn)}` : "Sin editar todavía";

    let mensajeCandado = "";
    if (!esCoordinador && !esResponsable) {
      const mias = misEstrategiasNombres();
      mensajeCandado = `<p class="text-muted text-sm">🔒 No puedes editar este contenido — solo lo puede editar: <strong>${responsablesTexto}</strong>. ${mias.length ? `Tú puedes editar: <strong>${mias.join(", ")}</strong>.` : "No tienes ninguna estrategia asignada en este informe."}</p>`;
    } else if (soloLecturaPorConsolidado) {
      mensajeCandado = `<p class="text-muted text-sm">🔒 Este informe ya fue consolidado — solo el coordinador puede reabrirlo o editarlo.</p>`;
    }

    return `
      <div class="toolbar collapsible-toggle" data-toggle-card="${e.id}">
        <h3 class="m-0">${e.nombre}</h3>
        <span class="badge ${ESTADO_ESTRATEGIA_BADGE[e.estado]}">${ESTADO_ESTRATEGIA_TEXTO[e.estado]}</span>
        <span class="badge muted">👤 ${responsablesTexto}</span>
        <span class="collapsible-chevron">▾</span>
      </div>
      ${mensajeCandado}
      <div class="collapsible-form"><div class="collapsible-form-inner">
        ${panelesCoordinador(e)}
        <div class="alert warn hidden" data-conflicto="${e.id}"></div>
        ${estrategiasConCambiosSinGuardar.has(e.id) ? `<div class="alert warn">⚠️ Esta sección tiene cambios sin guardar de un momento anterior que no se sincronizaron con el servidor — revisa el contenido de abajo y haz clic en "Guardar avance" para no perderlos.</div>` : ""}
        ${puedeEditar ? `
          <div class="toolbar">
            <label class="m-0">Estado</label>
            <select data-estado="${e.id}">
              <option value="pendiente" ${e.estado === "pendiente" ? "selected" : ""}>Pendiente</option>
              <option value="en_progreso" ${e.estado === "en_progreso" ? "selected" : ""}>En progreso</option>
              <option value="completo" ${e.estado === "completo" ? "selected" : ""}>Completo</option>
            </select>
            <button type="button" class="btn secondary btn-auto" data-guardar="${e.id}">💾 Guardar avance</button>
          </div>
          <p class="text-muted text-sm m-0">⬆️ Guarda seguido, sobre todo si vas a agregar un bloque y luego salir de esta tarjeta — los cambios sin guardar se pueden perder si sales sin guardar antes.</p>
        ` : ""}
        ${puedeEditar
          ? `<div data-bloques="${e.id}"></div>`
          : bloquesASoloLecturaHTML(contenidoABloques(e.contenido))}
        <p class="text-muted text-sm m-0">${ultimaEdicion}</p>
        ${puedeEditar ? `
          <div class="toolbar">
            <button type="button" class="btn secondary btn-auto" data-guardar="${e.id}">💾 Guardar avance</button>
          </div>
        ` : ""}
        <div class="toolbar">
          <button type="button" class="control-btn-mini" data-toggle-card="${e.id}">🔼 Cerrar esta sección</button>
        </div>
      </div></div>
    `;
  }

  function actualizarBannerConflicto(el, e) {
    const banner = el.querySelector(`[data-conflicto="${e.id}"]`);
    if (!banner) return;
    const cambioAjeno = !!(focoActualizadoEnInicial && e.actualizadoEn && e.actualizadoEn.toMillis
      && focoActualizadoEnInicial.toMillis && e.actualizadoEn.toMillis() !== focoActualizadoEnInicial.toMillis()
      && e.actualizadoPor !== user.uid);
    banner.classList.toggle("hidden", !cambioAjeno);
    if (cambioAjeno) banner.textContent = `⚠️ ${e.actualizadoPorNombre || "Otra persona"} actualizó esta sección mientras la editabas. Revisa el contenido antes de guardar para no sobrescribir su cambio.`;
  }

  const listaEstrategiasEl = document.getElementById("listaEstrategias");
  function render() {
    if (!informeActual) return;
    renderCabecera();
    if (estrategiasActuales.length === 0) {
      listaEstrategiasEl.innerHTML = '<div class="card"><p class="text-muted text-center">Este informe todavía no tiene estrategias.</p></div>';
      return;
    }
    if (listaEstrategiasEl.querySelector("p.text-center")) listaEstrategiasEl.innerHTML = "";

    const visual = ordenVisual();
    const inicioNumeracion = calcularInicioNumeracionPorEstrategia(visual);
    const idsVigentes = visual.map((e) => e.id);
    Array.from(listaEstrategiasEl.children).forEach((el) => {
      if (!idsVigentes.includes(el.dataset.id)) el.remove();
    });
    visual.forEach((e, i) => {
      let el = listaEstrategiasEl.querySelector(`[data-id="${e.id}"]`);
      if (!el) {
        el = document.createElement("div");
        el.dataset.id = e.id;
        listaEstrategiasEl.appendChild(el);
      }
      el.className = (e.padreId ? "card estrategia-hija" : "card") + (estrategiasExpandidas.has(e.id) ? " abierto" : "");
      if (e.id === estrategiaEnEdicionGlobal) {
        actualizarBannerConflicto(el, e);
        return;
      }
      // No está "en edición" ahora mismo (según el rastreo de foco): en
      // principio es seguro resincronizar el borrador local con lo último
      // guardado en Firestore. Pero como red de seguridad adicional —por si
      // el rastreo de foco se equivoca y da por salida una tarjeta que en
      // realidad seguía con cambios sin guardar—, si el borrador que ya
      // había (de una visita anterior a esta misma sesión) es DISTINTO de lo
      // que hay en el servidor, no se sobreescribe en silencio: se conserva
      // el borrador local y se avisa con un banner, en vez de perder esos
      // cambios sin que la persona se entere.
      if (estrategiasRecienGuardadas.has(e.id)) {
        // Acabamos de guardar esta estrategia nosotros mismos hace un
        // instante — el servidor puede tardar un momento en reflejarlo en
        // estrategiasActuales. Se deja pasar esta comparación puntual sin
        // marcar nada (el borrador local, que ya es justo lo que se
        // guardó, se conserva tal cual).
        estrategiasRecienGuardadas.delete(e.id);
        estrategiasConCambiosSinGuardar.delete(e.id);
      } else {
        const contenidoServidor = contenidoABloques(e.contenido);
        const borradorPrevio = borradorContenido.get(e.id);
        const hayCambiosSinGuardar = borradorPrevio !== undefined && !sonIguales(borradorPrevio, contenidoServidor);
        if (hayCambiosSinGuardar) {
          estrategiasConCambiosSinGuardar.add(e.id);
        } else {
          borradorContenido.set(e.id, contenidoServidor);
          estrategiasConCambiosSinGuardar.delete(e.id);
        }
      }
      el.innerHTML = cardHTML(e);
      if (listaEstrategiasEl.children[i] !== el) listaEstrategiasEl.insertBefore(el, listaEstrategiasEl.children[i]);
      const bloquesCont = el.querySelector(`[data-bloques="${e.id}"]`);
      if (bloquesCont) renderEditorBloques(e.id, bloquesCont, inicioNumeracion.get(e.id));
    });
  }

  onSnapshot(informeRef, (snap) => {
    if (!snap.exists()) {
      document.getElementById("vistaDetalle").innerHTML = '<div class="card"><p class="text-muted text-center">Este informe no existe o fue eliminado.</p></div>';
      return;
    }
    informeActual = { id: snap.id, ...snap.data() };
    render();
  }, (err) => {
    document.getElementById("vistaDetalle").innerHTML = `<div class="card"><p class="text-muted text-center">${friendlyError(err)}</p></div>`;
  });

  onSnapshot(collection(db, "informesGestion", informeId, "estrategias"), (snap) => {
    estrategiasActuales = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });

  // Congela la tarjeta que la persona está trabajando (para que un snapshot
  // de otra estrategia no le borre lo que va a mitad de construir: un
  // párrafo, una tabla, una imagen), y la libera al salir de toda la
  // tarjeta para traer la versión más fresca.
  function idEstrategiaDesde(el) {
    return el?.closest ? el.closest("[data-id]")?.dataset.id || null : null;
  }
  listaEstrategiasEl.addEventListener("focusin", (e) => {
    const id = e.target.dataset.contenido ? e.target.dataset.contenido : idEstrategiaDesde(e.target.closest("[data-bloques]"));
    if (!id || e.target.readOnly) return;
    estrategiaEnEdicionGlobal = id;
    focoActualizadoEnInicial = estrategiasActuales.find((x) => x.id === id)?.actualizadoEn || null;
  });
  listaEstrategiasEl.addEventListener("focusout", (e) => {
    const id = e.target.dataset.contenido ? e.target.dataset.contenido : idEstrategiaDesde(e.target.closest("[data-bloques]"));
    if (!id || id !== estrategiaEnEdicionGlobal) return;
    setTimeout(() => {
      // Este "focusout" pudo haber sido causado por nuestro propio
      // onChange() (al reconstruir el editor, se elimina y recrea el
      // control que tenía el foco) — no porque la persona de verdad haya
      // salido de la tarjeta. En ese caso no se suelta el congelado.
      if (bloqueSeAcabaDeActualizar) return;
      const activo = document.activeElement;
      const sigueEnLaMisma = activo?.dataset?.contenido === id || idEstrategiaDesde(activo?.closest?.("[data-bloques]")) === id || idEstrategiaDesde(activo?.closest?.("[data-id]")) === id;
      if (sigueEnLaMisma) return;
      estrategiaEnEdicionGlobal = null;
      focoActualizadoEnInicial = null;
      render();
    }, 0);
  });
  // Se congela la tarjeta al primer mousedown en CUALQUIER parte de ella
  // (no solo dentro de [data-bloques]) — botones como "Guardar avance",
  // "Renumerar" o "Reasignar" viven fuera del editor de bloques, y al
  // hacerles clic quitan el foco del campo que se estaba editando; sin este
  // congelado temprano, ese clic podía leerse como "la persona salió de la
  // tarjeta" antes de que el propio botón alcanzara a ejecutar su acción.
  listaEstrategiasEl.addEventListener("mousedown", (e) => {
    const tarjeta = e.target.closest("[data-id]");
    if (!tarjeta || !e.target.closest(".collapsible-form")) return;
    const id = tarjeta.dataset.id;
    if (estrategiaEnEdicionGlobal === id) return;
    estrategiaEnEdicionGlobal = id;
    focoActualizadoEnInicial = estrategiasActuales.find((x) => x.id === id)?.actualizadoEn || null;
  });

  // Mueve una estrategia (o subtítulo) un puesto arriba/abajo entre sus
  // hermanos (mismo padreId) intercambiando su "orden" con el vecino — la
  // numeración (4.1, 4.2...) se recalcula sola en ordenVisual().
  async function moverEstrategia(id, direccion) {
    const est = estrategiasActuales.find((x) => x.id === id);
    if (!est) return;
    const hermanos = estrategiasActuales.filter((x) => x.padreId === est.padreId).sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
    const idx = hermanos.findIndex((x) => x.id === id);
    const vecino = hermanos[idx + direccion];
    if (!vecino) return;
    try {
      await Promise.all([
        updateDoc(doc(db, "informesGestion", informeId, "estrategias", est.id), { orden: vecino.orden ?? (idx + direccion) }),
        updateDoc(doc(db, "informesGestion", informeId, "estrategias", vecino.id), { orden: est.orden ?? idx })
      ]);
    } catch (err) {
      alert(friendlyError(err));
    }
  }

  listaEstrategiasEl.addEventListener("click", async (e) => {
    const toggleCardId = e.target.closest("[data-toggle-card]")?.dataset.toggleCard;
    if (toggleCardId) {
      const el = listaEstrategiasEl.querySelector(`[data-id="${toggleCardId}"]`);
      if (estrategiasExpandidas.has(toggleCardId)) estrategiasExpandidas.delete(toggleCardId);
      else estrategiasExpandidas.add(toggleCardId);
      el?.classList.toggle("abierto", estrategiasExpandidas.has(toggleCardId));
      return;
    }

    const moverId = e.target.dataset.mover;
    if (moverId) {
      await moverEstrategia(moverId, Number(e.target.dataset.direccion));
      return;
    }

    const guardarId = e.target.dataset.guardar;
    if (guardarId) {
      const btn = e.target;
      const bloques = borradorContenido.get(guardarId) || [];
      // Un encabezado no tiene selector de "Estado" (no aplica: no lo llena
      // una sola persona) — si no existe, se conserva el que ya tuviera en
      // vez de fallar.
      const estadoSelect = document.querySelector(`[data-estado="${guardarId}"]`);
      const estado = estadoSelect ? estadoSelect.value : (estrategiasActuales.find((x) => x.id === guardarId)?.estado || "pendiente");
      btn.disabled = true;
      const textoOriginal = btn.textContent;
      btn.textContent = "Guardando...";
      // El botón "Guardar avance" vive FUERA de [data-bloques] — hacerle
      // clic saca el foco de cualquier campo que lo tuviera (ej. el
      // desplegable de nivel de un título), lo que dispara el mismo falso
      // "la persona salió de la tarjeta" que ya se blindó en onChange(),
      // pero esta acción no pasa por onChange(). Sin este blindaje, ese
      // falso positivo puede resincronizar desde Firestore A MITAD del
      // guardado (mientras el "await updateDoc" sigue en curso) y pisar el
      // nivel/tipo que se acababa de cambiar. Se libera explícitamente más
      // abajo, después de guardar.
      bloqueSeAcabaDeActualizar = true;
      try {
        const bloquesFinal = [];
        for (const bloque of bloques) {
          if (bloque.tipo === "imagen" && bloque.blob) {
            const archivoRef = ref(storage, `informesGestion/${informeId}/${crypto.randomUUID()}.jpg`);
            await uploadBytes(archivoRef, bloque.blob);
            const url = await getDownloadURL(archivoRef);
            bloquesFinal.push({ tipo: "imagen", url, nombre: bloque.nombre || "", pieDeFoto: bloque.pieDeFoto || "", tamano: bloque.tamano || 85 });
          } else if (bloque.tipo === "imagen") {
            if (!bloque.url) continue; // bloque de imagen vacío (sin elegir archivo) — se descarta, no tiene nada que guardar
            bloquesFinal.push({ tipo: "imagen", url: bloque.url, nombre: bloque.nombre || "", pieDeFoto: bloque.pieDeFoto || "", tamano: bloque.tamano || 85 });
          } else if (bloque.tipo === "tabla") {
            // _selA/_selB/_filaFoco/_colFoco son estado transitorio del
            // editor (selección de celdas) — Firestore rechaza valores
            // "undefined", así que se excluyen por completo en vez de
            // asignarlos a undefined.
            const { _selA, _selB, _filaFoco, _colFoco, ...bloqueLimpio } = bloque;
            bloquesFinal.push({ ...bloqueLimpio, filas: filasParaGuardar(bloque.filas) });
          } else if (bloque.tipo === "firma") {
            const firmantes = [];
            for (const firmante of bloque.firmantes || []) {
              let firmaUrl = firmante.firmaUrl || null;
              if (firmante.firmaBlob) {
                const archivoRef = ref(storage, `informesGestion/${informeId}/${crypto.randomUUID()}.png`);
                await uploadBytes(archivoRef, firmante.firmaBlob);
                firmaUrl = await getDownloadURL(archivoRef);
              }
              firmantes.push({ nombre: firmante.nombre || "", cargo: firmante.cargo || "", firmaUrl, altoFirma: firmante.altoFirma || 14 });
            }
            bloquesFinal.push({ tipo: "firma", etiqueta: bloque.etiqueta || "", firmantes });
          } else {
            bloquesFinal.push(bloque);
          }
        }
        await updateDoc(doc(db, "informesGestion", informeId, "estrategias", guardarId), {
          contenido: bloquesFinal, estado,
          actualizadoEn: serverTimestamp(),
          actualizadoPor: user.uid,
          actualizadoPorNombre: perfil.nombre || user.email
        });
        estrategiaEnEdicionGlobal = null;
        focoActualizadoEnInicial = null;
        bloqueSeAcabaDeActualizar = false;
        // Se normaliza el borrador local al mismo formato que tendría al
        // volver a leerlo del servidor (bloquesFinal es justo lo que se
        // guardó, pero en formato de guardado — ej. una tabla ya pasó por
        // filasParaGuardar, no filasParaEditar) — así, cuando el snapshot
        // real llegue un instante después y se vuelva a comparar, coincide
        // exactamente y no vuelve a verse como "cambios sin guardar".
        borradorContenido.set(guardarId, contenidoABloques(bloquesFinal));
        estrategiasRecienGuardadas.add(guardarId);
        render();
      } catch (err) {
        bloqueSeAcabaDeActualizar = false;
        alert(friendlyError(err));
        btn.disabled = false;
        btn.textContent = textoOriginal;
      }
      return;
    }

    const reasignarToggleId = e.target.dataset.reasignarToggle;
    if (reasignarToggleId) {
      document.querySelector(`[data-reasignar-panel="${reasignarToggleId}"]`)?.classList.toggle("hidden");
      return;
    }

    const reasignarGuardarId = e.target.dataset.reasignarGuardar;
    if (reasignarGuardarId) {
      const nombre = document.querySelector(`[data-reasignar-nombre="${reasignarGuardarId}"]`).value.trim();
      if (!nombre) { alert("La estrategia necesita un nombre."); return; }
      const selResp = document.querySelector(`[data-reasignar-responsables="${reasignarGuardarId}"]`);
      const cambios = { nombre };
      if (selResp) {
        const responsables = Array.from(selResp.selectedOptions).map((o) => o.value);
        if (responsables.length === 0) { alert("Selecciona al menos un responsable."); return; }
        cambios.responsables = responsables;
        cambios.responsablesNombres = responsables.map(nombrePorUid);
      }
      try {
        await updateDoc(doc(db, "informesGestion", informeId, "estrategias", reasignarGuardarId), cambios);
        await guardarEnCatalogo(new Set([nombre]));
      } catch (err) {
        alert(friendlyError(err));
      }
      return;
    }

    const eliminarId = e.target.dataset.eliminarEstrategia;
    if (eliminarId) {
      const est = estrategiasActuales.find((x) => x.id === eliminarId);
      const hijos = estrategiasActuales.filter((x) => x.padreId === eliminarId);
      const mensaje = hijos.length
        ? `¿Eliminar "${est?.nombre}" y sus ${hijos.length} subtítulo(s)/zona(s)? Se perderá todo su contenido.`
        : `¿Eliminar la estrategia "${est?.nombre}"? Se perderá su contenido.`;
      if (!confirm(mensaje)) return;
      try {
        await Promise.all([
          deleteDoc(doc(db, "informesGestion", informeId, "estrategias", eliminarId)),
          ...hijos.map((h) => deleteDoc(doc(db, "informesGestion", informeId, "estrategias", h.id)))
        ]);
        borradorContenido.delete(eliminarId);
        historialBloques.delete(eliminarId);
      } catch (err) {
        alert(friendlyError(err));
      }
    }
  });

  if (esCoordinador) {
    document.getElementById("agregarEstrategiaForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const alertBox = document.getElementById("agregarEstrategiaAlertBox");
      clearAlert(alertBox);
      const nombre = document.getElementById("nuevaEstrategiaNombre").value.trim();
      const responsables = Array.from(document.getElementById("nuevaEstrategiaResponsables").selectedOptions).map((o) => o.value);
      if (!nombre || responsables.length === 0) {
        showAlert(alertBox, "Indica un nombre y al menos un responsable.", "error");
        return;
      }
      try {
        await addDoc(collection(db, "informesGestion", informeId, "estrategias"), {
          nombre,
          orden: estrategiasActuales.filter((x) => !x.padreId).length,
          padreId: null,
          responsables,
          responsablesNombres: responsables.map(nombrePorUid),
          contenido: "",
          estado: "pendiente",
          actualizadoEn: null,
          actualizadoPor: null,
          actualizadoPorNombre: null,
          creadoEn: serverTimestamp()
        });
        await guardarEnCatalogo(new Set([nombre]));
        e.target.reset();
      } catch (err) {
        showAlert(alertBox, friendlyError(err), "error");
      }
    });

    document.getElementById("consolidarBtn").addEventListener("click", async () => {
      const consolidando = informeActual.estado !== "consolidado";
      const mensaje = consolidando
        ? "¿Consolidar este informe? Los responsables ya no podrán editar su(s) estrategia(s) hasta que lo reabras."
        : "¿Reabrir este informe para que los responsables puedan volver a editar?";
      if (!confirm(mensaje)) return;
      try {
        await updateDoc(informeRef, consolidando
          ? { estado: "consolidado", consolidadoEn: serverTimestamp(), consolidadoPor: perfil.nombre || user.email }
          : { estado: "borrador", consolidadoEn: null, consolidadoPor: null });
      } catch (err) {
        alert(friendlyError(err));
      }
    });

    document.getElementById("duplicarInformeToggleBtn").addEventListener("click", () => {
      document.getElementById("duplicarInformePanel").classList.toggle("hidden");
    });

    document.getElementById("editarInformeToggleBtn").addEventListener("click", () => {
      const panel = document.getElementById("editarInformePanel");
      const abriendo = panel.classList.contains("hidden");
      panel.classList.toggle("hidden");
      if (abriendo && informeActual) {
        document.getElementById("editarInformeContrato").value = informeActual.contrato || "";
        document.getElementById("editarInformePeriodo").value = informeActual.anio && informeActual.mes ? `${informeActual.anio}-${String(informeActual.mes).padStart(2, "0")}` : "";
      }
    });

    document.getElementById("editarInformeGuardarBtn").addEventListener("click", async () => {
      const alertBox = document.getElementById("editarInformeAlertBox");
      clearAlert(alertBox);
      const contrato = document.getElementById("editarInformeContrato").value.trim();
      const periodo = document.getElementById("editarInformePeriodo").value; // "YYYY-MM"
      if (!contrato || !periodo) {
        showAlert(alertBox, "Completa el contrato y el periodo.", "error");
        return;
      }
      const [anio, mes] = periodo.split("-").map(Number);
      const periodoLabel = new Date(anio, mes - 1, 1).toLocaleDateString("es-CO", { year: "numeric", month: "long" });
      try {
        await updateDoc(informeRef, { contrato, anio, mes, periodoLabel });
        showAlert(alertBox, "Datos del informe actualizados.", "ok");
      } catch (err) {
        showAlert(alertBox, friendlyError(err), "error");
      }
    });

    document.getElementById("portadaToggleBtn").addEventListener("click", () => {
      const panel = document.getElementById("portadaPanel");
      const abriendo = panel.classList.contains("hidden");
      panel.classList.toggle("hidden");
      if (abriendo && informeActual) {
        document.getElementById("portadaNumeroContrato").value = informeActual.numeroContrato || "";
        document.getElementById("portadaObjeto").value = informeActual.objeto || "";
        document.getElementById("portadaCliente").value = informeActual.cliente || "";
        document.getElementById("portadaSupervisor").value = informeActual.supervisor || "";
        document.getElementById("portadaVigenciaInicio").value = informeActual.vigenciaInicio || "";
        document.getElementById("portadaVigenciaFin").value = informeActual.vigenciaFin || "";
        document.getElementById("portadaRadicado").value = informeActual.radicado || "";
      }
    });

    document.getElementById("obtenerRadicadoBtn").addEventListener("click", async (e) => {
      const alertBox = document.getElementById("portadaAlertBox");
      clearAlert(alertBox);
      const btn = e.target;
      btn.disabled = true;
      const textoOriginal = btn.textContent;
      btn.textContent = "Buscando...";
      try {
        const llamada = httpsCallable(functions, "obtenerRadicadoInformeGestion");
        const { data } = await llamada({ informeId });
        document.getElementById("portadaRadicado").value = data.radicado;
        showAlert(alertBox, data.yaExistia
          ? `Este informe ya tenía el radicado oficial ${data.radicado}.`
          : `Radicado ${data.radicado} obtenido y ya quedó guardado en este informe y registrado en Control de Contratos.`, "ok");
      } catch (err) {
        showAlert(alertBox, friendlyError(err), "error");
      } finally {
        btn.disabled = false;
        btn.textContent = textoOriginal;
      }
    });

    document.getElementById("portadaGuardarBtn").addEventListener("click", async () => {
      const alertBox = document.getElementById("portadaAlertBox");
      clearAlert(alertBox);
      try {
        await updateDoc(informeRef, {
          numeroContrato: document.getElementById("portadaNumeroContrato").value.trim(),
          objeto: document.getElementById("portadaObjeto").value.trim(),
          cliente: document.getElementById("portadaCliente").value.trim(),
          supervisor: document.getElementById("portadaSupervisor").value.trim(),
          vigenciaInicio: document.getElementById("portadaVigenciaInicio").value || null,
          vigenciaFin: document.getElementById("portadaVigenciaFin").value || null,
          radicado: document.getElementById("portadaRadicado").value.trim()
        });
        showAlert(alertBox, "Datos de portada guardados.", "ok");
      } catch (err) {
        showAlert(alertBox, friendlyError(err), "error");
      }
    });

    document.getElementById("notificarToggleBtn").addEventListener("click", () => {
      const panel = document.getElementById("notificarPanel");
      const abriendo = panel.classList.contains("hidden");
      panel.classList.toggle("hidden");
      if (abriendo && informeActual?.fechaLimite) {
        document.getElementById("notificarFechaLimite").value = informeActual.fechaLimite;
      }
    });

    document.getElementById("notificarEnviarBtn").addEventListener("click", async (e) => {
      const alertBox = document.getElementById("notificarAlertBox");
      clearAlert(alertBox);
      const fechaLimite = document.getElementById("notificarFechaLimite").value;
      const modoPrueba = document.getElementById("notificarModoPrueba").checked;
      if (!fechaLimite) {
        showAlert(alertBox, "Elige la fecha límite antes de enviar.", "error");
        return;
      }
      if (!modoPrueba) {
        const responsablesUnicos = new Set();
        estrategiasActuales.forEach((est) => (est.responsables || []).forEach((uid) => responsablesUnicos.add(uid)));
        if (!confirm(`¿Enviar un correo a las ${responsablesUnicos.size} persona(s) responsables de alguna sección de este informe, con fecha límite ${fechaLimite}?`)) return;
      }
      const btn = e.target;
      btn.disabled = true;
      const textoOriginal = btn.textContent;
      btn.textContent = "Enviando...";
      try {
        const llamada = httpsCallable(functions, "notificarResponsablesInformeGestion");
        const { data } = await llamada({ informeId, fechaLimite, modoPrueba });
        const mensaje = data.prueba
          ? "Correo de prueba enviado a gerencia.cincoltda@hotmail.com — revísalo antes de notificar a todos."
          : `Correo enviado a ${data.enviados.length} persona(s): ${data.enviados.join(", ")}.${data.sinCorreo?.length ? ` Sin correo registrado (no se les pudo notificar): ${data.sinCorreo.join(", ")}.` : ""}`;
        showAlert(alertBox, mensaje, "ok");
      } catch (err) {
        showAlert(alertBox, friendlyError(err), "error");
      } finally {
        btn.disabled = false;
        btn.textContent = textoOriginal;
      }
    });

    // Calcula, con lo que ya está cargado en el navegador (estrategiasActuales),
    // quién tiene ahora mismo alguna sección sin completar — se usa tanto
    // para mostrar la vista previa en el panel como para el confirm() antes
    // de enviar de verdad. No hace falta ir al servidor: es solo una
    // previsualización, la función en la nube vuelve a calcular esto mismo
    // contra Firestore antes de enviar cualquier correo real.
    function pendientesIncumplimiento() {
      const porResponsable = new Map(); // nombre -> [secciones]
      estrategiasActuales.forEach((e) => {
        if (!e.responsables || !e.responsables.length) return;
        if (e.estado === "completo") return;
        (e.responsablesNombres || []).forEach((nombre) => {
          if (!porResponsable.has(nombre)) porResponsable.set(nombre, []);
          porResponsable.get(nombre).push(e.nombre);
        });
      });
      return porResponsable;
    }

    document.getElementById("incumplimientoToggleBtn").addEventListener("click", () => {
      const panel = document.getElementById("incumplimientoPanel");
      const abriendo = panel.classList.contains("hidden");
      panel.classList.toggle("hidden");
      if (!abriendo) return;
      const lista = document.getElementById("incumplimientoLista");
      const pendientes = pendientesIncumplimiento();
      if (pendientes.size === 0) {
        lista.innerHTML = '<p class="text-muted text-sm m-0">✅ No hay secciones pendientes ahora mismo — todas están completas. Puedes usar "Modo prueba" para ver cómo se vería este correo de todos modos.</p>';
        return;
      }
      const filas = Array.from(pendientes.entries())
        .map(([nombre, secciones]) => `<li><strong>${nombre}</strong>: ${secciones.join(", ")}</li>`)
        .join("");
      lista.innerHTML = `
        <p class="text-muted text-sm m-0">Ahora mismo, quienes recibirían este aviso si lo envías de verdad:</p>
        <ul class="text-sm" style="margin:6px 0 0;padding-left:20px;">${filas}</ul>`;
    });

    document.getElementById("incumplimientoEnviarBtn").addEventListener("click", async (e) => {
      const alertBox = document.getElementById("incumplimientoAlertBox");
      clearAlert(alertBox);
      const modoPrueba = document.getElementById("incumplimientoModoPrueba").checked;
      if (!modoPrueba) {
        if (!informeActual?.fechaLimite) {
          showAlert(alertBox, 'Este informe todavía no tiene fecha límite — primero usa "Notificar a responsables".', "error");
          return;
        }
        if (new Date(informeActual.fechaLimite).getTime() > Date.now()) {
          showAlert(alertBox, `La fecha límite (${formatDate(informeActual.fechaLimite)}) todavía no se ha vencido.`, "error");
          return;
        }
        const pendientes = pendientesIncumplimiento();
        if (pendientes.size === 0) {
          showAlert(alertBox, "No hay secciones pendientes — todas están completas.", "ok");
          return;
        }
        if (!confirm(`¿Enviar el aviso de incumplimiento a las ${pendientes.size} persona(s) listadas arriba, con copia a gerencia.cincoltda@hotmail.com? Esto queda registrado como constancia y no se puede deshacer.`)) return;
      }
      const btn = e.target;
      btn.disabled = true;
      const textoOriginal = btn.textContent;
      btn.textContent = "Enviando...";
      try {
        const llamada = httpsCallable(functions, "notificarIncumplimientosInformeGestion");
        const { data } = await llamada({ informeId, modoPrueba });
        const mensaje = data.prueba
          ? "Correo de prueba enviado a gerencia.cincoltda@hotmail.com — revísalo antes de notificar a los responsables reales."
          : `Aviso enviado a ${data.enviados.length} persona(s): ${data.enviados.join(", ")}.${data.sinCorreo?.length ? ` Sin correo registrado (no se les pudo notificar): ${data.sinCorreo.join(", ")}.` : ""}`;
        showAlert(alertBox, mensaje, "ok");
      } catch (err) {
        showAlert(alertBox, friendlyError(err), "error");
      } finally {
        btn.disabled = false;
        btn.textContent = textoOriginal;
      }
    });

    document.getElementById("duplicarInformeBtn").addEventListener("click", async () => {
      const alertBox = document.getElementById("duplicarInformeAlertBox");
      clearAlert(alertBox);
      const periodo = document.getElementById("duplicarPeriodo").value; // "YYYY-MM"
      if (!periodo) {
        showAlert(alertBox, "Elige el mes del nuevo informe.", "error");
        return;
      }
      const [anio, mes] = periodo.split("-").map(Number);
      if (anio === informeActual.anio && mes === informeActual.mes) {
        showAlert(alertBox, "Elige un mes distinto al de este informe.", "error");
        return;
      }
      const periodoLabel = new Date(anio, mes - 1, 1).toLocaleDateString("es-CO", { year: "numeric", month: "long" });
      if (!confirm(`¿Duplicar este informe como ${informeActual.contrato} — ${periodoLabel}?\n\nSe copian todas las estrategias, subtítulos/zonas, responsables y el contenido actual como punto de partida.`)) {
        return;
      }
      try {
        const nuevoInforme = await addDoc(collection(db, "informesGestion"), {
          contrato: informeActual.contrato,
          periodoLabel,
          anio,
          mes,
          prefijoNumeracion: informeActual.prefijoNumeracion || "",
          estado: "borrador",
          creadoPor: user.uid,
          creadoPorNombre: perfil.nombre || user.email,
          creadoEn: serverTimestamp(),
          consolidadoEn: null,
          consolidadoPor: null,
          duplicadoDe: informeId
        });

        const principales = estrategiasActuales.filter((x) => !x.padreId).sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
        for (const p of principales) {
          const nuevoPadre = await addDoc(collection(db, "informesGestion", nuevoInforme.id, "estrategias"), {
            nombre: p.nombre,
            orden: p.orden ?? 0,
            padreId: null,
            responsables: p.responsables || [],
            responsablesNombres: p.responsablesNombres || [],
            contenido: p.contenido || "",
            estado: p.contenido ? "en_progreso" : "pendiente",
            actualizadoEn: null,
            actualizadoPor: null,
            actualizadoPorNombre: null,
            creadoEn: serverTimestamp()
          });
          const hijos = estrategiasActuales.filter((x) => x.padreId === p.id).sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
          await Promise.all(hijos.map((h) => addDoc(collection(db, "informesGestion", nuevoInforme.id, "estrategias"), {
            nombre: h.nombre,
            orden: h.orden ?? 0,
            padreId: nuevoPadre.id,
            responsables: h.responsables || [],
            responsablesNombres: h.responsablesNombres || [],
            contenido: h.contenido || "",
            estado: h.contenido ? "en_progreso" : "pendiente",
            actualizadoEn: null,
            actualizadoPor: null,
            actualizadoPorNombre: null,
            creadoEn: serverTimestamp()
          })));
        }
        window.location.href = `informes-gestion.html?id=${nuevoInforme.id}`;
      } catch (err) {
        showAlert(alertBox, friendlyError(err), "error");
      }
    });

    document.getElementById("eliminarInformeBtn").addEventListener("click", async () => {
      const total = estrategiasActuales.length;
      const primeraConfirmacion = confirm(
        `¿Eliminar por completo el informe de ${informeActual.contrato} — ${informeActual.periodoLabel}?\n\n` +
        `Se borran las ${total} estrategia(s)/zona(s) y todo su contenido. Esta acción NO se puede deshacer.`
      );
      if (!primeraConfirmacion) return;
      if (!confirm("Confirma una vez más: se eliminará TODO el contenido de este informe de forma definitiva.")) return;
      try {
        await Promise.all(estrategiasActuales.map((est) => deleteDoc(doc(db, "informesGestion", informeId, "estrategias", est.id))));
        await deleteDoc(informeRef);
        window.location.href = "informes-gestion.html";
      } catch (err) {
        alert(friendlyError(err));
      }
    });
  }

  // Genera el informe completo — "portadaClara" decide solo la primera
  // página (dibujarPortadaNavy vs dibujarPortadaClara); el resto del
  // documento (desarrollo, índice, listas) es idéntico en los dos casos.
  // Ambos botones ("oscura"/"clara") llaman esta misma función.
  async function generarInformePDF(btn, portadaClara) {
    if (!informeActual) return;
    btn.disabled = true;
    const textoOriginal = btn.textContent;
    btn.textContent = "Generando...";
    try {
      const visual = ordenVisual();
      const docPdf = crearDocumentoPDF("portrait");
      const anchoPagina = docPdf.internal.pageSize.getWidth();
      const altoPagina = docPdf.internal.pageSize.getHeight();
      const geometria = { margenSuperior: 20, margenInferior: altoPagina - 22, anchoUtil: anchoPagina - INDICE_MARGEN_X * 2 };

      let logo = null;
      if (portadaClara) {
        // logo.png ya trae el texto en negro — se ve bien tal cual sobre
        // el fondo blanco de esta portada, sin necesitar aplanar
        // transparencia sobre ningún color en particular.
        try { logo = await cargarImagenComoDataURL("assets/img/logo.png", "#ffffff", "PNG"); } catch (err) { /* se genera igual sin logo */ }
        dibujarPortadaClara(docPdf, informeActual, logo);
      } else {
        // Logo con el texto en BLANCO (logo-blanco.png) — el normal
        // (logo.png) trae el texto en negro para fondo claro, invisible
        // sobre el navy de esta portada. El color de fondo pasado aquí
        // ("#1f2732", el mismo navy) es el que queda relleno donde la
        // imagen original era transparente — cargarImagenComoDataURL
        // aplana la transparencia sobre ese color antes de generar el PNG
        // final, así que tiene que coincidir con el navy de la portada o
        // se vería un rectángulo del color equivocado encima.
        try { logo = await cargarImagenComoDataURL("assets/img/logo-blanco.png", "#1f2732", "PNG"); } catch (err) { /* se genera igual sin logo */ }
        dibujarPortadaNavy(docPdf, informeActual, logo);
      }

      // El desarrollo detallado siempre arranca en página nueva — así el
      // índice/listas que se insertan más abajo quedan limpiamente entre
      // la portada (página 1) y el desarrollo.
      docPdf.addPage();
      let y = geometria.margenSuperior;

      const indiceEntradas = [];
      const tablasEntradas = [];
      const graficosEntradas = [];
      // Contadores COMPARTIDOS entre todas las estrategias del informe (no
      // se reinician por estrategia) — la numeración real del documento es
      // continua a través de todas ellas, en el mismo orden en que aparecen
      // en la lista (ver ordenVisual()). contadorTabla/contadorImagen van en
      // un objeto {n} porque un número no se puede "pasar por referencia" en
      // JS — así agregarSeccionEstrategia puede incrementarlo y que el
      // cambio se vea en las llamadas siguientes.
      const tracking = {
        indiceEntradas, tablasEntradas, graficosEntradas,
        contadoresTitulo: [0, 0, 0, 0],
        contadorTabla: { n: 0 },
        contadorImagen: { n: 0 }
      };

      // El "nombre" de la estrategia es solo la etiqueta administrativa para
      // identificar quién la llena en el editor — no es contenido del
      // informe, así que ya no se imprime como título ni entra al índice.
      // Lo único que sale en el PDF es el contenido real (los bloques que
      // cada responsable escribió).
      //
      // Cada estrategia arranca en página nueva (salvo la primera, que ya
      // queda justo después de addPage() de arriba) — a propósito, porque
      // son varios responsables distintos editando el mismo documento: si
      // el contenido de uno se reorganiza (crece, se acorta, un título
      // cambia de nivel), eso no debe correr ni mezclarse con la sección de
      // la persona siguiente en la misma página.
      let primeraEstrategia = true;
      let anterior = null;
      for (const e of visual) {
        // Excepción al salto de página por estrategia: un encabezado puro
        // (agrupa subtítulos/zonas, sin contenido ni responsable propio, ver
        // esEncabezado más arriba) no lleva nada que imprimir debajo de su
        // título — si igual se le diera página nueva, quedaría solo en una
        // hoja casi en blanco antes de que arranque el contenido real de su
        // primer subtítulo. Solo se salta este salto puntual (encabezado →
        // su primer hijo); entre los hijos entre sí sigue aplicando el salto
        // normal, porque esos sí son estrategias con contenido y responsable
        // propio que no deben mezclarse en la misma página.
        const esContinuacionDeEncabezado = anterior && esEncabezado(anterior.id) && e.padreId === anterior.id;
        if (!primeraEstrategia && !esContinuacionDeEncabezado) { docPdf.addPage(); y = geometria.margenSuperior; }
        primeraEstrategia = false;
        const bloques = contenidoABloques(e.contenido);
        y = await agregarSeccionEstrategia(docPdf, y, "", bloques, tracking, esEncabezado(e.id));
        anterior = e;
      }

      // ---- insertar Contenido / Lista de tablas / Lista de gráficos justo
      // después de la página 1, corrigiendo la numeración de página de todo
      // lo ya dibujado (se recorrió tantas páginas como se insertaron). ----
      if (indiceEntradas.length || tablasEntradas.length || graficosEntradas.length) {
        const paginasNecesarias = calcularPaginasIndice(indiceEntradas, tablasEntradas, graficosEntradas, geometria);
        for (let i = 0; i < paginasNecesarias; i++) docPdf.insertPage(2);
        [...indiceEntradas, ...tablasEntradas, ...graficosEntradas].forEach((en) => { en.pagina += paginasNecesarias; });
        dibujarIndiceCompleto(docPdf, indiceEntradas, tablasEntradas, graficosEntradas, geometria);
      }

      agregarPiePagina(docPdf);
      descargarPDF(docPdf, `informe-gestion-${informeActual.contrato}-${informeActual.periodoLabel}.pdf`.toLowerCase().replace(/[^a-z0-9.]+/g, "-"));
    } catch (err) {
      alert(friendlyError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  }

  document.getElementById("pdfBtn").addEventListener("click", (e) => generarInformePDF(e.target, false));
  document.getElementById("pdfBtnClaro").addEventListener("click", (e) => generarInformePDF(e.target, true));
}


// ======================================================================
// Dibujo de bloques (párrafo/tabla/imagen) en el PDF — la parte de tabla
// (con combinar celdas/negrilla/color) está adaptada de
// Cinco SAS control (web/js/control/informes-pdf.js: calcularAnchosColumna
// + dibujarTabla), cambiando la tipografía a "times" para que coincida con
// el resto de los informes de Cinco Conecta.
// ======================================================================

function sumaRango(valores, inicio, cantidad) {
  let total = 0;
  for (let i = inicio; i < inicio + cantidad; i++) total += valores[i];
  return total;
}

function hexARgb(hex) {
  if (!hex) return null;
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Reparte "total" entre columnas garantizando primero el mínimo de cada una
// (mins[i]) y creciendo desde ahí hacia lo que pidió (deseos[i]) en rondas —
// cada ronda reparte el espacio que sobra por igual entre las columnas que
// todavía no llegaron a su deseo; la que sí llega sale del reparto y su
// sobrante pasa a las demás ("max-min fair share", igual que el ancho de
// banda entre conexiones que compiten por un enlace). A diferencia de un
// reparto proporcional simple, esto nunca deja una columna por debajo de su
// propio mínimo mientras la suma de mínimos quepa en total — antes, con
// muchas columnas angostas + una de texto libre (ej. la tabla de "Origen"
// con columnas COMERCIAL/EH/FSCR/PROING), la suma de mínimos superaba el
// ancho de página y el reparto se rendía a un reparto parejo de TODO
// (deseados/numCols) que ignoraba el contenido y partía palabras como
// "COMERCIAL" en "COME"/"RCIAL" — ver dibujarTablaBloque más abajo, que
// reintenta con letra más chica antes de aceptar ese último recurso.
function repartirConMinimos(mins, deseos, total) {
  const n = mins.length;
  const sumaMin = mins.reduce((a, b) => a + b, 0);
  if (sumaMin >= total) return mins.map((m) => m * (total / sumaMin));

  const anchos = mins.slice();
  const pendientes = deseos.map((d, i) => Math.max(d - mins[i], 0));
  const activos = pendientes.map((p) => p > 1e-9);
  let restante = total - sumaMin;
  while (restante > 1e-6 && activos.some(Boolean)) {
    const nActivos = activos.filter(Boolean).length;
    const cuota = restante / nActivos;
    let usado = 0;
    for (let i = 0; i < n; i++) {
      if (!activos[i]) continue;
      if (pendientes[i] <= cuota) {
        anchos[i] += pendientes[i];
        usado += pendientes[i];
        pendientes[i] = 0;
        activos[i] = false;
      } else {
        anchos[i] += cuota;
        pendientes[i] -= cuota;
        usado += cuota;
      }
    }
    restante -= usado;
  }
  if (restante > 0.5) {
    const usado = anchos.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) anchos[i] += restante * (anchos[i] / usado);
  }
  return anchos;
}

// Devuelve { anchos, cabe }: cabe=false avisa que ni los mínimos por palabra
// entraron en la página a este tamaño de fuente — dibujarTablaBloque lo usa
// para reintentar con una fuente más pequeña antes de resignarse a partir
// palabras.
function calcularAnchosColumnaConMerges(doc, filas, anchoUtil, merges = []) {
  const numCols = Math.max(...filas.map((f) => f.length));
  const anchoMinGeneral = Math.min(18, (anchoUtil / numCols) * 0.6);
  const anchoMax = anchoUtil * 0.4;

  const deseados = [];
  const anchoMinPorColumna = [];
  for (let c = 0; c < numCols; c++) {
    let maximo = 0;
    let palabraMasAncha = 0;
    filas.forEach((fila, fi) => {
      if (celdaCombinada(merges, fi, c)) return;
      doc.setFont("times", fi === 0 ? "bold" : "normal");
      const texto = String(fila[c] || "");
      const ancho = doc.getTextWidth(texto);
      if (ancho > maximo) maximo = ancho;
      texto.split(/\s+/).forEach((palabra) => {
        const anchoPalabra = doc.getTextWidth(palabra);
        if (anchoPalabra > palabraMasAncha) palabraMasAncha = anchoPalabra;
      });
    });
    deseados.push(maximo);
    anchoMinPorColumna.push(Math.min(anchoMax, Math.max(anchoMinGeneral, palabraMasAncha + 6)));
  }

  merges.forEach((m) => {
    const texto = String(filas[m.fila]?.[m.col] || "");
    if (!texto) return;
    doc.setFont("times", m.fila === 0 ? "bold" : "normal");
    const anchoPorColumna = doc.getTextWidth(texto) / m.cols;
    for (let c = m.col; c < m.col + m.cols; c++) {
      if (anchoPorColumna > deseados[c]) deseados[c] = anchoPorColumna;
    }
    let palabraMasAnchaMerge = 0;
    texto.split(/\s+/).forEach((palabra) => {
      const anchoPalabra = doc.getTextWidth(palabra) / m.cols;
      if (anchoPalabra > palabraMasAnchaMerge) palabraMasAnchaMerge = anchoPalabra;
    });
    for (let c = m.col; c < m.col + m.cols; c++) {
      const minimo = Math.min(anchoMax, Math.max(anchoMinPorColumna[c], palabraMasAnchaMerge + 6));
      if (minimo > anchoMinPorColumna[c]) anchoMinPorColumna[c] = minimo;
    }
  });

  for (let c = 0; c < numCols; c++) deseados[c] = Math.min(Math.max(deseados[c] + 6, anchoMinPorColumna[c]), anchoMax);

  const sumaMin = anchoMinPorColumna.reduce((a, b) => a + b, 0);
  return { anchos: repartirConMinimos(anchoMinPorColumna, deseados, anchoUtil), cabe: sumaMin <= anchoUtil };
}

const NAVY_PDF = [31, 39, 50];
const GRIS_CLARO_PDF = [245, 246, 248];
const TEXT_MUTED_PDF = [92, 101, 112];

function formatFechaCorta(iso) {
  if (!iso) return "";
  return new Date(`${iso}T00:00:00`).toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric" });
}

// Portada a página completa (fondo navy, logo, título centrado y ficha con
// Contrato/Objeto/Cliente/Supervisor/Vigencia/Radicado) — mismo estilo que
// los informes de "control de contratos". Los campos de ficha son
// opcionales: si el informe no los tiene guardados, esa línea simplemente
// no se dibuja.
function dibujarPortadaNavy(doc, informe, logo) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const altoPagina = doc.internal.pageSize.getHeight();
  const margenX = 12;
  const anchoUtil = anchoPagina - margenX * 2;

  doc.setPage(1);
  doc.setFillColor(...NAVY_PDF);
  doc.rect(0, 0, anchoPagina, altoPagina, "F");

  if (logo) {
    const altoLogo = 24;
    const anchoLogo = altoLogo * (logo.ancho / logo.alto);
    doc.addImage(logo.dataUrl, "PNG", (anchoPagina - anchoLogo) / 2, 28, anchoLogo, altoLogo);
  }

  let y = 88;
  doc.setFont("times", "bold");
  doc.setFontSize(20);
  doc.setTextColor(255, 255, 255);
  const tituloLineas = doc.splitTextToSize(`Informe de Gestión — ${informe.periodoLabel}`, anchoUtil);
  doc.text(tituloLineas, anchoPagina / 2, y, { align: "center" });
  y += tituloLineas.length * 8 + 6;

  doc.setFont("times", "normal");
  doc.setFontSize(12);
  doc.setTextColor(254, 178, 9);
  doc.text("Informe de gestión", anchoPagina / 2, y, { align: "center" });

  y = 150;
  doc.setFontSize(10.5);
  const xValor = anchoPagina / 2 - 6;
  const anchoValor = anchoPagina - margenX - xValor;
  const filaPortada = (etiqueta, valor) => {
    if (!valor) return;
    doc.setFont("times", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text(etiqueta, anchoPagina / 2 - 45, y);
    doc.setFont("times", "normal");
    doc.setTextColor(220, 224, 229);
    const renglones = doc.splitTextToSize(String(valor), anchoValor);
    doc.text(renglones, xValor, y);
    y += renglones.length * 5.4 + 2.5;
  };
  filaPortada("Contrato:", informe.contrato ? `${informe.contrato}${informe.numeroContrato ? " · N.º " + informe.numeroContrato : ""}` : null);
  filaPortada("Objeto:", informe.objeto);
  filaPortada("Cliente:", informe.cliente);
  filaPortada("Supervisor:", informe.supervisor);
  if (informe.vigenciaInicio) filaPortada("Vigencia:", `${formatFechaCorta(informe.vigenciaInicio)} — ${informe.vigenciaFin ? formatFechaCorta(informe.vigenciaFin) : "en curso"}`);

  doc.setFont("times", "bold");
  doc.setFontSize(11);
  doc.setTextColor(255, 255, 255);
  doc.text(`Radicado: ${informe.radicado || ""}`, anchoPagina / 2, altoPagina - 30, { align: "center" });
  doc.setFont("times", "normal");
  doc.setFontSize(9);
  doc.setTextColor(199, 204, 211);
  doc.text(`Cinco S.A.S. · ${informe.periodoLabel}`, anchoPagina / 2, altoPagina - 24, { align: "center" });
  doc.setTextColor(0, 0, 0);
}

// Misma información y diseño que dibujarPortadaNavy, pero sobre fondo
// blanco en vez de navy — mismos colores exactos que la portada clara del
// informe de gestión de Cinco SAS (Contratos): fondo blanco con dos
// filetes navy+ámbar arriba y abajo (en vez de un fondo navy a página
// completa), título en navy, subtítulo en ámbar oscuro, etiquetas en navy
// y valores/pie en el mismo gris (TEXT_MUTED_PDF) que el resto de la app.
function dibujarPortadaClara(doc, informe, logo) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const altoPagina = doc.internal.pageSize.getHeight();
  const margenX = 12;
  const anchoUtil = anchoPagina - margenX * 2;
  const AMBER_PDF = [254, 178, 9];
  const AMBER_DARK_PDF = [217, 148, 0];

  doc.setPage(1);
  doc.setFillColor(255, 255, 255);
  doc.rect(0, 0, anchoPagina, altoPagina, "F");
  doc.setFillColor(...NAVY_PDF);
  doc.rect(0, 15, anchoPagina, 1.2, "F");
  doc.setFillColor(...AMBER_PDF);
  doc.rect(0, 16.2, anchoPagina, 1.2, "F");
  doc.setFillColor(...AMBER_PDF);
  doc.rect(0, altoPagina - 40, anchoPagina, 1.2, "F");
  doc.setFillColor(...NAVY_PDF);
  doc.rect(0, altoPagina - 38.8, anchoPagina, 1.2, "F");

  if (logo) {
    const altoLogo = 24;
    const anchoLogo = altoLogo * (logo.ancho / logo.alto);
    doc.addImage(logo.dataUrl, "PNG", (anchoPagina - anchoLogo) / 2, 28, anchoLogo, altoLogo);
  }

  let y = 88;
  doc.setFont("times", "bold");
  doc.setFontSize(20);
  doc.setTextColor(...NAVY_PDF);
  const tituloLineas = doc.splitTextToSize(`Informe de Gestión — ${informe.periodoLabel}`, anchoUtil);
  doc.text(tituloLineas, anchoPagina / 2, y, { align: "center" });
  y += tituloLineas.length * 8 + 6;

  doc.setFont("times", "normal");
  doc.setFontSize(12);
  doc.setTextColor(...AMBER_DARK_PDF);
  doc.text("Informe de gestión", anchoPagina / 2, y, { align: "center" });

  y = 150;
  doc.setFontSize(10.5);
  const xValor = anchoPagina / 2 - 6;
  const anchoValor = anchoPagina - margenX - xValor;
  const filaPortada = (etiqueta, valor) => {
    if (!valor) return;
    doc.setFont("times", "bold");
    doc.setTextColor(...NAVY_PDF);
    doc.text(etiqueta, anchoPagina / 2 - 45, y);
    doc.setFont("times", "normal");
    doc.setTextColor(...TEXT_MUTED_PDF);
    const renglones = doc.splitTextToSize(String(valor), anchoValor);
    doc.text(renglones, xValor, y);
    y += renglones.length * 5.4 + 2.5;
  };
  filaPortada("Contrato:", informe.contrato ? `${informe.contrato}${informe.numeroContrato ? " · N.º " + informe.numeroContrato : ""}` : null);
  filaPortada("Objeto:", informe.objeto);
  filaPortada("Cliente:", informe.cliente);
  filaPortada("Supervisor:", informe.supervisor);
  if (informe.vigenciaInicio) filaPortada("Vigencia:", `${formatFechaCorta(informe.vigenciaInicio)} — ${informe.vigenciaFin ? formatFechaCorta(informe.vigenciaFin) : "en curso"}`);

  doc.setFont("times", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...NAVY_PDF);
  doc.text(`Radicado: ${informe.radicado || ""}`, anchoPagina / 2, altoPagina - 30, { align: "center" });
  doc.setFont("times", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...TEXT_MUTED_PDF);
  doc.text(`Cinco S.A.S. · ${informe.periodoLabel}`, anchoPagina / 2, altoPagina - 24, { align: "center" });
  doc.setTextColor(0, 0, 0);
}

// Dibuja un bloque de párrafo con formato (negrilla/cursiva/color/viñetas/
// alineación) en el PDF — portado y extendido desde dibujarParrafo de Cinco
// SAS control (informes-pdf.js): esa versión no tenía alineación; acá se
// agrega justificado real (izquierda/centro/derecha se resuelven con solo
// mover dónde arranca la línea, pero "justificado" reparte el espacio
// sobrante entre las palabras de cada línea para que ambos márgenes queden
// parejos, igual que Word — la ÚLTIMA línea de cada párrafo/ítem nunca se
// estira, por convención tipográfica).
//
// Como la línea se arma palabra por palabra y solo se sabe si una línea es
// "la última" del párrafo/ítem cuando YA se está armando la SIGUIENTE (o se
// acabó el texto), se dibuja con un línea de retraso: "pendiente" guarda la
// última línea armada pero todavía sin dibujar — se dibuja recién cuando se
// sabe con certeza si le tocaba estirarse (no era la última) o no (si lo
// era).
function dibujarParrafoBloque(doc, y, bloque) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const altoPagina = doc.internal.pageSize.getHeight();
  const margenX = 12;
  const margenInferior = altoPagina - 18;
  const anchoUtil = anchoPagina - margenX * 2;
  const lineHeight = 5;
  const COLOR_PARRAFO = [20, 22, 26];

  function saltoSiNoCabe(alturaNecesaria) {
    if (y + alturaNecesaria > margenInferior) { doc.addPage(); y = 20; }
  }
  function estiloFuente(negrita, cursiva) {
    if (negrita && cursiva) return "bolditalic";
    if (negrita) return "bold";
    if (cursiva) return "italic";
    return "normal";
  }
  doc.setFontSize(9.5);
  function medirToken(token) {
    doc.setFont("times", estiloFuente(token.negrita, token.cursiva));
    return doc.getTextWidth(token.texto);
  }

  const runs = parsearHtmlARuns(htmlParaCampoRico(bloque.texto));
  if (!runs.length) return y;

  const tokens = [];
  runs.forEach((run) => {
    if (run.salto) { tokens.push({ salto: true }); return; }
    run.texto.split(/(\s+)/).filter((p) => p !== "").forEach((palabra) => {
      tokens.push({ texto: palabra, negrita: run.negrita, cursiva: run.cursiva, color: run.color, alineacion: run.alineacion });
    });
  });

  // Dibuja una línea ya armada. "esUltima" decide si se estira con
  // justificado — la última línea de un párrafo/ítem nunca se estira.
  function dibujarLinea(pendiente, esUltima) {
    const { tokens: lineaTokens, sangria, esPrimeraLineaDeItem, alineacion } = pendiente;
    if (!lineaTokens.length) { y += lineHeight; return; }
    saltoSiNoCabe(lineHeight);
    const anchoDisponible = anchoUtil - (esPrimeraLineaDeItem ? 0 : sangria);
    const xBase = margenX + (esPrimeraLineaDeItem ? 0 : sangria);

    let anchoTokens = 0;
    lineaTokens.forEach((t) => { anchoTokens += medirToken(t); });
    const huecos = lineaTokens.filter((t) => /^\s+$/.test(t.texto)).length;

    let extraPorHueco = 0;
    let x = xBase;
    if (alineacion === "justify" && !esUltima && huecos > 0 && anchoTokens < anchoDisponible) {
      extraPorHueco = (anchoDisponible - anchoTokens) / huecos;
    } else if (alineacion === "center" && anchoTokens < anchoDisponible) {
      x = xBase + (anchoDisponible - anchoTokens) / 2;
    } else if (alineacion === "right" && anchoTokens < anchoDisponible) {
      x = xBase + (anchoDisponible - anchoTokens);
    }

    lineaTokens.forEach((token) => {
      const ancho = medirToken(token);
      doc.setFont("times", estiloFuente(token.negrita, token.cursiva));
      doc.setTextColor(...(token.color || COLOR_PARRAFO));
      doc.text(token.texto, x, y);
      x += ancho + (/^\s+$/.test(token.texto) ? extraPorHueco : 0);
    });
    y += lineHeight;
  }

  let pendiente = null;
  function emitir(lineaObj) {
    if (pendiente) dibujarLinea(pendiente, false);
    pendiente = lineaObj;
  }
  function cerrarItem() {
    if (pendiente) dibujarLinea(pendiente, true);
    pendiente = null;
  }

  let linea = [];
  let anchoLinea = 0;
  let sangriaItem = 0;
  let esPrimeraLineaDeItem = true;
  let alineacionItem = "left";
  // Solo se acumula sangriaItem mientras estemos viendo indentación/viñeta
  // de arranque — se apaga para siempre en la primera palabra "de verdad"
  // del ítem, para no seguir recalculándola con cada espacio del resto del
  // párrafo (eso indentaría todo un párrafo normal a donde cayó su primer
  // salto de línea).
  let enIndentInicial = true;

  function emitirLineaActual() {
    emitir({ tokens: linea, sangria: sangriaItem, esPrimeraLineaDeItem, alineacion: alineacionItem });
    linea = [];
    anchoLinea = 0;
    esPrimeraLineaDeItem = false;
  }

  // lineaNueva: true justo tras un salto explícito (fin de línea/viñeta en
  // el HTML), no tras un salto de línea automático por ajuste de ancho —
  // así el espacio de sangría de una viñeta ("    o texto") sobrevive, pero
  // se sigue evitando arrancar una línea de ajuste con un espacio suelto.
  let lineaNueva = true;
  tokens.forEach((token) => {
    if (token.salto) {
      emitirLineaActual();
      cerrarItem();
      y += lineHeight * 0.3;
      lineaNueva = true;
      esPrimeraLineaDeItem = true;
      sangriaItem = 0;
      enIndentInicial = true;
      alineacionItem = "left";
      return;
    }
    if (alineacionItem === "left" && token.alineacion) alineacionItem = token.alineacion;

    // Viñeta "•" escrita a mano dentro del propio texto del párrafo (sin
    // pasar por el botón "Viñeta", que sí crea <li> con su propio salto):
    // si ya hay algo en la línea actual, se fuerza el salto + espaciado
    // antes de ella — así "Etiqueta: • primer punto • segundo punto..."
    // baja cada punto como renglón aparte y espaciado, en vez de quedar
    // todo pegado en el mismo párrafo. Solo "•": "-"/"o" también son
    // palabras normales del idioma y darían falsos positivos. El
    // "!enIndentInicial" evita que esto dispare con la propia viñeta de
    // arranque de un <li> real.
    if (token.texto === "•" && linea.length && !enIndentInicial) {
      emitirLineaActual();
      cerrarItem();
      y += lineHeight * 0.3;
      esPrimeraLineaDeItem = true;
      sangriaItem = 0;
      enIndentInicial = true;
      lineaNueva = true;
      const indent = { texto: "    ", negrita: token.negrita, cursiva: token.cursiva, color: token.color };
      const anchoIndent = medirToken(indent);
      linea.push(indent);
      anchoLinea += anchoIndent;
      sangriaItem = anchoLinea;
    }

    const ancho = medirToken(token);
    const esEspacio = /^\s+$/.test(token.texto);
    if (esEspacio && !linea.length && !lineaNueva) return; // no arrancar una línea de ajuste con espacio
    const anchoDisponible = anchoUtil - (esPrimeraLineaDeItem ? 0 : sangriaItem);
    if (!esEspacio && anchoLinea + ancho > anchoDisponible && linea.length) emitirLineaActual();
    linea.push(token);
    anchoLinea += ancho;
    lineaNueva = false;
    if (enIndentInicial) {
      if (esEspacio || MARCADORES_VINETA.includes(token.texto)) sangriaItem = anchoLinea;
      else enIndentInicial = false;
    }
  });
  emitirLineaActual();
  cerrarItem();
  y += lineHeight * 0.5;

  doc.setTextColor(0);
  return y;
}

// Dibuja un bloque de título (encabezado de subsección, niveles 1-4) en el
// PDF — más chico y con más sangría entre más profundo el nivel. Devuelve
// el nuevo "y". onTitulo(paginaActual), si se pasa, se invoca justo después
// de dibujar el título — la Tabla de Contenido registra ahí la página
// donde empieza a verse este encabezado.
function dibujarTituloBloque(doc, y, bloque, numero, onTitulo) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const altoPagina = doc.internal.pageSize.getHeight();
  const margenInferior = 22;
  const TAMANOS = { 1: 10.5, 2: 10, 3: 9.5, 4: 9.5 };
  const nivel = Math.min(4, Math.max(1, Number(bloque.nivel) || 1));
  if (y > altoPagina - margenInferior - 10) { doc.addPage(); y = 20; }
  doc.setFont("times", nivel <= 2 ? "bold" : "bolditalic");
  doc.setFontSize(TAMANOS[nivel]);
  doc.setTextColor(...NAVY_PDF);
  const margenX = 12 + (nivel - 1) * 3;
  const lineas = doc.splitTextToSize(`${numero}. ${bloque.texto || ""}`, anchoPagina - margenX - 12);
  lineas.forEach((linea) => {
    if (y > altoPagina - margenInferior) { doc.addPage(); y = 20; }
    doc.text(linea, margenX, y);
    y += 5;
  });
  doc.setTextColor(0, 0, 0);
  if (onTitulo) onTitulo(doc.internal.getNumberOfPages());
  return y + 2;
}

// Dibuja un bloque de tabla en el PDF, con combinar celdas/negrilla/color/
// repetición de encabezado al saltar de página. Devuelve el nuevo "y".
// onTitulo(paginaActual), si se pasa, se invoca justo después de dibujar el
// título de la tabla (antes de que el cuerpo pueda saltar de página) — así
// la Lista de tablas registra la página donde empieza a verse la tabla,
// no donde termina.
function dibujarTablaBloque(doc, y, bloque, numero, onTitulo) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const altoPagina = doc.internal.pageSize.getHeight();
  const margenX = 12;
  const margenInferior = altoPagina - 18;
  const anchoUtil = anchoPagina - margenX * 2;

  function saltoSiNoCabe(alturaNecesaria) {
    if (y + alturaNecesaria > margenInferior) { doc.addPage(); y = 20; }
  }

  const filasCrudas = bloque.filas && bloque.filas.length ? bloque.filas : [[""]];
  const filas = filasCrudas.map((f) => (Array.isArray(f) ? f : f.celdas || []));

  const padding = 1.8;
  const numFilas = filas.length;
  const numCols = Math.max(...filas.map((f) => f.length));
  const merges = normalizarMerges(bloque.merges || [], numFilas, numCols);
  const filasEncabezado = Math.max(1, Math.min(Number(bloque.filasEncabezado) || filasEncabezadoAutomatico(numFilas, merges), numFilas));
  const centrados = normalizarCentrados(bloque.centrados || [], numFilas, numCols);
  const centradosVertical = normalizarCentradosVertical(bloque.centradosVertical || [], numFilas, numCols);
  const negritas = normalizarNegritas(bloque.negritas || [], numFilas, numCols);
  const coloresCelda = normalizarColoresCelda(bloque.coloresCelda || [], numFilas, numCols);

  // Fuente de partida 8pt/1.8mm (antes 8.5/2.2) — igual que el resto de la
  // suite. Si la tabla trae muchas columnas y ni el mínimo de cada una
  // (nunca partir su palabra más larga) cabe en la página a este tamaño, se
  // reintenta con la fuente un poco más chica — hasta un piso de 6pt — en
  // vez de partir palabras letra por letra (ver calcularAnchosColumnaConMerges/
  // repartirConMinimos más arriba).
  let fontSize = 8;
  let resultadoAnchos;
  for (;;) {
    doc.setFont("times", "normal");
    doc.setFontSize(fontSize);
    resultadoAnchos = calcularAnchosColumnaConMerges(doc, filas, anchoUtil, merges);
    if (resultadoAnchos.cabe || fontSize <= 6) break;
    fontSize -= 0.5;
  }
  const anchos = resultadoAnchos.anchos;
  // Alto de línea y línea base del texto dentro de la celda, en la misma
  // proporción que se usaba a 8.5pt/4.2mm/3.2mm, escalados al tamaño de
  // fuente que de verdad se usó (puede haber bajado de 8 si la tabla tiene
  // muchas columnas).
  const pasoLinea = fontSize * 0.5;
  const offsetBase = fontSize * 0.375;

  const alturaFilas = new Array(numFilas).fill(0);
  filas.forEach((fila, fi) => {
    doc.setFont("times", fi === 0 ? "bold" : "normal");
    for (let ci = 0; ci < numCols; ci++) {
      const info = celdaCombinada(merges, fi, ci);
      if (info && !info.esAncla) continue;
      if (info && info.merge.filas > 1) continue;
      const ancho = info ? sumaRango(anchos, ci, info.merge.cols) : anchos[ci];
      const lineas = doc.splitTextToSize(String(fila[ci] || ""), ancho - padding * 2);
      const alto = lineas.length * pasoLinea + padding * 2;
      if (alto > alturaFilas[fi]) alturaFilas[fi] = alto;
    }
  });
  for (let fi = 0; fi < numFilas; fi++) if (!alturaFilas[fi]) alturaFilas[fi] = pasoLinea + padding * 2;
  merges.filter((m) => m.filas > 1).forEach((m) => {
    doc.setFont("times", m.fila === 0 ? "bold" : "normal");
    const ancho = sumaRango(anchos, m.col, m.cols);
    const lineas = doc.splitTextToSize(String(filas[m.fila][m.col] || ""), ancho - padding * 2);
    const altoNecesario = lineas.length * pasoLinea + padding * 2;
    const altoActual = sumaRango(alturaFilas, m.fila, m.filas);
    if (altoNecesario > altoActual) {
      const extra = (altoNecesario - altoActual) / m.filas;
      for (let r = m.fila; r < m.fila + m.filas; r++) alturaFilas[r] += extra;
    }
  });

  // El título de la tabla y su encabezado deben quedar en la misma
  // página: se mide el título y el alto real de las filas de encabezado
  // ANTES de decidir el salto de página, para que el salto considere los
  // dos juntos — si solo se mirara el título, un encabezado que no cupiera
  // detrás dejaba el título huérfano al final de la página anterior y la
  // tabla arrancaba sola en la siguiente.
  if (bloque.titulo) {
    doc.setFont("times", "bold");
    doc.setFontSize(9.5);
    const lineasTitulo = doc.splitTextToSize(`Tabla ${numero}. ${bloque.titulo}`, anchoUtil);
    const altoTitulo = lineasTitulo.length * 5;
    const altoEncabezado = sumaRango(alturaFilas, 0, filasEncabezado);
    saltoSiNoCabe(altoTitulo + altoEncabezado);
    doc.setTextColor(...NAVY_PDF);
    doc.text(lineasTitulo, anchoPagina / 2, y, { align: "center" });
    y += altoTitulo;
    if (onTitulo) onTitulo(doc.internal.getNumberOfPages());
  }
  // El título se dibujó en negrilla a 9.5pt — sin este reset, las celdas se
  // dibujaban con ese mismo tamaño heredado (dibujarFila nunca llama
  // setFontSize, solo setFont para negrita/normal), aunque los anchos de
  // columna se habían calculado para el tamaño de la tabla (fontSize): el
  // texto quedaba más ancho que la celda que se le midió, invadiendo la
  // celda vecina o partiendo palabras.
  doc.setFontSize(fontSize);

  function dibujarFila(fila, fi, yPos) {
    let x = margenX;
    if (fi === 0) doc.setFillColor(...GRIS_CLARO_PDF);
    for (let ci = 0; ci < numCols; ci++) {
      const info = celdaCombinada(merges, fi, ci);
      if (!info || info.esAncla) {
        const ancho = info ? sumaRango(anchos, ci, info.merge.cols) : anchos[ci];
        const alto = info && info.merge.filas > 1 ? sumaRango(alturaFilas, fi, info.merge.filas) : alturaFilas[fi];
        if (fi === 0) doc.rect(x, yPos, ancho, alto, "F");
        doc.setDrawColor(210, 214, 219);
        doc.rect(x, yPos, ancho, alto);
      }
      x += anchos[ci];
    }
    x = margenX;
    for (let ci = 0; ci < numCols; ci++) {
      const info = celdaCombinada(merges, fi, ci);
      if (!info || info.esAncla) {
        const ancho = info ? sumaRango(anchos, ci, info.merge.cols) : anchos[ci];
        const alto = info && info.merge.filas > 1 ? sumaRango(alturaFilas, fi, info.merge.filas) : alturaFilas[fi];
        const esNegrita = fi === 0 || celdaNegrita(negritas, fi, ci);
        const color = hexARgb(colorCelda(coloresCelda, fi, ci)) || [20, 22, 26];
        doc.setFont("times", esNegrita ? "bold" : "normal");
        doc.setTextColor(...color);
        const lineas = doc.splitTextToSize(String(fila[ci] || ""), ancho - padding * 2);
        // Por defecto el texto queda arriba de la celda (padding fijo);
        // si está marcada como centrada verticalmente, se reparte el
        // espacio sobrante (alto de la fila menos lo que ocupa el texto)
        // mitad arriba, mitad abajo — útil cuando una celda de al lado
        // tiene varias líneas y esta queda corta.
        const altoTexto = lineas.length * pasoLinea;
        const yTexto = celdaCentradaVertical(centradosVertical, fi, ci)
          ? yPos + Math.max(padding, (alto - altoTexto) / 2) + offsetBase
          : yPos + padding + offsetBase;
        if (celdaCentrada(centrados, fi, ci)) doc.text(lineas, x + ancho / 2, yTexto, { align: "center" });
        else doc.text(lineas, x + padding, yTexto);
      }
      x += anchos[ci];
    }
  }

  function saltoTablaSiNoCabe(alturaNecesaria, esFilaEncabezado) {
    if (y + alturaNecesaria > margenInferior) {
      doc.addPage();
      y = 20;
      if (!esFilaEncabezado && numFilas > filasEncabezado) {
        for (let h = 0; h < filasEncabezado; h++) {
          dibujarFila(filas[h], h, y);
          y += alturaFilas[h];
        }
      }
    }
  }

  filas.forEach((fila, fi) => {
    const inicioMergeVertical = merges.find((m) => m.fila === fi && m.filas > 1);
    const esContinuacion = merges.some((m) => m.filas > 1 && fi > m.fila && fi < m.fila + m.filas);
    if (!esContinuacion) {
      saltoTablaSiNoCabe(inicioMergeVertical ? sumaRango(alturaFilas, fi, inicioMergeVertical.filas) : alturaFilas[fi], fi < filasEncabezado);
    }
    dibujarFila(fila, fi, y);
    y += alturaFilas[fi];
  });

  if (bloque.nota) {
    y += 5;
    doc.setFont("times", "italic");
    doc.setFontSize(9);
    doc.setTextColor(...TEXT_MUTED_PDF);
    const lineasNota = doc.splitTextToSize(bloque.nota, anchoUtil);
    saltoSiNoCabe(lineasNota.length * 4.5);
    doc.text(lineasNota, anchoPagina - margenX, y, { align: "right" });
    y += lineasNota.length * 4.5;
  }
  doc.setTextColor(0);
  return y + 6;
}

// Dibuja un bloque de imagen en el PDF, centrada, con nombre y pie de foto.
// Devuelve el nuevo "y". onTitulo(paginaActual): ver dibujarTablaBloque.
async function dibujarImagenBloque(doc, y, bloque, numero, onTitulo) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const altoPagina = doc.internal.pageSize.getHeight();
  const margenX = 12;
  const margenSuperior = 20;
  const margenInferior = altoPagina - 18;
  const anchoUtil = anchoPagina - margenX * 2;

  try {
    const img = await cargarImagenComoDataURL(bloque.url, "#ffffff", "JPEG");

    // El nombre de la imagen y la imagen misma deben quedar en la misma
    // página: se calcula el tamaño real de la imagen ANTES de decidir el
    // salto, para que el salto considere el título Y la imagen juntos — si
    // solo se mirara el título, una imagen que no cupiera detrás dejaba el
    // nombre huérfano al final de la página anterior y la imagen sola en
    // la siguiente.
    const escalaImagen = Math.min(100, Math.max(30, bloque.tamano || 85)) / 100;
    let ancho = anchoUtil * escalaImagen;
    let alto = ancho * (img.alto / img.ancho);
    const altoMaximo = Math.max(60, margenInferior - margenSuperior - 20);
    if (alto > altoMaximo) { alto = altoMaximo; ancho = alto * (img.ancho / img.alto); }

    if (bloque.nombre) {
      doc.setFont("times", "bold");
      doc.setFontSize(9.5);
      const lineasNombre = doc.splitTextToSize(`Figura ${numero}. ${bloque.nombre}`, anchoUtil);
      const altoNombre = lineasNombre.length * 5;
      if (y + altoNombre + alto + 10 > margenInferior) { doc.addPage(); y = margenSuperior; }
      doc.setTextColor(...NAVY_PDF);
      doc.text(lineasNombre, anchoPagina / 2, y, { align: "center" });
      y += altoNombre;
      if (onTitulo) onTitulo(doc.internal.getNumberOfPages());
    } else if (y + alto + 10 > margenInferior) {
      doc.addPage();
      y = margenSuperior;
    }
    const x = margenX + (anchoUtil - ancho) / 2;
    doc.addImage(img.dataUrl, "JPEG", x, y, ancho, alto);
    y += alto + 3;

    if (bloque.pieDeFoto) {
      doc.setFont("times", "italic");
      doc.setFontSize(9);
      doc.setTextColor(...TEXT_MUTED_PDF);
      const lineasPie = doc.splitTextToSize(bloque.pieDeFoto, anchoUtil);
      doc.text(lineasPie, anchoPagina - margenX, y, { align: "right" });
      y += lineasPie.length * 4.5;
    }
    doc.setTextColor(0);
    return y + 6;
  } catch (e) {
    // Se deja el motivo real en la consola (CORS, 403 de Storage, URL rota,
    // etc.) — el aviso en el PDF es a propósito genérico para quien lo lee,
    // pero quien esté revisando el problema puede abrir la consola del
    // navegador y ver exactamente por qué falló esta imagen en particular.
    console.error(`No se pudo cargar la imagen "${bloque.nombre || "(sin nombre)"}" para el PDF. URL: ${bloque.url}`, e);
    if (y > margenInferior - 14) { doc.addPage(); y = margenSuperior; }
    doc.setDrawColor(214, 69, 69);
    doc.rect(margenX, y, anchoUtil, 14);
    doc.setFont("times", "italic");
    doc.setFontSize(9);
    doc.setTextColor(178, 52, 52);
    doc.text("Aviso: no se pudo cargar esta imagen al generar el documento.", margenX + 4, y + 8);
    doc.setTextColor(0);
    return y + 20;
  }
}

// Dibuja un bloque de firma: etiqueta ("APROBÓ", "ELABORÓ"...) y una fila
// de uno o varios firmantes, cada uno con su línea de firma (y, si la
// subió, la imagen de la firma digital arriba del nombre) — portado de
// Cinco SAS control (dibujarFirma en informes-pdf.js).
async function dibujarFirmaBloque(doc, y, bloque) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const altoPagina = doc.internal.pageSize.getHeight();
  const margenX = 12;
  const margenSuperior = 20;
  const margenInferior = altoPagina - 18;
  const anchoUtil = anchoPagina - margenX * 2;

  const firmantes = bloque.firmantes && bloque.firmantes.length ? bloque.firmantes : [{ nombre: "", cargo: "" }];
  const numFirmantes = firmantes.length;
  const anchoColumna = anchoUtil / numFirmantes;
  const anchoLinea = Math.min(60, anchoColumna * 0.75);

  // Igual que con las imágenes normales: el alto reservado se calcula
  // siempre sobre este tamaño base, sin importar el tamaño real que pida
  // cada firmante — si alguien agranda su firma más de lo normal, la
  // imagen crece hacia arriba y se monta sobre el contenido anterior (como
  // un sello real) en vez de empujar más espacio en blanco.
  const altoFirmaImg = 14;
  const imagenesFirma = await Promise.all(firmantes.map(async (f) => {
    if (!f.firmaUrl) return null;
    try { return await cargarImagenComoDataURL(f.firmaUrl, "#ffffff", "JPEG"); } catch (e) {
      console.error(`No se pudo cargar la firma digital de "${f.nombre || "(sin nombre)"}" para el PDF. URL: ${f.firmaUrl}`, e);
      return null;
    }
  }));
  const hayFirmaDigital = imagenesFirma.some((img) => img);

  doc.setFont("times", "bold");
  doc.setFontSize(10);
  const lineasNombrePorFirmante = firmantes.map((f) => doc.splitTextToSize(f.nombre || "", anchoColumna - 6));
  doc.setFont("times", "normal");
  doc.setFontSize(8.5);
  const lineasCargoPorFirmante = firmantes.map((f) => (f.cargo ? doc.splitTextToSize(f.cargo, anchoColumna - 6) : []));
  const maxLineasNombre = Math.max(1, ...lineasNombrePorFirmante.map((l) => l.length));
  const maxLineasCargo = Math.max(0, ...lineasCargoPorFirmante.map((l) => l.length));

  const altoEtiqueta = bloque.etiqueta ? 9 : 0;
  // Sin firma digital, este espacio queda en blanco para firmar a mano
  // sobre el PDF impreso — se deja más amplio que el de una firma digital
  // (que ya trae su propio tamaño) para que quepa una firma real a lápiz.
  const espacioParaFirmar = hayFirmaDigital ? altoFirmaImg + 4 : 24;
  const altoNombre = maxLineasNombre * 4.2 + 5;
  const altoCargo = maxLineasCargo * 3.8;
  if (y + altoEtiqueta + espacioParaFirmar + altoNombre + altoCargo + 4 > margenInferior) { doc.addPage(); y = margenSuperior; }

  if (bloque.etiqueta) {
    doc.setFont("times", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...NAVY_PDF);
    doc.text(bloque.etiqueta.toUpperCase(), margenX, y);
  }
  y += altoEtiqueta + espacioParaFirmar;

  firmantes.forEach((firmante, i) => {
    const xCentro = margenX + anchoColumna * i + anchoColumna / 2;

    const imgFirma = imagenesFirma[i];
    if (imgFirma) {
      const altoDeseado = Math.min(60, Math.max(6, Number(firmante.altoFirma) || altoFirmaImg));
      let anchoImg = altoDeseado * (imgFirma.ancho / imgFirma.alto);
      if (anchoImg > anchoColumna - 6) anchoImg = anchoColumna - 6;
      const altoImg = anchoImg * (imgFirma.alto / imgFirma.ancho);
      doc.addImage(imgFirma.dataUrl, "JPEG", xCentro - anchoImg / 2, y - altoImg - 2, anchoImg, altoImg);
    }

    doc.setDrawColor(120, 126, 134);
    doc.setLineWidth(0.4);
    doc.line(xCentro - anchoLinea / 2, y, xCentro + anchoLinea / 2, y);

    doc.setFont("times", "bold");
    doc.setFontSize(10);
    doc.setTextColor(20, 22, 26);
    doc.text(lineasNombrePorFirmante[i].length ? lineasNombrePorFirmante[i] : [" "], xCentro, y + 5, { align: "center" });

    if (lineasCargoPorFirmante[i].length) {
      doc.setFont("times", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...TEXT_MUTED_PDF);
      doc.text(lineasCargoPorFirmante[i], xCentro, y + 5 + maxLineasNombre * 4.2 + 3, { align: "center" });
    }
  });

  doc.setTextColor(0);
  return y + 5 + maxLineasNombre * 4.2 + (maxLineasCargo ? maxLineasCargo * 3.8 + 3 : 0) + 8;
}

// Calcula el número que le toca a UN título, en cascada, a partir de los
// contadores COMPARTIDOS de todo el informe (ver el comentario en el botón
// de generar PDF) — nadie escribe el número a mano y nunca queda
// desincronizado al agregar, quitar, mover o reordenar un bloque, una
// estrategia entera, o al pasar de una estrategia a la siguiente (la
// numeración sigue corrida, no se reinicia). Un título nivel 2 continúa el
// último nivel 1 visto (ej. "6" -> primer nivel1 "6.1", su primer nivel2
// "6.1.1"); al aparecer un nivel más superficial, los niveles más
// profundos se reinician a cero.
function siguienteNumeroTitulo(contadoresTitulo, nivelBloque) {
  const nivel = Math.min(4, Math.max(1, Number(nivelBloque) || 1));
  contadoresTitulo[nivel - 1]++;
  for (let k = nivel; k < 4; k++) contadoresTitulo[k] = 0;
  return contadoresTitulo.slice(0, nivel).join(".");
}

// A modo de guía para quien está llenando el contenido, el editor muestra
// junto a cada título/tabla/imagen el número que le tocaría en el PDF —
// solo de referencia (no editable, no se guarda): la numeración real se
// vuelve a calcular igual, desde cero, al generar el informe (ver
// siguienteNumeroTitulo más arriba y el botón "Generar informe PDF").
//
// Como el editor de una estrategia solo ve sus propios bloques, primero se
// recorre TODA la lista visual para saber en qué "punto" de los contadores
// (título/tabla/imagen) queda cada estrategia justo ANTES de empezar sus
// propios bloques — ese punto de partida es lo único que depende de las
// demás estrategias, y solo se recalcula cuando corre un render() completo
// (ej. llega un snapshot de Firestore).
function calcularInicioNumeracionPorEstrategia(visual) {
  const contadoresTitulo = [0, 0, 0, 0];
  const contadorTabla = { n: 0 };
  const contadorImagen = { n: 0 };
  const porEstrategia = new Map();
  visual.forEach((e) => {
    porEstrategia.set(e.id, {
      contadoresTitulo: contadoresTitulo.slice(),
      contadorTabla: contadorTabla.n,
      contadorImagen: contadorImagen.n
    });
    const bloques = borradorContenido.get(e.id) || contenidoABloques(e.contenido);
    bloques.forEach((b) => {
      if (b.tipo === "titulo") siguienteNumeroTitulo(contadoresTitulo, b.nivel);
      else if (b.tipo === "tabla" && b.titulo) contadorTabla.n++;
      else if (b.tipo === "imagen" && b.nombre) contadorImagen.n++;
    });
  });
  return porEstrategia;
}

// A partir del punto de partida de los contadores (ver la función
// anterior), calcula el numeral de cada bloque de UNA estrategia. Se vuelve
// a llamar en cada re-render de su propio editor (incluida cada tecla),
// para que si la persona agrega, quita o reordena un título/tabla/imagen
// dentro de su propia estrategia, el numeral mostrado se actualice al
// instante sin esperar a un render() completo.
function calcularNumerosLocales(bloques, inicio) {
  const contadoresTitulo = (inicio?.contadoresTitulo || [0, 0, 0, 0]).slice();
  let nTabla = inicio?.contadorTabla || 0;
  let nImagen = inicio?.contadorImagen || 0;
  return bloques.map((b) => {
    if (b.tipo === "titulo") return siguienteNumeroTitulo(contadoresTitulo, b.nivel);
    if (b.tipo === "tabla") return b.titulo ? String(++nTabla) : null;
    if (b.tipo === "imagen") return b.nombre ? String(++nImagen) : null;
    return null;
  });
}

// Dibuja la sección completa de una estrategia (título administrativo +
// sus bloques) en el PDF. Devuelve el nuevo "y". "esEncabezado" (tarjeta
// que solo agrupa subtítulos/zonas, sin contenido propio): si no tiene
// bloques, no muestra "Sin contenido registrado" — simplemente no hay nada
// más que dibujar. "tracking" (opcional): { indiceEntradas, tablasEntradas,
// graficosEntradas, contadoresTitulo, contadorTabla, contadorImagen }.
async function agregarSeccionEstrategia(doc, y, titulo, bloques, tracking, esEncabezado = false) {
  const anchoPagina = doc.internal.pageSize.getWidth();
  const altoPagina = doc.internal.pageSize.getHeight();
  const margenInferior = 22;
  if (titulo) {
    if (y > altoPagina - margenInferior - 20) { doc.addPage(); y = 20; }
    doc.setFont("times", "bold");
    doc.setFontSize(11);
    doc.text(titulo, 12, y);
    y += 6;
  }

  if (!bloques.length) {
    if (esEncabezado) return y + 2;
    doc.setFont("times", "normal");
    doc.setFontSize(9.5);
    doc.text("Sin contenido registrado.", 12, y);
    return y + 12;
  }

  for (let bi = 0; bi < bloques.length; bi++) {
    const bloque = bloques[bi];
    if (bloque.tipo === "titulo") {
      const numero = siguienteNumeroTitulo(tracking.contadoresTitulo, bloque.nivel);
      y = dibujarTituloBloque(doc, y, bloque, numero, (pagina) => {
        if (tracking) tracking.indiceEntradas.push({ texto: `${numero}. ${bloque.texto}`, nivel: bloque.nivel, pagina });
      });
    } else if (bloque.tipo === "tabla") {
      const numeroTabla = bloque.titulo ? ++tracking.contadorTabla.n : null;
      y = dibujarTablaBloque(doc, y, bloque, numeroTabla, (pagina) => {
        if (tracking && bloque.titulo) tracking.tablasEntradas.push({ texto: `Tabla ${numeroTabla}. ${bloque.titulo}`, pagina });
      });
    } else if (bloque.tipo === "imagen") {
      if (!bloque.url) continue;
      const numeroImagen = bloque.nombre ? ++tracking.contadorImagen.n : null;
      y = await dibujarImagenBloque(doc, y, bloque, numeroImagen, (pagina) => {
        if (tracking && bloque.nombre) tracking.graficosEntradas.push({ texto: `Figura ${numeroImagen}. ${bloque.nombre}`, pagina });
      });
    } else if (bloque.tipo === "firma") {
      y = await dibujarFirmaBloque(doc, y, bloque);
    } else {
      // párrafo (o cualquier tipo desconocido, por compatibilidad)
      y = dibujarParrafoBloque(doc, y, bloque);
    }
  }
  return y + 6;
}

// ======================================================================
// Tabla de Contenido + Lista de tablas + Lista de gráficos — se insertan
// como páginas nuevas justo después de la página 1 (encabezado + cuadro
// resumen), antes del desarrollo. Mismo truco que en Cinco SAS control:
// el cuerpo se dibuja primero (registrando en qué página cae cada
// estrategia/tabla/gráfico), y solo al final se calcula cuántas páginas
// hacen falta para el índice y se insertan — así el índice puede tener
// numeración de página real sin tener que dibujar el documento dos veces.
//
// "recorrerListaIndice" es la única fuente de verdad del diseño (altura de
// título de sección + una línea por entrada): se usa tanto para SIMULAR
// (calcularPaginasIndice, sin doc, solo para contar páginas) como para
// DIBUJAR de verdad (dibujarIndiceCompleto) — así ambos recorridos avanzan
// exactamente igual y nunca se desincronizan.
// ======================================================================

const INDICE_MARGEN_X = 12;
const INDICE_ALTURA_ENTRADA = 6;

function recorrerListaIndice(doc, estado, titulo, entradas, { margenSuperior, margenInferior, anchoUtil }) {
  let { pagina, y } = estado;
  const dibujar = !!doc;

  function paginaSiguiente() {
    pagina += 1;
    y = margenSuperior;
    if (dibujar) doc.setPage(pagina + 1); // pagina 1 = primera página insertada = página real 2
  }
  function saltoSiNoCabe(altura) {
    if (y + altura > margenInferior) paginaSiguiente();
  }

  if (y > margenSuperior + 0.5) { saltoSiNoCabe(20); y += 6; }
  if (dibujar) {
    doc.setFont("times", "bold");
    doc.setFontSize(13);
    doc.setTextColor(31, 39, 50);
    doc.text(titulo, INDICE_MARGEN_X, y);
    doc.setDrawColor(254, 178, 9);
    doc.setLineWidth(0.6);
    doc.line(INDICE_MARGEN_X, y + 2, anchoUtil + INDICE_MARGEN_X, y + 2);
    doc.setTextColor(0);
  }
  y += 10;

  entradas.forEach((en) => {
    saltoSiNoCabe(INDICE_ALTURA_ENTRADA);
    if (dibujar) {
      const nivel = Math.min(4, Math.max(1, Number(en.nivel) || 1));
      const indent = (nivel - 1) * 6;
      doc.setFont("times", nivel === 1 ? "bold" : nivel >= 3 ? "italic" : "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(20, 22, 26);
      const paginaTexto = String(en.pagina);
      const anchoDisponible = anchoUtil - indent - doc.getTextWidth(paginaTexto) - 4;
      const lineasTexto = doc.splitTextToSize(en.texto, anchoDisponible);
      const textoLinea = lineasTexto[0] + (lineasTexto.length > 1 ? "..." : "");
      doc.text(textoLinea, INDICE_MARGEN_X + indent, y);
      const anchoTexto = doc.getTextWidth(textoLinea);
      const xFinTexto = INDICE_MARGEN_X + indent + anchoTexto + 2;
      const xInicioPagina = INDICE_MARGEN_X + anchoUtil - doc.getTextWidth(paginaTexto);
      if (xInicioPagina - 2 > xFinTexto) {
        doc.setTextColor(170, 174, 179);
        const anchoPunto = doc.getTextWidth(". ");
        const cantidadPuntos = Math.max(0, Math.floor((xInicioPagina - 2 - xFinTexto) / anchoPunto));
        doc.text(". ".repeat(cantidadPuntos), xFinTexto, y);
      }
      doc.setTextColor(20, 22, 26);
      doc.text(paginaTexto, INDICE_MARGEN_X + anchoUtil, y, { align: "right" });
      doc.setTextColor(0);
    }
    y += INDICE_ALTURA_ENTRADA;
  });
  y += 8;
  return { pagina, y };
}

function calcularPaginasIndice(indiceEntradas, tablasEntradas, graficosEntradas, geometria) {
  let estado = { pagina: 1, y: geometria.margenSuperior };
  if (indiceEntradas.length) estado = recorrerListaIndice(null, estado, "Contenido", indiceEntradas, geometria);
  if (tablasEntradas.length) estado = recorrerListaIndice(null, estado, "Lista de tablas", tablasEntradas, geometria);
  if (graficosEntradas.length) estado = recorrerListaIndice(null, estado, "Lista de gráficos", graficosEntradas, geometria);
  return estado.pagina;
}

function dibujarIndiceCompleto(doc, indiceEntradas, tablasEntradas, graficosEntradas, geometria) {
  doc.setPage(2);
  let estado = { pagina: 1, y: geometria.margenSuperior };
  if (indiceEntradas.length) estado = recorrerListaIndice(doc, estado, "Contenido", indiceEntradas, geometria);
  if (tablasEntradas.length) estado = recorrerListaIndice(doc, estado, "Lista de tablas", tablasEntradas, geometria);
  if (graficosEntradas.length) estado = recorrerListaIndice(doc, estado, "Lista de gráficos", graficosEntradas, geometria);
}
