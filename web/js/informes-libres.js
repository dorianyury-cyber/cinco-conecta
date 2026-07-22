import {
  collection, onSnapshot, query, orderBy, addDoc, updateDoc, deleteDoc, doc,
  serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import {
  db, functions, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert,
  friendlyError, formatDate, hoyStr, obtenerArchivoComoDataUrl
} from "./utils.js";
import {
  crearDocumentoPDF, agregarPortadaInforme, agregarBloqueTitulo, agregarBloqueParrafo,
  agregarBloqueImagen, agregarBloqueTabla, agregarBloqueGraficoBarras, agregarBloqueGraficoLineas,
  agregarBloqueGraficoPastel, agregarEncabezadoPiePaginaInforme, agregarSeccionReferencias,
  descargarPDF, crearContadoresInforme, agregarTablaDeContenido, agregarIndiceElementos,
  contarPaginasDeListado
} from "./pdf.js";
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs";

const { user, perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

const uid = user.uid;
const esAdmin = perfil.rol === "admin";

// Referencias APA que siempre se incluyen por defecto en un informe nuevo
// (normas del Sistema de Gestión Integrado de Cinco S.A.S. + RETIE) — el
// usuario puede editarlas/quitarlas/agregar las suyas, pero el PDF siempre
// lleva la sección de Referencias, así el documento importado no traiga
// ninguna.
const REFERENCIAS_POR_DEFECTO = [
  "International Organization for Standardization. (2015). Sistemas de gestión de la calidad — Requisitos (ISO 9001:2015).",
  "International Organization for Standardization. (2015). Sistemas de gestión ambiental — Requisitos con orientación para su uso (ISO 14001:2015).",
  "International Organization for Standardization. (2018). Sistemas de gestión de la seguridad y salud en el trabajo — Requisitos con orientación para su uso (ISO 45001:2018).",
  "Ministerio de Minas y Energía de Colombia. (2013). Reglamento Técnico de Instalaciones Eléctricas (RETIE)."
];

// ---------------------------------------------------------------------
// Imagen: comprimir en el navegador antes de subir (fotos de obra desde
// celular fácilmente pesan varios MB; un informe con muchas fotos sin
// comprimir puede saturar la memoria del navegador al generar el PDF).
// ---------------------------------------------------------------------

// El navegador solo puede decodificar los formatos de imagen que soporta de
// forma nativa. El caso real más común de "no se pudo leer la imagen" es una
// foto de iPhone en formato HEIC (formato de cámara por defecto de Apple),
// que no se puede mostrar en un <img> de escritorio — se valida el tipo
// ANTES de intentar decodificar, para dar un mensaje que explique qué pasó
// en vez del genérico error de decodificación del navegador.
const TIPOS_IMAGEN_PERMITIDOS = ["image/jpeg", "image/png", "image/webp"];
const EXTENSIONES_IMAGEN_PERMITIDAS = ["jpg", "jpeg", "png", "webp"];

function validarTipoImagen(file) {
  if (TIPOS_IMAGEN_PERMITIDOS.includes(file.type)) return null;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  // En algunos equipos Windows la asociación de archivo de ".jpg" está mal
  // configurada y el navegador no puede determinar el tipo (file.type llega
  // vacío) aunque el archivo sea un JPG real — en ese caso confiar en la
  // extensión en vez de rechazarlo de una.
  if (!file.type && EXTENSIONES_IMAGEN_PERMITIDAS.includes(ext)) return null;
  return `Formato de imagen no compatible${file.type ? ` (${file.type})` : ext ? ` (.${ext})` : ""}. Usa JPG, PNG o WEBP. Si es una foto de iPhone en formato HEIC, conviértela primero a JPG.`;
}

function comprimirImagen(file, maxLado = 1600, calidad = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > height && width > maxLado) {
        height = Math.round(height * (maxLado / width));
        width = maxLado;
      } else if (height > maxLado) {
        width = Math.round(width * (maxLado / height));
        height = maxLado;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error("No se pudo procesar la imagen.")); return; }
        resolve(blob);
      }, "image/jpeg", calidad);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la imagen.")); };
    img.src = url;
  });
}

function leerBlobComoBase64(blob) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(String(lector.result).split(",")[1] || "");
    lector.onerror = reject;
    lector.readAsDataURL(blob);
  });
}

function base64ABlob(base64, contentType) {
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return new Blob([bytes], { type: contentType || "image/png" });
}

function cargarImagenElemento(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// ---------------------------------------------------------------------
// Gráficos vectoriales (SVG) para la vista previa en pantalla — sin
// librería de gráficos, mismos colores de marca (ámbar→navy) que la
// versión que dibuja pdf.js con las primitivas de jsPDF.
// ---------------------------------------------------------------------

function colorPaletaSvg(i, total) {
  const amber = [254, 178, 9];
  const navy = [31, 39, 50];
  if (total <= 1) return `rgb(${amber.join(",")})`;
  const t = i / (total - 1);
  const c = amber.map((v, idx) => Math.round(v + (navy[idx] - v) * t));
  return `rgb(${c.join(",")})`;
}

function generarSvgBarras(etiquetas, valores) {
  const ancho = 560, alto = 160, margen = 24;
  const max = Math.max(...valores, 1);
  const anchoBarra = (ancho - margen * 2) / valores.length;
  const yBase = alto - margen;
  const barras = valores.map((v, i) => {
    const h = (v / max) * (alto - margen * 2);
    const x = margen + i * anchoBarra + anchoBarra * 0.15;
    const y = yBase - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(anchoBarra * 0.7).toFixed(1)}" height="${h.toFixed(1)}" fill="${colorPaletaSvg(i, valores.length)}"></rect>
            <text x="${(x + anchoBarra * 0.35).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="9" text-anchor="middle">${v}</text>
            <text x="${(x + anchoBarra * 0.35).toFixed(1)}" y="${(yBase + 12).toFixed(1)}" font-size="8" text-anchor="middle">${etiquetas[i] ?? ""}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${ancho} ${alto}" xmlns="http://www.w3.org/2000/svg">
    <line x1="${margen}" y1="${yBase}" x2="${ancho - margen}" y2="${yBase}" stroke="#ccc"></line>
    ${barras}
  </svg>`;
}

function generarSvgLineas(etiquetas, valores) {
  const ancho = 560, alto = 160, margen = 24;
  const max = Math.max(...valores, 1);
  const yBase = alto - margen;
  const paso = valores.length > 1 ? (ancho - margen * 2) / (valores.length - 1) : 0;
  const puntos = valores.map((v, i) => ({ x: margen + i * paso, y: yBase - (v / max) * (alto - margen * 2) }));
  const linea = puntos.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const marcadores = puntos.map((p, i) => `
    <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="rgb(254,178,9)"></circle>
    <text x="${p.x.toFixed(1)}" y="${(p.y - 6).toFixed(1)}" font-size="9" text-anchor="middle">${valores[i]}</text>
    <text x="${p.x.toFixed(1)}" y="${(yBase + 12).toFixed(1)}" font-size="8" text-anchor="middle">${etiquetas[i] ?? ""}</text>
  `).join("");
  return `<svg viewBox="0 0 ${ancho} ${alto}" xmlns="http://www.w3.org/2000/svg">
    <line x1="${margen}" y1="${yBase}" x2="${ancho - margen}" y2="${yBase}" stroke="#ccc"></line>
    <polyline points="${linea}" fill="none" stroke="rgb(217,148,0)" stroke-width="1.5"></polyline>
    ${marcadores}
  </svg>`;
}

function generarSvgPastel(etiquetas, valores) {
  const total = valores.reduce((s, v) => s + v, 0) || 1;
  const cx = 70, cy = 80, r = 65;
  let anguloAcumulado = 0;
  const coordenada = (anguloGrados) => {
    const rad = ((anguloGrados - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const sectores = valores.map((v, i) => {
    const inicio = anguloAcumulado;
    anguloAcumulado += (v / total) * 360;
    const fin = anguloAcumulado;
    const [x1, y1] = coordenada(inicio);
    const [x2, y2] = coordenada(fin);
    const grande = fin - inicio > 180 ? 1 : 0;
    return `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${grande},1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${colorPaletaSvg(i, valores.length)}"></path>`;
  }).join("");
  const leyenda = etiquetas.map((et, i) => {
    const y = 14 + i * 16;
    const porcentaje = Math.round((valores[i] / total) * 100);
    return `<rect x="160" y="${y - 9}" width="10" height="10" fill="${colorPaletaSvg(i, valores.length)}"></rect>
            <text x="176" y="${y}" font-size="9">${et || ""} (${porcentaje}%)</text>`;
  }).join("");
  return `<svg viewBox="0 0 320 160" xmlns="http://www.w3.org/2000/svg">${sectores}${leyenda}</svg>`;
}

function generarSvgGrafico(tipo, etiquetas, valores) {
  if (!valores || valores.length === 0) return '<p class="text-muted text-sm">Agrega al menos un dato.</p>';
  if (tipo === "lineas") return generarSvgLineas(etiquetas, valores);
  if (tipo === "pastel") return generarSvgPastel(etiquetas, valores);
  return generarSvgBarras(etiquetas, valores);
}

