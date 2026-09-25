// Constructor de preguntas de Encuestas (estilo Google Forms): cada pregunta
// es una tarjeta con su propio selector "Tipo de pregunta"; al cambiarlo, el
// cuerpo de la tarjeta cambia de inmediato a la interfaz de ese tipo.
// Sin dependencias de Firebase: solo manipula la lista de preguntas en
// memoria; quien lo usa (encuestas.js) decide cómo guardarla.
import {
  esc, TIPOS, TIPO_ICONO, LIMITES, CATEGORIAS_ARCHIVO,
  normalizarPregunta, preguntaNueva, encabezadoNuevo, esEncabezado, cambiarTipo, nuevoId
} from "./encuestas-tipos.js";

const GLIFO = {
  opcion_multiple: () => "○",
  casillas: () => "☐",
  desplegable: (j) => `${j + 1}.`,
  filas: (j) => `${j + 1}.`,
  columnas_opciones: () => "○",
  columnas_casillas: () => "☐"
};

// La descripción no tiene límite de longitud: el cuadro crece con el texto.
function ajustarAlto(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}

const rango = (desde, hasta) => Array.from({ length: hasta - desde + 1 }, (_, k) => desde + k);

function htmlLista(nombre, items, { glifo, etiqueta, agregar, max, min }) {
  return `
    <div class="lista-editable" data-lista="${nombre}">
      ${items.map((valor, j) => `
        <div class="opcion-fila" data-j="${j}">
          <span class="opcion-glifo" aria-hidden="true">${glifo(j)}</span>
          <input type="text" data-campo="item" maxlength="100" value="${esc(valor)}" placeholder="${etiqueta} ${j + 1}" aria-label="${etiqueta} ${j + 1}">
          <button type="button" class="icon-btn" data-accion="subir-item" title="Subir" aria-label="Subir" ${j === 0 ? "disabled" : ""}>▲</button>
          <button type="button" class="icon-btn" data-accion="bajar-item" title="Bajar" aria-label="Bajar" ${j === items.length - 1 ? "disabled" : ""}>▼</button>
          <button type="button" class="icon-btn peligro" data-accion="quitar-item" title="Quitar" aria-label="Quitar" ${items.length <= min ? "disabled" : ""}>✕</button>
        </div>`).join("")}
      <button type="button" class="btn secondary btn-auto btn-sm" data-accion="agregar-item" ${items.length >= max ? "disabled" : ""}>+ ${agregar}</button>
    </div>`;
}

