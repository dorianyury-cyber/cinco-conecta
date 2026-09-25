// Formulario con el que el trabajador responde una encuesta (y la vista
// previa del creador — es el MISMO código, así lo que se previsualiza es
// exactamente lo que se responde). Sin dependencias de Firebase: la subida de
// archivos llega inyectada como `subirArchivo`.
import { esc, normalizarPregunta, esCuadricula, esEncabezado, CATEGORIAS_ARCHIVO, textoLimitesCasillas } from "./encuestas-tipos.js";

let montajes = 0;

const extensionDe = (nombre) => (/\.([A-Za-z0-9]{1,5})$/.exec(nombre || "")?.[1] || "").toLowerCase();

function formatoTamano(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function extensionesDe(p) {
  return p.archivos.tipos.flatMap((t) => CATEGORIAS_ARCHIVO[t]?.exts || []);
}

function leerBase64(archivo) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(String(lector.result).split(",")[1] || "");
    lector.onerror = () => reject(new Error(`No se pudo leer el archivo ${archivo.name}.`));
    lector.readAsDataURL(archivo);
  });
}

// ---------- HTML de cada tipo ----------

function htmlCuerpo(p, i, pref) {
  const name = `${pref}-${i}`;
  switch (p.tipo) {
    case "parrafo":
      return `<textarea name="${name}" rows="4" maxlength="2000" placeholder="Tu respuesta"></textarea>`;

    case "opcion_multiple":
      return `<div class="opciones-lista">${p.opciones.map((o) => `
        <label class="opcion-respuesta"><input type="radio" name="${name}" value="${esc(o)}"><span>${esc(o)}</span></label>`).join("")}</div>
        ${p.obligatoria ? "" : '<button type="button" class="link-btn" data-accion="borrar-seleccion">Borrar selección</button>'}`;

    case "casillas": {
      const limites = textoLimitesCasillas(p);
      return `${limites ? `<p class="preg-resp-hint">${esc(limites)}</p>` : ""}
        <div class="opciones-lista">${p.opciones.map((o) => `
        <label class="opcion-respuesta"><input type="checkbox" name="${name}" value="${esc(o)}"><span>${esc(o)}</span></label>`).join("")}</div>`;
    }

    case "desplegable":
      return `<select name="${name}"><option value="">Elige una opción</option>${p.opciones.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}</select>`;

    case "escala": {
      const valores = [];
      for (let v = p.escala.min; v <= p.escala.max; v++) valores.push(v);
      return `<div class="escala">
        ${p.escala.etiquetaMin ? `<span class="escala-etq">${esc(p.escala.etiquetaMin)}</span>` : ""}
        <div class="escala-opciones">${valores.map((v) => `
          <label class="escala-op"><span>${v}</span><input type="radio" name="${name}" value="${v}"></label>`).join("")}</div>
        ${p.escala.etiquetaMax ? `<span class="escala-etq">${esc(p.escala.etiquetaMax)}</span>` : ""}
      </div>
      ${p.obligatoria ? "" : '<button type="button" class="link-btn" data-accion="borrar-seleccion">Borrar selección</button>'}`;
    }

    case "calificacion": {
      const estrellas = [];
      for (let v = 1; v <= p.calificacion.max; v++) {
        estrellas.push(`<button type="button" class="estrella" data-valor="${v}" aria-label="${v} de ${p.calificacion.max}">★</button>`);
      }
      return `<div class="estrellas" role="group">${estrellas.join("")}<span class="estrellas-valor"></span></div>
        ${p.obligatoria ? "" : '<button type="button" class="link-btn" data-accion="borrar-calificacion">Borrar calificación</button>'}`;
    }

    case "cuadricula_opciones":
    case "cuadricula_casillas": {
      const tipoInput = p.tipo === "cuadricula_opciones" ? "radio" : "checkbox";
      const anchoMin = 150 + p.columnas.length * 84;
      return `<div class="cuadricula-wrap"><table class="cuadricula" style="min-width:${anchoMin}px">
        <colgroup><col style="width:150px">${p.columnas.map(() => "<col>").join("")}</colgroup>
        <thead><tr><th></th>${p.columnas.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>${p.filas.map((f, j) => `<tr>
          <th scope="row">${esc(f)}</th>
          ${p.columnas.map((c) => `<td><input type="${tipoInput}" name="${name}-${j}" value="${esc(c)}" aria-label="${esc(f)}: ${esc(c)}"></td>`).join("")}
        </tr>`).join("")}</tbody>
      </table></div>
      ${p.tipo === "cuadricula_opciones" ? '<p class="preg-resp-hint">Una opción por fila.</p>' : '<p class="preg-resp-hint">Puedes marcar varias opciones por fila.</p>'}`;
    }

    case "archivos": {
      const nombresTipos = p.archivos.tipos.map((t) => CATEGORIAS_ARCHIVO[t].etiqueta).join(", ");
      const varios = p.archivos.maxArchivos > 1;
      return `<div class="archivos-ctrl">
        <p class="preg-resp-hint">${esc(nombresTipos)} · ${varios ? `hasta ${p.archivos.maxArchivos} archivos` : "1 archivo"} · máx. ${p.archivos.maxMB} MB cada uno</p>
        <input type="file" class="archivo-input" name="${name}" ${varios ? "multiple" : ""} accept="${extensionesDe(p).map((e) => "." + e).join(",")}">
        <button type="button" class="btn secondary btn-auto" data-accion="elegir-archivo">Agregar ${varios ? "archivos" : "archivo"}</button>
        <ul class="archivos-lista"></ul>
      </div>`;
    }

    case "fecha":
      return `<input type="date" name="${name}" class="input-corto">`;
    case "hora":
      return `<input type="time" name="${name}" class="input-corto">`;
    default:
      return `<input type="text" name="${name}" maxlength="300" placeholder="Tu respuesta">`;
  }
}