// ---------------------------------------------------------------------
// Numeración jerárquica de títulos (1, 1.1, 1.1.1, 2, 2.1...) — única
// fuente de verdad, usada tanto en la vista del editor como en el PDF.
// ---------------------------------------------------------------------

function calcularNumeracionBloques(bloques) {
  const contador = [0, 0, 0];
  return bloques.map((b) => {
    if (b.tipo === "titulo1") { contador[0]++; contador[1] = 0; contador[2] = 0; return String(contador[0]); }
    if (b.tipo === "titulo2") { contador[1]++; contador[2] = 0; return `${contador[0]}.${contador[1]}`; }
    if (b.tipo === "titulo3") { contador[2]++; return `${contador[0]}.${contador[1]}.${contador[2]}`; }
    return "";
  });
}

// ---------------------------------------------------------------------
// Código de control documental (INT-{año}-{consecutivo}) — se asigna solo
// una vez, al crear el informe, mediante un contador atómico compartido
// con generarInformePlantilla (misma secuencia para los dos tipos de
// informe, porque documentalmente son el mismo tipo de registro). Nunca
// se vuelve a pedir a mano ni se puede repetir.
// ---------------------------------------------------------------------

async function generarCodigoInforme() {
  const anio = new Date().getFullYear();
  const contadorRef = doc(db, "contadoresCodigo", String(anio));
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(contadorRef);
    const siguiente = (snap.exists() ? snap.data().ultimo : 0) + 1;
    tx.set(contadorRef, { ultimo: siguiente });
    return `INT-${anio}-${String(siguiente).padStart(3, "0")}`;
  });
}

// ---------------------------------------------------------------------
// Cargar propuesta en PDF: extrae el texto (pdfjs-dist, 100% en el
// navegador) y adivina título/cliente/identificación/proyecto por
// palabras clave — es una ayuda de mejor esfuerzo, no una lectura exacta;
// el usuario siempre revisa/edita los campos antes de guardar.
// ---------------------------------------------------------------------

async function extraerTextoPdf(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const lineas = [];
  let itemsPrimeraPagina = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pagina = await pdf.getPage(i);
    const contenido = await pagina.getTextContent();
    if (i === 1) itemsPrimeraPagina = contenido.items;
    let lineaActual = "";
    let yActual = null;
    contenido.items.forEach((item) => {
      const y = item.transform[5];
      if (yActual !== null && Math.abs(y - yActual) > 2) {
        if (lineaActual.trim()) lineas.push(lineaActual.trim());
        lineaActual = "";
      }
      lineaActual += `${item.str} `;
      yActual = y;
    });
    if (lineaActual.trim()) lineas.push(lineaActual.trim());
  }
  return { lineas, itemsPrimeraPagina };
}

function buscarPorEtiqueta(lineas, patrones) {
  for (const linea of lineas) {
    for (const patron of patrones) {
      const m = linea.match(patron);
      if (m && m[1] && m[1].trim()) return m[1].trim().replace(/[.,;]+$/, "");
    }
  }
  return "";
}

// Para campos largos tipo "Referencia:"/"Objeto:" el valor casi siempre
// sigue en la(s) línea(s) siguiente(s) (texto que hace salto de línea en
// el PDF) — se van agregando líneas mientras la última no termine en
// punto/signo de cierre, hasta un tope de seguridad.
function buscarCampoMultilinea(lineas, patrones, maxContinuacion = 5) {
  for (let i = 0; i < lineas.length; i++) {
    for (const patron of patrones) {
      const m = lineas[i].match(patron);
      if (m && m[1] && m[1].trim()) {
        let valor = m[1].trim();
        let agregadas = 0;
        while (!/[.!?]$/.test(valor) && agregadas < maxContinuacion && i + 1 + agregadas < lineas.length) {
          const siguiente = (lineas[i + 1 + agregadas] || "").trim();
          if (siguiente.length < 3) break;
          valor += ` ${siguiente}`;
          agregadas++;
        }
        return valor.replace(/[,;]+$/, "").trim();
      }
    }
  }
  return "";
}

// Formato clásico de carta colombiana: "Señores" / "Estimados señores" y,
// en las líneas siguientes, el nombre del destinatario (cliente), antes de
// NIT/Ciudad/Dirección — muy común en propuestas/cotizaciones, y el
// cliente casi nunca aparece con una etiqueta "Cliente:" explícita ahí.
function buscarClienteTrasSaludo(lineas) {
  const idx = lineas.findIndex((l) => /^se[ñn]or(es)?\.?$/i.test(l.trim()) || /^estimados?\s+se[ñn]or/i.test(l.trim()));
  if (idx === -1) return "";
  for (let j = idx + 1; j < Math.min(idx + 4, lineas.length); j++) {
    const linea = lineas[j].trim();
    if (!linea) continue;
    if (/^nit\b/i.test(linea) || /^c\.?c\.?\b/i.test(linea)) continue;
    if (/^ciudad$/i.test(linea) || /^direcci[oó]n/i.test(linea)) continue;
    return linea;
  }
  return "";
}

const PALABRAS_GENERICAS_CLIENTE = [
  "conjunto", "residencial", "edificio", "urbanizacion", "urbanización", "condominio",
  "empresa", "compañia", "compañía", "sociedad", "copropiedad", "propiedad", "horizontal",
  "ph", "s.a.s", "sas", "s.a", "s.a.", "ltda", "e.s.p", "esp", "e.u", "eu"
];

// El "nombre corto de proyecto" casi nunca aparece escrito como tal en
// estas propuestas (no hay una etiqueta "Proyecto:") — se sugiere a partir
// del nombre del cliente, quitando palabras genéricas de razón social,
// tal como normalmente se nombran los proyectos internamente
// (Ej. "Conjunto Residencial Siena" -> "SIENA").
function sugerirProyectoDesdeCliente(cliente) {
  if (!cliente) return "";
  const palabras = cliente
    .split(/\s+/)
    .filter((p) => p && !PALABRAS_GENERICAS_CLIENTE.includes(p.toLowerCase().replace(/[.,]/g, "")));
  return palabras.join(" ").toUpperCase();
}

function adivinarTituloPorTamanoFuente(itemsPrimeraPagina) {
  if (!itemsPrimeraPagina.length) return "";
  let mayor = itemsPrimeraPagina[0];
  let alturaMayor = Math.hypot(mayor.transform[2], mayor.transform[3]);
  itemsPrimeraPagina.forEach((item) => {
    const altura = Math.hypot(item.transform[2], item.transform[3]);
    if (altura > alturaMayor && item.str.trim().length > 3) {
      mayor = item;
      alturaMayor = altura;
    }
  });
  return mayor.str.trim();
}

function extraerCamposDePropuesta(lineas, itemsPrimeraPagina) {
  let cliente = buscarPorEtiqueta(lineas, [/cliente[:\s]+(.+)/i, /raz[oó]n social[:\s]+(.+)/i, /empresa[:\s]+(.+)/i, /contratante[:\s]+(.+)/i]);
  if (!cliente) cliente = buscarClienteTrasSaludo(lineas);

  let identificacion = buscarPorEtiqueta(lineas, [
    /nit[:\s.]*n?°?\s*([\d.]+(?:\s*-\s*\d+)?)/i,
    /c[eé]dula(?:\s+de\s+ciudadan[ií]a)?[:\s.]*(?:no\.?)?\s*([\d.]+(?:\s*-\s*\d+)?)/i,
    /c\.?c\.?[:\s.]*n?°?\s*([\d.]+(?:\s*-\s*\d+)?)/i
  ]);
  if (identificacion) identificacion = identificacion.replace(/\s*-\s*/, "-");

  let titulo = buscarCampoMultilinea(lineas, [
    /referencia[:\s]+(.+)/i,
    /objeto(?:\s+del\s+contrato)?[:\s]+(.+)/i,
    /asunto[:\s]+(.+)/i,
    /t[ií]tulo[:\s]+(.+)/i,
    /propuesta[:\s]+(.+)/i
  ]);
  titulo = titulo.replace(/^cotizaci[oó]n\s+(del?|de\s+la)\s+/i, "");
  if (titulo) titulo = titulo.charAt(0).toUpperCase() + titulo.slice(1);
  if (!titulo) titulo = adivinarTituloPorTamanoFuente(itemsPrimeraPagina);

  let proyecto = buscarPorEtiqueta(lineas, [/proyecto[:\s]+(.+)/i]);
  if (!proyecto) proyecto = sugerirProyectoDesdeCliente(cliente);

  return { titulo, cliente, proyecto, identificacion };
}

// ---------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------

let informes = [];
let informeActual = null;
let bloques = [];
let referencias = [];
let modoMeta = "crear";
const imagenesCache = {};
const imagenesCargando = new Set();