function htmlCuerpo(q) {
  switch (q.tipo) {
    case "corta":
      return '<input type="text" disabled placeholder="Texto de respuesta corta">';
    case "parrafo":
      return '<textarea disabled rows="3" placeholder="Texto de respuesta larga"></textarea>';
    case "opcion_multiple":
    case "desplegable":
      return `<label class="etiqueta-seccion">Opciones${q.tipo === "opcion_multiple" ? " (se elige UNA)" : " (lista desplegable, se elige UNA)"}</label>
        ${htmlLista("opciones", q.opciones, { glifo: GLIFO[q.tipo], etiqueta: "Opción", agregar: "Agregar opción", max: LIMITES.opciones, min: 1 })}`;
    case "casillas":
      return `<label class="etiqueta-seccion">Opciones (se pueden marcar VARIAS)</label>
        ${htmlLista("opciones", q.opciones, { glifo: GLIFO.casillas, etiqueta: "Opción", agregar: "Agregar opción", max: LIMITES.opciones, min: 1 })}
        <div class="editor-config">
          <label>Mínimo de respuestas
            <input type="number" min="0" max="${q.opciones.length}" data-campo="minSeleccion" value="${q.minSeleccion || ""}" placeholder="Sin mínimo">
          </label>
          <label>Máximo de respuestas
            <input type="number" min="1" max="${q.opciones.length}" data-campo="maxSeleccion" value="${q.maxSeleccion ?? ""}" placeholder="Sin máximo">
          </label>
        </div>`;
    case "archivos":
      return `<label class="etiqueta-seccion">Tipos de archivo permitidos</label>
        <div class="editor-checks">${Object.entries(CATEGORIAS_ARCHIVO).map(([clave, c]) => `
          <label class="checkbox-row"><input type="checkbox" data-campo="archivo-tipo" value="${clave}" ${q.archivos.tipos.includes(clave) ? "checked" : ""}> ${c.etiqueta}</label>`).join("")}</div>
        <div class="editor-config">
          <label>Cantidad máxima de archivos
            <select data-campo="archivo-maxArchivos">${LIMITES.cantidadesArchivos.map((n) => `<option value="${n}" ${q.archivos.maxArchivos === n ? "selected" : ""}>${n}</option>`).join("")}</select>
          </label>
          <label>Tamaño máximo por archivo
            <select data-campo="archivo-maxMB">${LIMITES.tamanosMB.map((n) => `<option value="${n}" ${q.archivos.maxMB === n ? "selected" : ""}>${n} MB</option>`).join("")}</select>
          </label>
        </div>
        <p class="text-muted text-sm m-0">El tamaño máximo que admite la plataforma es de 5 MB por archivo.</p>`;
    case "escala":
      return `<div class="editor-config">
          <label>Desde
            <select data-campo="escala-min">${[0, 1].map((n) => `<option value="${n}" ${q.escala.min === n ? "selected" : ""}>${n}</option>`).join("")}</select>
          </label>
          <label>Hasta
            <select data-campo="escala-max">${rango(q.escala.min + 1, 10).map((n) => `<option value="${n}" ${q.escala.max === n ? "selected" : ""}>${n}</option>`).join("")}</select>
          </label>
        </div>
        <div class="editor-config">
          <label>Etiqueta del extremo inferior (opcional)
            <input type="text" maxlength="60" data-campo="escala-etiquetaMin" value="${esc(q.escala.etiquetaMin)}" placeholder="Ej.: Nada probable">
          </label>
          <label>Etiqueta del extremo superior (opcional)
            <input type="text" maxlength="60" data-campo="escala-etiquetaMax" value="${esc(q.escala.etiquetaMax)}" placeholder="Ej.: Muy probable">
          </label>
        </div>
        <div class="escala escala-previa">
          <span class="escala-etq">${esc(q.escala.etiquetaMin)}</span>
          <div class="escala-opciones">${rango(q.escala.min, q.escala.max).map((v) => `<span class="escala-op"><span>${v}</span><span class="escala-punto"></span></span>`).join("")}</div>
          <span class="escala-etq">${esc(q.escala.etiquetaMax)}</span>
        </div>`;
    case "calificacion":
      return `<div class="editor-config">
          <label>Número de estrellas
            <select data-campo="calificacion-max">${rango(3, 10).map((n) => `<option value="${n}" ${q.calificacion.max === n ? "selected" : ""}>${n}</option>`).join("")}</select>
          </label>
        </div>
        <div class="estrellas estrellas-previa">${"<span class=\"estrella\">★</span>".repeat(q.calificacion.max)}</div>`;
    case "cuadricula_opciones":
    case "cuadricula_casillas": {
      const columnasGlifo = q.tipo === "cuadricula_opciones" ? GLIFO.columnas_opciones : GLIFO.columnas_casillas;
      return `<p class="text-muted text-sm m-0">${q.tipo === "cuadricula_opciones" ? "La persona elige UNA opción por cada fila." : "La persona puede marcar VARIAS opciones por cada fila."}</p>
        <div class="editor-cuadricula">
          <div><label class="etiqueta-seccion">Filas</label>
            ${htmlLista("filas", q.filas, { glifo: GLIFO.filas, etiqueta: "Fila", agregar: "Agregar fila", max: LIMITES.filas, min: 1 })}</div>
          <div><label class="etiqueta-seccion">Columnas</label>
            ${htmlLista("columnas", q.columnas, { glifo: columnasGlifo, etiqueta: "Columna", agregar: "Agregar columna", max: LIMITES.columnas, min: 2 })}</div>
        </div>`;
    }
    case "fecha":
      return '<input type="date" disabled class="input-corto"> <span class="text-muted text-sm">La persona verá un selector de calendario.</span>';
    case "hora":
      return '<input type="time" disabled class="input-corto"> <span class="text-muted text-sm">La persona verá un selector de hora.</span>';
    default:
      return "";
  }
}

