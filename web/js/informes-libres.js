import {
  collection, onSnapshot, query, orderBy, addDoc, updateDoc, deleteDoc, doc,
  serverTimestamp, getDocs, where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import {
  db, functions, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert,
  friendlyError, formatDate, hoyStr, obtenerArchivoComoDataUrl
} from "./utils.js";
import {
  crearDocumentoPDF, agregarPortadaInforme, agregarBloqueTitulo, agregarBloqueParrafo,
  agregarBloqueImagen, agregarBloqueTabla, agregarBloqueGraficoBarras, agregarBloqueGraficoLineas,
  agregarBloqueGraficoPastel, agregarPiePagina, descargarPDF, crearContadoresInforme
} from "./pdf.js";

const { user, perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

const uid = user.uid;
const esAdmin = perfil.rol === "admin";

// ---------------------------------------------------------------------
// Imagen: comprimir en el navegador antes de subir (fotos de obra desde
// celular fácilmente pesan varios MB; un informe con muchas fotos sin
// comprimir puede saturar la memoria del navegador al generar el PDF).
// ---------------------------------------------------------------------

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
// Estado
// ---------------------------------------------------------------------

let informes = [];
let informeActual = null;
let bloques = [];
let modoMeta = "crear";
const imagenesCache = {};
const imagenesCargando = new Set();

const tablaInformes = document.getElementById("tablaInformes");
const datalistClientes = document.getElementById("clientesConocidos");
const contenedorBloques = document.getElementById("contenedorBloques");
const modalBackdrop = document.getElementById("modalBackdrop");
const metaAlertBox = document.getElementById("metaAlertBox");

// ---------------------------------------------------------------------
// Vista: lista de informes
// ---------------------------------------------------------------------

function renderListaInformes() {
  if (informes.length === 0) {
    tablaInformes.innerHTML = '<tr><td colspan="6" class="text-muted text-center">Aún no hay informes.</td></tr>';
  } else {
    tablaInformes.innerHTML = informes.map((inf) => {
      const puedeBorrar = esAdmin || (inf.autorUid === uid && inf.estado === "borrador");
      return `
        <tr>
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
  tablaInformes.innerHTML = `<tr><td colspan="6" class="text-muted text-center">${friendlyError(err)}</td></tr>`;
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
  document.getElementById("metaProyecto").value = informe?.proyecto || "";
  document.getElementById("metaCodigo").value = informe?.codigo || "";
  document.getElementById("metaVersion").value = informe?.version || "1.0";
  modalBackdrop.classList.add("open");
}

document.getElementById("nuevoInformeBtn").addEventListener("click", () => abrirModalMeta("crear"));
document.getElementById("metaCancelarBtn").addEventListener("click", () => modalBackdrop.classList.remove("open"));

document.getElementById("metaForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert(metaAlertBox);
  const btn = document.getElementById("metaGuardarBtn");
  btn.disabled = true;
  try {
    const datos = {
      titulo: document.getElementById("metaTitulo").value.trim(),
      cliente: document.getElementById("metaCliente").value.trim(),
      proyecto: document.getElementById("metaProyecto").value.trim(),
      codigo: document.getElementById("metaCodigo").value.trim(),
      version: document.getElementById("metaVersion").value.trim() || "1.0"
    };

    if (datos.codigo) {
      const dupSnap = await getDocs(query(collection(db, "informesLibres"), where("codigo", "==", datos.codigo)));
      const otroConMismoCodigo = dupSnap.docs.some((d) => d.id !== informeActual?.id);
      if (otroConMismoCodigo && !confirm(`Ya existe otro informe con el código "${datos.codigo}". ¿Continuar de todas formas?`)) {
        btn.disabled = false;
        return;
      }
    }

    if (modoMeta === "crear") {
      const ref = await addDoc(collection(db, "informesLibres"), {
        ...datos,
        autorUid: uid,
        autorNombre: perfil.nombre || "Empleado",
        fecha: hoyStr(),
        estado: "borrador",
        bloques: [],
        creadoEn: serverTimestamp(),
        actualizadoEn: serverTimestamp()
      });
      modalBackdrop.classList.remove("open");
      abrirEditor({ id: ref.id, ...datos, autorUid: uid, autorNombre: perfil.nombre, fecha: hoyStr(), estado: "borrador", bloques: [] });
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
  document.getElementById("vistaLista").classList.add("hidden");
  document.getElementById("vistaEditor").classList.remove("hidden");
  renderCabeceraEditor();
  renderBloques();
}

document.getElementById("volverListaBtn").addEventListener("click", () => {
  document.getElementById("vistaEditor").classList.add("hidden");
  document.getElementById("vistaLista").classList.remove("hidden");
  informeActual = null;
  bloques = [];
});

function renderCabeceraEditor() {
  document.getElementById("tituloInformeEditor").textContent = informeActual.titulo;
  document.getElementById("metaInformeEditor").textContent =
    `${informeActual.cliente || "-"} · ${informeActual.proyecto || "-"} · Código: ${informeActual.codigo || "-"} · v${informeActual.version || "1.0"} · ${informeActual.autorNombre || ""}`;

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
  const btn = document.getElementById("guardarBorradorBtn");
  const alertBox = document.getElementById("editorAlertBox");
  clearAlert(alertBox);
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "informesLibres", informeActual.id), {
      bloques,
      actualizadoEn: serverTimestamp(),
      ...extra
    });
    informeActual = { ...informeActual, bloques: JSON.parse(JSON.stringify(bloques)), ...extra };
    renderCabeceraEditor();
    renderBloques();
    showAlert(alertBox, "Guardado.", "success");
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
  } finally {
    btn.disabled = false;
  }
}

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
    } else if (b.tipo === "imagen") {
      const el = campo("pie");
      if (el) b.pie = el.value;
    } else if (b.tipo === "tabla") {
      const tituloEl = campo("tituloTabla");
      if (tituloEl) b.titulo = tituloEl.value;
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

function agregarBloque(tipo) {
  if (!puedeEditarInforme()) return;
  sincronizarBloquesDesdeDOM();
  if (tipo === "imagen") {
    document.getElementById("inputImagen").click();
    return;
  }
  if (tipo === "tabla") {
    bloques.push({ tipo: "tabla", titulo: "", columnas: ["Columna 1", "Columna 2"], filas: [["", ""]] });
  } else if (tipo === "grafico") {
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
  try {
    const blob = await comprimirImagen(file);
    const base64 = await leerBlobComoBase64(blob);
    const llamada = httpsCallable(functions, "subirImagenInforme");
    const { data } = await llamada({ informeId: informeActual.id, archivoBase64: base64, tipo: "image/jpeg" });
    imagenesCache[data.path] = `data:image/jpeg;base64,${base64}`;
    bloques.push({ tipo: "imagen", archivo: { nombre: file.name, path: data.path, tipo: "image/jpeg", tamano: blob.size }, pie: "" });
    renderBloques();
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
  }
});

// ---- Acciones sobre bloques existentes (mover/borrar/agregar fila-col-dato) ----

contenedorBloques.addEventListener("click", (e) => {
  const accion = e.target.dataset.accion;
  if (!accion) return;
  const i = Number(e.target.dataset.indice);
  if (Number.isNaN(i) || !bloques[i]) return;
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
  } else if (accion === "agregarDato") {
    bloques[i].etiquetas.push(`Dato ${bloques[i].etiquetas.length + 1}`);
    bloques[i].valores.push(0);
  }
  renderBloques();
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
        <label>Imagen</label>
        ${previewHtml}
        <label>Pie de foto</label>
        <input type="text" data-campo="pie" value="${(bloque.pie || "").replace(/"/g, "&quot;")}" ${dis}>
        ${controles}
      </div>
    `;
  }

  if (bloque.tipo === "tabla") {
    const encabezadosHtml = bloque.columnas.map((col, ci) => `<th><input type="text" data-campo="columna" data-col="${ci}" value="${String(col || "").replace(/"/g, "&quot;")}" ${dis}></th>`).join("");
    const filasHtml = bloque.filas.map((fila, fi) => `
      <tr>${fila.map((celda, ci) => `<td><input type="text" data-campo="celda" data-fila="${fi}" data-col="${ci}" value="${String(celda || "").replace(/"/g, "&quot;")}" ${dis}></td>`).join("")}</tr>
    `).join("");
    return `
      <div class="card item-card bloque-card" data-bloque="${i}">
        <label>Título de la tabla</label>
        <input type="text" data-campo="tituloTabla" value="${(bloque.titulo || "").replace(/"/g, "&quot;")}" ${dis}>
        <table class="tabla-editor">
          <thead><tr>${encabezadosHtml}</tr></thead>
          <tbody>${filasHtml}</tbody>
        </table>
        <div class="toolbar mt-4">
          <button type="button" class="btn secondary btn-auto" data-accion="agregarFila" data-indice="${i}" ${dis}>+ Fila</button>
          <button type="button" class="btn secondary btn-auto" data-accion="agregarColumna" data-indice="${i}" ${dis}>+ Columna</button>
        </div>
        ${controles}
      </div>
    `;
  }

  if (bloque.tipo === "grafico") {
    const filasHtml = bloque.etiquetas.map((et, fi) => `
      <tr>
        <td><input type="text" data-campo="etiqueta" data-fila="${fi}" value="${String(et || "").replace(/"/g, "&quot;")}" ${dis}></td>
        <td><input type="number" data-campo="valor" data-fila="${fi}" value="${bloque.valores[fi] ?? 0}" ${dis}></td>
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
          <thead><tr><th>Etiqueta</th><th>Valor</th></tr></thead>
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
  const btn = document.getElementById("generarPdfBtn");
  const alertBox = document.getElementById("editorAlertBox");
  clearAlert(alertBox);
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Generando...";
  try {
    const docPdf = crearDocumentoPDF("portrait");
    let y = agregarPortadaInforme(docPdf, {
      titulo: informeActual.titulo,
      cliente: informeActual.cliente,
      proyecto: informeActual.proyecto,
      codigo: informeActual.codigo,
      version: informeActual.version,
      autor: informeActual.autorNombre,
      fecha: informeActual.fecha
    });

    const numeros = calcularNumeracionBloques(bloques);
    const contadores = crearContadoresInforme();

    for (let i = 0; i < bloques.length; i++) {
      const b = bloques[i];
      if (b.tipo.startsWith("titulo")) {
        y = agregarBloqueTitulo(docPdf, y, Number(b.tipo.slice(-1)), numeros[i], b.texto);
      } else if (b.tipo === "parrafo") {
        y = agregarBloqueParrafo(docPdf, y, b.texto);
      } else if (b.tipo === "imagen") {
        let dataUrl = imagenesCache[b.archivo.path];
        if (!dataUrl) {
          dataUrl = await obtenerArchivoComoDataUrl(b.archivo.path);
          imagenesCache[b.archivo.path] = dataUrl;
        }
        y = await agregarBloqueImagen(docPdf, y, dataUrl, b.pie, contadores);
      } else if (b.tipo === "tabla") {
        y = agregarBloqueTabla(docPdf, y, b.columnas, b.filas, b.titulo, contadores);
      } else if (b.tipo === "grafico") {
        const datos = { titulo: b.titulo, etiquetas: b.etiquetas, valores: b.valores };
        if (b.tipoGrafico === "lineas") y = agregarBloqueGraficoLineas(docPdf, y, datos, contadores);
        else if (b.tipoGrafico === "pastel") y = agregarBloqueGraficoPastel(docPdf, y, datos, contadores);
        else y = agregarBloqueGraficoBarras(docPdf, y, datos, contadores);
      }
    }

    agregarPiePagina(docPdf);
    descargarPDF(docPdf, `informe-${(informeActual.titulo || "informe").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`);
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
});