const tablaInformes = document.getElementById("tablaInformes");
const datalistClientes = document.getElementById("clientesConocidos");
const contenedorBloques = document.getElementById("contenedorBloques");
const contenedorReferencias = document.getElementById("contenedorReferencias");
const modalBackdrop = document.getElementById("modalBackdrop");
const metaAlertBox = document.getElementById("metaAlertBox");

// ---------------------------------------------------------------------
// Vista: lista de informes
// ---------------------------------------------------------------------

function renderListaInformes() {
  if (informes.length === 0) {
    tablaInformes.innerHTML = '<tr><td colspan="7" class="text-muted text-center">Aún no hay informes.</td></tr>';
  } else {
    tablaInformes.innerHTML = informes.map((inf) => {
      const puedeBorrar = esAdmin || (inf.autorUid === uid && inf.estado === "borrador");
      return `
        <tr>
          <td>${inf.codigo || "-"}</td>
          <td><b>${inf.titulo}</b></td>
          <td>${inf.cliente || "-"}</td>
          <td>${inf.autorNombre || "-"}</td>
          <td><span class="badge ${inf.estado === "final" ? "ok" : "warn"}">${inf.estado === "final" ? "Final" : "Borrador"}</span></td>
          <td>${inf.creadoEn ? formatDate(inf.creadoEn) : "-"}</td>
          <td>
            <button class="icon-btn" data-abrir="${inf.id}">📂 Abrir</button>
            ${puedeBorrar ? `<button class="icon-btn danger" data-borrar="${inf.id}">🗑️ Eliminar</button>` : ""}
          </td>
        </tr>
      `;
    }).join("");
  }

  const clientesUnicos = [...new Set(informes.map((i) => i.cliente).filter(Boolean))];
  datalistClientes.innerHTML = clientesUnicos.map((c) => `<option value="${c}"></option>`).join("");
}

onSnapshot(query(collection(db, "informesLibres"), orderBy("creadoEn", "desc")), (snap) => {
  informes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderListaInformes();
}, (err) => {
  tablaInformes.innerHTML = `<tr><td colspan="7" class="text-muted text-center">${friendlyError(err)}</td></tr>`;
});

tablaInformes.addEventListener("click", async (e) => {
  const abrirId = e.target.dataset.abrir;
  const borrarId = e.target.dataset.borrar;

  if (abrirId) {
    const inf = informes.find((i) => i.id === abrirId);
    if (inf) abrirEditor(inf);
  }

  if (borrarId) {
    if (!confirm("¿Eliminar este informe? Esta acción no se puede deshacer.")) return;
    try {
      await deleteDoc(doc(db, "informesLibres", borrarId));
    } catch (err) {
      alert(friendlyError(err));
    }
  }
});

// ---------------------------------------------------------------------
// Modal de metadatos (crear / editar)
// ---------------------------------------------------------------------

function abrirModalMeta(modo, informe) {
  modoMeta = modo;
  clearAlert(metaAlertBox);
  document.getElementById("modalTitulo").textContent = modo === "crear" ? "Nuevo informe" : "Editar datos del informe";
  document.getElementById("metaTitulo").value = informe?.titulo || "";
  document.getElementById("metaCliente").value = informe?.cliente || "";
  document.getElementById("metaIdentificacion").value = informe?.identificacionCliente || "";
  document.getElementById("metaProyecto").value = informe?.proyecto || "";
  document.getElementById("metaVersion").value = informe?.version || "1.0";
  document.getElementById("metaAprobador").value = informe?.aprobador || "";
  document.getElementById("metaCiudad").value = informe?.ciudad || "Neiva";
  document.getElementById("propuestaEstado").textContent = "";
  modalBackdrop.classList.add("open");
}

document.getElementById("nuevoInformeBtn").addEventListener("click", () => abrirModalMeta("crear"));
document.getElementById("metaCancelarBtn").addEventListener("click", () => modalBackdrop.classList.remove("open"));

document.getElementById("cargarPropuestaBtn").addEventListener("click", () => document.getElementById("inputPropuestaPdf").click());

document.getElementById("inputPropuestaPdf").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const estadoEl = document.getElementById("propuestaEstado");
  estadoEl.textContent = "Leyendo el PDF...";
  try {
    const { lineas, itemsPrimeraPagina } = await extraerTextoPdf(file);
    const campos = extraerCamposDePropuesta(lineas, itemsPrimeraPagina);
    if (campos.titulo) document.getElementById("metaTitulo").value = campos.titulo;
    if (campos.cliente) document.getElementById("metaCliente").value = campos.cliente;
    if (campos.identificacion) document.getElementById("metaIdentificacion").value = campos.identificacion;
    if (campos.proyecto) document.getElementById("metaProyecto").value = campos.proyecto;
    const detectados = Object.entries(campos).filter(([, v]) => v).map(([k]) => k);
    estadoEl.textContent = detectados.length
      ? `Detectado automáticamente: ${detectados.join(", ")}. Revisa y corrige antes de guardar.`
      : "No se detectó ningún dato automáticamente — completa los campos a mano.";
  } catch (err) {
    estadoEl.textContent = "No se pudo leer el PDF. Completa los campos a mano.";
    console.error(err);
  }
});

document.getElementById("metaForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert(metaAlertBox);
  const btn = document.getElementById("metaGuardarBtn");
  btn.disabled = true;
  try {
    const datos = {
      titulo: document.getElementById("metaTitulo").value.trim(),
      cliente: document.getElementById("metaCliente").value.trim(),
      identificacionCliente: document.getElementById("metaIdentificacion").value.trim(),
      proyecto: document.getElementById("metaProyecto").value.trim(),
      version: document.getElementById("metaVersion").value.trim() || "1.0",
      aprobador: document.getElementById("metaAprobador").value.trim(),
      ciudad: document.getElementById("metaCiudad").value.trim() || "Neiva"
    };

    if (modoMeta === "crear") {
      const codigo = await generarCodigoInforme();
      const ref = await addDoc(collection(db, "informesLibres"), {
        ...datos,
        codigo,
        autorUid: uid,
        autorNombre: perfil.nombre || "Empleado",
        fecha: hoyStr(),
        estado: "borrador",
        bloques: [],
        referencias: REFERENCIAS_POR_DEFECTO.slice(),
        creadoEn: serverTimestamp(),
        actualizadoEn: serverTimestamp()
      });
      modalBackdrop.classList.remove("open");
      abrirEditor({ id: ref.id, ...datos, codigo, autorUid: uid, autorNombre: perfil.nombre, fecha: hoyStr(), estado: "borrador", bloques: [], referencias: REFERENCIAS_POR_DEFECTO.slice() });
    } else {
      await updateDoc(doc(db, "informesLibres", informeActual.id), datos);
      informeActual = { ...informeActual, ...datos };
      modalBackdrop.classList.remove("open");
      renderCabeceraEditor();
    }
  } catch (err) {
    showAlert(metaAlertBox, friendlyError(err), "error");
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------
// Vista: editor de un informe
// ---------------------------------------------------------------------

function puedeEditarInforme() {
  if (!informeActual) return false;
  if (esAdmin) return true;
  return informeActual.autorUid === uid && informeActual.estado === "borrador";
}

function abrirEditor(informe) {
  informeActual = informe;
  bloques = JSON.parse(JSON.stringify(informe.bloques || []));
  referencias = JSON.parse(JSON.stringify(informe.referencias && informe.referencias.length ? informe.referencias : REFERENCIAS_POR_DEFECTO));
  document.getElementById("vistaLista").classList.add("hidden");
  document.getElementById("vistaEditor").classList.remove("hidden");
  renderCabeceraEditor();
  renderBloques();
  renderReferencias();
}

document.getElementById("volverListaBtn").addEventListener("click", () => {
  document.getElementById("vistaEditor").classList.add("hidden");
  document.getElementById("vistaLista").classList.remove("hidden");
  informeActual = null;
  bloques = [];
  referencias = [];
});

function renderCabeceraEditor() {
  document.getElementById("tituloInformeEditor").textContent = informeActual.titulo;
  const identificacionTexto = informeActual.identificacionCliente ? ` (${informeActual.identificacionCliente})` : "";
  document.getElementById("metaInformeEditor").textContent =
    `${informeActual.cliente || "-"}${identificacionTexto} · ${informeActual.proyecto || "-"} · Código: ${informeActual.codigo || "-"} · v${informeActual.version || "1.0"} · ${informeActual.autorNombre || ""}`;

  const badge = document.getElementById("estadoBadge");
  badge.textContent = informeActual.estado === "final" ? "Final" : "Borrador";
  badge.className = `badge ${informeActual.estado === "final" ? "ok" : "warn"}`;

  const editable = puedeEditarInforme();
  document.getElementById("editarMetaBtn").disabled = !editable;
  document.getElementById("guardarBorradorBtn").disabled = !editable;
  document.getElementById("marcarFinalBtn").classList.toggle("hidden", informeActual.estado === "final" || !editable);
}

document.getElementById("editarMetaBtn").addEventListener("click", () => abrirModalMeta("editar", informeActual));

async function guardarBloques(extra = {}) {
  sincronizarBloquesDesdeDOM();
  sincronizarReferenciasDesdeDOM();
  const btn = document.getElementById("guardarBorradorBtn");
  const alertBox = document.getElementById("editorAlertBox");
  clearAlert(alertBox);
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "informesLibres", informeActual.id), {
      bloques,
      referencias,
      actualizadoEn: serverTimestamp(),
      ...extra
    });
    informeActual = { ...informeActual, bloques: JSON.parse(JSON.stringify(bloques)), referencias: JSON.parse(JSON.stringify(referencias)), ...extra };
    renderCabeceraEditor();
    renderBloques();
    renderReferencias();
    showAlert(alertBox, "Guardado.", "success");
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
  } finally {
    btn.disabled = false;
  }
}