function htmlPregunta(p, i, pref) {
  if (esEncabezado(p.tipo)) {
    return `
      <div class="preg-resp-encabezado" data-i="${i}">
        <div class="preg-resp-encabezado-titulo">${esc(p.texto)}</div>
        ${p.descripcion ? `<div class="preg-resp-encabezado-desc">${esc(p.descripcion)}</div>` : ""}
      </div>`;
  }
  return `
    <section class="preg-resp" data-i="${i}" role="group" aria-labelledby="${pref}-t${i}">
      <div class="preg-resp-titulo" id="${pref}-t${i}">${esc(p.texto)}${p.obligatoria ? '<span class="preg-req" title="Obligatoria"> *</span>' : ""}</div>
      ${p.descripcion ? `<div class="preg-resp-desc">${esc(p.descripcion)}</div>` : ""}
      <div class="preg-resp-cuerpo">${htmlCuerpo(p, i, pref)}</div>
      <div class="preg-resp-error" role="alert"></div>
    </section>`;
}

// ---------- Montaje ----------

/**
 * Dibuja el formulario dentro de `host`. Devuelve { obtenerRespuestas }:
 * valida (marcando cada pregunta con error), sube los archivos pendientes y
 * retorna el objeto { [idPregunta]: valor } listo para responderEncuesta —
 * o `null` si hay errores de validación. Lanza Error si falla una subida.
 */
