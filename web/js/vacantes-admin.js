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

function render() {
  if (vacantes.length === 0) {
    tabla.innerHTML = '<tr><td colspan="5" class="text-muted text-center">Aún no hay vacantes creadas.</td></tr>';
    return;
  }
  tabla.innerHTML = vacantes
    .sort((a, b) => (b.fechaPublicacion || "").localeCompare(a.fechaPublicacion || ""))
    .map((v) => `
      <tr>
        <td><b>${v.titulo}</b></td>
        <td>${v.estado === "abierta" ? '<span class="badge ok">Abierta</span>' : '<span class="badge muted">Cerrada</span>'}</td>
        <td>${v.fechaPublicacion ? formatDate(v.fechaPublicacion) : "-"}</td>
        <td>${conteoCandidatos[v.id] || 0}</td>
        <td>
          <a class="icon-btn" href="candidatos.html?vacanteId=${v.id}">👥 Ver</a>
          <button class="icon-btn" data-editar="${v.id}">✏️ Editar</button>
        </td>
      </tr>
    `)
    .join("");
}

onSnapshot(collection(db, "vacantes"), (snap) => {
  vacantes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}, (err) => {
  tabla.innerHTML = `<tr><td colspan="5" class="text-muted text-center">${friendlyError(err)}</td></tr>`;
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

tabla.addEventListener("click", (e) => {
  const editarId = e.target.dataset.editar;
  if (editarId) abrirModal(vacantes.find((v) => v.id === editarId));
});

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
