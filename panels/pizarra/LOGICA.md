# Lógica de Excalidraw adaptada a Pizarra

Estado: diseño para implementar, no funcionalidad añadida. Revisión del 19 de octubre de 2026.

## Lo que ya funciona

Pizarra guarda elementos vectoriales; el canvas representa esos datos. `model.js` crea objetos inmutables, `tools.js` gestiona interacciones, `shapes.js` calcula geometría, `drawing.js` dibuja y `state.js:59` concentra las modificaciones en `commit()`. El historial ya permite que una operación compuesta sea un único paso de deshacer.

Verificación realizada: `node tools/test-pizarra.mjs` pasó colocación, arrastre, estilos, selección y tamaño, notas, texto, cancelación, deshacer/rehacer, navegación, Mermaid, procesos, JSON, archivo, limpieza, recarga, temas y tres anchuras.

La selección actual es un único `{ kind, id }` (`state.js:24`). Las flechas solo conservan dos coordenadas (`model.js:81`); mover una figura reemplaza únicamente esa figura (`tools.js:276`). Por tanto, una flecha no puede seguirla automáticamente.

## Referencia comprobada

El código público de Excalidraw separa los vínculos del inicio y del final de una flecha, distingue crear/conservar/romper un vínculo y recalcula los puntos conectados. La detección de proximidad considera el zoom. Referencia: [binding.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/element/src/binding.ts).

La selección se calcula sobre elementos y estado de selección; no depende de leer píxeles del canvas. Referencia: [selection.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/element/src/selection.ts).

Estas referencias corresponden al código público consultado, no prueban identidad con la versión desplegada. El análisis REA previo omitió el paquete principal por memoria; no se usa para atribuirle comportamiento que no pudo analizar.

## Primera implementación: conectores que siguen a las figuras

La siguiente es una adaptación propuesta para el modelo pequeño de Pizarra, no una copia del algoritmo completo de Excalidraw.

1. Añadir a cada flecha dos vínculos opcionales: `startBinding` y `endBinding`. Cada uno conserva `elementId` y un anclaje proporcional `u, v`. Mantener `points` como geometría resuelta permite dibujar y conservar flechas libres.
2. Al dibujar o arrastrar un extremo, buscar la figura elegible más cercana dentro de una tolerancia visual convertida a unidades del documento. Empezar con rectángulos, elipses y rombos; resolver empates con el orden de dibujo. Mostrar el destino antes de soltar.
3. Convertir la posición cercana en un punto del contorno. Guardar `u = (x - figura.x) / figura.w` y `v = (y - figura.y) / figura.h`. Para elipses y rombos, proyectar sobre su contorno antes de normalizar. No usar solamente su caja rectangular.
4. Al mover o cambiar el tamaño de una figura, reconstruir sus anclajes: `x = figura.x + u * figura.w`, `y = figura.y + v * figura.h`. Aplicar cualquier separación visual en una función geométrica común. Mantener puntos dentro de los límites del lienzo.
5. Durante el arrastre, presentar figura y flechas actualizadas en la misma vista previa. Escape descarta todas. Al soltar, confirmar la operación completa mediante un solo `commit()`.
6. Al alejar un extremo, romper únicamente ese vínculo. Al borrar una figura, dejar sus flechas en su última posición y quitar las referencias a ella. Esta política de borrado es una decisión propuesta para Pizarra.

### Integración concreta

| Archivo | Cambio necesario |
| --- | --- |
| `bindings.js` nuevo | Detección, anclaje al contorno, resolución y actualización de conectores como funciones puras. |
| `model.js` | Conservar y congelar los vínculos opcionales al crear una flecha. |
| `tools.js` | Conectar extremos durante creación/edición; ampliar `overlay()` para previsualizar todos los afectados. |
| `state.js` | Resolver relaciones de la escena candidata antes de comprobar tamaño y registrar historial. Un fallo no modifica documento ni historial. |
| `transfer.js` | Validar vínculos después de construir el mapa de IDs: destino existente, tipo permitido y anclajes finitos válidos. Versionar el formato; seguir importando versiones 1–3 como flechas libres. |
| `archive.js` | Guardar referencias como índices compactos y reconstruirlas con los nuevos IDs. Actualmente elimina los IDs y los regenera: copiar vínculos sin remapearlos rompería restauraciones. |
| `diagram.js`, `mermaidpanel.js` | Conservar identidad de nodos y extremos de aristas. Crear IDs de figuras primero y resolver conexiones después; no deducir relaciones por proximidad tras compilar. |

Pruebas de aceptación: crear dos figuras conectadas; mover y redimensionar cada una; comprobar ambos extremos durante el arrastre; cancelar; deshacer y rehacer todo en un paso; desconectar y reconectar un extremo; borrar/restaurar destino; exportar/importar y archivar/restaurar; verificar anclajes a distintos zooms; rechazar vínculos inválidos y modificaciones que superen el almacenamiento sin cambios parciales.

## Siguientes bloques, independientes

- **Selección múltiple:** conjunto de IDs; Shift alterna pertenencia; arrastre sobre fondo define un rectángulo de selección; mover aplica el mismo desplazamiento a todos. Recalcular conectores una sola vez sobre la escena resultante. Un gesto equivale a una transacción.
- **Grupos de usuario:** usar identificadores propios, separados del actual `group: "mermaid"`, que sirve para reemplazar diagramas generados. Seleccionar un miembro selecciona su grupo; desagrupar mantiene los elementos.
- **Duplicación:** asignar nuevos IDs en dos pasadas; después remapear vínculos cuyos destinos también fueron duplicados. Definir explícitamente qué ocurre con destinos externos.
- **Texto y figuras:** aprovechar que las figuras ya incorporan `text`; añadir medición y ajuste de líneas según espacio disponible, conservando edición y deshacer existentes.

## Restricciones de esta adaptación

Mantener el SDK de Deska, el lienzo acotado, los límites de almacenamiento y la interfaz actual. No hace falta introducir React ni el paquete completo de Excalidraw para estos bloques. Trabajar sobre `panels/pizarra`; la copia `1.0.0` debe tratarse como una versión separada, no modificarse automáticamente.

Implementar y verificar cada bloque completo antes del siguiente. La actualización de conectores exige incluir guardado, importación y archivo desde el inicio, no solo el comportamiento visual.
