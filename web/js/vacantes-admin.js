import {
  collection, onSnapshot, addDoc, updateDoc, doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { db, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, formatDate, hoyStr } from "./utils.js";

await requireAuth();
wireLogoutButton();
setActiveNav();

const tabla = document.getElementById("tablaVacantes");
const modalBackdrop = document.getElementById("modalBackdrop");
const modalTitulo = document.getElementById("modalTitulo");
const form = document.getElementById("vacanteForm");
const alertBox = document.getElementById("alertBox");
const guardarBtn = document.getElementById("guardarBtn");

let vacantes = [];
let conteoCandidatos = {};

function vacantesOrdenadas() {
  return vacantes.slice().sort((a, b) => (b.fechaPublicacion || "").localeCompare(a.fechaPublicacion || ""));
}

function celdaTrunc(texto, anchoPx) {
  return `<span class="celda-trunc" style="max-width:${anchoPx}px;" title="${(texto || "").replace(/"/g, "&quot;")}">${texto || "-"}</span>`;
}

// Fila = solo lo justo para escanear y elegir; el detalle completo
// (descripción, requisitos, acciones) vive en el panel de vista previa de
// arriba — mismo patrón que Empleados (ver empleados.js).
function render() {
  if (vacantes.length === 0) {
    tabla.innerHTML = '<tr><td colspan="4" class="text-muted text-center">Aún no hay vacantes creadas.</td></tr>';
    vacanteSeleccionadaId = null;
    pintarVistaPreviaVacante();
    return;
  }
  const ordenadas = vacantesOrdenadas();
  if (!vacanteSeleccionadaId || !ordenadas.some((v) => v.id === vacanteSeleccionadaId)) {
    vacanteSeleccionadaId = ordenadas[0].id;
  }
  tabla.innerHTML = ordenadas.map((v) => `
    <tr data-id="${v.id}">
      <td style="font-weight:600;">${celdaTrunc(v.titulo, 320)}</td>
      <td>${v.estado === "abierta" ? '<span class="badge ok">Abierta</span>' : '<span class="badge muted">Cerrada</span>'}</td>
      <td>${v.fechaPublicacion ? formatDate(v.fechaPublicacion) : "-"}</td>
      <td>${conteoCandidatos[v.id] || 0}</td>
    </tr>
  `).join("");
  tabla.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      vacanteSeleccionadaId = tr.getAttribute("data-id");
      actualizarResaltadoVacante();
      pintarVistaPreviaVacante();
    });
  });
  actualizarResaltadoVacante();
  pintarVistaPreviaVacante();
}

let vacanteSeleccionadaId = null;

function actualizarResaltadoVacante() {
  tabla.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.classList.toggle("fila-fijada", tr.getAttribute("data-id") === vacanteSeleccionadaId);
  });
}

function escapeHtml(texto) {
  return String(texto ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const vistaPreviaEl = document.getElementById("vistaPreviaVacante");
const VISTA_PREVIA_VACIA = '<p class="text-muted" style="margin:0;">Aún no hay vacantes creadas.</p>';

function pintarVistaPreviaVacante() {
  if (!vistaPreviaEl) return;
  const v = vacantes.find((x) => x.id === vacanteSeleccionadaId);
  if (!v) { vistaPreviaEl.innerHTML = VISTA_PREVIA_VACIA; return; }

  const campo = (etiqueta, valor) => `
    <div class="vp-campo">
      <span class="vp-etiqueta">${etiqueta}</span>
      <span class="vp-valor">${escapeHtml(valor || "Sin especificar")}</span>
    </div>`;
  const grupo = (titulo, camposHtml) => `
    <div class="vp-grupo">
      <div class="vp-grupo-titulo">${titulo}</div>
      <div class="vp-grupo-campos">${camposHtml}</div>
    </div>`;

  vistaPreviaEl.innerHTML = `
    <div class="vp-encabezado">
      <span class="vp-nombre">${escapeHtml(v.titulo)}</span>
      <div class="vp-acciones">
        <a class="icon-btn" href="candidatos.html?vacanteId=${v.id}">👥 Ver candidatos (${conteoCandidatos[v.id] || 0})</a>
        <button class="icon-btn" data-editar="${v.id}">✏️ Editar</button>
      </div>
    </div>
    <div class="vp-grupos">
      ${grupo("Publicación", `
        ${campo("Estado", v.estado === "abierta" ? "Abierta" : "Cerrada")}
        ${campo("Publicada", v.fechaPublicacion ? formatDate(v.fechaPublicacion) : "")}
        ${campo("Candidatos postulados", String(conteoCandidatos[v.id] || 0))}
      `)}
      ${grupo("Descripción", campo("Descripción", v.descripcion))}
      ${grupo("Requisitos", campo("Requisitos", v.requisitos))}
    </div>
  `;

  vistaPreviaEl.querySelector("[data-editar]")?.addEventListener("click", () => abrirModal(v));
}

onSnapshot(collection(db, "vacantes"), (snap) => {
  vacantes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}, (err) => {
  tabla.innerHTML = `<tr><td colspan="4" class="text-muted text-center">${friendlyError(err)}</td></tr>`;
});

onSnapshot(collection(db, "candidatos"), (snap) => {
  conteoCandidatos = {};
  snap.docs.forEach((d) => {
    const vacanteId = d.data().vacanteId;
    conteoCandidatos[vacanteId] = (conteoCandidatos[vacanteId] || 0) + 1;
  });
  render();
});

function abrirModal(vacante = null) {
  form.reset();
  clearAlert(alertBox);
  document.getElementById("vacanteId").value = vacante?.id || "";
  document.getElementById("titulo").value = vacante?.titulo || "";
  document.getElementById("descripcion").value = vacante?.descripcion || "";
  document.getElementById("requisitos").value = vacante?.requisitos || "";
  document.getElementById("estado").value = vacante?.estado || "abierta";
  modalTitulo.textContent = vacante ? "Editar vacante" : "Nueva vacante";
  modalBackdrop.classList.add("open");
}

document.getElementById("nuevaVacanteBtn").addEventListener("click", () => abrirModal());
document.getElementById("cancelarBtn").addEventListener("click", () => modalBackdrop.classList.remove("open"));

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert(alertBox);
  guardarBtn.disabled = true;
  guardarBtn.textContent = "Guardando...";

  const id = document.getElementById("vacanteId").value;
  const datos = {
    titulo: document.getElementById("titulo").value.trim(),
    descripcion: document.getElementById("descripcion").value.trim(),
    requisitos: document.getElementById("requisitos").value.trim(),
    estado: document.getElementById("estado").value
  };

  try {
    if (id) {
      await updateDoc(doc(db, "vacantes", id), datos);
    } else {
      await addDoc(collection(db, "vacantes"), { ...datos, fechaPublicacion: hoyStr(), creadoEn: serverTimestamp() });
    }
    modalBackdrop.classList.remove("open");
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
  } finally {
    guardarBtn.disabled = false;
    guardarBtn.textContent = "Guardar";
  }
});