// ---- Referencias bibliográficas (siempre presentes, editables) ----

function renderReferencias() {
  contenedorReferencias.innerHTML = referencias
    .map((ref, i) => `
      <div class="checkbox-row">
        <input type="text" class="flex-1" data-referencia="${i}" value="${String(ref || "").replace(/"/g, "&quot;")}">
        <button type="button" class="icon-btn danger" data-quitar-referencia="${i}">🗑️</button>
      </div>
    `)
    .join("");
}

function sincronizarReferenciasDesdeDOM() {
  contenedorReferencias.querySelectorAll("[data-referencia]").forEach((el) => {
    referencias[Number(el.dataset.referencia)] = el.value;
  });
}

document.getElementById("agregarReferenciaBtn").addEventListener("click", () => {
  sincronizarReferenciasDesdeDOM();
  referencias.push("");
  renderReferencias();
});

contenedorReferencias.addEventListener("click", (e) => {
  const i = e.target.dataset.quitarReferencia;
  if (i === undefined) return;
  sincronizarReferenciasDesdeDOM();
  referencias.splice(Number(i), 1);
  renderReferencias();
});

document.getElementById("guardarBorradorBtn").addEventListener("click", () => guardarBloques());
document.getElementById("marcarFinalBtn").addEventListener("click", () => {
  if (!confirm("Una vez marcado como FINAL, ya no podrás editarlo ni borrarlo (solo un administrador podrá hacerlo). ¿Continuar?")) return;
  guardarBloques({ estado: "final" });
});

// ---- Bloques: sincronizar valores desde el DOM antes de mutar/guardar ----

function sincronizarBloquesDesdeDOM() {
  bloques.forEach((b, i) => {
    const wrapper = document.querySelector(`[data-bloque="${i}"]`);
    if (!wrapper) return;
    const campo = (nombre) => wrapper.querySelector(`[data-campo="${nombre}"]`);

    if (b.tipo.startsWith("titulo") || b.tipo === "parrafo") {
      const el = campo("texto");
      if (el) b.texto = el.value;
    } else if (b.tipo === "imagen" || b.tipo === "imagenPendiente" || (b.tipo === "tabla" && b.archivo)) {
      // Imagen, imagen pendiente de subir, o tabla cargada como imagen
      // (botón "+ Tabla") — mismos campos.
      const pieEl = campo("pie");
      if (pieEl) b.pie = pieEl.value;
      const tituloEl = campo("tituloImagen");
      if (tituloEl) b.titulo = tituloEl.value;
    } else if (b.tipo === "tabla") {
      // Tabla con datos estructurados (importada de Word, o creada antes de este cambio).
      const tituloEl = campo("tituloTabla");
      if (tituloEl) b.titulo = tituloEl.value;
      const pieEl = campo("pieTabla");
      if (pieEl) b.pie = pieEl.value;
      wrapper.querySelectorAll('[data-campo="columna"]').forEach((el) => { b.columnas[Number(el.dataset.col)] = el.value; });
      wrapper.querySelectorAll('[data-campo="celda"]').forEach((el) => { b.filas[Number(el.dataset.fila)][Number(el.dataset.col)] = el.value; });
    } else if (b.tipo === "grafico") {
      const tituloEl = campo("tituloGrafico");
      if (tituloEl) b.titulo = tituloEl.value;
      const tipoEl = campo("tipoGrafico");
      if (tipoEl) b.tipoGrafico = tipoEl.value;
      wrapper.querySelectorAll('[data-campo="etiqueta"]').forEach((el) => { b.etiquetas[Number(el.dataset.fila)] = el.value; });
      wrapper.querySelectorAll('[data-campo="valor"]').forEach((el) => { b.valores[Number(el.dataset.fila)] = Number(el.value) || 0; });
    }
  });
}

// ---- Agregar bloques ----

function hayTitulo1() { return bloques.some((b) => b.tipo === "titulo1"); }
function hayTitulo2() { return bloques.some((b) => b.tipo === "titulo2"); }

function actualizarEstadoBotonesNumeracion() {
  const editable = puedeEditarInforme();
  document.querySelector('[data-agregar="titulo1"]').disabled = !editable;
  document.querySelector('[data-agregar="titulo2"]').disabled = !editable || !hayTitulo1();
  document.querySelector('[data-agregar="titulo3"]').disabled = !editable || !hayTitulo2();
  document.querySelector('[data-agregar="parrafo"]').disabled = !editable;
  document.querySelector('[data-agregar="imagen"]').disabled = !editable;
  document.querySelector('[data-agregar="tabla"]').disabled = !editable;
  document.querySelector('[data-agregar="grafico"]').disabled = !editable;
}

document.querySelectorAll("[data-agregar]").forEach((btn) => {
  btn.addEventListener("click", () => agregarBloque(btn.dataset.agregar));
});

// Al agregar una imagen o una tabla desde los botones, ambas se cargan
// como imagen (una captura/foto de la tabla ya armada en Excel/Word, por
// ejemplo) — más simple que llenar una cuadrícula a mano. Esta variable
// recuerda cuál de los dos botones se usó para saber qué tipo de bloque
// crear cuando el usuario termine de elegir el archivo.
let tipoBloqueASubir = "imagen";

function agregarBloque(tipo) {
  if (!puedeEditarInforme()) return;
  sincronizarBloquesDesdeDOM();
  if (tipo === "imagen" || tipo === "tabla") {
    tipoBloqueASubir = tipo;
    document.getElementById("inputImagen").click();
    return;
  }
  if (tipo === "grafico") {
    bloques.push({ tipo: "grafico", tipoGrafico: "barras", titulo: "", etiquetas: ["Dato 1"], valores: [0] });
  } else {
    bloques.push({ tipo, texto: "" });
  }
  renderBloques();
}

document.getElementById("inputImagen").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !informeActual) return;
  const alertBox = document.getElementById("editorAlertBox");
  clearAlert(alertBox);
  const errorTipo = validarTipoImagen(file);
  if (errorTipo) { showAlert(alertBox, errorTipo, "error"); return; }
  try {
    const blob = await comprimirImagen(file);
    const base64 = await leerBlobComoBase64(blob);
    const llamada = httpsCallable(functions, "subirImagenInforme");
    const { data } = await llamada({ informeId: informeActual.id, archivoBase64: base64, tipo: "image/jpeg" });
    imagenesCache[data.path] = `data:image/jpeg;base64,${base64}`;
    bloques.push({ tipo: tipoBloqueASubir, archivo: { nombre: file.name, path: data.path, tipo: "image/jpeg", tamano: blob.size }, titulo: "", pie: "" });
    renderBloques();
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
  }
});

// ---------------------------------------------------------------------
// Importar documento Word (.docx) -> bloques editables (mammoth.js).
// Los títulos "Heading 1/2/3" de Word se mapean a título1/2/3, los
// párrafos y listas a bloques de párrafo, las tablas a bloques de tabla,
// y las imágenes se suben (comprimidas) igual que si se agregaran a mano.
// Un gráfico nativo de Word (no una simple foto pegada) entra como
// imagen, no como dato editable — ver aviso en la propia página.
// ---------------------------------------------------------------------

// Detecta líneas tipo "Imagen 6. Gráfica del comportamiento..." o
// "Tabla 2: Resumen..." (título/caption, normalmente ANTES de la imagen o
// tabla) y "Fuente: ..."/"Nota: ..." (nota al pie, normalmente DESPUÉS) —
// el número que ya traía el Word se descarta porque el PDF pone el suyo
// propio (Figura N./Tabla N. autonumerado), solo se conserva el texto
// descriptivo.
const PATRON_CAPTION = /^(imagen|figura|tabla)\s*\.?\s*\d*\.?\s*[:.]?\s*(.+)$/i;
const PATRON_FUENTE = /^(fuente|nota)\s*[:.]\s*(.+)$/i;

function extraerCaption(texto) {
  const m = (texto || "").trim().match(PATRON_CAPTION);
  return m ? m[2].trim() : "";
}

function extraerFuente(texto) {
  const m = (texto || "").trim().match(PATRON_FUENTE);
  return m ? m[2].trim() : "";
}

