import { collection, onSnapshot, addDoc, updateDoc, doc, serverTimestamp, Timestamp, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { db, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, formatDate, tienePermiso } from "./utils.js";
import { ExcelJS, descargarWorkbook, estilizarEncabezado } from "./excel.js";

const { user, perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

const esAdmin = tienePermiso(perfil, "accionesCorrectivas");
const params = new URLSearchParams(window.location.search);
const origen = params.get("origenId")
  ? { tipo: params.get("origenTipo") || "manual", refId: params.get("origenId") }
  : { tipo: "manual", refId: null };

if (esAdmin) {
  const crearCard = document.getElementById("crearCard");
  crearCard.classList.remove("hidden");
  // Si se llega desde "+ Crear acción correctiva" en Incidentes (con
  // origenId en la URL), el formulario arranca ya desplegado — quien hizo
  // clic en ese enlace espera verlo listo para llenar, no una tarjeta
  // colapsada que hay que volver a abrir.
  if (origen.refId) crearCard.classList.add("abierto");
  if (params.get("origenTitulo")) {
    document.getElementById("origenTexto").textContent = `Originada en: ${params.get("origenTitulo")}`;
  }
}

const responsableSelect = document.getElementById("responsableUid");
let compañeros = [];
onSnapshot(collection(db, "staff"), (snap) => {
  compañeros = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.estado === "activo");
  responsableSelect.innerHTML = compañeros.map((p) => `<option value="${p.id}">${p.nombre}</option>`).join("");
});

const ESTADO_BADGE = { abierta: "warn", en_progreso: "gold", cerrada: "ok" };
const ESTADO_TEXTO = { abierta: "Abierta", en_progreso: "En progreso", cerrada: "Cerrada" };

let acciones = [];

function accionesVisibles() {
  return esAdmin ? acciones : acciones.filter((a) => a.responsableUid === user.uid);
}
function celdaTrunc(texto, anchoPx) {
  return `<span class="celda-trunc" style="max-width:${anchoPx}px;" title="${(texto || "").replace(/"/g, "&quot;")}">${texto || "-"}</span>`;
}
function escapeHtml(texto) {
  return String(texto ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const tabla = document.getElementById("tablaAcciones");

// Fila = solo lo justo para escanear y elegir; el formulario de avance
// (estado/evidencia) vive en el panel de vista previa de arriba, en vez de
// abierto de una en cada tarjeta — mismo patrón que Empleados (ver
// empleados.js).
function render() {
  const visibles = accionesVisibles();
  if (visibles.length === 0) {
    tabla.innerHTML = '<tr><td colspan="4" class="text-muted text-center">No hay acciones correctivas para mostrar.</td></tr>';
    accionSeleccionadaId = null;
    pintarVistaPreviaAccion();
    return;
  }
  if (!accionSeleccionadaId || !visibles.some((a) => a.id === accionSeleccionadaId)) {
    accionSeleccionadaId = visibles[0].id;
  }
  tabla.innerHTML = visibles.map((a) => `
    <tr data-id="${a.id}">
      <td style="font-weight:600;">${celdaTrunc(a.responsableNombre, 150)}</td>
      <td>${celdaTrunc(a.descripcion, 320)}</td>
      <td>${formatDate(a.fechaLimite)}</td>
      <td><span class="badge ${ESTADO_BADGE[a.estado]}">${ESTADO_TEXTO[a.estado]}</span></td>
    </tr>
  `).join("");
  tabla.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      accionSeleccionadaId = tr.getAttribute("data-id");
      actualizarResaltadoAccion();
      pintarVistaPreviaAccion();
    });
  });
  actualizarResaltadoAccion();
  pintarVistaPreviaAccion();
}

let accionSeleccionadaId = null;

function actualizarResaltadoAccion() {
  tabla.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.classList.toggle("fila-fijada", tr.getAttribute("data-id") === accionSeleccionadaId);
  });
}

const vistaPreviaEl = document.getElementById("vistaPreviaAccion");
const VISTA_PREVIA_VACIA = '<p class="text-muted" style="margin:0;">No hay acciones correctivas para mostrar.</p>';

