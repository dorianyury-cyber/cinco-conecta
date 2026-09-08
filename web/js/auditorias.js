import { collection, onSnapshot, addDoc, updateDoc, doc, serverTimestamp, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { db, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, formatDate, formatDateCorta, tienePermiso } from "./utils.js";
import { crearDocumentoPDF, agregarEncabezado, agregarTabla, agregarPiePagina, descargarPDF } from "./pdf.js";

const { perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

const esAdmin = tienePermiso(perfil, "auditorias");
if (esAdmin) document.getElementById("crearCard").classList.remove("hidden");

const NORMA_TEXTO = { "9001": "ISO 9001", "14001": "ISO 14001", "45001": "ISO 45001", multiple: "Varias normas" };
const TIPO_TEXTO = { auditoria: "Auditoría", inspeccion: "Inspección" };
const CUMPLE_TEXTO = { true: "✅ Cumple", false: "❌ No cumple", null: "⏳ Pendiente" };

let auditorias = [];
const tabla = document.getElementById("tablaAuditorias");

function celdaTrunc(texto, anchoPx) {
  return `<span class="celda-trunc" style="max-width:${anchoPx}px;" title="${(texto || "").replace(/"/g, "&quot;")}">${texto || "-"}</span>`;
}
function escapeHtml(texto) {
  return String(texto ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function filaItemEditable(item, i, auditoriaId) {
  return `
    <div class="card item-card">
      <label>${item.texto}</label>
      <select data-cumple="${auditoriaId}-${i}">
        <option value="null" ${item.cumple === null ? "selected" : ""}>Pendiente</option>
        <option value="true" ${item.cumple === true ? "selected" : ""}>Cumple</option>
        <option value="false" ${item.cumple === false ? "selected" : ""}>No cumple</option>
      </select>
      <input type="text" data-observacion="${auditoriaId}-${i}" value="${(item.observacion || "").replace(/"/g, "&quot;")}" placeholder="Observación">
    </div>
  `;
}

// Fila = solo lo justo para escanear y elegir; la lista de verificación
// completa (editable o de solo lectura) vive en el panel de vista previa
// de arriba — mismo patrón que Empleados (ver empleados.js).
function render() {
  if (auditorias.length === 0) {
    tabla.innerHTML = '<tr><td colspan="5" class="text-muted text-center">Aún no hay auditorías registradas.</td></tr>';
    auditoriaSeleccionadaId = null;
    pintarVistaPreviaAuditoria();
    return;
  }
  if (!auditoriaSeleccionadaId || !auditorias.some((a) => a.id === auditoriaSeleccionadaId)) {
    auditoriaSeleccionadaId = auditorias[0].id;
  }
  tabla.innerHTML = auditorias.map((a) => `
    <tr data-id="${a.id}">
      <td style="font-weight:600;">${celdaTrunc(a.titulo, 260)}</td>
      <td>${TIPO_TEXTO[a.tipo]}</td>
      <td>${NORMA_TEXTO[a.normaISO]}</td>
      <td>${formatDate(a.fecha)}</td>
      <td><span class="badge ${a.estado === "cerrada" ? "ok" : "warn"}">${a.estado === "cerrada" ? "Cerrada" : "Abierta"}</span></td>
    </tr>
  `).join("");
  tabla.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      auditoriaSeleccionadaId = tr.getAttribute("data-id");
      actualizarResaltadoAuditoria();
      pintarVistaPreviaAuditoria();
    });
  });
  actualizarResaltadoAuditoria();
  pintarVistaPreviaAuditoria();
}

let auditoriaSeleccionadaId = null;

function actualizarResaltadoAuditoria() {
  tabla.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.classList.toggle("fila-fijada", tr.getAttribute("data-id") === auditoriaSeleccionadaId);
  });
}

function generarInformeAuditoria(a) {
  const columnas = ["Ítem", "Resultado", "Observación"];
  const filas = (a.items || []).map((item) => [item.texto, CUMPLE_TEXTO[item.cumple], item.observacion || "-"]);
  const docPdf = crearDocumentoPDF();
  const startY = agregarEncabezado(docPdf, "Cinco S.A.S.", `${TIPO_TEXTO[a.tipo]} — ${a.titulo}`, `${NORMA_TEXTO[a.normaISO]} · ${formatDateCorta(a.fecha)} · Sistema SGI-HSEQ`);
  agregarTabla(docPdf, columnas, filas, startY);
  let y = docPdf.lastAutoTable.finalY + 10;
  docPdf.setFont("times", "bold");
  docPdf.setFontSize(11);
  docPdf.text("Hallazgos:", 12, y);
  docPdf.setFont("times", "normal");
  const hallazgosTexto = docPdf.splitTextToSize(a.hallazgos || "Sin hallazgos registrados.", docPdf.internal.pageSize.getWidth() - 24);
  docPdf.text(hallazgosTexto, 12, y + 6);
  agregarPiePagina(docPdf);
  descargarPDF(docPdf, `auditoria-${(a.titulo || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`);
}