// Colapsada: solo el número/ícono + el título, para poder escanear muchas
// preguntas de un vistazo (estilo Google Forms). Clic en el resumen expande
// la tarjeta completa con su editor; clic en "▴ Contraer" la vuelve a cerrar.
function htmlResumen(q, { numero, icono, vacio }) {
  return `
    <button type="button" class="pregunta-resumen" data-accion="expandir">
      ${numero !== undefined ? `<span class="pregunta-num">${numero}</span>` : ""}
      <span class="tipo-icono-mini" aria-hidden="true">${icono}</span>
      <span class="pregunta-resumen-texto${q.texto ? "" : " vacio"}">${esc(q.texto) || vacio}</span>
      <span class="pregunta-resumen-chevron" aria-hidden="true">▾</span>
    </button>`;
}

function htmlPregunta(q, i, total, numPregunta, expandido) {
  if (!expandido) {
    return `<div class="pregunta-editor bloque-editor colapsada" data-i="${i}">${htmlResumen(q, { numero: numPregunta, icono: TIPO_ICONO[q.tipo], vacio: "Pregunta sin título" })}</div>`;
  }
  return `
    <div class="pregunta-editor bloque-editor" data-i="${i}">
      <div class="pregunta-editor-head">
        <span class="pregunta-num">${numPregunta}</span>
        <div class="pregunta-tipo">
          <label for="tipo-${i}">Tipo de pregunta</label>
          <div class="tipo-select-wrap">
            <span class="tipo-icono" aria-hidden="true">${TIPO_ICONO[q.tipo]}</span>
            <select id="tipo-${i}" data-campo="tipo">
              ${TIPOS.map((t) => `<option value="${t.valor}" ${q.tipo === t.valor ? "selected" : ""}>${t.etiqueta}</option>`).join("")}
            </select>
          </div>
        </div>
        <button type="button" class="icon-btn contraer-btn" data-accion="expandir" title="Contraer" aria-label="Contraer pregunta">▴</button>
      </div>
      <input type="text" class="pregunta-texto" data-campo="texto" maxlength="200" value="${esc(q.texto)}" placeholder="Escribe la pregunta" aria-label="Pregunta ${numPregunta}">
      <textarea class="pregunta-descripcion" data-campo="descripcion" rows="2" placeholder="Descripción o ayuda (opcional)" aria-label="Descripción de la pregunta ${numPregunta}">${esc(q.descripcion)}</textarea>
      <div class="pregunta-cuerpo">${htmlCuerpo(q)}</div>
      <div class="pregunta-editor-pie">
        <label class="switch"><input type="checkbox" data-campo="obligatoria" ${q.obligatoria ? "checked" : ""}><span class="switch-pista"></span> Obligatoria</label>
        <div class="pregunta-acciones">
          <button type="button" class="icon-btn" data-accion="subir-pregunta" title="Mover arriba" aria-label="Mover pregunta arriba" ${i === 0 ? "disabled" : ""}>▲</button>
          <button type="button" class="icon-btn" data-accion="bajar-pregunta" title="Mover abajo" aria-label="Mover pregunta abajo" ${i === total - 1 ? "disabled" : ""}>▼</button>
          <button type="button" class="btn secondary btn-auto btn-sm" data-accion="duplicar-pregunta">Duplicar</button>
          <button type="button" class="btn secondary btn-auto btn-sm peligro" data-accion="quitar-pregunta" ${total <= 1 ? "disabled" : ""}>Eliminar</button>
        </div>
      </div>
    </div>`;
}