export function montarFormulario({ host, preguntas, subirArchivo }) {
  const pref = `f${++montajes}`;
  const ps = preguntas.map(normalizarPregunta);
  // Por pregunta de archivos: [{ archivo: File, subido: {path,...}|null }]
  const adjuntos = ps.map(() => []);
  const valorEstrella = ps.map(() => 0);

  host.innerHTML = ps.map((p, i) => htmlPregunta(p, i, pref)).join("");
  const tarjeta = (i) => host.querySelector(`.preg-resp[data-i="${i}"]`);
  const cuerpo = (i) => tarjeta(i).querySelector(".preg-resp-cuerpo");

  function marcarError(i, mensaje) {
    const t = tarjeta(i);
    if (!t) return; // los encabezados no son ".preg-resp": no tienen dónde marcar error.
    t.classList.toggle("con-error", !!mensaje);
    t.querySelector(".preg-resp-error").textContent = mensaje || "";
  }

  function pintarEstrellas(i) {
    const v = valorEstrella[i];
    cuerpo(i).querySelectorAll(".estrella").forEach((b) => b.classList.toggle("activa", Number(b.dataset.valor) <= v));
    const etq = cuerpo(i).querySelector(".estrellas-valor");
    if (etq) etq.textContent = v ? `${v} de ${ps[i].calificacion.max}` : "";
  }

  function pintarArchivos(i) {
    cuerpo(i).querySelector(".archivos-lista").innerHTML = adjuntos[i].map((a, j) => `
      <li><span class="archivo-nombre">${esc(a.archivo.name)}</span>
        <span class="text-muted text-sm">${formatoTamano(a.archivo.size)}${a.subido ? " · subido" : ""}</span>
        <button type="button" class="icon-btn" data-accion="quitar-archivo" data-j="${j}" title="Quitar">✕</button></li>`).join("");
  }

  // Con "máximo" en casillas, al llegar al tope se bloquean las demás.
  function aplicarTopeCasillas(i) {
    const p = ps[i];
    if (p.tipo !== "casillas" || p.maxSeleccion === null) return;
    const cajas = [...cuerpo(i).querySelectorAll('input[type="checkbox"]')];
    const marcadas = cajas.filter((c) => c.checked).length;
    cajas.forEach((c) => { c.disabled = !c.checked && marcadas >= p.maxSeleccion; });
  }

  host.addEventListener("click", (e) => {
    const boton = e.target.closest("[data-accion], .estrella");
    if (!boton) return;
    const t = boton.closest(".preg-resp");
    const i = Number(t.dataset.i);
    if (boton.classList.contains("estrella")) {
      valorEstrella[i] = valorEstrella[i] === Number(boton.dataset.valor) && !ps[i].obligatoria ? 0 : Number(boton.dataset.valor);
      pintarEstrellas(i);
      marcarError(i, "");
      return;
    }
    switch (boton.dataset.accion) {
      case "borrar-seleccion":
        cuerpo(i).querySelectorAll('input[type="radio"]').forEach((r) => { r.checked = false; });
        break;
      case "borrar-calificacion":
        valorEstrella[i] = 0;
        pintarEstrellas(i);
        break;
      case "elegir-archivo":
        cuerpo(i).querySelector(".archivo-input").click();
        break;
      case "quitar-archivo":
        adjuntos[i].splice(Number(boton.dataset.j), 1);
        pintarArchivos(i);
        marcarError(i, "");
        break;
    }
  });

  host.addEventListener("change", (e) => {
    const t = e.target.closest(".preg-resp");
    if (!t) return;
    const i = Number(t.dataset.i);
    const p = ps[i];
    marcarError(i, "");
    aplicarTopeCasillas(i);
    if (p.tipo !== "archivos" || !e.target.classList.contains("archivo-input")) return;

    const permitidas = extensionesDe(p);
    const problemas = [];
    [...e.target.files].forEach((archivo) => {
      if (adjuntos[i].length >= p.archivos.maxArchivos) {
        problemas.push(`Máximo ${p.archivos.maxArchivos} archivo(s) en esta pregunta.`);
      } else if (!permitidas.includes(extensionDe(archivo.name))) {
        problemas.push(`"${archivo.name}": tipo de archivo no permitido.`);
      } else if (archivo.size > p.archivos.maxMB * 1024 * 1024) {
        problemas.push(`"${archivo.name}" supera ${p.archivos.maxMB} MB.`);
      } else if (archivo.size === 0) {
        problemas.push(`"${archivo.name}" está vacío.`);
      } else {
        adjuntos[i].push({ archivo, subido: null });
      }
    });
    e.target.value = "";
    pintarArchivos(i);
    if (problemas.length) marcarError(i, [...new Set(problemas)].join(" "));
  });
  host.addEventListener("input", (e) => {
    const t = e.target.closest(".preg-resp");
    if (t) marcarError(Number(t.dataset.i), "");
  });

  // ---------- Lectura y validación ----------

  function leer(p, i) {
    if (esEncabezado(p.tipo)) return { valor: null, vacio: true }; // no es pregunta: nunca tiene cuerpo ni respuesta.
    const c = cuerpo(i);
    const marcados = (sel) => [...c.querySelectorAll(sel)];
    switch (p.tipo) {
      case "opcion_multiple":
      case "escala": {
        const r = c.querySelector('input[type="radio"]:checked');
        const valor = r ? (p.tipo === "escala" ? Number(r.value) : r.value) : null;
        return { valor, vacio: valor === null };
      }
      case "casillas": {
        const valor = marcados('input[type="checkbox"]:checked').map((x) => x.value);
        return { valor, vacio: valor.length === 0 };
      }
      case "desplegable": {
        const valor = c.querySelector("select").value;
        return { valor, vacio: valor === "" };
      }
      case "calificacion":
        return { valor: valorEstrella[i], vacio: valorEstrella[i] === 0 };
      case "cuadricula_opciones": {
        const valor = [];
        p.filas.forEach((fila, j) => {
          const r = c.querySelector(`input[name="${pref}-${i}-${j}"]:checked`);
          if (r) valor.push({ fila, valor: r.value });
        });
        return { valor, vacio: valor.length === 0, filasSinResponder: p.filas.length - valor.length };
      }
      case "cuadricula_casillas": {
        const valor = [];
        p.filas.forEach((fila, j) => {
          const valores = marcados(`input[name="${pref}-${i}-${j}"]:checked`).map((x) => x.value);
          if (valores.length) valor.push({ fila, valores });
        });
        return { valor, vacio: valor.length === 0, filasSinResponder: p.filas.length - valor.length };
      }
      case "archivos":
        return { valor: adjuntos[i], vacio: adjuntos[i].length === 0 };
      default: {
        const valor = c.querySelector("input, textarea").value.trim();
        return { valor, vacio: valor === "" };
      }
    }
  }

  function mensajeError(p, r) {
    if (r.vacio) return p.obligatoria ? "Esta pregunta es obligatoria." : "";
    if (p.tipo === "casillas") {
      if (r.valor.length < p.minSeleccion) return `Selecciona al menos ${p.minSeleccion} opción(es).`;
      if (p.maxSeleccion !== null && r.valor.length > p.maxSeleccion) return `Selecciona como máximo ${p.maxSeleccion} opción(es).`;
    }
    if (esCuadricula(p.tipo) && p.obligatoria && r.filasSinResponder > 0) return "Responde todas las filas.";
    return "";
  }

  async function obtenerRespuestas(alProgreso = () => {}) {
    const lecturas = ps.map((p, i) => leer(p, i));
    let primera = null;
    ps.forEach((p, i) => {
      const mensaje = mensajeError(p, lecturas[i]);
      marcarError(i, mensaje);
      if (mensaje && primera === null) primera = i;
    });
    if (primera !== null) {
      tarjeta(primera).scrollIntoView({ behavior: "smooth", block: "center" });
      return null;
    }

    // Subir los archivos que aún no se han subido (uno a uno; si el envío
    // final falla y la persona reintenta, los ya subidos no se repiten).
    const pendientes = ps.flatMap((p, i) => (p.tipo === "archivos" ? adjuntos[i].filter((a) => !a.subido).map((a) => ({ i, p, a })) : []));
    for (let k = 0; k < pendientes.length; k++) {
      const { i, p, a } = pendientes[k];
      alProgreso(`Subiendo archivo ${k + 1} de ${pendientes.length}: ${a.archivo.name}`);
      try {
        a.subido = await subirArchivo({ preguntaId: p.id, nombre: a.archivo.name, base64: await leerBase64(a.archivo) });
      } catch (err) {
        marcarError(i, `No se pudo subir "${a.archivo.name}": ${err.message || err}`);
        tarjeta(i).scrollIntoView({ behavior: "smooth", block: "center" });
        throw new Error("No se pudo subir un archivo. Revisa la pregunta marcada e inténtalo de nuevo.");
      }
      pintarArchivos(i);
    }

    const respuestas = {};
    ps.forEach((p, i) => {
      const r = lecturas[i];
      if (r.vacio) return;
      respuestas[p.id] = p.tipo === "archivos" ? adjuntos[i].map((a) => ({ path: a.subido.path })) : r.valor;
    });
    return respuestas;
  }

  ps.forEach((p, i) => {
    if (p.tipo === "calificacion") pintarEstrellas(i);
  });

  return { obtenerRespuestas };
}
