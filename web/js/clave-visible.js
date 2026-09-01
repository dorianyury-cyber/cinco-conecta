// Botón "mostrar/ocultar" para campos de contraseña — envuelve el <input>
// en un contenedor relativo y agrega un botón de ojo que alterna entre
// type="password" y type="text". Un solo lugar para este comportamiento,
// en vez de repetirlo en cada formulario que tenga un campo de clave.
// Portado tal cual desde Cinco SAS control (web/js/control/clave-visible.js).
export function agregarToggleClave(input) {
  const wrap = document.createElement("div");
  wrap.className = "control-clave-wrap";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "control-clave-toggle";
  btn.textContent = "👁";
  btn.setAttribute("aria-label", "Mostrar contraseña");
  btn.addEventListener("click", () => {
    const seVaAMostrar = input.type === "password";
    input.type = seVaAMostrar ? "text" : "password";
    btn.textContent = seVaAMostrar ? "🙈" : "👁";
    btn.setAttribute("aria-label", seVaAMostrar ? "Ocultar contraseña" : "Mostrar contraseña");
  });
  wrap.appendChild(btn);
}
