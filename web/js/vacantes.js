import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { db } from "./utils.js";

const contenedor = document.getElementById("listaVacantes");

onSnapshot(query(collection(db, "vacantes"), where("estado", "==", "abierta")), (snap) => {
  const vacantes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (vacantes.length === 0) {
    contenedor.innerHTML = '<p class="text-muted text-center">Por ahora no hay vacantes abiertas. Vuelve pronto.</p>';
    return;
  }
  contenedor.innerHTML = vacantes
    .sort((a, b) => (b.fechaPublicacion || "").localeCompare(a.fechaPublicacion || ""))
    .map((v) => `
      <div class="vacante-card">
        <div>
          <h3>${v.titulo}</h3>
          <p>${v.descripcion || ""}</p>
        </div>
        <a class="btn" href="postular.html?vacanteId=${v.id}">Postularme</a>
      </div>
    `)
    .join("");
}, (err) => {
  contenedor.innerHTML = `<p class="text-muted text-center">No se pudieron cargar las vacantes (${err.message || err}).</p>`;
});