async function subirImagenImportada(base64, contentType) {
  const blobOriginal = base64ABlob(base64, contentType);
  const blobComprimido = await comprimirImagen(blobOriginal);
  const base64Comprimido = await leerBlobComoBase64(blobComprimido);
  const llamada = httpsCallable(functions, "subirImagenInforme");
  const { data } = await llamada({ informeId: informeActual.id, archivoBase64: base64Comprimido, tipo: "image/jpeg" });
  imagenesCache[data.path] = `data:image/jpeg;base64,${base64Comprimido}`;
  return { tipo: "imagen", archivo: { nombre: "imagen-importada.jpg", path: data.path, tipo: "image/jpeg", tamano: blobComprimido.size }, titulo: "", pie: "" };
}

// ---------------------------------------------------------------------
// Preparar el .docx ANTES de pasárselo a mammoth (dos arreglos sobre el
// XML crudo, ver detalle de cada uno más abajo):
// 1. Reparar encabezados "disfrazados" — verificado contra un informe
//    real de Cinco S.A.S.: cuando un título de Word no usa el estilo con
//    nombre "Título 1/2/3" sino que se arma con la numeración automática
//    de la cinta (viñeta/numeración + "Nivel de esquema" en Párrafo >
//    Numeración), mammoth no lo reconoce como encabezado — lo convierte
//    en una lista (<ul>/<ol><li>) sin importar qué otro estilo tenga el
//    párrafo, y termina como un párrafo suelto con un "•" delante en vez
//    de un bloque de Título numerado. La señal confiable de que un
//    párrafo así SÍ es un título (y no una lista real) es que Word le
//    puso <w:outlineLvl> (nivel de esquema, lo que alimenta la
//    navegación y la Tabla de Contenido nativa de Word) — un párrafo de
//    una lista común nunca tiene esa marca. El nivel de la lista
//    (<w:ilvl>) indica a qué nivel de título corresponde (0→Título 1,
//    1→Título 2, 2 o más→Título 3).
// 2. Marcar gráficos nativos/objetos OLE no importables (ver
//    marcarObjetosNoImportables más abajo).
// ---------------------------------------------------------------------

const NIVEL_A_ESTILO_TITULO = { 1: "Ttulo1", 2: "Ttulo2", 3: "TituloAutoDetectado3" };

// Gráficos nativos de Excel/Word (no una foto pegada) y objetos OLE
// incrustados (ej. una hoja de Excel insertada como objeto) no tienen
// forma confiable de extraerse como imagen — mammoth simplemente los
// descarta en silencio, sin dejar ningún rastro en el HTML resultante, así
// que el usuario ni se entera de que faltó contenido. En vez de intentarlo
// y arriesgar una imagen rota o con texto superpuesto (el mismo problema ya
// visto con cuadros de texto flotantes), se detecta su presencia en el XML
// ANTES de convertir y se deja un marcador de texto en su lugar — el bucle
// de importación lo reconoce y agrega un bloque de "imagen pendiente" con
// un botón para que el usuario suba la captura real.
const MARCADOR_OBJETO_NO_IMPORTADO = "CINCO_OBJETO_NO_IMPORTADO_MARCADOR";

function marcarObjetosNoImportables(docXml) {
  return docXml.replace(/<w:p [^>]*>[\s\S]*?<\/w:p>/g, (parrafo) => {
    const tieneDibujo = /<w:drawing>/.test(parrafo);
    const esImagenNormal = /2006\/picture"/.test(parrafo);
    // Un objeto OLE incrustado (ej. una hoja de Excel insertada con
    // "Insertar objeto") casi siempre trae una imagen de vista previa en
    // formato VML (<v:imagedata>) — mammoth SÍ sabe extraer esa imagen de
    // vista previa como una imagen normal, así que solo hace falta el
    // marcador cuando el objeto NO trae esa vista previa (si no, se
    // duplicaría la misma imagen: una vez bien importada + un marcador de
    // "pendiente" innecesario).
    const esObjetoOleSinVistaPrevia = /<w:object>/.test(parrafo) && !/<v:imagedata/.test(parrafo);
    if (!((tieneDibujo && !esImagenNormal) || esObjetoOleSinVistaPrevia)) return parrafo;
    return `${parrafo}<w:p><w:r><w:t>${MARCADOR_OBJETO_NO_IMPORTADO}</w:t></w:r></w:p>`;
  });
}

function nivelTituloDesdeIlvl(ilvl) {
  if (ilvl === 0) return 1;
  if (ilvl === 1) return 2;
  return 3;
}

async function prepararDocxAntesDeImportar(buffer) {
  const zip = await window.JSZip.loadAsync(buffer);
  const docXmlPath = "word/document.xml";
  const stylesXmlPath = "word/styles.xml";
  const docXmlFile = zip.file(docXmlPath);
  const stylesXmlFile = zip.file(stylesXmlPath);
  if (!docXmlFile || !stylesXmlFile) return buffer; // no es un .docx con la estructura esperada

  let docXml = await docXmlFile.async("string");
  let stylesXml = await stylesXmlFile.async("string");

  // El documento puede no traer un estilo con nombre "heading 3" real (los
  // niveles 1 y 2 casi siempre existen aunque no se usen, por venir en la
  // plantilla base de Word) — si falta, se agrega uno mínimo.
  if (!/w:styleId="TituloAutoDetectado3"/.test(stylesXml)) {
    const nuevoEstilo = '<w:style w:type="paragraph" w:styleId="TituloAutoDetectado3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/></w:style>';
    stylesXml = stylesXml.replace("</w:styles>", `${nuevoEstilo}</w:styles>`);
  }

  docXml = docXml.replace(/<w:p [^>]*>[\s\S]*?<\/w:p>/g, (parrafo) => {
    if (!/<w:numPr>/.test(parrafo)) return parrafo;
    if (!/<w:outlineLvl w:val="\d+"/.test(parrafo)) return parrafo;
    const ilvlMatch = parrafo.match(/<w:ilvl w:val="(\d+)"/);
    const nivel = nivelTituloDesdeIlvl(ilvlMatch ? Number(ilvlMatch[1]) : 0);
    const styleId = NIVEL_A_ESTILO_TITULO[nivel];
    // Se quita la numeración manual de Word (el motor de PDF de Cinco
    // Conecta ya pone su propia numeración "1."/"1.1" al generar el
    // informe) — si no, mammoth sigue envolviendo el párrafo en una lista
    // sin importar el estilo. El estilo que tuviera antes (normalmente
    // "Párrafo de lista", que Word asigna solo por tener viñeta/numeración
    // y no aporta semántica de título) se reemplaza por el de encabezado.
    const sinNumPr = parrafo.replace(/<w:numPr>[\s\S]*?<\/w:numPr>/, "");
    if (/<w:pStyle [^/]*\/>/.test(sinNumPr)) {
      return sinNumPr.replace(/<w:pStyle [^/]*\/>/, `<w:pStyle w:val="${styleId}"/>`);
    }
    return sinNumPr.replace("<w:pPr>", `<w:pPr><w:pStyle w:val="${styleId}"/>`);
  });

  docXml = marcarObjetosNoImportables(docXml);

  zip.file(docXmlPath, docXml);
  zip.file(stylesXmlPath, stylesXml);
  return zip.generateAsync({ type: "arraybuffer" });
}

/**
 * A diferencia de un simple recorrido nodo-por-nodo, aquí se necesita
 * "mirar" el párrafo anterior y siguiente a una imagen/tabla para
 * encontrar su título y su fuente — por eso recibe el arreglo completo de
 * nodos + el índice actual, en vez de un solo nodo. Cuando el párrafo
 * ANTERIOR resulta ser el título, se saca (pop) del arreglo de bloques ya
 * armado (ahí quedó como un párrafo suelto en la vuelta anterior); el
 * párrafo SIGUIENTE que resulta ser la fuente se marca en `saltar` para
 * que la vuelta futura no lo vuelva a agregar como párrafo aparte.
 */
