import { collection, onSnapshot, addDoc, query, orderBy, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { db, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, formatDate } from "./utils.js";

const { perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

const esAdmin = perfil.rol === "admin";
if (esAdmin) document.getElementById("publicarCard").classList.remove("hidden");

const feed = document.getElementById("feedComunicados");
const form = document.getElementById("comunicadoForm");
const alertBox = document.getElementById("alertBox");
const publicarBtn = document.getElementById("publicarBtn");

onSnapshot(query(collection(db, "comunicados"), orderBy("creadoEn", "desc")), (snap) => {
  const comunicados = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (comunicados.length === 0) {
    feed.innerHTML = '<p class="text-muted text-center">Aún no hay comunicados publicados.</p>';
    return;
  }
  const fijados = comunicados.filter((c) => c.fijado);
  const resto = comunicados.filter((c) => !c.fijado);
  feed.innerHTML = [...fijados, ...resto]
    .map((c) => `
      <div class="card">
        ${c.fijado ? '<span class="badge gold">📌 Fijado</span>' : ""}
        <h2>${c.titulo}</h2>
        <p>${c.cuerpo}</p>
        <p class="text-muted text-sm">${c.autorNombre || ""} · ${c.creadoEn ? formatDate(c.creadoEn) : ""}</p>
      </div>
    `)
    .join("");
}, (err) => {
  feed.innerHTML = `<p class="text-muted text-center">${friendlyError(err)}</p>`;
});

if (esAdmin) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert(alertBox);
    publicarBtn.disabled = true;
    publicarBtn.textContent = "Publicando...";
    try {
      await addDoc(collection(db, "comunicados"), {
        titulo: document.getElementById("tituloComunicado").value.trim(),
        cuerpo: document.getElementById("cuerpoComunicado").value.trim(),
        autorNombre: document.getElementById("userName").textContent,
        fijado: document.getElementById("fijadoCheck").checked,
        creadoEn: serverTimestamp()
      });
      form.reset();
    } catch (err) {
      showAlert(alertBox, friendlyError(err), "error");
    } finally {
      publicarBtn.disabled = false;
      publicarBtn.textContent = "Publicar";
    }
  });
}