function htmlEncabezado(q, i, total, expandido) {
  if (!expandido) {
    return `<div class="encabezado-editor bloque-editor colapsada" data-i="${i}">${htmlResumen(q, { icono: "¶", vacio: "Encabezado sin título" })}</div>`;
  }
  return `
    <div class="encabezado-editor bloque-editor" data-i="${i}">
      <div class="encabezado-editor-head">
        <span class="encabezado-icono" aria-hidden="true">¶</span>
        <span class="encabezado-etiqueta">Encabezado de sección</span>
        <button type="button" class="icon-btn contraer-btn" data-accion="expandir" title="Contraer" aria-label="Contraer encabezado">▴</button>
      </div>
      <input type="text" class="encabezado-titulo" data-campo="texto" maxlength="200" value="${esc(q.texto)}" placeholder="Título del encabezado" aria-label="Título del encabezado">
      <textarea class="encabezado-descripcion" data-campo="descripcion" rows="2" placeholder="Texto descriptivo (opcional)" aria-label="Descripción del encabezado">${esc(q.descripcion)}</textarea>
      <div class="encabezado-editor-pie">
        <button type="button" class="icon-btn" data-accion="subir-pregunta" title="Mover arriba" aria-label="Mover encabezado arriba" ${i === 0 ? "disabled" : ""}>▲</button>
        <button type="button" class="icon-btn" data-accion="bajar-pregunta" title="Mover abajo" aria-label="Mover encabezado abajo" ${i === total - 1 ? "disabled" : ""}>▼</button>
        <button type="button" class="btn secondary btn-auto btn-sm peligro" data-accion="quitar-pregunta" ${total <= 1 ? "disabled" : ""}>Eliminar</button>
      </div>
    </div>`;
}

/**
 * Monta el editor dentro de `host`.
 * `alCambiar()` se llama en cada modificación (para marcar "cambios sin guardar").
 * `confirmarCambioTipo(q, tipoNuevo)` puede devolver false para cancelar el cambio.
 */