const vistaPreviaEl = document.getElementById("vistaPreviaAuditoria");
const VISTA_PREVIA_VACIA = '<p class="text-muted" style="margin:0;">Aún no hay auditorías registradas.</p>';

function pintarVistaPreviaAuditoria() {
  if (!vistaPreviaEl) return;
  const a = auditorias.find((x) => x.id === auditoriaSeleccionadaId);
  if (!a) { vistaPreviaEl.innerHTML = VISTA_PREVIA_VACIA; return; }

  const editable = esAdmin && a.estado !== "cerrada";

  vistaPreviaEl.innerHTML = `
    <div class="vp-encabezado">
      <span class="vp-nombre">${escapeHtml(a.titulo)}</span>
      <div class="vp-acciones">
        <span class="badge gold">${TIPO_TEXTO[a.tipo]}</span>
        <span class="badge muted">${NORMA_TEXTO[a.normaISO]}</span>
        <span class="badge ${a.estado === "cerrada" ? "ok" : "warn"}">${a.estado === "cerrada" ? "Cerrada" : "Abierta"}</span>
        ${editable ? `<button class="icon-btn" data-guardar="${a.id}">💾 Guardar cambios</button>` : ""}
        ${editable ? `<button class="icon-btn" data-cerrar="${a.id}">✅ Cerrar auditoría</button>` : ""}
        <button class="icon-btn" data-informe="${a.id}">📄 Generar informe PDF</button>
      </div>
    </div>
    <p class="text-muted text-sm">${formatDate(a.fecha)}</p>

    ${editable
      ? (a.items || []).map((item, i) => filaItemEditable(item, i, a.id)).join("")
      : (a.items || []).map((item) => `<p>${item.texto} — <strong>${CUMPLE_TEXTO[item.cumple]}</strong>${item.observacion ? ` — ${item.observacion}` : ""}</p>`).join("")
    }

    <label>Hallazgos</label>
    ${editable
      ? `<textarea rows="2" data-hallazgos="${a.id}">${a.hallazgos || ""}</textarea>`
      : `<p>${a.hallazgos || "-"}</p>`
    }
  `;

  vistaPreviaEl.querySelector("[data-guardar]")?.addEventListener("click", async () => {
    const nuevosItems = (a.items || []).map((item, i) => {
      const cumpleVal = document.querySelector(`[data-cumple="${a.id}-${i}"]`).value;
      const observacion = document.querySelector(`[data-observacion="${a.id}-${i}"]`).value.trim();
      return { texto: item.texto, cumple: cumpleVal === "null" ? null : cumpleVal === "true", observacion };
    });
    const hallazgos = document.querySelector(`[data-hallazgos="${a.id}"]`).value.trim();
    try {
      await updateDoc(doc(db, "auditorias", a.id), { items: nuevosItems, hallazgos });
    } catch (err) {
      alert(friendlyError(err));
    }
  });
  vistaPreviaEl.querySelector("[data-cerrar]")?.addEventListener("click", async () => {
    try {
      await updateDoc(doc(db, "auditorias", a.id), { estado: "cerrada" });
    } catch (err) {
      alert(friendlyError(err));
    }
  });
  vistaPreviaEl.querySelector("[data-informe]")?.addEventListener("click", () => generarInformeAuditoria(a));
}

onSnapshot(query(collection(db, "auditorias"), orderBy("creadoEn", "desc")), (snap) => {
  auditorias = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}, (err) => {
  tabla.innerHTML = `<tr><td colspan="5" class="text-muted text-center">${friendlyError(err)}</td></tr>`;
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
      const items = document.getElementById("items").value
        .split("\n").map((t) => t.trim()).filter(Boolean)
        .map((texto) => ({ texto, cumple: null, observacion: "" }));
      if (items.length === 0) throw new Error("Agrega al menos un ítem a la lista de verificación.");
      await addDoc(collection(db, "auditorias"), {
        titulo: document.getElementById("titulo").value.trim(),
        tipo: document.getElementById("tipo").value,
        normaISO: document.getElementById("normaISO").value,
        fecha: document.getElementById("fecha").value,
        items,
        hallazgos: "",
        estado: "programada",
        creadoEn: serverTimestamp()
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