function pintarVistaPreviaAccion() {
  if (!vistaPreviaEl) return;
  const a = acciones.find((x) => x.id === accionSeleccionadaId);
  if (!a) { vistaPreviaEl.innerHTML = VISTA_PREVIA_VACIA; return; }

  const puedeEditar = esAdmin || a.responsableUid === user.uid;
  const campo = (etiqueta, valor) => `
    <div class="vp-campo">
      <span class="vp-etiqueta">${etiqueta}</span>
      <span class="vp-valor">${escapeHtml(valor || "-")}</span>
    </div>`;

  vistaPreviaEl.innerHTML = `
    <div class="vp-encabezado">
      <span class="vp-nombre">${escapeHtml(a.descripcion)}</span>
      <span class="badge ${ESTADO_BADGE[a.estado]}">${ESTADO_TEXTO[a.estado]}</span>
    </div>
    <div class="vp-grupos">
      <div class="vp-grupo">
        <div class="vp-grupo-titulo">Detalle</div>
        <div class="vp-grupo-campos">
          ${campo("Responsable", a.responsableNombre)}
          ${campo("Vence", formatDate(a.fechaLimite))}
          ${campo("Estado", ESTADO_TEXTO[a.estado])}
        </div>
      </div>
      ${a.evidencia && !puedeEditar ? `<div class="vp-grupo"><div class="vp-grupo-titulo">Evidencia</div><div class="vp-grupo-campos">${campo("Evidencia", a.evidencia)}</div></div>` : ""}
    </div>
    ${puedeEditar ? `
      <div class="mt-4">
        <label>Estado</label>
        <select id="accionEstadoInput">
          <option value="abierta" ${a.estado === "abierta" ? "selected" : ""}>Abierta</option>
          <option value="en_progreso" ${a.estado === "en_progreso" ? "selected" : ""}>En progreso</option>
          <option value="cerrada" ${a.estado === "cerrada" ? "selected" : ""}>Cerrada</option>
        </select>
        <label>Evidencia</label>
        <textarea rows="2" id="accionEvidenciaInput">${a.evidencia || ""}</textarea>
        <button type="button" class="btn secondary btn-auto mt-4" id="accionGuardarBtn">Guardar avance</button>
      </div>
    ` : ""}
  `;

  vistaPreviaEl.querySelector("#accionGuardarBtn")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const estado = document.getElementById("accionEstadoInput").value;
    const evidencia = document.getElementById("accionEvidenciaInput").value.trim();
    btn.disabled = true;
    try {
      await updateDoc(doc(db, "accionesCorrectivas", a.id), { estado, evidencia });
    } catch (err) {
      alert(friendlyError(err));
    } finally {
      btn.disabled = false;
    }
  });
}

onSnapshot(query(collection(db, "accionesCorrectivas"), orderBy("creadoEn", "desc")), (snap) => {
  acciones = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}, (err) => {
  tabla.innerHTML = `<tr><td colspan="4" class="text-muted text-center">${friendlyError(err)}</td></tr>`;
});

if (esAdmin) {
  document.getElementById("crearForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const alertBox = document.getElementById("crearAlertBox");
    const btn = document.getElementById("crearBtn");
    clearAlert(alertBox);
    btn.disabled = true;
    btn.textContent = "Creando...";
    try {
      const responsableUid = responsableSelect.value;
      const responsableNombre = compañeros.find((p) => p.id === responsableUid)?.nombre || "";
      await addDoc(collection(db, "accionesCorrectivas"), {
        descripcion: document.getElementById("descripcion").value.trim(),
        origen,
        responsableUid,
        responsableNombre,
        fechaLimite: document.getElementById("fechaLimite").value,
        estado: "abierta",
        evidencia: "",
        creadoEn: serverTimestamp(),
        cerradaEn: null
      });
      e.target.reset();
    } catch (err) {
      showAlert(alertBox, friendlyError(err), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Crear";
    }
  });
}

document.getElementById("exportarBtn").addEventListener("click", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Acciones Correctivas");
  ws.columns = [
    { header: "Descripción", key: "descripcion", width: 40 },
    { header: "Responsable", key: "responsable", width: 22 },
    { header: "Fecha límite", key: "fecha", width: 16 },
    { header: "Estado", key: "estado", width: 16 },
    { header: "Evidencia", key: "evidencia", width: 40 }
  ];
  estilizarEncabezado(ws);
  const visibles = esAdmin ? acciones : acciones.filter((a) => a.responsableUid === user.uid);
  visibles.forEach((a) => {
    const row = ws.addRow({
      descripcion: a.descripcion,
      responsable: a.responsableNombre,
      fecha: a.fechaLimite,
      estado: ESTADO_TEXTO[a.estado],
      evidencia: a.evidencia || ""
    });
    row.getCell(1).alignment = { wrapText: true, vertical: "top" };
    row.getCell(5).alignment = { wrapText: true, vertical: "top" };
  });
  await descargarWorkbook(wb, "acciones-correctivas.xlsx");
});