async function importarDocx(file) {
  let buffer = await file.arrayBuffer();
  try {
    buffer = await prepararDocxAntesDeImportar(buffer);
  } catch (err) {
    // Si la reparación falla por cualquier motivo, se sigue con el
    // documento tal cual — mejor un encabezado sin numerar que un import
    // roto por completo.
    console.error("No se pudieron reparar encabezados disfrazados de lista:", err);
  }
  const imagenesCapturadas = [];
  const opciones = {
    convertImage: window.mammoth.images.imgElement((image) =>
      image.read("base64").then((base64) => {
        const indice = imagenesCapturadas.length;
        imagenesCapturadas.push({ base64, contentType: image.contentType });
        return { src: `PLACEHOLDER_IMG:${indice}` };
      })
    )
  };
  const resultado = await window.mammoth.convertToHtml({ arrayBuffer: buffer }, opciones);
  const dom = new DOMParser().parseFromString(resultado.value, "text/html");
  const nodos = [...dom.body.children];

  const nuevosBloques = [];
  const saltar = new Set();

  function quitarCaptionAnterior(idx) {
    const anterior = (nodos[idx - 1]?.textContent || "").trim();
    const caption = extraerCaption(anterior);
    if (!caption) return "";
    const ultimo = nuevosBloques[nuevosBloques.length - 1];
    if (ultimo && ultimo.tipo === "parrafo" && ultimo.texto === anterior) nuevosBloques.pop();
    return caption;
  }

  function marcarFuenteSiguiente(idx) {
    const siguiente = (nodos[idx + 1]?.textContent || "").trim();
    const fuente = extraerFuente(siguiente);
    if (fuente) saltar.add(idx + 1);
    return fuente;
  }

  for (let idx = 0; idx < nodos.length; idx++) {
    if (saltar.has(idx)) continue;
    const nodo = nodos[idx];
    const tag = nodo.tagName.toLowerCase();

    if (tag === "h1") { nuevosBloques.push({ tipo: "titulo1", texto: nodo.textContent.trim() }); continue; }
    if (tag === "h2") { nuevosBloques.push({ tipo: "titulo2", texto: nodo.textContent.trim() }); continue; }
    if (/^h[3-6]$/.test(tag)) { nuevosBloques.push({ tipo: "titulo3", texto: nodo.textContent.trim() }); continue; }

    if (nodo.textContent.trim() === MARCADOR_OBJETO_NO_IMPORTADO) {
      const tituloDetectado = quitarCaptionAnterior(idx);
      const pieDetectado = marcarFuenteSiguiente(idx);
      nuevosBloques.push({ tipo: "imagenPendiente", titulo: tituloDetectado, pie: pieDetectado });
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      const texto = [...nodo.querySelectorAll("li")].map((li) => `• ${li.textContent.trim()}`).join("\n");
      if (texto) nuevosBloques.push({ tipo: "parrafo", texto });
      continue;
    }

    if (tag === "table") {
      const filasNodo = [...nodo.querySelectorAll("tr")];
      if (filasNodo.length === 0) continue;
      const columnas = [...filasNodo[0].children].map((c) => c.textContent.trim() || "Columna");
      const filas = filasNodo.slice(1).map((fila) => [...fila.children].map((c) => c.textContent.trim()));
      const tituloTabla = quitarCaptionAnterior(idx);
      const pieTabla = marcarFuenteSiguiente(idx);
      nuevosBloques.push({ tipo: "tabla", titulo: tituloTabla, pie: pieTabla, columnas, filas: filas.length ? filas : [columnas.map(() => "")] });
      continue;
    }

    // Párrafos (y cualquier otra etiqueta suelta): puede traer una imagen
    // incrustada. Cualquier texto que NO sea la imagen misma (elementos
    // superpuestos como cuadros de texto flotantes de Word encima/debajo
    // de la foto) se ignora a propósito — solo se usa el texto del propio
    // párrafo que contiene la imagen si además trae contenido normal.
    const imgEnNodo = tag === "img" ? nodo : nodo.querySelector?.("img");
    if (imgEnNodo) {
      const m = (imgEnNodo.getAttribute("src") || "").match(/PLACEHOLDER_IMG:(\d+)/);
      const capturada = m && imagenesCapturadas[Number(m[1])];
      if (capturada) {
        const tituloImagen = quitarCaptionAnterior(idx);
        const pieImagen = marcarFuenteSiguiente(idx);
        try {
          const bloqueImg = await subirImagenImportada(capturada.base64, capturada.contentType);
          bloqueImg.titulo = tituloImagen;
          bloqueImg.pie = pieImagen;
          nuevosBloques.push(bloqueImg);
        } catch (err) {
          console.error("No se pudo importar una imagen del documento:", err);
        }
      }
      continue;
    }

    const texto = nodo.textContent.trim();
    if (texto) nuevosBloques.push({ tipo: "parrafo", texto });
  }

  return nuevosBloques;
}

document.getElementById("importarWordBtn").addEventListener("click", () => document.getElementById("inputWord").click());

document.getElementById("inputWord").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !informeActual) return;
  const estadoEl = document.getElementById("importarWordEstado");
  estadoEl.textContent = "Leyendo el documento...";
  try {
    sincronizarBloquesDesdeDOM();
    const nuevosBloques = await importarDocx(file);
    if (nuevosBloques.length === 0) {
      estadoEl.textContent = "No se encontró contenido reconocible en el documento.";
      return;
    }
    bloques.push(...nuevosBloques);
    renderBloques();
    estadoEl.textContent = `Se agregaron ${nuevosBloques.length} bloques al final del informe. Revísalos antes de guardar.`;
  } catch (err) {
    estadoEl.textContent = "No se pudo importar el documento.";
    console.error(err);
  }
});

// ---- Acciones sobre bloques existentes (mover/borrar/agregar fila-col-dato) ----

contenedorBloques.addEventListener("click", (e) => {
  const accion = e.target.dataset.accion;
  if (!accion) return;
  const i = Number(e.target.dataset.indice);
  if (Number.isNaN(i) || !bloques[i]) return;

  if (accion === "cambiarImagen") {
    indiceImagenAReemplazar = i;
    document.getElementById("inputImagenReemplazo").click();
    return;
  }

  sincronizarBloquesDesdeDOM();

  if (accion === "borrar") {
    bloques.splice(i, 1);
  } else if (accion === "subir" && i > 0) {
    [bloques[i - 1], bloques[i]] = [bloques[i], bloques[i - 1]];
  } else if (accion === "bajar" && i < bloques.length - 1) {
    [bloques[i + 1], bloques[i]] = [bloques[i], bloques[i + 1]];
  } else if (accion === "agregarFila") {
    bloques[i].filas.push(bloques[i].columnas.map(() => ""));
  } else if (accion === "agregarColumna") {
    bloques[i].columnas.push(`Columna ${bloques[i].columnas.length + 1}`);
    bloques[i].filas.forEach((fila) => fila.push(""));
  } else if (accion === "quitarFila") {
    const fi = Number(e.target.dataset.filaQuitar);
    if (bloques[i].filas.length > 1) bloques[i].filas.splice(fi, 1);
  } else if (accion === "quitarColumna") {
    const ci = Number(e.target.dataset.colQuitar);
    if (bloques[i].columnas.length > 1) {
      bloques[i].columnas.splice(ci, 1);
      bloques[i].filas.forEach((fila) => fila.splice(ci, 1));
    }
  } else if (accion === "agregarDato") {
    bloques[i].etiquetas.push(`Dato ${bloques[i].etiquetas.length + 1}`);
    bloques[i].valores.push(0);
  } else if (accion === "quitarDato") {
    const di = Number(e.target.dataset.datoQuitar);
    if (bloques[i].etiquetas.length > 1) {
      bloques[i].etiquetas.splice(di, 1);
      bloques[i].valores.splice(di, 1);
    }
  }
  renderBloques();
});

// ---- Cambiar imagen de un bloque existente ----

let indiceImagenAReemplazar = null;

document.getElementById("inputImagenReemplazo").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  const i = indiceImagenAReemplazar;
  indiceImagenAReemplazar = null;
  if (!file || i === null || !bloques[i] || !informeActual) return;
  sincronizarBloquesDesdeDOM();
  const alertBox = document.getElementById("editorAlertBox");
  clearAlert(alertBox);
  const errorTipo = validarTipoImagen(file);
  if (errorTipo) { showAlert(alertBox, errorTipo, "error"); return; }
  try {
    const blob = await comprimirImagen(file);
    const base64 = await leerBlobComoBase64(blob);
    const llamada = httpsCallable(functions, "subirImagenInforme");
    const { data } = await llamada({ informeId: informeActual.id, archivoBase64: base64, tipo: "image/jpeg" });
    imagenesCache[data.path] = `data:image/jpeg;base64,${base64}`;
    bloques[i].archivo = { nombre: file.name, path: data.path, tipo: "image/jpeg", tamano: blob.size };
    if (bloques[i].tipo === "imagenPendiente") bloques[i].tipo = "imagen";
    renderBloques();
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
  }
});

// Vista previa en vivo del gráfico (SVG) al escribir sus datos, sin volver
// a dibujar todo el editor (evitaría perder el foco de otros campos).
function manejarInputBloques(e) {
  const wrapper = e.target.closest("[data-bloque]");
  if (!wrapper) return;
  const i = Number(wrapper.dataset.bloque);
  if (bloques[i]?.tipo === "grafico") actualizarPreviewGrafico(i);
}
contenedorBloques.addEventListener("input", manejarInputBloques);
contenedorBloques.addEventListener("change", manejarInputBloques);

function actualizarPreviewGrafico(i) {
  const wrapper = document.querySelector(`[data-bloque="${i}"]`);
  const previewEl = wrapper?.querySelector("[data-preview-grafico]");
  if (!wrapper || !previewEl) return;
  const tipo = wrapper.querySelector('[data-campo="tipoGrafico"]').value;
  const etiquetas = [...wrapper.querySelectorAll('[data-campo="etiqueta"]')].map((el) => el.value);
  const valores = [...wrapper.querySelectorAll('[data-campo="valor"]')].map((el) => Number(el.value) || 0);
  previewEl.innerHTML = generarSvgGrafico(tipo, etiquetas, valores);
}

