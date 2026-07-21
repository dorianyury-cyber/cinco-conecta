import {
  collection, onSnapshot, addDoc, updateDoc, doc, arrayUnion, arrayRemove, serverTimestamp, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { db, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, VALORES_CINCO } from "./utils.js";

const { user } = await requireAuth();
wireLogoutButton();
setActiveNav();

const paraUidSelect = document.getElementById("paraUid");
const valorSelect = document.getElementById("valor");
const form = document.getElementById("reconocerForm");
const alertBox = document.getElementById("alertBox");
const enviarBtn = document.getElementById("enviarBtn");
const muro = document.getElementById("muroReconocimientos");

valorSelect.innerHTML = VALORES_CINCO.map((v) => `<option value="${v}">${v}</option>`).join("");

let compañeros = [];
onSnapshot(collection(db, "staff"), (snap) => {
  compañeros = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => p.id !== user.uid && p.estado === "activo");
  paraUidSelect.innerHTML = compañeros.map((p) => `<option value="${p.id}">${p.nombre}</option>`).join("");
});

let reconocimientos = [];
function renderMuro() {
  if (reconocimientos.length === 0) {
    muro.innerHTML = '<p class="text-muted text-center">Aún no hay reconocimientos — ¡sé el primero!</p>';
    return;
  }
  muro.innerHTML = reconocimientos
    .map((r) => {
      const yaLeDiMeGusta = (r.megusta || []).includes(user.uid);
      return `
        <div class="card">
          <p><strong>${r.deAutorNombre}</strong> reconoció a <strong>${r.paraNombre}</strong> <span class="badge gold">${r.valor}</span></p>
          <p>${r.mensaje}</p>
          <button type="button" class="icon-btn ${yaLeDiMeGusta ? "danger" : ""}" data-like="${r.id}">
            ${yaLeDiMeGusta ? "❤️" : "🤍"} ${(r.megusta || []).length}
          </button>
        </div>
      `;
    })
    .join("");
}

onSnapshot(query(collection(db, "reconocimientos"), orderBy("creadoEn", "desc")), (snap) => {
  reconocimientos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderMuro();
}, (err) => {
  muro.innerHTML = `<p class="text-muted text-center">${friendlyError(err)}</p>`;
});

muro.addEventListener("click", async (e) => {
  const id = e.target.closest("[data-like]")?.dataset.like;
  if (!id) return;
  const r = reconocimientos.find((x) => x.id === id);
  const yaLeDiMeGusta = (r.megusta || []).includes(user.uid);
  await updateDoc(doc(db, "reconocimientos", id), {
    megusta: yaLeDiMeGusta ? arrayRemove(user.uid) : arrayUnion(user.uid)
  });
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert(alertBox);
  enviarBtn.disabled = true;
  enviarBtn.textContent = "Enviando...";

  try {
    const paraUid = paraUidSelect.value;
    const paraNombre = compañeros.find((p) => p.id === paraUid)?.nombre || "";
    await addDoc(collection(db, "reconocimientos"), {
      deAutorUid: user.uid,
      deAutorNombre: document.getElementById("userName").textContent,
      paraUid,
      paraNombre,
      valor: valorSelect.value,
      mensaje: document.getElementById("mensaje").value.trim(),
      megusta: [],
      creadoEn: serverTimestamp()
    });
    form.reset();
    showAlert(alertBox, "¡Reconocimiento publicado!", "success");
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
  } finally {
    enviarBtn.disabled = false;
    enviarBtn.textContent = "Reconocer";
  }
});