export function crearEditor(host, { alCambiar = () => {}, confirmarCambioTipo = () => true } = {}) {
  let preguntas = [preguntaNueva()];
  // Solo UNA tarjeta expandida (con el editor completo a la vista) a la
  // vez — el resto queda colapsada mostrando solo su título, como en Google
  // Forms: al abrir una se cierran las demás solas, sin esperar a recargar
  // la encuesta. Por id (no por índice): así sobrevive a mover, duplicar o
  // eliminar otras tarjetas.
  let expandidoId = preguntas[0].id;

  function render(enfocar) {
    let numPregunta = 0;
    host.innerHTML = preguntas.map((q, i) => {
      const expandido = q.id === expandidoId;
      if (esEncabezado(q.tipo)) return htmlEncabezado(q, i, preguntas.length, expandido);
      numPregunta++;
      return htmlPregunta(q, i, preguntas.length, numPregunta, expandido);
    }).join("")
      + `<div class="agregar-bloque">
          <button type="button" class="btn secondary btn-auto agregar-pregunta" data-accion="agregar-pregunta">+ Agregar pregunta</button>
          <button type="button" class="btn secondary btn-auto agregar-encabezado" data-accion="agregar-encabezado">+ Agregar encabezado</button>
        </div>`;
    host.querySelectorAll(".pregunta-descripcion, .encabezado-descripcion").forEach(ajustarAlto);
    if (enfocar) {
      const el = host.querySelector(enfocar);
      if (el) {
        el.focus();
        if (el.select && el.type === "text") el.select();
      }
    }
  }
  const selCampo = (i, campo) => `.pregunta-editor[data-i="${i}"] [data-campo="${campo}"]`;

  host.addEventListener("input", (e) => {
    const tarjeta = e.target.closest(".bloque-editor");
    if (!tarjeta) return;
    const q = preguntas[Number(tarjeta.dataset.i)];
    const campo = e.target.dataset.campo;
    if (campo === "texto") q.texto = e.target.value;
    else if (campo === "descripcion") {
      q.descripcion = e.target.value;
      ajustarAlto(e.target);
    }
    else if (campo === "item") q[e.target.closest(".lista-editable").dataset.lista][Number(e.target.closest(".opcion-fila").dataset.j)] = e.target.value;
    else if (campo === "minSeleccion") q.minSeleccion = e.target.value === "" ? 0 : Math.max(0, parseInt(e.target.value, 10) || 0);
    else if (campo === "maxSeleccion") q.maxSeleccion = e.target.value === "" ? null : parseInt(e.target.value, 10) || null;
    else if (campo === "escala-etiquetaMin") q.escala.etiquetaMin = e.target.value;
    else if (campo === "escala-etiquetaMax") q.escala.etiquetaMax = e.target.value;
    else return;
    alCambiar();
  });

  // Las etiquetas de la escala se reflejan en la vista previa al salir del campo.
  host.addEventListener("focusout", (e) => {
    const campo = e.target.dataset?.campo;
    if (campo !== "escala-etiquetaMin" && campo !== "escala-etiquetaMax") return;
    const tarjeta = e.target.closest(".pregunta-editor");
    const q = preguntas[Number(tarjeta.dataset.i)];
    const etiquetas = tarjeta.querySelectorAll(".escala-previa .escala-etq");
    if (etiquetas.length === 2) {
      etiquetas[0].textContent = q.escala.etiquetaMin;
      etiquetas[1].textContent = q.escala.etiquetaMax;
    }
  });

  host.addEventListener("change", (e) => {
    const tarjeta = e.target.closest(".pregunta-editor");
    if (!tarjeta) return;
    const i = Number(tarjeta.dataset.i);
    const q = preguntas[i];
    const campo = e.target.dataset.campo;
    switch (campo) {
      case "tipo": {
        if (!confirmarCambioTipo(q, e.target.value)) {
          e.target.value = q.tipo;
          return;
        }
        const idAntes = q.id;
        cambiarTipo(q, e.target.value);
        // cambiarTipo puede darle un id nuevo (cambio de "familia" de
        // respuesta) — sin esto la tarjeta se vería colapsar sola a mitad
        // de la edición.
        if (q.id !== idAntes && expandidoId === idAntes) expandidoId = q.id;
        render(selCampo(i, "tipo"));
        break;
      }
      case "obligatoria":
        q.obligatoria = e.target.checked;
        break;
      case "archivo-tipo":
        q.archivos.tipos = [...tarjeta.querySelectorAll('[data-campo="archivo-tipo"]:checked')].map((c) => c.value);
        break;
      case "archivo-maxArchivos":
        q.archivos.maxArchivos = Number(e.target.value);
        break;
      case "archivo-maxMB":
        q.archivos.maxMB = Number(e.target.value);
        break;
      case "escala-min":
        q.escala.min = Number(e.target.value);
        if (q.escala.max <= q.escala.min) q.escala.max = q.escala.min + 1;
        render(selCampo(i, "escala-min"));
        break;
      case "escala-max":
        q.escala.max = Number(e.target.value);
        render(selCampo(i, "escala-max"));
        break;
      case "calificacion-max":
        q.calificacion.max = Number(e.target.value);
        render(selCampo(i, "calificacion-max"));
        break;
      default:
        return;
    }
    alCambiar();
  });

  const mover = (arreglo, de, a) => {
    if (a < 0 || a >= arreglo.length) return false;
    arreglo.splice(a, 0, arreglo.splice(de, 1)[0]);
    return true;
  };

  host.addEventListener("click", (e) => {
    const boton = e.target.closest("[data-accion]");
    if (!boton || boton.disabled) return;
    const accion = boton.dataset.accion;

    if (accion === "agregar-pregunta") {
      const nueva = preguntaNueva();
      expandidoId = nueva.id;
      preguntas.push(nueva);
      render(`[data-i="${preguntas.length - 1}"] .pregunta-texto`);
      host.querySelector(`[data-i="${preguntas.length - 1}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      alCambiar();
      return;
    }

    if (accion === "agregar-encabezado") {
      const nuevo = encabezadoNuevo();
      expandidoId = nuevo.id;
      preguntas.push(nuevo);
      render(`[data-i="${preguntas.length - 1}"] .encabezado-titulo`);
      host.querySelector(`[data-i="${preguntas.length - 1}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      alCambiar();
      return;
    }

    const tarjeta = boton.closest(".bloque-editor");
    if (!tarjeta) return;
    const i = Number(tarjeta.dataset.i);
    const q = preguntas[i];
    const sobreLista = boton.closest(".lista-editable");

    if (sobreLista) {
      const nombre = sobreLista.dataset.lista;
      const items = q[nombre];
      const filaEl = boton.closest(".opcion-fila");
      const j = filaEl ? Number(filaEl.dataset.j) : -1;
      const selItem = (k) => `.pregunta-editor[data-i="${i}"] .lista-editable[data-lista="${nombre}"] .opcion-fila[data-j="${k}"] input`;
      if (accion === "agregar-item") {
        items.push("");
        render(selItem(items.length - 1));
      } else if (accion === "quitar-item") {
        items.splice(j, 1);
        render(selItem(Math.min(j, items.length - 1)));
      } else if (accion === "subir-item" && mover(items, j, j - 1)) {
        render(selItem(j - 1));
      } else if (accion === "bajar-item" && mover(items, j, j + 1)) {
        render(selItem(j + 1));
      }
      alCambiar();
      return;
    }

    if (accion === "expandir") {
      const expandiendo = expandidoId !== q.id;
      expandidoId = expandiendo ? q.id : null;
      render(expandiendo ? `[data-i="${i}"] .pregunta-texto, [data-i="${i}"] .encabezado-titulo` : undefined);
      return;
    }

    if (accion === "quitar-pregunta") {
      if (preguntas.length <= 1) return;
      if (!confirm(esEncabezado(q.tipo) ? "¿Eliminar este encabezado?" : "¿Eliminar esta pregunta?")) return;
      preguntas.splice(i, 1);
      if (expandidoId === q.id) expandidoId = null;
      render();
    } else if (accion === "duplicar-pregunta") {
      const copia = JSON.parse(JSON.stringify(q));
      copia.id = nuevoId();
      delete copia.origen;
      expandidoId = copia.id;
      preguntas.splice(i + 1, 0, copia);
      render(`[data-i="${i + 1}"] .pregunta-texto`);
    } else if (accion === "subir-pregunta" && mover(preguntas, i, i - 1)) {
      render(`[data-i="${i - 1}"] [data-accion="subir-pregunta"]`);
    } else if (accion === "bajar-pregunta" && mover(preguntas, i, i + 1)) {
      render(`[data-i="${i + 1}"] [data-accion="bajar-pregunta"]`);
    } else {
      return;
    }
    alCambiar();
  });

  // Enter nunca envía el formulario desde aquí; dentro de una opción agrega
  // otra debajo (como Google Forms).
  host.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.target.tagName !== "INPUT" || e.target.type !== "text") return;
    e.preventDefault();
    if (e.target.dataset.campo === "item") {
      e.target.closest(".opcion-fila").parentElement.querySelector('[data-accion="agregar-item"]:not([disabled])')?.click();
    }
  });

  render();

  return {
    /** Carga las preguntas guardadas (o una pregunta vacía si no hay). */
    cargar(guardadas) {
      preguntas = (guardadas || []).map((p, i) => {
        const q = normalizarPregunta(p, i);
        q.origen = { id: q.id, tipo: q.tipo };
        return q;
      });
      if (preguntas.length === 0) preguntas = [preguntaNueva()];
      // Todas colapsadas al cargar una encuesta existente: con varias
      // preguntas, ver solo los títulos de una vez es justo el punto.
      expandidoId = preguntas.length === 1 ? preguntas[0].id : null;
      render();
    },
    /** Estado actual del editor (formato de edición; usa serializarPreguntas para guardar). */
    obtener() {
      return preguntas;
    },
    reiniciar() {
      preguntas = [preguntaNueva()];
      expandidoId = preguntas[0].id;
      render();
    }
  };
}