async function cargarImagenEnCache(path, i) {
  imagenesCargando.add(path);
  try {
    const dataUrl = await obtenerArchivoComoDataUrl(path);
    imagenesCache[path] = dataUrl;
    if (informeActual && bloques[i]?.archivo?.path === path) renderBloques();
  } catch (err) {
    console.error("No se pudo cargar la imagen:", err);
  } finally {
    imagenesCargando.delete(path);
  }
}

// ---- Render de cada bloque ----

function renderBloque(bloque, i, numero) {
  const editable = puedeEditarInforme();
  const dis = editable ? "" : "disabled";
  const controles = `
    <div class="toolbar mt-4">
      ${i > 0 ? `<button type="button" class="icon-btn" data-accion="subir" data-indice="${i}" ${dis}>↑ Subir</button>` : ""}
      ${i < bloques.length - 1 ? `<button type="button" class="icon-btn" data-accion="bajar" data-indice="${i}" ${dis}>↓ Bajar</button>` : ""}
      <button type="button" class="icon-btn danger" data-accion="borrar" data-indice="${i}" ${dis}>🗑️ Eliminar bloque</button>
    </div>
  `;

  if (bloque.tipo.startsWith("titulo")) {
    const nivel = bloque.tipo.slice(-1);
    return `
      <div class="card item-card bloque-card" data-bloque="${i}">
        <label><span class="bloque-numero">${numero}.</span>Título nivel ${nivel}</label>
        <input type="text" data-campo="texto" value="${(bloque.texto || "").replace(/"/g, "&quot;")}" ${dis}>
        ${controles}
      </div>
    `;
  }

  if (bloque.tipo === "parrafo") {
    return `
      <div class="card item-card bloque-card" data-bloque="${i}">
        <label>Párrafo</label>
        <textarea rows="4" data-campo="texto" ${dis}>${bloque.texto || ""}</textarea>
        ${controles}
      </div>
    `;
  }

  if (bloque.tipo === "imagenPendiente") {
    return `
      <div class="card item-card bloque-card bloque-pendiente" data-bloque="${i}">
        <p class="text-sm">⚠️ Aquí había un gráfico o un objeto insertado en el Word original que no se pudo importar automáticamente (los gráficos nativos de Excel/Word y los objetos incrustados no se pueden convertir a imagen de forma confiable). Sube la captura real de la gráfica o tabla.</p>
        <label>Título (va arriba, como "Figura N. Título")</label>
        <input type="text" data-campo="tituloImagen" value="${(bloque.titulo || "").replace(/"/g, "&quot;")}" ${dis}>
        <div class="toolbar mt-4">
          <button type="button" class="btn btn-auto" data-accion="cambiarImagen" data-indice="${i}" ${dis}>📊 Subir imagen</button>
        </div>
        <label>Nota / fuente (va debajo, ej. "Fuente: Elaboración propia")</label>
        <input type="text" data-campo="pie" value="${(bloque.pie || "").replace(/"/g, "&quot;")}" ${dis}>
        ${controles}
      </div>
    `;
  }

  if (bloque.tipo === "imagen") {
    const path = bloque.archivo?.path;
    let previewHtml;
    if (path && imagenesCache[path]) {
      previewHtml = `<img class="preview-img" src="${imagenesCache[path]}" alt="">`;
    } else {
      previewHtml = '<p class="text-muted text-sm">Cargando imagen...</p>';
      if (path && !imagenesCargando.has(path)) cargarImagenEnCache(path, i);
    }
    return `
      <div class="card item-card bloque-card" data-bloque="${i}">
        <label>Título de la imagen (va arriba, como "Figura N. Título")</label>
        <input type="text" data-campo="tituloImagen" value="${(bloque.titulo || "").replace(/"/g, "&quot;")}" ${dis}>
        ${previewHtml}
        <div class="toolbar mt-4">
          <button type="button" class="btn secondary btn-auto" data-accion="cambiarImagen" data-indice="${i}" ${dis}>🔄 Cambiar imagen</button>
        </div>
        <label>Nota / fuente (va debajo, ej. "Fuente: Elaboración propia")</label>
        <input type="text" data-campo="pie" value="${(bloque.pie || "").replace(/"/g, "&quot;")}" ${dis}>
        ${controles}
      </div>
    `;
  }

  if (bloque.tipo === "tabla" && bloque.archivo) {
    // Tabla cargada como imagen (botón "+ Tabla") — misma interfaz que un
    // bloque de imagen, solo cambia la etiqueta y el contador en el PDF
    // (Tabla N. en vez de Figura N.).
    const path = bloque.archivo?.path;
    let previewHtmlTabla;
    if (path && imagenesCache[path]) {
      previewHtmlTabla = `<img class="preview-img" src="${imagenesCache[path]}" alt="">`;
    } else {
      previewHtmlTabla = '<p class="text-muted text-sm">Cargando imagen...</p>';
      if (path && !imagenesCargando.has(path)) cargarImagenEnCache(path, i);
    }
    return `
      <div class="card item-card bloque-card" data-bloque="${i}">
        <label>Título de la tabla (va arriba, como "Tabla N. Título")</label>
        <input type="text" data-campo="tituloImagen" value="${(bloque.titulo || "").replace(/"/g, "&quot;")}" ${dis}>
        ${previewHtmlTabla}
        <div class="toolbar mt-4">
          <button type="button" class="btn secondary btn-auto" data-accion="cambiarImagen" data-indice="${i}" ${dis}>🔄 Cambiar imagen</button>
        </div>
        <label>Nota / fuente (va debajo, ej. "Fuente: Elaboración propia")</label>
        <input type="text" data-campo="pie" value="${(bloque.pie || "").replace(/"/g, "&quot;")}" ${dis}>
        ${controles}
      </div>
    `;
  }

  if (bloque.tipo === "tabla") {
    const encabezadosHtml = bloque.columnas.map((col, ci) => `
      <th>
        <input type="text" data-campo="columna" data-col="${ci}" value="${String(col || "").replace(/"/g, "&quot;")}" ${dis}>
        ${bloque.columnas.length > 1 ? `<button type="button" class="icon-btn danger text-xs" data-accion="quitarColumna" data-indice="${i}" data-col-quitar="${ci}" ${dis}>🗑️</button>` : ""}
      </th>
    `).join("");
    const filasHtml = bloque.filas.map((fila, fi) => `
      <tr>
        ${fila.map((celda, ci) => `<td><input type="text" data-campo="celda" data-fila="${fi}" data-col="${ci}" value="${String(celda || "").replace(/"/g, "&quot;")}" ${dis}></td>`).join("")}
        <td>${bloque.filas.length > 1 ? `<button type="button" class="icon-btn danger text-xs" data-accion="quitarFila" data-indice="${i}" data-fila-quitar="${fi}" ${dis}>🗑️</button>` : ""}</td>
      </tr>
    `).join("");
    return `
      <div class="card item-card bloque-card" data-bloque="${i}">
        <label>Título de la tabla</label>
        <input type="text" data-campo="tituloTabla" value="${(bloque.titulo || "").replace(/"/g, "&quot;")}" ${dis}>
        <table class="tabla-editor">
          <thead><tr>${encabezadosHtml}<th></th></tr></thead>
          <tbody>${filasHtml}</tbody>
        </table>
        <div class="toolbar mt-4">
          <button type="button" class="btn secondary btn-auto" data-accion="agregarFila" data-indice="${i}" ${dis}>+ Fila</button>
          <button type="button" class="btn secondary btn-auto" data-accion="agregarColumna" data-indice="${i}" ${dis}>+ Columna</button>
          <button type="button" class="btn secondary btn-auto" data-accion="cambiarImagen" data-indice="${i}" ${dis}>🖼️ Convertir a imagen (subir captura)</button>
        </div>
        <label>Nota / fuente (va debajo, ej. "Fuente: Elaboración propia")</label>
        <input type="text" data-campo="pieTabla" value="${(bloque.pie || "").replace(/"/g, "&quot;")}" ${dis}>
        ${controles}
      </div>
    `;
  }

  if (bloque.tipo === "grafico") {
    const filasHtml = bloque.etiquetas.map((et, fi) => `
      <tr>
        <td><input type="text" data-campo="etiqueta" data-fila="${fi}" value="${String(et || "").replace(/"/g, "&quot;")}" ${dis}></td>
        <td><input type="number" data-campo="valor" data-fila="${fi}" value="${bloque.valores[fi] ?? 0}" ${dis}></td>
        <td>${bloque.etiquetas.length > 1 ? `<button type="button" class="icon-btn danger text-xs" data-accion="quitarDato" data-indice="${i}" data-dato-quitar="${fi}" ${dis}>🗑️</button>` : ""}</td>
      </tr>
    `).join("");
    return `
      <div class="card item-card bloque-card" data-bloque="${i}">
        <label>Tipo de gráfico</label>
        <select data-campo="tipoGrafico" ${dis}>
          <option value="barras" ${bloque.tipoGrafico === "barras" ? "selected" : ""}>Barras</option>
          <option value="lineas" ${bloque.tipoGrafico === "lineas" ? "selected" : ""}>Líneas</option>
          <option value="pastel" ${bloque.tipoGrafico === "pastel" ? "selected" : ""}>Pastel</option>
        </select>
        <label>Título del gráfico</label>
        <input type="text" data-campo="tituloGrafico" value="${(bloque.titulo || "").replace(/"/g, "&quot;")}" ${dis}>
        <table class="grafico-filas">
          <thead><tr><th>Etiqueta</th><th>Valor</th><th></th></tr></thead>
          <tbody>${filasHtml}</tbody>
        </table>
        <div class="toolbar mt-4">
          <button type="button" class="btn secondary btn-auto" data-accion="agregarDato" data-indice="${i}" ${dis}>+ Dato</button>
        </div>
        <div data-preview-grafico class="svg-grafico">${generarSvgGrafico(bloque.tipoGrafico, bloque.etiquetas, bloque.valores)}</div>
        ${controles}
      </div>
    `;
  }

  return "";
}

function renderBloques() {
  const numeros = calcularNumeracionBloques(bloques);
  contenedorBloques.innerHTML = bloques.length
    ? bloques.map((b, i) => renderBloque(b, i, numeros[i])).join("")
    : '<p class="text-muted text-center">Este informe todavía no tiene contenido. Usa los botones de abajo para agregar el primer bloque.</p>';
  actualizarEstadoBotonesNumeracion();
}

// ---------------------------------------------------------------------
// Generar PDF (100% en el navegador, reutilizando pdf.js)
// ---------------------------------------------------------------------

document.getElementById("generarPdfBtn").addEventListener("click", async () => {
  sincronizarBloquesDesdeDOM();
  sincronizarReferenciasDesdeDOM();
  const btn = document.getElementById("generarPdfBtn");
  const alertBox = document.getElementById("editorAlertBox");
  clearAlert(alertBox);
  const pendientes = bloques.filter((b) => b.tipo === "imagenPendiente").length;
  if (pendientes > 0) {
    showAlert(alertBox, `Este informe todavía tiene ${pendientes} imagen(es) pendiente(s) por subir (los gráficos/objetos que no se pudieron importar automáticamente del Word). Súbelas o elimina esos bloques antes de generar el PDF.`, "error");
    return;
  }
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Generando...";
  try {
    const logoImg = await cargarImagenElemento("assets/img/logo.png").catch(() => null);
    const docPdf = crearDocumentoPDF("portrait");
    const margenContenido = agregarPortadaInforme(docPdf, {
      titulo: informeActual.titulo,
      autor: informeActual.autorNombre,
      aprobador: informeActual.aprobador,
      ciudad: informeActual.ciudad,
      fecha: informeActual.fecha,
      codigo: informeActual.codigo,
      version: informeActual.version
    });

    const numeros = calcularNumeracionBloques(bloques);

    // Entradas de Tabla de Contenido / Índices, calculadas solo a partir de
    // los bloques (sin número de página real todavía) — sirven para saber
    // CUÁNTAS páginas reservar para estas secciones antes de dibujar el
    // cuerpo (ver nota en pdf.js sobre por qué no se pueden insertar
    // páginas en la mitad del documento).
    const entradasTitulos = bloques
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.tipo.startsWith("titulo"))
      .map(({ b, i }) => ({ nivel: Number(b.tipo.slice(-1)), numero: numeros[i], texto: b.texto }));

    let contadorFigPrevio = 0;
    let contadorTabPrevio = 0;
    const entradasFiguras = [];
    const entradasTablas = [];
    bloques.forEach((b) => {
      if (b.tipo === "imagen" || b.tipo === "grafico") {
        contadorFigPrevio += 1;
        entradasFiguras.push({ numero: contadorFigPrevio, titulo: b.titulo || "" });
      } else if (b.tipo === "tabla") {
        contadorTabPrevio += 1;
        entradasTablas.push({ numero: contadorTabPrevio, titulo: b.titulo || "" });
      }
    });

    // Un jsPDF recién creado ya arranca con 1 página incluso si no se
    // dibuja nada encima — por eso solo se cuenta cuando SÍ hay entradas,
    // para no reservar una página en blanco de más cuando el informe no
    // tiene títulos, imágenes o tablas.
    const paginasTOC = entradasTitulos.length ? contarPaginasDeListado((doc) => agregarTablaDeContenido(doc, entradasTitulos)) : 0;
    const paginasImg = entradasFiguras.length ? contarPaginasDeListado((doc) => agregarIndiceElementos(doc, "Índice de Imágenes", entradasFiguras, "Imagen")) : 0;
    const paginasTab = entradasTablas.length ? contarPaginasDeListado((doc) => agregarIndiceElementos(doc, "Índice de Tablas", entradasTablas, "Tabla")) : 0;

    // Reservar en blanco las páginas de TOC + índices justo después de la
    // portada; se rellenan al final, cuando ya se conoce en qué página
    // real cayó cada título/figura/tabla.
    // agregarPortadaInforme ya dejó lista una página nueva (la portada es la
    // 1); esa es la primera página reservable. Si hay algo que reservar, se
    // completan las que falten y se agrega UNA página más aparte donde
    // arranca el cuerpo real — si no hay nada que reservar, el cuerpo sigue
    // directo en la página que ya dejó la portada, sin páginas de más.
    const primeraPaginaIndices = docPdf.internal.getNumberOfPages();
    const totalPaginasIndices = paginasTOC + paginasImg + paginasTab;
    if (totalPaginasIndices > 0) {
      for (let p = 1; p < totalPaginasIndices; p++) docPdf.addPage();
      docPdf.addPage();
    }

    let y = margenContenido;
    const contadores = crearContadoresInforme();

    for (let i = 0; i < bloques.length; i++) {
      const b = bloques[i];
      if (b.tipo.startsWith("titulo")) {
        y = agregarBloqueTitulo(docPdf, y, Number(b.tipo.slice(-1)), numeros[i], b.texto, contadores);
      } else if (b.tipo === "parrafo") {
        y = agregarBloqueParrafo(docPdf, y, b.texto);
      } else if (b.tipo === "imagen" || (b.tipo === "tabla" && b.archivo)) {
        let dataUrl = imagenesCache[b.archivo.path];
        if (!dataUrl) {
          dataUrl = await obtenerArchivoComoDataUrl(b.archivo.path);
          imagenesCache[b.archivo.path] = dataUrl;
        }
        y = await agregarBloqueImagen(docPdf, y, dataUrl, b.titulo, b.pie, contadores, b.tipo === "tabla" ? "Tabla" : "Figura");
      } else if (b.tipo === "tabla") {
        y = agregarBloqueTabla(docPdf, y, b.columnas, b.filas, b.titulo, b.pie, contadores);
      } else if (b.tipo === "grafico") {
        const datos = { titulo: b.titulo, etiquetas: b.etiquetas, valores: b.valores };
        if (b.tipoGrafico === "lineas") y = agregarBloqueGraficoLineas(docPdf, y, datos, contadores);
        else if (b.tipoGrafico === "pastel") y = agregarBloqueGraficoPastel(docPdf, y, datos, contadores);
        else y = agregarBloqueGraficoBarras(docPdf, y, datos, contadores);
      }
    }

    agregarSeccionReferencias(docPdf, referencias);

    // Ya se conoce la página real de cada título/figura/tabla (contadores.
    // indice*) — volver a las páginas reservadas y rellenarlas. `nuevaPagina`
    // se reemplaza por doc.setPage() al siguiente hueco ya reservado en vez
    // de doc.addPage(), que agregaría una página nueva al final del
    // documento en lugar de continuar donde toca. Cada sección arranca
    // donde realmente terminó la anterior (no en un número de página
    // precalculado) para que nunca dos secciones queden compartiendo una
    // misma página, incluso si alguna necesitó una página más o menos de
    // las que se habían reservado.
    let paginaDeRelleno = primeraPaginaIndices;
    if (entradasTitulos.length) {
      docPdf.setPage(paginaDeRelleno);
      agregarTablaDeContenido(docPdf, contadores.indiceTitulos, { nuevaPagina: () => docPdf.setPage(++paginaDeRelleno) });
      paginaDeRelleno += 1;
    }
    if (entradasFiguras.length) {
      docPdf.setPage(paginaDeRelleno);
      agregarIndiceElementos(docPdf, "Índice de Imágenes", contadores.indiceFiguras, "Imagen", { nuevaPagina: () => docPdf.setPage(++paginaDeRelleno) });
      paginaDeRelleno += 1;
    }
    if (entradasTablas.length) {
      docPdf.setPage(paginaDeRelleno);
      agregarIndiceElementos(docPdf, "Índice de Tablas", contadores.indiceTablas, "Tabla", { nuevaPagina: () => docPdf.setPage(++paginaDeRelleno) });
    }

    agregarEncabezadoPiePaginaInforme(docPdf, { logoImg, titulo: informeActual.titulo, codigo: informeActual.codigo });
    descargarPDF(docPdf, `informe-${(informeActual.titulo || "informe").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`);
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
});
